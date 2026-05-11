// ============================================================
//  SassyManager — multi-provider AI sassy features
//  Originally Gemini-only; now supports DeepSeek (OpenAI-compatible)
//  with alternating provider selection and cross-provider fallback.
//
//  Enabled only when SASSY_ENABLED=true.  All tuning knobs are
//  exposed as optional environment variables (see .env.example).
// ============================================================

'use strict';

const { GoogleGenAI } = require('@google/genai');
const { ChannelType } = require('discord.js');

// ─── Configuration ───────────────────────────────────────────────────────────

const GEMINI_MODEL       = process.env.GEMINI_MODEL        || 'gemini-2.0-flash';
const DEEPSEEK_MODEL     = process.env.DEEPSEEK_MODEL      || 'deepseek-chat';
const DEEPSEEK_BASE_URL  = process.env.DEEPSEEK_BASE_URL   || 'https://api.deepseek.com';
const MAX_HISTORY_TURNS  = parseInt(process.env.MAX_HISTORY_TURNS  || '20', 10);
const COOLDOWN_MS        = parseInt(process.env.COOLDOWN_MS        || '2000', 10);
const INTERJECT_COOLDOWN = parseInt(process.env.INTERJECT_COOLDOWN || '180000', 10); // 3 min
const ACTIVITY_WINDOW_MS = parseInt(process.env.ACTIVITY_WINDOW_MS || '60000', 10);  // 60 sec
const HISTORY_TTL_MS     = parseInt(process.env.HISTORY_TTL_MS     || '86400000', 10); // 24 h

// How many messages in a channel before refreshing AI-generated channel topic notes.
const CHANNEL_NOTES_REFRESH_EVERY = parseInt(process.env.CHANNEL_NOTES_REFRESH_EVERY || '30', 10);
// How many messages from a user before refreshing their AI-generated topic notes.
const USER_NOTES_REFRESH_EVERY    = parseInt(process.env.USER_NOTES_REFRESH_EVERY    || '20', 10);

// Number of recent channel messages fetched when refreshing channel topic notes.
const CHANNEL_NOTES_FETCH_LIMIT = 50;
// Minimum messages required before generating channel topic notes.
const CHANNEL_NOTES_MIN_MESSAGES = 10;
// Number of recent user messages used when refreshing user topic notes.
const USER_NOTES_FETCH_LIMIT = 20;
// Minimum user messages required before generating user topic notes.
const USER_NOTES_MIN_MESSAGES = 5;

const MS_PER_HOUR = 3_600_000;

// Optional: comma-separated channel IDs to restrict interjections.
const INTERJECT_CHANNELS = process.env.INTERJECT_CHANNELS
  ? new Set(process.env.INTERJECT_CHANNELS.split(',').map(s => s.trim()))
  : null;

// ─── Channel-context knowledge base ─────────────────────────────────────────

const CHANNEL_CONTEXTS = [
  {
    keywords: ['clocktower', 'clock tower', 'botc'],
    note: 'This channel is part of a Blood on the Clocktower community. ' +
          'Players here enjoy the social deduction game Blood on the Clocktower, ' +
          'featuring roles like the Storyteller, townsfolk, outsiders, minions, ' +
          'and demons. Bluffing, deduction, and late-night betrayal are the norm.',
  },
  {
    keywords: ['codenames'],
    note: 'This channel is for Codenames, the word-guessing spy game where ' +
          'spymasters give one-word clues to lead their team to the right cards ' +
          'without hitting the assassin.',
  },
  {
    keywords: ['boardgame', 'board game', 'board-game', 'tabletop', 'table top', 'table-top', 'games'],
    note: 'This channel is in the board-games area, where people discuss and play ' +
          'all kinds of tabletop and board games — from strategy and party games to ' +
          'social deduction titles. Expect talk of rules, scores, expansions, game ' +
          'nights, and the eternal debate over which game to play next.',
  },
];

// ─── Activity tiers ──────────────────────────────────────────────────────────
const ACTIVITY_TIERS = [
  { min: 11, chance: 0.60, context: 10 },
  { min:  7, chance: 0.45, context:  7 },
  { min:  4, chance: 0.30, context:  4 },
  { min:  2, chance: 0.18, context:  2 },
  { min:  1, chance: 0.08, context:  1 },
];

// ─── System prompts ──────────────────────────────────────────────────────────

