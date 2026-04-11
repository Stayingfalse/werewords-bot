const { runEndSequence } = require('./sessionEnd');

// ── Outcome definitions (kept for reference / future use) ─────────────────────

const OUTCOMES = {
  villagers_word: {
    title: '🎉 Townsfolk Win!',
    description: 'The forbidden word was correctly guessed and the Demon stayed hidden!',
    color: 0x57F287, // green
  },
  werewolf_time: {
    title: '😈 Demons Win!',
    description: 'Time ran out before the forbidden word was guessed.',
    color: 0xED4245, // red
  },
  werewolf_tokens: {
    title: '😈 Demons Win!',
    description: 'All tokens were used up before the forbidden word was guessed.',
    color: 0xED4245, // red
  },
  werewolf_seer: {
    title: '😈 Demons Win!',
    description: 'The word was guessed but the Demon revealed themselves and correctly identified the Librarian!',
    color: 0xED4245, // red
  },
  villagers_vote: {
    title: '🎉 Townsfolk Win!',
    description: 'The Townsfolk voted correctly and exposed the Demon!',
    color: 0x57F287, // green
  },
  werewolf_vote: {
    title: '😈 Demons Win!',
    description: 'The Townsfolk failed to identify the Demon.',
    color: 0xED4245, // red
  },
};

// ── End-game logic ─────────────────────────────────────────────────────────────

/**
 * Finalises the game:
 *  1. Clears timers and sets phase to 'ended'.
 *  2. Removes Wordsmith action buttons from the board.
 *  3. Delegates presentation to runEndSequence (sequential reveal, stats, rematch buttons).
 *  4. Does NOT delete the game from the registry — the session lives on until
 *     the host clicks "Close Session".
 *
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 * @param {string} outcome
 * @param {string|null} [seerVictimUserId]  userId the Demon correctly named as Librarian.
 */
async function endGame(game, client, outcome, seerVictimUserId = null) {
  // Guard against being called twice.
  if (game.phase === 'ended') return;

  // Stop timers immediately.
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }
  if (game.revealTimeout) {
    clearTimeout(game.revealTimeout);
    game.revealTimeout = null;
  }

  game.phase = 'ended';

  // Remove Wordsmith action buttons from the board so they can't be clicked.
  if (game.boardMessageId) {
    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      const boardMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
      if (boardMsg) await boardMsg.edit({ components: [] }).catch(() => {});
    }
  }

  // Hand off to the full end-game presentation sequence.
  await runEndSequence(game, client, outcome, seerVictimUserId);
}

module.exports = { endGame };
