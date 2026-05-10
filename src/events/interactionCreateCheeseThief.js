const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { CT_ROLES } = require('../game/CheeseThiefManager');
const { buildLobbyEmbed, buildLobbyComponents } = require('../commands/cheesethief');

const WAKE_DURATION_MS = 15_000;
const NIGHT_DELAY_MIN_MS = 5_000;
const NIGHT_DELAY_MAX_MS = 10_000;
const DISCUSSION_DURATION_MS = 3 * 60_000;
const VOTE_DURATION_MS = 15_000;

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

function buildReadyComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_ready').setLabel("I'm Ready!").setEmoji('✅').setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildRoleDescription(role) {
  if (role === CT_ROLES.THIEF) return 'You are the **Cheese Thief** 🧀';
  if (role === CT_ROLES.FALL_MOUSE) return 'You are the **Fall Mouse** 🍂';
  return 'You are **Sleepy Mice** 🐭';
}

function buildSecretContent(player, game) {
  const thiefInfo = game.thiefId ? `<@${game.thiefId}>` : '*Unknown*';
  const accompliceText = player.isAccomplice
    ? `\n\n🤝 You are the accomplice.\nCheese Thief: ${thiefInfo}`
    : '';
  const theftText = game.cheeseStolen
    ? `\n\n🧀 Cheese status: **Stolen at wake ${game.stolenAtWake ?? '?'}**`
    : '\n\n🧀 Cheese status: **Not stolen yet**';
  return `${buildRoleDescription(player.role)}\n\n🎲 Your die number: **${player.dieValue ?? '?'}**${accompliceText}${theftText}`;
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

function buildWakeActionRows(game, awakePlayerIds) {
  const rows = [];

  if (awakePlayerIds.length === 1) {
    const soloId = awakePlayerIds[0];
    const targets = [...game.players.values()].filter(p => p.id !== soloId);
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

  if (awakePlayerIds.includes(game.thiefId) && !game.cheeseStolen) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ct_steal_cheese').setLabel('Steal Cheese').setStyle(ButtonStyle.Danger),
    ));
  }

  return rows;
}

function ensureNightMessageTracking(game) {
  if (!Array.isArray(game.nightMessageIds)) game.nightMessageIds = [];
}

async function sendTracked(thread, client, game, payload) {
  ensureNightMessageTracking(game);
  const msg = await thread.send(payload).catch(() => null);
  if (msg) {
    game.nightMessageIds.push(msg.id);
    persistGame(client, game);
  }
  return msg;
}

async function deleteTrackedNightMessages(thread, game, client) {
  ensureNightMessageTracking(game);
  const ids = [...game.nightMessageIds];
  game.nightMessageIds = [];
  persistGame(client, game);

  await Promise.all(ids.map(id => thread.messages.delete(id).catch(() => {})));
}

function scheduleWakeEnd(game, thread, client, wakeNumber, durationMs) {
  if (game.wakeTimeout) { clearTimeout(game.wakeTimeout); game.wakeTimeout = null; }
  game.phaseEndsAt = Date.now() + durationMs;
  persistGame(client, game);

  game.wakeTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'playing') return;

      // Advance immediately so old wake buttons can't be used during the between-night delay.
      game.currentWakeNumber = wakeNumber + 1;
      persistGame(client, game);

      await sendTracked(thread, client, game, { content: `🔊 Night ${wakeNumber} close your eyes…`, tts: true });
      await deleteTrackedNightMessages(thread, game, client);

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
    await startDiscussion(game, thread, client);
    return;
  }

  const wakeNumber = game.currentWakeNumber;
  const awakeIds = getAwakePlayerIds(game, wakeNumber);
  const awakeMentions = awakeIds.length ? awakeIds.map(id => `<@${id}>`).join(', ') : '*No one*';

  await sendTracked(thread, client, game, { content: `🔊 Those waking Night ${wakeNumber} open your eyes…`, tts: true });
  await sendTracked(thread, client, game, {
    content: `🌙 **Wake ${wakeNumber}**\nAwake now: ${awakeMentions}\n_Wake ends in 15 seconds._`,
    components: buildWakeActionRows(game, awakeIds),
  });

  scheduleWakeEnd(game, thread, client, wakeNumber, WAKE_DURATION_MS);
}

async function maybeStartWake(game, client) {
  if (game.phase !== 'playing' || game.currentWakeNumber !== 0) return;
  if (game.readyPlayers.size < game.players.size) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;

  game.nightMessageIds = [];
  game.currentWakeNumber = 1;
  persistGame(client, game);
  ensureNightMessageTracking(game);
  await sendTracked(thread, client, game, { content: '🔊 Everyone close your eyes and go to sleep.', tts: true });
  await sleep(getNightDelayMs());
  await runWakeStep(game, thread, client);
}