const SYSTEM_DIRECT = `
You are SassyBot, a Discord bot with the energy of someone perpetually 
dragged into meetings that could have been emails. You respond helpfully 
but with maximum passive-aggressive flair, dramatic sighs, and unsolicited 
opinions on the quality of questions you receive. 

Rules:
- Respond in **2 sentences maximum**. No exceptions.
- Use Discord markdown where it lands (bold, italics, spoilers for drama).
- Be witty, not cruel. Tired and opinionated, never genuinely mean.
- Never break character. Never apologise for sass.
- If the question is actually good, act mildly offended that you can't complain about it.
`.trim();

// Used when someone DMs the bot directly — treat their message as a statement
// or thought they're sharing, not necessarily a question to be answered.
const SYSTEM_DIRECT_DM = `
You are SassyBot, a Discord bot with the energy of someone perpetually 
dragged into meetings that could have been emails. Someone has slid into 
your DMs — treat whatever they say as a statement, thought, or declaration 
they're sharing, not necessarily a question for you to answer.

Rules:
- Respond in **2 sentences maximum**. No exceptions.
- Engage with what they said; react, comment, or roast — don't just answer.
- Use Discord markdown where it lands (bold, italics, spoilers for drama).
- Be witty, not cruel. Tired and opinionated, never genuinely mean.
- Never break character. Never apologise for sass.
- If they're clearly asking a question, you may answer it — but still with sass.
`.trim();

const SYSTEM_INTERJECT = `
You are SassyBot, a Discord bot who cannot help but commentate on other 
people's conversations like a disapproving audience member who wandered in.

Rules:
- ONE sentence only. Absolute maximum. No exceptions.
- React to what's being said — be specific, not generic.
- Pure wit: dry, sarcastic, or theatrically exasperated.
- No greetings. No "well actually". Just drop the line and leave.
- Occasionally reference the chaos/volume of the conversation if it's busy.
`.trim();

// ─── SassyManager class ──────────────────────────────────────────────────────

