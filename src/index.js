require('dotenv').config();

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const GameManager = require('./game/GameManager');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // DirectMessages intent not required — the bot sends DMs but doesn't listen to DM messages.
  ],
});

client.commands = new Collection();
client.gameManager = new GameManager();

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
  const handler = (...args) => event.execute(...args, client);
  if (event.once) {
    client.once(event.name, handler);
  } else {
    client.on(event.name, handler);
  }
}

client.login(process.env.DISCORD_TOKEN);
