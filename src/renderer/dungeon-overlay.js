'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const api = window.api;
  let config = {};
  let interactive = false;
  try {
    const state = await api.getState();
    config = state?.config || {};
    interactive = state?.overlayInteractive === true;
  } catch { /* The map can still load while settings are unavailable. */ }
  OverkotTheme.apply(config, { widgetId: 'minimap' });
  const hint = document.getElementById('dungeon-overlay-hint');
  const renderHint = () => {
    document.body.dataset.dockEdge = ['top', 'bottom', 'left', 'right'].includes(config.dockEdge) ? config.dockEdge : 'bottom';
    const chord = (config.interactionHotkey || 'Shift+F1').replaceAll('+', ' + ');
    hint.textContent = interactive ? 'Drag to pan · Scroll to zoom · Escape to return to game' : `${chord} to interact`;
  };
  renderHint();
  const map = DungeonMapWidget.mount(document.getElementById('dungeon-overlay'), {
    api, config, overlay: true, onClose: () => api.closeDungeonOverlay(),
  });
  api.onConfigChanged?.(next => { config = next; OverkotTheme.apply(next, { widgetId: 'minimap' }); renderHint(); });
  api.onOverlayInteraction?.(next => { interactive = next === true; renderHint(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !interactive) return;
    event.preventDefault();
    event.stopPropagation();
    interactive = false;
    map.releaseInteraction();
    renderHint();
    api.exitDungeonOverlayInteraction();
  });
  window.addEventListener('unload', () => map.destroy(), { once: true });
});
