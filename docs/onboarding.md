# Tutorials and the focus reminder

On each fresh launch, a small speech bubble points to the Overkot icon on the
dock and shows your configured focus shortcut. It passes mouse input through
and cannot take keyboard focus. It disappears when you use the shortcut or
after 60 seconds. Hiding and restoring the overlay does not restart it.
A launch to the tray waits until the overlay is shown before displaying it.

The first time you focus Overkot with the shortcut, a short tutorial explains
the dock, widgets, layout controls, game connection and settings. Starting the
tutorial after intentional focus keeps startup from interrupting your game.
Use Back and Next to move through the cards, or Skip / Escape to dismiss the
tour. Finished and skipped tours are remembered in your local profile.

Each widget has its own short introduction when you first open it after the
app tour. Restoring saved panels at startup does not bring up tutorial windows
over your game. Settings lets you replay the app tour or a selected widget
tutorial whenever you need a refresher.

Every app and widget tour has a **Turn off all tours** button at the bottom.
Settings → Tutorials also has **Enable all tutorials**, which controls automatic
tours across the app. This preference survives restarts and preserves completed
tours. Turning tutorials back on allows unfinished tours to appear on their next
normal trigger. Manual replay stays available while automatic tutorials are off.

Validation: `node --test test/focusReminder.test.js test/tutorials.test.js`
checks reminder placement/lifetime and tutorial progress. On Windows,
`node scripts/check-onboarding.js` uses an isolated profile and mock game input
to exercise a fresh launch, app and widget tours, a process restart, Settings
replay and native click-through/focus behavior. It uses the local fixture feed
at `output/data-feed` and writes screenshots and reports beneath `output`.
