const fs = require('fs');
const path = require('path');

const STATS_PATH = path.join(__dirname, '../../data/stats.json');
const TMP_PATH   = STATS_PATH + '.tmp';

// ── Helpers ────────────────────────────────────────────────────────────────────

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Atomic write: write to a temp file then rename over the real file. */
function save(data) {
  fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(TMP_PATH, STATS_PATH);
}

function defaultEntry() {
  return {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    rolesPlayed: { Mayor: 0, Werewolf: 0, Seer: 0, Villager: 0 },
    correctGuesses: 0,
    timesIdentifiedAsSeer: 0,
  };
}

// ── Win/loss assignment per outcome ───────────────────────────────────────────

/** Returns the set of roles that WIN for a given outcome. */
const WINNER_ROLES = {
  villagers_word:   new Set(['Mayor', 'Seer', 'Villager']),
  villagers_vote:   new Set(['Mayor', 'Seer', 'Villager']),
  werewolf_time:    new Set(['Werewolf']),
  werewolf_tokens:  new Set(['Werewolf']),
  werewolf_seer:    new Set(['Werewolf']),
  werewolf_vote:    new Set(['Werewolf']),
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Records the result of one game into stats.json.
 *
 * @param {string} guildId
 * @param {Map<string, {id: string, username: string, role: string}>} players
 * @param {string} outcome  One of the OUTCOMES keys
 * @param {string|null} winnerGuesserUserId  userId whose guess was accepted (may be null)
 * @param {string|null} seerVictimUserId     userId the Werewolf correctly named as Seer (may be null)
 */
function recordGame(guildId, players, outcome, winnerGuesserUserId, seerVictimUserId) {
  const data = load();
  if (!data[guildId]) data[guildId] = {};

  const winners = WINNER_ROLES[outcome] ?? new Set();

  for (const player of players.values()) {
    if (!data[guildId][player.id]) {
      data[guildId][player.id] = { username: player.username, ...defaultEntry() };
    }
    const entry = data[guildId][player.id];

    // Keep username current.
    entry.username = player.username;

    entry.gamesPlayed++;

    const won = winners.has(player.role);
    if (won) entry.wins++; else entry.losses++;

    if (player.role && entry.rolesPlayed[player.role] !== undefined) {
      entry.rolesPlayed[player.role]++;
    }

    if (winnerGuesserUserId && player.id === winnerGuesserUserId) {
      entry.correctGuesses++;
    }

    if (seerVictimUserId && player.id === seerVictimUserId) {
      entry.timesIdentifiedAsSeer++;
    }
  }

  save(data);
}

/**
 * Returns stats for a specific guild. Returns {} if no data.
 * @param {string} guildId
 */
function getGuildStats(guildId) {
  const data = load();
  return data[guildId] ?? {};
}

module.exports = { recordGame, getGuildStats };
