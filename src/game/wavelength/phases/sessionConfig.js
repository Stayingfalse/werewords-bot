'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const MODE_LABELS = {
  round_robin_times: 'Round Robin · Everyone clues X times',
  snake_points: 'Snake Draft · First to X points',
  endless: 'Endless Mode',
};

function describeSessionMode(sessionMode) {
  if (!sessionMode) return 'Not selected yet';

  if (sessionMode.type === 'round_robin_times') {
    return `${MODE_LABELS.round_robin_times} (X = ${sessionMode.targetClueTurns})`;
  }
  if (sessionMode.type === 'snake_points') {
    return `${MODE_LABELS.snake_points} (X = ${sessionMode.targetPoints})`;
  }
  return `${MODE_LABELS.endless} (${formatClueOrder(sessionMode.clueOrder)})`;
}

function formatClueOrder(clueOrder) {
  if (clueOrder === 'round_robin') return 'Round Robin clue order';
  if (clueOrder === 'snake') return 'Snake Draft clue order';
  return 'Random clue giver';
}

function buildSessionModePromptEmbed(game) {
  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Choose Session Mode')
    .setDescription(
      `Host <@${game.hostId}>, choose how this session should run before Round ${game.gameNumber} starts.\n\n` +
      `1) **Round Robin** until everyone has been Clue Giver X times.\n` +
      `2) **Snake Draft** until one player reaches X points.\n` +
      `3) **Endless Mode** with Round Robin, Snake Draft, or Random clue order.`
    )
    .setColor(0x5865F2)
    .setTimestamp();
}

function buildSessionModePromptComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_mode_rr_times')
      .setLabel('Round Robin (X clues each)')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wl_mode_snake_points')
      .setLabel('Snake Draft (First to X pts)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('wl_mode_endless')
      .setLabel('Endless Mode')
      .setStyle(ButtonStyle.Success),
  );
  return [row];
}

function buildSnakePointsComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_snake_points_30')
      .setLabel('30 pts')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wl_snake_points_45')
      .setLabel('45 pts')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wl_snake_points_60')
      .setLabel('60 pts')
      .setStyle(ButtonStyle.Primary),
  );
  return [row];
}

function buildEndlessClueOrderComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_endless_order_round_robin')
      .setLabel('Round Robin')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wl_endless_order_snake')
      .setLabel('Snake Draft')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('wl_endless_order_random')
      .setLabel('Random')
      .setStyle(ButtonStyle.Success),
  );
  return [row];
}

module.exports = {
  describeSessionMode,
  formatClueOrder,
  buildSessionModePromptEmbed,
  buildSessionModePromptComponents,
  buildSnakePointsComponents,
  buildEndlessClueOrderComponents,
};
