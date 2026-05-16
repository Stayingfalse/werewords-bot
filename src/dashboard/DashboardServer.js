'use strict';

// ============================================================
//  DashboardServer — admin dashboard for potato-game-bot.
//
//  Uses Discord OAuth2 (identify + guilds scopes) for auth.
//  All network calls use Node built-in modules only (http/https/crypto).
//
//  Routes
//  ──────
//  GET  /dashboard                         → redirect to login or guild list
//  GET  /dashboard/login                   → initiate Discord OAuth2
//  GET  /dashboard/callback                → OAuth2 callback, set session cookie
//  POST /dashboard/logout                  → clear session, redirect to login
//  GET  /dashboard/guild/:guildId          → guild settings page
//  GET  /dashboard/api/guilds              → JSON list of manageable guilds
//  GET  /dashboard/api/guilds/:guildId     → JSON feature settings for a guild
//  POST /dashboard/api/guilds/:guildId/features  → update a feature setting
//
//  Static HTML
//  ───────────
//  GET  /dashboard/static/login.html
//  GET  /dashboard/static/dashboard.html
//  GET  /dashboard/static/guild.html
// ============================================================

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const settingsRepo = require('./SettingsRepository');

// ── Constants ─────────────────────────────────────────────────────────────────

const DISCORD_API      = 'https://discord.com/api/v10';
const SESSION_TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours
const MANAGE_GUILD_BIT = 0x20n; // BigInt for safe 53-bit overflow handling
const HTML_DIR         = path.join(__dirname, 'html');

// Known bot features shown in the guild settings UI.
const FEATURES = [
  { id: 'werewords',    label: 'Werewords',    hasChannels: true  },
  { id: 'wavelength',   label: 'Wavelength',   hasChannels: true  },
  { id: 'cheesethief',  label: 'Cheese Thief', hasChannels: true  },
  { id: 'herdmentality',label: 'Herd Mentality',hasChannels: true },
  { id: 'birthday',     label: 'Birthdays',    hasChannels: true  },
  { id: 'sassy',        label: 'SassyBot',     hasChannels: true  },
];

class DashboardServer {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db          - shared SQLite DB (unused directly, kept for future use)
   * @param {import('discord.js').Client}       opts.client      - discord.js client
   * @param {number|string}                     [opts.port=3200]
   */
  constructor({ db, client, port = 3200 }) {
    this._client  = client;
    this._port    = parseInt(port, 10);
    this._server  = null;

    // In-memory session store: token → { userId, username, guilds, expiresAt }
    this._sessions = new Map();

    // Resolve config from env
    this._clientId     = process.env.CLIENT_ID     || '';
    this._clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
    this._baseUrl      = (process.env.DASHBOARD_URL || `http://localhost:${this._port}`).replace(/\/$/, '');
    this._redirectUri  = `${this._baseUrl}/dashboard/callback`;

    const superAdminRaw = process.env.SUPER_ADMIN_IDS || '';
    this._superAdminIds = new Set(superAdminRaw.split(',').map(s => s.trim()).filter(Boolean));

    // Session secret used for CSRF state param
    if (process.env.DASHBOARD_SESSION_SECRET) {
      this._sessionSecret = process.env.DASHBOARD_SESSION_SECRET;
    } else {
      this._sessionSecret = crypto.randomBytes(32).toString('hex');
      console.warn(
        '[Dashboard] DASHBOARD_SESSION_SECRET is not set — using a random secret. ' +
        'All sessions will be invalidated on restart. Set this env var for persistent sessions.',
      );
    }

    // Prune expired sessions every hour
    setInterval(() => this._pruneSessions(), 60 * 60 * 1000);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this._server = http.createServer((req, res) => {
      this._dispatch(req, res).catch((err) => {
        console.error('[Dashboard] Unhandled error:', err);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal server error');
        }
      });
    });

    this._server.listen(this._port, () => {
      console.log(`[Dashboard] Admin dashboard listening on port ${this._port}`);
      console.log(`[Dashboard] URL: ${this._baseUrl}/dashboard`);
    });

