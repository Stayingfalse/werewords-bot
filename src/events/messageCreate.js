const { ROLES } = require('../utils/roles');
const { buildGuessComponents } = require('../game/phases/playing');

/** Handle a message inside an active werewords playing-phase thread. */
async function handleGameMessage(message, gameManager) {
  const game = gameManager.getGame(message.channel.id);
  if (!game) return;
}

module.exports = {
  name: 'messageCreate',

  async execute(message, client) {
    // Ignore bots, DMs, and system messages.
    if (message.author.bot || !message.guild || message.system) return;

    await handleGameMessage(message, client.gameManager);

    // ── SassyBot AI features (opt-in via SASSY_ENABLED=true) ─────────────────
    if (client.sassyManager) {
      // Suppress unprompted interjections while an active game is running in
      // this thread so Sassy doesn't disrupt gameplay.  Direct mentions/replies
      // still work normally.
      const inActiveThread = !!client.gameManager.getGame(message.channel.id);
      await client.sassyManager.handleMessage(message, { suppressInterjections: inActiveThread });
    }
  },
};
