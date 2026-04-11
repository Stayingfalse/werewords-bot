const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildActiveEmbed,
  buildGameThreadEmbed,
  buildPlayingComponents,
  buildMayorWordComponents,
} = require('../game/phases/lobby');
const { buildBoardEmbed, buildMayorActionComponents, buildGuessComponents } = require('../game/phases/playing');
const { endGame } = require('../game/phases/endGame');
const { ROLES, ROLE_DESCRIPTIONS } = require('../utils/roles');
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

/**
 * Builds the ephemeral secret-info text for a player.
 * @param {{ role: string }} player
 * @param {string|null} word  Current game.word (may be null if Mayor hasn't picked yet)
 * @returns {{ content: string, wordPending: boolean }}
 */
function buildSecretContent(player, word) {
  const roleDesc = ROLE_DESCRIPTIONS[player.role];
  const knowsWord = [ROLES.MAYOR, ROLES.WEREWOLF, ROLES.SEER].includes(player.role);

  if (!knowsWord) {
    return { content: roleDesc, wordPending: false };
  }

  if (word) {
    return {
      content: `${roleDesc}\n\n🔤 The magic word is: **${word}**`,
      wordPending: false,
    };
  }

  return {
    content: `${roleDesc}\n\n⏳ The Mayor is still choosing the magic word — this message will update automatically once it is chosen.`,
    wordPending: true,
  };
}

