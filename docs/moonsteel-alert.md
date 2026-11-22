# Moonsteel alerts

Settings → Moonsteel alert controls the monitor-edge glow and sound for newly
confirmed Moonsteel weapon drops. The default flash uses the same purple as the
shiny map marker (`#da75ff`). Its centre remains transparent, and the alert never
takes keyboard focus or captures mouse input.

Choose the flash colour, intensity, edge width, inward softness, duration and
pulse speed. Target the primary monitor, the monitor under the pointer, or all
monitors. Sound has a separate switch, three tones and a volume control; targeting
all monitors still plays the sound once. System reduced motion uses a gentle
fade instead of repeated pulses. **Test alert** previews the current choices,
including when automatic Moonsteel alerts are off.

Detection runs in the main process and does not depend on an open minimap,
expanded map, map markers being enabled, or dungeon map alignment. It requires
live player tracking on Windows and fresh game observations of a nearby weapon
confirmed as Moonsteel. Ordinary weapons and unknown shiny status do not alert.
Repeated observations of the same drop do not repeat its alert. These preferences
are independent of timer popup and timer sound preferences.

Validation:

```powershell
npm test
node scripts/check-settings.js --source --moonsteel-only
node scripts/check-moonsteel-alert.js --source
node scripts/check-settings.js --moonsteel-only
node scripts/check-moonsteel-alert.js --packaged
```

Native checks use isolated profiles and synthetic detections. They do not attach
to the game or modify the user's settings.
