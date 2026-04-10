const ROLES = Object.freeze({
  MAYOR: 'Mayor',
  WEREWOLF: 'Werewolf',
  SEER: 'Seer',
  VILLAGER: 'Villager',
});

const ROLE_DESCRIPTIONS = Object.freeze({
  [ROLES.MAYOR]:
    'You are the **Mayor** 🏛️\n\n' +
    "You know the magic word. Answer your fellow villagers' questions using only **Yes**, **No**, or " +
    '**Maybe** via the buttons on the game board. You **cannot speak** during the game — your answers are your only voice!',

  [ROLES.WEREWOLF]:
    'You are the **Werewolf** 🐺\n\n' +
    'You already know the magic word. Pretend you don\'t! Blend in with the villagers, ask misleading ' +
    'questions, and stop them from guessing the word before time runs out.',

  [ROLES.SEER]:
    'You are the **Seer** 🔮\n\n' +
    'You know the magic word. Subtly guide the villagers toward the answer — without revealing that you ' +
    'already know it. The Werewolf will be watching for you!',

  [ROLES.VILLAGER]:
    'You are a **Villager** 🧑‍🌾\n\n' +
    "You don't know the magic word. Ask strategic yes/no questions, listen to the Mayor's answers, and " +
    'work together to guess the word before time runs out!',
});

/**
 * Assigns roles to a shuffled copy of the player array.
 *
 * Distribution:
 *   3 players  → Mayor, Werewolf, Villager
 *   4+ players → Mayor, Werewolf, Seer, ...Villagers
 *
 * @param {Array<{id: string, username: string}>} players
 * @returns {Array<{id: string, username: string, role: string}>}
 * @throws {Error} if fewer than 3 players are provided
 */
function assignRoles(players) {
  if (players.length < 3) {
    throw new Error('At least 3 players are required to start Werewords.');
  }

  // Fisher-Yates shuffle for fair randomisation
  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const result = shuffled.map(p => ({ ...p }));

  result[0].role = ROLES.MAYOR;
  result[1].role = ROLES.WEREWOLF;

  if (result.length >= 4) {
    result[2].role = ROLES.SEER;
    for (let i = 3; i < result.length; i++) {
      result[i].role = ROLES.VILLAGER;
    }
  } else {
    result[2].role = ROLES.VILLAGER;
  }

  return result;
}

module.exports = { ROLES, ROLE_DESCRIPTIONS, assignRoles };
