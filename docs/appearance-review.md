# Appearance review

## Baseline and direction

The baseline was captured from the production Electron renderers and preload in
an isolated offline profile. Synthetic timers, wallet balances, faction standing,
crafting, a clock and Daily Brief populated nine embedded widgets. No live game,
account, memory scanner or production settings were used. Images are local,
ignored artifacts under `output/appearance-review/baseline/`.

The visual direction is a restrained game companion: legible ink surfaces,
clear primary numbers, quieter secondary labels and ornament reserved for
meaningful events. Shared geometry and motion should hold the interface together
while allowing noticeably different personal styles.

Priorities observed before implementation:

1. Shape and border treatments were fixed independently in controls and widgets.
   The palette picker changed colors but could not express sharp or pill styles.
2. Most bars and values had similar emphasis. Large bright fills dominated dense
   arrangements, while countdowns and supporting labels competed for attention.
3. The narrow Player wallet wrapped a large balance onto two lines. Small
   navigation labels and dense timer names needed more deliberate hierarchy.
4. Appearance edits saved immediately. There was no reversible editing session,
   reusable appearance library, per-widget inheritance or appearance-only sharing.
5. Existing motion was distributed among components. Reduced-motion handling and
   the cumulative effect of repeated feedback required a shared policy.

Baseline images include `settings.png`, `picker.png`, `rail.png`, `dense.png`,
`timer.png`, `player.png`, `daily.png` and `alert.png`. `dense-map-texture.png`
uses a bundled map tile as a busy background and is labeled as a fixture;
it is not a gameplay screenshot.

## Measurement scope

The baseline visible nine-widget fixture ran for 5.005 seconds on a 144 Hz,
1920 × 1080 display at 100% scaling. It recorded 721 animation-frame intervals:
median 6.9 ms, 95th percentile 7.1 ms, maximum 7.2 ms and no intervals over
34 ms. Raw values are in `output/appearance-review/baseline/frame-times.json`.
These are renderer scheduling observations in a synthetic fixture, not game
performance measurements or a claim about CPU/GPU usage.

The refined fixture measured 720 intervals over 5.007 seconds: median 6.9 ms,
95th percentile 7.1 ms, maximum 7.3 ms, and no intervals over 34 ms. The raw
sample is `output/appearance-review/final/frame-times-classic.json`. Both samples
used the same visible nine-widget arrangement, 144 Hz display and Classic
appearance. This small observation showed no scheduling regression; it does
not establish a performance improvement or measure the cost alongside Soulframe.

## Visual review and corrections

The first component pass inspected the editor, picker, rail, timers, Player,
Daily Brief and alerts. Artifacts are in `output/appearance-review/component-pass/`.
It identified the narrow wallet wrapping a large balance, overly tall short
timer rows, and labels competing with thin progress tracks. Corrections gave
large balances a full card row, kept short timer names and countdowns together,
provided full-name tooltips for truncated labels, and moved thin-bar labels
below their tracks.

The second pass reviewed all nine widgets together over a bundled map texture.
`output/appearance-review/overlay-pass/` records that pass. The final repeat in
`output/appearance-review/final/` includes the subsequent thin-bar and native
rail-border corrections. Grove, Obsidian and Ember visibly differ in palette,
surface transparency, radius, density, tracks and labels. The sampled 240 px
embedded cards fit their reported content heights; the fit JSONs record the
measurements. Final timer rows are retained between one-second updates, with
duplicate-safe matching and no remount-driven replay of event emphasis.

Representative local evidence:

| Case | Artifact |
| --- | --- |
| Baseline dense overlay | [Before](../output/appearance-review/baseline/dense-map-texture.png) |
| Rounded Grove over busy texture | [After](../output/appearance-review/final/dense-grove-map-texture.png) |
| Sharp Obsidian | [After](../output/appearance-review/final/dense-obsidian-map-texture.png) |
| Ember with pill controls | [After](../output/appearance-review/final/dense-ember-map-texture.png) |
| Radius zero and border controls | [Editor](../output/appearance-review/final/editor-zero-radius-controls.png) |
| Borderless sharp defaults, rounded Clock override | [Mixed inheritance](../output/appearance-review/final/dense-sharp-borderless-rounded-clock.png) |
| High Contrast with zero decorative border | [Rendered result](../output/appearance-review/final/dense-high-contrast-zero-border.png) |
| German labels and long names | [Localized fixture](../output/appearance-review/final/dense-german-long-labels.png) |
| Large text with a 4 px track | [Readable caption fallback](../output/appearance-review/final/large-text-thin-bar-label-fallback.png) |
| Recoverable error and retry | [Error](../output/appearance-review/final/player-recoverable-error.png), [recovered](../output/appearance-review/final/player-recovered-equipment.png) |

High Contrast zero-radius/zero-border measurements cover all nine cards and
retain an opaque yellow focus token. In the 20 px text / 4 px track case, the
caption measured 17 px high below the track and stayed within the card. A 150%
renderer zoom sample had document client/scroll width 720/720 px. Renderer zoom
at 125% and 150% was reviewed separately from the actual Windows scale, which
remained 100%; real mixed-DPI or multiple-monitor configurations were not tested.

## Repeatable checks

