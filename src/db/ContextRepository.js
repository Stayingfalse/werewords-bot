'use strict';

// ============================================================
//  ContextRepository — SQLite-backed context store for the
//  MCP server and SassyManager rich-context AI calls.
//
//  Tables used (created in database.js):
//    sassy_user_profiles   — per-user profile, message count, topic notes
//    sassy_conversation_log — rolling message log per channel
//    sassy_chat_history    — persisted Gemini/OpenAI chat history per channel
//    werewords_player_stats — read-only for scoreboard / user context
//    wavelength_player_stats — read-only for scoreboard / user context
// ============================================================

const db = require('./database');

// How many days of conversation log to keep (older rows are pruned).
const LOG_RETENTION_DAYS = parseInt(process.env.CONTEXT_LOG_RETENTION_DAYS || '30', 10);
const LOG_RETENTION_MS   = LOG_RETENTION_DAYS * 86_400_000;

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtUpsertProfile = db.prepare(`
  INSERT INTO sassy_user_profiles (guild_id, user_id, username, last_seen, message_count)
  VALUES (@guild_id, @user_id, @username, @now, 1)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    username      = excluded.username,
    last_seen     = excluded.last_seen,
    message_count = message_count + 1
`);

const stmtGetProfile = db.prepare(`
  SELECT * FROM sassy_user_profiles WHERE guild_id = ? AND user_id = ?
`);

const stmtUpdateTopicNotes = db.prepare(`
  UPDATE sassy_user_profiles SET topic_notes = ? WHERE guild_id = ? AND user_id = ?
`);

const stmtGetWWStats = db.prepare(`
  SELECT * FROM werewords_player_stats WHERE guild_id = ? AND user_id = ?
`);

const stmtGetWLStats = db.prepare(`
  SELECT * FROM wavelength_player_stats WHERE guild_id = ? AND user_id = ?
`);

const stmtLogConv = db.prepare(`
  INSERT INTO sassy_conversation_log (channel_id, guild_id, user_id, username, content, timestamp)
  VALUES (@channel_id, @guild_id, @user_id, @username, @content, @timestamp)
`);

const stmtGetRecentConv = db.prepare(`
  SELECT username, content, timestamp FROM sassy_conversation_log
  WHERE channel_id = ?
  ORDER BY timestamp DESC
  LIMIT ?
`);

const stmtGetRecentUserConv = db.prepare(`
  SELECT channel_id, content, timestamp FROM sassy_conversation_log
  WHERE guild_id = ? AND user_id = ?
  ORDER BY timestamp DESC
  LIMIT ?
`);

const stmtPruneLog = db.prepare(`
  DELETE FROM sassy_conversation_log WHERE timestamp < ?
`);

const stmtLoadHistory = db.prepare(`
  SELECT history FROM sassy_chat_history WHERE channel_id = ?
`);

const stmtSaveHistory = db.prepare(`
  INSERT INTO sassy_chat_history (channel_id, history, updated_at)
  VALUES (@channel_id, @history, @now)
  ON CONFLICT(channel_id) DO UPDATE SET
    history    = excluded.history,
    updated_at = excluded.updated_at
`);

const stmtGetChannelProfile = db.prepare(`
  SELECT * FROM sassy_channel_profiles WHERE channel_id = ?
`);

const stmtUpsertChannelProfile = db.prepare(`
  INSERT INTO sassy_channel_profiles (channel_id, guild_id, topic_notes, updated_at)
  VALUES (@channel_id, @guild_id, @topic_notes, @now)
  ON CONFLICT(channel_id) DO UPDATE SET
    guild_id    = excluded.guild_id,
    topic_notes = excluded.topic_notes,
    updated_at  = excluded.updated_at
`);

const stmtWWScoreboard = db.prepare(`
  SELECT user_id, username, games_played, wins, losses,
         CASE WHEN games_played > 0 THEN ROUND(100.0 * wins / games_played, 1) ELSE 0 END AS win_pct
  FROM werewords_player_stats
  WHERE guild_id = ? AND games_played > 0
  ORDER BY wins DESC, win_pct DESC
  LIMIT 10
`);

const stmtWLScoreboard = db.prepare(`
  SELECT user_id, username, rounds_played, total_score, bullseyes,
         CASE WHEN rounds_played > 0 THEN ROUND(1.0 * total_score / rounds_played, 1) ELSE 0 END AS avg_score
  FROM wavelength_player_stats
  WHERE guild_id = ? AND rounds_played > 0
  ORDER BY total_score DESC, avg_score DESC
  LIMIT 10
`);

const stmtChannelParticipants = db.prepare(`
  SELECT DISTINCT user_id, username FROM sassy_conversation_log
  WHERE channel_id = ? AND timestamp > ?
`);

// ── ContextRepository class ───────────────────────────────────────────────────

class ContextRepository {
  /**
   * Record a new message; increments the user's message_count and appends
   * to the rolling conversation log.
   *
   * @param {string} channelId
   * @param {string|null} guildId
   * @param {string} userId
   * @param {string} username
   * @param {string} content
   */
  logMessage(channelId, guildId, userId, username, content) {
    const now = Date.now();
    if (guildId) {
      stmtUpsertProfile.run({ guild_id: guildId, user_id: userId, username, now });
    }
    stmtLogConv.run({ channel_id: channelId, guild_id: guildId ?? null, user_id: userId, username, content, timestamp: now });
  }

