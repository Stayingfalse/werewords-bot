const ROLES = Object.freeze({
  MAYOR: 'Wordsmith',
  WEREWOLF: 'Demon',
  SEER: 'Librarian',
  VILLAGER: 'Townsfolk',
});

const ROLE_DESCRIPTIONS = Object.freeze({
  [ROLES.MAYOR]:
    'You are the **Wordsmith** 📝\n\n' +
    "You know the forbidden word. Answer your fellow townsfolk's questions using only **Yes**, **No**, or " +
    '**Maybe** via the buttons on the game board. You **cannot speak** during the game — your answers are your only voice!',

  [ROLES.WEREWOLF]:
    'You are the **Demon** 😈\n\n' +
    'You already know the forbidden word. Pretend you don\'t! Blend in with the townsfolk, ask misleading ' +
    'questions, and stop them from guessing the word before time runs out.',

  [ROLES.SEER]:
    'You are the **Librarian** 📚\n\n' +
    'You know the forbidden word. Subtly guide the townsfolk toward the answer — without revealing that you ' +
    'already know it. The Demon will be watching for you!',

  [ROLES.VILLAGER]:
    'You are a **Townsfolk** 🏡\n\n' +
    "You don't know the forbidden word. Ask strategic yes/no questions, listen to the Wordsmith's answers, and " +
    'work together to guess the word before time runs out!',
});

/**
 * Assigns roles to a shuffled copy of the player array.
 *
 * Distribution:
 *   3 players  → Wordsmith, Demon, Townsfolk
 *   4+ players → Wordsmith, Demon, Librarian, ...Townsfolk
 *
 * @param {Array<{id: string, username: string}>} players
 * @returns {Array<{id: string, username: string, role: string}>}
 * @throws {Error} if fewer than 3 players are provided
 */
function assignRoles(players) {
  if (players.length < 3) {
    throw new Error('At least 3 players are required to start The Forbidden Word.');
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
