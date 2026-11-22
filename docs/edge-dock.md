# Edge Dock preview

The bar spans the chosen display edge and is 48 device-independent pixels thick.
It keeps the full display height or width when the Windows taskbar changes the
work area, and repairs native window-size changes without restarting. Attached
panels still fit within the usable work area beside the taskbar.
Settings → Overlay chooses Top, Bottom, Left or Right and enables auto-hide.
With auto-hide enabled, the native bar hides completely after 850 ms away.
Shift + F1 reveals the bar and enables interaction. Moving the pointer to its
screen edge reveals it only while overlay interaction has focus. Game cursor
movement or dragging keeps a collapsed bar hidden. Open attached widgets use
the space released by the hidden bar, then move back when it returns. Hovering
an attached widget during focused interaction keeps a visible bar open without
reviving an already hidden bar.

Use the widget picker to add or remove app icons. Click an icon to open its
panel, then click again to hide it. Attached panels stay beside the bar and
arrange in shelves when several are open. Floating panels retain their position
when hidden and shown. Hidden panels stay mounted, preserving in-progress UI.
Market continues to open its full browsing window from its icon.
Hold the left mouse button and drag an icon to reorder it. The order persists,
including when a widget is removed and added again. Alt + the arrow along the
bar moves a focused icon using the keyboard.

Focus the overlay first (Shift + F1 by default), then hold Shift to arrange
panels. Focus leaving the overlay ends arrangement even while Shift remains held.
A dark, click-through scrim with a 24-pixel grid
sits above other applications and below the overlay on each display. While
Shift is held, drag anywhere in a panel, including its controls, or use the
corner resize grip. Movement is free during the gesture. On releasing Shift,
moved floating panels align to the nearest grid point within the display's
usable area. Existing untouched positions remain unchanged.

To attach a floating widget, drag the pointer onto the rail or within 24 pixels
of it. The rail highlights **Release to dock**. Release the mouse (or Shift) to
attach. The widget's app icon continues to control visibility in either state.

Shift + F2 hides or restores the bar, widgets, popouts and alerts. Change it in
Settings → Overlay by selecting the shortcut and pressing a modifier with a key.
Shift + F1 enables interaction with the launcher bar and with attached and floating
widgets when click-through is enabled. Returning focus to the game restores
click-through on the bar and every widget panel. The launcher always requires
interaction or layout mode, including when widget click-through is disabled. A tray icon can
restore the overlay when hidden. Minimize uses the same hide state as Shift + F2;
either the visibility shortcut or the tray restores it. A conflicting shortcut
is rejected.

Widget title strips are removed. Settings → Appearance → Widget outline opacity
can make card outlines completely invisible, including in High Contrast.
Dungeon maps no longer display room names. In a dungeon, expanding Mini-Map
hides its panel and opens a large transparent outline map over the game. Drag to
pan, scroll to zoom, or use the crosshair control to center and fit the map.
The diagonal arrows expand it. Escape returns input and focus to Soulframe while
preserving the visible map and its pan/zoom. Close restores Mini-Map; leaving the
dungeon also closes the large map. After returning focus to the game, Shift + F1
enables the map controls again. The large map stays click-through outside
interaction mode, including after changing the interaction shortcut. Closing a
map that enabled interaction returns the panels to their prior click-through state.
Panning releases its mouse capture when focus leaves the overlay, interaction is
turned off, or the button is released outside the map. Native foreground tracking
also releases input if Chromium retains an outdated active-window state.

Existing profiles retain enabled widgets and saved bounds. Widgets start closed
on the first upgrade; old collapse controls and free/grid layout preferences no
longer affect the interface. Subsequent panel visibility and attachment choices
persist. Widget position reset returns panels to the rail.

## Local verification

- `npm test` covers geometry, key-monitor cleanup, migration, Settings shortcuts
  and renderer editing behavior.
- `node scripts/check-edge-dock.js` launches the actual app with an isolated
  profile and local data fixture, exercises native windows and captures images.
- `node scripts/check-edge-dock-package.js` verifies the actual packaged
  renderers and preload inside `app.asar`, using the packaged Electron runtime.
- `npm run build:portable` produces a separate Edge Dock preview executable in
  `dist/`; build commands do not publish.

Try the portable with Soulframe in borderless or windowed mode: check all four
edges, icon reordering, auto-hide while widgets are open, focused Shift dragging
across displays, docking, dungeon expansion and the visibility shortcut while
the game owns focus. Windows observes
Shift, the left mouse button and foreground process ownership through a hidden
helper, so releasing Shift or returning focus to another application
ends layout mode. Other platforms use focused renderer
key events for their experimental layout controls.
