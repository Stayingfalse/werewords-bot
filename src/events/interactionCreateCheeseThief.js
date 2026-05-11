const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { CT_ROLES } = require('../game/CheeseThiefManager');
const { buildLobbyEmbed, buildLobbyComponents } = require('../commands/cheesethief');

const WAKE_DURATION_MS = 15_000;
const NIGHT_DELAY_MIN_MS = 5_000;
const NIGHT_DELAY_MAX_MS = 10_000;
const DISCUSSION_DURATION_MS = 3 * 60_000;
const VOTE_DURATION_MS = 15_000;
const ACCOMPLICE_SELECTION_DURATION_MS = 60_000; // 1 min for thief to pick accomplice after all 6 nights

function persistGame(client, game) {
  if (!game) return;
  client.cheeseThiefManager?.saveGame(game.threadId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNightDelayMs() {
  const min = NIGHT_DELAY_MIN_MS;
  const max = NIGHT_DELAY_MAX_MS;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function assignDiceValues(game) {
  for (const p of game.players.values()) {
    p.dieValue = Math.floor(Math.random() * 6) + 1;
  }
}

function buildActiveEmbed(game) {
  const players = [...game.players.values()].map(p => `<@${p.id}>`).join(', ');
  return new EmbedBuilder()
    .setTitle('🧀 Cheese Thief — In Progress')
    .setDescription('A game is currently underway!')
    .addFields(
      { name: 'Players', value: players || '*No players*' },
      { name: '🧵 Game Thread', value: `<#${game.threadId}>` },
    )
    .setColor(0xED4245)
    .setTimestamp();
}

function buildThreadReadyEmbed(game) {
  const readyCount = game.readyPlayers.size;
  const total = game.players.size;
  const lines = [...game.players.values()].map(p => `${game.readyPlayers.has(p.id) ? '✅' : '⏳'} <@${p.id}>`).join('\n');

  return new EmbedBuilder()
    .setTitle('🧀 Cheese Thief — Game Started')
    .setDescription(
      readyCount >= total
        ? '✅ All players are ready. Wake sequence starts now.'
        : 'Press **View Secret Info** and then **I\'m Ready!**',
    )
    .addFields({ name: `Readiness (${readyCount}/${total})`, value: lines || '*No players*' })
    .setColor(0xED4245)
    .setTimestamp();
}

function buildThreadControls() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_secret').setLabel('View Secret Info').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ct_end_game').setLabel('End Game').setEmoji('🛑').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildRoleDescription(role) {
  if (role === CT_ROLES.THIEF)      return 'You are the **Cheese Thief** 🧀';
  if (role === CT_ROLES.FALL_MOUSE) return 'You are the **Fall Mouse** 🍂';
  return 'You are **Sleepy Mice** 🐭';
}

// ── Per-player log / ephemeral token helpers ───────────────────────────────────

function ensurePlayerLogs(game)      { if (!game.playerLogs)             game.playerLogs             = new Map(); }
function ensureEphemeralTokens(game) { if (!game.ephemeralTokens)        game.ephemeralTokens        = new Map(); }
function ensureDiscussionReady(game) { if (!game.discussionReadyPlayers) game.discussionReadyPlayers = new Set(); }

function addToPlayerLog(game, userId, entry) {
  ensurePlayerLogs(game);
  const log = game.playerLogs.get(userId) ?? [];
  log.push(entry);
  game.playerLogs.set(userId, log);
}

// ── Ephemeral payload builders ─────────────────────────────────────────────────

function buildBaseContent(player, game) {
  ensurePlayerLogs(game);
  const log = game.playerLogs.get(player.id) ?? [];
  const logSection = log.length > 0 ? '\n\n📋 **Activity Log:**\n' + log.join('\n') : '';
  return (
    `${buildRoleDescription(player.role)}\n` +
    `🎲 Your die number: **${player.dieValue ?? '?'}**\n\n` +
    `⚠️ *Don't dismiss this message — your private game updates will appear here.*` +
    logSection
  );
}

function buildPreNightPayload(player, game) {
  const isReady = game.readyPlayers.has(player.id);
  const readyComponents = isReady ? [] : [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_ready').setLabel("I'm Ready!").setEmoji('✅').setStyle(ButtonStyle.Success),
    ),
  ];
  return {
    content: `${buildBaseContent(player, game)}\n\n👥 Ready: **${game.readyPlayers.size}/${game.players.size}** players`,
    components: readyComponents,
  };
}

function buildSleepPayload(player, game) {
  return {
    content: `${buildBaseContent(player, game)}\n\n😴 Your eyes are currently closed.`,
    components: [],
  };
}

function buildEphemeralWakeComponents(game, playerId, awakeIds) {
  const rows = [];
  if (awakeIds.length === 1 && awakeIds[0] === playerId) {
    const targets = [...game.players.values()].filter(p => p.id !== playerId);
    for (let i = 0; i < targets.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        targets.slice(i, i + 5).map(t =>
          new ButtonBuilder()
            .setCustomId(`ct_inspect_${t.id}`)
            .setLabel(`Inspect ${t.username}`)
            .setStyle(ButtonStyle.Secondary),
        ),
      ));
    }
  }
  if (playerId === game.thiefId && !game.cheeseStolen && awakeIds.includes(playerId)) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_steal_cheese').setLabel('Steal the Cheese 🧀').setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

