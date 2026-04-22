'use strict';

/**
 * /birthday — Birthday management command.
 *
 * Subcommands:
 *   set <date> [user]        – Set a birthday (dd/mm[/yyyy]). Admins can target any user.
 *   list [user] [all]        – View birthdays:
 *                               • list <user>     → show that user's birthday (admins can look up anyone)
 *                               • list            → show next 3 upcoming birthdays
 *                               • list all:True   → show all birthdays sorted by month/day
 *   delete [user]            – Remove a birthday. Admins can target any user.
 *   start [channel]          – Admin: enable announcements (optionally set channel).
 *   stop                     – Admin: disable announcements.
 *   setchannel <channel>     – Admin: set/change the announcement channel.
 *   resend                   – Admin: clear today's dedup and re-send today's announcements.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');

const repo = require('../db/BirthdayRepository');

// ── Date helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a birthday string in dd/mm/yyyy or dd/mm format.
 * Returns { day, month, year } on success, or null on failure.
 */
function parseBirthday(str) {
  const parts = str.trim().split('/');
  if (parts.length < 2 || parts.length > 3) return null;

  const day   = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year  = parts.length === 3 ? parseInt(parts[2], 10) : null;

  if (isNaN(day) || day < 1 || day > 31)   return null;
  if (isNaN(month) || month < 1 || month > 12) return null;
  if (year !== null && (isNaN(year) || year < 1900 || year > new Date().getFullYear())) return null;

  // Validate the date actually exists (handles Feb 29 on non-leap years, etc.)
  const checkYear = year ?? 2000; // 2000 is a leap year — good default for year-less entries
  const date = new Date(Date.UTC(checkYear, month - 1, day));
  if (
    date.getUTCFullYear() !== checkYear ||
    date.getUTCMonth()    !== month - 1 ||
    date.getUTCDate()     !== day
  ) {
    return null;
  }

  return { day, month, year };
}

/**
 * Format a birthday record as a readable string.
 */
function formatBirthday(row) {
  const dd = String(row.birth_day).padStart(2, '0');
  const mm = String(row.birth_month).padStart(2, '0');
  if (row.birth_year) return `${dd}/${mm}/${row.birth_year}`;
  return `${dd}/${mm}`;
}

/**
 * Given a list of all guild birthdays, return the next `count` upcoming after today (UTC).
 * @returns {{ userId: string, day: number, month: number, daysAway: number }[]}
 */
function getUpcoming(allBirthdays, count = 3) {
  const now   = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const candidates = [];

  for (const row of allBirthdays) {
    // Try this year and next year to handle wrap-around.
    for (const yearOffset of [0, 1]) {
      const year = now.getUTCFullYear() + yearOffset;
      // Use 2000 as leap-year stand-in when we want to check Feb 29 anniversaries.
      const checkYear = (row.birth_month === 2 && row.birth_day === 29) ? leapYear(year) : year;
      const bday = Date.UTC(checkYear, row.birth_month - 1, row.birth_day);
      const daysAway = Math.round((bday - today) / 86_400_000);
      if (daysAway > 0) {
        candidates.push({ userId: row.user_id, day: row.birth_day, month: row.birth_month, daysAway });
        break; // found the next occurrence, no need for +1 year
      }
    }
  }

  candidates.sort((a, b) => a.daysAway - b.daysAway);
  return candidates.slice(0, count);
}

