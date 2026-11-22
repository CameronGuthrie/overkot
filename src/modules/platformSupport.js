'use strict';

function getPlatformSupport(platform = process.platform) {
  return {
    platform,
    gameConnection: platform === 'win32' || platform === 'linux',
    gameFocusTracking: platform === 'win32',
    experimental: platform !== 'win32',
    inventoryUnavailableReason: platform === 'darwin'
      ? 'Live Soulframe inventory is not available in the macOS companion build. You can browse the market and manage existing listings.'
      : 'Connect to Soulframe and wait for a live inventory update.',
  };
}

module.exports = { getPlatformSupport };
