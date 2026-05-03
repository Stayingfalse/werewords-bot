const { ROLES } = require('../utils/roles');
const { buildGuessComponents } = require('../game/phases/playing');

/** Handle a message inside an active werewords playing-phase thread. */
async function handleGameMessage(message, gameManager) {
  const game = gameManager.getGame(message.channel.id);
  if (!game || game.phase !== 'playing' || !game.word) return;

  const player = game.players.get(message.author.id);
  if (!player || player.role === ROLES.MAYOR) return;

  await message.channel.send({
    content: `🎯 <@${message.author.id}> guesses: **"${message.content}"**`,
    components: buildGuessComponents(message.author.id, game.tokens),
  });
}

module.exports = {
  name: 'messageCreate',

  async execute(message, client) {
    // Ignore bots, DMs, and system messages.
    if (message.author.bot || !message.guild || message.system) return;

    await handleGameMessage(message, client.gameManager);

    // ── SassyBot AI features (opt-in via SASSY_ENABLED=true) ─────────────────
    if (client.sassyManager) {
      await client.sassyManager.handleMessage(message);
    }
  },
};
