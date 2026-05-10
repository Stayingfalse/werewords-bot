require('dotenv').config();

// Initialise the database (creates schema + migrates stats.json) before
// anything else so all repositories are ready when the managers start.
require('./db/database');

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const GameManager = require('./game/GameManager');
const { CheeseThiefManager } = require('./game/CheeseThiefManager');
const WavelengthManager = require('./game/WavelengthManager');
const BirthdayManager = require('./game/BirthdayManager');
const SassyManager = require('./game/SassyManager');

// ── Process-level crash guards ─────────────────────────────────────────────
// Prevent Node from exiting on unhandled async errors or synchronous throws.
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Privileged — enable in Discord Dev Portal → Bot → Privileged Gateway Intents
    GatewayIntentBits.GuildMembers,   // Required by SassyManager when SASSY_ENABLED=true
  ],
});

// ── Discord client error guard ─────────────────────────────────────────────
// Catches connection-level errors emitted by the discord.js client.
client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

client.commands = new Collection();
client.gameManager = new GameManager();
client.cheeseThiefManager = new CheeseThiefManager();
client.wavelengthManager = new WavelengthManager();
client.birthdayManager = new BirthdayManager();

// Conditionally initialise SassyBot AI features.
// Set SASSY_ENABLED=true and provide a GEMINI_API_KEY to activate.
if (process.env.SASSY_ENABLED === 'true') {
  try {
    client.sassyManager = new SassyManager();
  } catch (err) {
    console.error('[SassyManager] Failed to initialise:', err);
  }
}

// ── Load commands ──────────────────────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// ── Load events ────────────────────────────────────────────────────────────────
const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  // Append the client instance so every event handler can access it.
  // Wrap in a catch so errors from any event handler never crash the process.
  const handler = (...args) => Promise.resolve(event.execute(...args, client)).catch((err) => {
    console.error(`[Event handler error: ${event.name}]`, err);
  });
  if (event.once) {
    client.once(event.name, handler);
  } else {
    client.on(event.name, handler);
  }
}

client.login(process.env.DISCORD_TOKEN);