  /**
   * Return full context for a user: profile + game stats + recent messages.
   *
   * @param {string} guildId
   * @param {string} userId
   * @returns {object}
   */
  getUserContext(guildId, userId) {
    const profile     = stmtGetProfile.get(guildId, userId) ?? null;
    const wwStats     = stmtGetWWStats.get(guildId, userId) ?? null;
    const wlStats     = stmtGetWLStats.get(guildId, userId) ?? null;
    const recentMsgs  = stmtGetRecentUserConv.all(guildId, userId, 10);
    return { profile, wwStats, wlStats, recentMessages: recentMsgs };
  }

  /**
   * Get the last `limit` messages in a channel (most-recent first).
   *
   * @param {string} channelId
   * @param {number} [limit=50]
   * @returns {Array<{username: string, content: string, timestamp: number}>}
   */
  getRecentConversations(channelId, limit = 50) {
    return stmtGetRecentConv.all(channelId, limit);
  }

  /**
   * Get all users active in a channel within the last `windowMs` milliseconds.
   *
   * @param {string} channelId
   * @param {number} windowMs
   * @returns {Array<{user_id: string, username: string}>}
   */
  getChannelParticipants(channelId, windowMs) {
    return stmtChannelParticipants.all(channelId, Date.now() - windowMs);
  }

  /**
   * Get top-10 Werewords scoreboard for a guild.
   *
   * @param {string} guildId
   * @returns {Array}
   */
  getScoreboard(guildId) {
    return stmtWWScoreboard.all(guildId);
  }

  /**
   * Get top-10 Wavelength scoreboard for a guild.
   *
   * @param {string} guildId
   * @returns {Array}
   */
  getWavelengthScoreboard(guildId) {
    return stmtWLScoreboard.all(guildId);
  }

  /**
   * Log a message sent by the bot itself (no user profile upsert).
   *
   * @param {string} channelId
   * @param {string|null} guildId
   * @param {string} username  Display name for the bot
   * @param {string} content
   */
  logBotMessage(channelId, guildId, username, content) {
    stmtLogConv.run({
      channel_id: channelId,
      guild_id:   guildId ?? null,
      user_id:    'sassybot',
      username,
      content,
      timestamp:  Date.now(),
    });
  }

  /**
   * Get stored profile for a channel.
   *
   * @param {string} channelId
   * @returns {object|null}
   */
  getChannelProfile(channelId) {
    return stmtGetChannelProfile.get(channelId) ?? null;
  }

  /**
   * Overwrite the topic_notes field for a channel (AI-generated summary).
   *
   * @param {string} channelId
   * @param {string|null} guildId
   * @param {string} notes
   */
  updateChannelTopicNotes(channelId, guildId, notes) {
    stmtUpsertChannelProfile.run({
      channel_id:  channelId,
      guild_id:    guildId ?? null,
      topic_notes: notes,
      now:         Date.now(),
    });
  }

  /**
   * Return stored topic notes for a channel, or null if none have been
   * generated yet.
   *
   * @param {string} channelId
   * @returns {string|null}
   */
  buildChannelContextString(channelId) {
    return this.getChannelProfile(channelId)?.topic_notes ?? null;
  }

  /**
   * Overwrite the topic_notes field for a user (can be AI-generated).
   *
   * @param {string} guildId
   * @param {string} userId
   * @param {string} notes
   */
  updateTopicNotes(guildId, userId, notes) {
    stmtUpdateTopicNotes.run(notes, guildId, userId);
  }

  /**
   * Load the persisted chat history for a channel.
   * Returns an array in Gemini history format (role + parts).
   *
   * @param {string} channelId
   * @returns {Array}
   */
  loadChatHistory(channelId) {
    const row = stmtLoadHistory.get(channelId);
    if (!row) return [];
    try {
      return JSON.parse(row.history);
    } catch {
      return [];
    }
  }

  /**
   * Persist the current chat history for a channel.
   *
   * @param {string} channelId
   * @param {Array} history  Gemini-format history array
   */
  saveChatHistory(channelId, history) {
    stmtSaveHistory.run({
      channel_id: channelId,
      history:    JSON.stringify(history),
      now:        Date.now(),
    });
  }

  /**
   * Delete conversation log entries older than LOG_RETENTION_DAYS.
   * Should be called periodically (SassyManager cleanup timer does this).
   */
  pruneOldLogs() {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const { changes } = stmtPruneLog.run(cutoff);
    if (changes > 0) {
      console.log(`[ContextRepository] Pruned ${changes} old conversation log entries.`);
    }
  }

  /**
   * Build a human-readable context string about a user for injection into AI
   * system prompts.
   *
   * @param {string} guildId
   * @param {string} userId
   * @returns {string|null}
   */
  buildUserContextString(guildId, userId) {
    const { profile, wwStats, wlStats } = this.getUserContext(guildId, userId);
    if (!profile) return null;

    const parts = [];
    parts.push(`User "${profile.username}" has sent ${profile.message_count} messages in this server.`);

    if (profile.topic_notes) {
      parts.push(`Topics they often discuss: ${profile.topic_notes}.`);
    }

    if (wwStats?.games_played > 0) {
      const pct = wwStats.games_played > 0 ? Math.round((100 * wwStats.wins) / wwStats.games_played) : 0;
      parts.push(`Werewords record: ${wwStats.games_played} games, ${wwStats.wins} wins (${pct}%).`);
    }

    if (wlStats?.rounds_played > 0) {
      const avg = wlStats.rounds_played > 0 ? (wlStats.total_score / wlStats.rounds_played).toFixed(1) : 0;
      parts.push(`Wavelength: ${wlStats.rounds_played} rounds, avg score ${avg}, ${wlStats.bullseyes} bullseyes.`);
    }

    return parts.join(' ');
  }
}

module.exports = new ContextRepository();
