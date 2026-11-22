/** Settings hub. Config controls send only the fields the user changes. */
'use strict';
const $ = selector => document.querySelector(selector);
let config = {};
let platformSupport = {};
let confirmedConfig = {};
let configRevision = 0;
let initialized = false;
let saving = false;
let loadFailed = false;
let saveFailed = false;
let closeAfterSave = false;
let t = {};
let activeTab = 'appearance';
const shortcutControls = {
  interactionHotkey: { id: 'interaction-hotkey', defaultValue: 'Shift+F1' },
  overlayVisibilityHotkey: { id: 'overlay-hotkey', defaultValue: 'Shift+F2' },
};
let recordingShortcut = null;
let capturedKey = null;
let capturedMouse = null;
let suppressMouseClick = null;
let shortcutMessage = '';
const shortcutWarnings = {};
const pendingConfig = new Map();
const sliderTimers = new Map();
const configSaveWaiters = new Set();
let layoutsSettings = null;
let widgetSizingSettings = null;
let dataCheckStatus = '';
let marketState = null;
let marketRevision = 0;
let marketBusy = false;
let marketError = '';
let avakotAccountState = null;
let avakotAccountRevision = 0;
let avakotAccountAction = '';
let avakotAccountActionId = 0;
let avakotAccountError = '';
let updateState = null;
let overlayDisplays = null;
let overlayDisplaysRevision = 0;
let overlayDisplaysFailed = false;
let playerTrackingState = null;
let playerTrackingRevision = 0;
let tutorialToggleBusy = false;
let moonsteelPreviewBusy = false;
let paths = null;
const dirtyPaths = new Set();
const busyPaths = new Set();
const pathFeedback = {};
const pathDefinitions = {
  log: { snapshot: 'eeLog', config: 'eeLogPath', input: 'ee-log-path' },
  screenshots: { snapshot: 'screenshots', config: 'screenshotDir', input: 'screenshot-dir' },
};
const checkboxSettings = {
  'chk-hide-bars': ['hideBars', false],
  'chk-hide-countdown': ['hideCountdown', false],
  'chk-alert-popup': ['enableAlertPopup', true],
  'chk-alert-sound': ['enableAlertSound', true],
  'chk-alerts-when-hidden': ['showAlertsWhenHidden', false],
  'chk-click-through': ['clickThrough', true],
  'chk-launch-to-tray': ['launchToTray', false],
  'chk-daily-login': ['dailyAutoLogin', true],
  'chk-daily-reset': ['dailyAutoReset', true],
  'chk-hide-when-game-closed': ['hideWhenGameClosed', true],
  'chk-show-only-when-game-focused': ['showOnlyWhenGameFocused', false],
  'chk-market-remember': ['marketRememberSession', true],
  'chk-dungeon-auto-switch': ['dungeonMapAutoSwitch', true],
  'chk-dungeon-progressive-reveal': ['dungeonMapProgressiveReveal', true],
  'chk-dungeon-see-through': ['dungeonMapSeeThrough', false],
  'chk-live-player-tracking': ['livePlayerTracking', true],
  'chk-world-drops': ['showWorldDrops', true],
  'chk-dock-auto-hide': ['dockAutoHide', false],
  'chk-allow-single-key-shortcuts': ['allowSingleKeyShortcuts', false],
};
const opacitySettings = [
  ['slider-dungeon-opacity', 'dungeon-opacity-value', 'dungeonMapBackgroundOpacity', 45],
];
const mapColorSettings = [
  ['color-player-marker', 'player-marker-color-value', 'reset-player-marker-color', 'playerMarkerColor', '#f4b642'],
  ['color-player-marker-outline', 'player-marker-outline-color-value', 'reset-player-marker-outline-color', 'playerMarkerOutlineColor', '#241708'],
  ['color-dungeon-outline', 'dungeon-outline-color-value', 'reset-dungeon-outline-color', 'dungeonMapOutlineColor', '#d8d8d8'],
];
const validMapColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const moonsteelCheckboxes = [['chk-moonsteel-enabled', 'enabled'], ['chk-moonsteel-flash', 'flashEnabled'], ['chk-moonsteel-sound', 'soundEnabled']];
const moonsteelSliders = [
  ['opacity', 'opacity', value => `${Math.round(value * 100)}%`],
  ['border-width', 'borderWidth', value => `${value} px`],
  ['blur', 'blur', value => `${value} px`],
  ['duration', 'duration', value => `${value} s`],
  ['pulse-speed', 'pulseSpeed', value => `${value}×`],
  ['volume', 'volume', value => `${Math.round(value * 100)}%`],
];
const tr = (key, fallback) => t[key] || fallback;

function loadTranslations() {
  const lang = config.language || 'en';
  t = { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
  window.OverkotAppearanceEditor?.setLanguage?.(lang, t);
  document.documentElement.lang = window.i18n?.localeTags?.[lang] || lang;
  populateWidgetTutorials();
  document.title = tr('settingsTitle', 'Settings');
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const value = t[element.dataset.i18n];
    if (value) element.textContent = value;
  });
  $('#close-btn').title = tr('tooltipClose', 'Close');
  $('#close-btn').setAttribute('aria-label', tr('tooltipClose', 'Close'));
  $('#appearance-editor').setAttribute('aria-label', tr('settingsAppearanceEditor', 'Appearance editor'));
  $('.settings-sidebar').setAttribute('aria-label', tr('settingsCategories', 'Settings categories'));
  for (const def of Object.values(pathDefinitions)) {
    $('#' + def.input).placeholder = tr('settingsAutomaticPath', 'Automatic detection');
  }
  renderStatus();
  renderDataCheckStatus();
  renderMarket();
  renderAvakotAccount();
  renderGamePaths();
  renderUpdate();
  renderOverlayHotkey();
  renderPlayerTracking();
  renderTutorialControls();
}

function renderTutorialControls() {
  $('#chk-tutorials-enabled').checked = config.tutorialsEnabled !== false;
  $('#chk-tutorials-enabled').disabled = tutorialToggleBusy;
}

function renderMoonsteelAlertControls() {
  const model = window.MoonsteelAlertSettings;
  if (!model) return;
  const settings = model.normalize(config.moonsteelAlert);
  for (const [id, key] of moonsteelCheckboxes) $('#' + id).checked = settings[key];
  for (const [suffix, key, format] of moonsteelSliders) {
    $('#slider-moonsteel-' + suffix).value = settings[key];
    $('#moonsteel-' + suffix + '-value').textContent = format(settings[key]);
  }
  $('#color-moonsteel-alert').value = settings.color;
  $('#moonsteel-color-value').textContent = settings.color.toUpperCase();
  $('#moonsteel-monitor-select').value = settings.monitor;
  $('#moonsteel-sound-select').value = settings.sound;
  for (const input of document.querySelectorAll('.moonsteel-flash-control input')) input.disabled = !settings.flashEnabled;
  for (const input of document.querySelectorAll('.moonsteel-sound-control input, .moonsteel-sound-control select')) input.disabled = !settings.soundEnabled;
  const hasOutput = settings.flashEnabled && settings.opacity > 0 || settings.soundEnabled && settings.volume > 0;
  $('#btn-test-moonsteel-alert').disabled = moonsteelPreviewBusy || !hasOutput;
  $('#btn-test-moonsteel-alert').title = hasOutput ? '' : tr('settingsTestEnableHint', 'Enable a visible flash or audible sound to test the alert.');
  $('#moonsteel-detection-hint').textContent = config.livePlayerTracking === false
    ? tr('settingsMoonsteelTrackingOff', 'Live player tracking is off. Turn it on under Overlay to detect Moonsteel drops, even with the minimap closed.')
    : tr('settingsMoonsteelDetection', 'Detection runs in the background even with the minimap closed. Requires live player tracking on Windows or Linux.');
}

