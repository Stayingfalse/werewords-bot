'use strict';

/**
 * Crash-recovery: reload all active games from the DB and re-hook timers/buttons.
 * Called once from ready.js after the bot logs in.
 *
 * @param {import('discord.js').Client} client
 */
async function restoreGames(client) {
  const CheeseThiefRepository = require('./CheeseThiefRepository');
  const GameRepository       = require('./GameRepository');
  const WavelengthRepository = require('./WavelengthRepository');

  await Promise.all([
    restoreCheeseThief(client, CheeseThiefRepository),
    restoreWerewords(client, GameRepository),
    restoreWavelength(client, WavelengthRepository),
  ]);
}

// ── Cheese Thief restore ───────────────────────────────────────────────────────

async function restoreCheeseThief(client, CheeseThiefRepository) {
  const rows = CheeseThiefRepository.getAll();
  if (rows.length === 0) return;

  const { resumeCheeseThiefGame } = require('../events/interactionCreateCheeseThief');

  for (const row of rows) {
    if (row.phase === 'ended') {
      CheeseThiefRepository.remove(row.thread_id);
      continue;
    }

    const playersArray = JSON.parse(row.players);
    const players = new Map(playersArray.map(p => [p.id, p]));
    const readyPlayers = new Set(JSON.parse(row.ready_players || '[]'));
    const votes = new Map(Object.entries(JSON.parse(row.votes || '{}')));

    const game = {
      guildId: row.guild_id,
      channelId: row.channel_id,
      threadId: row.thread_id,
      hostId: row.host_id,
      hostUsername: row.host_username,
      messageId: row.message_id,
      readyMessageId: row.ready_message_id,
      phase: row.phase,
      players,
      readyPlayers,
      votes,
      currentWakeNumber: row.current_wake_number ?? 0,
      phaseEndsAt: row.phase_ends_at ?? null,
      cheeseStolen: !!row.cheese_stolen,
      thiefId: row.thief_id ?? null,
      accompliceId: row.accomplice_id ?? null,
      stolenAtWake: row.stolen_at_wake ?? null,
      // In-memory only — start empty after a restart; players must reopen Secret Info
      ephemeralTokens: new Map(),
      playerLogs: new Map(),
      discussionReadyPlayers: new Set(),
      wakeTimeout: null,
      accompliceTimeout: null,
      revealTimeout: null,
      gameNumber: row.game_number ?? 1,
      _createdAt: row.created_at,
    };

    client.cheeseThiefManager.games.set(row.thread_id, game);

    if (row.phase === 'lobby') {
      CheeseThiefRepository.remove(row.thread_id);
      client.cheeseThiefManager.games.delete(row.thread_id);
      continue;
    }

    const resumed = await resumeCheeseThiefGame(game, client);
    if (!resumed) {
      CheeseThiefRepository.remove(row.thread_id);
      client.cheeseThiefManager.games.delete(row.thread_id);
    }
  }
}

// ── Werewords restore ──────────────────────────────────────────────────────────

async function restoreWerewords(client, GameRepository) {
  const rows = GameRepository.getAll();
  if (rows.length === 0) return;

  const {
    buildBoardEmbed,
    buildMayorActionComponents,
  } = require('../game/phases/playing');
  const { buildVoteComponents } = require('../game/phases/voting');
  const { buildRevealComponents } = require('../game/phases/reveal');
  const { startGameTimer }        = require('../game/phases/timer');
  const { endGame }               = require('../game/phases/endGame');

  for (const row of rows) {
    if (row.phase === 'ended') {
      GameRepository.remove(row.thread_id);
      continue;
    }

    // Deserialise JSON columns.
    const playersArray   = JSON.parse(row.players);
    const players        = new Map(playersArray.map(p => [p.id, p]));
    const tokens         = JSON.parse(row.tokens);
    const votes          = new Map(Object.entries(JSON.parse(row.votes)));
    const wordOptions    = JSON.parse(row.word_options);

    // Reconstruct the GameState-shaped object and insert into the manager.
    const game = {
      guildId:           row.guild_id,
      channelId:         row.channel_id,
      threadId:          row.thread_id,
      hostId:            row.host_id,
      hostUsername:      row.host_username,
      messageId:         row.message_id,
      boardMessageId:    row.board_message_id,
      phase:             row.phase,
      players,
      word:              row.word,
      wordOptions,
      pendingSecretInteractions: [],
      tokens,
      readyPlayers:      new Set(),
      timerInterval:     null,
      timeLeft:          row.time_left,
      collector:         null,
      votes,
      revealTimeout:     null,
      gameNumber:        row.game_number,
      sessionHistory:    [],
      winnerGuesserUserId: row.winner_guesser_user_id,
      sessionMode:       row.session_mode ?? null,
      voicePlayerMessageIds: row.voice_player_message_ids
        ? new Map(Object.entries(JSON.parse(row.voice_player_message_ids)))
        : new Map(),
      _createdAt:        row.created_at,
    };

    client.gameManager.games.set(row.thread_id, game);

    // Lobby and mode_select games are trivial to re-start — drop them silently so users aren't
    // spammed with a "bot restarted" notice every time a new lobby is created.
    if (row.phase === 'lobby' || row.phase === 'mode_select') {
      GameRepository.remove(row.thread_id);
      client.gameManager.games.delete(row.thread_id);
      continue;
    }

    // Fetch the thread — drop the game if Discord no longer knows about it.
    const thread = await client.channels.fetch(row.thread_id).catch(() => null);
    if (!thread) {
      GameRepository.remove(row.thread_id);
      client.gameManager.games.delete(row.thread_id);
      continue;
    }

    await thread.send({ content: '⚠️ Bot restarted. Attempting to resume game…' }).catch(() => {});

    // ── Phase-specific recovery ────────────────────────────────────────────
    if (row.phase === 'playing') {
      // Restart the countdown from saved time_left.
      startGameTimer(game, thread, client);
      if (game.boardMessageId) {
        const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
        if (bMsg) {
          await bMsg.edit({
            embeds: [buildBoardEmbed(game)],
            components: buildMayorActionComponents(game.tokens),
          }).catch(() => {});
        }
      }
    } else if (row.phase === 'voting') {
      // Re-post vote buttons. Auto-tally after 60 s.
      const { tallyVotes } = require('../game/phases/voting');
      await thread.send({
        content: '🗳️ Voting has resumed — please re-cast your vote:',
        components: buildVoteComponents(game.players),
      }).catch(() => {});

      game.revealTimeout = setTimeout(async () => {
        if (game.phase !== 'voting') return;
        await tallyVotes(game, client);
      }, 60_000);
    } else if (row.phase === 'reveal') {
      // Re-post Demon reveal button. 90 s timeout.
      await thread.send({
        content: '😈 Resume: Werewolf, you may still reveal yourself:',
        components: buildRevealComponents(),
      }).catch(() => {});

      game.revealTimeout = setTimeout(async () => {
        if (game.phase !== 'reveal') return;
        await endGame(game, client, 'villagers_word');
      }, 90_000);
    }
  }
}

