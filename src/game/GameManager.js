const { assignRoles } = require('../utils/roles');
const GameRepository  = require('../db/GameRepository');

// ── GameState ──────────────────────────────────────────────────────────────────

class GameState {
  /**
   * @param {string} guildId
   * @param {string} threadId  The Discord thread channel ID that hosts this game.
   * @param {string} hostId
   * @param {string} hostUsername
   */
  constructor(guildId, channelId, threadId, hostId, hostUsername) {
    this.guildId = guildId;
    this.channelId = channelId; // parent channel where the public lobby embed lives
    this.threadId = threadId;
    this.hostId = hostId;
    this.hostUsername = hostUsername;
    this.messageId = null;
    /** Discord message ID of the game board embed posted in the thread. */
    this.boardMessageId = null;

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
    this.tokens = { yes_no: 36, maybe: 12, correct: 1, so_close_way_off: 2 };
    this.readyPlayers = new Set();

    // Populated during the playing phase
    this.timerInterval = null;
    this.timeLeft = 240; // seconds (4 minutes)
    this.collector = null;

    // Populated during reveal / voting phases
    /** @type {Map<string, string>} userId → targeted userId */
    this.votes = new Map();
    /** setTimeout handle for the 90s outer reveal safety net / voting window. */
    this.revealTimeout = null;

    // Session tracking
    this.gameNumber = 1;
    /**
     * Results of previous games in this session.
     * @type {Array<{gameNumber: number, outcome: string, word: string|null, players: Array}>}
     */
    this.sessionHistory = [];
    /** userId of the player whose guess was accepted (for stats credit). */
    this.winnerGuesserUserId = null;
  }
}

// ── GameManager ────────────────────────────────────────────────────────────────

class GameManager {
  constructor() {
    /** @type {Map<string, GameState>} */  // threadId → GameState
    this.games = new Map();
  }

  /**
   * Creates and registers a new game, keyed by thread ID.
   * @param {string} guildId
   * @param {string} threadId
   * @param {string} hostId
   * @param {string} hostUsername
   * @returns {GameState}
   */
  createGame(guildId, channelId, threadId, hostId, hostUsername) {
    const game = new GameState(guildId, channelId, threadId, hostId, hostUsername);
    game._createdAt = Date.now();
    this.games.set(threadId, game);
    GameRepository.upsert(game);
    return game;
  }

  /** @returns {GameState|null} */
  getGame(threadId) {
    return this.games.get(threadId) ?? null;
  }

  /**
   * Finds any active game in the given guild that is hosted by hostId.
   * @returns {GameState|null}
   */
  getGameByHost(guildId, hostId) {
    for (const game of this.games.values()) {
      if (game.guildId === guildId && game.hostId === hostId) return game;
    }
    return null;
  }

  /**
   * Cleans up timers/collectors and removes the game from the registry.
   * @returns {boolean} whether a game was removed
   */
  deleteGame(threadId) {
    const game = this.games.get(threadId);
    if (!game) return false;

    if (game.timerInterval) clearInterval(game.timerInterval);
    if (game.revealTimeout) clearTimeout(game.revealTimeout);
    if (game.collector && !game.collector.ended) game.collector.stop('cleanup');

    GameRepository.remove(threadId);
    this.games.delete(threadId);
    return true;
  }

  /**
   * Resets the game for a rematch without destroying the session.
   * @param {string} threadId
   * @param {boolean} openSignups  true = back to lobby; false = straight to playing
   * @returns {GameState|null}
   */
  resetForRematch(threadId, openSignups) {
    const game = this.games.get(threadId);
    if (!game) return null;

    // Stop any lingering timers.
    if (game.timerInterval) { clearInterval(game.timerInterval); game.timerInterval = null; }
    if (game.revealTimeout) { clearTimeout(game.revealTimeout); game.revealTimeout = null; }

    game.gameNumber++;
    game.phase = openSignups ? 'lobby' : 'playing';
    game.word = null;
    game.wordOptions = [];
    game.pendingSecretInteractions = [];
    game.tokens = { yes_no: 36, maybe: 12, correct: 1, so_close_way_off: 2 };
    game.readyPlayers = new Set();
    game.votes = new Map();
    game.boardMessageId = null;
    game.winnerGuesserUserId = null;
    game.timeLeft = 240;

    // Reset roles so they get reassigned on start.
    for (const player of game.players.values()) {
      player.role = null;
    }

    GameRepository.upsert(game);
    return game;
  }

  /**
   * Adds a Discord user to the lobby.
   * @param {string} threadId
   * @param {{id: string, username: string}} user
   * @returns {boolean} false if the user was already in the game or the lobby is full
   */
  addPlayer(threadId, user) {
    const game = this.games.get(threadId);
    if (!game || game.players.has(user.id) || game.players.size >= 10) return false;

    game.players.set(user.id, { id: user.id, username: user.username, role: null });
    GameRepository.upsert(game);
    return true;
  }

  /**
   * Removes a player from the lobby by user ID.
   * @param {string} threadId
   * @returns {boolean}
   */
  removePlayer(threadId, userId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    const removed = game.players.delete(userId);
    if (removed) GameRepository.upsert(game);
    return removed;
  }

  /**
   * Shuffles the player list and assigns roles in place.
   * @param {string} threadId
   * @returns {GameState|null}
   */
  assignRoles(threadId) {
    const game = this.games.get(threadId);
    if (!game) return null;

    const assigned = assignRoles([...game.players.values()]);
    for (const player of assigned) {
      game.players.set(player.id, player);
    }
    GameRepository.upsert(game);
    return game;
  }
}

module.exports = GameManager;
