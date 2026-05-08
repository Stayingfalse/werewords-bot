const { SlashCommandBuilder, MessageFlags, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function buildLobbyEmbed(game) {
  const players = [...game.players.values()]
    .map((p, i) => `\`${String(i + 1).padStart(2, '0')}.\` <@${p.id}>`)
    .join('\n') || '*No players yet — be the first to join!*';

  return new EmbedBuilder()
    .setTitle('🧀 Cheese Thief — Lobby')
    .setDescription('Hidden-role game with wake phases and a final accusation.')
    .addFields(
      { name: `Players (${game.players.size} / 10)`, value: players },
      { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
    )
    .setColor(0x5865F2)
    .setFooter({ text: `Host: @${game.hostUsername}  •  Minimum 3 players required` })
    .setTimestamp();
}

function buildLobbyComponents(threadId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ct_join_${threadId}`).setLabel('Join').setEmoji('✋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ct_leave_${threadId}`).setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ct_start_${threadId}`).setLabel('Start Game').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ct_cancel_${threadId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    ),
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cheesethief')
    .setDescription('Start a new Cheese Thief game lobby in this channel'),

  async execute(interaction, client) {
    const { guildId, user, channel } = interaction;
    const { cheeseThiefManager } = client;

    const existing = cheeseThiefManager.getGameByHost(guildId, user.id);
    if (existing) {
      cheeseThiefManager.deleteGame(existing.threadId);
      const oldThread = await client.channels.fetch(existing.threadId).catch(() => null);
      if (oldThread) {
        await oldThread.delete('Host started a new Cheese Thief game').catch(async () => {
          await oldThread.setArchived(true).catch(() => {});
        });
      }
    }

    let thread;
    try {
      thread = await channel.threads.create({
        name: `Cheese Thief — ${user.username}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        reason: `Cheese Thief game started by ${user.username}`,
      });
      await thread.members.add(user.id);
    } catch {
      return interaction.reply({
        content:
          '❌ **Missing permissions.** The bot needs:\n' +
          '• `Create Private Threads`\n' +
          '• `Send Messages in Threads`\n' +
          '• `Manage Threads`',
        flags: MessageFlags.Ephemeral,
      });
    }

    const game = cheeseThiefManager.createGame(guildId, channel.id, thread.id, user.id, user.username);
    cheeseThiefManager.addPlayer(thread.id, user);

    const { resource } = await interaction.reply({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(thread.id),
      withResponse: true,
    });

    game.messageId = resource.message.id;
  },

  buildLobbyEmbed,
  buildLobbyComponents,
};
