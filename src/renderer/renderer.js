/** Edge dock: app launchers, connection status, and timer notifications. */
'use strict';

const $ = (selector) => document.querySelector(selector);
const WIDGET_CATALOG = {
  'collection-log': { name: 'collectionLogWidget', icon: 'collection' },
  cosmetics: { name: 'cosmeticsWidget', icon: 'cosmetics' },
  'mastery-tracker': { name: 'masteryTrackerWidget', icon: 'mastery' },
  resources: { name: 'resourcesWidget', icon: 'resources' },
  enhancements: { name: 'enhancementsWidget', icon: 'enhancements' },
  'crafting-planner': { name: 'craftingPlannerWidget', icon: 'planner' },
  activity: { name: 'activityWidget', icon: 'activity' },
  'crafting-log': { name: 'craftingLogWidget', icon: 'craftlog' },
  'session-analysis': { name: 'sessionAnalysisWidget', icon: 'analysis' },
  player: { name: 'playerWidget', icon: 'player' },
  daily: { name: 'dailyWidget', icon: 'daily' },
  boss: { name: 'bossTimers', icon: 'boss' },
  crafting: { name: 'craftingTimers', icon: 'settings' },
  other: { name: 'otherTimers', icon: 'timer' },
  affiliation: { name: 'affiliationWidget', icon: 'affiliation' },
  factions: { name: 'factionsWidget', icon: 'flag' },
  odeinfamy: { name: 'odeInfamyWidget', icon: 'star' },
  wiki: { name: 'wikiWidget', icon: 'search' },
  groupfinder: { name: 'groupFinderWidget', icon: 'group' },
  market: { name: 'marketWidget', icon: 'market' },
  minimap: { name: 'minimapWidget', icon: 'map-pin' },
  arena: { name: 'arenaFinderWidget', icon: 'arena' },
  'world-watch': { name: 'worldWatchWidget', icon: 'clock' },
  clock: { name: 'clockWidget', icon: 'clock' },
  weather: { name: 'weatherWidget', icon: 'weather' },
  'build-exporter': { name: 'buildExporterWidget', icon: 'clipboard' },
  'temper-tracker': { name: 'temperTrackerWidget', icon: 'temper' },
  'wolf-training': { name: 'wolfTrainingWidget', icon: 'paw' },
  'data-inventory': { name: 'dataInventoryWidget', icon: 'database' },
  'data-ee-log': { name: 'dataEeLogWidget', icon: 'log' },
};

// Outline symbols match the widget picker; other icons use the shared mask set.

let config = {};
if (window.i18n?.titleTrackerEnabled === true) WIDGET_CATALOG['title-tracker'] = { name: 'titleTrackerWidget', icon: 'title' };
let platformSupport = {};
let translations = TRANSLATIONS.en;
let namesMap = {};
let currentStatus = 'waiting';
let currentTimers = [];
let overlayShortcutWarning = '';
let rendererWarning = '';
let overlayInteractive = false;
let nativeLayoutTracking = false;
let dockState = {};
const alertedTimers = new Set();
const widgetButtons = new Map();
let iconDrag = null;
let suppressDockIconClick = false;
let pendingDockOrder = null;
let dockOrderSaving = false;

function dockWidgetIds() {
  return [...new Set([...(window.ALL_WIDGET_IDS || Object.keys(WIDGET_CATALOG)), 'market'])];
}