function buildWakePayload(game, player, awakeIds, wakeNumber) {
  const others = awakeIds.filter(id => id !== player.id);
  const whoElse = others.length > 0
    ? `${others.map(id => `<@${id}>`).join(', ')} ${others.length === 1 ? 'is' : 'are'} also awake.`
    : "You're the only one awake this hour.";
  const cheeseStatus = game.cheeseStolen
    ? `🧀 The cheese is **gone** (stolen at wake ${game.stolenAtWake ?? '?'}).`
    : '🧀 The cheese is still here.';
  return {
    content: `${buildBaseContent(player, game)}\n\n👁️ **Wake ${wakeNumber}:** You open your eyes. ${whoElse}\n${cheeseStatus}`,
    components: buildEphemeralWakeComponents(game, player.id, awakeIds),
  };
}

function buildAccomplicePickerPayload(game, player) {
  const candidates = [...game.players.values()].filter(p => p.id !== player.id);
  const rows = [];
  for (let i = 0; i < candidates.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      candidates.slice(i, i + 5).map(p =>
        new ButtonBuilder().setCustomId(`ct_pick_accomplice_${p.id}`).setLabel(p.username).setStyle(ButtonStyle.Primary),
      ),
    ));
  }
  return {
    content: `${buildBaseContent(player, game)}\n\n🤝 **All 6 nights are over. Choose your accomplice secretly.**`,
    components: rows,
  };
}

function buildDiscussionPayload(player, game) {
  ensureDiscussionReady(game);
  const isReady = game.discussionReadyPlayers.has(player.id);
  const components = isReady ? [] : [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_discussion_ready').setLabel('Ready for Voting').setEmoji('✅').setStyle(ButtonStyle.Success),
    ),
  ];
  return {
    content:
      `${buildBaseContent(player, game)}\n\n` +
      `🗣️ **Discussion Phase** — Talk it out! Click ready when you want to move to voting.` +
      (isReady ? '\n\n✅ You are ready.' : ''),
    components,
  };
}

// ── Ephemeral REST update helpers ──────────────────────────────────────────────

async function tryUpdatePlayerEphemeral(client, game, userId, content, components) {
  ensureEphemeralTokens(game);
  const stored = game.ephemeralTokens.get(userId);
  if (!stored) return false;
  try {
    await client.rest.patch(
      `/webhooks/${stored.applicationId}/${stored.token}/messages/@original`,
      { body: { content, components: components ?? [] } },
    );
    return true;
  } catch { return false; }
}

async function notifyReopenEphemeral(thread, failedIds) {
  const mentions = failedIds.map(id => `<@${id}>`).join(', ');
  await thread.send({
    content: `⚠️ ${mentions} — your **Secret Info** needs to be reopened to receive game updates. Click the **View Secret Info** button in this thread!`,
  }).catch(() => {});
}

async function broadcastEphemeralUpdates(client, game, thread, buildPayload) {
  const failed = [];
  for (const player of game.players.values()) {
    const { content, components } = buildPayload(player);
    const ok = await tryUpdatePlayerEphemeral(client, game, player.id, content, components);
    if (!ok) failed.push(player.id);
  }
  if (failed.length > 0) await notifyReopenEphemeral(thread, failed);
}

async function updateReadyEmbed(game, client) {
  if (!game.readyMessageId) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;
  const msg = await thread.messages.fetch(game.readyMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [buildThreadReadyEmbed(game)], components: buildThreadControls() }).catch(() => {});
}

function getAwakePlayerIds(game, wakeNumber) {
  return [...game.players.values()].filter(p => p.dieValue === wakeNumber).map(p => p.id);
}

// ── Night cycle ────────────────────────────────────────────────────────────────

