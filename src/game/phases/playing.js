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
      { name: '✅ ❌  Yes / No', value: `${tokens.yes_no} / 36`, inline: true },
      { name: '❔ Maybe', value: `${tokens.maybe} / 12`, inline: true },
      { name: '✅ Correct', value: `${tokens.correct} / 1`, inline: true },
      { name: '🔥 ❌  So Close / Way Off', value: `${tokens.so_close_way_off} / 2`, inline: true },
      { name: 'Players', value: playerList },
    )
    .setColor(BOARD_COLOR)
    .setFooter({ text: 'Wordsmith: answer questions with Yes / No / Maybe. When a player guesses the word, tap ✅ Correct! or ❌ Way Off! on their guess message.' })
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
        .setDisabled(tokens.yes_no <= 0),
      new ButtonBuilder()
        .setCustomId('ww_no')
        .setLabel('No')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(tokens.yes_no <= 0),
      new ButtonBuilder()
        .setCustomId('ww_maybe')
        .setLabel('Maybe')
        .setEmoji('❔')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(tokens.maybe <= 0),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_correct')
        .setLabel('Correct!')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(tokens.correct <= 0),
      new ButtonBuilder()
        .setCustomId('ww_soclose')
        .setLabel('So Close!')
        .setEmoji('🔥')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(tokens.so_close_way_off <= 0),
      new ButtonBuilder()
        .setCustomId('ww_wayoff')
        .setLabel('Way Off!')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(tokens.so_close_way_off <= 0),
    ),
  ];
}

// ── Guess announcement components ─────────────────────────────────────────────

/**
 * Returns the Accept / Reject action row posted when a player makes a guess.
 * Only the Wordsmith can interact with these buttons.
 * @param {string} guesserId  The user ID of the player who made the guess.
 * @param {{ correct: number, so_close_way_off: number }} tokens
 */
function buildGuessComponents(guesserId, tokens) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ww_guess_correct_${guesserId}`)
        .setLabel('✅ Correct!')
        .setStyle(ButtonStyle.Success)
        .setDisabled(tokens.correct <= 0),
      new ButtonBuilder()
        .setCustomId(`ww_guess_soclose_${guesserId}`)
        .setLabel('🔥 So Close!')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(tokens.so_close_way_off <= 0),
      new ButtonBuilder()
        .setCustomId(`ww_guess_wayoff_${guesserId}`)
        .setLabel('❌ Way Off!')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(tokens.so_close_way_off <= 0),
    ),
  ];
}

module.exports = {
  formatTime,
  buildBoardEmbed,
  buildMayorActionComponents,
  buildGuessComponents,
};
