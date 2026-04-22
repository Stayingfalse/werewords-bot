'use strict';

/**
 * Birthday data access layer.
 * All birthday records are scoped per guild so multiple servers can coexist.
 */

const db = require('./database');

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtSet = db.prepare(`
  INSERT INTO birthdays (guild_id, user_id, birth_day, birth_month, birth_year)
  VALUES (@guild_id, @user_id, @birth_day, @birth_month, @birth_year)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    birth_day   = excluded.birth_day,
    birth_month = excluded.birth_month,
    birth_year  = excluded.birth_year
`);

const stmtGet = db.prepare(`
  SELECT birth_day, birth_month, birth_year
  FROM birthdays
  WHERE guild_id = ? AND user_id = ?
`);

const stmtDelete = db.prepare(`
  DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?
`);

const stmtTodaysBirthdays = db.prepare(`
  SELECT user_id FROM birthdays
  WHERE guild_id = ? AND birth_day = ? AND birth_month = ?
`);

const stmtUpcoming = db.prepare(`
  SELECT user_id, birth_day, birth_month FROM birthdays
  WHERE guild_id = ?
`);

const stmtWasAnnounced = db.prepare(`
  SELECT 1 FROM birthday_announcements
  WHERE guild_id = ? AND user_id = ? AND announced_on = ?
`);

const stmtMarkAnnounced = db.prepare(`
  INSERT OR IGNORE INTO birthday_announcements (guild_id, user_id, announced_on)
  VALUES (?, ?, ?)
`);

const stmtPruneAnnouncements = db.prepare(`
  DELETE FROM birthday_announcements WHERE announced_on < ?
`);

const stmtGetSettings = db.prepare(`
  SELECT channel_id, enabled FROM birthday_settings WHERE guild_id = ?
`);

const stmtUpsertSettings = db.prepare(`
  INSERT INTO birthday_settings (guild_id, channel_id, enabled)
  VALUES (@guild_id, @channel_id, @enabled)
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = COALESCE(excluded.channel_id, channel_id),
    enabled    = excluded.enabled
`);

const stmtSetChannel = db.prepare(`
  INSERT INTO birthday_settings (guild_id, channel_id, enabled)
  VALUES (@guild_id, @channel_id, 0)
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = excluded.channel_id
`);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Store or update a user's birthday for a guild.
 * @param {string} guildId
 * @param {string} userId
 * @param {number} day        1–31
 * @param {number} month      1–12
 * @param {number|null} year  Full year, or null if omitted
 */
function setBirthday(guildId, userId, day, month, year) {
  stmtSet.run({
    guild_id:    guildId,
    user_id:     userId,
    birth_day:   day,
    birth_month: month,
    birth_year:  year ?? null,
  });
}

/**
 * Retrieve a user's birthday.
 * @returns {{ birth_day: number, birth_month: number, birth_year: number|null }|null}
 */
function getBirthday(guildId, userId) {
  return stmtGet.get(guildId, userId) ?? null;
}

/**
 * Remove a user's birthday record.
 * @returns {boolean} true if a record was deleted
 */
function deleteBirthday(guildId, userId) {
  const info = stmtDelete.run(guildId, userId);
  return info.changes > 0;
}

/**
 * Return all user IDs with today's birthday in the given guild.
 * @param {string} guildId
 * @param {number} day
 * @param {number} month
 * @returns {string[]}
 */
function getTodaysBirthdays(guildId, day, month) {
  return stmtTodaysBirthdays.all(guildId, day, month).map(r => r.user_id);
}

/**
 * Return all birthdays in a guild (for upcoming calculation).
 * @param {string} guildId
 * @returns {{ user_id: string, birth_day: number, birth_month: number }[]}
 */
function getAllBirthdays(guildId) {
  return stmtUpcoming.all(guildId);
}

/**
 * Check whether a user has already been announced today.
 * @param {string} guildId
 * @param {string} userId
 * @param {string} dateKey  ISO date string "YYYY-MM-DD"
 */
function wasAnnounced(guildId, userId, dateKey) {
  return !!stmtWasAnnounced.get(guildId, userId, dateKey);
}

/**
 * Record that a user was announced today (idempotent).
 */
function markAnnounced(guildId, userId, dateKey) {
  stmtMarkAnnounced.run(guildId, userId, dateKey);
}

/**
 * Delete old announcement records older than the given ISO date string.
 */
function pruneAnnouncements(beforeDateKey) {
  stmtPruneAnnouncements.run(beforeDateKey);
}

/**
 * Get birthday settings for a guild.
 * @returns {{ channel_id: string|null, enabled: boolean }|null}
 */
function getSettings(guildId) {
  const row = stmtGetSettings.get(guildId);
  if (!row) return null;
  return { channel_id: row.channel_id, enabled: !!row.enabled };
}

/**
 * Enable or disable birthday announcements, optionally setting the channel.
 */
function setEnabled(guildId, enabled, channelId) {
  stmtUpsertSettings.run({
    guild_id:   guildId,
    channel_id: channelId ?? null,
    enabled:    enabled ? 1 : 0,
  });
}

/**
 * Set the announcement channel for a guild (does not change enabled state).
 */
function setChannel(guildId, channelId) {
  stmtSetChannel.run({ guild_id: guildId, channel_id: channelId });
}

module.exports = {
  setBirthday,
  getBirthday,
  deleteBirthday,
  getTodaysBirthdays,
  getAllBirthdays,
  wasAnnounced,
  markAnnounced,
  pruneAnnouncements,
  getSettings,
  setEnabled,
  setChannel,
};
