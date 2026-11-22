# Midrath clock

Enable **Clock** in Modules. Mora and Saphene cross the sky during daytime;
Iridis crosses in the opposite direction at night. The module shows the sky and
live countdown, with no alignment button, calibration panel or status footer.
It supports floating/docked layouts, collapse, resizing, click-through, themes
and opacity. Artwork is local SVG; there are no image or font downloads.

## One clock, one cycle calculation

`src/modules/worldClock.js` owns the app's shared server clock. Every window
receives a sample of that clock and advances it using monotonic elapsed time.
`src/renderer/world-cycle.js` is the single definition of Midrath's timing rules.
Old `worldClockCalibration` preferences are ignored: users cannot acquire
different phase anchors through settings or IPC.

The previous May 2026 measurements (`1779464368`, `2881.1875`) have been replaced
with the game's sky synchronization formula:

```js
rate = Math.fround(0.00833);
period = 24 / rate;
shift = Math.fround(period / 2);
hour = positiveModulo(serverUnixSeconds - 1391990400 + shift, period) / period * 24;
```

Daytime is 06:00–22:00. The resulting cycle lasts `2881.1525878749844` seconds;
day lasts about 32m 0.768s and night 16m 0.384s. Both float32 conversions matter.
Rounding the rate or fitting a period to a few observations accumulates error.
No observed dawn timestamp or per-machine correction is needed.

### Evidence from the installed game, 12 September 2026

Read-only analysis used build `2026.08.20.11.07`, whose executable SHA-256 is
`20c4f48ffba2bbdd59995d2f70934340ba207b319f95e4b663be4ccfe666acd7`.
The addresses below are preferred image VAs for that build, not runtime hooks.

- `SF/Scripts/Levels/DayNight.lua`, `SyncSkiesWithWorldState`, reads the main
  DynamicSky's rate, calculates `24 / rate`, and passes the rate and half-period
  to game-rules atom `0xdf6c58c8` before setting sky time.
- That atom's native binding at `0x141a62650` casts both arguments to float32,
  calculates the period as a double, adds the half-period to game time, applies
  `fmod`, and converts the result to 24-hour sky time.
- Its time reader at `0x1402d8e20` subtracts the fixed epoch `1391990400` from
  the game's shared server Unix time. The WorldSeed blob is not an input.
- The DynamicSky rate getter at `0x141a45960` reads float32 at `+0x5b8`;
  the main-sky flag getter at `0x141a45cb0` reads `+0x87f`. The running game's
  active main sky had rate `0.008329999633133411` (float32 `0.00833`).
- `SF/Interface/Map.lua`, prototype 51, uses 06:00/22:00 transitions. Its
  displayed countdown uses nominal `0.0083333333`, which can differ by less
  than a second from the precise next transition.

At server time `1789210848.7812953`, the native formula gave hour
`2.1926212790724944`; the live main sky read `2.1542434692382812`, approximately
4.61 real seconds behind. The main sky also advances locally between syncs, so
frame timing/client simulation can introduce a small difference. The old model
was about two minutes away. This validates the formula without claiming an
exact frame-by-frame match or adding a new empirical offset. These development
checks only read the game; the shipped clock does not scan game memory.

## Server synchronization

The public [world-state endpoint](https://api.soulframe.com/cdn/worldState.php)
supplies Unix time. Its current response does not supply a day/night phase;
the native formula above derives it. Overkot checks once per 24 hours while
the clock is enabled, with gzip/deflate/Brotli support, a 1 MiB response limit
and no account credentials. All windows share the request and its cooldown.

The JSON `Time` is CDN-cached. The reader cross-checks `Time + Age` against HTTP
`Date`, counts Age once, and allows for request latency and one-second timestamp
resolution. Invalid/inconsistent responses retain the existing clock. Only a
tiny offset/check record is cached; the world-state document is discarded.
Failures retry after one hour; both cooldowns survive restarts. Offline startup
uses the last server offset, or system time before the first successful check.
There is no network timer when the module is closed.

## Verification

```powershell
node --test test/worldClock.test.js
npm run pack -- --skip-scanner
node scripts/check-clock.js
node scripts/check-build-exporter.js
```

Tests cover the native formula, float precision, long-term phase, day/night
boundaries, orbit direction, legacy calibration removal, timestamp validation,
daily deduplication, restart cooldowns, offline fallback and system-clock jumps.
Native checks exercise both skies, live ticks, server-clock notifications into
docked frames, no alignment controls, compact sizing, collapse, packaged assets
under CSP, themes and module toggles.