// ── Wavelength restore ─────────────────────────────────────────────────────────

async function restoreWavelength(client, WavelengthRepository) {
  const rows = WavelengthRepository.getAll();
  if (rows.length === 0) return;

  const { startRevealPhase } = require('../game/wavelength/phases/reveal');
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const {
    buildSessionModePromptEmbed,
    buildSessionModePromptComponents,
  } = require('../game/wavelength/phases/sessionConfig');

  for (const row of rows) {
    if (row.phase === 'ended') {
      WavelengthRepository.remove(row.thread_id);
      continue;
    }

    const playersArray = JSON.parse(row.players);
    const players      = new Map(playersArray.map(p => [p.id, p]));
    const guessesObj   = JSON.parse(row.guesses);
    const guesses      = new Map(Object.entries(guessesObj));

    const game = {
      guildId:         row.guild_id,
      channelId:       row.channel_id,
      threadId:        row.thread_id,
      hostId:          row.host_id,
      hostUsername:    row.host_username,
      messageId:       row.message_id,
      boardMessageId:  row.board_message_id,
      phase:           row.phase,
      players,
      clueGiverId:     row.clue_giver_id,
      spectrumOptions: row.spectrum_options ? JSON.parse(row.spectrum_options) : [],
      chosenSpectrum:  row.chosen_spectrum  ? JSON.parse(row.chosen_spectrum)  : null,
      targetPosition:  row.target_position,
      clue:            row.clue,
      guesses,
      guessTimeout:    null,
      sessionMode:     row.session_mode ? JSON.parse(row.session_mode) : null,
      clueOrderState:  row.clue_order_state
        ? JSON.parse(row.clue_order_state)
        : { roundRobinIndex: 0, snakeIndex: 0, snakeDirection: 1, clueTurnsByPlayer: {} },
      gameNumber:      row.game_number,
      sessionHistory:  [],
      _createdAt:      row.created_at,
    };

    client.wavelengthManager.games.set(row.thread_id, game);

    // Lobby games are trivial to re-start — drop them silently.
    if (row.phase === 'lobby') {
      WavelengthRepository.remove(row.thread_id);
      client.wavelengthManager.games.delete(row.thread_id);
      continue;
    }

    const thread = await client.channels.fetch(row.thread_id).catch(() => null);
    if (!thread) {
      WavelengthRepository.remove(row.thread_id);
      client.wavelengthManager.games.delete(row.thread_id);
      continue;
    }

    await thread.send({ content: '⚠️ Bot restarted. Attempting to resume Wavelength game…' }).catch(() => {});

    if (row.phase === 'setup') {
      await thread.send({
        content: `⚙️ <@${game.hostId}> choose a session mode to resume this game.`,
        embeds: [buildSessionModePromptEmbed(game)],
        components: buildSessionModePromptComponents(),
      }).catch(() => {});
    } else if (row.phase === 'cluing') {
      // Re-post the "Open Clue Giver Panel" button.
      await thread.send({
        content: `<@${game.clueGiverId}> — the bot restarted. Click below to reopen your Clue Giver panel.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('wl_open_cg_panel')
              .setLabel('Open Clue Giver Panel')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});
    } else if (row.phase === 'guessing') {
      // Re-post the public "View Guess Panel" button.
      const { buildGuessPromptComponents } = require('../game/wavelength/phases/guessing');
      await thread.send({
        content: '🔄 Guessing resumed — click below to reopen your guess panel:',
        components: buildGuessPromptComponents(),
      }).catch(() => {});

      // Restart 3-minute auto-submit fallback.
      game.guessTimeout = setTimeout(async () => {
        if (game.phase !== 'guessing') return;
        for (const [, g] of game.guesses) g.submitted = true;
        const t = await client.channels.fetch(game.threadId).catch(() => null);
        if (t) await t.send({ content: '⏰ Time\'s up! All remaining guesses have been locked in.' }).catch(() => {});
        await startRevealPhase(game, client);
      }, 3 * 60 * 1_000);
    } else if (row.phase === 'reveal') {
      // Reveal already posted before crash — just re-post rematch buttons.
      const { buildRematchComponents } = require('../game/wavelength/phases/sessionEnd');
      await thread.send({
        content: '🔄 Bot restarted. You can still start a rematch or close the session:',
        components: buildRematchComponents(),
      }).catch(() => {});
    }
  }
}

module.exports = { restoreGames };
