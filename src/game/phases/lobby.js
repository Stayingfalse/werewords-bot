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
    .addFields(
      { name: `Players (${game.players.size} / 10)`, value: playerLines },
      { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
    )
    .setColor(LOBBY_COLOR)
    .setFooter({ text: `Host: @${game.hostUsername}  •  Minimum 3 players required` })
    .setTimestamp();
}

// ── Lobby action row ───────────────────────────────────────────────────────────

/**
 * Returns the Join / Leave / Start action row for the lobby.
 * @param {string} threadId  The private game thread ID, embedded in each button's customId.
 */
function buildLobbyComponents(threadId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ww_join_${threadId}`)
        .setLabel('Join')
        .setEmoji('✋')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ww_leave_${threadId}`)
        .setLabel('Leave')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ww_start_${threadId}`)
        .setLabel('Start Game')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

// ── Active game embed (shown in main channel after game starts) ───────────────

/**
 * Replaces the lobby embed in the main channel once the game has started.
 * Shows the game is underway and links to the private game thread.
 * @param {import('../GameManager').GameState} game
 */
function buildActiveEmbed(game) {
  const playerMentions =
    [...game.players.values()].map(p => `<@${p.id}>`).join(', ');

  return new EmbedBuilder()
    .setTitle('🐺  Werewords — In Progress')
    .setDescription('A game is currently underway!')
    .addFields(
      { name: 'Players', value: playerMentions },
      { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
    )
    .setColor(PLAYING_COLOR)
    .setFooter({ text: `Host: @${game.hostUsername}` })
    .setTimestamp();
}

// ── Game thread embed (first message posted inside the private thread) ─────────

/**
 * Posted inside the private game thread when the game starts.
 * @param {import('../GameManager').GameState} game
 */
function buildGameThreadEmbed(game) {
  const playerMentions =
    [...game.players.values()].map(p => `<@${p.id}>`).join(', ');

  return new EmbedBuilder()
    .setTitle('🐺  Werewords — Game Started!')
    .setDescription(
      'Roles have been secretly assigned.\n' +
      'Press **View Secret Info** to see your role.\n' +
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
  buildActiveEmbed,
  buildGameThreadEmbed,
  buildPlayingComponents,
  buildMayorWordComponents,
};
