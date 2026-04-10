const { assignRoles } = require('../utils/roles');

// ── GameState ──────────────────────────────────────────────────────────────────

class GameState {
  /**
   * @param {string} guildId
   * @param {string} channelId
   * @param {string} hostId
   * @param {string} hostUsername
   */
  constructor(guildId, channelId, hostId, hostUsername) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.hostId = hostId;
    this.hostUsername = hostUsername;
    this.messageId = null;

    /** @type {'lobby'|'starting'|'playing'|'voting'|'ended'} */
    this.phase = 'lobby';

    /** @type {Map<string, {id: string, username: string, role: string|null}>} */
    this.players = new Map(); // userId → player object

    this.word = null;
    /** @type {string[]} Three preset word options presented to the Mayor. */
    this.wordOptions = [];
    /**
     * Deferred ephemeral interactions from Werewolf/Seer players who clicked
     * "View Secret Info" before the Mayor chose a word. Each entry is a
     * Discord Interaction object whose editReply() we call once the word is set.
     * @type {import('discord.js').ButtonInteraction[]}
     */
    this.pendingSecretInteractions = [];
    this.tokens = { yes: 14, no: 5, maybe: 1 };
    this.readyPlayers = new Set();

    // Populated during the playing phase (next step)
    this.timerInterval = null;
    this.timeLeft = 240; // seconds (4 minutes)
    this.collector = null;
  }
}

// ── GameManager ────────────────────────────────────────────────────────────────

class GameManager {
  constructor() {
    /** @type {Map<string, GameState>} */
    this.games = new Map();
  }

  /**
   * Creates and registers a new game for the given guild.
   * @returns {GameState}
   */
  createGame(guildId, channelId, hostId, hostUsername) {
    const game = new GameState(guildId, channelId, hostId, hostUsername);
    this.games.set(guildId, game);
    return game;
  }

  /** @returns {GameState|null} */
  getGame(guildId) {
    return this.games.get(guildId) ?? null;
  }

  /**
   * Cleans up timers/collectors and removes the game from the registry.
   * @returns {boolean} whether a game was removed
   */
  deleteGame(guildId) {
    const game = this.games.get(guildId);
    if (!game) return false;

    if (game.timerInterval) clearInterval(game.timerInterval);
    if (game.collector && !game.collector.ended) game.collector.stop('cleanup');

    this.games.delete(guildId);
    return true;
  }

  /**
   * Adds a Discord user to the lobby.
   * @param {{id: string, username: string}} user
   * @returns {boolean} false if the user was already in the game or the lobby is full
   */
  addPlayer(guildId, user) {
    const game = this.games.get(guildId);
    if (!game || game.players.has(user.id) || game.players.size >= 10) return false;

    game.players.set(user.id, { id: user.id, username: user.username, role: null });
    return true;
  }

  /**
   * Removes a player from the lobby by user ID.
   * @returns {boolean}
   */
  removePlayer(guildId, userId) {
    const game = this.games.get(guildId);
    if (!game) return false;
    return game.players.delete(userId);
  }

  /**
   * Shuffles the player list and assigns roles in place.
   * @returns {GameState|null}
   */
  assignRoles(guildId) {
    const game = this.games.get(guildId);
    if (!game) return null;

    const assigned = assignRoles([...game.players.values()]);
    for (const player of assigned) {
      game.players.set(player.id, player);
    }
    return game;
  }
}

module.exports = GameManager;
