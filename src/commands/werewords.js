const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildLobbyEmbed, buildLobbyComponents } = require('../game/phases/lobby');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('werewords')
    .setDescription('Create a Werewords game lobby in this channel'),

  async execute(interaction, client) {
    const { guildId, channelId, user } = interaction;
    const { gameManager } = client;

    if (gameManager.getGame(guildId)) {
      return interaction.reply({
        content:
          '⚠️ A Werewords game is already running in this server. ' +
          'The current game must end before a new lobby can be created.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = gameManager.createGame(guildId, channelId, user.id, user.username);
    gameManager.addPlayer(guildId, user);

    const { resource } = await interaction.reply({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(),
      withResponse: true,
    });

    game.messageId = resource.message.id;
  },
};
