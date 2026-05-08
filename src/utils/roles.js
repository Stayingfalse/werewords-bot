const ROLES = Object.freeze({
  MAYOR: 'Wordsmith (Unused)',
  WEREWOLF: 'Cheese Thief',
  SEER: 'Fall Mouse',
  VILLAGER: 'Sleepy Mice',
});

const ROLE_DESCRIPTIONS = Object.freeze({
  [ROLES.WEREWOLF]:
    'You are the **Cheese Thief** 🧀\n\n' +
    'You wake only when your die number is called. You may steal the cheese once, then choose one accomplice.',
  [ROLES.SEER]:
    'You are the **Fall Mouse** 🍂\n\n' +
    'If you are selected in the final accusation (including a tie), you win alone.',
  [ROLES.VILLAGER]:
    'You are a **Sleepy Mice** 🐭\n\n' +
    'You wake when your die number is called and try to identify the Cheese Thief.',
});

/**
 * Returns the player's hidden alignment role when present.
 * Wordsmiths can carry a secondary secret role.
 * @param {{role?: string, secretRole?: string|null}} player
 * @returns {string|undefined}
 */
function getEffectiveRole(player) {
  return player?.role;
}

/**
 * @param {{role?: string, secretRole?: string|null}} player
 * @returns {boolean}
 */
function isDemon(player) {
  return getEffectiveRole(player) === ROLES.WEREWOLF;
}

/**
 * @param {{role?: string, secretRole?: string|null}} player
 * @returns {boolean}
 */
function isLibrarian(player) {
  return getEffectiveRole(player) === ROLES.SEER;
}

function isThief(player) {
  return isDemon(player);
}

function isFallMouse(player) {
  return isLibrarian(player);
}

/**
 * Assigns roles to a shuffled copy of the player array.
 *
 * Distribution:
 *   3+ players → Cheese Thief, Fall Mouse, ...Sleepy Mice
 *
 * @param {Array<{id: string, username: string}>} players
 * @returns {Array<{id: string, username: string, role: string, secretRole: string|null}>}
 * @throws {Error} if fewer than 3 players are provided
 */
function assignRoles(players) {
  if (players.length < 3) {
    throw new Error('At least 3 players are required to start.');
  }

  // Fisher-Yates shuffle for fair randomisation
  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const result = shuffled.map(p => ({ ...p, secretRole: null }));

  result[0].role = ROLES.WEREWOLF;
  result[1].role = ROLES.SEER;
  for (let i = 2; i < result.length; i++) {
    result[i].role = ROLES.VILLAGER;
  }

  return result;
}

module.exports = {
  ROLES,
  ROLE_DESCRIPTIONS,
  assignRoles,
  getEffectiveRole,
  isDemon,
  isLibrarian,
  isThief,
  isFallMouse,
};
