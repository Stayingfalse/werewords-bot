const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ROLES } = require('../../utils/roles');
const { endGame } = require('./endGame');
const GameRepository = require('../../db/GameRepository');

const REVEAL_COLOR = 0xFEE75C; // yellow

// ── Embed ──────────────────────────────────────────────────────────────────────

function buildRevealEmbed(game) {
  return new EmbedBuilder()
    .setTitle('�  The Forbidden Word — The Word Was Guessed!')
    .setDescription(
      `The forbidden word **"${game.word}"** was correctly guessed!\n\n` +
      '**Demon:** you may now reveal yourself to attempt to identify the Librarian.\n' +
      'If you correctly name the Librarian, your team steals the win!\n\n' +
      '_If you choose not to reveal, the Townsfolk win._',
    )
    .setColor(REVEAL_COLOR)
    .setTimestamp();
}

// ── Components ─────────────────────────────────────────────────────────────────

/** Single button for the Demon to kick off the reveal. */
function buildRevealComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_reveal')
        .setLabel('Reveal Yourself')
        .setEmoji('😈')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * One button per player who could be the Librarian (excludes the Demon themselves
 * and the Wordsmith, since neither can be the Librarian).
 * @param {Map<string, {id: string, username: string, role: string}>} players
 * @param {string} werewolfId
 */
function buildSeerPickComponents(players, werewolfId) {
  const candidates = [...players.values()].filter(
    p => p.id !== werewolfId && p.role !== ROLES.MAYOR,
  );

  const rows = [];
  for (let i = 0; i < candidates.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        candidates.slice(i, i + 5).map(p =>
          new ButtonBuilder()
            .setCustomId(`ww_seer_pick_${p.id}`)
            .setLabel(p.username)
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }
  return rows;
}

// ── Phase entry point ──────────────────────────────────────────────────────────

/**
 * Transitions the game into the reveal phase.
 * - If no Librarian exists (3-player game) the Townsfolk win immediately.
 * - Otherwise posts the reveal message with a 90 s safety timeout.
 *
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 */
async function startRevealPhase(game, client) {
  // Stop the main countdown timer.
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }

  // No Librarian in this game → Townsfolk win straight away.
  const hasSeer = [...game.players.values()].some(p => p.role === ROLES.SEER);
  if (!hasSeer) {
    await endGame(game, client, 'villagers_word');
    return;
  }

  game.phase = 'reveal';
  GameRepository.upsert(game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) {
    await endGame(game, client, 'villagers_word');
    return;
  }

  // Remove Wordsmith action buttons from the board now that the word phase is over.
  if (game.boardMessageId) {
    const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
    if (bMsg) await bMsg.edit({ components: [] }).catch(() => {});
  }

  await thread.send({
    embeds: [buildRevealEmbed(game)],
    components: buildRevealComponents(),
  }).catch(() => {});

  // 90 s safety net — if the Demon goes AFK the Townsfolk win.
  game.revealTimeout = setTimeout(async () => {
    if (game.phase !== 'reveal') return;
    await endGame(game, client, 'villagers_word');
  }, 90_000);
}

module.exports = { startRevealPhase, buildRevealComponents, buildSeerPickComponents };
