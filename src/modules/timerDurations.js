/**
 * Timer duration map – how long each timer type lasts.
 * Definitions come from the verified display feed; this module provides
 * the lookup logic and generic estimates until the first download.
 */

// Keep confirmed corrections while older display feeds are still cached.
const EXACT_CORRECTIONS = { upgradegiven_godandghost: 23 * 3600 };
let data = { defaultSeconds: 1800, recipeDefaultSeconds: 36000, exact: { ...EXACT_CORRECTIONS }, patterns: {}, recipes: {} };

function setTimerDurations(next) {
  const seconds = value => Number.isFinite(value) && value > 0 && value <= 366 * 86400;
  if (!next || !seconds(next.defaultSeconds) || !seconds(next.recipeDefaultSeconds)) return false;
  for (const key of ['exact', 'patterns', 'recipes']) {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])
        || !Object.values(next[key]).every(seconds)) return false;
  }
  data = { ...next, exact: { ...next.exact, ...EXACT_CORRECTIONS } };
  return true;
}

/**
 * Get the total duration for a timer tag in seconds.
 * @param {string} tag
 * @returns {number} duration in seconds
 */
function getTimerDuration(tag) {
  const lower = tag.toLowerCase();

  // Exact tag match
  if (data.exact[lower] !== undefined) return data.exact[lower];

  // Substring pattern matches
  for (const [pattern, seconds] of Object.entries(data.patterns)) {
    if (lower.includes(pattern)) return seconds;
  }

  // PendingRecipe lookup
  if (lower.startsWith('pendingrecipe:')) {
    const recipe = lower.slice('pendingrecipe:'.length);
    return data.recipes[recipe] !== undefined ? data.recipes[recipe] : data.recipeDefaultSeconds;
  }

  return data.defaultSeconds;
}

module.exports = { getTimerDuration, setTimerDurations, getTimerDurations: () => data };
