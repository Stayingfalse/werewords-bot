'use strict';

const db = require('../db/database');

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtGetGuild = db.prepare(`
  SELECT feature, enabled, channel_ids, extra
  FROM guild_settings
  WHERE guild_id = ?
`);

const stmtUpsert = db.prepare(`
  INSERT INTO guild_settings (guild_id, feature, enabled, channel_ids, extra, updated_at)
  VALUES (@guild_id, @feature, @enabled, @channel_ids, @extra, @updated_at)
  ON CONFLICT(guild_id, feature) DO UPDATE SET
    enabled     = excluded.enabled,
    channel_ids = excluded.channel_ids,
    extra       = excluded.extra,
    updated_at  = excluded.updated_at
`);

const stmtAllGuilds = db.prepare(`
  SELECT DISTINCT guild_id FROM guild_settings
`);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns all feature settings for a guild as a plain object keyed by feature name.
 * Each value is { enabled: boolean, channelIds: string[]|null, extra: object|null }.
 *
 * @param {string} guildId
 * @returns {Record<string, { enabled: boolean, channelIds: string[]|null, extra: object|null }>}
 */
function getGuildSettings(guildId) {
  const rows = stmtGetGuild.all(guildId);
  const result = {};
  for (const row of rows) {
    result[row.feature] = {
      enabled:    row.enabled === 1,
      channelIds: row.channel_ids ? JSON.parse(row.channel_ids) : null,
      extra:      row.extra       ? JSON.parse(row.extra)       : null,
    };
  }
  return result;
}

/**
 * Upserts a single feature setting for a guild.
 *
 * @param {string}          guildId
 * @param {string}          feature     e.g. 'werewords', 'wavelength', 'sassy'
 * @param {boolean}         enabled
 * @param {string[]|null}   channelIds  null = all channels
 * @param {object|null}     extra       feature-specific JSON config
 */
function setFeature(guildId, feature, enabled, channelIds = null, extra = null) {
  stmtUpsert.run({
    guild_id:    guildId,
    feature,
    enabled:     enabled ? 1 : 0,
    channel_ids: channelIds ? JSON.stringify(channelIds) : null,
    extra:       extra      ? JSON.stringify(extra)      : null,
    updated_at:  Date.now(),
  });
}

/**
 * Returns all distinct guild IDs that have at least one feature row.
 * Used by the super-admin view to list every known guild.
 *
 * @returns {string[]}
 */
function getAllGuilds() {
  return stmtAllGuilds.all().map(r => r.guild_id);
}

module.exports = { getGuildSettings, setFeature, getAllGuilds };
