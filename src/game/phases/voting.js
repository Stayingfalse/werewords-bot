const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ROLES } = require('../../utils/roles');
const { endGame } = require('./endGame');
const { buildPlayerStatsEmbed } = require('./sessionEnd');
const GameRepository = require('../../db/GameRepository');

const VOTE_COLOR = 0xEB459E; // pink

const VOTE_DURATION = 15_000;

// ── Embeds ─────────────────────────────────────────────────────────────────────

function buildWordRevealEmbed(game) {
  return new EmbedBuilder()
    .setTitle('🗳️ Final Accusation')
    .setDescription(
      'Discussion is over.\n\n' +
      'Vote for who you think is the **Cheese Thief**.',
    )
    .setColor(VOTE_COLOR)
    .setTimestamp();
}

function buildVoteEmbed(game) {
  const timeStr = `<t:${Math.floor((Date.now() + VOTE_DURATION) / 1000)}:R>`;

  return new EmbedBuilder()
    .setTitle('🗳️ Vote Now')
    .setDescription(
      'Vote for who you think the **Cheese Thief** is.\n\n' +
      `Voting closes ${timeStr}. You can change your vote before it ends.`,
    )
    .setColor(VOTE_COLOR)
    .setTimestamp();
}

// ── Components ─────────────────────────────────────────────────────────────────

/**
 * One button per player in the game (everyone can be suspected).
 * Laid out in rows of up to 5.
 * @param {Map<string, {id: string, username: string}>} players
 */
function buildVoteComponents(players) {
  const all = [...players.values()];
  const rows = [];
  for (let i = 0; i < all.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        all.slice(i, i + 5).map(p =>
          new ButtonBuilder()
            .setCustomId(`ww_vote_${p.id}`)
            .setLabel(p.username)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }
  return rows;
}

// ── Tally ──────────────────────────────────────────────────────────────────────

/**
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 */
async function tallyVotes(game, client) {
  const tally = new Map(); // targetId → count
  for (const targetId of game.votes.values()) {
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
  }

  // Find player(s) with the most votes.
  let maxVotes = 0;
  for (const count of tally.values()) {
    if (count > maxVotes) maxVotes = count;
  }

  const topTargets = [...tally.entries()]
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id);

  if (topTargets.length === 0) {
    await endGame(game, client, 'werewolf_vote');
    return;
  }

  const selectedPlayers = topTargets.map(id => game.players.get(id)).filter(Boolean);
  const hasFallMouse = selectedPlayers.some(p => p.role === ROLES.SEER);
  const hasThief = selectedPlayers.some(p => p.role === ROLES.WEREWOLF);

  if (hasFallMouse) {
    await endGame(game, client, 'fall_mouse_vote');
    return;
  }

  if (hasThief) {
    await endGame(game, client, 'villagers_vote');
    return;
  }

  await endGame(game, client, 'werewolf_vote');
}

// ── Phase entry point ──────────────────────────────────────────────────────────

/**
 * Transitions the game into the voting phase.
 * Posts a public vote message in the thread and starts the 60 s countdown.
 *
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 */
async function startVotingPhase(game, client) {
  // Stop wake/discussion timers if still running.
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }
  if (game.wakeTimeout) {
    clearTimeout(game.wakeTimeout);
    game.wakeTimeout = null;
  }

  game.phase = 'voting';
  GameRepository.upsert(game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) {
    await endGame(game, client, 'werewolf_vote');
    return;
  }

  game.phaseEndsAt = Date.now() + VOTE_DURATION;
  GameRepository.upsert(game);

  // Remove stale action buttons from the board.
  if (game.boardMessageId) {
    const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
    if (bMsg) await bMsg.edit({ components: [] }).catch(() => {});
  }

  await thread.send({ embeds: [buildWordRevealEmbed(game)] }).catch(() => {});

  if (!game.responseStatsShown) {
    await thread.send({ embeds: [buildPlayerStatsEmbed(game)] }).catch(() => {});
    game.responseStatsShown = true;
  }

  await thread.send({
    embeds: [buildVoteEmbed(game)],
    components: buildVoteComponents(game.players),
  }).catch(() => {});

  // Auto-tally when the window expires.
  game.revealTimeout = setTimeout(async () => {
    if (game.phase !== 'voting') return;
    await tallyVotes(game, client);
  }, VOTE_DURATION);
}

module.exports = { startVotingPhase, buildVoteComponents, tallyVotes };