async function startDiscussion(game, thread, client) {
  game.phase = 'discussion';
  game.phaseEndsAt = Date.now() + DISCUSSION_DURATION_MS;
  persistGame(client, game);

  await thread.send({ content: '🗣️ **Discussion Phase**\nYou have **3 minutes** before the final accusation.' }).catch(() => {});

  game.wakeTimeout = setTimeout(async () => {
    try {
      if (game.phase !== 'discussion') return;
      await startVotingPhase(game, client);
    } catch (err) {
      console.error('[CheeseThief] Discussion timer error:', err);
    }
  }, DISCUSSION_DURATION_MS);
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
  if (game.wakeTimeout) { clearTimeout(game.wakeTimeout); game.wakeTimeout = null; }
  if (game.revealTimeout) { clearTimeout(game.revealTimeout); game.revealTimeout = null; }
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
    game.nightMessageIds = [];
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
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return false;

  await thread.send({ content: '⚠️ Bot restarted. Attempting to resume Cheese Thief game…' }).catch(() => {});

  if (game.phase === 'playing') {
    if ((game.currentWakeNumber ?? 0) <= 0) game.currentWakeNumber = 1;
    const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
    if (remaining === 0) {
      await runWakeStep(game, thread, client);
      return true;
    }

    game.nightMessageIds = [];
    const awakeIds = getAwakePlayerIds(game, game.currentWakeNumber);
    const awakeMentions = awakeIds.length ? awakeIds.map(id => `<@${id}>`).join(', ') : '*No one*';
    const remainingSeconds = Math.max(1, Math.ceil(remaining / 1000));

    await sendTracked(thread, client, game, { content: `🔊 Those waking Night ${game.currentWakeNumber} open your eyes…`, tts: true });
    await sendTracked(thread, client, game, {
      content: `🌙 **Wake ${game.currentWakeNumber} (resumed)**\nAwake now: ${awakeMentions}\n_Wake ends in ${remainingSeconds} seconds._`,
      components: buildWakeActionRows(game, awakeIds),
    });

    scheduleWakeEnd(game, thread, client, game.currentWakeNumber, remaining);
    return true;
  }

  if (game.phase === 'discussion') {
    const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
    if (remaining === 0) {
      await startVotingPhase(game, client);
      return true;
    }

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
    if (remaining === 0) {
      await tallyVotes(game, client);
      return true;
    }

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
      if (game.phase !== 'playing' && game.phase !== 'discussion' && game.phase !== 'voting') {
        return interaction.reply({ content: 'There is no active Cheese Thief round.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      const components = game.readyPlayers.has(user.id) || game.phase !== 'playing' ? [] : buildReadyComponents();
      return interaction.reply({ content: buildSecretContent(player, game), components, flags: MessageFlags.Ephemeral });
    }

    if (customId === 'ct_ready') {
      if (game.phase !== 'playing') return interaction.reply({ content: 'Readiness is only used before wake sequence starts.', flags: MessageFlags.Ephemeral });
      const player = game.players.get(user.id);
      if (!player) return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      if (game.readyPlayers.has(user.id)) return interaction.update({ content: '✅ You are already ready.', components: [] });

      game.readyPlayers.add(user.id);
      persistGame(client, game);
      await interaction.update({ content: `✅ You're ready! (${game.readyPlayers.size}/${game.players.size})`, components: [] });
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
      return interaction.reply({ content: `🔎 <@${target.id}> has die number **${target.dieValue ?? '?'}**.`, flags: MessageFlags.Ephemeral });
    }

    if (customId === 'ct_steal_cheese') {
      if (game.phase !== 'playing') return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      if (user.id !== game.thiefId) return interaction.reply({ content: 'Only the Cheese Thief can steal the cheese.', flags: MessageFlags.Ephemeral });
      const awake = getAwakePlayerIds(game, game.currentWakeNumber);
      if (!awake.includes(user.id)) return interaction.reply({ content: 'You can only steal while awake.', flags: MessageFlags.Ephemeral });
      if (game.cheeseStolen) return interaction.reply({ content: 'Cheese has already been stolen.', flags: MessageFlags.Ephemeral });

      game.cheeseStolen = true;
      game.stolenAtWake = game.currentWakeNumber;
      persistGame(client, game);

      const candidates = [...game.players.values()].filter(p => p.id !== user.id);
      const rows = [];
      for (let i = 0; i < candidates.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
          candidates.slice(i, i + 5).map(p =>
            new ButtonBuilder().setCustomId(`ct_pick_accomplice_${p.id}`).setLabel(p.username).setStyle(ButtonStyle.Primary),
          ),
        ));
      }

      return interaction.reply({ content: '🧀 Cheese stolen. Pick your accomplice.', components: rows, flags: MessageFlags.Ephemeral });
    }

    if (customId.startsWith('ct_pick_accomplice_')) {
      if (game.phase !== 'playing') return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      if (user.id !== game.thiefId) return interaction.reply({ content: 'Only the Cheese Thief can choose an accomplice.', flags: MessageFlags.Ephemeral });
      if (game.accompliceId) return interaction.reply({ content: 'An accomplice has already been chosen.', flags: MessageFlags.Ephemeral });

      const targetId = customId.split('ct_pick_accomplice_')[1];
      const target = game.players.get(targetId);
      if (!target || target.id === user.id) return interaction.reply({ content: 'Invalid accomplice choice.', flags: MessageFlags.Ephemeral });

      if (game.accompliceId && game.players.has(game.accompliceId)) {
        game.players.get(game.accompliceId).isAccomplice = false;
      }
      target.isAccomplice = true;
      game.accompliceId = target.id;
      persistGame(client, game);
      return interaction.update({ content: `🤝 Accomplice selected: **${target.username}**.`, components: [] });
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
