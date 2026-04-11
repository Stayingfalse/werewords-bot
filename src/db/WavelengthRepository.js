'use strict';

const db = require('./database');

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtUpsert = db.prepare(`
  INSERT INTO wavelength_games
    (thread_id, guild_id, channel_id, host_id, host_username,
     message_id, board_message_id, phase, players, clue_giver_id,
     spectrum_options, chosen_spectrum, target_position, clue,
     guesses, game_number, created_at)
  VALUES
    (@thread_id, @guild_id, @channel_id, @host_id, @host_username,
     @message_id, @board_message_id, @phase, @players, @clue_giver_id,
     @spectrum_options, @chosen_spectrum, @target_position, @clue,
     @guesses, @game_number, @created_at)
  ON CONFLICT(thread_id) DO UPDATE SET
    guild_id         = excluded.guild_id,
    channel_id       = excluded.channel_id,
    host_id          = excluded.host_id,
    host_username    = excluded.host_username,
    message_id       = excluded.message_id,
    board_message_id = excluded.board_message_id,
    phase            = excluded.phase,
    players          = excluded.players,
    clue_giver_id    = excluded.clue_giver_id,
    spectrum_options = excluded.spectrum_options,
    chosen_spectrum  = excluded.chosen_spectrum,
    target_position  = excluded.target_position,
    clue             = excluded.clue,
    guesses          = excluded.guesses,
    game_number      = excluded.game_number
`);

const stmtGetAll = db.prepare(`SELECT * FROM wavelength_games`);

const stmtDelete = db.prepare(`DELETE FROM wavelength_games WHERE thread_id = ?`);

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Serialise a WavelengthGameState and upsert it into the DB.
 * @param {import('../game/WavelengthManager').WavelengthGameState} game
 */
function upsert(game) {
  stmtUpsert.run({
    thread_id:        game.threadId,
    guild_id:         game.guildId,
    channel_id:       game.channelId,
    host_id:          game.hostId,
    host_username:    game.hostUsername,
    message_id:       game.messageId ?? null,
    board_message_id: game.boardMessageId ?? null,
    phase:            game.phase,
    players:          JSON.stringify([...game.players.values()]),
    clue_giver_id:    game.clueGiverId ?? null,
    spectrum_options: JSON.stringify(game.spectrumOptions ?? []),
    chosen_spectrum:  game.chosenSpectrum ? JSON.stringify(game.chosenSpectrum) : null,
    target_position:  game.targetPosition ?? null,
    clue:             game.clue ?? null,
    guesses:          JSON.stringify(Object.fromEntries(game.guesses ?? new Map())),
    game_number:      game.gameNumber,
    created_at:       game._createdAt ?? Date.now(),
  });
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

module.exports = { upsert, getAll, remove };