    this._server.on('error', (err) => {
      console.error('[Dashboard] Server error:', err);
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  // ── Request dispatcher ─────────────────────────────────────────────────────

  async _dispatch(req, res) {
    const url    = new URL(req.url, `http://localhost:${this._port}`);
    const method = req.method.toUpperCase();
    const p      = url.pathname.replace(/\/$/, '') || '/';

    // Only handle /dashboard paths
    if (!p.startsWith('/dashboard')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    try {
      await this._route(method, p, url, req, res);
    } catch (err) {
      if (err.status === 401) {
        this._redirect(res, '/dashboard/login');
      } else if (err.status === 403) {
        this._sendJson(res, 403, { error: 'Forbidden' });
      } else if (err.status === 400) {
        this._sendJson(res, 400, { error: err.message });
      } else {
        throw err;
      }
    }
  }

  async _route(method, p, url, req, res) {
    // ── Static HTML files ──────────────────────────────────────────────────
    const staticMatch = p.match(/^\/dashboard\/static\/(.+\.html)$/);
    if (method === 'GET' && staticMatch) {
      return this._serveHtml(res, staticMatch[1]);
    }

    // ── GET /dashboard ─────────────────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard') {
      const session = this._getSession(req);
      if (!session) return this._redirect(res, '/dashboard/login');
      return this._redirect(res, '/dashboard/static/dashboard.html');
    }

    // ── GET /dashboard/login ───────────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/login') {
      const session = this._getSession(req);
      if (session) return this._redirect(res, '/dashboard/static/dashboard.html');
      return this._serveHtml(res, 'login.html');
    }

    // ── GET /dashboard/oauth ───────────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/oauth') {
      const state = crypto.randomBytes(16).toString('hex');
      const oauthUrl =
        `https://discord.com/api/oauth2/authorize` +
        `?client_id=${encodeURIComponent(this._clientId)}` +
        `&redirect_uri=${encodeURIComponent(this._redirectUri)}` +
        `&response_type=code` +
        `&scope=identify%20guilds` +
        `&state=${state}`;
      // Store state in a short-lived cookie for CSRF protection
      res.setHeader('Set-Cookie', `dash_state=${state}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=300`);
      return this._redirect(res, oauthUrl);
    }

    // ── GET /dashboard/callback ────────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/callback') {
      return this._handleCallback(req, res, url);
    }

    // ── POST /dashboard/logout ─────────────────────────────────────────────
    if (method === 'POST' && p === '/dashboard/logout') {
      const token = this._getSessionToken(req);
      if (token) this._sessions.delete(token);
      res.setHeader('Set-Cookie', 'dash_session=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0');
      return this._redirect(res, '/dashboard/login');
    }

    // ── GET /dashboard/guild/:guildId ──────────────────────────────────────
    const guildPageMatch = p.match(/^\/dashboard\/guild\/([^/]+)$/);
    if (method === 'GET' && guildPageMatch) {
      const session = this._requireSession(req);
      await this._assertGuildAccess(session, guildPageMatch[1]);
      return this._serveHtml(res, 'guild.html');
    }

