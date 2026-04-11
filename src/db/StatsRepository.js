'use strict';

/**
 * Werewords player stats — replaces the old file-based StatsManager.
 * Public API is intentionally API-compatible with the old StatsManager so
 * call sites only need a require-path change.
 */

const db = require('./database');

// ── Win/loss mapping ───────────────────────────────────────────────────────────

const WINNER_ROLES = {
  villagers_word:  new Set(['Wordsmith', 'Librarian', 'Townsfolk']),
  villagers_vote:  new Set(['Wordsmith', 'Librarian', 'Townsfolk']),
  werewolf_time:   new Set(['Demon']),
  werewolf_tokens: new Set(['Demon']),
  werewolf_seer:   new Set(['Demon']),
  werewolf_vote:   new Set(['Demon']),
};

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtUpsertPlayer = db.prepare(`
  INSERT INTO werewords_player_stats
    (guild_id, user_id, username, games_played, wins, losses,
     role_wordsmith, role_demon, role_librarian, role_townsfolk,
     correct_guesses, times_identified_as_seer)
  VALUES
    (@guild_id, @user_id, @username, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    username = excluded.username
`);

const stmtIncrGame = db.prepare(`
  UPDATE werewords_player_stats
  SET games_played = games_played + 1,
      wins         = wins   + @won,
      losses       = losses + @lost
  WHERE guild_id = @guild_id AND user_id = @user_id
`);

const stmtIncrRole = db.prepare(`
  UPDATE werewords_player_stats
  SET role_wordsmith = role_wordsmith + @wordsmith,
      role_demon     = role_demon     + @demon,
      role_librarian = role_librarian + @librarian,
      role_townsfolk = role_townsfolk + @townsfolk
  WHERE guild_id = @guild_id AND user_id = @user_id
`);

const stmtIncrCorrectGuess = db.prepare(`
  UPDATE werewords_player_stats
  SET correct_guesses = correct_guesses + 1
  WHERE guild_id = @guild_id AND user_id = @user_id
`);

const stmtIncrSeer = db.prepare(`
  UPDATE werewords_player_stats
  SET times_identified_as_seer = times_identified_as_seer + 1
  WHERE guild_id = @guild_id AND user_id = @user_id
`);

const stmtGetGuild = db.prepare(`
  SELECT * FROM werewords_player_stats WHERE guild_id = ?
`);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Records the result of one werewords game (maps to the old StatsManager API).
 *
 * @param {string} guildId
 * @param {Map<string, {id: string, username: string, role: string}>} players
 * @param {string} outcome
 * @param {string|null} winnerGuesserUserId
 * @param {string|null} seerVictimUserId
 */
const recordGame = db.transaction((guildId, players, outcome, winnerGuesserUserId, seerVictimUserId) => {
  const winners = WINNER_ROLES[outcome] ?? new Set();

  for (const player of players.values()) {
    // Ensure row exists.
    stmtUpsertPlayer.run({ guild_id: guildId, user_id: player.id, username: player.username });

    const won = winners.has(player.role) ? 1 : 0;
    stmtIncrGame.run({ guild_id: guildId, user_id: player.id, won, lost: 1 - won });

    stmtIncrRole.run({
      guild_id:   guildId,
      user_id:    player.id,
      wordsmith:  player.role === 'Wordsmith' ? 1 : 0,
      demon:      player.role === 'Demon'     ? 1 : 0,
      librarian:  player.role === 'Librarian' ? 1 : 0,
      townsfolk:  player.role === 'Townsfolk' ? 1 : 0,
    });

    if (winnerGuesserUserId && player.id === winnerGuesserUserId) {
      stmtIncrCorrectGuess.run({ guild_id: guildId, user_id: player.id });
    }

    if (seerVictimUserId && player.id === seerVictimUserId) {
      stmtIncrSeer.run({ guild_id: guildId, user_id: player.id });
    }
  }
});

/**
 * Returns guild stats in the same shape as the old StatsManager so existing
 * consumers (buildSessionSummaryEmbed) work without changes.
 *
 * @param {string} guildId
 * @returns {Object.<string, object>}  userId → stats object
 */
function getGuildStats(guildId) {
  const rows = stmtGetGuild.all(guildId);
  const result = {};
  for (const row of rows) {
    result[row.user_id] = {
      username:              row.username,
      gamesPlayed:           row.games_played,
      wins:                  row.wins,
      losses:                row.losses,
      rolesPlayed: {
        Wordsmith: row.role_wordsmith,
        Demon:     row.role_demon,
        Librarian: row.role_librarian,
        Townsfolk: row.role_townsfolk,
      },
      correctGuesses:         row.correct_guesses,
      timesIdentifiedAsSeer:  row.times_identified_as_seer,
    };
  }
  return result;
}

module.exports = { recordGame, getGuildStats };