/** Return the current or next leap year at/after `year`. */
function leapYear(year) {
  while (!((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) year++;
  return year;
}

const MONTH_NAMES = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ── Command definition ─────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Birthday management')

    // /birthday set <date> [user]
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('Set a birthday (dd/mm/yyyy or dd/mm). Admins can set for another user.')
        .addStringOption(opt =>
          opt
            .setName('date')
            .setDescription('Birthday in dd/mm/yyyy or dd/mm format')
            .setRequired(true),
        )
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('(Admin only) The user whose birthday to set'),
        ),
    )

    // /birthday list [user] [all]
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List birthdays: a user\'s birthday, upcoming birthdays, or all birthdays.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('Show this user\'s birthday. Admins can look up anyone.'),
        )
        .addBooleanOption(opt =>
          opt
            .setName('all')
            .setDescription('Show all birthdays in this server sorted by month/day.'),
        ),
    )

    // /birthday delete [user]
    .addSubcommand(sub =>
      sub
        .setName('delete')
        .setDescription('Remove a birthday. Admins can remove any user\'s birthday.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('(Admin only) The user whose birthday to remove'),
        ),
    )

    // /birthday start [channel]
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('(Admin) Enable birthday announcements in this server.')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel to send birthday messages (uses existing setting if omitted)'),
        ),
    )

    // /birthday stop
    .addSubcommand(sub =>
      sub
        .setName('stop')
        .setDescription('(Admin) Disable birthday announcements in this server.'),
    )

    // /birthday setchannel <channel>
    .addSubcommand(sub =>
      sub
        .setName('setchannel')
        .setDescription('(Admin) Set or change the birthday announcement channel.')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('The channel to use for birthday announcements')
            .setRequired(true),
        ),
    )

    // /birthday resend
    .addSubcommand(sub =>
      sub
        .setName('resend')
        .setDescription('(Admin) Re-send today\'s birthday announcements (clears today\'s dedup first).'),
    ),

  // ── Handler ──────────────────────────────────────────────────────────────────

  async execute(interaction) {
    const { guildId, member } = interaction;
    const sub = interaction.options.getSubcommand();

    /** True if the invoking member has Manage Guild or Administrator. */
    const isAdmin =
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.Administrator);

    // ── /birthday set ────────────────────────────────────────────────────────
    if (sub === 'set') {
      const dateStr  = interaction.options.getString('date', true);
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      if (targetUser.id !== interaction.user.id && !isAdmin) {
        return interaction.reply({
          content: '❌ You can only set your **own** birthday.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const parsed = parseBirthday(dateStr);
      if (!parsed) {
        return interaction.reply({
          content:
            '❌ Invalid date format. Use **dd/mm/yyyy** or **dd/mm**.\n' +
            'Examples: `20/12/1998` or `20/12`',
          flags: MessageFlags.Ephemeral,
        });
      }

      repo.setBirthday(guildId, targetUser.id, parsed.day, parsed.month, parsed.year);

      const formatted = formatBirthday({ birth_day: parsed.day, birth_month: parsed.month, birth_year: parsed.year });
      const whose = targetUser.id === interaction.user.id ? 'Your' : `${targetUser.username}'s`;
      return interaction.reply({
        content: `🎂 ${whose} birthday has been set to **${formatted}**!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── /birthday list ───────────────────────────────────────────────────────
    if (sub === 'list') {
      const targetUser = interaction.options.getUser('user');
      const showAll    = interaction.options.getBoolean('all') ?? false;

      // — list <user>: show a specific user's birthday
      if (targetUser) {
        if (targetUser.id !== interaction.user.id && !isAdmin) {
          return interaction.reply({
            content: '❌ You can only check your **own** birthday.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const row = repo.getBirthday(guildId, targetUser.id);
        if (!row) {
          const whose = targetUser.id === interaction.user.id ? 'You don\'t' : `${targetUser.username} doesn't`;
          return interaction.reply({
            content: `ℹ️ ${whose} have a birthday set in this server.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const formatted = formatBirthday(row);
        const whose = targetUser.id === interaction.user.id ? 'Your' : `${targetUser.username}'s`;
        return interaction.reply({
          content: `🎂 ${whose} birthday is **${formatted}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // — list all:true: show every birthday sorted by month/day
      if (showAll) {
        const all = repo.getAllBirthdays(guildId);

        if (all.length === 0) {
          return interaction.reply({
            content: 'ℹ️ No birthdays have been set in this server yet.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const sorted = [...all].sort((a, b) =>
          a.birth_month !== b.birth_month
            ? a.birth_month - b.birth_month
            : a.birth_day - b.birth_day,
        );

        const MAX_LINES = 50;
        const lines = sorted.slice(0, MAX_LINES).map(row => {
          const dd  = String(row.birth_day).padStart(2, '0');
          const mon = MONTH_NAMES[row.birth_month];
          return `🎂 <@${row.user_id}> — **${dd} ${mon}**`;
        });

        if (sorted.length > MAX_LINES) {
          lines.push(`*… and ${sorted.length - MAX_LINES} more*`);
        }

        const embed = new EmbedBuilder()
          .setTitle('🎂 All Birthdays')
          .setDescription(lines.join('\n'))
          .setColor(0xF1C40F)
          .setFooter({ text: `${all.length} birthday${all.length === 1 ? '' : 's'} registered in this server` });

        return interaction.reply({ embeds: [embed] });
      }

      // — list (no args): show next 3 upcoming birthdays
      const all = repo.getAllBirthdays(guildId);
      const upcoming = getUpcoming(all, 3);

      if (upcoming.length === 0) {
        return interaction.reply({
          content: 'ℹ️ No upcoming birthdays found in this server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = upcoming.map(entry => {
        const dd  = String(entry.day).padStart(2, '0');
        const mon = MONTH_NAMES[entry.month];
        const days = entry.daysAway === 1 ? 'tomorrow' : `in ${entry.daysAway} days`;
        return `🎂 <@${entry.userId}> — **${dd} ${mon}** (${days})`;
      });

      const embed = new EmbedBuilder()
        .setTitle('📅 Upcoming Birthdays')
        .setDescription(lines.join('\n'))
        .setColor(0xF1C40F)
        .setFooter({ text: 'Next 3 birthdays in this server' });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /birthday delete ─────────────────────────────────────────────────────
    if (sub === 'delete') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      if (targetUser.id !== interaction.user.id && !isAdmin) {
        return interaction.reply({
          content: '❌ You can only delete your **own** birthday.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const deleted = repo.deleteBirthday(guildId, targetUser.id);
      if (!deleted) {
        const whose = targetUser.id === interaction.user.id ? 'You don\'t' : `${targetUser.username} doesn't`;
        return interaction.reply({
          content: `ℹ️ ${whose} have a birthday set in this server.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const whose = targetUser.id === interaction.user.id ? 'Your' : `${targetUser.username}'s`;
      return interaction.reply({
        content: `🗑️ ${whose} birthday has been removed.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── /birthday start ──────────────────────────────────────────────────────
    if (sub === 'start') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need the **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channelOption = interaction.options.getChannel('channel');
      const settings = repo.getSettings(guildId);
      const channelId = channelOption?.id ?? settings?.channel_id ?? null;

      if (!channelId) {
        return interaction.reply({
          content:
            '❌ No announcement channel is set. Please provide a channel:\n' +
            '`/birthday start channel:#your-channel`\nor set one first with `/birthday setchannel`.',
          flags: MessageFlags.Ephemeral,
        });
      }

      repo.setEnabled(guildId, true, channelId);

      return interaction.reply({
        content: `✅ Birthday announcements **enabled**! Messages will be sent in <#${channelId}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── /birthday stop ───────────────────────────────────────────────────────
    if (sub === 'stop') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need the **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      repo.setEnabled(guildId, false, null);
      return interaction.reply({
        content: '🛑 Birthday announcements **disabled**.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── /birthday setchannel ─────────────────────────────────────────────────
    if (sub === 'setchannel') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need the **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.options.getChannel('channel', true);
      repo.setChannel(guildId, channel.id);

      return interaction.reply({
        content: `✅ Birthday announcement channel set to <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── /birthday resend ─────────────────────────────────────────────────────
    if (sub === 'resend') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need the **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const settings = repo.getSettings(guildId);
      if (!settings || !settings.enabled || !settings.channel_id) {
        return interaction.reply({
          content:
            '❌ Birthday announcements are not enabled in this server. ' +
            'Use `/birthday start` to enable them first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Defer because we'll be making Discord API calls (member fetches + sends).
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Wipe today's dedup records for this guild so everyone gets re-announced.
      const dateKey = new Date().toISOString().slice(0, 10);
      repo.clearTodayAnnouncements(guildId, dateKey);

      const result = await interaction.client.birthdayManager.runForGuild(interaction.guild);

      if (result.total === 0) {
        return interaction.editReply({ content: 'ℹ️ No birthdays today in this server.' });
      }

      return interaction.editReply({
        content:
          `✅ Sent **${result.sent}** birthday announcement${result.sent === 1 ? '' : 's'}` +
          ` in <#${result.channelId}>.` +
          (result.total > result.sent
            ? ` (${result.total - result.sent} member${result.total - result.sent === 1 ? '' : 's'} not found in server)`
            : ''),
      });
    }
  },
};
