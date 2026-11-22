'use strict';

/** Select a display backend before Electron becomes ready. */
function configureLinuxDisplay({ platform = process.platform, env = process.env, commandLine } = {}) {
  if (platform !== 'linux') return {};
  const waylandSession = !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland';
  let selected = commandLine.getSwitchValue('ozone-platform');
  const hint = commandLine.getSwitchValue('ozone-platform-hint');
  const explicit = commandLine.hasSwitch('ozone-platform') || commandLine.hasSwitch('ozone-platform-hint');
  if (!selected && hint) selected = hint;
  const automatic = !selected || selected === 'auto';
  if (automatic && env.DISPLAY) {
    // This overlay needs global window positions for its rail and grid. Resolve
    // Electron's "auto" to XWayland even on Wayland desktops. The obsolete,
    // desktop-wide ELECTRON_OZONE_PLATFORM_HINT must not override this choice.
    selected = 'x11';
    commandLine.appendSwitch('ozone-platform', selected);
  } else if (automatic && waylandSession) {
    selected = 'wayland';
    commandLine.appendSwitch('ozone-platform', selected);
  } else if (selected && !commandLine.getSwitchValue('ozone-platform')) {
    // Keep deliberate legacy command-line overrides working on Electron 40.
    commandLine.appendSwitch('ozone-platform', selected);
  }

  const displayBackend = selected === 'x11' ? (waylandSession ? 'xwayland' : 'x11')
    : selected === 'wayland' ? 'wayland' : selected === 'auto' ? 'auto' : 'unknown';
  if (selected === 'wayland' || (waylandSession && selected !== 'x11')) {
    const disabled = commandLine.getSwitchValue('disable-features').split(',');
    if (!disabled.includes('GlobalShortcutsPortal')) {
      const enabled = commandLine.getSwitchValue('enable-features').split(',').filter(Boolean);
      if (!enabled.includes('GlobalShortcutsPortal')) enabled.push('GlobalShortcutsPortal');
      commandLine.appendSwitch('enable-features', enabled.join(','));
    }
  }
  return { displayBackend, displaySelection: explicit && !automatic ? 'explicit' : 'automatic' };
}

module.exports = { configureLinuxDisplay };
