# Ancestor discoveries

The minimap and expanded map show active Gods & Ghosts encounters automatically.
Each encounter gets a purple dot and name label. Hovering the dot or label shows
the full name. A new discovery briefly pulses the dot and map border for six
seconds; reduced-motion preferences disable this animation.

Detection follows the encounter/resource sequence used by `minimap.py`:

1. An `ENCMGR` start for `DynamicGodsAndGhostEncounter` provides world X/Y/Z.
2. A nearby `ResourceLoader` load of an ancestor `BoonNpc` resource supplies its
   name. Helper resources and unrelated preloads cannot create a discovery.
3. Completion, abandonment, level transitions, logout, or game exit remove it.

An encounter without a matching name load appears as **Unknown Ancestor**.
Opening the overlay during play replays the current log in bounded chunks and
publishes only encounters still active at the end of that replay.

## Placement

Use the map's existing world transform: `px = 3584 + 2 * x`,
`py = 3584 - 2 * z`, followed by the current pan and zoom. Y is elevation.
Do not apply the Python viewer's fitted affine calibration or POI overlap
spreading to ancestor dots. Labels can move to avoid overlap, while dots stay at
their projected coordinates and keep a six-pixel radius at every zoom.

EE.log provides the encounter hint position, which may differ from the NPC's
exact standing position. The marker is therefore an encounter location.

## Verification

- `node --test test/ancestorWatcher.test.js test/ancestor-markers.test.js`
- `node scripts/check-ancestor-markers.js` runs real Electron map renderers with
  fixture IPC and bundled tiles, without using game credentials or user settings.
  Screenshots and results are written under `output/ancestor-check/`.
