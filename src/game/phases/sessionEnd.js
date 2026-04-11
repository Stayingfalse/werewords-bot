const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ROLES } = require('../../utils/roles');
const { recordGame } = require('../../utils/StatsManager');
const { buildLobbyEmbed, buildLobbyComponents } = require('./lobby');

const ROLE_EMOJI = {
  [ROLES.MAYOR]:    '📝',
  [ROLES.WEREWOLF]: '😈',
  [ROLES.SEER]:     '📚',
  [ROLES.VILLAGER]: '🏡',
};

const OUTCOME_COLOR = {
  villagers_word:  0x57F287,
  villagers_vote:  0x57F287,
  werewolf_time:   0xED4245,
  werewolf_tokens: 0xED4245,
  werewolf_seer:   0xED4245,
  werewolf_vote:   0xED4245,
};

const OUTCOME_BANNER = {
  villagers_word:  { title: '🎉  Townsfolk Win!',   description: 'The forbidden word was guessed correctly — and the Demon stayed hidden!' },
  villagers_vote:  { title: '🎉  Townsfolk Win!',   description: 'The Townsfolk correctly voted out the Demon!' },
  werewolf_time:   { title: '😈  Demons Win!',      description: 'Time ran out before the forbidden word was guessed.' },
  werewolf_tokens: { title: '😈  Demons Win!',      description: 'All tokens were exhausted before the forbidden word was guessed.' },
  werewolf_seer:   { title: '😈  Demons Win!',      description: 'The Demon revealed and correctly identified the Librarian — stealing the win!' },
  werewolf_vote:   { title: '😈  Demons Win!',      description: 'The Townsfolk failed to unmask the Demon.' },
};

// ── Embeds ─────────────────────────────────────────────────────────────────────

function buildWinnerEmbed(game, outcome) {
  const { title, description } = OUTCOME_BANNER[outcome];
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .addFields({ name: '🔤 The Forbidden Word', value: `**${game.word || '*(never chosen)*'}**` })
    .setColor(OUTCOME_COLOR[outcome])
    .setTimestamp();
}

function buildSessionSummaryEmbed(game, guildStats) {
  // Per-player session record (wins/losses across this session's games).
  const sessionLines = [...game.players.values()].map(p => {
    const record = game.sessionHistory.reduce(
      (acc, g) => {
        const isWinner = g.winners.has(p.id);
        return { w: acc.w + (isWinner ? 1 : 0), l: acc.l + (isWinner ? 0 : 1) };
      },
      { w: 0, l: 0 },
    );
    return `<@${p.id}> — **${record.w}W / ${record.l}L** this session`;
  });

  // Career totals from persistent stats.
  const careerLines = [...game.players.values()].map(p => {
    const s = guildStats[p.id];
    if (!s) return `<@${p.id}> — no prior stats`;
    const wr = s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0;
    return `<@${p.id}> — ${s.gamesPlayed} played · ${s.wins}W/${s.losses}L · ${wr}% win rate`;
  });

  return new EmbedBuilder()
    .setTitle(`📊  Session Summary — ${game.gameNumber} game${game.gameNumber !== 1 ? 's' : ''} played`)
    .addFields(
      { name: 'This Session', value: sessionLines.join('\n') || '*No data*' },
      { name: 'Career Totals', value: careerLines.join('\n') || '*No data*' },
    )
    .setColor(0x5865F2)
    .setTimestamp();
}

function buildRematchComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_rematch_same')
        .setLabel('Rematch (Same Group)')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('ww_rematch_open')
        .setLabel('Rematch (Open Sign-ups)')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ww_close_session')
        .setLabel('Close Session')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Sequential role reveal ─────────────────────────────────────────────────────

/** Posts one message per player, 1.5 s apart, revealing their role. */
async function postSequentialReveal(thread, players) {
  const list = [...players.values()];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const emoji = ROLE_EMOJI[p.role] ?? '❓';
    await thread.send({ content: `${emoji}  <@${p.id}> was the **${p.role}**` }).catch(() => {});
    if (i < list.length - 1) await delay(1500);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * Full end-game sequence:
 *   1. Post winner banner
 *   2. "🎭 Let's see who everyone was…" message
 *   3. Sequential role reveals (1.5 s apart)
 *   4. Record stats + append to session history
 *   5. Post session summary + rematch/close buttons
 *   6. Update main channel embed
 *
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 * @param {string} outcome
 * @param {string|null} seerVictimUserId  The userId the Demon correctly named (if any).
 */
async function runEndSequence(game, client, outcome, seerVictimUserId = null) {
  const thread = await client.channels.fetch(game.threadId).catch(() => null);

  if (thread) {
    // 1. Winner banner.
    await thread.send({ embeds: [buildWinnerEmbed(game, outcome)] }).catch(() => {});

    await delay(1500);

    // 2. Transition line.
    await thread.send({ content: '🎭 Let\'s see who everyone was…' }).catch(() => {});

    await delay(1000);

    // 3. Sequential role reveal.
    await postSequentialReveal(thread, game.players);

    await delay(1000);
  }

  // 4. Record stats + session history.
  // Build winner set for session history.
  const VILLAGER_WIN_OUTCOMES = new Set(['villagers_word', 'villagers_vote']);
  const werewolfWins = !VILLAGER_WIN_OUTCOMES.has(outcome);
  const winnerIds = new Set(
    [...game.players.values()]
      .filter(p => werewolfWins ? p.role === ROLES.WEREWOLF : p.role !== ROLES.WEREWOLF)
      .map(p => p.id),
  );

  game.sessionHistory.push({
    gameNumber: game.gameNumber,
    outcome,
    word: game.word,
    winners: winnerIds,
    players: [...game.players.values()].map(p => ({ id: p.id, username: p.username, role: p.role })),
  });

  recordGame(
    game.guildId,
    game.players,
    outcome,
    game.winnerGuesserUserId,
    seerVictimUserId,
  );

  // 5. Session summary + action buttons.
  const { getGuildStats } = require('../../utils/StatsManager');
  const guildStats = getGuildStats(game.guildId);

  if (thread) {
    await thread.send({
      embeds: [buildSessionSummaryEmbed(game, guildStats)],
      components: buildRematchComponents(),
    }).catch(() => {});
  }

  // 6. Update main channel embed.
  if (game.channelId && game.messageId) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (channel) {
      const lobbyMsg = await channel.messages.fetch(game.messageId).catch(() => null);
      if (lobbyMsg) {
        const { title } = OUTCOME_BANNER[outcome];
        const waitEmbed = new EmbedBuilder()
          .setTitle(`�  The Forbidden Word — Game ${game.gameNumber} Complete`)
          .setDescription(`**${title}** — waiting for the host to start the next game or close the session.`)
          .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
          .setColor(OUTCOME_COLOR[outcome])
          .setTimestamp();
        await lobbyMsg.edit({ embeds: [waitEmbed], components: [] }).catch(() => {});
      }
    }
  }
}

module.exports = { runEndSequence, buildRematchComponents, buildSessionSummaryEmbed };