function changeMoonsteelAlert(key, value, defer = false) {
  const settings = window.MoonsteelAlertSettings?.merge(config.moonsteelAlert, { [key]: value });
  if (!settings) { renderMoonsteelAlertControls(); return; }
  queueConfig({ moonsteelAlert: settings }, defer);
  renderMoonsteelAlertControls();
}

async function previewMoonsteelAlert() {
  if (moonsteelPreviewBusy || !window.MoonsteelAlertSettings) return;
  const settings = window.MoonsteelAlertSettings.normalize(config.moonsteelAlert);
  const status = $('#moonsteel-alert-status');
  moonsteelPreviewBusy = true;
  status.hidden = false; status.dataset.error = 'false'; status.textContent = tr('settingsTestStarting', 'Starting the test alert…');
  renderMoonsteelAlertControls();
  try {
    if (await window.api.previewMoonsteelAlert(settings) !== true) throw new Error('Alert preview did not start');
    status.textContent = tr('settingsTestStarted', 'Test alert started with these settings.');
  } catch {
    status.dataset.error = 'true'; status.textContent = tr('settingsTestFailed', 'Could not start the test alert. Try again.');
  } finally {
    moonsteelPreviewBusy = false;
    renderMoonsteelAlertControls();
  }
}

async function setTutorialsEnabled(enabled) {
  if (tutorialToggleBusy) return;
  tutorialToggleBusy = true;
  const status = $('#tutorial-toggle-status');
  status.hidden = true;
  renderTutorialControls();
  try {
    if (await window.api.setTutorialsEnabled(enabled) !== true) throw new Error('Tutorial preference was not saved');
    config.tutorialsEnabled = confirmedConfig.tutorialsEnabled = enabled;
  } catch {
    status.textContent = tr('settingsTutorialSaveFailed', 'Could not save the tutorial setting. Try again.');
    status.dataset.error = 'true'; status.hidden = false;
  } finally {
    tutorialToggleBusy = false;
    renderTutorialControls();
  }
}

function setTab(next, focus = false) {
  stopShortcutCapture();
  activeTab = next;
  for (const button of document.querySelectorAll('.settings-tab')) {
    const selected = button.dataset.tab === next;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $('#' + button.getAttribute('aria-controls')).hidden = !selected;
  }
  closeLanguageDropdown();
  $('#settings-content').scrollTop = 0;
  renderStatus();
  if (focus) $('#tab-' + next).focus();
}

function closeLanguageDropdown(focus = false) {
  $('#lang-dropdown-options').classList.add('hidden');
  $('#lang-dropdown-selected').setAttribute('aria-expanded', 'false');
  if (focus) $('#lang-dropdown-selected').focus();
}

function populateLanguageDropdown() {
  const currentLang = config.language || 'en';
  const fontFamily = window.OverkotAppearance.resolve(config).fontFamily;
  const container = $('#lang-dropdown-options');
  container.replaceChildren();
  for (const lang of LANGUAGES) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'lang-option' + (lang.code === currentLang ? ' selected' : '');
    option.dataset.langCode = lang.code;
    option.lang = lang.locale || lang.code;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(lang.code === currentLang));
    const flag = document.createElement('img');
    flag.className = 'lang-flag';
    flag.src = `../../langs/flags/${lang.flag}`;
    flag.alt = '';
    const name = document.createElement('span');
    name.textContent = lang.name;
    name.style.fontFamily = window.OverkotAppearance.fontStack(fontFamily, lang.code);
    option.append(flag, name);
    container.append(option);
  }
  const currentEntry = LANGUAGES.find(lang => lang.code === currentLang) || LANGUAGES.find(lang => lang.code === 'en') || LANGUAGES[0];
  if (currentEntry) {
    $('#lang-selected-flag').src = `../../langs/flags/${currentEntry.flag}`;
    $('#lang-selected-text').textContent = currentEntry.name;
    $('#lang-selected-text').lang = currentEntry.locale || currentEntry.code;
  }
}

function applyConfigToDOM() {
  for (const [id, [key, fallback]] of Object.entries(checkboxSettings)) {
    $('#' + id).checked = config[key] ?? fallback;
  }
  updateOpacityControls();
  renderMapColors();
  $('#dock-edge-select').value = ['top', 'bottom', 'left', 'right'].includes(config.dockEdge) ? config.dockEdge : 'bottom';
  $('#window-close-focus-select').value = config.windowCloseFocus ?? 'game';
  renderOverlayDisplays();
  renderOverlayHotkey();
  $('#settings-content').inert = !initialized;
  renderPlatformSupport();
  renderMarket();
  renderPlayerTracking();
  renderTutorialControls();
  renderMoonsteelAlertControls();
}

function renderPlayerTracking() {
  const element = $('#player-tracking-status');
  if (!element) return;
  const status = config.livePlayerTracking === false ? 'disabled' : playerTrackingState?.status || 'idle';
  const permissionMessages = {
    win32: tr('settingsPositionWindowsDenied', 'Windows denied access to the player position. Restart Soulframe and Overkot under the same Windows account with “Run as administrator” turned off for both.'),
    linux: 'Linux blocked the player position reader. Install or reinstall the DEB/Pacman package to configure its reader permissions.',
  };
  const messages = {
    tracking: tr('settingsPositionActive', 'Tracking player position and facing.'),
    searching: tr('settingsPositionFinding', 'Finding the player in the current game session…'),
    stale: tr('settingsPositionStale', 'Waiting for a fresh player position…'),
    disabled: tr('settingsPositionOff', 'Live player tracking is off.'),
    'unsupported-build': tr('settingsPositionBuild', 'Live tracking is not available for this Soulframe build yet.'),
    'unsupported-platform': tr('settingsPositionPlatforms', 'Live player tracking supports Windows and Linux with Wine/Proton.'),
    'game-closed': tr('settingsPositionStartGame', 'Start Soulframe to track your player position.'),
    'waiting-for-game': tr('settingsPositionStartGame', 'Start Soulframe to track your player position.'),
    'waiting-for-login': tr('settingsPositionLogin', 'Player found. Waiting for Overkot to identify the current Soulframe account.'),
    'waiting-for-area': tr('settingsPositionArea', 'Player found. Waiting for the current area in EE.log. Check the log file in Settings → Game files.'),
    'waiting-context': tr('settingsPositionMap', 'Waiting for your current map…'),
    'waiting-position': tr('settingsPositionPosition', 'Waiting for a player position…'),
    'helper-missing': tr('settingsPositionUnavailableReader', 'The player position reader is unavailable.'),
    'helper-unavailable': tr('settingsPositionUnavailableReader', 'The player position reader is unavailable.'),
    'scan-incomplete': tr('settingsPositionSearching', 'The player search is still incomplete. Waiting while it retries.'),
    'process-gone': tr('settingsPositionStartGame', 'Start Soulframe to track your player position.'),
    'profile-mismatch': tr('settingsPositionSession', 'Live tracking could not verify this Soulframe session.'),
    'permission-denied': permissionMessages[platformSupport.platform] || tr('settingsPositionUnreadable', 'Your player position could not be read.'),
    'not-found': tr('settingsPositionRetry', 'Waiting to find your player while the reader retries.'),
    ambiguous: tr('settingsPositionAmbiguous', 'Waiting to verify your player position while the reader retries.'),
    'scan-failed': tr('settingsPositionUnavailable', 'Live player tracking is unavailable.'),
    'invalid-arguments': tr('settingsPositionUnavailable', 'Live player tracking is unavailable.'),
    'wrong-process': tr('settingsPositionWaiting', 'Waiting for Soulframe…'),
    stopped: tr('settingsPositionWaiting', 'Waiting for Soulframe…'),
    unavailable: tr('settingsPositionUnavailable', 'Live player tracking is unavailable.'),
    error: tr('settingsPositionUnavailable', 'Live player tracking is unavailable.'),
    idle: tr('settingsWaitingForTracking', 'Waiting for player tracking…'),
  };
  const progress = playerTrackingState?.scanProgress;
  element.textContent = (status === 'searching' || status === 'scan-incomplete') && Number.isInteger(progress)
    ? `${messages.searching} ${progress}%` : messages[status] || messages.idle;
  element.dataset.status = Object.hasOwn(messages, status) ? status : 'idle';
}