function scheduleWakeEnd(game, thread, client, wakeNumber, durationMs) {
  if (game.wakeTimeout) { clearTimeout(game.wakeTimeout); game.wakeTimeout = null; }
  game.phaseEndsAt = Date.now() + durationMs;
  persistGame(client, game);

  game.wakeTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'playing') return;
      game.currentWakeNumber = wakeNumber + 1;
      persistGame(client, game);

      // Update awake players' ephemerals: eyes closed again
      const awakeIds = getAwakePlayerIds(game, wakeNumber);
      const failed   = [];
      for (const pid of awakeIds) {
        const player = game.players.get(pid);
        if (!player) continue;
        addToPlayerLog(game, pid, `😴 Wake ${wakeNumber}: Your time is over.`);
        const payload = buildSleepPayload(player, game);
        const ok = await tryUpdatePlayerEphemeral(client, game, pid, payload.content, payload.components);
        if (!ok) failed.push(pid);
      }
      if (failed.length > 0) await notifyReopenEphemeral(thread, failed);

      await sleep(getNightDelayMs());
      if (game.phase !== 'playing') return;
      await runWakeStep(game, thread, client);
    } catch (err) {
      console.error(`[CheeseThief] Wake-end timer error (wake ${wakeNumber}):`, err);
    }
  }, durationMs);
}

async function runWakeStep(game, thread, client) {
  if (game.phase !== 'playing') return;

  if (game.currentWakeNumber > 6) {
    await startAccomplicePhase(game, thread, client);
    return;
  }

  const wakeNumber = game.currentWakeNumber;
  const awakeIds   = getAwakePlayerIds(game, wakeNumber);

  // Public night marker — no TTS, no buttons in the main chat
  await thread.send({ content: `🌙 **Night ${wakeNumber}**` }).catch(() => {});

  // Update only awake players' ephemerals with their wake state + action buttons
  const failed = [];
  for (const pid of awakeIds) {
    const player = game.players.get(pid);
    if (!player) continue;
    addToPlayerLog(game, pid, `👁️ Wake ${wakeNumber}: Your eyes are open.`);
    const payload = buildWakePayload(game, player, awakeIds, wakeNumber);
    const ok = await tryUpdatePlayerEphemeral(client, game, pid, payload.content, payload.components);
    if (!ok) failed.push(pid);
  }
  if (failed.length > 0) await notifyReopenEphemeral(thread, failed);

  scheduleWakeEnd(game, thread, client, wakeNumber, WAKE_DURATION_MS);
}

async function maybeStartWake(game, client) {
  if (game.phase !== 'playing' || game.currentWakeNumber !== 0) return;
  if (game.readyPlayers.size < game.players.size) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  game.currentWakeNumber = 1;
  persistGame(client, game);

  await thread.send({ content: '🌙 **The night begins… everyone goes to sleep.**' }).catch(() => {});

  // Update every player's ephemeral to "eyes closed" before night 1
  for (const player of game.players.values()) {
    addToPlayerLog(game, player.id, '😴 Night has begun. Your eyes are closed.');
  }
  await broadcastEphemeralUpdates(client, game, thread, player => buildSleepPayload(player, game));

  await sleep(getNightDelayMs());
  await runWakeStep(game, thread, client);
}

// ── Accomplice phase (after all 6 nights) ────────────────────────────────────

async function startAccomplicePhase(game, thread, client) {
  await thread.send({ content: '🌙 **All 6 nights have passed. Everyone stirs awake…**' }).catch(() => {});

  if (!game.cheeseStolen) {
    for (const player of game.players.values()) {
      addToPlayerLog(game, player.id, '🌙 All 6 nights are over. No cheese was stolen.');
    }
    await broadcastEphemeralUpdates(client, game, thread, player => buildSleepPayload(player, game));
    await startDiscussion(game, thread, client);
    return;
  }

  game.phase = 'accomplice';
  persistGame(client, game);

  // Non-thief players: update to "cheese stolen, thief is choosing"
  for (const player of game.players.values()) {
    if (player.id === game.thiefId) continue;
    addToPlayerLog(game, player.id, '🌙 All 6 nights are over. Everyone wakes up.');
    addToPlayerLog(game, player.id, '🧀 The cheese was stolen during the night. The Cheese Thief is making their choice…');
  }
  const nonThiefFailed = [];
  for (const player of game.players.values()) {
    if (player.id === game.thiefId) continue;
    const payload = buildSleepPayload(player, game);
    const ok = await tryUpdatePlayerEphemeral(client, game, player.id, payload.content, payload.components);
    if (!ok) nonThiefFailed.push(player.id);
  }
  if (nonThiefFailed.length > 0) await notifyReopenEphemeral(thread, nonThiefFailed);

  // Thief: show accomplice picker
  const thief = game.players.get(game.thiefId);
  if (thief) {
    addToPlayerLog(game, game.thiefId, '🌙 All 6 nights are over.');
    addToPlayerLog(game, game.thiefId, '🤝 Now choose your accomplice secretly (1 minute).');
    const thiefPayload = buildAccomplicePickerPayload(game, thief);
    const thiefOk = await tryUpdatePlayerEphemeral(client, game, game.thiefId, thiefPayload.content, thiefPayload.components);
    if (!thiefOk) await notifyReopenEphemeral(thread, [game.thiefId]);
  }

  // Auto-advance to discussion if thief doesn't pick in time
  if (game.accompliceTimeout) clearTimeout(game.accompliceTimeout);
  game.accompliceTimeout = setTimeout(async () => {
    if (game.phase !== 'accomplice') return;
    game.accompliceTimeout = null;
    await startDiscussion(game, thread, client);
  }, ACCOMPLICE_SELECTION_DURATION_MS);
}

