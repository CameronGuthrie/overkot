# Midrath weather calculation

Enable **Weather** in the widget picker. The card shows animated conditions,
the next change with a countdown, and three upcoming conditions in local time.
It supports floating/docked layouts, resizing, collapse, themes and opacity.
Animations pause while hidden or collapsed and respect reduced-motion settings.
Before the first successful server synchronization, the footer says **Device
time**; the prediction remains usable offline using the clock's saved offset.

`src/modules/weatherCycle.js` computes the current target and upcoming weather
from Unix time. Runtime time comes from the app's shared `WorldClock`, which
synchronizes with `https://api.soulframe.com/cdn/worldState.php`. No downloaded
HTML, dated forecast calendar, installed game, private archive login or local
developer files are required or packaged.

The chooser is a JavaScript port of `soulkit/src/weather.rs` from
`CameronGuthrie/soulframe-rust-workspace`, branch `oreo`, commit
`996962b25e2620e61cf2dfb1f32682bb4550c0fd`. Its `research/README.md` records the
native evidence for Soulframe build 2026-09-24: chooser `0x140ac0430`, simplex
noise `0x140f0dc10`, permutation `0x1424c5cc0`, and applier `0x140e07370`.
The upstream reconstruction matched 3,000 emulated native samples. The 24
published native samples are retained as regression tests. The source repository
is private; it is a development reference, never a runtime dependency.

The chooser samples a 31-day circle with radius `float32(118.41128)` through a
variant of 2D simplex noise. Unlike standard simplex implementations, its
gradient mask is `0x3f` and scale is `float32(45.230652)`. Float32 rounding after
each arithmetic operation matters. The noise is mapped through exponent `1.25`
into four tiers. A 32-bit hash of the tier and 11,880-second time bucket chooses
one of the tier's keys. The bucket hash does not reset every 31 days, so repeating
a 31-day calendar would be wrong.

The eight small condition interpretations follow the `DynamicWeather` key
arrays on `/SF/Levels/MidrathRedux/DynamicSkyMidrath`: 1 clear, 2 light, 3 moderate
and 2 heavy. They are part of the computational model. The supplied HTML/JSON
were used only as a development cross-check. Changes to the game's algorithm or
key arrays need a model update; the public world-state response does not expose
those definitions.

Every second is evaluated when finding nearby transitions. This catches brief
threshold changes that the upstream calendar generator's minute scan can miss.
Each result includes the current period and four subsequent periods, with UTC
millisecond `start` and `end` boundaries. Scanning is limited to one day in each
direction and rejects unsupported input rather than inventing a forecast.
Adjacent presets with the same displayed condition and rainbow chance share a
single period, so internal preset changes do not produce a Breeze-to-Breeze
countdown. A different rainbow chance remains a meaningful boundary. The
period's `typeId` and raw key record its first native preset; `weatherAt` always
returns the ungrouped native result.

These are target states. The game blends into them over a few seconds, and
quests/scripts can pause or override the normal cycle. Native FMA math and
JavaScript math may differ at the last bit on a threshold. This is a prediction,
not a reading of the player's local sky.

Internal names are not treated as player-facing guarantees. Wind is not mapped
to Rainbow, and overcast is not labelled Fog: the fog trigger is not traced.
The moderate shower preset has a 20% rainbow chance after rain. Its actual roll
depends on recent-rain state and is not predicted; the widget must describe it
as a chance rather than announcing a scheduled rainbow.

Validation: `node --test test/weatherCycle.test.js`. A separate development
audit compared all 1,209,600 seconds across the supplied 14-day reference with
the native chooser: zero differing seconds, including all 1,327 reference
entries. The reference files and generated audit report are not packaged.

Integration checks: `node scripts/check-weather.js` after `npm run pack` (or a
portable build). This uses an isolated profile and the packaged Electron runtime
to verify countdown transitions, animations/reduced motion, 200/300/400px sizes,
cache expiry, collapse, bundled renderer assets, dock broadcasts and visibility
persistence. `npm run build:portable` produces the local portable executable and
SHA-256 checksum with publication explicitly disabled.
