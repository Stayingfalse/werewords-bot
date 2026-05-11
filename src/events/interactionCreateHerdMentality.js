'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const { buildLobbyEmbed, buildLobbyComponents } = require('../commands/herdmentality');

const questions = require('../../data/herd_mentality_questions.json').questions;

const ANSWER_DURATION_MS = 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function persistGame(client, game) {
  if (!game) return;
  client.herdMentalityManager?.saveGame(game.threadId);
}

/** Normalise an answer string for comparison. */
function normalise(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

/** Pick a question not yet used in this game session. */
function pickQuestion(game) {
  const available = questions
    .map((q, i) => ({ q, i }))
    .filter(({ i }) => !game.usedQuestions.has(i));

  if (available.length === 0) {
    // All questions used — reset the pool.
    game.usedQuestions.clear();
    return { q: questions[Math.floor(Math.random() * questions.length)], i: 0 };
  }

  const picked = available[Math.floor(Math.random() * available.length)];
  return picked;
}

// ── Embed builders ─────────────────────────────────────────────────────────────

function buildScoreboardField(game) {
  const lines = [...game.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => {
      const cow = p.hasPinkCow ? ' 🐄' : '';
      return `<@${p.id}>${cow} — **${p.score}** point${p.score !== 1 ? 's' : ''}`;
    });
  return lines.join('\n') || '*No players*';
}

function buildRoundEmbed(game) {
  const submittedCount = game.answers.size;
  const totalCount = game.players.size;
  const remaining = game.phaseEndsAt ? Math.max(0, Math.ceil((game.phaseEndsAt - Date.now()) / 1000)) : 60;

  return new EmbedBuilder()
    .setTitle(`🐄 Round ${game.roundNumber}: Herd Mentality`)
    .setDescription(`**${game.currentQuestion}**\n\nSubmit your answer secretly — think like the herd!`)
    .addFields(
      { name: 'Answers submitted', value: `${submittedCount} / ${totalCount}`, inline: true },
      { name: 'Time remaining', value: `${remaining}s`, inline: true },
    )
    .setColor(0xF4A261)
    .setFooter({ text: 'Majority answer scores 1 point  •  Lone answer earns the 🐄 pink cow' })
    .setTimestamp();
}

function buildRoundComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('hm_answer')
        .setLabel('Submit Answer')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('hm_reveal')
        .setLabel('Reveal Answers (Host Only)')
        .setEmoji('👁️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildRevealEmbed(game, groupedAnswers) {
  const embed = new EmbedBuilder()
    .setTitle(`🐄 Round ${game.roundNumber} — Results`)
    .setDescription(`**Q: ${game.currentQuestion}**`)
    .setColor(0x57F287)
    .setTimestamp();

  // Sort groups by count descending.
  const sorted = [...groupedAnswers.entries()].sort(([, a], [, b]) => b.length - a.length);

  for (const [answer, playerIds] of sorted) {
    const names = playerIds.map(id => `<@${id}>`).join(', ');
    const medal = playerIds.length === sorted[0][1].length ? '🏆 ' : '';
    embed.addFields({ name: `${medal}"${answer}" — ${playerIds.length} vote${playerIds.length !== 1 ? 's' : ''}`, value: names });
  }

  if (game.pinkCowHolderId) {
    embed.addFields({ name: '🐄 Pink Cow holder', value: `<@${game.pinkCowHolderId}>` });
  }

  embed.addFields({ name: 'Scoreboard', value: buildScoreboardField(game) });

  return embed;
}

function buildRevealComponents() {
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('hm_next_round')
        .setLabel('Next Round')
        .setEmoji('➡️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('hm_end_game')
        .setLabel('End Game')
        .setEmoji('🛑')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
  return components;
}

function buildEndEmbed(game, winnerIds) {
  const embed = new EmbedBuilder()
    .setTitle('🏁 Herd Mentality — Game Over!')
    .setColor(0x5865F2)
    .setTimestamp();

  if (winnerIds.length === 1) {
    embed.setDescription(`🎉 <@${winnerIds[0]}> **wins Herd Mentality!**`);
  } else if (winnerIds.length > 1) {
    embed.setDescription(`🎉 It's a tie! Winners: ${winnerIds.map(id => `<@${id}>`).join(', ')}`);
  } else {
    embed.setDescription('The game has ended.');
  }

  embed.addFields({ name: 'Final Scoreboard', value: buildScoreboardField(game) });
  return embed;
}

function buildEndComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('hm_rematch_same').setLabel('Rematch (Same Group)').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('hm_rematch_open').setLabel('Rematch (Open Sign-ups)').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('hm_close_session').setLabel('Close Session').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Game logic ─────────────────────────────────────────────────────────────────

/** Calculate scores for the round and return grouped answers map. */
function scoreRound(game) {
  // Group answers by normalised text.
  const groupedAnswers = new Map(); // normalisedAnswer -> [userId, ...]
  for (const [userId, rawAnswer] of game.answers) {
    const key = normalise(rawAnswer);
    if (!groupedAnswers.has(key)) groupedAnswers.set(key, []);
    groupedAnswers.get(key).push(userId);
  }

  // Players who didn't answer get an empty unique answer each.
  for (const playerId of game.players.keys()) {
    if (!game.answers.has(playerId)) {
      const uniqueKey = `__no_answer_${playerId}`;
      groupedAnswers.set(uniqueKey, [playerId]);
    }
  }

  // Find majority count.
  let maxCount = 0;
  for (const ids of groupedAnswers.values()) {
    if (ids.length > maxCount) maxCount = ids.length;
  }

  const majorityGroups = [...groupedAnswers.values()].filter(ids => ids.length === maxCount);

  // Award 1 point to players in majority group(s).
  const majorityPlayerIds = new Set(majorityGroups.flat());
  for (const playerId of majorityPlayerIds) {
    const player = game.players.get(playerId);
    if (player) player.score += 1;
  }

  // Update pink cow:
  // A "lone" answerer is someone who gave a completely unique answer (group size 1)
  // and is not in the majority.
  const loneAnswerers = [...groupedAnswers.entries()]
    .filter(([, ids]) => ids.length === 1 && !majorityPlayerIds.has(ids[0]))
    .map(([, ids]) => ids[0]);

  if (loneAnswerers.length > 0) {
    const currentCowHolder = game.pinkCowHolderId;
    if (currentCowHolder && majorityPlayerIds.has(currentCowHolder)) {
      // Current holder escaped the cow — pass it to a random lone answerer.
      const player = game.players.get(currentCowHolder);
      if (player) player.hasPinkCow = false;
      const newHolder = loneAnswerers[Math.floor(Math.random() * loneAnswerers.length)];
      game.pinkCowHolderId = newHolder;
      const newHolderPlayer = game.players.get(newHolder);
      if (newHolderPlayer) newHolderPlayer.hasPinkCow = true;
    } else if (!currentCowHolder) {
      // No one has the cow yet — assign it.
      const newHolder = loneAnswerers[Math.floor(Math.random() * loneAnswerers.length)];
      game.pinkCowHolderId = newHolder;
      const newHolderPlayer = game.players.get(newHolder);
      if (newHolderPlayer) newHolderPlayer.hasPinkCow = true;
    }
    // Otherwise, the current cow holder also gave a lone/minority answer — they keep it.
  }

  // Return only "real" groups (filter out __no_answer_ entries for display).
  const displayGroups = new Map(
    [...groupedAnswers.entries()].filter(([k]) => !k.startsWith('__no_answer_')),
  );

  return displayGroups;
}

/** Check if any player has won. Returns winning player IDs ([] if no winner yet). */
function checkWinners(game) {
  const winners = [...game.players.values()]
    .filter(p => p.score >= game.targetScore && !p.hasPinkCow)
    .map(p => p.id);
  return winners;
}

async function startRound(game, client, { keepRoundNumber = false } = {}) {
  if (game.phase === 'ended') return;
  game.phase = 'answering';
  game.answers = new Map();

  const { q, i } = pickQuestion(game);
  game.currentQuestion = q;
  game.usedQuestions.add(i);
  if (!keepRoundNumber) game.roundNumber += 1;
  game.phaseEndsAt = Date.now() + ANSWER_DURATION_MS;
  persistGame(client, game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  const msg = await thread.send({
    embeds: [buildRoundEmbed(game)],
    components: buildRoundComponents(),
  }).catch(() => null);

  if (msg) {
    game.questionMessageId = msg.id;
    persistGame(client, game);
  }

  // Auto-reveal after ANSWER_DURATION_MS.
  if (game.answerTimeout) clearTimeout(game.answerTimeout);
  game.answerTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'answering') return;
      await revealRound(game, client);
    } catch (err) {
      console.error('[HerdMentality] Auto-reveal error:', err);
    }
  }, ANSWER_DURATION_MS);
}

