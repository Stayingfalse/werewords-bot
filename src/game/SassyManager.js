// ============================================================
//  SassyManager — Gemini-powered sassy AI features
//  Ported from SassyBot (https://github.com/Stayingfalse/SassyBot)
//
//  Enabled only when SASSY_ENABLED=true.  All tuning knobs are
//  exposed as optional environment variables (see .env.example).
// ============================================================

'use strict';

const { GoogleGenAI } = require('@google/genai');
const { ChannelType } = require('discord.js');

// ─── Configuration ───────────────────────────────────────────────────────────

const GEMINI_MODEL       = process.env.GEMINI_MODEL        || 'gemini-2.0-flash';
const MAX_HISTORY_TURNS  = parseInt(process.env.MAX_HISTORY_TURNS  || '20', 10);
const COOLDOWN_MS        = parseInt(process.env.COOLDOWN_MS        || '2000', 10);
const INTERJECT_COOLDOWN = parseInt(process.env.INTERJECT_COOLDOWN || '180000', 10); // 3 min
const ACTIVITY_WINDOW_MS = parseInt(process.env.ACTIVITY_WINDOW_MS || '60000', 10);  // 60 sec
const HISTORY_TTL_MS     = parseInt(process.env.HISTORY_TTL_MS     || '86400000', 10); // 24 h

const MS_PER_HOUR = 3_600_000;

// Optional: comma-separated channel IDs to restrict interjections.
// Leave unset to allow interjections everywhere.
const INTERJECT_CHANNELS = process.env.INTERJECT_CHANNELS
  ? new Set(process.env.INTERJECT_CHANNELS.split(',').map(s => s.trim()))
  : null;

// ─── Channel-context knowledge base ─────────────────────────────────────────
// Maps lowercase keywords found in a channel's category or channel name to a
// descriptive sentence that is injected into the Gemini system prompt so the
// AI can make contextually relevant comments.

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
    keywords: ['boardgame', 'board game', 'board-game', 'werewords', 'wavelength'],
    note: 'This channel is in the board-games area. Games played here include ' +
          'Werewords (a social deduction word game with Mayor, Werewolf, Seer, ' +
          'and Villager roles where the village must guess the secret word before ' +
          'time runs out), Wavelength (a psychic party game of clues and spectrums), ' +
          'and other tabletop favourites.',
  },
];