function renderOverlayDisplays() {
  const select = $('#dock-display-select'), hint = $('#dock-display-hint');
  if (!overlayDisplays) {
    select.disabled = true;
    if (overlayDisplaysFailed) hint.textContent = tr('settingsMonitorLoadFailed', 'Could not load connected monitors. Reopen Settings to try again.');
    hint.dataset.error = String(overlayDisplaysFailed);
    return;
  }
  const displays = overlayDisplays.displays;
  const options = displays.map(display => {
    const option = document.createElement('option');
    option.value = String(display.id); option.textContent = display.label; return option;
  });
  if (!options.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = tr('settingsMonitorEmpty', 'No connected monitors'); options.push(option);
  }
  select.replaceChildren(...options);
  select.disabled = displays.length === 0;
  const has = id => displays.some(display => display.id === id);
  const pending = pendingConfig.get('dockDisplayId');
  const selected = has(pending) ? pending : has(config.dockDisplayId) ? config.dockDisplayId
    : has(overlayDisplays.selectedDisplayId) ? overlayDisplays.selectedDisplayId : displays.find(display => display.primary)?.id ?? displays[0]?.id;
  select.value = selected === undefined ? '' : String(selected);
  const missing = overlayDisplays.usingFallback === true || (Number.isSafeInteger(config.dockDisplayId) && !has(config.dockDisplayId));
  hint.dataset.error = 'false';
  hint.textContent = missing
    ? tr('settingsMonitorDisconnected', 'The saved monitor is disconnected. The bar is using an available monitor; select one to change it.')
    : tr('settingsMonitorHint', 'Move the bar and attached widgets to another monitor. If it disconnects, Overkot uses an available monitor.');
}

function receiveOverlayDisplays(snapshot) {
  overlayDisplaysRevision++;
  if (!snapshot || !Array.isArray(snapshot.displays)) { overlayDisplaysFailed = true; renderOverlayDisplays(); return; }
  const seen = new Set();
  const displays = snapshot.displays.filter(display => {
    if (!display || !Number.isSafeInteger(display.id) || display.id === -1 || seen.has(display.id) || typeof display.label !== 'string') return false;
    seen.add(display.id); return true;
  });
  overlayDisplays = { displays, selectedDisplayId: snapshot.selectedDisplayId,
    preferredDisplayId: snapshot.preferredDisplayId, usingFallback: snapshot.usingFallback === true };
  overlayDisplaysFailed = false;
  renderOverlayDisplays();
}

async function loadOverlayDisplays() {
  if (!window.api.getOverlayDisplays) return;
  const revision = overlayDisplaysRevision;
  try {
    const snapshot = await window.api.getOverlayDisplays();
    if (revision === overlayDisplaysRevision) receiveOverlayDisplays(snapshot);
  } catch {
    if (revision === overlayDisplaysRevision) { overlayDisplaysFailed = true; renderOverlayDisplays(); }
  }
}

function changeOverlayDisplay(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) { renderOverlayDisplays(); return false; }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || !overlayDisplays?.displays.some(display => display.id === id)) { renderOverlayDisplays(); return false; }
  queueConfig({ dockDisplayId: id }); renderOverlayDisplays(); return true;
}

async function loadPlayerTracking() {
  const revision = playerTrackingRevision;
  if (!window.api.getPlayerTracking) { playerTrackingState = { status: 'unavailable' }; renderPlayerTracking(); return; }
  try {
    const snapshot = await window.api.getPlayerTracking();
    if (revision === playerTrackingRevision) { playerTrackingState = snapshot; renderPlayerTracking(); }
  } catch {
    if (revision === playerTrackingRevision) { playerTrackingState = { status: 'unavailable' }; renderPlayerTracking(); }
  }
}

const mouseButtons = ['Mouse1', 'Mouse3', 'Mouse2', 'Mouse4', 'Mouse5'];
const mouseShortcutNames = {
  Mouse1: ['settingsMouseButton1', 'Left click'], Mouse2: ['settingsMouseButton2', 'Right click'],
  Mouse3: ['settingsMouseButton3', 'Wheel click'], Mouse4: ['settingsMouseButton4', 'Mouse 4 (Back)'],
  Mouse5: ['settingsMouseButton5', 'Mouse 5 (Forward)'],
  WheelUp: ['settingsWheelUp', 'Scroll up'], WheelDown: ['settingsWheelDown', 'Scroll down'],
  WheelLeft: ['settingsWheelLeft', 'Scroll left'], WheelRight: ['settingsWheelRight', 'Scroll right'],
};

function renderOverlayHotkey() {
  const mouseSupported = platformSupport.platform === 'win32';
  $('#single-key-shortcuts-label').textContent = mouseSupported
    ? tr('settingsAllowSingleKeyMouseShortcuts', 'Allow single keys or mouse buttons')
    : tr('settingsAllowSingleKeyShortcuts', 'Allow single-key shortcuts');
  for (const [key, { id, defaultValue }] of Object.entries(shortcutControls)) {
    const button = $('#' + id + '-capture');
    const value = config[key] || defaultValue;
    button.textContent = recordingShortcut === key ? tr('settingsHotkeyRecording', 'Press a shortcut…')
      : value.split('+').map(part => Object.hasOwn(mouseShortcutNames, part) ? tr(...mouseShortcutNames[part]) : part).join(' + ');
    button.setAttribute('aria-pressed', String(recordingShortcut === key));
  }
  const message = shortcutMessage || Object.values(shortcutWarnings).filter(Boolean).join(' ');
  const hint = $('#overlay-hotkey-hint');
  if (message) hint.textContent = message;
  else if (config.allowSingleKeyShortcuts === true) hint.textContent = mouseSupported
    ? tr('settingsSingleKeyMouseHint', 'Click a shortcut, then press a key, click a mouse button or scroll. Escape cancels. A single key also works while typing in other apps. Unmodified left and right clicks only trigger while Soulframe is focused.')
    : tr('settingsSingleKeyHint', 'Click a shortcut, then press a key or key combination. Escape cancels. Single keys also work while typing in other apps.');
  else hint.textContent = recordingShortcut
    ? tr('settingsHotkeyRecordingHint', 'Press a modifier and a key. Escape cancels.')
    : tr('settingsHotkeyHint', 'Click the shortcut, then press a modifier and a key. Escape cancels.');
  hint.dataset.error = String(!!message);
}

