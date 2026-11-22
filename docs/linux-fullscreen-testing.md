# Linux borderless/fullscreen overlay verification

X11 window managers can place an active fullscreen game above ordinary docks
and always-on-top windows. Overkot's Linux helper requests critical notification,
notification, then dock types, in that order, and asks the compositor to retain
compositing. Normal popouts remain transient windows so Settings can still move
and resize. These are window-manager requests; support varies by desktop.

## Automated native check

Run `scripts/check-linux-fullscreen.js` on a disposable Linux X11 desktop, such
as Xvfb inside a container. It sends real pointer and keyboard input. The explicit
`OVERKOT_ISOLATED_X11_QA=1` flag acknowledges that requirement. Do not run it in
your working desktop session.

Requirements are a C compiler, Xlib development files, `xprop`, `xwininfo`,
`xdotool`, a running X server and window manager, and a freshly built local Linux
Overkot/Electron runtime containing `resources/bin/overkot-overlay-window`.
`npm run build:overlay:linux` rebuilds the helper when preparing source QA.

```sh
OVERKOT_ISOLATED_X11_QA=1 \
OVERKOT_PACKAGED_DIRECTORY=/path/to/linux-unpacked \
node scripts/check-linux-fullscreen.js --disable-dev-shm-usage
```

`DISPLAY` must identify the isolated desktop. The runtime directory contains the
`overkot` executable and its resources. `--app-root=/path/to/resources/app.asar`
also exercises a bundled main process, preload and renderer. For that mode, keep
the packaged `resources/bin/overkot-overlay-window` beside the runtime; the check
copies it into its disposable runtime. The default app root is the source tree.

The check creates a fresh local profile, blocks network requests and game-process
discovery, and starts an independent native Xlib window as the fake game. It:

- Verifies actual X11 window types and the compositor-bypass property.
- Alternates a screen-sized borderless window and EWMH fullscreen four times.
- Checks native stacking above the active fake game for the rail and widgets.
- Sends real clicks through every passive overlay and verifies game delivery and
  foreground ownership.
- Uses the actual Shift+F1 shortcut to focus the rail and return to pass-through.
- Opens Settings, checks its ordinary type and transient relationship, and
  verifies its focus, stacking, native movement and resizing. Settings must stay
  natively visible above the game while the rail auto-hides.
- Uses Shift+F2 to hide everything, changes game mode, and verifies Shift+F1 does
  not reveal hidden windows; restoring preserves layering and pass-through.
- Saves native desktop screenshots and `result.json` under
  `output/linux-fullscreen-check-*`; failures save `failure.json`.

An isolated Docker run may require `--no-sandbox` because its sandbox prerequisites
are unavailable. This is a test-environment argument, and the JSON records it;
it is not part of the application launch configuration.

## Local verification recorded for this change

The source main process and renderer ran with packaged Electron 40.10.6 and the
helper at its packaged `resources/bin` path, an independent native game fixture,
real shortcuts and real input, under Debian KWin X11 5.27.5 (`kwin-x11` package
`4:5.27.5-3`) and Xvfb 21.1.7. The complete check passed. The isolated container
ran as an ordinary user with Chromium's sandbox disabled for this QA run.
Local artifacts are in `output/linux-fullscreen-qa/kwin-final-pass/`. This was a
source-runtime integration test, not a new complete distribution-package build.

A temporary control run with the new native hint application disabled reproduced
the rail stacking below the active game. An intermediate implementation also
exposed Settings below critical widget windows; raising its parent before the
popout corrected this while preserving native resizing.

Arch Openbox 3.6.1 (`openbox` package `3.6.1-14`, Xvfb 21.1.25) failed the native
stacking assertion with the new hints. Its supported fallback does not provide
the required layer above the active fullscreen window. Do not treat this change
as a universal Linux fullscreen guarantee. Actual game sessions, current Plasma,
GNOME/Mutter, and Wayland/XWayland compositor behavior still need desktop testing.

## Acceptance on the reported desktop

Record `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`, the desktop/compositor version,
and the Overkot package version. With the game focused, verify the rail, attached
widgets and floating widgets remain visible when changing from windowed mode to
borderless fullscreen, back to windowed mode, and back to borderless fullscreen.
Also check the game's fullscreen setting if it exposes a distinct option.

With click-through enabled, clicks over the rail and widgets must reach the game
without taking its focus. Shift+F1 must allow overlay interaction; Settings and
other popouts must appear above the widgets, accept keyboard input, and retain
their usual move/resize behavior. Press Shift+F1 again and verify pass-through.

Hide with Shift+F2, change game modes and press Shift+F1: all hidden windows must
remain hidden. Restore with Shift+F2 and verify placement and stacking. Repeat
after Alt+Tab and, if available, on a second monitor. These checks also identify
compositor policies that cannot be established by Xvfb testing.