    // ── GET /dashboard/api/guilds ──────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/api/guilds') {
      const session = this._requireSession(req);
      const guilds  = await this._getAccessibleGuilds(session);
      return this._sendJson(res, 200, guilds);
    }

    // ── GET /dashboard/api/guilds/:guildId ─────────────────────────────────
    const guildApiMatch = p.match(/^\/dashboard\/api\/guilds\/([^/]+)$/);
    if (method === 'GET' && guildApiMatch) {
      const session = this._requireSession(req);
      const guildId = guildApiMatch[1];
      await this._assertGuildAccess(session, guildId);
      const settings = settingsRepo.getGuildSettings(guildId);
      // Merge with defaults so every known feature is always present
      const merged = this._mergeDefaults(settings);
      return this._sendJson(res, 200, { guildId, features: merged });
    }

    // ── POST /dashboard/api/guilds/:guildId/features ───────────────────────
    const featApiMatch = p.match(/^\/dashboard\/api\/guilds\/([^/]+)\/features$/);
    if (method === 'POST' && featApiMatch) {
      const session = this._requireSession(req);
      const guildId = featApiMatch[1];
      await this._assertGuildAccess(session, guildId);
      const body    = await this._readBody(req);
      const { feature, enabled, channelIds } = JSON.parse(body);
      if (!feature) throw Object.assign(new Error('Missing required field: feature'), { status: 400 });
      if (!FEATURES.find(f => f.id === feature)) {
        throw Object.assign(new Error(`Unknown feature: ${feature}`), { status: 400 });
      }
      settingsRepo.setFeature(
        guildId,
        feature,
        enabled !== false,
        Array.isArray(channelIds) ? channelIds : null,
        null,
      );
      return this._sendJson(res, 200, { ok: true });
    }

    // ── GET /dashboard/api/features ────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/api/features') {
      return this._sendJson(res, 200, FEATURES);
    }

    // ── GET /dashboard/api/me ──────────────────────────────────────────────
    if (method === 'GET' && p === '/dashboard/api/me') {
      const session = this._requireSession(req);
      return this._sendJson(res, 200, {
        userId:        session.userId,
        username:      session.username,
        isSuperAdmin:  this._isSuperAdmin(session.userId),
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  // ── OAuth callback ─────────────────────────────────────────────────────────

  async _handleCallback(req, res, url) {
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing code parameter');
      return;
    }

    // Validate CSRF state
    const cookieState = this._parseCookie(req, 'dash_state');
    if (cookieState && state && cookieState !== state) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Invalid OAuth state — possible CSRF attempt');
      return;
    }

    // Exchange code for access token
    const tokenData = await this._discordTokenExchange(code);
    if (!tokenData.access_token) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to exchange OAuth code');
      return;
    }

    // Fetch user identity and guilds in parallel
    const [user, userGuilds] = await Promise.all([
      this._discordGet('/users/@me', tokenData.access_token),
      this._discordGet('/users/@me/guilds', tokenData.access_token),
    ]);

    if (!user.id) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to fetch Discord user');
      return;
    }

    // Create session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    this._sessions.set(sessionToken, {
      userId:    user.id,
      username:  user.username,
      guilds:    Array.isArray(userGuilds) ? userGuilds : [],
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    res.setHeader('Set-Cookie', [
      `dash_session=${sessionToken}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
      `dash_state=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    this._redirect(res, '/dashboard/static/dashboard.html');
  }

  // ── Session helpers ────────────────────────────────────────────────────────

  _getSessionToken(req) {
    return this._parseCookie(req, 'dash_session') || null;
  }

  _getSession(req) {
    const token = this._getSessionToken(req);
    if (!token) return null;
    const session = this._sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this._sessions.delete(token);
      return null;
    }
    return session;
  }

  _requireSession(req) {
    const session = this._getSession(req);
    if (!session) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    return session;
  }

  _pruneSessions() {
    const now = Date.now();
    for (const [token, session] of this._sessions) {
      if (now > session.expiresAt) this._sessions.delete(token);
    }
  }

  // ── Permission helpers ─────────────────────────────────────────────────────

  _isSuperAdmin(userId) {
    return this._superAdminIds.has(userId);
  }

  /**
   * Returns the guilds that this session's user may manage.
   * Super-admins see every guild the bot is currently serving plus every guild
   * that has a row in guild_settings.
   */
  async _getAccessibleGuilds(session) {
    if (this._isSuperAdmin(session.userId)) {
      // Combine bot guilds + guilds with existing settings
      const botGuildIds    = new Set(this._client.guilds.cache.keys());
      const settingsGuildIds = new Set(settingsRepo.getAllGuilds());
      const allIds = new Set([...botGuildIds, ...settingsGuildIds]);

      return [...allIds].map(id => {
        const discordGuild = this._client.guilds.cache.get(id);
        // Try to find name from user's own guild list too
        const userGuild = session.guilds.find(g => g.id === id);
        return {
          id,
          name: discordGuild?.name ?? userGuild?.name ?? id,
          icon: discordGuild?.icon ?? userGuild?.icon ?? null,
        };
      });
    }

    // Regular user: only guilds where they have Manage Guild permission
    return session.guilds
      .filter(g => {
        const perms = BigInt(g.permissions || 0);
        return (perms & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT;
      })
      .filter(g => this._client.guilds.cache.has(g.id))
      .map(g => ({ id: g.id, name: g.name, icon: g.icon ?? null }));
  }

  async _assertGuildAccess(session, guildId) {
    if (this._isSuperAdmin(session.userId)) return;
    const accessible = await this._getAccessibleGuilds(session);
    if (!accessible.find(g => g.id === guildId)) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
  }

  // ── Feature defaults ───────────────────────────────────────────────────────

  _mergeDefaults(stored) {
    const result = {};
    for (const feat of FEATURES) {
      result[feat.id] = stored[feat.id] ?? { enabled: true, channelIds: null, extra: null };
    }
    return result;
  }

  // ── Discord API helpers ────────────────────────────────────────────────────

  _discordTokenExchange(code) {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        client_id:     this._clientId,
        client_secret: this._clientSecret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  this._redirectUri,
      }).toString();

      const options = {
        hostname: 'discord.com',
        path:     '/api/v10/oauth2/token',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end',  () => {
          try { resolve(JSON.parse(data)); }
          catch (err) {
            console.error('[Dashboard] Failed to parse Discord token response:', err.message);
            resolve({});
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _discordGet(endpoint, accessToken) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'discord.com',
        path:     `/api/v10${endpoint}`,
        method:   'GET',
        headers:  { Authorization: `Bearer ${accessToken}` },
      };

      const req = https.request(options, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end',  () => {
          try { resolve(JSON.parse(data)); }
          catch (err) {
            console.error(`[Dashboard] Failed to parse Discord API response for ${endpoint}:`, err.message);
            resolve({});
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  _redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
  }

  _sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _serveHtml(res, filename) {
    const filePath = path.join(HTML_DIR, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end',  () => resolve(body));
      req.on('error', reject);
    });
  }

  _parseCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k.trim() === name) return v.join('=').trim();
    }
    return null;
  }
}

module.exports = DashboardServer;