function stopShortcutCapture() {
  if (!recordingShortcut) return;
  recordingShortcut = null;
  capturedKey = null;
  capturedMouse = null;
  shortcutMessage = '';
  window.api.setShortcutCapture?.(false);
  renderOverlayHotkey();
}

function startShortcutCapture(key) {
  if (recordingShortcut === key) { stopShortcutCapture(); return; }
  recordingShortcut = key;
  capturedKey = null;
  capturedMouse = null;
  suppressMouseClick = null;
  shortcutMessage = '';
  window.api.setShortcutCapture?.(true);
  renderOverlayHotkey();
  $('#' + shortcutControls[key].id + '-capture').focus();
}

function eventBinding(event, key) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  return key ? [...modifiers, key].join('+') : null;
}

function hotkeyFromEvent(event) {
  const code = event.code || '';
  const named = { ' ': 'Space', '+': 'Plus', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
    MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack' };
  const keypad = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv' };
  let key = named[event.key] || event.key;
  if (/^Numpad[0-9]$/.test(code) && /^[0-9]$/.test(event.key)) key = 'num' + event.key;
  else if (Object.hasOwn(keypad, code)) key = keypad[code];
  else if (code === 'NumpadDecimal' && event.key !== 'Delete') key = 'numdec';
  else if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
  else if (/^Digit[0-9]$/.test(code) && event.shiftKey) key = code.slice(5);
  else if (/^Key[A-Z]$/.test(code) && !/^[!-~]$/.test(event.key)) key = code.slice(3);
  const binding = eventBinding(event, key);
  return window.OverlayShortcuts.validShortcut(binding, config.allowSingleKeyShortcuts === true, platformSupport.platform) ? binding : null;
}

function changeShortcut(key, hotkey) {
  const other = key === 'interactionHotkey' ? 'overlayVisibilityHotkey' : 'interactionHotkey';
  const identity = value => window.OverlayShortcuts.shortcutIdentity(value, platformSupport.platform);
  if (identity(hotkey) === identity(config[other] || shortcutControls[other].defaultValue)) {
    shortcutMessage = key === 'interactionHotkey'
      ? tr('settingsInteractHotkeyConflict', 'This shortcut shows / hides the overlay. Choose a different interact hotkey.')
      : tr('settingsHotkeyConflict', 'Choose a shortcut different from the interact hotkey.');
    renderOverlayHotkey();
    return false;
  }
  stopShortcutCapture();
  shortcutMessage = '';
  delete shortcutWarnings[key];
  queueConfig({ [key]: hotkey });
  renderOverlayHotkey();
  return true;
}

function captureShortcut(event) {
  if (!recordingShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === 'keyup') {
    if (capturedKey && capturedKey.code === event.code) {
      const { hotkey } = capturedKey;
      capturedKey = null;
      changeShortcut(recordingShortcut, hotkey);
    }
    return;
  }
  if (event.key === 'Escape') { stopShortcutCapture(); return; }
  if (capturedKey || capturedMouse || event.repeat || ['Control', 'Alt', 'AltGraph', 'Shift', 'Meta'].includes(event.key)) return;
  const hotkey = hotkeyFromEvent(event);
  if (hotkey) capturedKey = { code: event.code, hotkey };
  else shortcutMessage = config.allowSingleKeyShortcuts === true
    ? tr('settingsSingleKeyUnsupported', 'Use a letter, number, function key or navigation key, with or without modifiers.')
    : tr('settingsHotkeyUnsupported', 'Use a modifier with a letter, number, function key or navigation key.');
  renderOverlayHotkey();
}

function canCaptureMouse() {
  return recordingShortcut && !capturedKey && config.allowSingleKeyShortcuts === true && platformSupport.platform === 'win32' && document.hasFocus();
}

function commitMouseShortcut(binding) {
  if (!canCaptureMouse() || !window.OverlayShortcuts.isMouseShortcut(binding)
    || !window.OverlayShortcuts.validShortcut(binding, true, 'win32')) return;
  capturedMouse = null;
  // A native release or DOM mouseup can be followed by a click on the recorder.
  // Consume that click so it cannot start a new capture or activate another control.
  suppressMouseClick = binding.split('+').at(-1);
  changeShortcut(recordingShortcut, binding);
}

function captureMouseEvent(event) {
  const button = mouseButtons[event.button];
  if (event.type === 'mousedown') suppressMouseClick = null;
  if (['click', 'auxclick', 'contextmenu'].includes(event.type)) {
    if (event.type === 'click' && event.detail === 0) return; // Keyboard activation.
    if (!button || (button !== suppressMouseClick && !canCaptureMouse())) return;
  } else if (!canCaptureMouse()) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === 'mousedown' && button) capturedMouse = { button, binding: eventBinding(event, button) };
  if (event.type === 'mouseup' && capturedMouse && capturedMouse.button === button) commitMouseShortcut(capturedMouse.binding);
  if (event.type === 'wheel') {
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.deltaY;
    const direction = horizontal ? (delta < 0 ? 'WheelLeft' : 'WheelRight') : (delta < 0 ? 'WheelUp' : 'WheelDown');
    if (delta) commitMouseShortcut(eventBinding(event, direction));
  }
}

function renderPlatformSupport() {
  $('#window-close-focus-row').hidden = platformSupport.platform !== 'win32';
  const note = $('#platform-support-note');
  note.hidden = !platformSupport.experimental;
  note.textContent = platformSupport.gameConnection === false
    ? 'This companion build supports Market, Wiki, Map and Calendar. Live inventory and game visibility controls are not available on macOS.'
    : 'Linux support is experimental. Game connection depends on Wine/Proton and process permissions. Game focus tracking is not available; overlay controls depend on your desktop.';
  if (platformSupport.platform === 'linux') {
    const displayNotes = {
      x11: tr('settingsDisplayX11', 'Display: X11. Test the overlay with Soulframe in borderless or windowed mode.'),
      xwayland: tr('settingsDisplayXwayland', 'Display: XWayland. Dock placement and grid snapping use XWayland on your Wayland desktop. Window stacking and shortcuts still depend on your compositor.'),
      wayland: tr('settingsDisplayWayland', 'Display: native Wayland. Dock placement, grid snapping and always-on-top are unavailable. Relaunch with --ozone-platform=x11 when XWayland is available, or use an X11 session.'),
      auto: tr('settingsDisplayAuto', 'Display: automatic selection requested. Native Wayland limits always-on-top and window positioning.'),
      unknown: tr('settingsDisplayUnknown', 'Display backend could not be determined. Use an X11 session for overlay testing.'),
    };
    note.textContent += ' ' + (displayNotes[platformSupport.displayBackend] || displayNotes.unknown);
  }
  for (const [id, supported] of [
    ['chk-hide-when-game-closed', platformSupport.gameConnection],
    ['chk-show-only-when-game-focused', platformSupport.gameFocusTracking],
  ]) {
    const control = $('#' + id);
    control.disabled = supported === false;
    if (control.disabled) control.checked = false;
  }
}

function updateOpacityControls() {
  for (const [sliderId, labelId, key, fallback] of opacitySettings) {
    const slider = $('#' + sliderId);
    slider.value = config[key] ?? fallback;
    $('#' + labelId).textContent = `${slider.value}%`;
  }
}