async function revealRound(game, client) {
  if (game.phase !== 'answering') return;
  if (game.answerTimeout) { clearTimeout(game.answerTimeout); game.answerTimeout = null; }
  game.phase = 'revealing';
  game.phaseEndsAt = null;
  persistGame(client, game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  // Disable the question message buttons.
  if (game.questionMessageId) {
    const qMsg = await thread.messages.fetch(game.questionMessageId).catch(() => null);
    if (qMsg) await qMsg.edit({ embeds: [buildRoundEmbed(game)], components: [] }).catch(() => {});
  }

  const groupedAnswers = scoreRound(game);
  persistGame(client, game);

  const winners = checkWinners(game);

  if (winners.length > 0) {
    await endGame(game, client, winners);
    return;
  }

  await thread.send({
    embeds: [buildRevealEmbed(game, groupedAnswers)],
    components: buildRevealComponents(),
  }).catch(() => {});
}

async function endGame(game, client, winnerIds) {
  if (game.phase === 'ended') return;
  if (game.answerTimeout) { clearTimeout(game.answerTimeout); game.answerTimeout = null; }
  game.phase = 'ended';
  game.phaseEndsAt = null;
  persistGame(client, game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  await thread.send({
    embeds: [buildEndEmbed(game, winnerIds ?? [])],
    components: buildEndComponents(),
  }).catch(() => {});
}

async function updateQuestionMessage(game, client) {
  if (!game.questionMessageId) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;
  const msg = await thread.messages.fetch(game.questionMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({
    embeds: [buildRoundEmbed(game)],
    components: buildRoundComponents(),
  }).catch(() => {});
}

// ── Lobby button handlers ──────────────────────────────────────────────────────

async function handleLobbyButtons(interaction, client, game, threadId) {
  const { customId, user } = interaction;

  if (customId.startsWith('hm_join_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby to join.', flags: MessageFlags.Ephemeral });
    }
    const added = client.herdMentalityManager.addPlayer(threadId, user);
    if (!added) {
      const reason = game.players.size >= 12 ? 'The lobby is full (12 players max).' : 'You are already in the game.';
      return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    }
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) await thread.members.add(user.id).catch(() => {});
    return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
  }

  if (customId.startsWith('hm_leave_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
    }
    const removed = client.herdMentalityManager.removePlayer(threadId, user.id);
    if (!removed) return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) await thread.members.remove(user.id).catch(() => {});
    return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
  }

  if (customId.startsWith('hm_start_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can start the game.', flags: MessageFlags.Ephemeral });
    }
    if (game.players.size < 2) {
      return interaction.reply({ content: `Need at least **2 players** to start. Currently: **${game.players.size}**.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    // Update lobby message to "game started".
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🐄 Herd Mentality — In Progress')
          .setDescription('A game is currently underway!')
          .addFields(
            { name: 'Players', value: [...game.players.values()].map(p => `<@${p.id}>`).join(', ') || '*No players*' },
            { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
          )
          .setColor(0xED4245)
          .setTimestamp(),
      ],
      components: [],
    });

    await startRound(game, client);
    return;
  }

  if (customId.startsWith('hm_cancel_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby to cancel.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can cancel the session.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🐄 Herd Mentality — Session Cancelled')
          .setDescription('The host cancelled the session before it started.')
          .setColor(0x95A5A6)
          .setTimestamp(),
      ],
      components: [],
    });

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) {
      await thread.send({ content: '✖️ The host cancelled the session. This thread will be archived shortly.' }).catch(() => {});
      setTimeout(async () => {
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }, 5_000);
    }

    client.herdMentalityManager.deleteGame(threadId);
  }
}

// ── In-game button & modal handlers ───────────────────────────────────────────

async function handleGameButtons(interaction, client, game) {
  const { customId, user } = interaction;

  // ── "Submit Answer" button — open modal ─────────────────────────────────────
  if (customId === 'hm_answer') {
    if (game.phase !== 'answering') {
      return interaction.reply({ content: 'Answering is not currently active.', flags: MessageFlags.Ephemeral });
    }
    if (!game.players.has(user.id)) {
      return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
    }
    if (game.answers.has(user.id)) {
      return interaction.reply({ content: '✅ You have already submitted an answer this round.', flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
      .setCustomId('hm_answer_modal')
      .setTitle(`Round ${game.roundNumber}`);

    const truncatedQuestion = game.currentQuestion.length > 40
      ? game.currentQuestion.slice(0, 37) + '…'
      : game.currentQuestion;

    const answerInput = new TextInputBuilder()
      .setCustomId('hm_answer_input')
      .setLabel(truncatedQuestion)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Type your answer here…')
      .setRequired(true)
      .setMaxLength(100);

    modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
    return interaction.showModal(modal);
  }

  // ── Force reveal (host only) ─────────────────────────────────────────────────
  if (customId === 'hm_reveal') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can force-reveal answers.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'answering') {
      return interaction.reply({ content: 'Answers are not currently being collected.', flags: MessageFlags.Ephemeral });
    }
    await interaction.reply({ content: '👁️ Revealing answers…', flags: MessageFlags.Ephemeral });
    await revealRound(game, client);
    return;
  }

  // ── Next round (host only) ───────────────────────────────────────────────────
  if (customId === 'hm_next_round') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can start the next round.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'revealing') {
      return interaction.reply({ content: 'The current round has not been revealed yet.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferUpdate();
    await startRound(game, client);
    return;
  }

  // ── End game early (host only) ───────────────────────────────────────────────
  if (customId === 'hm_end_game') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can end the game.', flags: MessageFlags.Ephemeral });
    }
    await interaction.reply({ content: '🛑 Host ended the game.', flags: MessageFlags.Ephemeral });
    await endGame(game, client, []);
    return;
  }

  // ── Rematch (same group) ─────────────────────────────────────────────────────
  if (customId === 'hm_rematch_same') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can start a rematch.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'ended') {
      return interaction.reply({ content: 'The game has not ended yet.', flags: MessageFlags.Ephemeral });
    }

    // Reset game state for a rematch.
    if (game.answerTimeout) { clearTimeout(game.answerTimeout); game.answerTimeout = null; }
    game.gameNumber += 1;
    game.phase = 'answering';
    game.answers = new Map();
    game.currentQuestion = null;
    game.questionMessageId = null;
    game.roundNumber = 0;
    game.pinkCowHolderId = null;
    game.phaseEndsAt = null;
    game.usedQuestions = new Set();
    for (const p of game.players.values()) {
      p.score = 0;
      p.hasPinkCow = false;
    }
    persistGame(client, game);

    await interaction.deferUpdate();
    await startRound(game, client);
    return;
  }

  // ── Rematch (open sign-ups) ──────────────────────────────────────────────────
  if (customId === 'hm_rematch_open') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can start a rematch.', flags: MessageFlags.Ephemeral });
    }
    if (game.phase !== 'ended') {
      return interaction.reply({ content: 'The game has not ended yet.', flags: MessageFlags.Ephemeral });
    }

    if (game.answerTimeout) { clearTimeout(game.answerTimeout); game.answerTimeout = null; }
    game.gameNumber += 1;
    game.phase = 'lobby';
    game.answers = new Map();
    game.currentQuestion = null;
    game.questionMessageId = null;
    game.roundNumber = 0;
    game.pinkCowHolderId = null;
    game.phaseEndsAt = null;
    game.usedQuestions = new Set();

    // Keep only the host; others must re-join.
    const host = game.players.get(game.hostId);
    game.players = new Map();
    if (host) {
      host.score = 0;
      host.hasPinkCow = false;
      game.players.set(host.id, host);
    }

    persistGame(client, game);

    await interaction.deferUpdate();

    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      const { resource } = await thread.send({
        embeds: [buildLobbyEmbed(game)],
        components: buildLobbyComponents(game.threadId),
        withResponse: true,
      }).catch(() => ({ resource: null }));

      if (resource?.message) {
        game.messageId = resource.message.id;
        persistGame(client, game);
      }
    }
    return;
  }

  // ── Close session ────────────────────────────────────────────────────────────
  if (customId === 'hm_close_session') {
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can close the session.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();
    client.herdMentalityManager.deleteGame(game.threadId);

    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      await thread.send({ content: '✅ Session closed. This thread will be archived shortly.' }).catch(() => {});
      setTimeout(async () => {
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }, 5_000);
    }
    return;
  }
}

async function handleAnswerModal(interaction, client, game) {
  if (game.phase !== 'answering') {
    return interaction.reply({ content: 'The answering phase has ended.', flags: MessageFlags.Ephemeral });
  }
  if (!game.players.has(interaction.user.id)) {
    return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
  }
  if (game.answers.has(interaction.user.id)) {
    return interaction.reply({ content: '✅ You have already submitted an answer this round.', flags: MessageFlags.Ephemeral });
  }

  const raw = interaction.fields.getTextInputValue('hm_answer_input');
  game.answers.set(interaction.user.id, raw);
  persistGame(client, game);

  await interaction.reply({ content: `✅ Answer submitted! _(${raw})_`, flags: MessageFlags.Ephemeral });

  // Update the question message to reflect new count.
  await updateQuestionMessage(game, client);

  // Auto-reveal when all players have answered.
  if (game.answers.size >= game.players.size) {
    if (game.answerTimeout) { clearTimeout(game.answerTimeout); game.answerTimeout = null; }
    await revealRound(game, client);
  }
}

// ── Module export (interactionCreate event) ────────────────────────────────────

module.exports = {
  name: 'interactionCreate',
  startRound,

  async execute(interaction, client) {
    const { herdMentalityManager } = client;

    // ── Handle button interactions ─────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId, channelId } = interaction;
      if (!customId.startsWith('hm_')) return;

      // Lobby buttons encode threadId in customId.
      if (
        customId.startsWith('hm_join_') ||
        customId.startsWith('hm_leave_') ||
        customId.startsWith('hm_start_') ||
        customId.startsWith('hm_cancel_')
      ) {
        const threadId = customId.split('_')[2];
        const game = herdMentalityManager.getGame(threadId);
        return handleLobbyButtons(interaction, client, game, threadId);
      }

      // All other buttons use channelId (= threadId) to find the game.
      const game = herdMentalityManager.getGame(channelId);
      if (!game) {
        return interaction.reply({ content: 'There is no active Herd Mentality game here.', flags: MessageFlags.Ephemeral });
      }
      return handleGameButtons(interaction, client, game);
    }

    // ── Handle modal submissions ───────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      if (interaction.customId !== 'hm_answer_modal') return;

      const game = herdMentalityManager.getGame(interaction.channelId);
      if (!game) {
        return interaction.reply({ content: 'There is no active Herd Mentality game here.', flags: MessageFlags.Ephemeral });
      }
      return handleAnswerModal(interaction, client, game);
    }
  },
};
