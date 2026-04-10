const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { buildLobbyEmbed, buildLobbyComponents } = require('../game/phases/lobby');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('werewords')
    .setDescription('Start a new Werewords game lobby in this channel'),

  async execute(interaction, client) {
    const { guildId, user, channel } = interaction;
    const { gameManager } = client;

    // If this user already hosts a game in this guild, tear it down first.
    const existing = gameManager.getGameByHost(guildId, user.id);
    if (existing) {
      gameManager.deleteGame(existing.threadId);
      try {
        const oldThread = await client.channels.fetch(existing.threadId).catch(() => null);
        if (oldThread) {
          await oldThread.delete('Host started a new Werewords game').catch(async () => {
            await oldThread.setArchived(true).catch(() => {});
          });
        }
      } catch {
        // Thread already gone — nothing to do.
      }
    }

    // Create a private thread for the game players.
    let thread;
    try {
      thread = await channel.threads.create({
        name: `Werewords 🐺 — ${user.username}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        reason: `Werewords game started by ${user.username}`,
      });
      // Add the host to the private thread immediately.
      await thread.members.add(user.id);
    } catch {
      return interaction.reply({
        content:
          '❌ **Missing permissions.** The bot needs the following in this channel:\n' +
          '• `Create Private Threads`\n' +
          '• `Send Messages in Threads`\n' +
          '• `Manage Threads` *(to clean up finished games)*\n\n' +
          '*Note: Private threads require a Community server or Boost Level 1+.*',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = gameManager.createGame(guildId, channel.id, thread.id, user.id, user.username);
    gameManager.addPlayer(thread.id, user);

    // Post the lobby embed publicly in the channel as the slash command reply.
    const { resource } = await interaction.reply({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(thread.id),
      withResponse: true,
    });

    game.messageId = resource.message.id;
  },
};

