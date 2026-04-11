'use strict';

/**
 * Shared helper: start (or restart) the werewords game-board timer.
 * Called both from interactionCreate.js (initial start) and restore.js (crash recovery).
 *
 * @param {import('../game/GameManager').GameState} game
 * @param {import('discord.js').ThreadChannel} thread
 * @param {import('discord.js').Client} client
 */
function startGameTimer(game, thread, client) {
  const { buildBoardEmbed, buildMayorActionComponents } = require('../game/phases/playing');
  const { startVotingPhase } = require('../game/phases/voting');
  const { updateTimeLeft } = require('../db/GameRepository');

  let boardRefreshing = false;

  game.timerInterval = setInterval(async () => {
    if (game.phase !== 'playing') return;

    game.timeLeft--;

    if (game.timeLeft <= 0) {
      game.timeLeft = 0;
      await startVotingPhase(game, client);
      return;
    }

    const updateEvery = game.timeLeft > 60 ? 30
                      : game.timeLeft > 30 ? 10
                      : 5;

    if (game.timeLeft % updateEvery === 0 && game.boardMessageId && !boardRefreshing) {
      updateTimeLeft(game.threadId, game.timeLeft);
      boardRefreshing = true;
      try {
        const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
        if (bMsg) {
          await bMsg.edit({
            embeds: [buildBoardEmbed(game)],
            components: buildMayorActionComponents(game.tokens),
          }).catch(err => {
            if (err?.status === 429) {
              console.warn(`[Board] Rate limited (thread ${game.threadId}, ${game.timeLeft}s left) — skipping tick`);
            }
          });
        }
      } finally {
        boardRefreshing = false;
      }
    }
  }, 1_000);
}

module.exports = { startGameTimer };
