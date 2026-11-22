'use strict';

const STABLE_CHANNEL = 'stable';
const TITLE_TRACKER_BETA_CHANNEL = 'title-tracker-beta';

// A packaged build's embedded channel always wins over the environment. Raw
// source packages also stay stable; the environment switch is only for local
// Electron development and UI checks.
function resolveBuildChannel({ bundledChannel, isPackaged = false, env = process.env } = {}) {
  if (bundledChannel !== undefined) {
    return bundledChannel === TITLE_TRACKER_BETA_CHANNEL ? TITLE_TRACKER_BETA_CHANNEL : STABLE_CHANNEL;
  }
  if (isPackaged) return STABLE_CHANNEL;
  return env.OVERKOT_BUILD_CHANNEL === TITLE_TRACKER_BETA_CHANNEL ? TITLE_TRACKER_BETA_CHANNEL : STABLE_CHANNEL;
}

let isPackaged = false;
try { isPackaged = require('electron').app?.isPackaged === true; } catch { /* Node test process. */ }
const BUILD_CHANNEL = resolveBuildChannel({
  bundledChannel: typeof __OVERKOT_BUILD_CHANNEL__ === 'undefined' ? undefined : __OVERKOT_BUILD_CHANNEL__,
  isPackaged,
});
const IS_BETA = BUILD_CHANNEL === TITLE_TRACKER_BETA_CHANNEL;
// Title Tracker ships in every channel. Beta controls packaging and updates.
const TITLE_TRACKER_ENABLED = true;

module.exports = { STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL, resolveBuildChannel,
  BUILD_CHANNEL, IS_BETA, TITLE_TRACKER_ENABLED };