// ── Discussion phase ───────────────────────────────────────────────────────────

async function startDiscussion(game, thread, client) {
  if (game.wakeTimeout)      { clearTimeout(game.wakeTimeout);      game.wakeTimeout      = null; }
  if (game.accompliceTimeout){ clearTimeout(game.accompliceTimeout); game.accompliceTimeout = null; }
  game.phase       = 'discussion';
  game.phaseEndsAt = Date.now() + DISCUSSION_DURATION_MS;
  ensureDiscussionReady(game);
  game.discussionReadyPlayers = new Set();
  persistGame(client, game);

  await thread.send({
    content:
      '🗣️ **Discussion Phase** — You have **3 minutes** to talk before the final accusation. ' +
      'Open your **Secret Info** to ready up early.',
  }).catch(() => {});

  await broadcastEphemeralUpdates(client, game, thread, player => {
    addToPlayerLog(game, player.id, '🗣️ Discussion phase has begun.');
    return buildDiscussionPayload(player, game);
  });

  game.wakeTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'discussion') return;
      await startVotingPhase(game, client);
    } catch (err) {
      console.error('[CheeseThief] Discussion timer error:', err);
    }
  }, DISCUSSION_DURATION_MS);
}

async function checkDiscussionReady(game, client) {
  ensureDiscussionReady(game);
  if (game.discussionReadyPlayers.size >= game.players.size) await startVotingPhase(game, client);
}

function buildVoteComponents(game) {
  const all = [...game.players.values()];
  const rows = [];
  for (let i = 0; i < all.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      all.slice(i, i + 5).map(p =>
        new ButtonBuilder().setCustomId(`ct_vote_${p.id}`).setLabel(p.username).setStyle(ButtonStyle.Secondary),
      ),
    ));
  }
  return rows;
}

async function startVotingPhase(game, client) {
  if (game.wakeTimeout) { clearTimeout(game.wakeTimeout); game.wakeTimeout = null; }
  game.phase = 'voting';
  game.phaseEndsAt = Date.now() + VOTE_DURATION_MS;
  persistGame(client, game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('🗳️ Final Accusation')
        .setDescription('Vote for who you think is the **Cheese Thief**.\nVoting ends in 15 seconds.')
        .setColor(0xEB459E)
        .setTimestamp(),
    ],
    components: buildVoteComponents(game),
  }).catch(() => {});

  game.revealTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'voting') return;
      await tallyVotes(game, client);
    } catch (err) {
      console.error('[CheeseThief] Voting timer error:', err);
    }
  }, VOTE_DURATION_MS);
}

function buildWinners(game, outcome) {
  const winners = new Set();
  if (outcome === 'fall_mouse_vote') {
    for (const p of game.players.values()) if (p.role === CT_ROLES.FALL_MOUSE) winners.add(p.id);
    return winners;
  }
  if (outcome === 'sleepy_mice_vote') {
    for (const p of game.players.values()) {
      if (p.role === CT_ROLES.SLEEPY_MICE && !p.isAccomplice) winners.add(p.id);
    }
    return winners;
  }
  for (const p of game.players.values()) {
    if (p.role === CT_ROLES.THIEF || p.isAccomplice) winners.add(p.id);
  }
  return winners;
}

async function endGame(game, client, outcome) {
  if (game.phase === 'ended') return;
  if (game.wakeTimeout)      { clearTimeout(game.wakeTimeout);      game.wakeTimeout      = null; }
  if (game.accompliceTimeout){ clearTimeout(game.accompliceTimeout); game.accompliceTimeout = null; }
  if (game.revealTimeout)    { clearTimeout(game.revealTimeout);    game.revealTimeout    = null; }
  game.phase = 'ended';
  persistGame(client, game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  const winners = buildWinners(game, outcome);
  const winnerMentions = [...winners].map(id => `<@${id}>`).join(', ') || '*None*';
  let outcomeText = '🧀 **Cheese Thief team wins**';
  if (outcome === 'fall_mouse_vote') {
    outcomeText = '🍂 **Fall Mouse wins alone**';
  } else if (outcome === 'sleepy_mice_vote') {
    outcomeText = '🐭 **Sleepy Mice win**';
  }

  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('🏁 Cheese Thief — Game Over')
        .setDescription(`${outcomeText}\n\nWinners: ${winnerMentions}`)
        .addFields({ name: 'Cheese Stolen', value: game.cheeseStolen ? `Yes (wake ${game.stolenAtWake ?? '?'})` : 'No' })
        .setColor(0x5865F2)
        .setTimestamp(),
    ],
  }).catch(() => {});

  for (const p of game.players.values()) {
    const accomplice = p.isAccomplice ? ' + Accomplice' : '';
    await thread.send({ content: `🎭 <@${p.id}> was **${p.role}${accomplice}** (die ${p.dieValue ?? '?'})` }).catch(() => {});
  }

  await thread.send({
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ct_rematch_same').setLabel('Rematch (Same Group)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ct_rematch_open').setLabel('Rematch (Open Sign-ups)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ct_close_session').setLabel('Close Session').setStyle(ButtonStyle.Secondary),
      ),
    ],
  }).catch(() => {});
}

