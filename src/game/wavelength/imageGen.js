'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const https = require('https');

// ── Canvas layout constants ────────────────────────────────────────────────────
const W          = 800;
const H          = 220;
const BAR_X1     = 70;   // left edge of spectrum bar
const BAR_X2     = 730;  // right edge of spectrum bar
const BAR_Y      = 100;  // centre-line of bar
const BAR_H      = 40;   // bar height
const LABEL_Y    = 185;  // concept labels baseline
const SCORE_Y    = 30;   // tier band label y

// Tier thresholds (distance from target, inclusive).
const TIER_BULLSEYE = 5;
const TIER_CLOSE    = 10;
const TIER_NEAR     = 20;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Convert a 0–100 position value to a canvas x coordinate. */
function posToX(pos) {
  return BAR_X1 + (pos / 100) * (BAR_X2 - BAR_X1);
}

/**
 * Fetch an image URL and return a Buffer.
 * Uses Node's built-in https so no extra dep is needed.
 */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Draw the gradient spectrum bar onto a canvas context.
 * Left side is warm orange, right side is cool blue — generic enough for any pair.
 */
function drawBar(ctx) {
  const grad = ctx.createLinearGradient(BAR_X1, 0, BAR_X2, 0);
  grad.addColorStop(0,    '#E74C3C'); // red-orange (left)
  grad.addColorStop(0.5,  '#F1C40F'); // yellow (centre)
  grad.addColorStop(1,    '#3498DB'); // blue (right)

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(BAR_X1, BAR_Y - BAR_H / 2, BAR_X2 - BAR_X1, BAR_H, 8);
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(BAR_X1, BAR_Y - BAR_H / 2, BAR_X2 - BAR_X1, BAR_H, 8);
  ctx.stroke();
}

/**
 * Draw concept labels centred at each end of the bar.
 */
function drawLabels(ctx, spectrum) {
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';

  // Left label
  ctx.fillText(spectrum.left,  BAR_X1 + (BAR_X2 - BAR_X1) * 0.12, LABEL_Y);
  // Right label
  ctx.fillText(spectrum.right, BAR_X1 + (BAR_X2 - BAR_X1) * 0.88, LABEL_Y);
}

/**
 * Draw a circular-clipped avatar at a given x position above the bar.
 * Falls back to a solid circle with the user's initial if the avatar fails.
 */
