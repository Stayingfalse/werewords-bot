const { buildLobbyEmbed, buildLobbyComponents, buildStartingEmbed } = require('../game/phases/lobby');
const { ROLE_DESCRIPTIONS } = require('../utils/roles');
const words = require('../../data/words.json');

// Flatten all words from every category into a single pool at load time.
const wordPool = words.categories.flatMap(c => c.words);

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
        const payload = { content: '❌ An error occurred running that command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        } else {
          await interaction.reply(payload);
        }
      }
      return;
    }

    // ── Button interactions ──────────────────────────────────────────────────
    if (!interaction.isButton()) return;

    const { customId, guildId, user } = interaction;

    // Ignore buttons that don't belong to this bot.
    if (!customId.startsWith('ww_')) return;

    const game = gameManager.getGame(guildId);

    // ── ww_join ──────────────────────────────────────────────────────────────
    if (customId === 'ww_join') {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'There is no active lobby to join.', ephemeral: true });
      }

      const added = gameManager.addPlayer(guildId, user);
      if (!added) {
        const reason = game.players.size >= 10
          ? 'The lobby is full (10 players max).'
          : 'You are already in the game.';
        return interaction.reply({ content: reason, ephemeral: true });
      }

      return interaction.update({
        embeds: [buildLobbyEmbed(game)],
        components: buildLobbyComponents(),
      });
    }

    // ── ww_leave ─────────────────────────────────────────────────────────────
    if (customId === 'ww_leave') {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'There is no active lobby.', ephemeral: true });
      }

      const removed = gameManager.removePlayer(guildId, user.id);
      if (!removed) {
        return interaction.reply({ content: 'You are not in the game.', ephemeral: true });
      }

      return interaction.update({
        embeds: [buildLobbyEmbed(game)],
        components: buildLobbyComponents(),
      });
    }

    // ── ww_start ─────────────────────────────────────────────────────────────
    if (customId === 'ww_start') {
      if (!game || game.phase !== 'lobby') {
        return interaction.reply({ content: 'There is no active lobby.', ephemeral: true });
      }
      if (user.id !== game.hostId) {
        return interaction.reply({ content: 'Only the host can start the game.', ephemeral: true });
      }
      if (game.players.size < 3) {
        return interaction.reply({
          content: `Need at least **3 players** to start. Currently: **${game.players.size}**.`,
          ephemeral: true,
        });
      }

      // Lock the phase immediately to prevent a race condition on double-click.
      game.phase = 'starting';
      await interaction.deferUpdate();

      // Assign roles and pick a random secret word.
      gameManager.assignRoles(guildId);
      game.word = wordPool[Math.floor(Math.random() * wordPool.length)];

      // DM every player their role (and the word, where applicable).
      const dmResults = await Promise.allSettled(
        [...game.players.values()].map(async (player) => {
          const discordUser = await client.users.fetch(player.id);
          const descriptor = ROLE_DESCRIPTIONS[player.role];
          const knowsWord  = ['Mayor', 'Werewolf', 'Seer'].includes(player.role);

          let dm = `**🐺 Werewords — Your Role**\n\n${descriptor}`;

          if (knowsWord) {
            dm += `\n\n🔤 The magic word is: **${game.word}**`;
          }
          if (player.role === 'Mayor') {
            dm += '\n\nUse the **Yes / No / Maybe** buttons on the game board to answer questions. You cannot speak!';
          }

          await discordUser.send(dm);
        }),
      );

      const failedDMs = dmResults.filter(r => r.status === 'rejected').length;
      if (failedDMs > 0) {
        console.warn(`[Werewords] Failed to DM ${failedDMs} player(s) in guild ${guildId}.`);
      }

      // Transition the lobby embed to the "starting" state.
      game.phase = 'playing';
      await interaction.editReply({
        embeds: [buildStartingEmbed(game, failedDMs)],
        components: [],
      });

      // ── TODO (next step) ─────────────────────────────────────────────────
      // Start the 4-minute countdown timmer, build the game board embed with
      // Yes / No / Maybe tokens (Mayor-only buttons), and attach an
      // InteractionCollector for word-guessing modals and voting logic.
    }
  },
};
