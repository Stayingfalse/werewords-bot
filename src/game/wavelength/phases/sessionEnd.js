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
          .setTitle('〰️ Wavelength — Round Complete')
          .setDescription(`**Round ${game.gameNumber}** has ended!`)
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
  const cumulative = computeSessionTotals(game);

  const lines = game.sessionHistory.map(h => {
    // Backward compatibility for in-memory sessions that still have `gameNumber`.
    const roundNo = h.roundNumber ?? h.gameNumber ?? '?';
    const avg = h.scores?.avgPosition ?? '?';
    const roundTotal = computeRoundTotal(h);
    return (
      `**Round ${roundNo}** — \`${h.spectrum?.left}\` ↔ \`${h.spectrum?.right}\`\n` +
      `Clue: "${h.clue}" · Target: \`${h.target}\` · Group avg: \`${avg}\` · Round pts: **${roundTotal}**`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle('〰️ Wavelength — Session Summary')
    .setDescription(lines.length > 0 ? lines.join('\n\n') : '*No rounds yet.*')
    .setColor(0x5865F2)
    .setTimestamp();

  if (cumulative.length > 0) {
    embed.addFields({
      name: '📈 Cumulative Session Scores',
      value: cumulative.map((entry, idx) => `**${idx + 1}.** <@${entry.userId}> — **${entry.total} pts**`).join('\n'),
    });
  }

  return embed;
}

/**
 * Rematch / Close buttons (only the host can use them).
 */
function buildRematchComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_rematch_same')
      .setLabel('Next Round')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId('wl_rematch_open')
      .setLabel('New Game (Open Signups)')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋'),
    new ButtonBuilder()
      .setCustomId('wl_close_session')
      .setLabel('End Game & Close Session')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
  return [row];
}

function computeRoundTotal(roundHistory) {
  let total = 0;
  for (const [, value] of iterateGuesserScores(roundHistory?.scores?.guesserScores)) {
    total += value?.total ?? 0;
  }
  total += roundHistory?.scores?.clueGiverScore?.total ?? 0;
  return total;
}

function computeSessionTotals(game) {
  const totals = new Map();

  for (const round of game.sessionHistory ?? []) {
    for (const [userId, value] of iterateGuesserScores(round?.scores?.guesserScores)) {
      totals.set(userId, (totals.get(userId) ?? 0) + (value?.total ?? 0));
    }

    if (round?.clueGiverId) {
      totals.set(
        round.clueGiverId,
        (totals.get(round.clueGiverId) ?? 0) + (round?.scores?.clueGiverScore?.total ?? 0),
      );
    }
  }

  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total);
}

function iterateGuesserScores(guesserScores) {
  if (guesserScores instanceof Map) return guesserScores.entries();
  if (guesserScores && typeof guesserScores === 'object') return Object.entries(guesserScores);
  return [];
}

module.exports = { runEndSequence, buildSessionSummaryEmbed, buildRematchComponents, computeSessionTotals };
