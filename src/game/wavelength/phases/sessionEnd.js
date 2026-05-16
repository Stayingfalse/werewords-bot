'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { describeSessionMode } = require('./sessionConfig');

/**
 * Run the end-of-round sequence: post winner summary + session controls.
 *
 * @param {import('../../WavelengthManager').WavelengthGameState} game
 * @param {import('discord.js').Client} client
 * @param {object} scores  Output of computeScores() from reveal.js
 */
async function runEndSequence(game, client, scores) {
  // Lazy require to break circular dependency (sessionEnd → interactionHandler → sessionEnd).
  const { startConfiguredRound } = require('../interactionHandler');
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

  // ── Post session summary ───────────────────────────────────────────────────
  const goal = evaluateSessionGoal(game);

  if (game.autoAdvanceRounds && !goal.complete) {
    // Auto-advance: post summary + advance indicator, then start next round automatically.
    await thread.send({
      embeds: [buildSessionSummaryEmbed(game)],
      components: buildAutoAdvanceControls(game),
    }).catch(() => {});

    await thread.send({
      content: '🔄 **Auto-advance is ON** — starting next round in 5 seconds…',
    }).catch(() => {});

    game.autoAdvanceTimeout = setTimeout(async () => {
      game.autoAdvanceTimeout = null;
      if (game.phase !== 'ended') return;
      const resetGame = client.wavelengthManager.resetForRematch(game.threadId, false);
      if (!resetGame) return;
      await startConfiguredRound(resetGame, client);
    }, 5_000);
  } else {
    // Manual advance: post summary + rematch controls.
    await thread.send({
      embeds: [buildSessionSummaryEmbed(game)],
      components: buildRematchComponents(goal.complete, game),
    }).catch(() => {});
  }
}

/**
 * Session summary embed (shown after each round, accumulates history).
 */
function buildSessionSummaryEmbed(game) {
  const cumulative = computeSessionTotals(game);
  const goal = evaluateSessionGoal(game);

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
    .addFields({ name: '🎮 Session Mode', value: describeSessionMode(game.sessionMode) })
    .setColor(0x5865F2)
    .setTimestamp();

  if (cumulative.length > 0) {
    embed.addFields({
      name: '📈 Cumulative Session Scores',
      value: cumulative.map((entry, idx) => `**${idx + 1}.** <@${entry.userId}> — **${entry.total} pts**`).join('\n'),
    });
  }

  if (goal.message) {
    embed.addFields({ name: goal.complete ? '🏁 Goal Reached' : '📌 Goal Progress', value: goal.message });
  }

  return embed;
}

/**
 * Build the auto-advance toggle button (shared between rematch and auto-advance controls).
 * @param {object|null} game
 */
function buildAutoAdvanceToggleButton(game) {
  const autoAdv = game?.autoAdvanceRounds ?? false;
  return new ButtonBuilder()
    .setCustomId('wl_toggle_autoadvance')
    .setLabel(autoAdv ? '✅ Auto-advance: ON' : '❌ Auto-advance: OFF')
    .setStyle(autoAdv ? ButtonStyle.Success : ButtonStyle.Secondary);
}

/**
 * Rematch / Close buttons (only the host can use them).
 * Includes an auto-advance toggle button.
 * @param {boolean} disableNextRound
 * @param {object} [game]  If provided, shows the current auto-advance state on the toggle.
 */
function buildRematchComponents(disableNextRound = false, game = null) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_rematch_same')
      .setLabel('Next Round')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔄')
      .setDisabled(disableNextRound),
    new ButtonBuilder()
      .setCustomId('wl_rematch_open')
      .setLabel('New Game (Open Signups)')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📋'),
    buildAutoAdvanceToggleButton(game),
    new ButtonBuilder()
      .setCustomId('wl_close_session')
      .setLabel('End Game & Close Session')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
  return [row];
}

/**
 * Controls shown during auto-advance countdown — allows host to toggle auto-advance off.
 * @param {object} game
 */
function buildAutoAdvanceControls(game) {
  const row = new ActionRowBuilder().addComponents(
    buildAutoAdvanceToggleButton(game),
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

function evaluateSessionGoal(game) {
  const sessionMode = game.sessionMode;
  if (!sessionMode || sessionMode.type === 'endless') {
    return { complete: false, message: null };
  }

  if (sessionMode.type === 'round_robin_times') {
    const target = Math.max(1, sessionMode.targetClueTurns ?? 1);
    const counts = game.clueOrderState?.clueTurnsByPlayer ?? {};
    const playerIds = [...game.players.keys()];
    const everyoneComplete = playerIds.length > 0 && playerIds.every((id) => (counts[id] ?? 0) >= target);
    const progressLines = playerIds
      .map((id) => `<@${id}>: **${counts[id] ?? 0}/${target}**`)
      .join(' · ');
    return { complete: everyoneComplete, message: progressLines || 'No players tracked yet.' };
  }

  if (sessionMode.type === 'snake_points') {
    const target = Math.max(1, sessionMode.targetPoints ?? 1);
    const totals = computeSessionTotals(game);
    const winner = totals.find(entry => entry.total >= target);
    if (winner) {
      return {
        complete: true,
        message: `<@${winner.userId}> reached **${winner.total}** points (target: **${target}**).`,
      };
    }
    const leader = totals[0];
    return {
      complete: false,
      message: leader
        ? `Leader: <@${leader.userId}> at **${leader.total}/${target}** points.`
        : `First player to **${target}** points wins.`,
    };
  }

  return { complete: false, message: null };
}

function iterateGuesserScores(guesserScores) {
  if (guesserScores instanceof Map) return guesserScores.entries();
  if (guesserScores && typeof guesserScores === 'object') return Object.entries(guesserScores);
  return [];
}

module.exports = {
  runEndSequence,
  buildSessionSummaryEmbed,
  buildRematchComponents,
  buildAutoAdvanceControls,
  computeSessionTotals,
  evaluateSessionGoal,
};
