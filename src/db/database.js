'use strict';

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../../data/bot.db');

// Ensure the data directory exists (needed for local dev without Docker volume).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance.
db.pragma('journal_mode = WAL');

// ── Schema ─────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS werewords_games (
    thread_id            TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    host_id              TEXT NOT NULL,
    host_username        TEXT NOT NULL,
    message_id           TEXT,
    board_message_id     TEXT,
    phase                TEXT NOT NULL DEFAULT 'lobby',
    players              TEXT NOT NULL DEFAULT '[]',
    word                 TEXT,
    word_options         TEXT NOT NULL DEFAULT '[]',
    tokens               TEXT NOT NULL DEFAULT '{"yes":14,"no":5,"maybe":1}',
    time_left            INTEGER NOT NULL DEFAULT 240,
    votes                TEXT NOT NULL DEFAULT '{}',
    game_number          INTEGER NOT NULL DEFAULT 1,
    winner_guesser_user_id TEXT,
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wavelength_games (
    thread_id            TEXT PRIMARY KEY,
    guild_id             TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    host_id              TEXT NOT NULL,
    host_username        TEXT NOT NULL,
    message_id           TEXT,
    board_message_id     TEXT,
    phase                TEXT NOT NULL DEFAULT 'lobby',
    players              TEXT NOT NULL DEFAULT '[]',
    clue_giver_id        TEXT,
    spectrum_options     TEXT NOT NULL DEFAULT '[]',
    chosen_spectrum      TEXT,
    target_position      INTEGER,
    clue                 TEXT,
    guesses              TEXT NOT NULL DEFAULT '{}',
    game_number          INTEGER NOT NULL DEFAULT 1,
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS werewords_player_stats (
    guild_id                  TEXT NOT NULL,
    user_id                   TEXT NOT NULL,
    username                  TEXT NOT NULL,
    games_played              INTEGER NOT NULL DEFAULT 0,
    wins                      INTEGER NOT NULL DEFAULT 0,
    losses                    INTEGER NOT NULL DEFAULT 0,
    role_wordsmith            INTEGER NOT NULL DEFAULT 0,
    role_demon                INTEGER NOT NULL DEFAULT 0,
    role_librarian            INTEGER NOT NULL DEFAULT 0,
    role_townsfolk            INTEGER NOT NULL DEFAULT 0,
    correct_guesses           INTEGER NOT NULL DEFAULT 0,
    times_identified_as_seer  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS wavelength_player_stats (
    guild_id           TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    username           TEXT NOT NULL,
    rounds_played      INTEGER NOT NULL DEFAULT 0,
    rounds_as_clue_giver INTEGER NOT NULL DEFAULT 0,
    total_score        INTEGER NOT NULL DEFAULT 0,
    bullseyes          INTEGER NOT NULL DEFAULT 0,
    synergy_bonuses    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS birthdays (
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    birth_day    INTEGER NOT NULL,
    birth_month  INTEGER NOT NULL,
    birth_year   INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS birthday_announcements (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    announced_on  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, announced_on)
  );

  CREATE TABLE IF NOT EXISTS birthday_settings (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT,
    enabled     INTEGER NOT NULL DEFAULT 0
  );
`);

// ── One-time migration: stats.json → werewords_player_stats ───────────────────

const STATS_JSON = path.join(__dirname, '../../data/stats.json');
const STATS_JSON_MIGRATED = STATS_JSON + '.migrated';

if (fs.existsSync(STATS_JSON) && !fs.existsSync(STATS_JSON_MIGRATED)) {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_JSON, 'utf8'));

    const upsert = db.prepare(`
      INSERT INTO werewords_player_stats
        (guild_id, user_id, username, games_played, wins, losses,
         role_wordsmith, role_demon, role_librarian, role_townsfolk,
         correct_guesses, times_identified_as_seer)
      VALUES
        (@guild_id, @user_id, @username, @games_played, @wins, @losses,
         @role_wordsmith, @role_demon, @role_librarian, @role_townsfolk,
         @correct_guesses, @times_identified_as_seer)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username                 = excluded.username,
        games_played             = excluded.games_played,
        wins                     = excluded.wins,
        losses                   = excluded.losses,
        role_wordsmith           = excluded.role_wordsmith,
        role_demon               = excluded.role_demon,
        role_librarian           = excluded.role_librarian,
        role_townsfolk           = excluded.role_townsfolk,
        correct_guesses          = excluded.correct_guesses,
        times_identified_as_seer = excluded.times_identified_as_seer
    `);

    const migrate = db.transaction(() => {
      for (const [guildId, players] of Object.entries(raw)) {
        for (const [userId, s] of Object.entries(players)) {
          upsert.run({
            guild_id:                  guildId,
            user_id:                   userId,
            username:                  s.username ?? userId,
            games_played:              s.gamesPlayed        ?? 0,
            wins:                      s.wins               ?? 0,
            losses:                    s.losses             ?? 0,
            role_wordsmith:            s.rolesPlayed?.Wordsmith ?? 0,
            role_demon:                s.rolesPlayed?.Demon     ?? 0,
            role_librarian:            s.rolesPlayed?.Librarian ?? 0,
            role_townsfolk:            s.rolesPlayed?.Townsfolk ?? 0,
            correct_guesses:           s.correctGuesses         ?? 0,
            times_identified_as_seer:  s.timesIdentifiedAsSeer  ?? 0,
          });
        }
      }
    });

    migrate();
    fs.renameSync(STATS_JSON, STATS_JSON_MIGRATED);
    console.log('[DB] Migrated stats.json → werewords_player_stats');
  } catch (err) {
    console.error('[DB] stats.json migration failed — skipping:', err.message);
  }
}

module.exports = db;
