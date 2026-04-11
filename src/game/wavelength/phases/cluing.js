'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Board embed shown while waiting for the Clue Giver to pick a spectrum and submit a clue.
 */
function buildCluingBoardEmbed(game) {
  const clueGiver = game.players.get(game.clueGiverId);
  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Awaiting Clue')
    .setDescription(
      `**Clue Giver:** <@${game.clueGiverId}> (${clueGiver?.username ?? '?'})\n\n` +
      `${clueGiver?.username ?? 'The Clue Giver'} is privately choosing a spectrum and thinking of a clue…\n\n` +
      `*Stand by — the clue will appear here when ready!*`
    )
    .setColor(0xF39C12)
    .setTimestamp();
}

/**
 * Ephemeral component for the Clue Giver to pick one of two spectra.
 * @param {Array<{left:string, right:string}>} spectrumOptions  Exactly 2 entries.
 */
function buildSpectrumPickComponents(spectrumOptions) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_spectrum_0')
      .setLabel(`${spectrumOptions[0].left} ↔ ${spectrumOptions[0].right}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wl_spectrum_1')
      .setLabel(`${spectrumOptions[1].left} ↔ ${spectrumOptions[1].right}`)
      .setStyle(ButtonStyle.Primary),
  );
  return [row];
}

/**
 * Ephemeral "Enter Your Clue" button shown to the Clue Giver after they pick a spectrum.
 */
function buildClueSubmitComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wl_enter_clue')
      .setLabel('Enter Your Clue')
      .setStyle(ButtonStyle.Success)
      .setEmoji('💬'),
  );
  return [row];
}

/**
 * Board embed updated in the thread once the Clue Giver has submitted their clue.
 * Shows the spectrum endpoints and the clue word.
 */
function buildPublicClueEmbed(game) {
  const clueGiver = game.players.get(game.clueGiverId);
  const guessers  = [...game.players.values()].filter(p => p.id !== game.clueGiverId);
  const submitted = [...game.guesses.values()].filter(g => g.submitted).length;

  return new EmbedBuilder()
    .setTitle('〰️ Wavelength — Make Your Guess!')
    .setDescription(
      `**Clue Giver:** ${clueGiver?.username ?? '?'}\n` +
      `**Spectrum:** \`${game.chosenSpectrum.left}\` ↔ \`${game.chosenSpectrum.right}\`\n\n` +
      `> 💬 **"${game.clue}"**\n\n` +
      `Click **"View Guess Panel"** below to position your marker on the spectrum and submit your guess.`
    )
    .addFields({
      name: `📊 Submissions — ${submitted}/${guessers.length}`,
      value: guessers.map(p => {
        const g = game.guesses.get(p.id);
        return g?.submitted ? `✅ ${p.username}` : `⏳ ${p.username}`;
      }).join('\n') || '*No guessers*',
    })
    .setColor(0x3498DB)
    .setTimestamp();
}

module.exports = {
  buildCluingBoardEmbed,
  buildSpectrumPickComponents,
  buildClueSubmitComponents,
  buildPublicClueEmbed,
};