function orderedDockWidgetIds() {
  const known = dockWidgetIds();
  const saved = pendingDockOrder || config.dockWidgetOrder;
  return [...new Set([...(Array.isArray(saved) ? saved.filter(id => known.includes(id)) : []), ...known])];
}

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  window.api.onConfigChanged((next) => {
    config = next || {};
    applyConfig();
  });
  window.api.onStateUpdate(applyState);
  window.api.onOverlayInteraction((interactive) => {
    overlayInteractive = interactive;
    document.body.classList.toggle('overlay-interactive', interactive);
  });
  window.api.onLayoutKeyMonitorStatus?.((active) => { nativeLayoutTracking = !!active; });
  if (window.api.onDockState) {
    window.api.onDockState((next) => {
      dockState = next || {};
      renderWidgetButtons();
      renderDockState();
      renderStatus();
    });
  }
  try {
    const state = await window.api.getState();
    config = state.config || {};
    dockState = state.dockState || {};
    platformSupport = state.platformSupport || {};
    nativeLayoutTracking = state.nativeLayoutTracking ?? platformSupport.platform === 'win32';
    applyState(state);
  } catch (error) {
    console.error('[DOCK] Could not load state:', error);
    rendererWarning = 'Could not load the overlay. Open Settings to retry.';
  }
  applyConfig();
  setInterval(() => {
    if (currentTimers.length) checkAlerts(currentTimers, Math.floor(Date.now() / 1000));
  }, 1000);
});

function applyState(state) {
  if (typeof state.overlayInteractive === 'boolean') {
    overlayInteractive = state.overlayInteractive;
    document.body.classList.toggle('overlay-interactive', overlayInteractive);
  }
  currentStatus = state.status || currentStatus;
  overlayShortcutWarning = state.overlayShortcutWarning || '';
  currentTimers = state.timers || [];
  if (state.namesMap) namesMap = state.namesMap;
  if (state.timerDurations) setTimerDurationsData(state.timerDurations);
  renderStatus();
  if (currentTimers.length) checkAlerts(currentTimers, Math.floor(Date.now() / 1000));
}

function dockText(key, fallback, values = {}) {
  return (translations[key] || fallback).replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
}

