'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * The 7-button nudge row shown in each guesser's ephemeral panel.
 *
 * Layout: <<< / << / < / SUBMIT / > / >> / >>>
 * Deltas:  -25 / -10 / -5 / submit / +5 / +10 / +25
 *
 * @param {string} userId
 * @param {boolean} submitted  When true, all nudge buttons are disabled.
 * @param {number} position    Current 0–100 position (used to disable nudges at edges).
 */
function buildNudgeComponents(userId, submitted, position) {
  const atLeft  = position <= 0;
  const atRight = position >= 100;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_-25`)
      .setLabel('<<<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atLeft),
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_-10`)
      .setLabel('<<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atLeft),
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_-5`)
      .setLabel('<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atLeft),
    new ButtonBuilder()
      .setCustomId(`wl_submit_${userId}`)
      .setLabel(submitted ? '✅ Locked In' : 'SUBMIT')
      .setStyle(submitted ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(submitted),
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_5`)
      .setLabel('>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atRight),
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_10`)
      .setLabel('>>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atRight),
    new ButtonBuilder()
      .setCustomId(`wl_nudge_${userId}_25`)
      .setLabel('>>>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(submitted || atRight),
  );

  return [row];
}

/**
 * Public "View Guess Panel" button posted in the thread for everyone to open their ephemeral.
 */
function buildGuessPromptComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_guess_panel')
      .setLabel('View Guess Panel')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📍'),
  );
  return [row];
}

module.exports = { buildNudgeComponents, buildGuessPromptComponents };
