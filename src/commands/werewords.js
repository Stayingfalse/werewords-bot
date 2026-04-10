const { SlashCommandBuilder, MessageFlags } = require('discord.js');
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
          // Try to delete; fall back to archiving if the bot lacks MANAGE_THREADS.
          await oldThread.delete('Host started a new Werewords game').catch(async () => {
            await oldThread.setArchived(true).catch(() => {});
          });
        }
      } catch {
        // Thread already gone — nothing to do.
      }
    }

    // Create a fresh public thread for the new game.
    let thread;
    try {
      thread = await channel.threads.create({
        name: `Werewords 🐺 — ${user.username}`,
        autoArchiveDuration: 60,
        reason: `Werewords game started by ${user.username}`,
      });
    } catch {
      return interaction.reply({
        content:
          '❌ **Missing permissions.** The bot needs the following in this channel:\n' +
          '• `Create Public Threads`\n' +
          '• `Send Messages in Threads`\n' +
          '• `Manage Threads` *(to clean up finished games)*',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = gameManager.createGame(guildId, thread.id, user.id, user.username);
    gameManager.addPlayer(thread.id, user);

    const message = await thread.send({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(),
    });

    game.messageId = message.id;

    // Acknowledge the slash command in the original channel.
    return interaction.reply({
      content: `✅ Your game lobby is ready! Head over to ${thread} to join.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
