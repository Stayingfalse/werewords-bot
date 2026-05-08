'use strict';

const GameRepository = require('../../db/GameRepository');

const WAKE_DURATION_MS = 15_000;
const DISCUSSION_DURATION_MS = 3 * 60_000;

function getAwakePlayerIds(game, wakeNumber) {
  return [...game.players.values()]
    .filter(player => player.dieValue === wakeNumber)
    .map(player => player.id);
}

function buildWakeActionRows(game, awakePlayerIds) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const rows = [];

  if (awakePlayerIds.length === 1) {
    const soloId = awakePlayerIds[0];
    const targets = [...game.players.values()].filter(p => p.id !== soloId);
    for (let i = 0; i < targets.length; i += 5) {
      rows.push(
        new ActionRowBuilder().addComponents(
          targets.slice(i, i + 5).map(target =>
            new ButtonBuilder()
              .setCustomId(`ww_inspect_${target.id}`)
              .setLabel(`Inspect ${target.username}`)
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      );
    }
  }

  const thiefAwake = awakePlayerIds.some(id => game.players.get(id)?.role === 'Cheese Thief');
  if (thiefAwake && !game.cheeseStolen) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ww_steal_cheese')
          .setLabel('Steal Cheese')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }

  return rows;
}

async function runWakeStep(game, thread, client) {
  if (game.phase !== 'playing') return;

  if (game.currentWakeNumber > 6) {
    await startDiscussion(game, thread, client);
    return;
  }

  const wakeNumber = game.currentWakeNumber;
  const awakePlayerIds = getAwakePlayerIds(game, wakeNumber);
  const awakeMentions = awakePlayerIds.length
    ? awakePlayerIds.map(id => `<@${id}>`).join(', ')
    : '*No one*';

  await thread.send({
    content:
      `🌙 **Wake ${wakeNumber}**\n` +
      `Awake now: ${awakeMentions}\n` +
      `_Wake closes in ${Math.floor(WAKE_DURATION_MS / 1000)} seconds._`,
    components: buildWakeActionRows(game, awakePlayerIds),
  }).catch(() => {});

  game.phaseEndsAt = Date.now() + WAKE_DURATION_MS;
  GameRepository.upsert(game);

  game.wakeTimeout = setTimeout(async () => {
    if (game.phase !== 'playing') return;
    game.currentWakeNumber += 1;
    GameRepository.upsert(game);
    await runWakeStep(game, thread, client);
  }, WAKE_DURATION_MS);
}

async function startDiscussion(game, thread, client) {
  const { startVotingPhase } = require('./voting');
  game.phase = 'discussion';
  game.phaseEndsAt = Date.now() + DISCUSSION_DURATION_MS;
  GameRepository.upsert(game);

  await thread.send({
    content: `🗣️ **Discussion Phase**\nYou have **3 minutes** to discuss before the final accusation.`,
  }).catch(() => {});

  game.wakeTimeout = setTimeout(async () => {
    if (game.phase !== 'discussion') return;
    await startVotingPhase(game, client);
  }, DISCUSSION_DURATION_MS);
}

async function resumeDiscussion(game, thread, client) {
  const { startVotingPhase } = require('./voting');
  const remaining = Math.max(0, (game.phaseEndsAt ?? Date.now()) - Date.now());
  if (remaining === 0) {
    await startVotingPhase(game, client);
    return;
  }
  game.wakeTimeout = setTimeout(async () => {
    if (game.phase !== 'discussion') return;
    await startVotingPhase(game, client);
  }, remaining);
}

async function startGameTimer(game, thread, client) {
  if (game.wakeTimeout) {
    clearTimeout(game.wakeTimeout);
    game.wakeTimeout = null;
  }

  if (game.phase === 'discussion') {
    await resumeDiscussion(game, thread, client);
    return;
  }

  if (game.phase !== 'playing') return;
  if (!game.currentWakeNumber || game.currentWakeNumber < 1) game.currentWakeNumber = 1;
  await runWakeStep(game, thread, client);
}

module.exports = {
  startGameTimer,
  getAwakePlayerIds,
  WAKE_DURATION_MS,
  DISCUSSION_DURATION_MS,
};
