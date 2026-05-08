'use strict';

const db = require('./database');

const stmtUpsert = db.prepare(`
  INSERT INTO cheese_thief_games
    (thread_id, guild_id, channel_id, host_id, host_username, message_id,
     ready_message_id, phase, players, ready_players, votes,
     current_wake_number, phase_ends_at, cheese_stolen, thief_id, accomplice_id,
     stolen_at_wake, game_number, created_at)
  VALUES
    (@thread_id, @guild_id, @channel_id, @host_id, @host_username, @message_id,
     @ready_message_id, @phase, @players, @ready_players, @votes,
     @current_wake_number, @phase_ends_at, @cheese_stolen, @thief_id, @accomplice_id,
     @stolen_at_wake, @game_number, @created_at)
  ON CONFLICT(thread_id) DO UPDATE SET
    guild_id            = excluded.guild_id,
    channel_id          = excluded.channel_id,
    host_id             = excluded.host_id,
    host_username       = excluded.host_username,
    message_id          = excluded.message_id,
    ready_message_id    = excluded.ready_message_id,
    phase               = excluded.phase,
    players             = excluded.players,
    ready_players       = excluded.ready_players,
    votes               = excluded.votes,
    current_wake_number = excluded.current_wake_number,
    phase_ends_at       = excluded.phase_ends_at,
    cheese_stolen       = excluded.cheese_stolen,
    thief_id            = excluded.thief_id,
    accomplice_id       = excluded.accomplice_id,
    stolen_at_wake      = excluded.stolen_at_wake,
    game_number         = excluded.game_number
`);

const stmtGetAll = db.prepare('SELECT * FROM cheese_thief_games');
const stmtDelete = db.prepare('DELETE FROM cheese_thief_games WHERE thread_id = ?');

/**
 * @param {import('../game/CheeseThiefManager').CheeseThiefGameState|object} game
 */
function upsert(game) {
  stmtUpsert.run({
    thread_id: game.threadId,
    guild_id: game.guildId,
    channel_id: game.channelId,
    host_id: game.hostId,
    host_username: game.hostUsername,
    message_id: game.messageId ?? null,
    ready_message_id: game.readyMessageId ?? null,
    phase: game.phase,
    players: JSON.stringify([...game.players.values()]),
    ready_players: JSON.stringify([...game.readyPlayers]),
    votes: JSON.stringify(Object.fromEntries(game.votes ?? new Map())),
    current_wake_number: game.currentWakeNumber ?? 0,
    phase_ends_at: game.phaseEndsAt ?? null,
    cheese_stolen: game.cheeseStolen ? 1 : 0,
    thief_id: game.thiefId ?? null,
    accomplice_id: game.accompliceId ?? null,
    stolen_at_wake: game.stolenAtWake ?? null,
    game_number: game.gameNumber ?? 1,
    created_at: game._createdAt ?? Date.now(),
  });
}

function getAll() {
  return stmtGetAll.all();
}

function remove(threadId) {
  stmtDelete.run(threadId);
}

module.exports = { upsert, getAll, remove };