function renderMapColors() {
  for (const [inputId, outputId, , key, fallback] of mapColorSettings) {
    const value = validMapColor(config[key]) ? config[key].toLowerCase() : fallback;
    $('#' + inputId).value = value;
    $('#' + outputId).textContent = value.toUpperCase();
  }
}

function renderStatus() {
  $('#settings-status').textContent = loadFailed ? tr('settingsLoadFailed', 'Could not load settings.')
    : saveFailed ? tr('settingsSaveFailed', 'Could not save this change. Please try again.')
    : !initialized ? tr('settingsLoading', 'Loading settings…')
    : activeTab === 'appearance' ? tr('settingsAppearancePreview', 'Appearance previews live. Use Apply to save; Cancel to restore.')
    : tr('settingsAutoSave', 'Changes save automatically.');
  $('#settings-status').dataset.error = String(loadFailed || saveFailed);
  $('#btn-retry-settings').hidden = !loadFailed;
}

function receiveConfig(next) {
  configRevision++;
  const previous = confirmedConfig;
  confirmedConfig = { ...confirmedConfig, ...next };
  config = { ...confirmedConfig, ...Object.fromEntries(pendingConfig) };
  initialized = true;
  loadFailed = false;
  loadTranslations();
  populateLanguageDropdown();
  applyConfigToDOM();
  window.OverkotAppearanceEditor?.receiveConfig(confirmedConfig);
  layoutsSettings?.receiveConfig(confirmedConfig);
  widgetSizingSettings?.receiveConfig(confirmedConfig);
  if (paths && (previous.eeLogPath !== confirmedConfig.eeLogPath || previous.screenshotDir !== confirmedConfig.screenshotDir)) void loadGamePaths();
}

async function loadSettings() {
  loadFailed = false;
  renderStatus();
  const revision = configRevision;
  try {
    const state = await window.api.getState();
    platformSupport = state?.platformSupport || {};
    receiveShortcutWarnings(state);
    if (revision === configRevision) receiveConfig(state?.config || {});
  } catch {
    if (!initialized) loadFailed = true;
    renderStatus();
  }
}

function receiveShortcutWarnings(state) {
  shortcutWarnings.interactionHotkey = state?.overlayShortcutWarning || '';
  shortcutWarnings.overlayVisibilityHotkey = state?.visibilityShortcutWarning?.message || state?.visibilityShortcutWarning || '';
  renderOverlayHotkey();
}

function queueConfig(patch, defer = false) {
  for (const [key, value] of Object.entries(patch)) pendingConfig.set(key, value);
  config = { ...confirmedConfig, ...Object.fromEntries(pendingConfig) };
  saveFailed = false;
  renderStatus();
  if (!defer) void saveConfig();
}

async function saveConfig() {
  if (saving || !initialized || pendingConfig.size === 0) return;
  saving = true;
  while (pendingConfig.size > 0) {
    const changes = new Map(pendingConfig);
    const patch = Object.fromEntries(changes);
    const revision = configRevision;
    try {
      const result = await window.api.saveConfig(patch);
      if (result === false) throw new Error('Settings write failed');
      if (revision === configRevision) confirmedConfig = { ...confirmedConfig, ...patch };
    } catch {
      saveFailed = true;
      closeAfterSave = false;
      if (Object.keys(shortcutControls).some(key => changes.has(key)) || changes.has('allowSingleKeyShortcuts')) {
        shortcutMessage = tr('settingsHotkeyUnavailable', 'Could not save this shortcut. Try a different key or key combination.');
      }
    }
    for (const [key, value] of changes) {
      if (pendingConfig.get(key) === value) pendingConfig.delete(key);
    }
    // Failed changes return to the confirmed state, including secure sign-in storage.
    config = { ...confirmedConfig, ...Object.fromEntries(pendingConfig) };
    loadTranslations();
    populateLanguageDropdown();
    applyConfigToDOM();
  }
  saving = false;
  for (const resolve of configSaveWaiters) resolve();
  configSaveWaiters.clear();
  if (closeAfterSave) window.api.windowClose();
}

async function flushPendingSettings() {
  for (const timer of sliderTimers.values()) clearTimeout(timer);
  sliderTimers.clear();
  await saveConfig();
  if (saving) await new Promise(resolve => configSaveWaiters.add(resolve));
  return initialized && !saveFailed && pendingConfig.size === 0;
}

const dataCheckMessages = {
  signin: ['dataSignInRequired', 'Connect your avakot.dev account in Connections to download game data. Verified saved data remains available offline.'],
  checking: ['dataChecking', 'Checking for new data…'], updated: ['dataUpdated', 'New data downloaded. Open widgets are refreshed.'],
  current: ['dataCurrent', 'Your game data is up to date.'], partial: ['dataPartial', 'Some data could not be downloaded. Check again to retry.'],
  error: ['dataCheckFailed', 'Could not check for new data. Please try again.'],
};
function renderDataCheckStatus() {
  const checking = dataCheckStatus === 'checking';
  $('#btn-check-data').disabled = checking;
  $('#btn-check-data').setAttribute('aria-busy', String(checking));
  $('#btn-check-data').textContent = checking ? tr(...dataCheckMessages.checking) : tr('checkForNewData', 'Check for new data');
  const message = dataCheckMessages[dataCheckStatus];
  $('#data-check-status').textContent = message ? tr(...message) : '';
  $('#data-check-status').dataset.error = String(dataCheckStatus === 'error' || dataCheckStatus === 'partial');
}
async function checkForNewData() {
  if (dataCheckStatus === 'checking') return;
  dataCheckStatus = 'checking';
  renderDataCheckStatus();
  try {
    const result = await window.api.checkForDataUpdates();
    dataCheckStatus = ['updated', 'current', 'partial', 'signin'].includes(result?.status) ? result.status : 'error';
  } catch { dataCheckStatus = 'error'; }
  renderDataCheckStatus();
}

function renderMarket() {
  const signedIn = !!marketState?.user;
  $('#market-account-badge').textContent = signedIn ? tr('settingsSignedIn', 'Signed in') : tr('settingsSignedOut', 'Signed out');
  $('#market-account-badge').dataset.state = signedIn ? 'signed-in' : 'signed-out';
  $('#market-account-status').textContent = signedIn
    ? tr('settingsMarketAccount', 'Signed in as {name}').replace('{name}', marketState.user.displayHandle || 'Envoy')
    : marketState?.accountConnection?.busy ? tr('settingsMarketConnecting', 'Connecting Market with your avakot.dev account…')
      : marketState?.accountConnection?.error || tr('settingsMarketSharedSignedOut', 'Connect your avakot.dev account above to use Market.');
  $('#market-session-hint').textContent = tr('settingsMarketSharedSession', 'Market uses the account connection above. Signing out there also signs out of Market.');
  $('#btn-market-logout').hidden = true;
  $('#btn-market-connection-retry').hidden = signedIn || !avakotAccountState?.signedIn || marketState?.accountConnection?.requiresReconnect === true;
  $('#btn-market-connection-retry').disabled = marketState?.accountConnection?.busy === true || marketBusy;
  $('#btn-market-logout').disabled = marketBusy;
  $('#market-settings-status').hidden = !marketError;
  $('#market-settings-status').textContent = marketError ? tr(marketError, 'Could not update your market account. Please try again.') : '';
  $('#market-settings-status').dataset.error = String(!!marketError);
}
async function loadMarket() {
  const revision = marketRevision;
  try {
    const result = await window.api.marketGetState();
    if (result?.ok === false) throw new Error('Market unavailable');
    if (revision === marketRevision) marketState = result;
  } catch { marketError = 'settingsMarketUnavailable'; }
  renderMarket();
}
async function signOutMarket() {
  if (marketBusy) return;
  marketBusy = true;
  marketError = '';
  renderMarket();
  try {
    const result = await window.api.marketLogout();
    if (result?.ok === false) throw new Error('Market sign-out failed');
    marketState = result?.state || { user: null };
  } catch { marketError = 'settingsMarketLogoutFailed'; }
  finally { marketBusy = false; renderMarket(); }
}

