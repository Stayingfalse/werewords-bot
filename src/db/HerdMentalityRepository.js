'use strict';

const db = require('./database');

const stmtUpsert = db.prepare(`
  INSERT INTO herd_mentality_games
    (thread_id, guild_id, channel_id, host_id, host_username, message_id,
     question_message_id, phase, players, answers, current_question, round_number,
     pink_cow_holder_id, target_score, used_questions, phase_ends_at,
     game_number, review_groups, created_at)
  VALUES
    (@thread_id, @guild_id, @channel_id, @host_id, @host_username, @message_id,
     @question_message_id, @phase, @players, @answers, @current_question, @round_number,
     @pink_cow_holder_id, @target_score, @used_questions, @phase_ends_at,
     @game_number, @review_groups, @created_at)
  ON CONFLICT(thread_id) DO UPDATE SET
    guild_id             = excluded.guild_id,
    channel_id           = excluded.channel_id,
    host_id              = excluded.host_id,
    host_username        = excluded.host_username,
    message_id           = excluded.message_id,
    question_message_id  = excluded.question_message_id,
    phase                = excluded.phase,
    players              = excluded.players,
    answers              = excluded.answers,
    current_question     = excluded.current_question,
    round_number         = excluded.round_number,
    pink_cow_holder_id   = excluded.pink_cow_holder_id,
    target_score         = excluded.target_score,
    used_questions       = excluded.used_questions,
    phase_ends_at        = excluded.phase_ends_at,
    game_number          = excluded.game_number,
    review_groups        = excluded.review_groups
`);

const stmtGetAll = db.prepare('SELECT * FROM herd_mentality_games');
const stmtDelete = db.prepare('DELETE FROM herd_mentality_games WHERE thread_id = ?');

/**
 * @param {object} game  HerdMentalityGameState-shaped object
 */
function upsert(game) {
  stmtUpsert.run({
    thread_id:           game.threadId,
    guild_id:            game.guildId,
    channel_id:          game.channelId,
    host_id:             game.hostId,
    host_username:       game.hostUsername,
    message_id:          game.messageId ?? null,
    question_message_id: game.questionMessageId ?? null,
    phase:               game.phase,
    players:             JSON.stringify([...game.players.values()]),
    answers:             JSON.stringify(Object.fromEntries(game.answers ?? new Map())),
    current_question:    game.currentQuestion ?? null,
    round_number:        game.roundNumber ?? 0,
    pink_cow_holder_id:  game.pinkCowHolderId ?? null,
    target_score:        game.targetScore ?? 8,
    used_questions:      JSON.stringify([...(game.usedQuestions ?? new Set())]),
    phase_ends_at:       game.phaseEndsAt ?? null,
    game_number:         game.gameNumber ?? 1,
    review_groups:       game.reviewGroups ? JSON.stringify(game.reviewGroups) : null,
    created_at:          game._createdAt ?? Date.now(),
  });
}

function getAll() {
  return stmtGetAll.all();
}

function remove(threadId) {
  stmtDelete.run(threadId);
}

module.exports = { upsert, getAll, remove };
