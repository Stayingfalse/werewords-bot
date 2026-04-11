const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
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
const { startRevealPhase, buildSeerPickComponents } = require('../game/phases/reveal');
const { startVotingPhase, tallyVotes } = require('../game/phases/voting');
const { buildSessionSummaryEmbed, buildRematchComponents } = require('../game/phases/sessionEnd');
const { getGuildStats } = require('../utils/StatsManager');
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
      content: `${roleDesc}\n\n🔤 The forbidden word is: **${word}**`,
      wordPending: false,
    };
  }

  return {
    content: `${roleDesc}\n\n⏳ The Wordsmith is still choosing the forbidden word — this message will update automatically once it is chosen.`,
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

        await interaction.reply({
          content: `✅ You chose the forbidden word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
          components: buildMayorActionComponents(game.tokens),
          flags: MessageFlags.Ephemeral,
        });

        // Resolve all pending Demon/Librarian interactions.
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
              await startVotingPhase(game, client);
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

        gameManager.deleteGame(threadId);
        return;
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

      // Wordsmith gets the word-picker UI until they have chosen a word;
      // afterwards they see their word + Yes/No/Maybe action buttons.
      if (player.role === ROLES.MAYOR) {
        if (game.word) {
          return interaction.reply({
            content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}\n\n✅ You chose the forbidden word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
            components: buildMayorActionComponents(game.tokens),
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          content: ROLE_DESCRIPTIONS[ROLES.MAYOR] + '\n\n🔤 **Choose the forbidden word:**',
          components: buildMayorWordComponents(game.wordOptions),
          flags: MessageFlags.Ephemeral,
        });
      }

      // Demon / Librarian / Townsfolk
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

      await interaction.update({
        content: `✅ You chose the forbidden word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
        components: buildMayorActionComponents(game.tokens),
      });

      // Resolve all pending Demon/Librarian interactions.
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

      // Post the Wordsmith's public response in the thread.
      const tokenEmoji = { yes: '✅', no: '❌', maybe: '❔' }[token];
      const thread = await client.channels.fetch(channelId).catch(() => null);
      if (thread) {
        await thread.send({ content: `${tokenEmoji} The Wordsmith answers: **${token.toUpperCase()}**` }).catch(() => {});
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
          content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}\n\n✅ Forbidden word: **${game.word}**\n\nUse the buttons below to respond to questions:`,
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

      // Check if any token type reached zero → trigger voting phase.
      if (game.tokens[token] <= 0) {
        await startVotingPhase(game, client);
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
        return interaction.reply({ content: 'Only the Wordsmith can accept or reject guesses.', flags: MessageFlags.Ephemeral });
      }

      // Edit the guess announcement to show it was accepted, remove buttons.
      await interaction.update({
        content: interaction.message.content + '\n✅ **Accepted by the Wordsmith — correct!**',
        components: [],
      });

      // Credit the stat to whichever player made the accepted guess.
      const guesserId = customId.split('ww_guess_accept_')[1];
      game.winnerGuesserUserId = guesserId ?? null;

      await startRevealPhase(game, client);
      return;
    }

    // ── ww_guess_reject_{guesserId} (Mayor rejects a word guess) ───────────
    if (customId.startsWith('ww_guess_reject_')) {
      if (!game || game.phase !== 'playing') {
        return interaction.reply({ content: 'There is no active game.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.MAYOR) {
        return interaction.reply({ content: 'Only the Wordsmith can accept or reject guesses.', flags: MessageFlags.Ephemeral });
      }

      // Edit the guess announcement to show it was rejected, remove buttons.
      await interaction.update({
        content: interaction.message.content + '\n❌ **Rejected by the Wordsmith — keep guessing!**',
        components: [],
      });

      return;
    }

    // ── ww_reveal (Werewolf chooses to reveal during the reveal phase) ────────
    if (customId === 'ww_reveal') {
      if (!game || game.phase !== 'reveal') {
        return interaction.reply({ content: 'The reveal phase is not active.', flags: MessageFlags.Ephemeral });
      }

      const player = game.players.get(user.id);
      if (!player || player.role !== ROLES.WEREWOLF) {
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
      if (!player || player.role !== ROLES.WEREWOLF) {
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
      const correct = target?.role === ROLES.SEER;
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

    // ── ww_vote_{targetId} (player votes for who they think is the Werewolf) ──
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
      resetGame.wordOptions = sampleN(wordPool, 3);

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

      await thread.send({
        content: `🔄 **Game ${resetGame.gameNumber} starting — same group!**`,
        embeds: [buildGameThreadEmbed(resetGame)],
        components: buildPlayingComponents(),
      }).catch(() => {});

      const boardMsg = await thread.send({
        embeds: [buildBoardEmbed(resetGame)],
        components: buildMayorActionComponents(resetGame.tokens),
      }).catch(() => null);

      if (boardMsg) resetGame.boardMessageId = boardMsg.id;

      let boardRefreshing = false;
      resetGame.timerInterval = setInterval(async () => {
        if (resetGame.phase !== 'playing') return;
        resetGame.timeLeft--;
        if (resetGame.timeLeft <= 0) {
          resetGame.timeLeft = 0;
          await startVotingPhase(resetGame, client);
          return;
        }
        const updateEvery = resetGame.timeLeft > 60 ? 30 : resetGame.timeLeft > 30 ? 10 : 5;
        if (resetGame.timeLeft % updateEvery === 0 && resetGame.boardMessageId && !boardRefreshing) {
          boardRefreshing = true;
          try {
            const bMsg = await thread.messages.fetch(resetGame.boardMessageId).catch(() => null);
            if (bMsg) {
              await bMsg.edit({
                embeds: [buildBoardEmbed(resetGame)],
                components: buildMayorActionComponents(resetGame.tokens),
              }).catch(err => {
                if (err?.status === 429) console.warn(`[Board] Rate limited (thread ${resetGame.threadId}, ${resetGame.timeLeft}s left)`);
              });
            }
          } finally {
            boardRefreshing = false;
          }
        }
      }, 1_000);

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