function renderAvakotAccount() {
  const state = avakotAccountState;
  const signedIn = state?.signedIn === true;
  const restoring = state?.hasCredential === true && !signedIn;
  const authorizing = state?.authorizing === true || ['login', 'reconnect'].includes(avakotAccountAction);
  const busy = !!avakotAccountAction || state?.busy === true;
  const badge = $('#avakot-account-badge');
  badge.textContent = signedIn ? tr('settingsSignedIn', 'Signed in')
    : authorizing ? tr('settingsAvakotSigningIn', 'Signing in…')
      : restoring ? tr('settingsAvakotConnectionPending', 'Connection pending') : tr('settingsSignedOut', 'Signed out');
  badge.dataset.state = signedIn ? 'signed-in' : 'signed-out';
  $('#avakot-account-status').textContent = authorizing
    ? tr('settingsAvakotAwaitingBrowser', 'Complete sign-in in your browser, then return here. You can cancel below.')
    : signedIn ? tr('settingsAvakotSharedConnected', 'Connected to account.avakot.dev. Market uses this account after you approve access.')
      : restoring ? busy ? tr('settingsAvakotRestoring', 'Restoring your saved avakot.dev account connection…')
        : tr('settingsAvakotRestorePending', 'Your saved sign-in could not be restored. Retry the connection, or sign out to connect another account.')
      : tr('settingsAvakotDisconnected', 'Connect your avakot.dev account to share your Soulframe name and game status.');
  $('#avakot-account-details').hidden = !signedIn;
  $('#avakot-account-name').textContent = state?.account?.displayName || state?.account?.email || tr('settingsAvakotAccount', 'avakot.dev account');
  $('#avakot-account-email').textContent = state?.account?.email || '';
  $('#avakot-account-email-row').hidden = !state?.account?.email;
  $('#avakot-account-game-name').textContent = state?.game?.displayName || tr('settingsAvakotNamePending', 'Waiting for a resolved Soulframe name');
  $('#avakot-account-game-status').textContent = state?.game?.online === true
    ? tr('settingsAvakotOnline', 'Online') : tr('settingsAvakotOffline', 'Offline');
  $('#avakot-account-game-status').dataset.state = state?.game?.online === true ? 'online' : 'offline';
  $('#avakot-account-session-hint').hidden = !signedIn && !restoring;
  $('#avakot-account-session-hint').textContent = state?.sessionPersistent === true
    ? tr('settingsAvakotSavedSession', 'Your sign-in is stored securely on this computer.')
    : tr('settingsAvakotSessionOnly', 'This sign-in is for this session only. Sign in again after restarting Overkot.');
  $('#btn-avakot-account-login').hidden = signedIn || authorizing;
  $('#btn-avakot-account-login').disabled = busy;
  $('#btn-avakot-account-reconnect').hidden = !signedIn || state?.marketSignIn === true || authorizing;
  $('#btn-avakot-account-reconnect').disabled = busy;
  $('#btn-avakot-account-login').textContent = restoring
    ? tr('settingsAvakotRetryConnection', 'Retry connection') : tr('settingsAvakotSignIn', 'Sign in with avakot.dev');
  $('#btn-avakot-account-cancel').hidden = !authorizing;
  // A pending browser login must remain cancellable even while its promise is open.
  $('#btn-avakot-account-cancel').disabled = avakotAccountAction === 'cancel';
  $('#btn-avakot-account-logout').hidden = !signedIn && !restoring;
  $('#btn-avakot-account-logout').disabled = busy;
  $('#btn-avakot-account-open').disabled = avakotAccountAction === 'open';
  const error = avakotAccountError || state?.error || '';
  $('#avakot-account-error').hidden = !error;
  $('#avakot-account-error').textContent = error;
  $('#avakot-account-error').dataset.error = String(!!error);
}

async function loadAvakotAccount() {
  const revision = avakotAccountRevision;
  try {
    const state = await window.api.avakotAccountState();
    if (!state || state.ok === false) throw new Error('Account unavailable');
    if (revision === avakotAccountRevision) { avakotAccountState = state; avakotAccountError = ''; }
  } catch {
    if (revision === avakotAccountRevision) avakotAccountError = tr('settingsAvakotUnavailable', 'Could not load your avakot.dev account. Try signing in again.');
  }
  renderAvakotAccount();
  renderMarket();
}

async function changeAvakotAccount(action) {
  if (avakotAccountAction && action !== 'cancel' && action !== 'open') return;
  if (action === 'login' && avakotAccountState?.hasCredential && !avakotAccountState.signedIn) action = 'retry';
  // Managing the account opens a browser without interrupting pending sign-in.
  if (action === 'open') {
    try {
      const result = await window.api.avakotAccountOpen();
      if (result?.ok === false) throw new Error('Browser unavailable');
    } catch { avakotAccountError = tr('settingsAvakotBrowserFailed', 'Could not open account.avakot.dev in your browser. Please try again.'); }
    renderAvakotAccount();
    return;
  }
  const id = ++avakotAccountActionId;
  const revision = avakotAccountRevision;
  avakotAccountAction = action;
  avakotAccountError = '';
  renderAvakotAccount();
  try {
    const methods = { login: 'avakotAccountLogin', retry: 'avakotAccountLogin', reconnect: 'avakotAccountReconnect', cancel: 'avakotAccountCancel', logout: 'avakotAccountLogout' };
    const result = await window.api[methods[action]]();
    if (id !== avakotAccountActionId) return;
    if (result?.state && revision === avakotAccountRevision) avakotAccountState = result.state;
    if (result?.ok === false) avakotAccountError = result.message || tr('settingsAvakotActionFailed', 'Could not update your avakot.dev account. Please try again.');
    else if (!result?.state) await loadAvakotAccount();
  } catch {
    if (id === avakotAccountActionId) avakotAccountError = tr('settingsAvakotActionFailed', 'Could not update your avakot.dev account. Please try again.');
  } finally {
    if (id === avakotAccountActionId) { avakotAccountAction = ''; renderAvakotAccount(); }
  }
}

