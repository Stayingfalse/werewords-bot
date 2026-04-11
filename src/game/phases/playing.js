const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const BOARD_COLOR = 0xED4245; // Red

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Formats seconds as M:SS.
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Board embed ────────────────────────────────────────────────────────────────

/**
 * Builds the live game board embed shown inside the private thread.
 * Updated on each timer tick and after each token use.
 * @param {import('../GameManager').GameState} game
 */
function buildBoardEmbed(game) {
  const { tokens, timeLeft, players } = game;

  const playerList = [...players.values()].map(p => `<@${p.id}>`).join(' • ');

  return new EmbedBuilder()
    .setTitle('🔮  The Forbidden Word — Game Board')
    .setDescription(
      game.word
        ? '🔤 The forbidden word has been chosen. Type any message in this thread to make a guess!'
        : '⏳ Waiting for the Wordsmith to choose the forbidden word…',
    )
    .addFields(
      { name: '⏱ Time Remaining', value: formatTime(timeLeft) },
      { name: '✅ Yes', value: `${tokens.yes} / 14`, inline: true },
      { name: '❌ No', value: `${tokens.no} / 5`, inline: true },
      { name: '❔ Maybe', value: `${tokens.maybe} / 1`, inline: true },
      { name: 'Players', value: playerList },
    )
    .setColor(BOARD_COLOR)
    .setFooter({ text: 'Wordsmith: use the Yes / No / Maybe buttons to answer questions.' })
    .setTimestamp();
}

// ── Wordsmith action buttons ──────────────────────────────────────────────────

/**
 * Returns the Wordsmith's Yes / No / Maybe action row.
 * Buttons are disabled when the corresponding token count reaches zero.
 * @param {{ yes: number, no: number, maybe: number }} tokens
 */
function buildMayorActionComponents(tokens) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_yes')
        .setLabel('Yes')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(tokens.yes <= 0),
      new ButtonBuilder()
        .setCustomId('ww_no')
        .setLabel('No')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(tokens.no <= 0),
      new ButtonBuilder()
        .setCustomId('ww_maybe')
        .setLabel('Maybe')
        .setEmoji('❔')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(tokens.maybe <= 0),
    ),
  ];
}

// ── Guess announcement components ─────────────────────────────────────────────

/**
 * Returns the Accept / Reject action row posted when a player makes a guess.
 * Only the Wordsmith can interact with these buttons.
 * @param {string} guesserId  The user ID of the player who made the guess.
 */
function buildGuessComponents(guesserId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ww_guess_accept_${guesserId}`)
        .setLabel('Accept ✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ww_guess_reject_${guesserId}`)
        .setLabel('Reject ❌')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

module.exports = {
  formatTime,
  buildBoardEmbed,
  buildMayorActionComponents,
  buildGuessComponents,
};
