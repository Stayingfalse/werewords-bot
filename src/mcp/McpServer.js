'use strict';

// ============================================================
//  McpServer — lightweight HTTP context server for potato-game-bot.
//
//  Follows MCP-inspired patterns (resources + tools) over plain HTTP/JSON
//  so it can be queried from within the Docker network or by external
//  MCP-compatible clients (e.g. Claude Desktop with a custom connector).
//
//  Endpoints
//  ─────────
//  GET  /                                      Server capabilities
//  GET  /resources/users/:guildId/:userId      Full user context
//  GET  /resources/channels/:channelId         Recent channel conversation log
//  GET  /resources/channels/:channelId/participants  Active users in channel
//  GET  /resources/scoreboards/:guildId        Werewords top-10 scoreboard
//  GET  /resources/scoreboards/:guildId/wavelength  Wavelength top-10 scoreboard
//  POST /tools/log_message                     Log a message event
//  POST /tools/update_topic_notes              Update user topic notes
// ============================================================

const http = require('http');

const CAPABILITIES = {
  name:        'potato-game-bot-context',
  version:     '1.0.0',
  description: 'MCP context server for potato-game-bot — exposes user profiles, game stats, conversation history, and scoreboards.',
  resources: [
    { uri: '/resources/users/{guildId}/{userId}',              description: 'Full user context: profile, game stats, recent messages' },
    { uri: '/resources/channels/{channelId}',                  description: 'Recent conversation log for a channel' },
    { uri: '/resources/channels/{channelId}/profile',          description: 'Stored topic notes for a channel' },
    { uri: '/resources/channels/{channelId}/participants',     description: 'Users active in a channel in the last N ms' },
    { uri: '/resources/scoreboards/{guildId}',                 description: 'Werewords top-10 scoreboard for a guild' },
    { uri: '/resources/scoreboards/{guildId}/wavelength',      description: 'Wavelength top-10 scoreboard for a guild' },
  ],
  tools: [
    { name: 'log_message',                description: 'Append a message to the conversation log and update the user profile.' },
    { name: 'update_topic_notes',         description: 'Set AI-generated topic notes for a user.' },
    { name: 'update_channel_topic_notes', description: 'Set AI-generated topic notes for a channel.' },
  ],
};

class McpServer {
  /**
   * @param {import('../db/ContextRepository')} contextRepo
   * @param {number} [port=3100]
   */
  constructor(contextRepo, port = 3100) {
    this._repo = contextRepo;
    this._port = port;
    this._server = null;
  }

  start() {
    this._server = http.createServer((req, res) => {
      this._dispatch(req, res).catch((err) => {
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    this._server.listen(this._port, () => {
      console.log(`[McpServer] Context server listening on port ${this._port}`);
    });

    this._server.on('error', (err) => {
      console.error('[McpServer] Server error:', err);
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  // ── Request dispatcher ──────────────────────────────────────────────────────

  async _dispatch(req, res) {
    const baseUrl  = `http://localhost:${this._port}`;
    const url      = new URL(req.url, baseUrl);
    const { method } = req;
    const path     = url.pathname.replace(/\/$/, '') || '/';

    let result;
    let status = 200;

    try {
      result = await this._route(method, path, url, req);
    } catch (err) {
      if (err.status === 404) {
        status = 404;
        result = { error: 'Not found' };
      } else {
        throw err;
      }
    }

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async _route(method, path, url, req) {
    // ── GET / ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/') return CAPABILITIES;

    // ── GET /resources/users/:guildId/:userId ─────────────────────────────────
    let m = path.match(/^\/resources\/users\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && m) {
      return this._repo.getUserContext(m[1], m[2]);
    }

    // ── GET /resources/channels/:channelId/participants ───────────────────────
    m = path.match(/^\/resources\/channels\/([^/]+)\/participants$/);
    if (method === 'GET' && m) {
      const windowMs = parseInt(url.searchParams.get('window') || '3600000', 10);
      return this._repo.getChannelParticipants(m[1], windowMs);
    }

    // ── GET /resources/channels/:channelId/profile ────────────────────────────
    m = path.match(/^\/resources\/channels\/([^/]+)\/profile$/);
    if (method === 'GET' && m) {
      return this._repo.getChannelProfile(m[1]) ?? { channel_id: m[1], topic_notes: null };
    }

    // ── GET /resources/channels/:channelId ────────────────────────────────────
    m = path.match(/^\/resources\/channels\/([^/]+)$/);
    if (method === 'GET' && m) {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const msgs  = this._repo.getRecentConversations(m[1], limit);
      // Return in chronological order for readability
      return msgs.reverse();
    }

    // ── GET /resources/scoreboards/:guildId/wavelength ────────────────────────
    m = path.match(/^\/resources\/scoreboards\/([^/]+)\/wavelength$/);
    if (method === 'GET' && m) {
      return this._repo.getWavelengthScoreboard(m[1]);
    }

    // ── GET /resources/scoreboards/:guildId ──────────────────────────────────
    m = path.match(/^\/resources\/scoreboards\/([^/]+)$/);
    if (method === 'GET' && m) {
      return this._repo.getScoreboard(m[1]);
    }

    // ── POST /tools/log_message ───────────────────────────────────────────────
    if (method === 'POST' && path === '/tools/log_message') {
      const body = await this._readBody(req);
      const { channelId, guildId, userId, username, content } = JSON.parse(body);
      if (!channelId || !userId || !username || !content) {
        throw Object.assign(new Error('Missing required fields: channelId, userId, username, content'), { status: 400 });
      }
      this._repo.logMessage(channelId, guildId ?? null, userId, username, content);
      return { ok: true };
    }

    // ── POST /tools/update_topic_notes ────────────────────────────────────────
    if (method === 'POST' && path === '/tools/update_topic_notes') {
      const body = await this._readBody(req);
      const { guildId, userId, notes } = JSON.parse(body);
      if (!guildId || !userId || !notes) {
        throw Object.assign(new Error('Missing required fields: guildId, userId, notes'), { status: 400 });
      }
      this._repo.updateTopicNotes(guildId, userId, notes);
      return { ok: true };
    }

    // ── POST /tools/update_channel_topic_notes ────────────────────────────────
    if (method === 'POST' && path === '/tools/update_channel_topic_notes') {
      const body = await this._readBody(req);
      const { channelId, guildId, notes } = JSON.parse(body);
      if (!channelId || !notes) {
        throw Object.assign(new Error('Missing required fields: channelId, notes'), { status: 400 });
      }
      this._repo.updateChannelTopicNotes(channelId, guildId ?? null, notes);
      return { ok: true };
    }

    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end',  () => resolve(body));
      req.on('error', reject);
    });
  }
}

module.exports = McpServer;
