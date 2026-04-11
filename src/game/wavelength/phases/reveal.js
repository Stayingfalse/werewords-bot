'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { generateRevealImage } = require('../imageGen');

// ── Scoring constants ──────────────────────────────────────────────────────────
const TIER_BULLSEYE = 5;   // ±5  → 4 pts
const TIER_CLOSE    = 10;  // ±10 → 3 pts
const TIER_NEAR     = 20;  // ±20 → 2 pts
// Outside → 0 pts

/**
 * Calculate individual tier score for one guess.
 * @param {number} guess
 * @param {number} target
 * @returns {number} 4 | 3 | 2 | 0
 */
function tierScore(guess, target) {
  const dist = Math.abs(guess - target);
  if (dist <= TIER_BULLSEYE) return 4;
  if (dist <= TIER_CLOSE)    return 3;
  if (dist <= TIER_NEAR)     return 2;
  return 0;
}

/**
 * Calculate group-average position from all submitted guesses.
 * @param {Map} guesses  game.guesses
 * @returns {number|null} rounded integer or null if no guesses
 */
function groupAverage(guesses) {
  const positions = [...guesses.values()].map(g => g.position);
  if (positions.length === 0) return null;
  return Math.round(positions.reduce((s, p) => s + p, 0) / positions.length);
}

/**
 * Calculate standard deviation of all guess positions.
 * Used for the Clue Giver synergy bonus.
 */
function stdDev(guesses) {
  const positions = [...guesses.values()].map(g => g.position);
  if (positions.length < 2) return 0;
  const mean = positions.reduce((s, p) => s + p, 0) / positions.length;
  const variance = positions.reduce((s, p) => s + (p - mean) ** 2, 0) / positions.length;
  return Math.sqrt(variance);
}

/**
 * Compute all scores for the round and return a structured object.
 *
 * Returns:
 *  {
 *    guesserScores:  Map<userId, { individual: number, bonus: number, total: number, tier: string }>
 *    clueGiverScore: { fromGuessers: number, synergy: number, total: number }
 *    avgPosition:    number | null
 *    avgScore:       number          (tier score of the group average vs target)
 *    deviation:      number
 *  }
 */
function computeScores(game) {
  const target  = game.targetPosition;
  const avg     = groupAverage(game.guesses);
  const avgScr  = avg !== null ? tierScore(avg, target) : 0;
  const dev     = stdDev(game.guesses);

  // Synergy bonus: ≤10 σ → +5 pts, ≤15 σ → +3 pts, else 0
  const synergy = dev <= 10 ? 5 : dev <= 15 ? 3 : 0;

  const guesserScores = new Map();
  let clueGiverFromGuessers = 0;

  for (const [userId, { position }] of game.guesses) {
    const individual = tierScore(position, target);
    const bonus      = avgScr; // same tier points as the group average earns
    const total      = individual + bonus;

    const tierLabel = individual === 4 ? '🎯 Bullseye'
                    : individual === 3 ? '🔵 Close'
                    : individual === 2 ? '🟡 Near'
                    : '⚫ Miss';

    guesserScores.set(userId, { individual, bonus, total, tier: tierLabel });
    clueGiverFromGuessers += individual; // Clue Giver earns what guessers earn
  }

  const clueGiverTotal = clueGiverFromGuessers + synergy;

  return {
    guesserScores,
    clueGiverScore: { fromGuessers: clueGiverFromGuessers, synergy, total: clueGiverTotal },
    avgPosition: avg,
    avgScore: avgScr,
    deviation: Math.round(dev * 10) / 10,
  };
}

/**
 * Entry point for the reveal phase.
 * Calculates scores, generates the canvas image, posts both in the thread.
 *
 * @param {import('../../WavelengthManager').WavelengthGameState} game
 * @param {import('discord.js').Client} client
 */
async function startRevealPhase(game, client) {
  if (game.phase === 'reveal' || game.phase === 'ended') return;
  game.phase = 'reveal';

  if (game.guessTimeout) {
    clearTimeout(game.guessTimeout);
    game.guessTimeout = null;
  }

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  // Build the data array for the image.
  const playerGuesses = [];
  for (const [userId, { position }] of game.guesses) {
    const player = game.players.get(userId);
    if (player) {
      playerGuesses.push({ userId, username: player.username, avatarURL: player.avatarURL, position });
    }
  }

  // Generate reveal canvas
  let imageBuffer = null;
  try {
    imageBuffer = await generateRevealImage(game.chosenSpectrum, game.targetPosition, playerGuesses);
  } catch (err) {
    console.error('[Wavelength] generateRevealImage failed:', err);
  }

  const scores = computeScores(game);

  // Record into session history
  game.sessionHistory.push({
    gameNumber:    game.gameNumber,
    target:        game.targetPosition,
    clue:          game.clue,
    spectrum:      game.chosenSpectrum,
    guesses:       Object.fromEntries(game.guesses),
    scores,
  });

  // ── Post reveal image ──────────────────────────────────────────────────────
  if (imageBuffer) {
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'wavelength_reveal.png' });
    await thread.send({
      content: `🎯 **The target was at position ${game.targetPosition}!**`,
      files: [attachment],
    }).catch(() => {});
  } else {
    await thread.send({ content: `🎯 **The target was at position ${game.targetPosition}!**` }).catch(() => {});
  }

  // ── Post score embed ───────────────────────────────────────────────────────
  await thread.send({ embeds: [buildRevealEmbed(game, scores)] }).catch(() => {});

  // ── Transition to ended ────────────────────────────────────────────────────
  const { endGame } = require('./endGame');
  await endGame(game, client, scores);
}

/**
 * Build the score breakdown embed.
 */
function buildRevealEmbed(game, scores) {
  const clueGiver = game.players.get(game.clueGiverId);

  const guesserLines = [...scores.guesserScores.entries()].map(([userId, s]) => {
    const player = game.players.get(userId);
    const pos    = game.guesses.get(userId)?.position ?? '?';
    return `<@${userId}> — pos \`${pos}\` ${s.tier} **${s.individual}** + group bonus **+${s.bonus}** = **${s.total} pts**`;
  });

  const embed = new EmbedBuilder()
    .setTitle('〰️ Wavelength — Scores')
    .setDescription(
      `**Spectrum:** \`${game.chosenSpectrum.left}\` ↔ \`${game.chosenSpectrum.right}\`\n` +
      `**Clue:** "${game.clue}"\n` +
      `**Target:** position \`${game.targetPosition}\`\n` +
      (scores.avgPosition !== null ? `**Group Average:** position \`${scores.avgPosition}\`\n` : '') +
      `**Deviation (σ):** ${scores.deviation}`
    )
    .setColor(0x2ECC71);

  if (guesserLines.length > 0) {
    embed.addFields({ name: '📊 Guesser Scores', value: guesserLines.join('\n') });
  }

  embed.addFields({
    name: '🎤 Clue Giver Score',
    value:
      `<@${game.clueGiverId}> (${clueGiver?.username ?? '?'})\n` +
      `From guessers: **${scores.clueGiverScore.fromGuessers} pts**` +
      (scores.clueGiverScore.synergy > 0
        ? ` + synergy bonus: **+${scores.clueGiverScore.synergy} pts**`
        : '') +
      ` = **${scores.clueGiverScore.total} pts**`,
  });

  return embed;
}

module.exports = { startRevealPhase, buildRevealEmbed, computeScores };
