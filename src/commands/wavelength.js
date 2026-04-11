'use strict';

const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { buildLobbyEmbed, buildLobbyComponents } = require('../game/wavelength/phases/lobby');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wavelength')
    .setDescription('Start a new Wavelength game lobby in this channel'),

  async execute(interaction, client) {
    const { guildId, user, channel } = interaction;
    const { wavelengthManager } = client;

    // If this user already hosts a Wavelength game in this guild, tear it down first.
    const existing = wavelengthManager.getGameByHost(guildId, user.id);
    if (existing) {
      wavelengthManager.deleteGame(existing.threadId);
      try {
        const oldThread = await client.channels.fetch(existing.threadId).catch(() => null);
        if (oldThread) {
          await oldThread.delete('Host started a new Wavelength game').catch(async () => {
            await oldThread.setArchived(true).catch(() => {});
          });
        }
      } catch {
        // Thread already gone.
      }
    }

    // Create a private thread for the game.
    let thread;
    try {
      thread = await channel.threads.create({
        name: `Wavelength 〰️ — ${user.username}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        reason: `Wavelength game started by ${user.username}`,
      });
      await thread.members.add(user.id);
    } catch {
      return interaction.reply({
        content:
          '❌ **Missing permissions.** The bot needs the following in this channel:\n' +
          '• `Create Private Threads`\n' +
          '• `Send Messages in Threads`\n' +
          '• `Manage Threads`\n\n' +
          '*Note: Private threads require a Community server or Boost Level 1+.*',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = wavelengthManager.createGame(guildId, channel.id, thread.id, user.id, user.username);
    wavelengthManager.addPlayer(thread.id, user);

    // Post the lobby embed in the parent channel as the slash command reply.
    const { resource } = await interaction.reply({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(thread.id),
      withResponse: true,
    });

    game.messageId = resource.message.id;
  },
};
