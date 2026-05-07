'use strict';

const WavelengthRepository = require('../db/WavelengthRepository');

class WavelengthGameState {
  constructor(guildId, channelId, threadId, hostId, hostUsername) {
    this.guildId       = guildId;
    this.channelId     = channelId;   // Parent channel (where lobby embed lives)
    this.threadId      = threadId;    // Private thread ID (game key)
    this.hostId        = hostId;
    this.hostUsername  = hostUsername;

    this.messageId     = null;        // Parent-channel lobby/status embed message ID
    this.boardMessageId = null;       // In-thread live board message ID

    /** @type {'lobby'|'setup'|'cluing'|'guessing'|'reveal'|'ended'} */
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
    this.gameNumber     = 1;          // Round counter within this session.
    this.sessionHistory = [];         // Array of { roundNumber, clueGiverId, target, clue, spectrum, guesses, scores }
    this.sessionMode    = null;       // { type, clueOrder, targetClueTurns?, targetPoints? }
    this.clueOrderState = {
      roundRobinIndex:   0,
      snakeIndex:        0,
      snakeDirection:    1,
      clueTurnsByPlayer: {},
    };
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
    game._createdAt = Date.now();
    this.games.set(threadId, game);
    WavelengthRepository.upsert(game);
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
    WavelengthRepository.remove(threadId);
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

    // Keep players, sessionHistory, and session mode.
    WavelengthRepository.upsert(game);
    return game;
  }

  /**
   * Reset state to begin a brand new session in the same thread.
   * Preserves players only.
   */
  resetForNewSession(threadId, openSignups) {
    const game = this.games.get(threadId);
    if (!game) return null;

    if (game.guessTimeout) {
      clearTimeout(game.guessTimeout);
      game.guessTimeout = null;
    }

    game.gameNumber      = 1;
    game.boardMessageId  = null;
    game.phase           = openSignups ? 'lobby' : 'setup';
    game.clueGiverId     = null;
    game.spectrumOptions = [];
    game.chosenSpectrum  = null;
    game.targetPosition  = null;
    game.clue            = null;
    game.guesses         = new Map();
    game.sessionHistory  = [];
    game.sessionMode     = null;
    game.clueOrderState  = {
      roundRobinIndex:   0,
      snakeIndex:        0,
      snakeDirection:    1,
      clueTurnsByPlayer: {},
    };

    WavelengthRepository.upsert(game);
    return game;
  }

  setSessionMode(threadId, sessionMode) {
    const game = this.games.get(threadId);
    if (!game) return null;
    game.sessionMode = sessionMode;
    game.clueOrderState = {
      roundRobinIndex:   0,
      snakeIndex:        0,
      snakeDirection:    1,
      clueTurnsByPlayer: {},
    };
    WavelengthRepository.upsert(game);
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
    WavelengthRepository.upsert(game);
    return true;
  }

  /** Remove a player. Returns false if they weren't in the game. */
  removePlayer(threadId, userId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    const removed = game.players.delete(userId);
    if (removed) WavelengthRepository.upsert(game);
    return removed;
  }

  /**
   * Prepare the game to start: assign a random Clue Giver, set a random target,
   * and pick two spectrum options from the provided pool.
   */
  startGame(threadId, spectraPool) {
    const game = this.games.get(threadId);
    if (!game) return;

    const playerIds = [...game.players.keys()];
    if (!game.sessionMode) return;
    game.clueGiverId   = this.pickClueGiver(game, playerIds);
    if (!game.clueGiverId) return;
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
    WavelengthRepository.upsert(game);
  }

  pickClueGiver(game, playerIds) {
    if (playerIds.length === 0) return null;
    const order = game.sessionMode?.clueOrder ?? 'random';
    const state = game.clueOrderState ?? {};

    let selectedId;

    if (order === 'round_robin') {
      const idx = state.roundRobinIndex ?? 0;
      selectedId = playerIds[idx % playerIds.length];
      game.clueOrderState.roundRobinIndex = (idx + 1) % playerIds.length;
    } else if (order === 'snake') {
      if (playerIds.length === 1) {
        selectedId = playerIds[0];
      } else {
        let idx = Math.max(0, Math.min(playerIds.length - 1, state.snakeIndex ?? 0));
        let dir = state.snakeDirection === -1 ? -1 : 1;
        selectedId = playerIds[idx];
        ({ idx, dir } = this.advanceSnakeIndex(idx, dir, playerIds.length));

        game.clueOrderState.snakeIndex = idx;
        game.clueOrderState.snakeDirection = dir;
      }
    } else {
      selectedId = playerIds[Math.floor(Math.random() * playerIds.length)];
    }

    const counts = game.clueOrderState.clueTurnsByPlayer ?? {};
    counts[selectedId] = (counts[selectedId] ?? 0) + 1;
    game.clueOrderState.clueTurnsByPlayer = counts;
    return selectedId;
  }

  /**
   * Advance the snake cursor for clue-giver order.
   * Pattern for players [A,B,C] is A → B → C → C → B → A → A → ...
   */
  advanceSnakeIndex(idx, dir, playerCount) {
    if (playerCount <= 1) return { idx: 0, dir: 1 };
    if (dir === 1) {
      if (idx >= playerCount - 1) return { idx: playerCount - 1, dir: -1 };
      return { idx: idx + 1, dir };
    }
    if (idx <= 0) return { idx: 0, dir: 1 };
    return { idx: idx - 1, dir };
  }
}

module.exports = WavelengthManager;
