// ============================================================
//  SassyManager — Gemini-powered sassy AI features
//  Ported from SassyBot (https://github.com/Stayingfalse/SassyBot)
//
//  Enabled only when SASSY_ENABLED=true.  All tuning knobs are
//  exposed as optional environment variables (see .env.example).
// ============================================================

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Configuration ───────────────────────────────────────────────────────────

const GEMINI_MODEL       = process.env.GEMINI_MODEL        || 'gemini-2.0-flash';
const MAX_HISTORY_TURNS  = parseInt(process.env.MAX_HISTORY_TURNS  || '20', 10);
const COOLDOWN_MS        = parseInt(process.env.COOLDOWN_MS        || '2000', 10);
const INTERJECT_COOLDOWN = parseInt(process.env.INTERJECT_COOLDOWN || '180000', 10); // 3 min
const ACTIVITY_WINDOW_MS = parseInt(process.env.ACTIVITY_WINDOW_MS || '60000', 10);  // 60 sec

// Optional: comma-separated channel IDs to restrict interjections.
// Leave unset to allow interjections everywhere.
const INTERJECT_CHANNELS = process.env.INTERJECT_CHANNELS
  ? new Set(process.env.INTERJECT_CHANNELS.split(',').map(s => s.trim()))
  : null;

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
You are SassBot, a Discord bot with the energy of someone perpetually 
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
You are SassBot, a Discord bot who cannot help but commentate on other 
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

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this._directModel   = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: SYSTEM_DIRECT });
    this._interjectModel= genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: SYSTEM_INTERJECT });

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

    console.log(`[SassyManager] Initialised — model: ${GEMINI_MODEL}`);
    console.log(`[SassyManager] Interjection cooldown: ${INTERJECT_COOLDOWN / 1000}s | Activity window: ${ACTIVITY_WINDOW_MS / 1000}s`);
    if (INTERJECT_CHANNELS) {
      console.log(`[SassyManager] Interjecting in channels: ${[...INTERJECT_CHANNELS].join(', ')}`);
    } else {
      console.log('[SassyManager] Interjecting in all channels');
    }
  }

  // ─── Public entry point ────────────────────────────────────────────────────

  /** Called for every non-bot guild message. */
  async handleMessage(message) {
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

    // ── PATH A: Direct reply (mention or reply-to-bot) ─────────────────────
    if (isMentioned || isReplyToBot) {
      const now = Date.now();
      if (now - (this._directCooldowns.get(channelId) || 0) < COOLDOWN_MS) return;
      this._directCooldowns.set(channelId, now);

      const userMessage = content.replace(/<@!?\d+>/g, '').trim() || '…(silence)';

      try {
        await message.channel.sendTyping();
        const reply = await this._getDirectReply(channelId, userMessage);
        await message.reply(reply);
      } catch (err) {
        console.error('[SassyManager] Direct reply error:', err);
        await message.reply("*stares blankly* My brain blue-screened. Try again, I suppose.").catch(() => {});
      }
      return; // Don't also try to interject on the same message
    }

    // ── PATH B: Unprompted interjection ────────────────────────────────────

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

    console.log(`[SassyManager] Interject check — channel ${channelId} | tier ${tier.min}+ msgs | chance ${tier.chance} | roll ${roll.toFixed(3)}`);

    if (roll > tier.chance) return;

    this._interjectCooldowns.set(channelId, now);

    const contextText = this._buildInterjectionContext(channelId, tier.context);

    try {
      const zinger = await this._getInterjection(contextText);
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
    const emojiStripped = content.replace(/[\u{1F300}-\u{1FFFF}]/gu, '').trim();
    if (emojiStripped.length < 5) return false; // emoji-only
    return true;
  }

  /** Build a context string from recent messages for Gemini. */
  _buildInterjectionContext(channelId, contextCount) {
    const msgs = this._recentMessages.get(channelId) || [];
    return msgs.slice(-contextCount).map(m => `${m.author}: ${m.content}`).join('\n');
  }

  /** Call Gemini for a direct reply, maintaining per-channel history. */
  async _getDirectReply(channelId, userMessage) {
    const history = this._conversationHistory.get(channelId) || [];

    const chat = this._directModel.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const responseText = result.response.text();

    history.push({ role: 'user',  parts: [{ text: userMessage  }] });
    history.push({ role: 'model', parts: [{ text: responseText }] });
    this._conversationHistory.set(channelId, history);
    this._trimHistory(channelId);

    return responseText;
  }

  /** Call Gemini for an unprompted interjection. */
  async _getInterjection(contextText) {
    const prompt = `Here is the recent conversation:\n\n${contextText}\n\nDrop your one-line reaction.`;
    const result = await this._interjectModel.generateContent(prompt);
    return result.response.text().trim();
  }
}

module.exports = SassyManager;
