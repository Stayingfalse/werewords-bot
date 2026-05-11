const { ROLES } = require('../utils/roles');
const { buildGuessComponents } = require('../game/phases/playing');

/** Handle a message inside an active werewords playing-phase thread. */
async function handleGameMessage(message, gameManager) {
  const game = gameManager.getGame(message.channel.id);
  if (!game || game.phase !== 'playing' || !game.word) return;

  // In voice mode guesses are called out verbally — don't process text messages as guesses.
  if (game.sessionMode === 'voice') return;

  const player = game.players.get(message.author.id);
  if (!player || player.role === ROLES.MAYOR) return;

  await message.channel.send({
    content: `🎯 <@${message.author.id}> guesses: **"${message.content}"**`,
    components: buildGuessComponents(message.author.id, game.tokens),
  });

  if (message.deletable) {
    await message.delete().catch(() => {});
  }
}

module.exports = {
  name: 'messageCreate',

  async execute(message, client) {
    // Ignore bots and system messages.
    if (message.author.bot || message.system) return;

    try {
      // Game message handling only applies to guild channels.
      if (message.guild) {
        await handleGameMessage(message, client.gameManager);
      }

      // ── SassyBot AI features (opt-in via SASSY_ENABLED=true) ─────────────────
      if (client.sassyManager) {
        // Suppress unprompted interjections while an active game is running in
        // this thread so Sassy doesn't disrupt gameplay.  Direct mentions/replies
        // and DMs still work normally.
        const inActiveThread = message.guild && (
          !!client.gameManager.getGame(message.channel.id) ||
          !!client.cheeseThiefManager?.getGame(message.channel.id)
        );
        await client.sassyManager.handleMessage(message, { suppressInterjections: inActiveThread });
      }
    } catch (err) {
      console.error('[messageCreate error]', err);
    }
  },
};