function renderGamePaths() {
  for (const [kind, def] of Object.entries(pathDefinitions)) {
    const snapshot = paths?.[def.snapshot];
    const input = $('#' + def.input);
    if (snapshot && !dirtyPaths.has(kind)) input.value = snapshot.override || '';
    const badge = $('#' + kind + '-path-badge');
    badge.textContent = !snapshot ? tr('settingsPathChecking', 'Checking…')
      : snapshot.found ? tr('settingsPathFound', 'Found') : tr('settingsPathMissing', 'Not found');
    badge.dataset.state = snapshot?.found ? 'found' : snapshot ? 'missing' : 'checking';
    $('#' + kind + '-effective-path').textContent = snapshot?.path || tr('settingsPathNotDetected', 'No location detected');
    const message = pathFeedback[kind];
    const status = $('#' + kind + '-path-status');
    status.hidden = !message;
    status.textContent = message?.text || (message?.key ? tr(message.key, 'Could not update this location. Please try again.') : '');
    status.dataset.error = String(message?.error === true);
    for (const element of $('#form-game-' + kind).querySelectorAll('button, input')) element.disabled = busyPaths.has(kind);
  }
}
async function loadGamePaths() {
  try {
    paths = await window.api.gamePathsGet();
    if (!paths?.eeLog || !paths?.screenshots) throw new Error('Missing game paths');
  } catch {
    for (const kind of Object.keys(pathDefinitions)) pathFeedback[kind] = { key: 'settingsPathsLoadFailed', error: true };
  }
  renderGamePaths();
}
async function saveGamePath(kind, value) {
  const def = pathDefinitions[kind];
  const result = await window.api.gamePathsSave({ [def.config]: value.trim() });
  if (result?.ok === false) {
    pathFeedback[kind] = { text: result.message || tr('settingsPathSaveFailed', 'Could not update this location.'), error: true };
    return;
  }
  if (!result?.paths) throw new Error('Missing game paths');
  paths = result.paths;
  dirtyPaths.delete(kind);
  pathFeedback[kind] = { key: 'settingsPathSaved', error: false };
}
async function changeGamePath(kind, action) {
  if (busyPaths.has(kind)) return;
  busyPaths.add(kind);
  delete pathFeedback[kind];
  renderGamePaths();
  try {
    let value = $('#' + pathDefinitions[kind].input).value;
    if (action === 'browse') {
      const result = await window.api.gamePathsChoose(kind);
      if (result?.canceled) return;
      if (!result?.path) throw new Error('No location chosen');
      value = result.path;
      $('#' + pathDefinitions[kind].input).value = value;
      dirtyPaths.add(kind);
      pathFeedback[kind] = { key: 'settingsPathSelected', error: false };
      return;
    } else if (action === 'reset') value = '';
    await saveGamePath(kind, value);
  } catch { pathFeedback[kind] = { key: 'settingsPathSaveFailed', error: true }; }
  finally { busyPaths.delete(kind); renderGamePaths(); }
}

function renderUpdate() {
  $('#settings-version').textContent = updateState?.currentVersion ? `v${updateState.currentVersion}` : '';
  const aboutVersion = $('#about-version');
  if (aboutVersion) aboutVersion.textContent = updateState?.currentVersion ? `v${updateState.currentVersion}` : '';
  $('#settings-update-status').textContent = updateState?.supported === false
    ? tr('settingsUpdatePlatform', 'In-app downloads are available in the installed Windows version of Overkot. Other builds can use a newer installer or package.') : '';
}

function populateWidgetTutorials() {
  const select = $('#widget-tutorial-select');
  const selected = select.value;
  const options = Object.entries(OverkotTutorials.WIDGET_TUTORIALS)
    .filter(([id]) => id !== 'title-tracker' || window.i18n?.titleTrackerEnabled === true)
    .map(([id, tutorial]) => [id, tr(OverkotTutorials.widgetTutorialPrefix(id) + 'Name', tutorial.name)])
    .sort(([, left], [, right]) => left.localeCompare(right, document.documentElement.lang || 'en'))
    .map(([id, name]) => {
      const option = document.createElement('option'); option.value = id; option.textContent = name; return option;
    });
  select.replaceChildren(...options);
  if (options.some(option => option.value === selected)) select.value = selected;
}

async function replayTutorial(id) {
  const status = $('#tutorial-replay-status');
  status.hidden = true;
  $('#btn-replay-tutorial').disabled = $('#btn-replay-widget-tutorial').disabled = true;
  try {
    if (await window.api.openTutorial(id) === false) throw new Error('Tutorial did not open');
  } catch {
    status.textContent = tr('settingsTutorialOpenFailed', 'Could not open the tutorial. Try again.');
    status.dataset.error = 'true'; status.hidden = false;
  } finally {
    $('#btn-replay-tutorial').disabled = $('#btn-replay-widget-tutorial').disabled = false;
  }
}

