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
    playerColor, playerOutlineColor, outlineColor, drawPlayerMarker };
});
