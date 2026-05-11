'use strict';

const HerdMentalityRepository = require('../db/HerdMentalityRepository');

class HerdMentalityGameState {
  constructor(guildId, channelId, threadId, hostId, hostUsername) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.threadId = threadId;
    this.hostId = hostId;
    this.hostUsername = hostUsername;
    this.messageId = null;
    this.questionMessageId = null;

    this.phase = 'lobby'; // lobby | answering | reviewing | revealing | ended
    this.players = new Map(); // userId -> { id, username, score, hasPinkCow }
    this.answers = new Map(); // userId -> string (raw answer)
    this.currentQuestion = null;
    this.roundNumber = 0;
    this.pinkCowHolderId = null;
    this.targetScore = 8;
    this.usedQuestions = new Set();
    this.phaseEndsAt = null;

    this.answerTimeout = null;
    this.gameNumber = 1;

    // Populated during the 'reviewing' phase; null otherwise.
    // Array<{ key: string, playerIds: string[] }> where key is the normalised answer label.
    this.reviewGroups = null;
    // Message ID of the pre-score review embed so it can be updated after merges.
    this.reviewMessageId = null;
  }
}

class HerdMentalityManager {
  constructor() {
    this.games = new Map();
  }

  createGame(guildId, channelId, threadId, hostId, hostUsername) {
    const game = new HerdMentalityGameState(guildId, channelId, threadId, hostId, hostUsername);
    game._createdAt = Date.now();
    this.games.set(threadId, game);
    HerdMentalityRepository.upsert(game);
    return game;
  }

  getGame(threadId) {
    return this.games.get(threadId) ?? null;
  }

  getGameByHost(guildId, hostId) {
    for (const game of this.games.values()) {
      if (game.guildId === guildId && game.hostId === hostId) return game;
    }
    return null;
  }

  deleteGame(threadId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    if (game.answerTimeout) clearTimeout(game.answerTimeout);
    HerdMentalityRepository.remove(threadId);
    this.games.delete(threadId);
    return true;
  }

  addPlayer(threadId, user) {
    const game = this.games.get(threadId);
    if (!game || game.players.has(user.id) || game.players.size >= 12) return false;
    game.players.set(user.id, {
      id: user.id,
      username: user.username,
      score: 0,
      hasPinkCow: false,
    });
    HerdMentalityRepository.upsert(game);
    return true;
  }

  removePlayer(threadId, userId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    const removed = game.players.delete(userId);
    if (removed) HerdMentalityRepository.upsert(game);
    return removed;
  }

  saveGame(threadId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    HerdMentalityRepository.upsert(game);
    return true;
  }
}

module.exports = HerdMentalityManager;
