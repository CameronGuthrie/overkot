'use strict';

const OverlayShortcuts = (() => {
  const defaults = { interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Shift+F2' };
  const bindings = Object.keys(defaults);
  const modifiers = new Set(['ctrl', 'shift', 'alt', 'super', 'altgr']);
  const mouseInputs = ['Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'Mouse5', 'WheelUp', 'WheelDown', 'WheelLeft', 'WheelRight'];
  const namedKeys = new Set(('plus space tab capslock numlock scrolllock backspace delete insert enter up down left right home end '
    + 'pageup pagedown escape volumeup volumedown volumemute medianexttrack mediaprevioustrack mediastop mediaplaypause '
    + 'printscreen numdec numadd numsub nummult numdiv').split(' '));

  function shortcutParts(value, platform) {
    if (typeof value !== 'string' || !value || value.length > 100) return [];
    const commandOrControl = (platform || (typeof process !== 'undefined' && process.platform)) === 'darwin' ? 'super' : 'ctrl';
    const aliases = { control: 'ctrl', command: 'super', cmd: 'super', meta: 'super', option: 'alt',
      commandorcontrol: commandOrControl, cmdorctrl: commandOrControl, return: 'enter', esc: 'escape' };
    return value.toLowerCase().split('+').map(part => Object.hasOwn(aliases, part) ? aliases[part] : part);
  }

  function shortcutIdentity(value, platform) {
    return shortcutParts(value, platform).sort().join('+');
  }

  function isMouseShortcut(value) {
    return typeof value === 'string' && mouseInputs.includes(value.split('+').at(-1));
  }

  function nativeMouseBinding(value, platform) {
    if (!isMouseShortcut(value)) return null;
    const parts = shortcutParts(value, platform);
    const modifierNames = ['Ctrl', 'Alt', 'Shift', 'Super'].filter(mod => parts.includes(mod.toLowerCase()));
    return [...modifierNames, value.split('+').at(-1)].join('+');
  }

  function validShortcut(value, allowSingle, platform) {
    const parts = shortcutParts(value, platform);
    const key = parts.pop();
    if (!key || (!parts.length && (!allowSingle || key === 'escape'))) return false;
    if (!parts.every(part => modifiers.has(part)) || new Set(parts).size !== parts.length) return false;
    if (isMouseShortcut(value)) return allowSingle && !parts.includes('altgr')
      && (platform || (typeof process !== 'undefined' && process.platform)) === 'win32';
    return namedKeys.has(key) || /^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|num[0-9])$/i.test(key)
      || /^[!@#$%^&*():;=,_<>.\/?"'~`{}\[\]|\\-]$/.test(key);
  }

  function normalizeShortcuts(config, platform) {
    const allowSingleKeyShortcuts = config.allowSingleKeyShortcuts === true;
    const used = new Set();
    const normalized = { allowSingleKeyShortcuts };
    // Preserve usable custom bindings before allocating defaults to missing bindings.
    for (const key of bindings) {
      const value = config[key], id = shortcutIdentity(value, platform);
      if (!validShortcut(value, allowSingleKeyShortcuts, platform) || used.has(id)) continue;
      normalized[key] = value;
      used.add(id);
    }
    for (const key of bindings) {
      if (Object.hasOwn(normalized, key)) continue;
      const fallback = [defaults[key], ...Object.values(defaults)].find(value => !used.has(shortcutIdentity(value, platform)));
      normalized[key] = fallback;
      used.add(shortcutIdentity(fallback, platform));
    }
    return normalized;
  }

  function shortcutPatch(current, patch, platform) {
    const next = { ...current, ...patch };
    if (typeof next.allowSingleKeyShortcuts !== 'boolean') return null;
    for (const key of bindings) {
      if (Object.hasOwn(patch, key) && !validShortcut(patch[key], next.allowSingleKeyShortcuts, platform)) return null;
    }
    if (shortcutIdentity(next.interactionHotkey, platform) === shortcutIdentity(next.overlayVisibilityHotkey, platform)) return null;
    const normalized = normalizeShortcuts(next, platform);
    return Object.fromEntries(bindings.filter(key => normalized[key] !== current[key] || Object.hasOwn(patch, key))
      .map(key => [key, normalized[key]]));
  }

  return { bindings, defaults, isMouseShortcut, nativeMouseBinding, validShortcut, shortcutIdentity, normalizeShortcuts, shortcutPatch };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OverlayShortcuts;
else window.OverlayShortcuts = OverlayShortcuts;
