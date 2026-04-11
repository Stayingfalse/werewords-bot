const { EmbedBuilder } = require('discord.js');

// ── Outcome definitions ────────────────────────────────────────────────────────

const OUTCOMES = {
  villagers_word: {
    title: '🎉 Villagers Win!',
    description: 'The magic word was correctly guessed and the Werewolf stayed hidden!',
    color: 0x57F287, // green
  },
  werewolf_time: {
    title: '🐺 Werewolves Win!',
    description: 'Time ran out before the magic word was guessed.',
    color: 0xED4245, // red
  },
  werewolf_tokens: {
    title: '🐺 Werewolves Win!',
    description: 'All tokens were used up before the magic word was guessed.',
    color: 0xED4245, // red
  },
  werewolf_seer: {
    title: '🐺 Werewolves Win!',
    description: 'The word was guessed but the Werewolf revealed themselves and correctly identified the Seer!',
    color: 0xED4245, // red
  },
  villagers_vote: {
    title: '🎉 Villagers Win!',
    description: 'The Villagers voted correctly and exposed the Werewolf!',
    color: 0x57F287, // green
  },
  werewolf_vote: {
    title: '🐺 Werewolves Win!',
    description: 'The Villagers failed to identify the Werewolf.',
    color: 0xED4245, // red
  },
};

// ── End-game embed ─────────────────────────────────────────────────────────────

/**
 * @param {import('../GameManager').GameState} game
 * @param {keyof OUTCOMES} outcome
 */
function buildEndEmbed(game, outcome) {
  const { title, description, color } = OUTCOMES[outcome];

  const roleLines = [...game.players.values()]
    .map(p => `<@${p.id}> — **${p.role}**`)
    .join('\n');

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: '🔤 The Magic Word Was', value: `**${game.word || '*(never chosen)*'}**` },
      { name: 'Player Roles', value: roleLines },
    )
    .setColor(color)
    .setTimestamp();
}

// ── End-game logic ─────────────────────────────────────────────────────────────

/**
 * Finalises the game:
 *  1. Clears the countdown timer.
 *  2. Sets phase to 'ended' and removes Mayor action buttons from the board.
 *  3. Posts the end-game result embed in the private thread.
 *  4. Updates the main-channel embed to show the game ended (no buttons).
 *  5. Archives and locks the thread after 30 s.
 *  6. Deletes the game from the registry.
 *
 * @param {import('../GameManager').GameState} game
 * @param {import('discord.js').Client} client
 * @param {'villagers_word'|'werewolf_time'|'werewolf_tokens'} outcome
 */
async function endGame(game, client, outcome) {
  // Guard against being called twice (e.g. timer + simultaneous guess accept).
  if (game.phase === 'ended') return;

  // Stop timers immediately.
  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }
  if (game.revealTimeout) {
    clearTimeout(game.revealTimeout);
    game.revealTimeout = null;
  }

  game.phase = 'ended';

  const thread = await client.channels.fetch(game.threadId).catch(() => null);

  if (thread) {
    // Remove Mayor action buttons from the board so they can't be clicked
    // in the 30-second window before the thread is archived.
    if (game.boardMessageId) {
      const boardMsg = await thread.messages.fetch(game.boardMessageId).catch(() => null);
      if (boardMsg) {
        await boardMsg.edit({ components: [] }).catch(() => {});
      }
    }

    // Post the end-game result embed.
    await thread.send({ embeds: [buildEndEmbed(game, outcome)] }).catch(() => {});

    // Archive and lock the thread after 30 seconds.
    setTimeout(async () => {
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }, 30_000);
  }

  // Update the main-channel embed to reflect the game ended.
  if (game.channelId && game.messageId) {
    const channel = await client.channels.fetch(game.channelId).catch(() => null);
    if (channel) {
      const lobbyMsg = await channel.messages.fetch(game.messageId).catch(() => null);
      if (lobbyMsg) {
        const { title, description, color } = OUTCOMES[outcome];
        const endedEmbed = new EmbedBuilder()
          .setTitle(`🐺  Werewords — ${title}`)
          .setDescription(description)
          .addFields({ name: '🔤 The Magic Word Was', value: `**${game.word || '*(never chosen)*'}**` })
          .setColor(color)
          .setTimestamp();
        await lobbyMsg.edit({ embeds: [endedEmbed], components: [] }).catch(() => {});
      }
    }
  }

  // Remove the game from the registry (also clears any remaining timer ref).
  client.gameManager.deleteGame(game.threadId);
}

module.exports = { endGame };