module.exports = {
  name: 'interactionCreate',

  async execute(interaction, client) {
    const { gameManager } = client;

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

      if (modalId === 'ww_word_modal') {
        const game = gameManager.getGame(channelId);

        if (!game || game.phase !== 'playing') {
          return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
        }

        const player = game.players.get(user.id);
        if (!player || player.role !== ROLES.MAYOR) {
          return interaction.reply({ content: 'Only the Mayor can pick the magic word.', flags: MessageFlags.Ephemeral });
        }

        if (game.word) {
          return interaction.reply({
            content: `✅ The magic word is already set to: **${game.word}**`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const raw = interaction.fields.getTextInputValue('ww_word_input');
        const chosen = raw.trim();
        if (!chosen) {
          return interaction.reply({ content: 'The magic word cannot be blank.', flags: MessageFlags.Ephemeral });
        }

        game.word = chosen;

        await interaction.reply({
          content: `✅ You chose the magic word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
          components: buildMayorActionComponents(game.tokens),
          flags: MessageFlags.Ephemeral,
        });

        // Resolve all pending Werewolf/Seer interactions.
        for (const pending of game.pendingSecretInteractions) {
          const pendingPlayer = game.players.get(pending.user.id);
          if (!pendingPlayer) continue;
          const { content } = buildSecretContent(pendingPlayer, game.word);
          await pending.editReply({ content }).catch(() => {});
        }
        game.pendingSecretInteractions = [];
      }
      return;
    }

    // ── Button interactions ──────────────────────────────────────────────────
    if (!interaction.isButton()) return;

    const { customId, channelId, guildId, user } = interaction;

    // Ignore buttons that don't belong to this bot.
    if (!customId.startsWith('ww_')) return;

    // ── Lobby buttons (fired from the main channel; threadId encoded in customId) ──
    // Format: ww_join_{threadId} | ww_leave_{threadId} | ww_start_{threadId}
    if (
      customId.startsWith('ww_join_') ||
      customId.startsWith('ww_leave_') ||
      customId.startsWith('ww_start_')
    ) {
      const threadId = customId.split('_')[2];
      const game = gameManager.getGame(threadId);

      // ── ww_join_{threadId} ─────────────────────────────────────────────────
      if (customId.startsWith('ww_join_')) {
        if (!game || game.phase !== 'lobby') {
          return interaction.reply({ content: 'There is no active lobby to join.', flags: MessageFlags.Ephemeral });
        }

        const added = gameManager.addPlayer(threadId, user);
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

        const removed = gameManager.removePlayer(threadId, user.id);
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

        gameManager.assignRoles(threadId);
        game.wordOptions = sampleN(wordPool, 3);

        game.phase = 'playing';

        // Update the main-channel lobby embed → Game In Progress, no buttons.
        await interaction.editReply({
          embeds: [buildActiveEmbed(game)],
          components: [],
        });

        // Post the game thread welcome embed + secret info button.
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [buildGameThreadEmbed(game)],
            components: buildPlayingComponents(),
          });

          // Post the live game board with Mayor action buttons.
          const boardMsg = await thread.send({
            embeds: [buildBoardEmbed(game)],
            components: buildMayorActionComponents(game.tokens),
          }).catch(() => null);

          if (boardMsg) {
            game.boardMessageId = boardMsg.id;
          }

          // Tick every second. Discord embed updates happen less often to stay
          // within rate limits: every 30 s with plenty of time left, every 10 s
          // inside the last minute, and every 5 s inside the last 30 seconds.
          //
          // boardRefreshing prevents concurrent edits from piling up if a
          // previous edit is still awaiting a rate-limit bucket reset.
          let boardRefreshing = false;

          game.timerInterval = setInterval(async () => {
            if (game.phase !== 'playing') return;

            game.timeLeft--;

            if (game.timeLeft <= 0) {
              game.timeLeft = 0;
              await endGame(game, client, 'werewolf_time');
              return;
            }

            const updateEvery = game.timeLeft > 60 ? 30
                              : game.timeLeft > 30 ? 10
                              : 5;

            if (game.timeLeft % updateEvery === 0 && game.boardMessageId && !boardRefreshing) {
              boardRefreshing = true;
              try {
                const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
                if (bMsg) {
                  await bMsg.edit({
                    embeds: [buildBoardEmbed(game)],
                    components: buildMayorActionComponents(game.tokens),
                  }).catch(err => {
                    if (err?.status === 429) {
                      console.warn(`[Board] Rate limited editing board (thread ${game.threadId}, ${game.timeLeft}s left) — skipping tick`);
                    }
                  });
                }
              } finally {
                boardRefreshing = false;
              }
            }
          }, 1_000);
        }
      }

      return;
    }

    // ── Game-thread buttons (fired from inside the private thread) ────────────
    // interaction.channelId === game.threadId when inside the thread.
    const game = gameManager.getGame(channelId);

    // ── ww_secret ────────────────────────────────────────────────────────────
    if (customId === 'ww_secret') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player) {
        return interaction.reply({ content: 'You are not in this game.', flags: MessageFlags.Ephemeral });
      }

      // Mayor gets the word-picker UI until they have chosen a word;
      // afterwards they see their word + Yes/No/Maybe action buttons.
      if (player.role === ROLES.MAYOR) {
        if (game.word) {
          return interaction.reply({
            content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}\n\n✅ You chose the magic word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
            components: buildMayorActionComponents(game.tokens),
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          content: ROLE_DESCRIPTIONS[ROLES.MAYOR] + '\n\n🔤 **Choose the magic word:**',
          components: buildMayorWordComponents(game.wordOptions),
          flags: MessageFlags.Ephemeral,
        });
      }

      // Werewolf / Seer / Villager
      const { content, wordPending } = buildSecretContent(player, game.word);

      if (!wordPending) {
        return interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }

      // Word not yet chosen — defer and queue for auto-update.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ content });
      game.pendingSecretInteractions.push(interaction);
      return;
    }

    // ── ww_word_N (Mayor preset word buttons) ────────────────────────────────
    if (/^ww_word_\d+$/.test(customId)) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Mayor can pick the magic word.', flags: MessageFlags.Ephemeral });
      }

      if (game.word) {
        return interaction.update({ content: `✅ The magic word is already set to: **${game.word}**`, components: [] });
      }

      const index = parseInt(customId.split('_')[2], 10);
      const chosen = game.wordOptions[index];
      if (!chosen) {
        return interaction.reply({ content: 'Invalid word selection.', flags: MessageFlags.Ephemeral });
      }

      game.word = chosen;

      await interaction.update({
        content: `✅ You chose the magic word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
        components: buildMayorActionComponents(game.tokens),
      });

      // Resolve all pending Werewolf/Seer interactions.
      for (const pending of game.pendingSecretInteractions) {
        const pendingPlayer = game.players.get(pending.user.id);
        if (!pendingPlayer) continue;
        const { content } = buildSecretContent(pendingPlayer, game.word);
        await pending.editReply({ content }).catch(() => {});
      }
      game.pendingSecretInteractions = [];
      return;
    }

    // ── ww_word_custom (Mayor opens a modal to type a custom word) ───────────
    if (customId === 'ww_word_custom') {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Mayor can pick the magic word.', flags: MessageFlags.Ephemeral });
      }

      if (game.word) {
        return interaction.reply({
          content: `✅ The magic word is already set to: **${game.word}**`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('ww_word_modal')
        .setTitle('Enter the Magic Word');

      const input = new TextInputBuilder()
        .setCustomId('ww_word_input')
        .setLabel('Magic word (max 50 characters)')
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
        return interaction.reply({ content: 'Only the Mayor can use Yes / No / Maybe.', flags: MessageFlags.Ephemeral });
      }

      const token = customId.replace('ww_', ''); // 'yes' | 'no' | 'maybe'

      if (game.tokens[token] <= 0) {
        return interaction.reply({
          content: `No **${token}** tokens remaining!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      game.tokens[token]--;

      // deferUpdate acknowledges the interaction; editReply updates the source message.
      await interaction.deferUpdate();

      // Post the Mayor's public response in the thread.
      const tokenEmoji = { yes: '✅', no: '❌', maybe: '❔' }[token];
      const thread = await client.channels.fetch(channelId).catch(() => null);
      if (thread) {
        await thread.send({ content: `${tokenEmoji} The Mayor answers: **${token.toUpperCase()}**` }).catch(() => {});
      }

      const fromBoard = interaction.message.id === game.boardMessageId;

      if (fromBoard) {
        // Update the board in-place (the source of this interaction).
        await interaction.editReply({
          embeds: [buildBoardEmbed(game)],
          components: buildMayorActionComponents(game.tokens),
        }).catch(() => {});
      } else {
        // Clicked from the Mayor's ephemeral — refresh the ephemeral with new buttons…
        await interaction.editReply({
          content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}\n\n✅ Magic word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
          components: buildMayorActionComponents(game.tokens),
        }).catch(() => {});

        // … and also refresh the board message.
        if (thread && game.boardMessageId) {
          const bMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
          if (bMsg) {
            await bMsg.edit({
              embeds: [buildBoardEmbed(game)],
              components: buildMayorActionComponents(game.tokens),
            }).catch(() => {});
          }
        }
      }

      // Check if any token type reached zero → Werewolves win.
      if (game.tokens[token] <= 0) {
        await endGame(game, client, 'werewolf_tokens');
      }

      return;
    }

    // ── ww_guess_accept_{guesserId} (Mayor accepts a word guess) ────────────
    if (customId.startsWith('ww_guess_accept_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Mayor can accept or reject guesses.', flags: MessageFlags.Ephemeral });
      }

      // Edit the guess announcement to show it was accepted, remove buttons.
      await interaction.update({
        content: interaction.message.content + '\n✅ **Accepted by the Mayor — correct!**',
        components: [],
      });

      await endGame(game, client, 'villagers_word');
      return;
    }

    // ── ww_guess_reject_{guesserId} (Mayor rejects a word guess) ───────────
    if (customId.startsWith('ww_guess_reject_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Mayor can accept or reject guesses.', flags: MessageFlags.Ephemeral });
      }

      // Edit the guess announcement to show it was rejected, remove buttons.
      await interaction.update({
        content: interaction.message.content + '\n❌ **Rejected by the Mayor — keep guessing!**',
        components: [],
      });

      return;
    }
  },
};
