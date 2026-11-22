# Local validation

Run commands from `App` after `npm install`.

```powershell
npm test
node scripts/check-window-renderers.js
node scripts/check-inventory-widgets.js
node scripts/check-arena-finder.js
```

The Node tests cover data updates, feed publication, configuration persistence,
and window geometry. The renderer check uses hidden Electron windows with mocked
data IPC. It verifies that dock sizing avoids unnecessary scrollbars, dock
updates and reordering preserve iframe state, and alerts render and dismiss with
the production script content policy.

The inventory widget check runs the real Electron main process, preload, picker,
dock, and widget panels against synthetic inventory in a temporary profile.
It covers the consolidated Player tabs and Daily Brief, including login/reset
opening, dismissal, live vendor information, unique picker/dock icons, saved
inventory, session reset, retained search, panel sizing and disabling/re-enabling
widgets. It blocks network
requests and does not require the game. Screenshots go to
`output/inventory-widgets/`.

The Arena Finder check runs the real dungeon watcher, shared room decoder,
arena resolver and preload with Mini-Map disabled and no room outlines. It
checks tile confirmation, complete negative layouts, unavailable-data log
fallback, wave progress and stale results after exit. Screenshots go to
`output/arena-finder/`; its layout fingerprints are synthetic test vectors.

For a Windows source-app integration check, leave Soulframe running and prepare
the static data feed first:

```powershell
npm run data:build -- --map-json assets/map-json
node scripts/check-app.js
```

The map override uses the reviewed bundled markers because the supplied pipeline
snapshot has invalid map layers; see [data updates](data-updates.md).

The integration check starts the real main process, preload, and renderers with a
temporary profile under `output/source-smoke-*` and an HTTP feed on loopback. It
checks Soulframe process detection, selective startup downloads, map tiles and
POIs, language changes while the map is open, settings, snapping, collapse and
restore, free/grid layouts, and alert dismissal. Screenshots and `summary.json`
are saved in the temporary profile directory.

Credential scanning and Group Finder writes are stubbed. The check does not
access inventory credentials or change the running game's state, and it does not
write to the normal Overkot profile. Both Electron checks exit nonzero on failure.

## Windows release validation

Build both distribution formats, then check the packaged UI with isolated
profiles and synthetic accounts:

```powershell
npm run build:win
npm run build:portable
node scripts/check-market.js --packaged
node scripts/check-updates.js
node scripts/check-group-finder.js
node scripts/check-wiki-search.js
$env:OVERKOT_DATA_MANIFEST_URL = 'https://d2855gck1tg5bh.cloudfront.net/overlay/v2/manifest.json'
node scripts/check-overlay-map.js
node scripts/check-wolf-training.js --packaged
node scripts/check-dungeon-map.js --packaged
```

The market check loads the packaged renderer/preload with mocked market IPC.
The update, Group Finder, wiki and map checks use the packaged Electron runtime.
The map check reads only the public data feed; game services are stubbed. It
checks the map/minimap under the packaged content policy, cached assets and the
Settings data-update button, including an offline failure and retry. No check
signs in to a real account, publishes listings or installs an update.

The older `check-packaged-content.js` assumes maps are bundled in the ASAR. It
is unsuitable for current releases, which download verified game data. Use
`check-overlay-map.js` and `check-wiki-search.js` for those checks instead.

Validated on September 14, 2026 for 0.0.11: all 765 Node tests passed; full NSIS
and portable builds succeeded with Electron 40.10.6 and all 15 configured locale
packs. All commands above passed, along with `check-window-renderers.js` and
the isolated `check-market-app.js` source integration. The live-feed map check
painted all four visible tiles and 140 markers/icons, and the offline wiki check
passed UK English locale loading and repeated native-window teardown. The
installer's updater size/SHA-512 and generated SHA-256 matched the final file.
Both distribution executables and the native helper remain unsigned.

