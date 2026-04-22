'use strict';

/**
 * /birthday — Birthday management command.
 *
 * Subcommands:
 *   set <date> [user]        – Set a birthday (dd/mm[/yyyy]). Admins can target any user.
 *   get [user]               – View a birthday. Admins can target any user.
 *   delete [user]            – Remove a birthday. Admins can target any user.
 *   upcoming                 – Show the next 3 upcoming birthdays in this server.
 *   start [channel]          – Admin: enable announcements (optionally set channel).
 *   stop                     – Admin: disable announcements.
 *   setchannel <channel>     – Admin: set/change the announcement channel.
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

    // /birthday get [user]
    .addSubcommand(sub =>
      sub
        .setName('get')
        .setDescription('Check a birthday. Admins can look up any user.')
        .addUserOption(opt =>
          opt
            .setName('user')
            .setDescription('(Admin only) The user to look up'),
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

    // /birthday upcoming
    .addSubcommand(sub =>
      sub
        .setName('upcoming')
        .setDescription('Show the next 3 upcoming birthdays in this server'),
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

    // ── /birthday get ────────────────────────────────────────────────────────
    if (sub === 'get') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

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

    // ── /birthday upcoming ───────────────────────────────────────────────────
    if (sub === 'upcoming') {
      const all = repo.getAllBirthdays(guildId);
      const upcoming = getUpcoming(all, 3);

      if (upcoming.length === 0) {
        return interaction.reply({
          content: 'ℹ️ No upcoming birthdays found in this server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const lines = upcoming.map(entry => {
        const dd = String(entry.day).padStart(2, '0');
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
  },
};