async function tallyVotes(game, client) {
  const tally = new Map();
  for (const targetId of game.votes.values()) {
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
  }

  let maxVotes = 0;
  for (const count of tally.values()) maxVotes = Math.max(maxVotes, count);
  const top = [...tally.entries()].filter(([, c]) => c === maxVotes).map(([id]) => id);

  if (top.length === 0) {
    await endGame(game, client, 'thief_team_vote');
    return;
  }

  const selectedPlayers = top.map(id => game.players.get(id)).filter(Boolean);
  if (selectedPlayers.some(p => p.role === CT_ROLES.FALL_MOUSE)) {
    await endGame(game, client, 'fall_mouse_vote');
    return;
  }
  if (selectedPlayers.some(p => p.role === CT_ROLES.THIEF)) {
    await endGame(game, client, 'sleepy_mice_vote');
    return;
  }
  await endGame(game, client, 'thief_team_vote');
}

async function handleLobbyButtons(interaction, client, game, threadId) {
  const { customId, user } = interaction;

  if (customId.startsWith('ct_join_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby to join.', flags: MessageFlags.Ephemeral });
    }
    const added = client.cheeseThiefManager.addPlayer(threadId, user);
    if (!added) {
      const reason = game.players.size >= 10 ? 'The lobby is full (10 players max).' : 'You are already in the game.';
      return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    }
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) await thread.members.add(user.id).catch(() => {});
    return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
  }

  if (customId.startsWith('ct_leave_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
    }
    const removed = client.cheeseThiefManager.removePlayer(threadId, user.id);
    if (!removed) return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) await thread.members.remove(user.id).catch(() => {});
    return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
  }

  if (customId.startsWith('ct_start_')) {
    if (!game || game.phase !== 'lobby') return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
    if (user.id !== game.hostId) return interaction.reply({ content: 'Only the host can start the game.', flags: MessageFlags.Ephemeral });
    if (game.players.size < 3) {
      return interaction.reply({ content: `Need at least **3 players** to start. Currently: **${game.players.size}**.`, flags: MessageFlags.Ephemeral });
    }

    game.phase = 'playing';
    game.readyPlayers = new Set();
    game.votes = new Map();
    game.currentWakeNumber = 0;
    game.cheeseStolen = false;
    game.accompliceId = null;
    game.stolenAtWake = null;
    game.ephemeralTokens = new Map();
    game.playerLogs = new Map();
    game.discussionReadyPlayers = new Set();
    persistGame(client, game);

    await interaction.deferUpdate();

    client.cheeseThiefManager.assignRoles(threadId);
    assignDiceValues(game);
    persistGame(client, game);

    if (!game.thiefId) {
      return interaction.followUp({ content: '❌ Failed to assign Cheese Thief. Please start again.', flags: MessageFlags.Ephemeral });
    }

    await interaction.editReply({ embeds: [buildActiveEmbed(game)], components: [] });

    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread) {
      const msg = await thread.send({ embeds: [buildThreadReadyEmbed(game)], components: buildThreadControls() }).catch(() => null);
      if (msg) {
        game.readyMessageId = msg.id;
        persistGame(client, game);
      }
    }
    return;
  }

  if (customId.startsWith('ct_cancel_')) {
    if (!game || game.phase !== 'lobby') {
      return interaction.reply({ content: 'There is no active lobby to cancel.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can cancel the session.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('🧀 Cheese Thief — Session Cancelled').setDescription('The host cancelled the session before it started.').setColor(0x95A5A6).setTimestamp()],
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

    client.cheeseThiefManager.deleteGame(threadId);
  }
}

async function resumeCheeseThiefGame(game, client) {
  // Ensure in-memory-only fields exist after restore
  ensureEphemeralTokens(game);
  ensurePlayerLogs(game);
  ensureDiscussionReady(game);

  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return false;

  await thread.send({
    content: '⚠️ **Bot restarted.** Please reopen your **Secret Info** to continue receiving private game updates.',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ct_secret').setLabel('View Secret Info').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
      ),
    ],
  }).catch(() => {});

  if (game.phase === 'playing') {
    if ((game.currentWakeNumber ?? 0) <= 0) game.currentWakeNumber = 1;
    const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
    if (remaining === 0) {
      await runWakeStep(game, thread, client);
      return true;
    }

    const wakeNumber       = game.currentWakeNumber;
    const awakeIds         = getAwakePlayerIds(game, wakeNumber);
    const awakeMentions    = awakeIds.length ? awakeIds.map(id => `<@${id}>`).join(', ') : '*No one*';
    const remainingSeconds = Math.max(1, Math.ceil(remaining / 1000));

    await thread.send({
      content: `🌙 **Night ${wakeNumber} (resumed)**\nAwake now: ${awakeMentions}\n_Wake ends in ${remainingSeconds} seconds._`,
    }).catch(() => {});

    scheduleWakeEnd(game, thread, client, wakeNumber, remaining);
    return true;
  }

  if (game.phase === 'accomplice') {
    await thread.send({ content: '🤝 The Cheese Thief is choosing their accomplice… (resumed)' }).catch(() => {});
    if (game.accompliceTimeout) clearTimeout(game.accompliceTimeout);
    game.accompliceTimeout = setTimeout(async () => {
      if (game.phase !== 'accomplice') return;
      game.accompliceTimeout = null;
      await startDiscussion(game, thread, client);
    }, ACCOMPLICE_SELECTION_DURATION_MS);
    return true;
  }

  if (game.phase === 'discussion') {
    const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
    if (remaining === 0) { await startVotingPhase(game, client); return true; }
    const remainingSeconds = Math.max(1, Math.ceil(remaining / 1000));
    await thread.send({
      content: `🗣️ **Discussion Phase (resumed)**\nYou have **${remainingSeconds} seconds** before the final accusation.`,
    }).catch(() => {});
    if (game.wakeTimeout) clearTimeout(game.wakeTimeout);
    game.wakeTimeout = setTimeout(async () => {
      if (game.phase !== 'discussion') return;
      await startVotingPhase(game, client);
    }, remaining);
    persistGame(client, game);
    return true;
  }

  if (game.phase === 'voting') {
    const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
    if (remaining === 0) { await tallyVotes(game, client); return true; }
    const remainingSeconds = Math.max(1, Math.ceil(remaining / 1000));
    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🗳️ Final Accusation (resumed)')
          .setDescription(`Vote for who you think is the **Cheese Thief**.\nVoting ends in ${remainingSeconds} seconds.`)
          .setColor(0xEB459E)
          .setTimestamp(),
      ],
      components: buildVoteComponents(game),
    }).catch(() => {});
    if (game.revealTimeout) clearTimeout(game.revealTimeout);
    game.revealTimeout = setTimeout(async () => {
      if (game.phase !== 'voting') return;
      await tallyVotes(game, client);
    }, remaining);
    persistGame(client, game);
    return true;
  }

  return true;
}

