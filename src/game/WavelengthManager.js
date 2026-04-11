'use strict';

class WavelengthGameState {
  constructor(guildId, channelId, threadId, hostId, hostUsername) {
    this.guildId       = guildId;
    this.channelId     = channelId;   // Parent channel (where lobby embed lives)
    this.threadId      = threadId;    // Private thread ID (game key)
    this.hostId        = hostId;
    this.hostUsername  = hostUsername;

    this.messageId     = null;        // Parent-channel lobby/status embed message ID
    this.boardMessageId = null;       // In-thread live board message ID

    /** @type {'lobby'|'cluing'|'guessing'|'reveal'|'ended'} */
    this.phase = 'lobby';

    /** @type {Map<string, {id:string, username:string, avatarURL:string}>} */
    this.players = new Map();

    this.clueGiverId = null;          // userId of the randomly chosen Clue Giver

    // Two spectrum options presented to the Clue Giver to pick from.
    // Each is { left: string, right: string }.
    this.spectrumOptions = [];
    this.chosenSpectrum  = null;      // { left, right } — set when Clue Giver picks

    this.targetPosition = null;       // Integer 0–100 randomised on game start
    this.clue           = null;       // String submitted by Clue Giver via modal

    // Map<userId, { position: number, submitted: boolean }>
    // Guessers start at position 50 and nudge before submitting.
    this.guesses = new Map();

    this.guessTimeout   = null;       // setTimeout handle for auto-submit fallback
    this.gameNumber     = 1;
    this.sessionHistory = [];         // Array of { gameNumber, target, clue, spectrum, guesses }
  }
}

class WavelengthManager {
  constructor() {
    /** @type {Map<string, WavelengthGameState>} */
    this.games = new Map();
  }

  /** Create and register a new game keyed by threadId. */
  createGame(guildId, channelId, threadId, hostId, hostUsername) {
    const game = new WavelengthGameState(guildId, channelId, threadId, hostId, hostUsername);
    this.games.set(threadId, game);
    return game;
  }

  /** Get game by threadId (the primary key). */
  getGame(threadId) {
    return this.games.get(threadId) ?? null;
  }

  /** Find an existing game for a given host within a guild (used for pre-flight teardown). */
  getGameByHost(guildId, hostId) {
    for (const game of this.games.values()) {
      if (game.guildId === guildId && game.hostId === hostId) return game;
    }
    return null;
  }

  /** Remove a game and clear all its timers. */
  deleteGame(threadId) {
    const game = this.games.get(threadId);
    if (!game) return;
    if (game.guessTimeout) {
      clearTimeout(game.guessTimeout);
      game.guessTimeout = null;
    }
    this.games.delete(threadId);
  }

  /**
   * Reset state for a rematch.
   * @param {string} threadId
   * @param {boolean} openSignups  true = go back to lobby; false = restart immediately with same players
   */
  resetForRematch(threadId, openSignups) {
    const game = this.games.get(threadId);
    if (!game) return null;

    if (game.guessTimeout) {
      clearTimeout(game.guessTimeout);
      game.guessTimeout = null;
    }

    game.gameNumber++;
    game.boardMessageId    = null;
    game.phase             = openSignups ? 'lobby' : 'cluing';
    game.clueGiverId       = null;
    game.spectrumOptions   = [];
    game.chosenSpectrum    = null;
    game.targetPosition    = null;
    game.clue              = null;
    game.guesses           = new Map();

    // Keep players and sessionHistory.
    return game;
  }

  /** Add a player. Returns false if they're already in or the lobby is full (20 max). */
  addPlayer(threadId, user) {
    const game = this.games.get(threadId);
    if (!game) return false;
    if (game.players.has(user.id)) return false;
    if (game.players.size >= 20) return false;
    game.players.set(user.id, {
      id:        user.id,
      username:  user.username,
      avatarURL: user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }),
    });
    return true;
  }

  /** Remove a player. Returns false if they weren't in the game. */
  removePlayer(threadId, userId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    return game.players.delete(userId);
  }

  /**
   * Prepare the game to start: assign a random Clue Giver, set a random target,
   * and pick two spectrum options from the provided pool.
   */
  startGame(threadId, spectraPool) {
    const game = this.games.get(threadId);
    if (!game) return;

    const playerIds = [...game.players.keys()];
    game.clueGiverId   = playerIds[Math.floor(Math.random() * playerIds.length)];
    game.targetPosition = Math.floor(Math.random() * 101); // 0–100 inclusive

    // Fisher-Yates shuffle, pick 2.
    const pool = [...spectraPool];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    game.spectrumOptions = pool.slice(0, 2);

    // Initialise guesses for all non-Clue-Giver players.
    game.guesses = new Map();
    for (const id of playerIds) {
      if (id !== game.clueGiverId) {
        game.guesses.set(id, { position: 50, submitted: false });
      }
    }

    game.phase = 'cluing';
  }
}

module.exports = WavelengthManager;