function applyConfig() {
  OverkotTheme.apply(config);
  const lang = config.language || 'en';
  translations = { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
  const labels = {
    'brand-btn': dockText('dockAbout', 'About Overkot / changelog'),
    'add-widgets-btn': translations.tooltipWidgets || 'Add / remove widgets',
    'settings-btn': translations.tooltipSettings || 'Settings',
    'tray-btn': translations.tooltipTray || 'Minimize to tray',
    'close-btn': translations.tooltipClose || 'Close Overkot',
  };
  for (const [id, label] of Object.entries(labels)) {
    $(`#${id}`).title = label;
    $(`#${id}`).setAttribute('aria-label', label);
  }
  $('#widget-launchers').setAttribute('aria-label', translations.widgetsTitle || 'Widgets');
  $('#dock-empty').title = dockText('dockChooseWidgets', 'Choose widgets to add to your dock');
  $('#dock-empty').textContent = dockText('dockAddWidgets', 'Add your widgets');
  renderWidgetButtons();
  renderDockState();
  renderStatus();
}

function makeWidgetIcon(id) {
  const icon = document.createElement('span');
  icon.className = 'dock-widget-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(window.WidgetIcons.create(id, document));
  return icon;
}

function renderWidgetButtons() {
  const enabled = config.widgetVisibility || config.moduleVisibility || {};
  let ids = orderedDockWidgetIds().filter(id => enabled[id] === true);
  if (iconDrag) {
    if (ids.length !== iconDrag.originalOrder.length || ids.some(id => !iconDrag.originalOrder.includes(id))) finishDockIconDrag(true);
    else ids = iconDrag.previewOrder;
  }
  const container = $('#widget-launchers');
  for (const [id, button] of widgetButtons) {
    if (!ids.includes(id)) {
      button.remove();
      widgetButtons.delete(id);
    }
  }
  for (const [index, id] of ids.entries()) {
    const definition = WIDGET_CATALOG[id] || { name: id, icon: 'widgets' };
    let button = widgetButtons.get(id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'dock-button dock-widget-button';
      button.dataset.widget = id;
      button.appendChild(makeWidgetIcon(id));
      const indicator = document.createElement('span');
      indicator.className = 'dock-floating-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      button.appendChild(indicator);
      button.addEventListener('click', () => toggleWidget(id, button));
      widgetButtons.set(id, button);
    }
    const popout = id === 'market' || id === 'daily';
    const open = id === 'market' ? dockState.marketOpen === true : id === 'daily' ? dockState.dailyOpen === true : config.widgetOpen?.[id] === true;
    const floating = popout || config.widgetDocked?.[id] === false;
    const name = translations[definition.name] || definition.name;
    const action = id === 'market' ? (open ? dockText('dockFocus', 'Focus {name}', { name }) : dockText('dockOpen', 'Open {name}', { name }))
      : (open ? dockText('dockHide', 'Hide {name}', { name }) : dockText('dockShow', 'Show {name}', { name }));
    const context = popout ? dockText('dockPopout', 'Pop-out') : floating ? dockText('dockFloating', 'Floating widget') : dockText('dockDocked', 'Docked widget');
    const label = `${action} · ${context}`;
    button.setAttribute('aria-label', label);
    const hints = [label];
    if (!popout) hints.push(dockText('dockArrangeHint', 'Hold Shift to arrange widgets.'));
    hints.push(dockText('dockReorderHint', 'Drag to reorder · Alt + arrow to move.'));
    button.title = hints.join('\n');
    const edge = dockState.edge || config.dockEdge || 'bottom';
    button.setAttribute('aria-keyshortcuts', edge === 'left' || edge === 'right' ? 'Alt+ArrowUp Alt+ArrowDown' : 'Alt+ArrowLeft Alt+ArrowRight');
    button.setAttribute('aria-pressed', String(open));
    button.classList.toggle('is-open', open);
    button.classList.toggle('is-floating', floating && !popout);
    // Leave existing nodes in place to retain keyboard focus on config updates.
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  }
  $('#dock-empty').hidden = ids.length > 0;
}

function visibleDockIconOrder() {
  return [...$('#widget-launchers').children].map(button => button.dataset.widget);
}

function announceDockOrder(id, position, total) {
  const announcement = $('#dock-order-announcement');
  if (announcement) announcement.textContent = dockText('dockMoved', '{name} moved to position {position} of {total}.', { name: translations[WIDGET_CATALOG[id]?.name] || id, position: position + 1, total });
}

function commitDockIconOrder(visibleOrder) {
  const previous = orderedDockWidgetIds();
  const enabled = new Set(visibleOrder);
  let index = 0;
  // Keep disabled icons in their stored slots so removing and re-adding a
  // widget does not erase the user's arrangement.
  const next = previous.map(id => enabled.has(id) ? visibleOrder[index++] : id);
  if (next.every((id, position) => id === previous[position])) return;
  pendingDockOrder = next;
  renderWidgetButtons();
  void saveDockIconOrder();
}

async function saveDockIconOrder() {
  if (dockOrderSaving) return;
  dockOrderSaving = true;
  try {
    while (pendingDockOrder) {
      const saving = pendingDockOrder;
      try {
        const result = await window.api.saveConfig({ dockWidgetOrder: saving.slice() });
        if (result === false) throw new Error('Widget order was not saved');
        config = { ...config, dockWidgetOrder: saving.slice() };
        rendererWarning = '';
      } catch (error) {
        console.error('[DOCK] Could not save widget order:', error);
        rendererWarning = 'Could not save widget order. Try dragging again.';
      }
      if (pendingDockOrder === saving) pendingDockOrder = null;
      renderWidgetButtons();
      renderStatus();
    }
  } finally {
    dockOrderSaving = false;
  }
}

function moveDockIconWithKeyboard(id, direction) {
  const order = visibleDockIconOrder();
  const index = order.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return;
  [order[index], order[next]] = [order[next], order[index]];
  commitDockIconOrder(order);
  widgetButtons.get(id)?.focus();
  announceDockOrder(id, next, order.length);
}

function bindDockIconReordering() {
  const container = $('#widget-launchers');
  const announcement = document.createElement('span');
  announcement.id = 'dock-order-announcement';
  announcement.className = 'dock-screen-reader';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  document.body.appendChild(announcement);
  container.addEventListener('pointerdown', event => {
    suppressDockIconClick = false;
    const button = event.target.closest('.dock-widget-button');
    if (!button || button.disabled || event.button !== 0 || event.isPrimary === false || iconDrag) return;
    const rect = button.getBoundingClientRect();
    const order = visibleDockIconOrder();
    iconDrag = { pointerId: event.pointerId, button, capture: button, moved: false,
      x: event.clientX, y: event.clientY, pointerX: event.clientX, pointerY: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      edge: document.body.dataset.dockEdge, vertical: document.body.classList.contains('dock-vertical'),
      originalOrder: order, previewOrder: order.slice(), ghost: null, scrollFrame: 0 };
    button.setPointerCapture(event.pointerId);
  });
  container.addEventListener('click', event => {
    // Keyboard activation has no pointer gesture and remains available.
    if (!suppressDockIconClick || event.detail === 0) return;
    suppressDockIconClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  container.addEventListener('dragstart', event => event.preventDefault());
  document.addEventListener('pointermove', event => {
    const drag = iconDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0) { finishDockIconDrag(false); return; }
    drag.pointerX = event.clientX;
    drag.pointerY = event.clientY;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    event.preventDefault();
    if (!drag.moved) {
      drag.moved = true;
      suppressDockIconClick = true;
      drag.capture = container;
      container.setPointerCapture(event.pointerId);
      document.body.classList.add('dock-icons-dragging');
      drag.button.classList.add('is-icon-dragging');
      drag.ghost = drag.button.cloneNode(true);
      drag.ghost.classList.remove('is-icon-dragging');
      drag.ghost.classList.add('dock-icon-ghost');
      drag.ghost.setAttribute('aria-hidden', 'true');
      drag.ghost.tabIndex = -1;
      drag.ghost.title = '';
      document.body.appendChild(drag.ghost);
      window.api.setDockKeyboardActive?.(true);
      drag.scrollFrame = requestAnimationFrame(scrollDockIconDrag);
    }
    updateDockIconDrag();
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (iconDrag?.pointerId === event.pointerId) finishDockIconDrag(false);
  });
  document.addEventListener('pointercancel', event => {
    if (iconDrag?.pointerId === event.pointerId) finishDockIconDrag(true);
  });
  container.addEventListener('lostpointercapture', event => {
    if (iconDrag?.pointerId === event.pointerId && event.target === iconDrag.capture) finishDockIconDrag(true);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && iconDrag) {
      event.preventDefault();
      finishDockIconDrag(true);
    }
  });
  window.addEventListener('blur', () => finishDockIconDrag(true));
}

function updateDockIconDrag() {
  const drag = iconDrag;
  if (!drag?.moved) return;
  const container = $('#widget-launchers');
  drag.ghost.style.left = `${Math.max(0, Math.min(window.innerWidth - 36, drag.pointerX - drag.offsetX))}px`;
  drag.ghost.style.top = `${Math.max(0, Math.min(window.innerHeight - 36, drag.pointerY - drag.offsetY))}px`;
  const position = drag.vertical ? drag.pointerY : drag.pointerX;
  const others = [...container.children].filter(button => button !== drag.button);
  const before = others.find(button => {
    const rect = button.getBoundingClientRect();
    return position < (drag.vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2);
  }) || null;
  if (drag.button.nextElementSibling !== before) container.insertBefore(drag.button, before);
  drag.previewOrder = visibleDockIconOrder();
}

function scrollDockIconDrag() {
  const drag = iconDrag;
  if (!drag?.moved) return;
  const container = $('#widget-launchers');
  const rect = container.getBoundingClientRect();
  const pointer = drag.vertical ? drag.pointerY : drag.pointerX;
  const start = drag.vertical ? rect.top : rect.left;
  const end = drag.vertical ? rect.bottom : rect.right;
  const scroll = pointer < start + 24 ? -6 : pointer > end - 24 ? 6 : 0;
  if (scroll) {
    const previous = drag.vertical ? container.scrollTop : container.scrollLeft;
    if (drag.vertical) container.scrollTop += scroll;
    else container.scrollLeft += scroll;
    const current = drag.vertical ? container.scrollTop : container.scrollLeft;
    if (current !== previous) updateDockIconDrag();
  }
  drag.scrollFrame = requestAnimationFrame(scrollDockIconDrag);
}

function finishDockIconDrag(cancelled) {
  const drag = iconDrag;
  if (!drag) return;
  iconDrag = null;
  if (drag.scrollFrame) cancelAnimationFrame(drag.scrollFrame);
  if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
  drag.ghost?.remove();
  drag.button.classList.remove('is-icon-dragging');
  document.body.classList.remove('dock-icons-dragging');
  if (!drag.moved) return;
  window.api.setDockKeyboardActive?.(false);
  if (cancelled) renderWidgetButtons();
  else {
    commitDockIconOrder(drag.previewOrder);
    announceDockOrder(drag.button.dataset.widget, drag.previewOrder.indexOf(drag.button.dataset.widget), drag.previewOrder.length);
  }
}

async function toggleWidget(id, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (id === 'market') {
      window.api.openMarket();
    } else {
      const result = await window.api.toggleDockWidget(id);
      if (result?.config) config = result.config;
      rendererWarning = '';
      renderWidgetButtons();
      window.OverkotMotion?.emphasize(button, 'activate');
    }
  } catch (error) {
    console.error('[DOCK] Widget toggle failed:', error);
    rendererWarning = 'Could not change widget visibility. Try again.';
    window.OverkotMotion?.emphasize(button, 'error');
  } finally {
    button.disabled = false;
    renderStatus();
  }
}

