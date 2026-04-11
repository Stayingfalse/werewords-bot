'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Run the end-of-round sequence: post winner summary + session controls.
 *
 * @param {import('../../WavelengthManager').WavelengthGameState} game
 * @param {import('discord.js').Client} client
 * @param {object} scores  Output of computeScores() from reveal.js
 */
async function runEndSequence(game, client, scores) {
  const thread = await client.channels.fetch(game.threadId).catch(() => null);

  // ── Update parent-channel embed ────────────────────────────────────────────
  if (game.channelId && game.messageId) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (channel) {
      const lobbyMsg = await channel.messages.fetch(game.messageId).catch(() => null);
      if (lobbyMsg) {
        const doneEmbed = new EmbedBuilder()
          .setTitle('〰️ Wavelength — Game Complete')
          .setDescription(`**Game ${game.gameNumber}** has ended!`)
          .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
          .setColor(0x2ECC71)
          .setTimestamp();
        await lobbyMsg.edit({ embeds: [doneEmbed], components: [] }).catch(() => {});
      }
    }
  }

  if (!thread) return;

  // ── Post session summary + rematch controls ────────────────────────────────
  await thread.send({
    embeds: [buildSessionSummaryEmbed(game)],
    components: buildRematchComponents(),
  }).catch(() => {});
}

/**
 * Session summary embed (shown after each round, accumulates history).
 */
function buildSessionSummaryEmbed(game) {
  const clueGiver = game.players.get(game.clueGiverId);

  const lines = game.sessionHistory.map(h => {
    const avg = h.scores?.avgPosition ?? '?';
    return (
      `**Game ${h.gameNumber}** — \`${h.spectrum?.left}\` ↔ \`${h.spectrum?.right}\`\n` +
      `Clue: "${h.clue}" · Target: \`${h.target}\` · Group avg: \`${avg}\``
    );
  });

  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Session Summary')
    .setDescription(lines.length > 0 ? lines.join('\n\n') : '*No rounds yet.*')
    .setColor(0x5865F2)
    .setTimestamp();
}

/**
 * Rematch / Close buttons (only the host can use them).
 */
function buildRematchComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_rematch_same')
      .setLabel('Rematch — Same Players')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId('wl_rematch_open')
      .setLabel('Rematch — Open Sign-ups')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋'),
    new ButtonBuilder()
      .setCustomId('wl_close_session')
      .setLabel('Close Session')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
  return [row];
}

module.exports = { runEndSequence, buildSessionSummaryEmbed, buildRematchComponents };
