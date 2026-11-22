# Dungeon maps

The **Mini-Map** switches automatically to the current dungeon when the game log
reports entry and restores the existing overworld view on exit. Dungeon maps
are part of the Mini-Map, with no separate widget. Existing Dungeon Map widget
preferences migrate to the Mini-Map when upgrading.

Open **Settings → Widgets → Mini-Map** to choose automatic minimap switching,
**Reveal dungeon as you explore**, the see-through option and **Dungeon background
opacity** (0–100%). Progressive reveal is enabled by default on all platforms.
Turn it off to show the full current dungeon layout as soon as it is available,
in both the Mini-Map and expanded dungeon map. Turn it back on to restore the
explored view; showing the full map does not mark its rooms as explored. The eye
button changes the shared see-through preference. The crosshair centers and fits
the map, diagonal arrows open the expanded map, and **+ / −** change zoom. Drag
to pan and use the wheel to zoom. Background opacity is independent of room outlines.
In the expanded map, **Escape** returns input and focus to Soulframe while keeping
the map and its current view visible. The interaction shortcut (default **Shift + F1**)
enables map controls again. The close button returns to Mini-Map.

## Generated routes

The decoder reads the instance's `.lp` fingerprint using the exact generator's
extracted component table, rather than limiting support to particular dungeon
names or previously captured routes. It validates the complete room tree,
unused-door caps, doorway attachment sections, cinematic selection and padding.
Both native attachment variants are supported, including generators that omit
category bits when they have no custom layouts. Older count-only feeds can be
read using strict validation of the alternate tail, without changing the tree.
Extracted door positions and outward normals place the selected rooms together;
the walkable navmesh supplies their outlines.

Independent captures verify regular Fallen Fortress, Undercity Cliff Cave,
Undercity Cliff Town and Glades. The two fresh Cliff Town captures assemble
different 13- and 10-room routes; the two Glades captures assemble distinct
10-room routes. Other indexed generators use the same format and their own
tables. Unknown serialization formats, invalid fingerprints and missing tables
produce an empty status view with a retry control. The Mini-Map never displays
an atlas of all available rooms. While awaiting generation it also shows no
room shapes from an earlier instance.

If outlines exist but portal transforms are missing, the selected instance's
connected room tree is shown as a labelled schematic. Missing room outlines are
explicitly indicated. Current exports use **layout-local** coordinates, with no
verified absolute world anchor. The game log does not supply continuous player
coordinates, so F6 position capture is disabled in the dungeon view.

## Data and lifecycle

The v2 content-addressed feed provides `dungeons/index.json`, plus
`dungeons/<key>/rooms.json` and `dungeons/<key>/layouts.json`. Compact vector
outlines let the renderer color floors, boundaries and background separately.
The desktop does not need to download the pipeline's raster room images.

The index resolves all 47 current generator paths, including Undercity, Tales
and quest aliases whose paths differ from their room set. Missing or legacy
layout tables trigger one shared early manifest check per set and feed version.
Offline clients show an empty status view without repeating forced checks;
retry and normal data updates can recover the map.

The watcher processes both existing logs and fresh appended lines, buffers
partial lines, and handles rotation, multiplayer entry, exits, logout and game
restarts. Generated resource paths on connected or ENTER events separate the
generator from its fingerprint. Prefetch and old-instance destruction cannot
activate or replace the current dungeon. Stale asynchronous map responses are
discarded after a new entry or exit. Hidden maps fit on activation, and later
resizes preserve deliberate pan and zoom.

## Validation

Run `node --test test/dungeonLayout.test.js test/dungeonMap.test.js test/dungeonService.test.js test/dungeonWatcherFresh.test.js test/minimap.test.js`
for captured routes, exact doorway placement, input rejection, legacy feed
upgrades, incremental log polling, re-entry and minimap regressions.

Run `node scripts/check-dungeon-map.js --source` for native Electron checks.
After packaging, run it with `--packaged` to use the production ASAR renderer,
preload and packaged Electron runtime, driven by the source service and watcher.
The check uses isolated storage, denies external requests,
and exercises automatic entry/exit, fresh Cliff Town and Glades routes, sizes,
see-through settings, empty unavailable/waiting views, delayed responses,
preserved overworld views and hidden-map activation. Chromium captures and a
JSON summary are written under `App/output`.