function renderDockState() {
  const edge = dockState.edge || config.dockEdge || 'bottom';
  if (iconDrag && (iconDrag.edge !== edge || dockState.autoHidden)) finishDockIconDrag(true);
  document.body.dataset.dockEdge = ['top', 'bottom', 'left', 'right'].includes(edge) ? edge : 'bottom';
  document.body.classList.toggle('dock-vertical', edge === 'left' || edge === 'right');
  document.body.classList.toggle('dock-editing', !!dockState.layoutEditing);
  document.body.classList.toggle('dock-redock-target', !!dockState.redockTarget);
  document.body.classList.toggle('dock-auto-hidden', !!dockState.autoHidden);
  $('#redock-hint').hidden = !dockState.layoutEditing;
  $('#redock-hint').textContent = dockState.redockTarget ? dockText('dockRelease', 'Release to dock') : dockText('dockDrop', 'Drop here to dock');
  $('#redock-hint').title = dockText('dockDropHint', 'Hold Shift and drag a widget onto this bar to dock it. Release Shift to align floating widgets to the grid.');
  $('#dock-bar').setAttribute('aria-label', dockState.layoutEditing ? dockText('dockDropLabel', 'Overlay dock — drop a widget here to dock it') : dockText('dockToolbar', 'Overlay dock'));
  $('#dock-bar').setAttribute('aria-orientation', edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal');
}

function renderStatus() {
  let text;
  let hint;
  switch (currentStatus) {
    case 'connected': text = translations.statusConnected || 'Connected'; hint = dockText('dockConnectedHint', 'Live Soulframe inventory is connected.'); break;
    case 'connecting':
      text = translations.statusConnecting || 'Connecting';
      hint = platformSupport.platform === 'linux' ? 'Linux game connection is experimental. Check game process access and your game log location if inventory stays unavailable.' : translations.pleaseLogin || 'Log in to Soulframe.';
      break;
    case 'permission-denied': text = dockText('dockAccessBlocked', 'Access blocked'); hint = 'Linux process permissions prevent reading Soulframe. Market, Wiki, Map and Calendar remain available. Overkot will retry automatically.'; break;
    case 'scan-failed': text = dockText('dockUnavailable', 'Inventory unavailable'); hint = 'Could not read the running game session. Overkot will retry automatically.'; break;
    case 'companion': text = translations.statusCompanion || 'Companion mode'; hint = translations.companionHint || 'Market, Wiki, Map and Calendar are ready. Live inventory is not available on this platform.'; break;
    default: text = translations.statusWaiting || 'Waiting for Soulframe'; hint = translations.pleaseLaunch || 'Launch Soulframe to connect live inventory.';
  }
  const warning = rendererWarning || dockState.shortcutWarning || overlayShortcutWarning;
  if (warning) hint += ` ${warning}`;
  const interactionHotkey = config.interactionHotkey || 'Shift+F1';
  const visibilityHotkey = config.overlayVisibilityHotkey || 'Shift+F2';
  hint += '\n' + dockText('dockHotkeys', '{interaction}: interact · {visibility}: show / hide overlay', { interaction: interactionHotkey, visibility: visibilityHotkey });
  hint += '\n' + dockText('dockArrangeHint', 'Hold Shift to arrange widgets.');
  $('#dock-status').dataset.status = warning ? 'warning' : currentStatus;
  $('#dock-status').title = `${text}\n${hint}`;
  $('#dock-status').setAttribute('aria-label', `${text}. ${hint}. Open Settings.`);
  $('#dock-status-text').textContent = text;
  const announcement = $('#dock-status-announcement');
  const nextAnnouncement = `${text}${warning ? `. ${warning}` : ''}`;
  if (announcement.textContent !== nextAnnouncement) announcement.textContent = nextAnnouncement;
}

function bindEvents() {
  bindDockIconReordering();
  $('#brand-btn').addEventListener('click', () => window.api.openChangelog());
  $('#dock-status').addEventListener('click', () => window.api.openSettings());
  $('#settings-btn').addEventListener('click', () => window.api.openSettings());
  $('#add-widgets-btn').addEventListener('click', () => window.api.openWidgets());
  $('#dock-empty').addEventListener('click', () => window.api.openWidgets());
  $('#tray-btn').addEventListener('click', () => window.api.minimizeToTray());
  $('#close-btn').addEventListener('click', () => window.api.windowClose());
  $('#widget-launchers').addEventListener('wheel', (event) => {
    if (document.body.classList.contains('dock-vertical')) return;
    if (event.deltaY && !event.deltaX) {
      event.preventDefault();
      $('#widget-launchers').scrollLeft += event.deltaY;
    }
  }, { passive: false });
  $('#dock-bar').addEventListener('keydown', (event) => {
    const vertical = document.body.classList.contains('dock-vertical');
    const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    if (event.key !== previous && event.key !== next) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && document.activeElement?.dataset.widget) {
      event.preventDefault();
      event.stopPropagation();
      window.api.setDockKeyboardActive?.(true);
      moveDockIconWithKeyboard(document.activeElement.dataset.widget, event.key === next ? 1 : -1);
      return;
    }
    const buttons = [...$('#dock-bar').querySelectorAll('button')].filter((button) => !button.hidden && !button.disabled);
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === next ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  document.addEventListener('keydown', (event) => {
    window.api.setDockKeyboardActive?.(true);
    if (event.key === 'Shift' && !event.repeat) window.api.setLayoutEditing?.(true);
    if (event.key === 'Escape' && overlayInteractive) window.api.exitInteractiveMode();
  });
  document.addEventListener('pointermove', () => {
    if (!iconDrag?.moved) window.api.setDockKeyboardActive?.(false);
  });
  document.addEventListener('pointerdown', () => window.api.setDockKeyboardActive?.(false));
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') window.api.setLayoutEditing?.(false);
  });
  window.addEventListener('blur', () => {
    if (!nativeLayoutTracking) window.api.setLayoutEditing?.(false);
  });
}

function checkAlerts(timers, nowSecs) {
  const currentTags = new Set(timers.map((timer) => timer.tag));
  for (const tag of alertedTimers) {
    if (!currentTags.has(tag)) alertedTimers.delete(tag);
  }
  for (const timer of timers) {
    if (timer.expiryTime - nowSecs <= 0 && !alertedTimers.has(timer.tag)) {
      alertedTimers.add(timer.tag);
      if (config.enableAlertPopup !== false) window.api.showAlert({ name: lookupTimerName(namesMap, timer.tag), readyLabel: translations.ready || 'Ready' });
    }
  }
}
