const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const LOBBY_COLOR   = 0x5865F2; // Discord blurple
const PLAYING_COLOR = 0xED4245; // Red

// ── Lobby embed ────────────────────────────────────────────────────────────────

/**
 * Builds the public lobby embed shown in the game channel.
 * @param {import('../GameManager').GameState} game
 */
function buildLobbyEmbed(game) {
  const playerLines =
    [...game.players.values()]
      .map((p, i) => `\`${String(i + 1).padStart(2, '0')}.\` <@${p.id}>`)
      .join('\n') || '*No players yet — be the first to join!*';

  return new EmbedBuilder()
    .setTitle('🐺  Werewords — Lobby')
    .setDescription(
      'A social deduction game of magic words and hidden roles.\n' +
      'Click **Join** to enter. The host can **Start** when at least 3 players are ready.',
    )
    .addFields({ name: `Players (${game.players.size} / 10)`, value: playerLines })
    .setColor(LOBBY_COLOR)
    .setFooter({ text: `Host: @${game.hostUsername}  •  Minimum 3 players required` })
    .setTimestamp();
}

// ── Lobby action row ───────────────────────────────────────────────────────────

/** Returns the Join / Leave / Start action row for the lobby. */
function buildLobbyComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_join')
        .setLabel('Join')
        .setEmoji('✋')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ww_leave')
        .setLabel('Leave')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ww_start')
        .setLabel('Start Game')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ── Starting / transition embed ────────────────────────────────────────────────

/**
 * Replaces the lobby embed once the game has started.
 * @param {import('../GameManager').GameState} game
 */
function buildStartingEmbed(game) {
  const playerMentions =
    [...game.players.values()].map(p => `<@${p.id}>`).join(', ');

  return new EmbedBuilder()
    .setTitle('🐺  Werewords — Starting!')
    .setDescription(
      'Roles have been secretly assigned. Press **View Secret Info** to see your role.\n' +
      '⏳ The Mayor is choosing the magic word…',
    )
    .addFields({ name: 'Players', value: playerMentions })
    .setColor(PLAYING_COLOR)
    .setFooter({ text: 'Game board loading…' })
    .setTimestamp();
}

// ── Playing-phase components ───────────────────────────────────────────────────

/** Returns the single "View Secret Info" button shown on the playing embed. */
function buildPlayingComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_secret')
        .setLabel('View Secret Info')
        .setEmoji('🔍')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Returns the Mayor's word-picker action row: three preset word buttons and a
 * "Custom Word" button that opens a modal.
 * @param {string[]} wordOptions  Three preset words from game.wordOptions
 */
function buildMayorWordComponents(wordOptions) {
  return [
    new ActionRowBuilder().addComponents(
      ...wordOptions.map((word, i) =>
        new ButtonBuilder()
          .setCustomId(`ww_word_${i}`)
          .setLabel(word)
          .setStyle(ButtonStyle.Primary),
      ),
      new ButtonBuilder()
        .setCustomId('ww_word_custom')
        .setLabel('Custom Word')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

module.exports = {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildStartingEmbed,
  buildPlayingComponents,
  buildMayorWordComponents,
};
