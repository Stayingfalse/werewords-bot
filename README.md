# Potato Game Bot 🎮

A Discord bot that brings party games and social deduction fun to your server! Host game nights with friends using interactive Discord threads and enjoy AI-powered entertainment.

## 🎲 Games

### The Forbidden Word (Werewords)

A social deduction word-guessing game where players work together to guess a secret word... but some players are secretly working against the team!

**How to Play:**
- Use `/werewords` to start a game
- The **Mayor** chooses a secret word from three options
- Players ask yes/no questions to guess the word
- **Townsfolk** try to help the team succeed
- **Werewolves** try to sabotage without being caught
- The **Seer** knows the word but can't reveal it directly
- After the word is guessed (or time runs out), players vote on who they think the Werewolf is!

**Features:**
- 🎭 Multiple roles: Mayor, Seer, Werewolf, and Townsfolk
- ⏱️ 4-minute timer for guessing
- 🗳️ Voting phase to identify the Werewolf
- 📊 Response statistics tracking
- 🔄 Session support - play multiple rounds with the same group
- 🎯 Text or voice mode options
- 👥 Supports 4-10 players

### Wavelength 〰️

A party game of clever clues and spectrum guessing! One player gives a clue to help teammates guess where a target sits on a spectrum between two extremes.

**How to Play:**
- Use `/wavelength` to start a game
- The **Clue Giver** is shown a spectrum (e.g., "Cold ↔ Hot") and a secret target position
- They give a one-word clue to help teammates guess the target
- Other players adjust a dial and submit their guess
- Points are awarded based on how close the guesses are to the target!

**Features:**
- 🎨 Visual spectrum board with interactive dial
- 🎲 Random clue giver selection (or round-robin/snake order modes)
- 🏆 Multiple game modes: Classic, First-to-Points, Fixed Rounds, and Unlimited
- 📈 Session tracking with score history
- 🔄 Rematch support to keep the party going
- 👥 Supports 2-20 players

## 🎉 Additional Features

### Birthday Announcements 🎂

Never forget a friend's birthday again! The bot can automatically announce birthdays in your server with fun, sassy messages.

**Commands:**
- `/birthday set <date>` - Set your birthday (format: dd/mm or dd/mm/yyyy)
- `/birthday list` - See the next 3 upcoming birthdays
- `/birthday list all:True` - View all registered birthdays
- `/birthday delete` - Remove your birthday

**Admin Commands:**
- `/birthday start` - Enable automatic birthday announcements
- `/birthday stop` - Disable announcements
- `/birthday setchannel <channel>` - Choose where announcements appear
- `/birthday resend` - Re-send today's birthday messages

### SassyBot AI 🤖

An AI companion powered by Google Gemini that adds personality to your server conversations!

**What it does:**
- Responds when mentioned with witty, sassy replies
- Occasionally interjects in conversations with clever commentary
- Understands channel context (board games, social deduction games, etc.)
- Adjusts response frequency based on channel activity
- Keeps conversation history for natural, contextual responses

**Features:**
- 💬 Direct replies when mentioned
- 🎭 Spontaneous interjections during lively conversations
- 🧠 Context-aware responses based on your channel's focus
- 😎 Passive-aggressive personality (helpful but with flair!)
- ⏱️ Smart cooldowns to avoid spam

## 🎮 Getting Started

1. **Invite the bot** to your Discord server (requires Community server or Boost Level 1+ for private threads)
2. **Grant permissions:**
   - Create Private Threads
   - Send Messages in Threads
   - Manage Threads
3. **Start playing!** Use `/werewords` or `/wavelength` in any channel to begin

## 🎯 Game Tips

**For The Forbidden Word:**
- Players can strategically use their response tokens to guide the guesser
- The Seer should be subtle - revealing yourself too early might help the Werewolves!
- Werewolves should participate naturally to avoid suspicion
- Use "So Close" and "Way Off" tokens wisely - they're limited!

**For Wavelength:**
- Clue Givers: Be creative but not too obscure!
- Guessers: Discuss and coordinate before locking in your guess
- Remember: It's not just about being right, it's about being close!
- Try different game modes to keep things fresh

**For Birthday Celebrations:**
- Set up announcements early so you never miss a celebration
- The bot will post automatically at midnight UTC
- Fun, random messages keep each birthday announcement unique!

## 🛠️ Features Overview

- ✨ Private thread-based games for organized play
- 💾 Persistent game state (survives bot restarts)
- 🔄 Session support for marathon game nights
- 📊 Statistics tracking and game history
- 🎨 Rich embeds and interactive buttons
- 🤖 Optional AI-powered entertainment
- 🎂 Automated birthday celebration system

## 📝 Note

All games run in private threads to keep your channels clean and conversations organized. Players are automatically added to the thread when they join a game!

---

Ready to play? Start with `/werewords` or `/wavelength` and let the games begin! 🎉
