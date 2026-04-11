const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ROLES } = require('../../utils/roles');
const { endGame } = require('./endGame');

const VOTE_COLOR = 0xEB459E; // pink

const VOTE_DURATION = 60_000; // 60 seconds

// ── Embed ──────────────────────────────────────────────────────────────────────

function buildVoteEmbed(game) {
  const timeStr = `<t:${Math.floor((Date.now() + VOTE_DURATION) / 1000)}:R>`;

  return new EmbedBuilder()
    .setTitle('🗳️  Werewords — Vote!')
    .setDescription(
      'The magic word was **not** guessed in time!\n\n' +
      'Vote for who you think the **Werewolf** is. ' +
      'If the majority picks correctly, the Villagers win!\n\n' +
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
 * Counts current votes, determines the winner, and calls endGame.
 * Tie → werewolf_vote (Werewolves win). Majority on Werewolf → villagers_vote.
 *
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

  // Tie → Werewolves win.
  if (topTargets.length !== 1) {
    await endGame(game, client, 'werewolf_vote');
    return;
  }

  // Check if the top target is the Werewolf.
  const suspected = game.players.get(topTargets[0]);
  const isWerewolf = suspected?.role === ROLES.WEREWOLF;

  await endGame(game, client, isWerewolf ? 'villagers_vote' : 'werewolf_vote');
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
  // Stop the main countdown timer if still running.
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }

  game.phase = 'voting';

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) {
    await endGame(game, client, 'werewolf_vote');
    return;
  }

  // Remove Mayor action buttons from the board.
  if (game.boardMessageId) {
    const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
    if (bMsg) await bMsg.edit({ components: [] }).catch(() => {});
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