// ─── Activity tiers ──────────────────────────────────────────────────────────
// Each tier: { min (messages in window), chance (0-1), context (messages fed to AI) }
const ACTIVITY_TIERS = [
  { min: 11, chance: 0.60, context: 10 }, // chaos
  { min:  7, chance: 0.45, context:  7 }, // busy
  { min:  4, chance: 0.30, context:  4 }, // active
  { min:  2, chance: 0.18, context:  2 }, // light
  { min:  1, chance: 0.08, context:  1 }, // quiet
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
  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('[SassyManager] GEMINI_API_KEY is required when SASSY_ENABLED=true');
    }

    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this._ai = genAI;

    // Per-channel conversation history for direct replies
    // Map<channelId, Array<{ role: "user"|"model", parts: [{ text }] }>>
    this._conversationHistory = new Map();

    // Per-channel cooldown for direct replies (anti-spam)
    this._directCooldowns = new Map();

    // Per-channel cooldown for interjections
    this._interjectCooldowns = new Map();

    // Per-channel rolling message timestamps for activity tracking
    this._activityWindows = new Map();

    // Per-channel recent messages for interjection context
    this._recentMessages = new Map();

    // Per-channel last activity timestamp (used by cleanup)
    this._lastActivity = new Map();

    console.log(`[SassyManager] Initialised — model: ${GEMINI_MODEL}`);
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
   * Called for every non-bot guild message.
   * @param {import('discord.js').Message} message
   * @param {{ suppressInterjections?: boolean }} [options]
   */
  async handleMessage(message, options = {}) {
    const channelId   = message.channel.id;
    const content     = message.content.trim();
    const isMentioned = message.mentions.has(message.client.user);

    let isReplyToBot = false;
    if (message.reference) {
      const ref = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      isReplyToBot = ref?.author?.id === message.client.user.id;
    }

    // Record activity and context for every human message
    this._recordActivity(channelId);
    this._storeRecentMessage(channelId, message.author.username, content);

    // Derive channel context once for both paths
    const { channelName, categoryName } = this._getChannelContext(message);
    const channelContext = this._buildContextNote(channelName, categoryName);

    // ── PATH A: Direct reply (mention or reply-to-bot) ─────────────────────
    if (isMentioned || isReplyToBot) {
      const now = Date.now();
      if (now - (this._directCooldowns.get(channelId) || 0) < COOLDOWN_MS) return;
      this._directCooldowns.set(channelId, now);

      const userMessage = content.replace(/<@!?\d+>/g, '').trim() || '…(silence)';

      try {
        await message.channel.sendTyping();
        const reply = await this._getDirectReply(channelId, userMessage, channelContext);
        await message.reply(reply);
      } catch (err) {
        console.error('[SassyManager] Direct reply error:', err);
        await message.reply("*stares blankly* My brain blue-screened. Try again, I suppose.").catch(() => {});
      }
      return; // Don't also try to interject on the same message
    }

    // ── PATH B: Unprompted interjection ────────────────────────────────────

    // Skip if Sassy has been asked to stand down (e.g. active game thread)
    if (options.suppressInterjections) return;

    // Channel allow-list (if configured)
    if (INTERJECT_CHANNELS && !INTERJECT_CHANNELS.has(channelId)) return;

    // Message quality gate
    if (!this._isInterjectable(content)) return;

    // Per-channel interjection cooldown
    const now = Date.now();
    if (now - (this._interjectCooldowns.get(channelId) || 0) < INTERJECT_COOLDOWN) return;

    // Resolve activity tier and roll the dice
    const tier = this._resolveTier(channelId);
    const roll = Math.random();

    if (roll > tier.chance) return;

    // We're going in — log only when interjecting
    console.log(`[SassyManager] Interjecting in channel ${channelId} | tier ${tier.min}+ msgs | chance ${tier.chance} | roll ${roll.toFixed(3)}`);

    this._interjectCooldowns.set(channelId, now);

    const contextText = this._buildInterjectionContext(channelId, tier.context);

    try {
      const zinger = await this._getInterjection(contextText, channelContext);
      await message.channel.send(zinger);
    } catch (err) {
      console.error('[SassyManager] Interjection error:', err);
      // Fail silently — the bot just doesn't bother this time
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Prune timestamps outside the activity window and return current count. */
  _getActivityCount(channelId) {
    const now = Date.now();
    const timestamps = this._activityWindows.get(channelId) || [];
    const pruned = timestamps.filter(t => now - t < ACTIVITY_WINDOW_MS);
    this._activityWindows.set(channelId, pruned);
    return pruned.length;
  }

  /** Record a new message timestamp for a channel. */
  _recordActivity(channelId) {
    const timestamps = this._activityWindows.get(channelId) || [];
    timestamps.push(Date.now());
    this._activityWindows.set(channelId, timestamps);
    this._lastActivity.set(channelId, Date.now());
  }

  /** Store a recent message for interjection context, capped at 10. */
  _storeRecentMessage(channelId, author, content) {
    const msgs = this._recentMessages.get(channelId) || [];
    msgs.push({ author, content });
    if (msgs.length > 10) msgs.shift();
    this._recentMessages.set(channelId, msgs);
  }

  /** Resolve the activity tier for a channel. */
  _resolveTier(channelId) {
    const count = this._getActivityCount(channelId);
    for (const tier of ACTIVITY_TIERS) {
      if (count >= tier.min) return tier;
    }
    return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1]; // fallback: quiet
  }

  /** Trim conversation history to the last MAX_HISTORY_TURNS turns. */
  _trimHistory(channelId) {
    const history = this._conversationHistory.get(channelId) || [];
    const maxEntries = MAX_HISTORY_TURNS * 2;
    if (history.length > maxEntries) {
      this._conversationHistory.set(channelId, history.slice(-maxEntries));
    }
  }

  /** Decide if a message is worth reacting to (basic content filter). */
  _isInterjectable(content) {
    if (!content || content.trim().length === 0) return false;
    const words = content.trim().split(/\s+/);
    if (words.length < 4) return false;
    if (/^https?:\/\/\S+$/.test(content.trim())) return false; // URL-only
    // Strip common Unicode emoji ranges and check if meaningful text remains.
    // Covers: Misc Symbols, Dingbats, Emoticons, Misc Symbols & Pictographs,
    // Transport & Map, Supplemental Symbols, enclosed alphanumerics, etc.
    const emojiStripped = content
      .replace(/[\u2600-\u27BF]/gu, '')       // Misc Symbols, Dingbats
      .replace(/[\uFE00-\uFE0F]/gu, '')        // Variation selectors
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')  // Emoji & pictographic supplement
      .replace(/[\u{E0000}-\u{E007F}]/gu, '')  // Tags
      .replace(/\uFE0F|\u200D/gu, '')          // Variation selector-16, ZWJ
      .trim();
    if (emojiStripped.length < 5) return false;
    return true;
  }

  /** Build a context string from recent messages for Gemini. */
  _buildInterjectionContext(channelId, contextCount) {
    const msgs = this._recentMessages.get(channelId) || [];
    return msgs.slice(-contextCount).map(m => `${m.author}: ${m.content}`).join('\n');
  }

  /** Call Gemini for a direct reply, maintaining per-channel history. */
  async _getDirectReply(channelId, userMessage, channelContext) {
    const history = this._conversationHistory.get(channelId) || [];
    const systemInstruction = channelContext
      ? `${SYSTEM_DIRECT}\n\nChannel context: ${channelContext}`
      : SYSTEM_DIRECT;

    const chat = this._ai.chats.create({
      model: GEMINI_MODEL,
      history,
      config: { systemInstruction },
    });
    const response = await chat.sendMessage({ message: userMessage });
    const responseText = response.text ?? '';

    history.push({ role: 'user',  parts: [{ text: userMessage  }] });
    history.push({ role: 'model', parts: [{ text: responseText }] });
    this._conversationHistory.set(channelId, history);
    this._trimHistory(channelId);

    return responseText;
  }

  /** Call Gemini for an unprompted interjection. */
  async _getInterjection(contextText, channelContext) {
    const systemInstruction = channelContext
      ? `${SYSTEM_INTERJECT}\n\nChannel context: ${channelContext}`
      : SYSTEM_INTERJECT;
    const prompt = `Here is the recent conversation:\n\n${contextText}\n\nDrop your one-line reaction.`;
    const result = await this._ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { systemInstruction },
    });
    return (result.text ?? '').trim();
  }

  // ─── Channel context helpers ───────────────────────────────────────────────

  /**
   * Extract the channel name and parent category name from a Discord message.
   * Works for regular text channels and threads (one level deep).
   * @param {import('discord.js').Message} message
   * @returns {{ channelName: string, categoryName: string }}
   */
  _getChannelContext(message) {
    const channel = message.channel;
    const channelName = channel.name ?? '';
    let categoryName = '';

    if (channel.parent) {
      if (channel.parent.type === ChannelType.GuildCategory) {
        // Regular text channel: parent is the category
        categoryName = channel.parent.name ?? '';
      } else if (channel.parent.parent?.type === ChannelType.GuildCategory) {
        // Thread: parent is a text channel, grandparent is the category
        categoryName = channel.parent.parent.name ?? '';
      }
    }

    return { channelName, categoryName };
  }

  /**
   * Map a channel/category name pair to a descriptive context note for the AI.
   * Returns null if no known context matches.
   * @param {string} channelName
   * @param {string} categoryName
   * @returns {string|null}
   */
  _buildContextNote(channelName, categoryName) {
    const haystack = `${channelName} ${categoryName}`.toLowerCase();
    for (const { keywords, note } of CHANNEL_CONTEXTS) {
      if (keywords.some(kw => haystack.includes(kw))) return note;
    }
    return null;
  }

  // ─── Memory cleanup ────────────────────────────────────────────────────────

  /**
   * Start a periodic timer that evicts per-channel state for channels that have
   * had no activity in the last HISTORY_TTL_MS milliseconds.  Runs every hour.
   */
  _startCleanupTimer() {
    this._cleanupInterval = setInterval(() => this._evictStaleChannels(), MS_PER_HOUR);
    // Allow Node.js to exit even if this timer is still pending
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /** Stop the cleanup timer and release all per-channel state. */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  /** Remove all per-channel state for channels inactive longer than HISTORY_TTL_MS. */
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
        evicted++;
      }
    }

    if (evicted > 0) {
      console.log(`[SassyManager] Evicted stale state for ${evicted} channel(s) (TTL ${HISTORY_TTL_MS / MS_PER_HOUR}h).`);
    }
  }
}

module.exports = SassyManager;
