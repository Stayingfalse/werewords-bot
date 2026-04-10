const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const {
  buildLobbyEmbed,
  buildLobbyComponents,
  buildStartingEmbed,
  buildPlayingComponents,
  buildMayorWordComponents,
} = require('../game/phases/lobby');
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
          content: `✅ You chose the magic word: **${game.word}**`,
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

    const game = gameManager.getGame(channelId);

    // ── ww_join ──────────────────────────────────────────────────────────────
    if (customId === 'ww_join') {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'There is no active lobby to join.', flags: MessageFlags.Ephemeral });
      }

      const added = gameManager.addPlayer(channelId, user);
      if (!added) {
        const reason = game.players.size >= 10
          ? 'The lobby is full (10 players max).'
          : 'You are already in the game.';
        return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
      }

      return interaction.update({
        embeds: [buildLobbyEmbed(game)],
        components: buildLobbyComponents(),
      });
    }

    // ── ww_leave ─────────────────────────────────────────────────────────────
    if (customId === 'ww_leave') {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'There is no active lobby.', flags: MessageFlags.Ephemeral });
      }

      const removed = gameManager.removePlayer(channelId, user.id);
      if (!removed) {
        return interaction.reply({ content: 'You are not in the game.', flags: MessageFlags.Ephemeral });
      }

      return interaction.update({
        embeds: [buildLobbyEmbed(game)],
        components: buildLobbyComponents(),
      });
    }

    // ── ww_start ─────────────────────────────────────────────────────────────
    if (customId === 'ww_start') {
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

      // Lock the phase immediately to prevent a race condition on double-click.
      game.phase = 'starting';
      await interaction.deferUpdate();

      // Assign roles and prepare 3 random word options for the Mayor to choose from.
      gameManager.assignRoles(channelId);
      game.wordOptions = sampleN(wordPool, 3);
      // game.word stays null until the Mayor picks.

      // Transition the lobby embed to the "starting" state.
      game.phase = 'playing';
      await interaction.editReply({
        embeds: [buildStartingEmbed(game)],
        components: buildPlayingComponents(),
      });

      // ── TODO (next step) ─────────────────────────────────────────────────
      // Start the 4-minute countdown timmer, build the game board embed with
      // Yes / No / Maybe tokens (Mayor-only buttons), and attach an
      // InteractionCollector for word-guessing modals and voting logic.
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

      // Mayor gets the word-picker UI until they have chosen a word.
      if (player.role === ROLES.MAYOR) {
        if (game.word) {
          return interaction.reply({
            content: `${ROLE_DESCRIPTIONS[ROLES.MAYOR]}\n\n✅ You chose the magic word: **${game.word}**`,
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
        content: `✅ You chose the magic word: **${game.word}**`,
        components: [],
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
  },
};