`node scripts/check-settings.js --source` uses actual main/preload/Settings IPC
with temporary preferences, blocked renderer HTTP requests and simulated game
foreground signals. Native input, focus and reopening checks remain part of that
script. Its screenshots and summary are written to a new
`output/settings-smoke-<timestamp>/` directory.

The following existing checks cover retained embedded widgets, alert dismissal,
native dock placement and inventory panels:

```powershell
npm test
node scripts/check-window-renderers.js
node scripts/check-edge-dock.js
node scripts/check-inventory-widgets.js
```

The edge-dock fixture requires the already-built local data feed at
`output/data-feed/manifest.json`. Native checks passed for all four full-length
48 DIP rail edges, 36 × 36 px icon hit areas with a 4 px decorative border,
drag/reorder/snap, click-through, auto-hide, visibility shortcuts, retained
windows and iframe state, and dungeon pan/Escape focus return. The full
edge-dock report after the lifecycle correction is
`output/edge-dock-smoke-1794960941783/summary.json`.

Inventory QA passed with disconnected, cached and live states, all Player tabs,
Daily login/reset, vendors, calendar, retained search controls and picker icons.
Its report is `output/inventory-widgets/consolidated-report.json`. Settings QA
adds actual main/preload preview/apply/cancel, persisted named imports, rejected
invalid files, preset CRUD, undo/redo/reset, per-widget geometry, zero values,
High Contrast fields, reduced-motion emulation and scoped motion overrides.
File chooser paths are supplied by the fixture; validation and file reads/writes
use the production IPC handlers. No game or account services run.

The final full Settings native flow passed in 8.94 seconds, including closing an
unapplied preview, restoring saved appearance, tutorials, passive input policy
and both recreated and retained Settings windows. Its complete report is
`output/settings-smoke-1794960855466/summary.json`; an independent close/reopen
repeat also passed in 8.59 seconds. These checks exposed a real teardown stall:
rollback had broadcast synchronously while the owner WebContents was being
destroyed. The correction clears preview state immediately and safely notifies
surviving frames after teardown, with a revision guard against newer edits.

The final unit run on the lifecycle correction passed 1,780 tests, with no
failures and two expected Linux-only skips (1,782 total). See
`output/appearance-full-tests-lifecycle.log`. All eight hidden native renderer
checks passed, including retained timer rows, readable thin captions and all
four 48 DIP rail edges with maximum decorative borders; see
`output/appearance-window-check-lifecycle.log`.

One existing inventory-check assertion was stale before this work. Baseline
commit `57a0597` already registered nine collection/resource/mastery services in
`src/main.js` in addition to the five Player domain services, while
`scripts/check-inventory-widgets.js` asserted that the entire service map
contained exactly five entries. The check now requires each of its five Player
services, then continues to exercise their actual IPC and disconnected, cached
and live states. Collection services retain their separate checks; no service
or renderer was removed to satisfy the assertion.

The baseline edge-dock fixture also lacked an instance ID and verified player
pose. `57a0597` already required both before revealing dungeon geometry, so its
pixel-pan assertion compared an empty canvas. The fixture now supplies a fresh,
explicitly synthetic verified pose, asserts a placed scene and visible pixels,
waits for the live marker to expire, then asserts that discovered room pixels
remain before comparing the native pan. The existing pixel-change and Escape
view-preservation assertions remain intact. Before opening Settings after the
outside-focus scenario, the fixture explicitly activates the interaction chord
instead of depending on Windows assigning focus when that outside window hides.

## Limits

The new editor's labels currently use English fallback text. Existing translated
application labels remain available, including the German fixture above. The
embedded Market frontend owns its own palette rather than consuming the overlay
appearance tokens. Native Windows behavior was exercised; other operating
systems, actual gameplay readability and simultaneous game CPU/GPU load were
not measured in this environment.

## Local implementation history

Work began from a clean `main` at `57a0597`. The following commits are local;
subsequent documentation commits are recorded in Git.

| Commit | Change |
| --- | --- |
| `1a7156d` | Shared appearance schema and validated preset format |
| `c5f1002` | Border opacity matches rendered alpha |
| `17b9828` | Shared rendering tokens, geometry and hierarchy |
| `9924f16` | Transactional preview/apply/cancel and native preset files |
| `f3b258e` | Coordinated motion and meaningful event feedback |
| `3db570b` | Keep overlay appearance scripts out of embedded Market inventory |
| `b42f063` | Dense widget readability and true zero-radius controls |
| `94563a4` | Shared transient-surface shapes and progress colors |
| `39b37fe` | Live appearance editor, scoped presets and customization |
| `fe09607` | Shared schema in platform regression fixtures |
| `b5e9703` | Retain timer nodes between ticks |
| `d7b8089` | Preview padding matches actual cards |
| `92226b1` | Readable captions across track and typography sizes |
| `8a5e18b` | Editor shows actual High Contrast semantic colors |
| `9bd7546` | Retain duplicate timer rows without orphan nodes |
| `45b475f` | Repair current inventory/dungeon native QA fixtures |
| `60745f2` | Safe appearance rollback beyond Settings teardown |
| `05ad41c` | Native editor, preset sharing and cross-window verification |

No change was pushed, deployed, published or uploaded as a release or build
artifact. Build outputs remain local and ignored by Git.
