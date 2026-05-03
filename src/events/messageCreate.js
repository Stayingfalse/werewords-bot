const { ROLES } = require('../utils/roles');
const { buildGuessComponents } = require('../game/phases/playing');

module.exports = {
  name: 'messageCreate',

  async execute(message, client) {
    // Ignore bots, DMs, and system messages.
    if (message.author.bot || !message.guild || message.system) return;

    const { gameManager } = client;
    const game = gameManager.getGame(message.channel.id);

    // Only process messages inside an active playing-phase game thread.
    if (game && game.phase === 'playing') {
      // Guessing only makes sense once the Wordsmith has chosen the forbidden word.
      if (game.word) {
        // Only players who joined the game can make guesses.
        const player = game.players.get(message.author.id);
        if (player && player.role !== ROLES.MAYOR) {
          // Announce the guess publicly so all thread members see it, with
          // Accept / Reject buttons only visible to (and usable by) the Wordsmith.
          await message.channel.send({
            content: `🎯 <@${message.author.id}> guesses: **"${message.content}"**`,
            components: buildGuessComponents(message.author.id, game.tokens),
          });
        }
      }
    }

    // ── SassyBot AI features (opt-in via SASSY_ENABLED=true) ─────────────────
    if (client.sassyManager) {
      await client.sassyManager.handleMessage(message);
    }
  },
};
