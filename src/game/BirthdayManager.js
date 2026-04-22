'use strict';

/**
 * BirthdayManager — handles scheduled daily birthday announcements.
 *
 * Call `start(client)` once on bot ready.  The manager will:
 *   1. Fire immediately to catch any birthdays already due today.
 *   2. Schedule itself to run every day at midnight UTC (via a self-adjusting
 *      setTimeout so it always fires right at the turn of the day).
 */

const repo = require('../db/BirthdayRepository');

/** Fun birthday messages.  `{mentions}` is replaced with user ping(s). */
const BIRTHDAY_MESSAGES = [
  '🎂 Attention everyone! {mentions} has survived another lap around the sun. Remarkable, really.',
  '🥳 Today in history: {mentions} was unleashed upon the world. We\'re still recovering. Happy birthday!',
  '🎉 Breaking news: {mentions} is officially one year closer to getting senior discounts. Congrats!',
  '🎈 {mentions} is celebrating a birthday today! Scientists are still unsure how they\'ve lasted this long.',
  '🎊 Happy birthday to {mentions}! Your cake has more candles than a medieval cathedral.',
  '🥂 Raise a glass for {mentions}! Another year older, and somehow still here bothering all of us. Love you really.',
  '🎂 {mentions} birthday detected. Deploying congratulations. Please stand by… 🎉',
  '🎁 Today is {mentions}\'s special day! And by special we mean the anniversary of the worst decision their parents ever made. (jk, happy birthday!)',
  '🎈 {mentions} has completed another successful orbit of the Sun. NASA is impressed.',
  '🥳 Fun fact: {mentions} is celebrating a birthday today. Less fun fact: they\'re not getting any younger.',
  '🎉 {mentions} is a year older today! Time flies when you\'re having fun. Or just existing. Either way.',
  '🎊 Happy birthday {mentions}! You\'re not old, you\'re a classic.',
  '🎂 The council has been notified. {mentions} is officially another year older. Prayers welcome.',
  '🥂 Alert! {mentions} has levelled up! +1 to age. No other stats changed.',
  '🎈 Today we celebrate {mentions} and the complete mystery of how they\'ve made it this far. Cheers!',
  '🎁 {mentions}! Your cake is ready. Your dignity? That left years ago. Happy birthday!',
  '🎉 {mentions} is aging like fine wine today. Or milk. Hard to tell. Happy birthday anyway!',
  '🎊 On this day, {mentions} was added to the world server. The admins have been unable to remove them since.',
  '🥳 {mentions} birthday unlocked! Achievement: Still Alive. Reward: Cake.',
  '🎂 Many years ago, {mentions} arrived. No one asked for it, but here we are. Happy birthday!',
  '🎈 Time to sing off-key at {mentions} until they feel sufficiently embarrassed! 🎵 Happy birthday to youuuu 🎵',
  '🥂 {mentions} has entered a new age bracket. Condolences and congratulations in equal measure.',
  '🎉 {mentions} is older today! The exact amount is classified. What we can confirm is: cake.',
  '🎁 The birthday fairy has visited {mentions}. She left cake, confetti, and mild existential dread.',
  '🎊 {mentions}, you\'ve been alive for a genuinely alarming number of days now. We\'re proud of you.',
  '🎂 Happy birthday {mentions}! You\'re not old. You\'re retro.',
  '🥳 {mentions} has downloaded another year of life experience. Please restart to apply updates.',
  '🎈 Scientists confirm that {mentions} is, in fact, older today than they were yesterday. More at 11.',
  '🎉 {mentions} birthday protocol initiated. All crew report to the mess hall for cake immediately.',
  '🎊 Today {mentions} turns another page in the book of life. We\'re not saying which page. That\'s rude.',
];

/** Return a random birthday message with `{mentions}` replaced. */
function randomMessage(mention) {
  const template = BIRTHDAY_MESSAGES[Math.floor(Math.random() * BIRTHDAY_MESSAGES.length)];
  return template.replace('{mentions}', mention);
}

/**
 * ISO date string for a given Date (UTC), e.g. "2025-04-22".
 * Used as the deduplication key.
 */
function todayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Compute milliseconds until the next UTC midnight from `now`.
 */
function msUntilMidnightUTC(now) {
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

class BirthdayManager {
  constructor() {
    this._client = null;
    this._timer  = null;
  }

  /**
   * Start the birthday announcement loop.
   * Safe to call multiple times — restarts the timer cleanly.
   * @param {import('discord.js').Client} client
   */
  start(client) {
    this._client = client;
    this._scheduleNext();
    // Also run immediately so birthdays aren't missed if the bot restarts mid-day.
    this._runAnnouncements().catch(err =>
      console.error('[BirthdayManager] Error in initial announcement run:', err),
    );
  }

  /** Stop the scheduled loop. */
  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Schedule the next run at the following UTC midnight. */
  _scheduleNext() {
    const delay = msUntilMidnightUTC(new Date());
    this._timer = setTimeout(() => {
      this._runAnnouncements().catch(err =>
        console.error('[BirthdayManager] Error during announcement run:', err),
      );
      this._scheduleNext();
    }, delay);
  }

  /** Core logic: find today's birthdays and post announcements. */
  async _runAnnouncements() {
    if (!this._client) return;

    const now = new Date();

    // Prune old dedup records (keep last 2 days to be safe)
    const pruneBeforeDate = new Date(now);
    pruneBeforeDate.setUTCDate(pruneBeforeDate.getUTCDate() - 2);
    repo.pruneAnnouncements(todayKey(pruneBeforeDate));

    for (const [, guild] of this._client.guilds.cache) {
      await this.runForGuild(guild).catch(err =>
        console.error(`[BirthdayManager] Error processing guild ${guild.id}:`, err),
      );
    }
  }

  /**
   * Send any unannounced birthday messages for a single guild.
   * Respects the existing dedup records — already-announced users are skipped.
   *
   * @param {import('discord.js').Guild} guild
   * @returns {Promise<{ sent: number, total: number, channelId: string|null }>}
   */
  async runForGuild(guild) {
    if (!this._client) return { sent: 0, total: 0, channelId: null };

    const guildId  = guild.id;
    const settings = repo.getSettings(guildId);
    if (!settings || !settings.enabled || !settings.channel_id) {
      return { sent: 0, total: 0, channelId: null };
    }

    const channel = this._client.channels.cache.get(settings.channel_id);
    if (!channel) return { sent: 0, total: 0, channelId: settings.channel_id };

    const now     = new Date();
    const dateKey = todayKey(now);
    const day     = now.getUTCDate();
    const month   = now.getUTCMonth() + 1; // 1-based

    const userIds = repo.getTodaysBirthdays(guildId, day, month);
    let sent = 0;

    for (const userId of userIds) {
      if (repo.wasAnnounced(guildId, userId, dateKey)) continue;

      // Verify the member is still in the guild.
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      const message = randomMessage(`<@${userId}>`);
      await channel.send(message).catch(err =>
        console.error(`[BirthdayManager] Failed to send message in guild ${guildId}:`, err),
      );

      repo.markAnnounced(guildId, userId, dateKey);
      sent++;
    }

    return { sent, total: userIds.length, channelId: settings.channel_id };
  }
}

module.exports = BirthdayManager;
