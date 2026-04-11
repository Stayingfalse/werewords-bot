'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Public lobby embed shown in the parent channel.
 */
function buildLobbyEmbed(game) {
  const playerList = game.players.size === 0
    ? '*No players yet — be the first to join!*'
    : [...game.players.values()].map(p => `• ${p.username}`).join('\n');

  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Lobby Open')
    .setDescription(
      `**Host:** ${game.hostUsername}\n\n` +
      `**Players (${game.players.size}/20):**\n${playerList}\n\n` +
      `A random **Clue Giver** will be chosen when the game starts.\n` +
      `The Clue Giver picks a spectrum and gives a one-word clue. Everyone else nudges a marker to guess where they think the target sits!`
    )
    .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
    .setColor(0x5865F2)
    .setFooter({ text: 'Minimum 2 players to start' })
    .setTimestamp();
}

/**
 * Lobby Join / Leave / Start / Cancel buttons.
 */
function buildLobbyComponents(threadId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_join_${threadId}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✋'),
    new ButtonBuilder()
      .setCustomId(`wl_leave_${threadId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🚪'),
    new ButtonBuilder()
      .setCustomId(`wl_start_${threadId}`)
      .setLabel('Start Game')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('▶️'),
    new ButtonBuilder()
      .setCustomId(`wl_cancel_${threadId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✖️'),
  );
  return [row];
}

/**
 * "Game In Progress" embed shown in the parent channel while the game is active.
 */
function buildActiveEmbed(game) {
  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Game In Progress')
    .setDescription(`**Game ${game.gameNumber}** is underway inside the thread.`)
    .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
    .setColor(0xF39C12)
    .setTimestamp();
}

/**
 * First message posted inside the private game thread at game start.
 */
function buildGameThreadEmbed(game) {
  const clueGiver = game.players.get(game.clueGiverId);
  return new EmbedBuilder()
    .setTitle(`〰️ Wavelength — Game ${game.gameNumber}`)
    .setDescription(
      `Welcome! **<@${game.clueGiverId}> (${clueGiver?.username ?? '?'})** is the Clue Giver this round.\n\n` +
      `**Clue Giver:** You'll receive a private message with two spectrum options to choose from, then submit one word as your clue.\n\n` +
      `**Everyone else:** Once the clue is revealed, click **"View Guess Panel"** to position your marker on the spectrum.`
    )
    .setColor(0x5865F2)
    .setTimestamp();
}

module.exports = {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildActiveEmbed,
  buildGameThreadEmbed,
};
