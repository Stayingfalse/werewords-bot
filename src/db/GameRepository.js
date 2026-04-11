'use strict';

const db = require('./database');

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtUpsert = db.prepare(`
  INSERT INTO werewords_games
    (thread_id, guild_id, channel_id, host_id, host_username,
     message_id, board_message_id, phase, players, word, word_options,
     tokens, time_left, votes, game_number, winner_guesser_user_id, created_at)
  VALUES
    (@thread_id, @guild_id, @channel_id, @host_id, @host_username,
     @message_id, @board_message_id, @phase, @players, @word, @word_options,
     @tokens, @time_left, @votes, @game_number, @winner_guesser_user_id, @created_at)
  ON CONFLICT(thread_id) DO UPDATE SET
    guild_id               = excluded.guild_id,
    channel_id             = excluded.channel_id,
    host_id                = excluded.host_id,
    host_username          = excluded.host_username,
    message_id             = excluded.message_id,
    board_message_id       = excluded.board_message_id,
    phase                  = excluded.phase,
    players                = excluded.players,
    word                   = excluded.word,
    word_options           = excluded.word_options,
    tokens                 = excluded.tokens,
    time_left              = excluded.time_left,
    votes                  = excluded.votes,
    game_number            = excluded.game_number,
    winner_guesser_user_id = excluded.winner_guesser_user_id
`);

const stmtUpdateTimeLeft = db.prepare(`
  UPDATE werewords_games SET time_left = @time_left WHERE thread_id = @thread_id
`);

const stmtGetAll = db.prepare(`SELECT * FROM werewords_games`);

const stmtDelete = db.prepare(`DELETE FROM werewords_games WHERE thread_id = ?`);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Serialise a GameState and upsert it into the DB.
 * @param {import('../game/GameManager').GameState} game
 */
function upsert(game) {
  stmtUpsert.run({
    thread_id:               game.threadId,
    guild_id:                game.guildId,
    channel_id:              game.channelId,
    host_id:                 game.hostId,
    host_username:           game.hostUsername,
    message_id:              game.messageId ?? null,
    board_message_id:        game.boardMessageId ?? null,
    phase:                   game.phase,
    players:                 JSON.stringify([...game.players.values()]),
    word:                    game.word ?? null,
    word_options:            JSON.stringify(game.wordOptions ?? []),
    tokens:                  JSON.stringify(game.tokens),
    time_left:               game.timeLeft,
    votes:                   JSON.stringify(Object.fromEntries(game.votes ?? new Map())),
    game_number:             game.gameNumber,
    winner_guesser_user_id:  game.winnerGuesserUserId ?? null,
    created_at:              game._createdAt ?? Date.now(),
  });
}

/**
 * Lightweight update for just the time_left column (called on every board refresh).
 * @param {string} threadId
 * @param {number} timeLeft
 */
function updateTimeLeft(threadId, timeLeft) {
  stmtUpdateTimeLeft.run({ thread_id: threadId, time_left: timeLeft });
}

/**
 * Return all rows (for crash recovery on startup).
 * @returns {object[]}
 */
function getAll() {
  return stmtGetAll.all();
}

/**
 * Delete a game row by threadId.
 * @param {string} threadId
 */
function remove(threadId) {
  stmtDelete.run(threadId);
}

module.exports = { upsert, updateTimeLeft, getAll, remove };
