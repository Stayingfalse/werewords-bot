const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildActiveEmbed,
  buildGameThreadEmbed,
  buildPlayingComponents,
  buildMayorWordComponents,
  buildModeSelectEmbed,
  buildModeSelectComponents,
  buildModeSelectingEmbed,
} = require('../game/phases/lobby');
const { buildBoardEmbed, buildMayorActionComponents, buildGuessComponents, buildVoicePlayerContent, buildVoicePlayerComponents } = require('../game/phases/playing');
const { endGame } = require('../game/phases/endGame');
const { startRevealPhase, buildSeerPickComponents } = require('../game/phases/reveal');
const { startVotingPhase, tallyVotes } = require('../game/phases/voting');
const { buildSessionSummaryEmbed, buildRematchComponents } = require('../game/phases/sessionEnd');
const { getGuildStats } = require('../db/StatsRepository');
const { startGameTimer, getAwakePlayerIds } = require('../game/phases/timer');
const {
  ROLES,
  ROLE_DESCRIPTIONS,
  isDemon,
  isLibrarian,
  getEffectiveRole,
} = require('../utils/roles');
const words = require('../../data/words.json');

// Flatten all words from every category into a single pool at load time.
const wordPool = words.categories.flatMap(c => c.words);

/** Pick `n` unique items at random from an array. */
function sampleN(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function getWordsmithSecretRoleText(player) {
  if (player?.role !== ROLES.MAYOR || !player.secretRole) return '';
  return `\n\n🎭 Secret role: **${player.secretRole}**`;
}

/**
 * Assigns each player a single d6 roll (1-6) for wake grouping.
 * @param {import('../game/GameManager').GameState} game
 */
function assignDiceValues(game) {
  for (const player of game.players.values()) {
    player.dieValue = Math.floor(Math.random() * 6) + 1;
  }
}

async function refreshBoardMessage(game, client) {
  if (!game?.boardMessageId) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;
  const board = await thread.messages.fetch(game.boardMessageId).catch(() => null);
  if (!board) return;
  await board.edit({
    embeds: [buildBoardEmbed(game)],
    components: [],
  }).catch(() => {});
}

/**
 * @param {{ role: string, dieValue?: number, isAccomplice?: boolean }} player
 * @param {import('../game/GameManager').GameState} game
 */
function buildSecretContent(player, game) {
  const roleDesc = ROLE_DESCRIPTIONS[player.role] ?? '';
  const dieText = player.dieValue ? `\n\n🎲 Your die number: **${player.dieValue}**` : '';
  const thiefInfoText = game.thiefId ? `<@${game.thiefId}>` : '*Unavailable*';
  const accompliceText = player.isAccomplice
    ? `\n\n🤝 You are the **accomplice**.\nThe **Cheese Thief** is ${thiefInfoText}.`
    : '';
  const theftText = game.cheeseStolen
    ? `\n\n🧀 Cheese status: **Stolen at wake ${game.stolenAtWake ?? '?'}**`
    : '\n\n🧀 Cheese status: **Not stolen yet**';
  return { content: `${roleDesc}${dieText}${accompliceText}${theftText}`, wordPending: false };
}

/** Single-button row shown in ephemeral secret-info for non-Wordsmith players. */
function buildReadyComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ww_ready')
        .setLabel("I'm Ready!")
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

/** Edits the "Game Started" embed to reflect the current ready-up state. */
async function updateReadyEmbed(game, client) {
  if (!game.readyMessageId) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;
  const msg = await thread.messages.fetch(game.readyMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({
    embeds: [buildGameThreadEmbed(game)],
    components: buildPlayingComponents(),
  }).catch(() => {});
}

/**
 * Starts the timer if and only if every player has readied up and the timer
 * isn't already running.  Also sends a "let's go!" announcement.
 */
async function maybeStartTimer(game, client) {
  if (game.timerInterval !== null) return;
  if (game.readyPlayers.size < game.players.size) return;
  const thread = await client.channels.fetch(game.threadId).catch(() => null);
  if (!thread) return;
  await thread.send({ content: '🌙 All players are ready — wake sequence starting now.' }).catch(() => {});
  startGameTimer(game, thread, client);
}

/**
 * Creates a voice-mode response panel message for every non-Wordsmith player.
 * Populates game.voicePlayerMessageIds and persists the game.
 * @param {import('../game/GameManager').GameState} game
 * @param {import('discord.js').ThreadChannel} thread
 */
async function createVoicePlayerPanels(game, thread) {
  await thread.send({ content: "🎙️ **Voice Mode panels — Wordsmith, use these to log each player's responses:**" }).catch(() => {});
  for (const player of game.players.values()) {
    if (player.role === ROLES.MAYOR) continue;
    const msg = await thread.send({
      content: buildVoicePlayerContent(player),
      components: buildVoicePlayerComponents(player.id, game.tokens),
    }).catch(() => null);
    if (msg) game.voicePlayerMessageIds.set(player.id, msg.id);
  }
  const { upsert: upsertGame } = require('../db/GameRepository');
  upsertGame(game);
}

module.exports = {
  name: 'interactionCreate',

  async execute(interaction, client) {

    // ── Slash commands ───────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction, client);
      } catch (error) {
        console.error('[Command error]', error);
        const payload = { content: '❌ An error occurred running that command.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      }
      return;
    }

    // ── Modal submissions ────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const { customId: modalId, channelId, guildId, user } = interaction;

      // ── Dispatch Wavelength modal ───────────────────────────────────────────
      if (modalId === 'wl_clue_modal' || modalId === 'wl_rr_times_modal') {
        const { handleWavelengthInteraction } = require('../game/wavelength/interactionHandler');
        try {
          return await handleWavelengthInteraction(interaction, client);
        } catch (error) {
          console.error('[Wavelength modal error]', error);
          const payload = { content: '❌ Something went wrong — please try again.', flags: MessageFlags.Ephemeral };
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(payload).catch(() => {});
          } else {
            await interaction.reply(payload).catch(() => {});
          }
        }
        return;
      }

      if (modalId === 'ww_word_modal') {
        const game = client.gameManager.getGame(channelId);

        if (!game || game.phase !== 'playing') {
          return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
        }

        const player = game.players.get(user.id);
        if (!player || player.role !== ROLES.MAYOR) {
          return interaction.reply({ content: 'Only the Wordsmith can pick the forbidden word.', flags: MessageFlags.Ephemeral });
        }

        if (game.word) {
          return interaction.reply({
            content: `✅ The forbidden word is already set to: **${game.word}**`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const raw = interaction.fields.getTextInputValue('ww_word_input');
        const chosen = raw.trim();
        if (!chosen) {
          return interaction.reply({ content: 'The forbidden word cannot be blank.', flags: MessageFlags.Ephemeral });
        }

        game.word = chosen;
        game.readyPlayers.add(user.id);

        await interaction.reply({
          content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}${getWordsmithSecretRoleText(player)}\n\n✅ You chose the forbidden word: **${game.word}**`,
          components: [],
          flags: MessageFlags.Ephemeral,
        });

        // Resolve all pending Demon/Librarian interactions.
        for (const pending of game.pendingSecretInteractions) {
          const pendingPlayer = game.players.get(pending.user.id);
          if (!pendingPlayer) continue;
          const { content } = buildSecretContent(pendingPlayer, game);
          const pendingReadyComponents = game.readyPlayers.has(pendingPlayer.id) ? [] : buildReadyComponents();
          await pending.editReply({ content, components: pendingReadyComponents }).catch(() => {});
        }
        game.pendingSecretInteractions = [];

        // In voice mode, create per-player response panels now that the word is set.
        if (game.sessionMode === 'voice') {
          const thread = await client.channels.fetch(game.threadId).catch(() => null);
          if (thread) await createVoicePlayerPanels(game, thread);
        }

        await updateReadyEmbed(game, client);
        await maybeStartTimer(game, client);
      }
      return;
    }

    // ── Button interactions ──────────────────────────────────────────────────
    if (!interaction.isButton()) return;

    const { customId, channelId, guildId, user } = interaction;

    // ── Dispatch Wavelength interactions ─────────────────────────────────────
    if (customId.startsWith('wl_')) {
      const { handleWavelengthInteraction } = require('../game/wavelength/interactionHandler');
      try {
        return await handleWavelengthInteraction(interaction, client);
      } catch (error) {
        console.error('[Wavelength button error]', error);
        const payload = { content: '❌ Something went wrong — please try again.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
      return;
    }

    // Ignore buttons that don't belong to this bot.
    if (!customId.startsWith('ww_')) return;

    // ── Lobby buttons (fired from the main channel; threadId encoded in customId) ──
    // Format: ww_join_{threadId} | ww_leave_{threadId} | ww_start_{threadId}
    if (
      customId.startsWith('ww_join_') ||
      customId.startsWith('ww_leave_') ||
      customId.startsWith('ww_start_') ||
      customId.startsWith('ww_cancel_')
    ) {
      const threadId = customId.split('_')[2];
      const game = client.gameManager.getGame(threadId);

      // ── ww_join_{threadId} ─────────────────────────────────────────────────
      if (customId.startsWith('ww_join_')) {
        if (!game || game.phase !== 'lobby') {
          return interaction.reply({ content: 'There is no active lobby to join.', flags: MessageFlags.Ephemeral });
        }

        const added = client.gameManager.addPlayer(threadId, user);
        if (!added) {
          const reason = game.players.size >= 10
            ? 'The lobby is full (10 players max).'
            : 'You are already in the game.';
          return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
        }

        // Add the player to the private game thread.
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread) await thread.members.add(user.id).catch(() => {});

        return interaction.update({
          embeds: [buildLobbyEmbed(game)],
          components: buildLobbyComponents(threadId),
        });
      }

      // ── ww_leave_{threadId} ────────────────────────────────────────────────
      if (customId.startsWith('ww_leave_')) {
        if (!game || game.phase !== 'lobby') {
          return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
        }

        const removed = client.gameManager.removePlayer(threadId, user.id);
        if (!removed) {
          return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
        }

        // Remove the player from the private thread (requires MANAGE_THREADS — fails gracefully).
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread) await thread.members.remove(user.id).catch(() => {});

        return interaction.update({
          embeds: [buildLobbyEmbed(game)],
          components: buildLobbyComponents(threadId),
        });
      }

      // ── ww_start_{threadId} ────────────────────────────────────────────────
      if (customId.startsWith('ww_start_')) {
        if (!game || game.phase !== 'lobby') {
          return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
        }
        if (user.id !== game.hostId) {
          return interaction.reply({ content: 'Only the host can start the game.', flags: MessageFlags.Ephemeral });
        }
        if (game.players.size < 3) {
          return interaction.reply({
            content: `Need at least **3 players** to start. Currently: **${game.players.size}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        game.phase = 'starting';
        await interaction.deferUpdate();

        client.gameManager.assignRoles(threadId);
        assignDiceValues(game);
        game.phase = 'playing';
        game.currentWakeNumber = 1;
        game.phaseEndsAt = null;
        game.cheeseStolen = false;
        game.accompliceId = null;
        game.thiefId = [...game.players.values()].find(p => p.role === ROLES.WEREWOLF)?.id ?? null;
        game.stolenAtWake = null;
        if (!game.thiefId) {
          return interaction.followUp({ content: '❌ Failed to assign Cheese Thief. Please start again.', flags: MessageFlags.Ephemeral });
        }

        // Show active game in the main channel and remove lobby buttons.
        await interaction.editReply({
          embeds: [buildActiveEmbed(game)],
          components: [],
        });

        // Post game-start prompt in the game thread.
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread) {
          const startMsg = await thread.send({
            embeds: [buildGameThreadEmbed(game)],
            components: buildPlayingComponents(),
          }).catch(() => null);
          if (startMsg) game.readyMessageId = startMsg.id;
        }

        const { upsert: upsertGame } = require('../db/GameRepository');
        upsertGame(game);
        return;
      }

      // ── ww_cancel_{threadId} ──────────────────────────────────────────────
      if (customId.startsWith('ww_cancel_')) {
        if (!game || game.phase !== 'lobby') {
          return interaction.reply({ content: 'There is no active lobby to cancel.', flags: MessageFlags.Ephemeral });
        }
        if (user.id !== game.hostId) {
          return interaction.reply({ content: 'Only the host can cancel the session.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferUpdate();

        // Update main channel embed — remove buttons immediately.
        const cancelledEmbed = new EmbedBuilder()
          .setTitle('�  The Forbidden Word — Session Cancelled')
          .setDescription('The host cancelled the session before it started.')
          .setColor(0x95A5A6)
          .setTimestamp();
        await interaction.editReply({ embeds: [cancelledEmbed], components: [] });

        // Notify the thread and archive after 5 s.
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread) {
          await thread.send({ content: '✖️ The host cancelled the session. This thread will be archived shortly.' }).catch(() => {});
          setTimeout(async () => {
            await thread.setLocked(true).catch(() => {});
            await thread.setArchived(true).catch(() => {});
          }, 5_000);
        }

        client.gameManager.deleteGame(threadId);
        return;
      }

      return;
    }

    // ── Game-thread buttons (fired from inside the private thread) ────────────
    // interaction.channelId === game.threadId when inside the thread.
    const game = client.gameManager.getGame(channelId);

    // ── ww_mode_text / ww_mode_voice (host selects play mode) ─────────────────
    if (customId === 'ww_mode_text' || customId === 'ww_mode_voice') {
      return interaction.reply({ content: 'Mode selection is no longer used in this game.', flags: MessageFlags.Ephemeral });
    }

    // ── ww_secret ────────────────────────────────────────────────────────────
    if (customId === 'ww_secret') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player) {
        return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      }

      const { content } = buildSecretContent(player, game);
      const alreadyReady = game.readyPlayers.has(user.id);
      const readyComponents = alreadyReady ? [] : buildReadyComponents();
      return interaction.reply({ content, components: readyComponents, flags: MessageFlags.Ephemeral });
    }

    // ── ww_ready (player confirms they have seen their secret role info) ───────
    if (customId === 'ww_ready') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player) {
        return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      }

      if (game.readyPlayers.has(user.id)) {
        return interaction.update({
          content: '✅ You have already confirmed you are ready!',
          components: [],
        });
      }

      game.readyPlayers.add(user.id);

      // Update the ephemeral to confirm readiness and remove the button.
      await interaction.update({
        content: `✅ You're ready! (${game.readyPlayers.size} / ${game.players.size} players ready)`,
        components: [],
      });

      await updateReadyEmbed(game, client);
      await maybeStartTimer(game, client);
      return;
    }

    if (customId.startsWith('ww_inspect_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      }
      const awakePlayerIds = getAwakePlayerIds(game, game.currentWakeNumber);
      if (awakePlayerIds.length !== 1 || awakePlayerIds[0] !== user.id) {
        return interaction.reply({ content: 'Only the solo awake player can inspect right now.', flags: MessageFlags.Ephemeral });
      }
      const targetId = customId.split('ww_inspect_')[1];
      if (!targetId || targetId === user.id) {
        return interaction.reply({ content: 'You cannot inspect your own die.', flags: MessageFlags.Ephemeral });
      }
      const target = game.players.get(targetId);
      if (!target) {
        return interaction.reply({ content: 'That player is not in the game.', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: `🔎 <@${target.id}> has die number **${target.dieValue ?? '?'}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (customId === 'ww_steal_cheese') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.WEREWOLF) {
        return interaction.reply({ content: 'Only the Cheese Thief can steal the cheese.', flags: MessageFlags.Ephemeral });
      }
      const awakePlayerIds = getAwakePlayerIds(game, game.currentWakeNumber);
      if (!awakePlayerIds.includes(user.id)) {
        return interaction.reply({ content: 'You can only steal while awake.', flags: MessageFlags.Ephemeral });
      }
      if (game.cheeseStolen) {
        return interaction.reply({ content: 'Cheese has already been stolen.', flags: MessageFlags.Ephemeral });
      }

      game.cheeseStolen = true;
      game.stolenAtWake = game.currentWakeNumber;
      const { upsert: upsertGame } = require('../db/GameRepository');
      upsertGame(game);

      const candidates = [...game.players.values()].filter(p => p.id !== user.id);
      const rows = [];
      for (let i = 0; i < candidates.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
          candidates.slice(i, i + 5).map(p => new ButtonBuilder()
            .setCustomId(`ww_pick_accomplice_${p.id}`)
            .setLabel(p.username)
            .setStyle(ButtonStyle.Primary)),
        ));
      }

      return interaction.reply({
        content: '🧀 Cheese stolen. Pick your accomplice.',
        components: rows,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (customId.startsWith('ww_pick_accomplice_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'Wake actions are not active.', flags: MessageFlags.Ephemeral });
      }
      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.WEREWOLF) {
        return interaction.reply({ content: 'Only the Cheese Thief can choose an accomplice.', flags: MessageFlags.Ephemeral });
      }

      const targetId = customId.split('ww_pick_accomplice_')[1];
      const target = game.players.get(targetId);
      if (!target || target.id === user.id) {
        return interaction.reply({ content: 'Invalid accomplice choice.', flags: MessageFlags.Ephemeral });
      }
      if (game.accompliceId) {
        return interaction.reply({ content: 'An accomplice has already been chosen.', flags: MessageFlags.Ephemeral });
      }

      for (const p of game.players.values()) p.isAccomplice = false;
      target.isAccomplice = true;
      game.accompliceId = target.id;
      game.thiefId = user.id;

      const { upsert: upsertGame } = require('../db/GameRepository');
      upsertGame(game);

      return interaction.update({
        content: `🤝 Accomplice selected: **${target.username}**.`,
        components: [],
      });
    }

    // ── ww_word_N (Mayor preset word buttons) ────────────────────────────────
    if (/^ww_word_\d+$/.test(customId)) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can pick the forbidden word.', flags: MessageFlags.Ephemeral });
      }

      if (game.word) {
        return interaction.update({ content: `✅ The forbidden word is already set to: **${game.word}**`, components: [] });
      }

      const index = parseInt(customId.split('_')[2], 10);
      const chosen = game.wordOptions[index];
      if (!chosen) {
        return interaction.reply({ content: 'Invalid word selection.', flags: MessageFlags.Ephemeral });
      }

      game.word = chosen;
      game.readyPlayers.add(user.id);

      await interaction.update({
        content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}${getWordsmithSecretRoleText(player)}\n\n✅ You chose the forbidden word: **${game.word}**`,
        components: [],
      });

      // Resolve all pending Demon/Librarian interactions.
      for (const pending of game.pendingSecretInteractions) {
        const pendingPlayer = game.players.get(pending.user.id);
        if (!pendingPlayer) continue;
        const { content } = buildSecretContent(pendingPlayer, game);
        const pendingReadyComponents = game.readyPlayers.has(pendingPlayer.id) ? [] : buildReadyComponents();
        await pending.editReply({ content, components: pendingReadyComponents }).catch(() => {});
      }
      game.pendingSecretInteractions = [];

      // In voice mode, create per-player response panels now that the word is set.
      if (game.sessionMode === 'voice') {
        const thread = await client.channels.fetch(game.threadId).catch(() => null);
        if (thread) await createVoicePlayerPanels(game, thread);
      }

      await updateReadyEmbed(game, client);
      await maybeStartTimer(game, client);
      return;
    }

    // ── ww_word_custom (Mayor opens a modal to type a custom word) ───────────
    if (customId === 'ww_word_custom') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can pick the forbidden word.', flags: MessageFlags.Ephemeral });
      }

      if (game.word) {
        return interaction.reply({
          content: `✅ The forbidden word is already set to: **${game.word}**`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('ww_word_modal')
        .setTitle('Enter the Forbidden Word');

      const input = new TextInputBuilder()
        .setCustomId('ww_word_input')
        .setLabel('Forbidden word (max 50 characters)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(50)
        .setPlaceholder('Type any word or short phrase…')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // ── Yes / No / Maybe (Mayor only — answers a player question) ───────────
    if (customId === 'ww_yes' || customId === 'ww_no' || customId === 'ww_maybe') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can use Yes / No / Maybe.', flags: MessageFlags.Ephemeral });
      }

      const label = customId.replace('ww_', ''); // 'yes' | 'no' | 'maybe' (for display)
      const isYesNo = customId === 'ww_yes' || customId === 'ww_no';
      const tokenKey = isYesNo ? 'yes_no' : 'maybe';

      if (game.tokens[tokenKey] <= 0) {
        return interaction.reply({
          content: isYesNo ? 'No **Yes / No** tokens remaining!' : 'No **Maybe** tokens remaining!',
          flags: MessageFlags.Ephemeral,
        });
      }

      game.tokens[tokenKey]--;

      // deferUpdate acknowledges the interaction; editReply updates the source message.
      await interaction.deferUpdate();

      // Post the Wordsmith's public response in the thread.
      const tokenEmoji = { yes: '✅', no: '❌', maybe: '❔' }[label];
      const thread = await client.channels.fetch(channelId).catch(() => null);
      if (thread) {
        await thread.send({ content: `${tokenEmoji} The Wordsmith answers: **${label.toUpperCase()}**` }).catch(() => {});
      }

      // Refresh the source message (board or ephemeral) without action buttons.
      await interaction.editReply({
        embeds: [buildBoardEmbed(game)],
        components: [],
      }).catch(() => {});

      // Also refresh the board if the click came from somewhere else.
      await refreshBoardMessage(game, client);

      // Only trigger voting when the shared Yes/No pool is exhausted.
      if (isYesNo && game.tokens.yes_no <= 0) {
        await startVotingPhase(game, client);
      }

      return;
    }

    // ── ww_end_game (host force-ends an in-progress game) ────────────────────
    if (customId === 'ww_end_game') {
      if (!game || (game.phase !== 'playing' && game.phase !== 'discussion' && game.phase !== 'voting' && game.phase !== 'reveal')) {
        return interaction.reply({ content: 'There is no active game to end.', flags: MessageFlags.Ephemeral });
      }

      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can end the game early.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();
      await endGame(game, client, 'host_cancelled');
      return;
    }

    // ── ww_correct / ww_soclose / ww_wayoff (board-level — legacy voice-chat mode) ──
    if (customId === 'ww_correct' || customId === 'ww_soclose' || customId === 'ww_wayoff') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can use these buttons.', flags: MessageFlags.Ephemeral });
      }

      if (customId === 'ww_correct') {
        if (game.tokens.correct <= 0) {
          return interaction.reply({ content: 'No **Correct** tokens remaining!', flags: MessageFlags.Ephemeral });
        }
        game.tokens.correct--;
        game.winnerGuesserUserId = null; // no specific text guess to credit
        await interaction.deferUpdate();
        await startRevealPhase(game, client);
        return;
      }

      // ww_soclose or ww_wayoff
      if (game.tokens.so_close_way_off <= 0) {
        return interaction.reply({ content: 'No **So Close / Way Off** tokens remaining!', flags: MessageFlags.Ephemeral });
      }
      game.tokens.so_close_way_off--;

      await interaction.deferUpdate();

      const thread = await client.channels.fetch(channelId).catch(() => null);
      if (thread) {
        const msg = customId === 'ww_soclose'
          ? '🔥 The Wordsmith signals: **So Close!**'
          : '❌ The Wordsmith signals: **Way Off!**';
        await thread.send({ content: msg }).catch(() => {});
      }

      // Refresh the board without action buttons.
      await interaction.editReply({
        embeds: [buildBoardEmbed(game)],
        components: [],
      }).catch(() => {});

      return;
    }

    // ── ww_guess_correct_{guesserId} (Mayor marks a guess as correct) ────────
    if (
      customId.startsWith('ww_guess_yes_') ||
      customId.startsWith('ww_guess_no_') ||
      customId.startsWith('ww_guess_maybe_')
    ) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can respond to guesses.', flags: MessageFlags.Ephemeral });
      }

      const isMaybe = customId.startsWith('ww_guess_maybe_');
      const tokenKey = isMaybe ? 'maybe' : 'yes_no';
      if (game.tokens[tokenKey] <= 0) {
        return interaction.reply({
          content: isMaybe ? 'No **Maybe** tokens remaining!' : 'No **Yes / No** tokens remaining!',
          flags: MessageFlags.Ephemeral,
        });
      }

      game.tokens[tokenKey]--;

      // Track per-player response stats.
      const guesserId = customId.substring(customId.lastIndexOf('_') + 1);
      const guesser = game.players.get(guesserId);
      if (guesser?.responseStats) {
        if (customId.startsWith('ww_guess_yes_'))   guesser.responseStats.yes++;
        else if (customId.startsWith('ww_guess_no_')) guesser.responseStats.no++;
        else                                          guesser.responseStats.maybe++;
      }

      const responseLine = customId.startsWith('ww_guess_yes_')
        ? '\n✅ **Yes — keep narrowing it down!**'
        : customId.startsWith('ww_guess_no_')
          ? '\n❌ **No — try a different angle!**'
          : '\n❔ **Maybe — you are circling it!**';

      await interaction.update({
        content: interaction.message.content + responseLine,
        components: [],
      });

      await refreshBoardMessage(game, client);

      if (!isMaybe && game.tokens.yes_no <= 0) {
        await startVotingPhase(game, client);
      }

      return;
    }

    // ── ww_guess_correct_{guesserId} (Mayor marks a guess as correct) ────────
    if (customId.startsWith('ww_guess_correct_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can respond to guesses.', flags: MessageFlags.Ephemeral });
      }

      if (game.tokens.correct <= 0) {
        return interaction.reply({ content: 'No **Correct** tokens remaining!', flags: MessageFlags.Ephemeral });
      }

      game.tokens.correct--;

      // Edit the guess announcement to show it was accepted, remove buttons.
      await interaction.update({
        content: interaction.message.content + '\n✅ **Correct — the word has been guessed!**',
        components: [],
      });

      // Credit the stat to whichever player made the accepted guess.
      const guesserId = customId.split('ww_guess_correct_')[1];
      game.winnerGuesserUserId = guesserId ?? null;

      await startRevealPhase(game, client);
      return;
    }

    // ── ww_guess_soclose_{guesserId} / ww_guess_wayoff_{guesserId} ───────────
    if (customId.startsWith('ww_guess_soclose_') || customId.startsWith('ww_guess_wayoff_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can respond to guesses.', flags: MessageFlags.Ephemeral });
      }

      if (game.tokens.so_close_way_off <= 0) {
        return interaction.reply({ content: 'No **So Close / Way Off** tokens remaining!', flags: MessageFlags.Ephemeral });
      }

      game.tokens.so_close_way_off--;

      const isSoClose = customId.startsWith('ww_guess_soclose_');

      // Track per-player response stats.
      const scGuesserId = isSoClose
        ? customId.slice('ww_guess_soclose_'.length)
        : customId.slice('ww_guess_wayoff_'.length);
      const scGuesser = game.players.get(scGuesserId);
      if (scGuesser?.responseStats) {
        if (isSoClose) scGuesser.responseStats.soClose++;
        else            scGuesser.responseStats.wayOff++;
      }

      // Edit the guess announcement to show the result, remove buttons.
      await interaction.update({
        content: interaction.message.content + (isSoClose ? '\n🔥 **So Close — keep guessing!**' : '\n❌ **Way Off — keep guessing!**'),
        components: [],
      });

      await refreshBoardMessage(game, client);

      return;
    }

    // ── ww_voice_* (voice-mode per-player panel buttons) ──────────────────────
    if (
      customId.startsWith('ww_voice_yes_') ||
      customId.startsWith('ww_voice_no_') ||
      customId.startsWith('ww_voice_maybe_') ||
      customId.startsWith('ww_voice_soclose_') ||
      customId.startsWith('ww_voice_wayoff_') ||
      customId.startsWith('ww_voice_correct_')
    ) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can use these buttons.', flags: MessageFlags.Ephemeral });
      }

      const targetPlayerId = customId.substring(customId.lastIndexOf('_') + 1);
      const targetPlayer = game.players.get(targetPlayerId);
      if (!targetPlayer) {
        return interaction.reply({ content: 'Player not found.', flags: MessageFlags.Ephemeral });
      }

      const isCorrect  = customId.startsWith('ww_voice_correct_');
      const isYes      = customId.startsWith('ww_voice_yes_');
      const isNo       = customId.startsWith('ww_voice_no_');
      const isMaybe    = customId.startsWith('ww_voice_maybe_');
      const isSoClose  = customId.startsWith('ww_voice_soclose_');
      const isWayOff   = customId.startsWith('ww_voice_wayoff_');

      if (isCorrect) {
        if (game.tokens.correct <= 0) {
          return interaction.reply({ content: 'No **Correct** tokens remaining!', flags: MessageFlags.Ephemeral });
        }
        game.tokens.correct--;
        game.winnerGuesserUserId = targetPlayerId;

        await interaction.deferUpdate();

        // Update the panel to show correct, remove buttons.
        await interaction.editReply({
          content: buildVoicePlayerContent(targetPlayer) + '\n✅ **CORRECT — the word has been guessed!**',
          components: [],
        }).catch(() => {});

        await startRevealPhase(game, client);
        return;
      }

      // Determine which token pool and stat to update.
      let tokenKey, statKey;
      if (isYes || isNo) {
        tokenKey = 'yes_no';
        statKey  = isYes ? 'yes' : 'no';
      } else if (isMaybe) {
        tokenKey = 'maybe';
        statKey  = 'maybe';
      } else if (isSoClose) {
        tokenKey = 'so_close_way_off';
        statKey  = 'soClose';
      } else { // wayOff
        tokenKey = 'so_close_way_off';
        statKey  = 'wayOff';
      }

      if (game.tokens[tokenKey] <= 0) {
        const tokenLabel = tokenKey === 'yes_no' ? 'Yes / No' : tokenKey === 'maybe' ? 'Maybe' : 'So Close / Way Off';
        return interaction.reply({
          content: `No **${tokenLabel}** tokens remaining!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      game.tokens[tokenKey]--;
      if (targetPlayer.responseStats) targetPlayer.responseStats[statKey]++;

      await interaction.deferUpdate();

      // Update the player's voice panel with new tally and refreshed buttons.
      await interaction.editReply({
        content: buildVoicePlayerContent(targetPlayer),
        components: buildVoicePlayerComponents(targetPlayerId, game.tokens),
      }).catch(() => {});

      // Also refresh other player panels so their buttons reflect current token counts.
      const panelThread = await client.channels.fetch(channelId).catch(() => null);
      if (panelThread) {
        for (const [pid, msgId] of game.voicePlayerMessageIds) {
          if (pid === targetPlayerId) continue; // already updated via deferUpdate
          const panelMsg = await panelThread.messages.fetch(msgId).catch(() => null);
          if (!panelMsg) continue;
          const panelPlayer = game.players.get(pid);
          if (!panelPlayer) continue;
          await panelMsg.edit({
            content: buildVoicePlayerContent(panelPlayer),
            components: buildVoicePlayerComponents(pid, game.tokens),
          }).catch(() => {});
        }
      }

      await refreshBoardMessage(game, client);

      if ((isYes || isNo) && game.tokens.yes_no <= 0) {
        await startVotingPhase(game, client);
      }

      return;
    }

    // ── ww_reveal (Werewolf chooses to reveal during the reveal phase) ────────
    if (customId === 'ww_reveal') {
      if (!game || game.phase !== 'reveal') {
        return interaction.reply({ content: 'The reveal phase is not active.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || !isDemon(player)) {
        return interaction.reply({ content: 'Only the Demon can reveal themselves.', flags: MessageFlags.Ephemeral });
      }

      // Cancel the 90 s outer safety timeout — the Werewolf is acting.
      if (game.revealTimeout) {
        clearTimeout(game.revealTimeout);
        game.revealTimeout = null;
      }

      // Acknowledge the reveal publicly.
      await interaction.update({
        content: '� **The Demon has revealed themselves!** They now have 20 seconds to identify the Librarian…',
        components: [],
      });

      // Send the Demon an ephemeral Librarian-pick panel.
      await interaction.followUp({
        content: '📚 **Pick who you think is the Librarian.** You have 20 seconds!',
        components: buildSeerPickComponents(game.players, user.id),
        flags: MessageFlags.Ephemeral,
      });

      // Start the 20 s Librarian-guess countdown.
      game.revealTimeout = setTimeout(async () => {
        if (game.phase !== 'reveal') return;
        // Time ran out without a pick → Townsfolk win.
        const thread = await client.channels.fetch(game.threadId).catch(() => null);
        if (thread) {
          await thread.send({ content: '⏰ The Demon ran out of time to identify the Librarian — **Townsfolk win!**' }).catch(() => {});
        }
        await endGame(game, client, 'villagers_word');
      }, 20_000);

      return;
    }

    // ── ww_seer_pick_{targetId} (Werewolf names who they think is the Seer) ──
    if (customId.startsWith('ww_seer_pick_')) {
      if (!game || game.phase !== 'reveal') {
        return interaction.reply({ content: 'The reveal phase is not active.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || !isDemon(player)) {
        return interaction.reply({ content: 'Only the Demon can pick the Librarian.', flags: MessageFlags.Ephemeral });
      }

      // Cancel the 20 s seer-guess countdown.
      if (game.revealTimeout) {
        clearTimeout(game.revealTimeout);
        game.revealTimeout = null;
      }

      const targetId = customId.split('ww_seer_pick_')[1];
      const target = game.players.get(targetId);

      // Acknowledge the pick (remove ephemeral buttons).
      await interaction.update({
        content: `� You picked **${target?.username ?? 'Unknown'}** as the Librarian.`,
        components: [],
      });

      // Announce result publicly in the thread.
      const correct = isLibrarian(target);
      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (thread) {
        await thread.send({
          content: correct
            ? `😈 The Demon picked <@${targetId}> as the Librarian — **correct!** Demons steal the win!`
            : `😈 The Demon picked <@${targetId}> as the Librarian — **wrong!** Townsfolk hold their win!`,
        }).catch(() => {});
      }

      await endGame(game, client, correct ? 'werewolf_seer' : 'villagers_word', correct ? targetId : null);
      return;
    }

    // ── ww_vote_{targetId} (player votes for who they think is the Cheese Thief) ──
    if (customId.startsWith('ww_vote_')) {
      if (!game || game.phase !== 'voting') {
        return interaction.reply({ content: 'Voting is not active.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player) {
        return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      }

      const targetId = customId.split('ww_vote_')[1];
      const target = game.players.get(targetId);
      if (!target) {
        return interaction.reply({ content: 'That player is not in the game.', flags: MessageFlags.Ephemeral });
      }

      const changed = game.votes.has(user.id);
      game.votes.set(user.id, targetId);

      await interaction.reply({
        content: changed
          ? `🗳️ Vote changed to **${target.username}**.`
          : `🗳️ Voted for **${target.username}**.`,
        flags: MessageFlags.Ephemeral,
      });

      // Tally early if every player has voted.
      if (game.votes.size >= game.players.size) {
        if (game.revealTimeout) {
          clearTimeout(game.revealTimeout);
          game.revealTimeout = null;
        }
        await tallyVotes(game, client);
      }

      return;
    }

    // ── ww_rematch_same (host — restart immediately with same players) ─────────
    if (customId === 'ww_rematch_same') {
      if (!game || game.phase !== 'ended') {
        return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can start a rematch.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      const resetGame = client.gameManager.resetForRematch(game.threadId, false);
      if (!resetGame) return;

      client.gameManager.assignRoles(game.threadId);
      assignDiceValues(resetGame);
      resetGame.currentWakeNumber = 1;
      resetGame.phaseEndsAt = null;
      resetGame.cheeseStolen = false;
      resetGame.accompliceId = null;
      resetGame.thiefId = [...resetGame.players.values()].find(p => p.role === ROLES.WEREWOLF)?.id ?? null;
      resetGame.stolenAtWake = null;
      if (!resetGame.thiefId) {
        return interaction.followUp({ content: '❌ Failed to assign Cheese Thief. Try rematch again.', flags: MessageFlags.Ephemeral });
      }

      // Update main channel embed → In Progress.
      if (resetGame.channelId && resetGame.messageId) {
        const channel = await client.channels.fetch(resetGame.channelId).catch(() => null);
        if (channel) {
          const lobbyMsg = await channel.messages.fetch(resetGame.messageId).catch(() => null);
          if (lobbyMsg) {
            await lobbyMsg.edit({
              embeds: [buildActiveEmbed(resetGame)],
              components: [],
            }).catch(() => {});
          }
        }
      }

      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (!thread) return;

      const startMsg = await thread.send({
        content: `🔄 **Game ${resetGame.gameNumber} starting — same group!**`,
        embeds: [buildGameThreadEmbed(resetGame)],
        components: buildPlayingComponents(),
      }).catch(() => null);

      if (startMsg) resetGame.readyMessageId = startMsg.id;
      resetGame.boardMessageId = null;

      const { upsert: upsertGame } = require('../db/GameRepository');
      upsertGame(resetGame);

      // Timer starts once all players have confirmed their roles (ww_ready).

      return;
    }

    // ── ww_rematch_open (host — reopen lobby sign-ups) ────────────────────
    if (customId === 'ww_rematch_open') {
      if (!game || game.phase !== 'ended') {
        return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can open sign-ups.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      const resetGame = client.gameManager.resetForRematch(game.threadId, true);
      if (!resetGame) return;

      // Restore main channel lobby embed with buttons active.
      if (resetGame.channelId && resetGame.messageId) {
        const channel = await client.channels.fetch(resetGame.channelId).catch(() => null);
        if (channel) {
          const lobbyMsg = await channel.messages.fetch(resetGame.messageId).catch(() => null);
          if (lobbyMsg) {
            await lobbyMsg.edit({
              embeds: [buildLobbyEmbed(resetGame)],
              components: buildLobbyComponents(resetGame.threadId),
            }).catch(() => {});
          }
        }
      }

      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (thread) {
        await thread.send({
          content: `📋 **Game ${resetGame.gameNumber} sign-ups open!** New players can click **Join** in the lobby to enter.`,
        }).catch(() => {});
      }

      return;
    }

    // ── ww_close_session (host — end the session, archive thread) ─────────
    if (customId === 'ww_close_session') {
      if (!game || game.phase !== 'ended') {
        return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can close the session.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      const thread = await client.channels.fetch(game.threadId).catch(() => null);
      if (thread) {
        const guildStats = getGuildStats(game.guildId);
        await thread.send({
          content: '🔒 **Session closed.** Thanks for playing!',
          embeds: [buildSessionSummaryEmbed(game, guildStats)],
        }).catch(() => {});

        setTimeout(async () => {
          await thread.setLocked(true).catch(() => {});
          await thread.setArchived(true).catch(() => {});
        }, 5_000);
      }

      // Update main channel embed.
      if (game.channelId && game.messageId) {
        const channel = await client.channels.fetch(game.channelId).catch(() => null);
        if (channel) {
          const lobbyMsg = await channel.messages.fetch(game.messageId).catch(() => null);
          if (lobbyMsg) {
            const closedEmbed = new EmbedBuilder()
              .setTitle('�  The Forbidden Word — Session Ended')
              .setDescription(`${game.gameNumber} game${game.gameNumber !== 1 ? 's' : ''} played. Thanks for playing!`)
              .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
              .setColor(0x5865F2)
              .setTimestamp();
            await lobbyMsg.edit({ embeds: [closedEmbed], components: [] }).catch(() => {});
          }
        }
      }

      client.gameManager.deleteGame(game.threadId);
      return;
    }
  },
};
