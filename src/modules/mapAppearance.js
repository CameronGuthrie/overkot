'use strict';

(function(root, factory) {
  const appearance = factory();
  if (typeof module === 'object' && module.exports) module.exports = appearance;
  else root.MapAppearance = appearance;
})(typeof window === 'object' ? window : globalThis, function() {
  const DEFAULT_PLAYER_COLOR = '#f4b642';
  const DEFAULT_PLAYER_OUTLINE_COLOR = '#241708';
  const DEFAULT_OUTLINE_COLOR = '#d8d8d8';
  const DEFAULT_OVERWORLD_ZOOM = .65;
  const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const playerColor = config => isColor(config?.playerMarkerColor) ? config.playerMarkerColor : DEFAULT_PLAYER_COLOR;
  const playerOutlineColor = config => isColor(config?.playerMarkerOutlineColor) ? config.playerMarkerOutlineColor : DEFAULT_PLAYER_OUTLINE_COLOR;
  const outlineColor = config => isColor(config?.dungeonMapOutlineColor) ? config.dungeonMapOutlineColor : DEFAULT_OUTLINE_COLOR;

  function bindTileStatus(element, openConnections) {
    const status = element.querySelector('[role="status"]');
    const connect = element.querySelector('button');
    // Let native buttons handle focus, Enter and Space without capturing a map drag.
    connect.addEventListener('pointerdown', event => event.stopPropagation());
    connect.addEventListener('click', openConnections);
    return (labels, { visible, painted, failed, requiresSignIn }) => {
      const ready = visible === painted;
      const needsConnection = failed && requiresSignIn;
      let message = '';
      if (needsConnection) {
        message = labels.mapTilesSignIn || 'Connect your avakot.dev account in Settings → Connections to download map tiles.';
        const label = labels.settingsAvakotSignIn || 'Sign in with avakot.dev';
        if (connect.textContent !== label) connect.textContent = label;
        if (connect.title !== message) connect.title = message;
      } else if (failed) {
        message = labels.mapTilesUnavailable || 'Map tiles unavailable. In Settings → Game files, select Check for new data to retry.';
      } else if (!ready) {
        message = labels.mapTilesLoading || 'Loading map tiles…';
      }
      if (status.textContent !== message) status.textContent = message;
      if (connect.hidden === needsConnection) connect.hidden = !needsConnection;
      element.classList.toggle('loaded', ready);
      element.classList.toggle('tile-connect', needsConnection);
      element.classList.toggle('tile-notice', !ready && (painted > 0 || failed && !needsConnection));
    };
  }

  /** Draw the same outlined, inset-base direction marker in every map viewport. */
  function drawPlayerMarker(context, { x, y, heading, color, outlineColor, scale = 1 } = {}) {
    if (![x, y, scale].every(Number.isFinite) || scale <= 0) return false;
    context.save();
    context.translate(x, y);
    context.shadowColor = 'rgba(0, 0, 0, 0.45)';
    context.shadowBlur = 3 * scale;
    context.shadowOffsetX = context.shadowOffsetY = 0;
    context.beginPath();
    if (Number.isFinite(heading)) {
      context.rotate(heading * Math.PI / 180);
      context.moveTo(0, -12 * scale);
      context.lineTo(8 * scale, 9 * scale);
      context.lineTo(0, 5 * scale);
      context.lineTo(-8 * scale, 9 * scale);
      context.closePath();
    } else context.arc(0, 0, 4 * scale, 0, Math.PI * 2);
    context.fillStyle = isColor(color) ? color : DEFAULT_PLAYER_COLOR;
    context.lineWidth = 2 * scale;
    context.strokeStyle = isColor(outlineColor) ? outlineColor : DEFAULT_PLAYER_OUTLINE_COLOR;
    context.lineJoin = 'round';
    context.fill(); context.stroke(); context.restore();
    return true;
  }

  return { DEFAULT_PLAYER_COLOR, DEFAULT_PLAYER_OUTLINE_COLOR, DEFAULT_OUTLINE_COLOR, DEFAULT_OVERWORLD_ZOOM, isColor,
    playerColor, playerOutlineColor, outlineColor, drawPlayerMarker, bindTileStatus };
});