module.exports = {
  name: 'interactionCreate',
  resumeCheeseThiefGame,

  async execute(interaction, client) {
    if (!interaction.isButton()) return;

    const { customId, channelId, user } = interaction;
    if (!customId.startsWith('ct_')) return;

    try {
      if (customId.startsWith('ct_join_') || customId.startsWith('ct_leave_') || customId.startsWith('ct_start_') || customId.startsWith('ct_cancel_')) {
        const threadId = customId.split('_')[2];
        const game = client.cheeseThiefManager.getGame(threadId);
        return await handleLobbyButtons(interaction, client, game, threadId);
      }

      const game = client.cheeseThiefManager.getGame(channelId);

      if (!game) {
        return interaction.reply({ content: 'There is no active Cheese Thief game.', flags: MessageFlags.Ephemeral });
      }

    if (customId === 'ct_secret') {
      const validPhases = ['playing', 'accomplice', 'discussion', 'voting'];
      if (!validPhases.includes(game.phase)) {
        return interaction.reply({ content: 'There is no active Cheese Thief round.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });

      // Store fresh token so future REST patches can update this ephemeral
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      let payload;
      if (game.phase === 'playing' && game.currentWakeNumber === 0) {
        payload = buildPreNightPayload(player, game);
      } else if (game.phase === 'playing') {
        const awakeIds = getAwakePlayerIds(game, game.currentWakeNumber);
        payload = awakeIds.includes(user.id)
          ? buildWakePayload(game, player, awakeIds, game.currentWakeNumber)
          : buildSleepPayload(player, game);
      } else if (game.phase === 'accomplice') {
        payload = (user.id === game.thiefId && !game.accompliceId)
          ? buildAccomplicePickerPayload(game, player)
          : buildSleepPayload(player, game);
      } else if (game.phase === 'discussion') {
        payload = buildDiscussionPayload(player, game);
      } else {
        payload = buildSleepPayload(player, game);
      }

      return interaction.reply({ content: payload.content, components: payload.components, flags: MessageFlags.Ephemeral });
    }

    if (customId === 'ct_ready') {
      if (game.phase !== 'playing' || game.currentWakeNumber !== 0) {
        return interaction.reply({ content: 'Readiness is only used before the wake sequence starts.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      if (game.readyPlayers.has(user.id)) {
        const payload = buildPreNightPayload(player, game);
        return interaction.update({ content: payload.content, components: [] });
      }

      game.readyPlayers.add(user.id);
      persistGame(client, game);

      // Store token so future REST patches can update this ephemeral
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      const { content } = buildPreNightPayload(player, game);
      await interaction.update({ content, components: [] }); // Remove the Ready button
      await updateReadyEmbed(game, client);
      await maybeStartWake(game, client);
      return;
    }

    if (customId === 'ct_end_game') {
      if (user.id !== game.hostId) return interaction.reply({ content: 'Only the host can end this game.', flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: '🛑 Host ended the game.', flags: MessageFlags.Ephemeral });
      await endGame(game, client, 'thief_team_vote');
      return;
    }

    if (customId.startsWith('ct_inspect_')) {
      if (game.phase !== 'playing') return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      const awake = getAwakePlayerIds(game, game.currentWakeNumber);
      if (awake.length !== 1 || awake[0] !== user.id) {
        return interaction.reply({ content: 'Only the solo awake player can inspect right now.', flags: MessageFlags.Ephemeral });
      }
      const targetId = customId.split('ct_inspect_')[1];
      const target = game.players.get(targetId);
      if (!target || target.id === user.id) {
        return interaction.reply({ content: 'Invalid inspect target.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });

      // Add inspection result to this player's activity log
      addToPlayerLog(game, user.id, `🔎 You inspected **${target.username}** — their die is **${target.dieValue ?? '?'}**.`);

      // Store token so future REST patches can update this ephemeral
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      // Update the ephemeral in-place (log now includes the result, buttons remain)
      const payload = buildWakePayload(game, player, awake, game.currentWakeNumber);
      return interaction.update({ content: payload.content, components: payload.components });
    }

    if (customId === 'ct_steal_cheese') {
      if (game.phase !== 'playing') return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      if (user.id !== game.thiefId) return interaction.reply({ content: 'Only the Cheese Thief can steal the cheese.', flags: MessageFlags.Ephemeral });
      const awake = getAwakePlayerIds(game, game.currentWakeNumber);
      if (!awake.includes(user.id)) return interaction.reply({ content: 'You can only steal while awake.', flags: MessageFlags.Ephemeral });
      if (game.cheeseStolen) return interaction.reply({ content: 'The cheese has already been stolen.', flags: MessageFlags.Ephemeral });

      game.cheeseStolen = true;
      game.stolenAtWake = game.currentWakeNumber;
      persistGame(client, game);

      const player = game.players.get(user.id);
      addToPlayerLog(game, user.id, `🧀 Wake ${game.currentWakeNumber}: You stole the cheese! You will choose your accomplice after all 6 nights.`);

      // Store token
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      // Update ephemeral in-place (steal button disappears; log shows the theft)
      const payload = buildWakePayload(game, player, awake, game.currentWakeNumber);
      return interaction.update({ content: payload.content, components: payload.components });
    }

    if (customId.startsWith('ct_pick_accomplice_')) {
      if (game.phase !== 'accomplice') return interaction.reply({ content: 'Accomplice selection is not active right now.', flags: MessageFlags.Ephemeral });
      if (user.id !== game.thiefId) return interaction.reply({ content: 'Only the Cheese Thief can choose an accomplice.', flags: MessageFlags.Ephemeral });
      if (game.accompliceId) return interaction.reply({ content: 'An accomplice has already been chosen.', flags: MessageFlags.Ephemeral });

      const targetId = customId.split('ct_pick_accomplice_')[1];
      const target = game.players.get(targetId);
      if (!target || target.id === user.id) return interaction.reply({ content: 'Invalid accomplice choice.', flags: MessageFlags.Ephemeral });

      target.isAccomplice = true;
      game.accompliceId = target.id;
      persistGame(client, game);

      const thiefPlayer = game.players.get(user.id);
      addToPlayerLog(game, user.id, `🤝 You chose **${target.username}** as your accomplice.`);

      // Store token from this interaction
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      // Update thief's ephemeral in-place (remove picker buttons)
      const thiefPayload = buildSleepPayload(thiefPlayer, game);
      await interaction.update({ content: thiefPayload.content, components: [] });

      // Notify accomplice via their ephemeral
      addToPlayerLog(game, target.id, `🤝 You have been chosen as the **Cheese Thief's accomplice**! The Cheese Thief is <@${user.id}>. Work together!`);
      const accomplicePayload = buildSleepPayload(target, game);
      const ok = await tryUpdatePlayerEphemeral(client, game, target.id, accomplicePayload.content, accomplicePayload.components);
      if (!ok) {
        const thread = await client.channels.fetch(game.threadId).catch(() => null);
        if (thread) await notifyReopenEphemeral(thread, [target.id]);
      }

      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (thread) await startDiscussion(game, thread, client);
      return;
    }

    if (customId === 'ct_discussion_ready') {
      if (game.phase !== 'discussion') return interaction.reply({ content: 'Discussion is not active.', flags: MessageFlags.Ephemeral });
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      ensureDiscussionReady(game);
      if (game.discussionReadyPlayers.has(user.id)) {
        return interaction.reply({ content: '✅ You are already ready.', flags: MessageFlags.Ephemeral });
      }
      game.discussionReadyPlayers.add(user.id);
      addToPlayerLog(game, user.id, '✅ You signalled ready for voting.');

      // Store token
      ensureEphemeralTokens(game);
      game.ephemeralTokens.set(user.id, { token: interaction.token, applicationId: interaction.applicationId });

      // Update ephemeral in-place (remove Ready button)
      const payload = buildDiscussionPayload(player, game);
      await interaction.update({ content: payload.content, components: payload.components });

      await checkDiscussionReady(game, client);
      return;
    }

    if (customId.startsWith('ct_vote_')) {
      if (game.phase !== 'voting') return interaction.reply({ content: 'Voting is not active.', flags: MessageFlags.Ephemeral });
      const voter = game.players.get(user.id);
      if (!voter) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });

      const targetId = customId.split('ct_vote_')[1];
      if (!game.players.has(targetId)) {
        return interaction.reply({ content: 'Invalid vote target.', flags: MessageFlags.Ephemeral });
      }

      game.votes.set(user.id, targetId);
      persistGame(client, game);
      return interaction.reply({ content: `🗳️ Vote recorded for <@${targetId}>.`, flags: MessageFlags.Ephemeral });
    }

    if (customId === 'ct_rematch_same' || customId === 'ct_rematch_open') {
      if (user.id !== game.hostId) return interaction.reply({ content: 'Only the host can start a rematch.', flags: MessageFlags.Ephemeral });
      const openSignups = customId === 'ct_rematch_open';
      const reset = client.cheeseThiefManager.resetForRematch(game.threadId, openSignups);
      if (!reset) return interaction.reply({ content: 'Unable to reset game.', flags: MessageFlags.Ephemeral });

      // Clear in-memory fields for the new round
      game.ephemeralTokens = new Map();
      game.playerLogs = new Map();
      game.discussionReadyPlayers = new Set();

      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (!thread) return interaction.reply({ content: 'Game thread no longer exists.', flags: MessageFlags.Ephemeral });

      if (openSignups) {
        const channel = await client.channels.fetch(game.channelId).catch(() => null);
        const lobbyMsg = channel ? await channel.messages.fetch(game.messageId).catch(() => null) : null;
        if (lobbyMsg) {
          await lobbyMsg.edit({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(game.threadId) }).catch(() => {});
        }
        return interaction.reply({ content: '📋 Open sign-ups enabled in the main channel lobby.', flags: MessageFlags.Ephemeral });
      }

      client.cheeseThiefManager.assignRoles(game.threadId);
      assignDiceValues(game);
      game.phase = 'playing';
      persistGame(client, game);
      const msg = await thread.send({ embeds: [buildThreadReadyEmbed(game)], components: buildThreadControls() }).catch(() => null);
      if (msg) {
        game.readyMessageId = msg.id;
        persistGame(client, game);
      }
      return interaction.reply({ content: '🔄 Rematch started. Check your secret info and ready up.', flags: MessageFlags.Ephemeral });
    }

    if (customId === 'ct_close_session') {
      if (user.id !== game.hostId) return interaction.reply({ content: 'Only the host can close the session.', flags: MessageFlags.Ephemeral });
      const acknowledged = await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true).catch((err) => {
        console.error('[CheeseThief] Failed to defer close-session reply:', err);
        return false;
      });
      if (!acknowledged) return;
      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (thread) {
        await thread.send({ content: '🔒 Session closed. Archiving thread.' }).catch(() => {});
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }
      client.cheeseThiefManager.deleteGame(game.threadId);
      return interaction.editReply({ content: '✅ Session closed.' }).catch((err) => {
        console.error('[CheeseThief] Failed to edit close-session reply:', err);
      });
    }
    } catch (error) {
      console.error('[CheeseThief button error]', error);
      const payload = { content: '❌ Something went wrong — please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