async function drawAvatar(ctx, avatarURL, username, x, y, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();

  try {
    const buf = await fetchBuffer(avatarURL);
    const img = await loadImage(buf);
    ctx.drawImage(img, x - radius, y - radius, radius * 2, radius * 2);
  } catch {
    // Fallback: solid colour + initial
    ctx.fillStyle = '#7289DA';
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
    ctx.save();
    ctx.font = `bold ${radius}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText((username ?? '?')[0].toUpperCase(), x, y);
  }

  ctx.restore();

  // White ring
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Draw a diamond shape at xPos on the bar (used for the target marker).
 */
function drawDiamond(ctx, xPos, color = '#FFD700', size = 14) {
  const yPos = BAR_Y;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xPos,        yPos - size);
  ctx.lineTo(xPos + size, yPos);
  ctx.lineTo(xPos,        yPos + size);
  ctx.lineTo(xPos - size, yPos);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/** Fill the canvas background. */
function drawBackground(ctx) {
  ctx.fillStyle = '#2C2F33';
  ctx.fillRect(0, 0, W, H);
}

// ── Scoring bands (drawn as semi-transparent overlays on reveal) ──────────────
function drawScoringBands(ctx, targetX) {
  const bands = [
    { dist: TIER_BULLSEYE, color: 'rgba(46, 204, 113, 0.30)' },  // green — bullseye ±5
    { dist: TIER_CLOSE,    color: 'rgba(52, 152, 219, 0.20)' },  // blue  — close ±10
    { dist: TIER_NEAR,     color: 'rgba(255, 193, 7,  0.15)' },  // amber — near ±20
  ];

  const pxPer = (BAR_X2 - BAR_X1) / 100;

  for (const { dist, color } of bands) {
    const x1 = Math.max(BAR_X1, targetX - dist * pxPer);
    const x2 = Math.min(BAR_X2, targetX + dist * pxPer);
    ctx.fillStyle = color;
    ctx.fillRect(x1, BAR_Y - BAR_H / 2, x2 - x1, BAR_H);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate the image shown (ephemerally) to the Clue Giver.
 * Shows the spectrum bar and the hidden target marked with a diamond.
 *
 * @param {{ left: string, right: string }} spectrum
 * @param {number} targetPosition  0–100
 * @returns {Promise<Buffer>}
 */
async function generateClueGiverImage(spectrum, targetPosition) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx);
  drawBar(ctx);

  const tX = posToX(targetPosition);
  drawDiamond(ctx, tX, '#FFD700', 16);

  // Label above the diamond
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#FFD700';
  ctx.fillText('TARGET', tX, BAR_Y - BAR_H / 2 - 4);

  drawLabels(ctx, spectrum);

  // Title
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('🎯 Your hidden target', 10, 8);

  return canvas.toBuffer('image/png');
}

/**
 * Generate the per-guesser nudge panel image.
 * Shows the spectrum bar with the guesser's avatar at their current position.
 *
 * @param {string} avatarURL
 * @param {string} username
 * @param {{ left: string, right: string }} spectrum
 * @param {number} position  0–100
 * @returns {Promise<Buffer>}
 */
async function generateGuesserImage(avatarURL, username, spectrum, position) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx);
  drawBar(ctx);

  const aX = posToX(position);
  // Avatar sits just above the bar
  await drawAvatar(ctx, avatarURL, username, aX, BAR_Y - BAR_H / 2 - 26, 20);

  // Vertical marker line
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(aX, BAR_Y - BAR_H / 2);
  ctx.lineTo(aX, BAR_Y + BAR_H / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Position label
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(`${position}`, aX, BAR_Y + BAR_H / 2 + 4);

  drawLabels(ctx, spectrum);

  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('📍 Your guess', 10, 8);

  return canvas.toBuffer('image/png');
}

/**
 * Generate the public reveal image posted in the thread.
 * Shows all guesser avatars, the target diamond, the group-average marker,
 * and semi-transparent tier-band overlays.
 *
 * @param {{ left: string, right: string }} spectrum
 * @param {number} targetPosition
 * @param {Array<{ userId: string, username: string, avatarURL: string, position: number }>} playerGuesses
 * @returns {Promise<Buffer>}
 */
async function generateRevealImage(spectrum, targetPosition, playerGuesses) {
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx);
  drawBar(ctx);

  const tX = posToX(targetPosition);
  drawScoringBands(ctx, tX);

  // Group average
  if (playerGuesses.length > 0) {
    const avg = playerGuesses.reduce((s, g) => s + g.position, 0) / playerGuesses.length;
    const aX  = posToX(avg);

    // Triangle marker for average
    const sz = 10;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(aX,      BAR_Y + BAR_H / 2 + sz * 2);
    ctx.lineTo(aX - sz, BAR_Y + BAR_H / 2);
    ctx.lineTo(aX + sz, BAR_Y + BAR_H / 2);
    ctx.closePath();
    ctx.fillStyle = '#E91E63';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#E91E63';
    ctx.fillText('AVG', aX, BAR_Y + BAR_H / 2 + sz * 2 + 2);
  }

  // Target diamond
  drawDiamond(ctx, tX, '#FFD700', 16);
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#FFD700';
  ctx.fillText('TARGET', tX, BAR_Y - BAR_H / 2 - 4);

  // Player avatars — stack them vertically if they cluster at the same x.
  // Group by rounded x position (±6 px bucket).
  const BUCKET = 6;
  const buckets = new Map(); // xBucket → array index for vertical stacking
  const AVATAR_R = 18;
  const AVATAR_BASE_Y = BAR_Y - BAR_H / 2 - AVATAR_R - 6;

  for (const g of playerGuesses) {
    const x   = posToX(g.position);
    const key = Math.round(x / BUCKET);
    const idx = buckets.has(key) ? buckets.get(key) : 0;
    buckets.set(key, idx + 1);
    const y = AVATAR_BASE_Y - idx * (AVATAR_R * 2 + 4);
    await drawAvatar(ctx, g.avatarURL, g.username, x, y, AVATAR_R);
  }

  drawLabels(ctx, spectrum);

  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('🏁 Results', 10, 8);

  return canvas.toBuffer('image/png');
}

module.exports = { generateClueGiverImage, generateGuesserImage, generateRevealImage };
