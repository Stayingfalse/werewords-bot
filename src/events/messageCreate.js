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
    if (!game || game.phase !== 'playing') return;

    // Guessing only makes sense once the Wordsmith has chosen the forbidden word.
    if (!game.word) return;

    // Only players who joined the game can make guesses.
    const player = game.players.get(message.author.id);
    if (!player) return;

    // The Wordsmith knows the word — they respond via Yes/No/Maybe, not guesses.
    if (player.role === ROLES.MAYOR) return;

    // Announce the guess publicly so all thread members see it, with
    // Accept / Reject buttons only visible to (and usable by) the Wordsmith.
    await message.channel.send({
      content: `🎯 <@${message.author.id}> guesses: **"${message.content}"**`,
      components: buildGuessComponents(message.author.id),
    });
  },
};
