const CheeseThiefRepository = require('../db/CheeseThiefRepository');

class CheeseThiefGameState {
  constructor(guildId, channelId, threadId, hostId, hostUsername) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.threadId = threadId;
    this.hostId = hostId;
    this.hostUsername = hostUsername;
    this.messageId = null;
    this.readyMessageId = null;

    this.phase = 'lobby'; // lobby|playing|accomplice|discussion|voting|ended
    this.players = new Map();
    this.readyPlayers = new Set();
    this.votes = new Map();

    this.currentWakeNumber = 0;
    this.phaseEndsAt = null;
    this.cheeseStolen = false;
    this.thiefId = null;
    this.accompliceId = null;
    this.stolenAtWake = null;

    // In-memory only (not persisted — regenerated on each game start / restored as empty on resume)
    this.ephemeralTokens      = new Map(); // userId → { token, applicationId }
    this.playerLogs           = new Map(); // userId → string[]
    this.discussionReadyPlayers = new Set();

    this.wakeTimeout = null;
    this.accompliceTimeout = null;
    this.revealTimeout = null;
    this.gameNumber = 1;
  }
}

const CT_ROLES = Object.freeze({
  THIEF: 'Cheese Thief',
  FALL_MOUSE: 'Fall Mouse',
  SLEEPY_MICE: 'Sleepy Mice',
});

function assignCheeseThiefRoles(players) {
  if (players.length < 3) throw new Error('At least 3 players are required to start Cheese Thief.');

  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const result = shuffled.map(p => ({ ...p, role: CT_ROLES.SLEEPY_MICE, dieValue: null, isAccomplice: false }));
  result[0].role = CT_ROLES.THIEF;
  result[1].role = CT_ROLES.FALL_MOUSE;
  return result;
}

class CheeseThiefManager {
  constructor() {
    this.games = new Map();
  }

  createGame(guildId, channelId, threadId, hostId, hostUsername) {
    const game = new CheeseThiefGameState(guildId, channelId, threadId, hostId, hostUsername);
    game._createdAt = Date.now();
    this.games.set(threadId, game);
    CheeseThiefRepository.upsert(game);
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
    if (game.wakeTimeout)       clearTimeout(game.wakeTimeout);
    if (game.accompliceTimeout) clearTimeout(game.accompliceTimeout);
    if (game.revealTimeout)     clearTimeout(game.revealTimeout);
    CheeseThiefRepository.remove(threadId);
    this.games.delete(threadId);
    return true;
  }

  addPlayer(threadId, user) {
    const game = this.games.get(threadId);
    if (!game || game.players.has(user.id) || game.players.size >= 10) return false;
    game.players.set(user.id, {
      id: user.id,
      username: user.username,
      role: null,
      dieValue: null,
      isAccomplice: false,
    });
    CheeseThiefRepository.upsert(game);
    return true;
  }

  removePlayer(threadId, userId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    const removed = game.players.delete(userId);
    if (removed) CheeseThiefRepository.upsert(game);
    return removed;
  }

  assignRoles(threadId) {
    const game = this.games.get(threadId);
    if (!game) return null;
    const assigned = assignCheeseThiefRoles([...game.players.values()]);
    for (const player of assigned) {
      game.players.set(player.id, player);
    }
    game.thiefId = assigned.find(p => p.role === CT_ROLES.THIEF)?.id ?? null;
    CheeseThiefRepository.upsert(game);
    return game;
  }

  resetForRematch(threadId, openSignups) {
    const game = this.games.get(threadId);
    if (!game) return null;

    if (game.wakeTimeout)       { clearTimeout(game.wakeTimeout);       game.wakeTimeout       = null; }
    if (game.accompliceTimeout) { clearTimeout(game.accompliceTimeout); game.accompliceTimeout = null; }
    if (game.revealTimeout)     { clearTimeout(game.revealTimeout);     game.revealTimeout     = null; }

    game.gameNumber += 1;
    game.phase = openSignups ? 'lobby' : 'playing';
    game.readyPlayers = new Set();
    game.votes = new Map();
    game.currentWakeNumber = 0;
    game.phaseEndsAt = null;
    game.cheeseStolen = false;
    game.accompliceId = null;
    game.stolenAtWake = null;
    game.readyMessageId = null;

    if (openSignups) {
      const host = game.players.get(game.hostId);
      game.players = new Map();
      if (host) game.players.set(host.id, { ...host, role: null, dieValue: null, isAccomplice: false });
    } else {
      for (const player of game.players.values()) {
        player.role = null;
        player.dieValue = null;
        player.isAccomplice = false;
      }
    }

    CheeseThiefRepository.upsert(game);
    return game;
  }

  saveGame(threadId) {
    const game = this.games.get(threadId);
    if (!game) return false;
    CheeseThiefRepository.upsert(game);
    return true;
  }
}

module.exports = { CheeseThiefManager, CT_ROLES };