Logs, screenshots and artifact hashes are under ignored `output/` directories.
The updater fixture currently logs missing mock handlers for `market:state` and
`game-paths:get`; its update/settings assertions pass. These warnings describe
fixture coverage, not errors observed in the real source-app market check.

Validated on September 21, 2026 for `0.0.12-beta.2`: all 809 Node tests passed,
including Avakot Account lifecycle/IPC/Settings and shared prerelease notes.
The unpacked Windows build passed all 15 locale checks. Packaged Calendar,
Temper Tracker, Market, updates/settings, Group Finder, wiki, live-feed map and
window-renderer checks passed. Calendar and temper screenshots confirm the
saved offerings toggle and blacksmith unlock list. The release workflow builds
and retains the final installer before publishing its checksums and metadata.

Validated on September 21, 2026 for `0.0.12-beta.3`: all 815 Node tests passed.
The unpacked Windows build passed all 15 locale checks. Source and packaged
Market renderer/preload checks passed, including browser approval, cancellation,
retry, completion, and the email/password fallback. Protocol tests verify
secret isolation, pending sign-in cancellation, late-token revocation, outages,
expiry and session persistence. The matching Market project passed 201 tests,
TypeScript and frontend builds; its browser checks cover consent, matching
codes, reloads, approval/denial and the Avakot login continuation. These auth
checks use synthetic accounts; a real account login is not automated.

Validated on September 27, 2026 for `0.0.12-beta.4`: all 815 Node tests passed.
The unpacked Windows build passed all 15 locale checks. Packaged Market and
updates/Settings checks passed with the avakot.dev account branding. This release
changes account and sign-in labels; account creation and linking run on the
separately deployed account service.

Validated on October 3, 2026 for `0.0.12-preview.wolf-dungeons.1`: 940 Node tests
passed, with one platform-specific test skipped. The portable build includes all
15 configured Electron locales. Packaged Wolf Training, Dungeon Map and the
existing map/minimap checks passed, including docked widgets, settings, transparent
backgrounds, automatic entry/exit and offline data retry. The real desktop
downloader verified all 323 production v2 objects, reused them after an offline
restart and downloaded no assets after an unchanged manifest. Seven dungeon sets
provide 265 room outlines; the captured normal Fallen Fortress assembles 11
connected rooms. Other generators show their labelled room atlas. Higher wolf
skill thresholds remain explicitly marked as estimates. No app release was
published.

Validated on October 3, 2026 for `0.0.12-preview.wolf-dungeons.2`: 954 Node tests
passed, with one platform-specific test skipped. The rebuilt portable passed
packaged Wolf Training, Dungeon Map and overworld map/minimap checks. Wolf Training
shows one current companion, a paw icon, the localized bond type and exact saved
points; native game code verifies all five paw thresholds and named bond
transitions. Its legacy cached catalogue migrates offline. Both recorded
UnderCityCliffCave fingerprints load connected eight- and nine-room maps through
the production desktop downloader, with no missing outlines. The revised watcher
recognises all 47 indexed generators and ignores background generation and stale
destruction lines. All 323 feed objects passed hash/size checks, an unchanged
manifest downloaded no assets, and all objects were reused offline. The API's
24 tests and TypeScript check passed; the v1 manifest and objects were unchanged.
No app release was published.

Validated on October 3, 2026 for `0.0.12-preview.wolf-dungeons.3`: the Node suite
passed, with one platform-specific test skipped. Native source minimap checks
passed using six real Cliff Cave, Cliff Town and Glades fingerprints and their
extracted room outlines. Fresh append polling and re-entry select the current
instance, and all connections align the extracted doors. Waiting, unsupported,
corrupt and offline states draw zero room pixels, with no room atlas fallback.
The separate Dungeon Map widget is removed; existing map preferences migrate to
the Mini-Map. Both native attachment-category formats retain full-tail
validation. Downloaded production tables resolve all four fresh Town/Glades
captures with no missing outlines.