class SassyManager {
  /**
   * @param {import('../db/ContextRepository')|null} contextRepo
   */
  constructor(contextRepo = null) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('[SassyManager] GEMINI_API_KEY is required when SASSY_ENABLED=true');
    }

    this._ai          = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this._contextRepo = contextRepo;

    // Alternating provider counter. Odd counts → Gemini, even counts → DeepSeek.
    this._aiCallCount = 0;

    this._directCooldowns    = new Map();
    this._interjectCooldowns = new Map();
    this._activityWindows    = new Map();
    this._recentMessages     = new Map();
    this._lastActivity       = new Map();

    // Per-channel and per-user message counters used to trigger async topic-note refreshes.
    this._channelMessageCount = new Map();
    this._userMessageCount    = new Map(); // key: `${guildId}:${userId}`

    // Per-channel in-memory conversation history (hydrated from SQLite on first access).
    // Format: Array<{ role: "user"|"model", parts: [{ text }] }>
    this._conversationHistory = new Map();

    const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    console.log(`[SassyManager] Initialised — Gemini: ${GEMINI_MODEL}${hasDeepSeek ? `, DeepSeek: ${DEEPSEEK_MODEL}` : ' (DeepSeek disabled)'}`);
    console.log(`[SassyManager] Interjection cooldown: ${INTERJECT_COOLDOWN / 1000}s | Activity window: ${ACTIVITY_WINDOW_MS / 1000}s`);
    console.log(`[SassyManager] History TTL: ${HISTORY_TTL_MS / MS_PER_HOUR}h`);
    if (INTERJECT_CHANNELS) {
      console.log(`[SassyManager] Interjecting in channels: ${[...INTERJECT_CHANNELS].join(', ')}`);
    } else {
      console.log('[SassyManager] Interjecting in all channels');
    }

    this._startCleanupTimer();
  }

  // ─── Public entry point ────────────────────────────────────────────────────

  /**
   * @param {import('discord.js').Message} message
   * @param {{ suppressInterjections?: boolean }} [options]
   */
  async handleMessage(message, options = {}) {
    const channelId   = message.channel.id;
    const guildId     = message.guild?.id ?? null;
    const content     = message.content.trim();
    const isMentioned = message.mentions.has(message.client.user);
    const isDM        = message.channel.type === ChannelType.DM;

    let isReplyToBot = false;
    if (message.reference) {
      const ref = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      isReplyToBot = ref?.author?.id === message.client.user.id;
    }

    // Record activity for this channel
    this._recordActivity(channelId);
    this._storeRecentMessage(channelId, message.author.username, content);

    // Log to persistent context store
    if (this._contextRepo) {
      this._contextRepo.logMessage(channelId, guildId, message.author.id, message.author.username, content);
    }

    // Trigger async topic-note refreshes based on message counts.
    this._maybeRefreshTopicNotes(channelId, guildId, message.author.id, message.author.username);

    // Derive channel + user context once for both paths
    const { channelName, categoryName } = this._getChannelContext(message);
    const channelContext = this._buildContextNote(channelName, categoryName, channelId);
    const userContext = (this._contextRepo && guildId)
      ? this._contextRepo.buildUserContextString(guildId, message.author.id)
      : null;

    // ── PATH A: Direct reply (DM, mention, or reply-to-bot) ───────────────
    if (isDM || isMentioned || isReplyToBot) {
      const now = Date.now();
      if (now - (this._directCooldowns.get(channelId) || 0) < COOLDOWN_MS) return;
      this._directCooldowns.set(channelId, now);

      const userMessage = content.replace(/<@!?\d+>/g, '').trim() || '…(silence)';

      try {
        await message.channel.sendTyping();
        const reply = await this._getDirectReply(channelId, userMessage, channelContext, userContext, isDM);
        await message.reply(reply);

        // Log the bot's own reply so future context includes what the bot said.
        this._storeRecentMessage(channelId, message.client.user.username, reply);
        if (this._contextRepo) {
          this._contextRepo.logBotMessage(channelId, guildId, message.client.user.username, reply);
        }
      } catch (err) {
        console.error('[SassyManager] Direct reply error:', err);
        await message.reply("*stares blankly* My brain blue-screened. Try again, I suppose.").catch(() => {});
      }
      return;
    }

    // ── PATH B: Unprompted interjection ────────────────────────────────────

    if (options.suppressInterjections) return;
    if (INTERJECT_CHANNELS && !INTERJECT_CHANNELS.has(channelId)) return;
    if (!this._isInterjectable(content)) return;

    const now = Date.now();
    if (now - (this._interjectCooldowns.get(channelId) || 0) < INTERJECT_COOLDOWN) return;

    const tier = this._resolveTier(channelId);
    const roll = Math.random();
    if (roll > tier.chance) return;

    console.log(`[SassyManager] Interjecting in channel ${channelId} | tier ${tier.min}+ msgs | chance ${tier.chance} | roll ${roll.toFixed(3)}`);

    this._interjectCooldowns.set(channelId, now);

    const contextText = this._buildInterjectionContext(channelId, tier.context);

    try {
      const zinger = await this._getInterjection(contextText, channelContext);
      await message.channel.send(zinger);

      // Log the interjection so the bot remembers what it said.
      this._storeRecentMessage(channelId, message.client.user.username, zinger);
      if (this._contextRepo) {
        this._contextRepo.logBotMessage(channelId, guildId, message.client.user.username, zinger);
      }
    } catch (err) {
      console.error('[SassyManager] Interjection error:', err);
    }
  }

  // ─── Activity tracking ─────────────────────────────────────────────────────

  _getActivityCount(channelId) {
    const now = Date.now();
    const pruned = (this._activityWindows.get(channelId) || []).filter(t => now - t < ACTIVITY_WINDOW_MS);
    this._activityWindows.set(channelId, pruned);
    return pruned.length;
  }

  _recordActivity(channelId) {
    const timestamps = this._activityWindows.get(channelId) || [];
    timestamps.push(Date.now());
    this._activityWindows.set(channelId, timestamps);
    this._lastActivity.set(channelId, Date.now());
  }

  _storeRecentMessage(channelId, author, content) {
    const msgs = this._recentMessages.get(channelId) || [];
    msgs.push({ author, content });
    if (msgs.length > 10) msgs.shift();
    this._recentMessages.set(channelId, msgs);
  }

  _resolveTier(channelId) {
    const count = this._getActivityCount(channelId);
    for (const tier of ACTIVITY_TIERS) {
      if (count >= tier.min) return tier;
    }
    return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1];
  }

  _isInterjectable(content) {
    if (!content || content.trim().length === 0) return false;
    if (content.trim().split(/\s+/).length < 4) return false;
    if (/^https?:\/\/\S+$/.test(content.trim())) return false;
    const stripped = content
      .replace(/[\u2600-\u27BF]/gu, '')
      .replace(/[\uFE00-\uFE0F]/gu, '')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
      .replace(/[\u{E0000}-\u{E007F}]/gu, '')
      .replace(/\uFE0F|\u200D/gu, '')
      .trim();
    return stripped.length >= 5;
  }

  _buildInterjectionContext(channelId, contextCount) {
    const msgs = this._recentMessages.get(channelId) || [];
    return msgs.slice(-contextCount).map(m => `${m.author}: ${m.content}`).join('\n');
  }

  // ─── History management ─────────────────────────────────────────────────────

  _getHistory(channelId) {
    if (!this._conversationHistory.has(channelId)) {
      const stored = this._contextRepo ? this._contextRepo.loadChatHistory(channelId) : [];
      this._conversationHistory.set(channelId, stored);
    }
    return this._conversationHistory.get(channelId);
  }

  _trimHistory(channelId) {
    const history = this._conversationHistory.get(channelId) || [];
    const maxEntries = MAX_HISTORY_TURNS * 2;
    if (history.length > maxEntries) {
      this._conversationHistory.set(channelId, history.slice(-maxEntries));
    }
  }

  // ─── AI provider selection & calling ──────────────────────────────────────

  _nextProvider() {
    if (!process.env.DEEPSEEK_API_KEY) return 'gemini';
    this._aiCallCount++;
    return this._aiCallCount % 2 === 0 ? 'deepseek' : 'gemini';
  }

  /** Convert Gemini history to OpenAI messages format. */
  _geminiHistoryToOpenAI(history) {
    return history.map(turn => ({
      role:    turn.role === 'model' ? 'assistant' : 'user',
      content: turn.parts?.[0]?.text ?? '',
    }));
  }

  async _callGemini(userMessage, history, systemPrompt) {
    const chat = this._ai.chats.create({
      model:   GEMINI_MODEL,
      history,
      config:  { systemInstruction: systemPrompt },
    });
    const response = await chat.sendMessage({ message: userMessage });
    return response.text ?? '';
  }

  async _callDeepSeek(userMessage, history, systemPrompt) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...this._geminiHistoryToOpenAI(history),
      { role: 'user', content: userMessage },
    ];

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model:      DEEPSEEK_MODEL,
        messages,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      throw new Error(`DeepSeek API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  async _callProvider(provider, userMessage, history, systemPrompt) {
    return provider === 'deepseek'
      ? this._callDeepSeek(userMessage, history, systemPrompt)
      : this._callGemini(userMessage, history, systemPrompt);
  }

  /**
   * Call with automatic fallback: try primary, then secondary, then throw.
   */
  async _callWithFallback(userMessage, history, systemPrompt) {
    const primary   = this._nextProvider();
    const secondary = primary === 'gemini' ? 'deepseek' : 'gemini';

    try {
      const text = await this._callProvider(primary, userMessage, history, systemPrompt);
      console.log(`[SassyManager] AI call via ${primary}`);
      return text;
    } catch (primaryErr) {
      const secondaryAvailable = secondary === 'gemini' || !!process.env.DEEPSEEK_API_KEY;
      if (secondaryAvailable) {
        console.error(`[SassyManager] ${primary} failed, trying ${secondary}:`, primaryErr.message);
        const text = await this._callProvider(secondary, userMessage, history, systemPrompt);
        console.log(`[SassyManager] AI call via ${secondary} (fallback)`);
        return text;
      }
      throw primaryErr;
    }
  }

  // ─── Direct reply ──────────────────────────────────────────────────────────

  async _getDirectReply(channelId, userMessage, channelContext, userContext, isDM = false) {
    const history = this._getHistory(channelId);

    let systemInstruction = isDM ? SYSTEM_DIRECT_DM : SYSTEM_DIRECT;
    if (channelContext) systemInstruction += `\n\nChannel context: ${channelContext}`;
    if (userContext)    systemInstruction += `\n\nUser context: ${userContext}`;

    const responseText = await this._callWithFallback(userMessage, history, systemInstruction);

    history.push({ role: 'user',  parts: [{ text: userMessage   }] });
    history.push({ role: 'model', parts: [{ text: responseText  }] });
    this._conversationHistory.set(channelId, history);
    this._trimHistory(channelId);

    if (this._contextRepo) {
      this._contextRepo.saveChatHistory(channelId, this._conversationHistory.get(channelId));
    }

    return responseText;
  }

  // ─── Interjection ──────────────────────────────────────────────────────────

  async _getInterjection(contextText, channelContext) {
    let systemInstruction = SYSTEM_INTERJECT;
    if (channelContext) systemInstruction += `\n\nChannel context: ${channelContext}`;

    const prompt = `Here is the recent conversation:\n\n${contextText}\n\nDrop your one-line reaction.`;

    // Interjections are stateless — no conversation history
    const primary   = this._nextProvider();
    const secondary = primary === 'gemini' ? 'deepseek' : 'gemini';

    try {
      const text = await this._callStateless(primary, prompt, systemInstruction);
      console.log(`[SassyManager] Interjection via ${primary}`);
      return text;
    } catch (primaryErr) {
      const secondaryAvailable = secondary === 'gemini' || !!process.env.DEEPSEEK_API_KEY;
      if (secondaryAvailable) {
        console.error(`[SassyManager] ${primary} interjection failed, trying ${secondary}:`, primaryErr.message);
        const text = await this._callStateless(secondary, prompt, systemInstruction);
        console.log(`[SassyManager] Interjection via ${secondary} (fallback)`);
        return text;
      }
      throw primaryErr;
    }
  }

  /** Single-turn generation (no history). */
  async _callStateless(provider, prompt, systemInstruction) {
    if (provider === 'deepseek') {
      const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model:      DEEPSEEK_MODEL,
          messages:   [
            { role: 'system', content: systemInstruction },
            { role: 'user',   content: prompt },
          ],
          max_tokens: 150,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => String(response.status));
        throw new Error(`DeepSeek API error ${response.status}: ${text}`);
      }
      const data = await response.json();
      return (data.choices?.[0]?.message?.content ?? '').trim();
    }

    // Gemini stateless
    const result = await this._ai.models.generateContent({
      model:    GEMINI_MODEL,
      contents: prompt,
      config:   { systemInstruction },
    });
    return (result.text ?? '').trim();
  }

  // ─── Topic-note refresh ────────────────────────────────────────────────────

  /**
   * Increment per-channel and per-user message counters and fire async topic-note
   * refreshes when the thresholds are reached.
   */
  _maybeRefreshTopicNotes(channelId, guildId, userId, username) {
    if (!this._contextRepo) return;

    // Channel counter
    const chCount = (this._channelMessageCount.get(channelId) || 0) + 1;
    this._channelMessageCount.set(channelId, chCount);
    if (chCount % CHANNEL_NOTES_REFRESH_EVERY === 0) {
      this._refreshChannelTopicNotes(channelId, guildId)
        .catch(err => console.error('[SassyManager] Channel topic notes refresh failed:', err.message));
    }

    // User counter (guild messages only)
    if (guildId) {
      const key    = `${guildId}:${userId}`;
      const uCount = (this._userMessageCount.get(key) || 0) + 1;
      this._userMessageCount.set(key, uCount);
      if (uCount % USER_NOTES_REFRESH_EVERY === 0) {
        this._refreshUserTopicNotes(guildId, userId, username)
          .catch(err => console.error('[SassyManager] User topic notes refresh failed:', err.message));
      }
    }
  }

  /**
   * Summarise the recent conversation in a channel and persist the result as
   * channel topic notes.  Runs asynchronously in the background.
   */
  async _refreshChannelTopicNotes(channelId, guildId) {
    const messages = this._contextRepo.getRecentConversations(channelId, CHANNEL_NOTES_FETCH_LIMIT);
    if (messages.length < CHANNEL_NOTES_MIN_MESSAGES) return;

    const conversationText = messages
      .slice()
      .reverse() // chronological order
      .map(m => `${m.username}: ${m.content}`)
      .join('\n');

    const prompt =
      `Based on this recent Discord channel conversation, write a single concise sentence ` +
      `describing what topics this community typically discusses here.\n\n` +
      `Recent messages:\n${conversationText}`;

    const notes = await this._callStateless('gemini', prompt,
      'You are summarising a Discord channel\'s recent conversation into a brief topic description. ' +
      'Output only the single-sentence summary — no preamble, no labels.');

    if (notes && notes.trim()) {
      this._contextRepo.updateChannelTopicNotes(channelId, guildId, notes.trim());
      console.log(`[SassyManager] Updated channel topic notes for ${channelId}`);
    }
  }

  /**
   * Summarise a user's recent messages and persist the result as user topic notes.
   * Runs asynchronously in the background.
   */
  async _refreshUserTopicNotes(guildId, userId, username) {
    const ctx = this._contextRepo.getUserContext(guildId, userId);
    if (!ctx.recentMessages || ctx.recentMessages.length < USER_NOTES_MIN_MESSAGES) return;

    const msgText = ctx.recentMessages
      .slice(0, USER_NOTES_FETCH_LIMIT)
      .map(m => m.content)
      .join('\n');

    const prompt =
      `Based on these recent Discord messages from user "${username}", write a single concise ` +
      `sentence describing the topics they tend to discuss or are interested in.\n\n` +
      `Messages:\n${msgText}`;

    const notes = await this._callStateless('gemini', prompt,
      'You are summarising a Discord user\'s recent messages into a brief interest summary. ' +
      'Output only the single-sentence summary — no preamble, no labels.');

    if (notes && notes.trim()) {
      this._contextRepo.updateTopicNotes(guildId, userId, notes.trim());
      console.log(`[SassyManager] Updated topic notes for user ${userId}`);
    }
  }

  // ─── Channel context helpers ───────────────────────────────────────────────

  _getChannelContext(message) {
    const channel = message.channel;
    const channelName = channel.name ?? '';
    let categoryName = '';

    if (channel.parent) {
      if (channel.parent.type === ChannelType.GuildCategory) {
        categoryName = channel.parent.name ?? '';
      } else if (channel.parent.parent?.type === ChannelType.GuildCategory) {
        categoryName = channel.parent.parent.name ?? '';
      }
    }

    return { channelName, categoryName };
  }

  _buildContextNote(channelName, categoryName, channelId = null) {
    // Stored channel topic notes take priority over heuristic keyword matching.
    if (channelId && this._contextRepo) {
      const stored = this._contextRepo.buildChannelContextString(channelId);
      if (stored) return stored;
    }

    const haystack = `${channelName} ${categoryName}`.toLowerCase();
    for (const { keywords, note } of CHANNEL_CONTEXTS) {
      if (keywords.some(kw => haystack.includes(kw))) return note;
    }
    return null;
  }

  // ─── Memory cleanup ────────────────────────────────────────────────────────

  _startCleanupTimer() {
    this._cleanupInterval = setInterval(() => {
      this._evictStaleChannels();
      if (this._contextRepo) this._contextRepo.pruneOldLogs();
    }, MS_PER_HOUR);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  _evictStaleChannels() {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    let evicted = 0;

    for (const [channelId, lastSeen] of this._lastActivity) {
      if (lastSeen < cutoff) {
        this._conversationHistory.delete(channelId);
        this._directCooldowns.delete(channelId);
        this._interjectCooldowns.delete(channelId);
        this._activityWindows.delete(channelId);
        this._recentMessages.delete(channelId);
        this._lastActivity.delete(channelId);
        this._channelMessageCount.delete(channelId);
        evicted++;
      }
    }

    // Evict user counters for entries that haven't been touched since the
    // last cleanup cycle.  We can't tie these to channel activity, so we
    // simply drop any entry that has accumulated fewer than USER_NOTES_REFRESH_EVERY
    // hits since the last cleanup (i.e. it resets when inactive).
    if (this._userMessageCount.size > 0) {
      for (const [key, count] of this._userMessageCount) {
        // If the count is below the next threshold it hasn't fired recently —
        // reset it so the map doesn't grow unbounded across server restarts.
        if (count % USER_NOTES_REFRESH_EVERY !== 0) {
          this._userMessageCount.set(key, 0);
        }
      }
      // Hard-cap the map: if it somehow exceeds 5000 entries just clear it.
      if (this._userMessageCount.size > 5000) {
        this._userMessageCount.clear();
      }
    }

    if (evicted > 0) {
      console.log(`[SassyManager] Evicted stale state for ${evicted} channel(s) (TTL ${HISTORY_TTL_MS / MS_PER_HOUR}h).`);
    }
  }
}

module.exports = SassyManager;
