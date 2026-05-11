'use strict';

const {
  SlashCommandBuilder,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

function buildLobbyEmbed(game) {
  const players = [...game.players.values()]
    .map((p, i) => `\`${String(i + 1).padStart(2, '0')}.\` <@${p.id}>`)
    .join('\n') || '*No players yet — be the first to join!*';

  return new EmbedBuilder()
    .setTitle('🐄 Herd Mentality — Lobby')
    .setDescription(
      'Think like the herd! Answer questions to match the majority. ' +
      'The player whose answer matches the most others scores a point. ' +
      'First to **8 points** (without the 🐄 pink cow) wins!',
    )
    .addFields(
      { name: `Players (${game.players.size} / 12)`, value: players },
      { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
    )
    .setColor(0xF4A261)
    .setFooter({ text: `Host: @${game.hostUsername}  •  Minimum 2 players required` })
    .setTimestamp();
}

function buildLobbyComponents(threadId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hm_join_${threadId}`).setLabel('Join').setEmoji('✋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hm_leave_${threadId}`).setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`hm_start_${threadId}`).setLabel('Start Game').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`hm_cancel_${threadId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    ),
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('herdmentality')
    .setDescription('Start a new Herd Mentality game lobby in this channel'),

  async execute(interaction, client) {
    const { guildId, user, channel } = interaction;
    const { herdMentalityManager } = client;

    const existing = herdMentalityManager.getGameByHost(guildId, user.id);
    if (existing) {
      herdMentalityManager.deleteGame(existing.threadId);
      const oldThread = await client.channels.fetch(existing.threadId).catch(() => null);
      if (oldThread) {
        await oldThread.delete('Host started a new Herd Mentality game').catch(async () => {
          await oldThread.setArchived(true).catch(() => {});
        });
      }
    }

    let thread;
    try {
      thread = await channel.threads.create({
        name: `Herd Mentality 🐄 — ${user.username}`,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 60,
        reason: `Herd Mentality game started by ${user.username}`,
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

    const game = herdMentalityManager.createGame(guildId, channel.id, thread.id, user.id, user.username);
    herdMentalityManager.addPlayer(thread.id, user);

    const { resource } = await interaction.reply({
      embeds: [buildLobbyEmbed(game)],
      components: buildLobbyComponents(thread.id),
      withResponse: true,
    });

    game.messageId = resource.message.id;
    client.herdMentalityManager.saveGame(game.threadId);
  },

  buildLobbyEmbed,
  buildLobbyComponents,
};
