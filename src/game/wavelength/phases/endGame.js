'use strict';

/**
 * Guards against double-calls and delegates to sessionEnd.
 *
 * @param {import('../../WavelengthManager').WavelengthGameState} game
 * @param {import('discord.js').Client} client
 * @param {object} scores  Output of computeScores() from reveal.js
 */
async function endGame(game, client, scores) {
  if (game.phase === 'ended') return;
  game.phase = 'ended';

  if (game.guessTimeout) {
    clearTimeout(game.guessTimeout);
    game.guessTimeout = null;
  }

  const { runEndSequence } = require('./sessionEnd');
  await runEndSequence(game, client, scores);
}

module.exports = { endGame };