function bindEvents() {
  $('#copy-player-tracking-report').addEventListener('click', async () => {
    const result = $('#player-tracking-report-result');
    result.textContent = '';
    let copied = false;
    try { copied = await window.api.copyPlayerTrackingReport(); } catch { /* Clipboard can be unavailable. */ }
    result.textContent = copied ? tr('gfCopied', 'Copied!') : tr('gfActionFailed', 'Action failed — try again');
  });
  $('#close-btn').addEventListener('click', () => {
    stopShortcutCapture();
    for (const timer of sliderTimers.values()) clearTimeout(timer);
    sliderTimers.clear();
    if (pendingConfig.size > 0) { closeAfterSave = true; void saveConfig(); }
    else window.api.windowClose();
  });
  $('#btn-retry-settings').addEventListener('click', loadSettings);
  $('#settings-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) setTab(tab.dataset.tab);
  });
  $('#settings-tabs').addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('.settings-tab')];
    const index = tabs.findIndex(tab => tab.dataset.tab === activeTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % tabs.length : event.key === 'ArrowUp' ? (index - 1 + tabs.length) % tabs.length : -1;
    if (next >= 0) { event.preventDefault(); setTab(tabs[next].dataset.tab, true); }
  });
  for (const [id, [key]] of Object.entries(checkboxSettings)) {
    $('#' + id).addEventListener('change', () => {
      if (key === 'allowSingleKeyShortcuts') {
        stopShortcutCapture();
        shortcutMessage = '';
      }
      queueConfig({ [key]: $('#' + id).checked });
      if (key === 'allowSingleKeyShortcuts') renderOverlayHotkey();
      if (key === 'marketRememberSession') renderMarket();
      if (key === 'livePlayerTracking') { renderPlayerTracking(); renderMoonsteelAlertControls(); }
    });
  }
  for (const [id, key] of moonsteelCheckboxes) $('#' + id).addEventListener('change', () => changeMoonsteelAlert(key, $('#' + id).checked));
  for (const [suffix, key] of moonsteelSliders) {
    const slider = $('#slider-moonsteel-' + suffix);
    slider.addEventListener('input', () => {
      changeMoonsteelAlert(key, Number(slider.value), true);
      clearTimeout(sliderTimers.get('moonsteelAlert'));
      sliderTimers.set('moonsteelAlert', setTimeout(() => { sliderTimers.delete('moonsteelAlert'); void saveConfig(); }, 30));
    });
    slider.addEventListener('change', () => {
      clearTimeout(sliderTimers.get('moonsteelAlert')); sliderTimers.delete('moonsteelAlert');
      changeMoonsteelAlert(key, Number(slider.value));
    });
  }
  $('#color-moonsteel-alert').addEventListener('change', () => changeMoonsteelAlert('color', $('#color-moonsteel-alert').value.toLowerCase()));
  $('#moonsteel-monitor-select').addEventListener('change', () => changeMoonsteelAlert('monitor', $('#moonsteel-monitor-select').value));
  $('#moonsteel-sound-select').addEventListener('change', () => changeMoonsteelAlert('sound', $('#moonsteel-sound-select').value));
  $('#btn-test-moonsteel-alert').addEventListener('click', () => void previewMoonsteelAlert());
  for (const [inputId, outputId, resetId, key, fallback] of mapColorSettings) {
    const input = $('#' + inputId);
    input.addEventListener('input', () => {
      if (validMapColor(input.value)) $('#' + outputId).textContent = input.value.toUpperCase();
    });
    input.addEventListener('change', () => {
      if (validMapColor(input.value)) queueConfig({ [key]: input.value.toLowerCase() });
      renderMapColors();
    });
    $('#' + resetId).addEventListener('click', () => {
      queueConfig({ [key]: fallback });
      renderMapColors();
    });
  }
  $('#dock-edge-select').addEventListener('change', () => queueConfig({ dockEdge: $('#dock-edge-select').value }));
  $('#window-close-focus-select').addEventListener('change', () => queueConfig({ windowCloseFocus: $('#window-close-focus-select').value }));
  $('#dock-display-select').addEventListener('change', () => changeOverlayDisplay($('#dock-display-select').value));
  for (const [key, { id, defaultValue }] of Object.entries(shortcutControls)) {
    const button = $('#' + id + '-capture');
    button.addEventListener('click', () => startShortcutCapture(key));
    button.addEventListener('blur', () => {
      if (recordingShortcut === key) stopShortcutCapture();
    });
    $('#' + id + '-reset').addEventListener('click', () => changeShortcut(key, defaultValue));
  }
  document.addEventListener('keydown', captureShortcut, true);
  document.addEventListener('keyup', captureShortcut, true);
  for (const name of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu', 'wheel']) {
    document.addEventListener(name, captureMouseEvent, { capture: true, passive: false });
  }
  window.addEventListener('blur', stopShortcutCapture);
  for (const [sliderId, labelId, key] of opacitySettings) {
    const slider = $('#' + sliderId);
    slider.addEventListener('input', () => {
      $('#' + labelId).textContent = `${slider.value}%`;
      queueConfig({ [key]: Number(slider.value) }, true);
      clearTimeout(sliderTimers.get(key));
      sliderTimers.set(key, setTimeout(() => { sliderTimers.delete(key); void saveConfig(); }, 30));
    });
    slider.addEventListener('change', () => {
      clearTimeout(sliderTimers.get(key));
      sliderTimers.delete(key);
      queueConfig({ [key]: Number(slider.value) });
    });
  }
  $('#lang-dropdown-selected').addEventListener('click', () => {
    const opening = $('#lang-dropdown-options').classList.contains('hidden');
    $('#lang-dropdown-options').classList.toggle('hidden', !opening);
    $('#lang-dropdown-selected').setAttribute('aria-expanded', String(opening));
    if (opening) $('#lang-dropdown-options .selected')?.focus();
  });
  $('#lang-dropdown-options').addEventListener('click', event => {
    const option = event.target.closest('.lang-option');
    if (!option) return;
    queueConfig({ language: option.dataset.langCode });
    closeLanguageDropdown(true);
    populateLanguageDropdown();
    loadTranslations();
  });
  $('#lang-dropdown').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeLanguageDropdown(true); }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    $('#lang-dropdown-options').classList.remove('hidden');
    $('#lang-dropdown-selected').setAttribute('aria-expanded', 'true');
    const options = [...document.querySelectorAll('.lang-option')];
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
    options[next]?.focus();
  });
  document.addEventListener('click', event => { if (!$('#lang-dropdown').contains(event.target)) closeLanguageDropdown(); });
  $('#btn-reset-positions').addEventListener('click', () => window.api.resetWidgetPositions());
  $('#btn-reset-sizes').addEventListener('click', () => window.api.resetWidgetSizes());
  $('#btn-open-widgets').addEventListener('click', () => window.api.openWidgets());
  $('#btn-replay-tutorial').addEventListener('click', () => void replayTutorial('app'));
  $('#chk-tutorials-enabled').addEventListener('change', () => void setTutorialsEnabled($('#chk-tutorials-enabled').checked));
  $('#btn-replay-widget-tutorial').addEventListener('click', () => void replayTutorial($('#widget-tutorial-select').value));
  $('#btn-calendar-settings').addEventListener('click', () => window.api.openCalendarSettings());
  $('#btn-open-market').addEventListener('click', () => window.api.openMarket());
  $('#btn-market-logout').addEventListener('click', signOutMarket);
  $('#btn-market-connection-retry').addEventListener('click', async () => {
    marketBusy = true; renderMarket();
    try { await window.api.marketConnectionRetry(); await loadMarket(); }
    catch { marketError = 'settingsMarketUnavailable'; }
    finally { marketBusy = false; renderMarket(); }
  });
  for (const action of ['login', 'reconnect', 'cancel', 'logout', 'open']) {
    $('#btn-avakot-account-' + action).addEventListener('click', () => void changeAvakotAccount(action));
  }
  $('#btn-check-app-updates').addEventListener('click', () => window.api.openUpdates());
  $('#btn-changelog').addEventListener('click', () => window.api.openChangelog());
  $('#btn-check-data').addEventListener('click', checkForNewData);
  for (const [kind, def] of Object.entries(pathDefinitions)) {
    $('#' + def.input).addEventListener('input', () => dirtyPaths.add(kind));
    $('#form-game-' + kind).addEventListener('submit', event => { event.preventDefault(); void changeGamePath(kind, 'save'); });
    $('#btn-browse-' + kind).addEventListener('click', () => void changeGamePath(kind, 'browse'));
    $('#btn-reset-' + kind).addEventListener('click', () => void changeGamePath(kind, 'reset'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const selectSection = section => {
    if (section === 'connections' || section === 'moonsteel-alert') setTab(section, true);
  };
  window.api.onSettingsSection?.(selectSection);
  selectSection(new URLSearchParams(window.location?.search || '').get('section'));
  loadTranslations();
  bindEvents();
  layoutsSettings = window.LayoutsSettings?.mount({ api: window.api, flushPending: flushPendingSettings });
  widgetSizingSettings = window.WidgetSizingSettings?.mount({ api: window.api, flushPending: flushPendingSettings });
  window.api.onConfigChanged?.(receiveConfig);
  window.api.onStateUpdate?.(receiveShortcutWarnings);
  const removeDisplayListener = window.api.onOverlayDisplaysChanged?.(receiveOverlayDisplays);
  const removeMouseListener = window.api.onShortcutMouseCaptured?.(commitMouseShortcut);
  window.api.onMarketChanged?.(snapshot => { marketRevision++; marketState = snapshot; marketError = ''; renderMarket(); });
  const removeAccountListener = window.api.onAvakotAccountState?.(snapshot => {
    avakotAccountRevision++;
    avakotAccountState = snapshot;
    avakotAccountError = '';
    renderAvakotAccount();
    renderMarket();
  });
  const removeTrackingListener = window.api.onPlayerTrackingChanged?.(snapshot => {
    playerTrackingRevision++; playerTrackingState = snapshot; renderPlayerTracking();
  });
  window.addEventListener('beforeunload', () => {
    layoutsSettings?.dispose();
    widgetSizingSettings?.dispose();
    stopShortcutCapture(); removeMouseListener?.(); removeAccountListener?.(); playerTrackingRevision++; removeTrackingListener?.();
    overlayDisplaysRevision++; removeDisplayListener?.();
  }, { once: true });
  window.api.onUpdateChanged?.(snapshot => { updateState = snapshot; renderUpdate(); });
  void loadSettings();
  void loadMarket();
  void loadAvakotAccount();
  void loadGamePaths();
  void loadPlayerTracking();
  void loadOverlayDisplays();
  window.api.getUpdateState?.().then(snapshot => { updateState = snapshot; renderUpdate(); }).catch(() => {});
});
