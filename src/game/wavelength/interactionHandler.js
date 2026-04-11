'use strict';

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildActiveEmbed,
  buildGameThreadEmbed,
} = require('./phases/lobby');

const {
  buildCluingBoardEmbed,
  buildSpectrumPickComponents,
  buildClueSubmitComponents,
  buildPublicClueEmbed,
} = require('./phases/cluing');

const { buildNudgeComponents, buildGuessPromptComponents } = require('./phases/guessing');
const { startRevealPhase } = require('./phases/reveal');
const { buildRematchComponents, buildSessionSummaryEmbed } = require('./phases/sessionEnd');
const { generateClueGiverImage, generateGuesserImage } = require('./imageGen');

const spectra = require('./spectra.json');

/** Pick 2 unique random spectra from the pool. */
function sampleSpectra() {
  const pool = [...spectra.spectra];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 2);
}

/**
 * Check whether all guessers have submitted and fire reveal if so.
 */
async function checkAllSubmitted(game, client) {
  const allDone = [...game.guesses.values()].every(g => g.submitted);
  if (allDone) {
    await startRevealPhase(game, client);
  }
}

/**
 * Dispatch all `wl_` button interactions and modal submissions.
 * Called from interactionCreate.js.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Client} client
 */
async function handleWavelengthInteraction(interaction, client) {
  const { wavelengthManager } = client;

  // ── Modal: clue submission ─────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'wl_clue_modal') {
    const game = wavelengthManager.getGame(interaction.channelId);
    if (!game || game.phase !== 'cluing') {
      return interaction.reply({ content: 'No active cluing phase.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== game.clueGiverId) {
      return interaction.reply({ content: 'Only the Clue Giver can submit a clue.', flags: MessageFlags.Ephemeral });
    }

    const raw = interaction.fields.getTextInputValue('wl_clue_input').trim();
    if (!raw) {
      return interaction.reply({ content: 'Clue cannot be blank.', flags: MessageFlags.Ephemeral });
    }
    // One word only — block spaces.
    if (/\s/.test(raw)) {
      return interaction.reply({ content: '❌ Your clue must be a **single word** — no spaces allowed.', flags: MessageFlags.Ephemeral });
    }

    game.clue  = raw;
    game.phase = 'guessing';

    await interaction.reply({ content: `✅ Clue **"${game.clue}"** submitted! Wait for everyone to guess.`, flags: MessageFlags.Ephemeral });

    // Update the board and post the public guess-prompt button.
    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      if (game.boardMessageId) {
        const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
        if (bMsg) {
          await bMsg.edit({ embeds: [buildPublicClueEmbed(game)], components: [] }).catch(() => {});
        }
      }
      await thread.send({
        content: `💬 **${game.players.get(game.clueGiverId)?.username ?? 'The Clue Giver'}** plays: **"${game.clue}"**`,
        components: buildGuessPromptComponents(),
      }).catch(() => {});
    }

    // 3-minute auto-submit fallback: anyone who hasn't submitted gets locked at current position.
    game.guessTimeout = setTimeout(async () => {
      if (game.phase !== 'guessing') return;
      for (const [, g] of game.guesses) {
        g.submitted = true;
      }
      const t = await client.channels.fetch(game.threadId).catch(() => null);
      if (t) await t.send({ content: '⏰ Time\'s up! All remaining guesses have been locked in.' }).catch(() => {});
      await startRevealPhase(game, client);
    }, 3 * 60 * 1_000);

    return;
  }

  // ── All remaining handlers are button interactions ─────────────────────────
  if (!interaction.isButton()) return;

  const { customId, user } = interaction;

  // ── Lobby buttons (customId encodes threadId as third segment) ─────────────
  if (
    customId.startsWith('wl_join_') ||
    customId.startsWith('wl_leave_') ||
    customId.startsWith('wl_start_') ||
    customId.startsWith('wl_cancel_')
  ) {
    const threadId = customId.split('_')[2];
    const game     = wavelengthManager.getGame(threadId);

    // ── wl_join ──────────────────────────────────────────────────────────────
    if (customId.startsWith('wl_join_')) {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'No active lobby to join.', flags: MessageFlags.Ephemeral });
      }
      const added = wavelengthManager.addPlayer(threadId, user);
      if (!added) {
        const reason = game.players.size >= 20 ? 'Lobby is full (20 players max).' : 'You are already in the game.';
        return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
      }
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (thread) await thread.members.add(user.id).catch(() => {});
      return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
    }

    // ── wl_leave ─────────────────────────────────────────────────────────────
    if (customId.startsWith('wl_leave_')) {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'No active lobby.', flags: MessageFlags.Ephemeral });
      }
      const removed = wavelengthManager.removePlayer(threadId, user.id);
      if (!removed) {
        return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
      }
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (thread) await thread.members.remove(user.id).catch(() => {});
      return interaction.update({ embeds: [buildLobbyEmbed(game)], components: buildLobbyComponents(threadId) });
    }

    // ── wl_start ─────────────────────────────────────────────────────────────
    if (customId.startsWith('wl_start_')) {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'No active lobby.', flags: MessageFlags.Ephemeral });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can start the game.', flags: MessageFlags.Ephemeral });
      }
      if (game.players.size < 2) {
        return interaction.reply({
          content: `Need at least **2 players** to start. Currently: **${game.players.size}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferUpdate();

      // Assign clue giver, target, spectra options.
      wavelengthManager.startGame(threadId, spectra.spectra);
      game.spectrumOptions = sampleSpectra();

      // Update parent-channel embed.
      await interaction.editReply({ embeds: [buildActiveEmbed(game)], components: [] });

      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread) return;

      // Post game intro + board in thread.
      await thread.send({ embeds: [buildGameThreadEmbed(game)] }).catch(() => {});

      const boardMsg = await thread.send({ embeds: [buildCluingBoardEmbed(game)], components: [] }).catch(() => null);
      if (boardMsg) game.boardMessageId = boardMsg.id;

      // Send Clue Giver a button to open their private spectrum-pick panel.
      await thread.send({
        content: `<@${game.clueGiverId}> — you're the **Clue Giver**! Click below to receive your private panel.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('wl_open_cg_panel')
              .setLabel('Open Clue Giver Panel')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});

      return;
    }

    // ── wl_cancel ────────────────────────────────────────────────────────────
    if (customId.startsWith('wl_cancel_')) {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'No active lobby to cancel.', flags: MessageFlags.Ephemeral });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can cancel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      const cancelledEmbed = new EmbedBuilder()
        .setTitle('〰️ Wavelength — Session Cancelled')
        .setDescription('The host cancelled the session before it started.')
        .setColor(0x95A5A6)
        .setTimestamp();
      await interaction.editReply({ embeds: [cancelledEmbed], components: [] });

      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (thread) {
        await thread.send({ content: '✖️ Session cancelled. This thread will be archived shortly.' }).catch(() => {});
        setTimeout(async () => {
          await thread.setLocked(true).catch(() => {});
          await thread.setArchived(true).catch(() => {});
        }, 5_000);
      }

      wavelengthManager.deleteGame(threadId);
      return;
    }

    return;
  }

  // ── In-thread buttons — look up game by channelId (= threadId) ────────────
  const game = wavelengthManager.getGame(interaction.channelId);

  // ── wl_open_cg_panel — Clue Giver opens their private spectrum picker ─────
  if (customId === 'wl_open_cg_panel') {
    if (!game || game.phase !== 'cluing') {
      return interaction.reply({ content: 'No active cluing phase.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.clueGiverId) {
      return interaction.reply({ content: 'Only the Clue Giver can open this panel.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
      content: '🎯 **Pick your spectrum!** Only you can see this.',
      components: buildSpectrumPickComponents(game.spectrumOptions),
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── wl_spectrum_0 / wl_spectrum_1 — Clue Giver picks which spectrum ────────
  if (customId === 'wl_spectrum_0' || customId === 'wl_spectrum_1') {
    if (!game || game.phase !== 'cluing') {
      return interaction.reply({ content: 'No active cluing phase.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.clueGiverId) {
      return interaction.reply({ content: 'Only the Clue Giver can pick the spectrum.', flags: MessageFlags.Ephemeral });
    }
    if (game.chosenSpectrum) {
      return interaction.update({ content: `✅ Spectrum already chosen: \`${game.chosenSpectrum.left}\` ↔ \`${game.chosenSpectrum.right}\``, components: [] });
    }

    const idx = customId === 'wl_spectrum_0' ? 0 : 1;
    game.chosenSpectrum = game.spectrumOptions[idx];

    // Generate the Clue Giver's canvas showing their target.
    let cgImageBuffer = null;
    try {
      cgImageBuffer = await generateClueGiverImage(game.chosenSpectrum, game.targetPosition);
    } catch (err) {
      console.error('[Wavelength] generateClueGiverImage failed:', err);
    }

    const files = cgImageBuffer ? [new AttachmentBuilder(cgImageBuffer, { name: 'target.png' })] : [];

    return interaction.update({
      content:
        `✅ **Spectrum chosen:** \`${game.chosenSpectrum.left}\` ↔ \`${game.chosenSpectrum.right}\`\n\n` +
        `🎯 The **target position** is shown on the image below. Give the guessers a **one-word clue** that hints at where it sits!`,
      components: buildClueSubmitComponents(),
      files,
    });
  }

  // ── wl_enter_clue — Clue Giver opens the clue modal ──────────────────────
  if (customId === 'wl_enter_clue') {
    if (!game || game.phase !== 'cluing') {
      return interaction.reply({ content: 'No active cluing phase.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.clueGiverId) {
      return interaction.reply({ content: 'Only the Clue Giver can submit a clue.', flags: MessageFlags.Ephemeral });
    }
    if (game.clue) {
      return interaction.reply({ content: `✅ Clue already set: **"${game.clue}"**`, flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
      .setCustomId('wl_clue_modal')
      .setTitle('Enter Your Clue');

    const input = new TextInputBuilder()
      .setCustomId('wl_clue_input')
      .setLabel('One word only — no spaces')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(50)
      .setPlaceholder('e.g. Volcano')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── wl_guess_panel — guesser opens their ephemeral nudge panel ────────────
  if (customId === 'wl_guess_panel') {
    if (!game || game.phase !== 'guessing') {
      return interaction.reply({ content: 'Guessing is not active right now.', flags: MessageFlags.Ephemeral });
    }
    if (user.id === game.clueGiverId) {
      return interaction.reply({ content: 'The Clue Giver cannot guess.', flags: MessageFlags.Ephemeral });
    }
    if (!game.guesses.has(user.id)) {
      return interaction.reply({ content: 'You are not registered as a guesser in this game.', flags: MessageFlags.Ephemeral });
    }

    const guess  = game.guesses.get(user.id);
    const player = game.players.get(user.id);

    let imageBuffer = null;
    try {
      imageBuffer = await generateGuesserImage(player.avatarURL, player.username, game.chosenSpectrum, guess.position);
    } catch (err) {
      console.error('[Wavelength] generateGuesserImage failed:', err);
    }

    const files      = imageBuffer ? [new AttachmentBuilder(imageBuffer, { name: 'guess.png' })] : [];
    const components = buildNudgeComponents(user.id, guess.submitted, guess.position);

    return interaction.reply({
      content: guess.submitted
        ? `✅ You locked in at position **${guess.position}**. Waiting for others…`
        : `📍 Your current position: **${guess.position}** — use the buttons to nudge your marker, then **SUBMIT**.`,
      components,
      files,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── wl_nudge_{userId}_{delta} — guesser nudges their marker ──────────────
  if (customId.startsWith('wl_nudge_')) {
    // customId format: wl_nudge_{userId}_{delta}
    // delta can be negative, e.g. wl_nudge_12345_-10
    const parts = customId.split('_');
    // parts: ['wl', 'nudge', userId, delta]
    const targetUserId = parts[2];
    const delta        = parseInt(parts[3], 10);

    if (user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your guess panel.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.phase !== 'guessing') {
      return interaction.reply({ content: 'Guessing is not active.', flags: MessageFlags.Ephemeral });
    }

    const guess = game.guesses.get(user.id);
    if (!guess) {
      return interaction.reply({ content: 'You are not registered as a guesser.', flags: MessageFlags.Ephemeral });
    }
    if (guess.submitted) {
      return interaction.reply({ content: '✅ You have already submitted your guess.', flags: MessageFlags.Ephemeral });
    }

    guess.position = Math.max(0, Math.min(100, guess.position + delta));

    const player = game.players.get(user.id);
    let imageBuffer = null;
    try {
      imageBuffer = await generateGuesserImage(player.avatarURL, player.username, game.chosenSpectrum, guess.position);
    } catch (err) {
      console.error('[Wavelength] generateGuesserImage failed:', err);
    }

    const files      = imageBuffer ? [new AttachmentBuilder(imageBuffer, { name: 'guess.png' })] : [];
    const components = buildNudgeComponents(user.id, false, guess.position);

    return interaction.update({
      content: `📍 Your current position: **${guess.position}** — use the buttons to nudge your marker, then **SUBMIT**.`,
      components,
      files,
    });
  }

  // ── wl_submit_{userId} — guesser locks in their position ─────────────────
  if (customId.startsWith('wl_submit_')) {
    const targetUserId = customId.split('wl_submit_')[1];

    if (user.id !== targetUserId) {
      return interaction.reply({ content: 'This is not your guess panel.', flags: MessageFlags.Ephemeral });
    }
    if (!game || game.phase !== 'guessing') {
      return interaction.reply({ content: 'Guessing is not active.', flags: MessageFlags.Ephemeral });
    }

    const guess = game.guesses.get(user.id);
    if (!guess) {
      return interaction.reply({ content: 'You are not registered as a guesser.', flags: MessageFlags.Ephemeral });
    }
    if (guess.submitted) {
      return interaction.reply({ content: '✅ Already submitted.', flags: MessageFlags.Ephemeral });
    }

    guess.submitted = true;

    // Update the guesser's ephemeral panel to show it's locked.
    const player = game.players.get(user.id);
    let imageBuffer = null;
    try {
      imageBuffer = await generateGuesserImage(player.avatarURL, player.username, game.chosenSpectrum, guess.position);
    } catch (err) {
      console.error('[Wavelength] generateGuesserImage failed:', err);
    }

    const files = imageBuffer ? [new AttachmentBuilder(imageBuffer, { name: 'guess.png' })] : [];

    await interaction.update({
      content: `✅ Locked in at position **${guess.position}**! Waiting for the others…`,
      components: buildNudgeComponents(user.id, true, guess.position),
      files,
    });

    // Update the public board's submission count.
    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread && game.boardMessageId) {
      const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
      if (bMsg) await bMsg.edit({ embeds: [buildPublicClueEmbed(game)], components: [] }).catch(() => {});
    }

    // Check if everyone has submitted.
    await checkAllSubmitted(game, client);
    return;
  }

  // ── wl_rematch_same ───────────────────────────────────────────────────────
  if (customId === 'wl_rematch_same') {
    if (!game || game.phase !== 'ended') {
      return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can start a rematch.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const resetGame = client.wavelengthManager.resetForRematch(game.threadId, false);
    if (!resetGame) return;

    resetGame.spectrumOptions = sampleSpectra();
    client.wavelengthManager.startGame(game.threadId, spectra.spectra);
    resetGame.spectrumOptions = sampleSpectra(); // override with fresh pair

    // Update parent embed.
    if (resetGame.channelId && resetGame.messageId) {
      const channel = await client.channels.fetch(resetGame.channelId).catch(() => null);
      if (channel) {
        const lobbyMsg = await channel.messages.fetch(resetGame.messageId).catch(() => null);
        if (lobbyMsg) await lobbyMsg.edit({ embeds: [buildActiveEmbed(resetGame)], components: [] }).catch(() => {});
      }
    }

    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (!thread) return;

    await thread.send({ content: `🔄 **Game ${resetGame.gameNumber} starting — same group!**`, embeds: [buildGameThreadEmbed(resetGame)] }).catch(() => {});

    const boardMsg = await thread.send({ embeds: [buildCluingBoardEmbed(resetGame)], components: [] }).catch(() => null);
    if (boardMsg) resetGame.boardMessageId = boardMsg.id;

    await thread.send({
      content: `<@${resetGame.clueGiverId}> — you're the **Clue Giver** this round! Click below to open your private panel.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wl_open_cg_panel')
            .setLabel('Open Clue Giver Panel')
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    }).catch(() => {});

    return;
  }

  // ── wl_rematch_open ───────────────────────────────────────────────────────
  if (customId === 'wl_rematch_open') {
    if (!game || game.phase !== 'ended') {
      return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can open sign-ups.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const resetGame = client.wavelengthManager.resetForRematch(game.threadId, true);
    if (!resetGame) return;

    if (resetGame.channelId && resetGame.messageId) {
      const channel = await client.channels.fetch(resetGame.channelId).catch(() => null);
      if (channel) {
        const lobbyMsg = await channel.messages.fetch(resetGame.messageId).catch(() => null);
        if (lobbyMsg) {
          await lobbyMsg.edit({ embeds: [buildLobbyEmbed(resetGame)], components: buildLobbyComponents(resetGame.threadId) }).catch(() => {});
        }
      }
    }

    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      await thread.send({ content: `📋 **Game ${resetGame.gameNumber} sign-ups open!** Join via the lobby button in the main channel.` }).catch(() => {});
    }

    return;
  }

  // ── wl_close_session ─────────────────────────────────────────────────────
  if (customId === 'wl_close_session') {
    if (!game || game.phase !== 'ended') {
      return interaction.reply({ content: 'No ended game in this thread.', flags: MessageFlags.Ephemeral });
    }
    if (user.id !== game.hostId) {
      return interaction.reply({ content: 'Only the host can close the session.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    const thread = await client.channels.fetch(game.threadId).catch(() => null);
    if (thread) {
      await thread.send({
        content: '🔒 **Session closed.** Thanks for playing Wavelength!',
        embeds: [buildSessionSummaryEmbed(game)],
      }).catch(() => {});
      setTimeout(async () => {
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }, 5_000);
    }

    if (game.channelId && game.messageId) {
      const channel = await client.channels.fetch(game.channelId).catch(() => null);
      if (channel) {
        const lobbyMsg = await channel.messages.fetch(game.messageId).catch(() => null);
        if (lobbyMsg) {
          const closedEmbed = new EmbedBuilder()
            .setTitle('〰️ Wavelength — Session Ended')
            .setDescription(`${game.gameNumber} round${game.gameNumber !== 1 ? 's' : ''} played. Thanks for playing!`)
            .addFields({ name: '🧵 Game Thread', value: `<#${game.threadId}>` })
            .setColor(0x5865F2)
            .setTimestamp();
          await lobbyMsg.edit({ embeds: [closedEmbed], components: [] }).catch(() => {});
        }
      }
    }

    client.wavelengthManager.deleteGame(game.threadId);
    return;
  }
}

module.exports = { handleWavelengthInteraction };
