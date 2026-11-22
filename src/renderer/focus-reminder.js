'use strict';
window.focusReminder.onState(state => {
  const reminder = document.getElementById('focus-reminder');
  const labels = state.labels || {};
  document.documentElement.lang = state.locale || 'en';
  if (state.font) document.body.style.fontFamily = state.font;
  reminder.querySelector('strong').textContent = labels.focusReady || 'Your overlay is ready';
  reminder.dataset.edge = state.edge;
  reminder.style.setProperty('--arrow-offset', `${state.arrowOffset}px`);
  const message = document.getElementById('focus-message');
  if (state.warning) {
    message.textContent = labels.focusUnavailable || 'Your focus shortcut is unavailable.';
    document.getElementById('focus-detail').textContent = labels.focusTrayHint || 'Open Overkot from the tray, then choose another shortcut in Settings → Overlay.';
  } else {
    const [before, after] = (labels.focusPress || 'Press {hotkey} to focus').split('{hotkey}');
    const hotkey = document.createElement('kbd');
    hotkey.id = 'focus-hotkey';
    hotkey.textContent = String(state.hotkey || 'Shift+F1').split('+').join(' + ');
    message.replaceChildren(before, hotkey, after);
    document.getElementById('focus-detail').textContent = labels.focusSettingsHint || 'Change your shortcut in Settings → Overlay.';
  }
});
