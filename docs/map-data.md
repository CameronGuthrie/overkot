# Map display data

The expanded map and minimap share `src/renderer/map-pois.js`. Both use the
same positions, filters, localized labels and encounter tooltips. Icons shrink
in whole-island views; hidden categories do not displace visible markers.

The minimap initially opens one zoom-button step closer than a whole-island
fit. Refreshing map data does not reset the current pan or zoom. Both maps use
the same verified disk cache, which warms in the background when the app opens,
including before game connection. See [remote game data](data-updates.md) for
download ordering, cache reuse and offline behavior.

The schema 2 `tile_layout.json` confirms a 14 × 14 grid of 512-pixel tiles.
Filenames run column-major, south to north. World X/Z bounds are ±1792;
`pixelX = (x + 1792) * 2` and `pixelY = (1792 - z) * 2`. Height is not a map axis.

## Public feed contract

The manifest and `get-map-data` bridge allow these nine JSON layers:

| File | Records | Display |
| --- | --- | --- |
| `faction_enclaves` | `enclaves` | Three recognized faction marker types |
| `world_trees` | `positions` | World trees |
| `avakot_spawns` | `positions` | `AvakotVendorNpc` only |
| `sap_trees` | `positions` | Explicit sap pickups, including transformed attachments |
| `vadagar_pools` | `pools` | Possible pool encounters |
| `ode_organs` | `positions` | Possible organ encounters |
| `boss_encounters` | array | Non-siege encounter candidates |
| `named_locations` | array | Named locations with valid positions |
| `dungeon_entrances` | category groups, array, or `positions` | Authored entrance waypoints |

The API must preserve `position`, names/localization keys, faction/NPC/boss
types, `enabled`, `start_hidden`, `has_position`, and `is_siege`. Entrances also
use `name` and `category`. Raw offsets, records, portal associations and asset
paths are unnecessary. The offline fixture generator strips them.

- `enabled: false` excludes a marker. Null or missing means no level override;
  it must survive API projection, particularly for Vadagar pools.
- `start_hidden: true` retains an authored location with a progress-dependent
  tooltip. This flag does not establish permanent unavailability.
- Encounter candidates are labelled as possibly inactive. Entrance tooltips
  mention access requirements. Static data cannot establish current activity.
- Only finite, in-bounds X/Z positions are displayed. Repeated records of the
  same marker are collapsed. A missing label cannot discard an entire layer.
- Use waypoint positions from `dungeon_entrances`, not the nearby associated
  portal or a generic entrance hint. Old feeds without this layer retain their
  named-location dungeon fallback; an explicitly empty entrance layer clears it.
- Empty/unavailable layers leave other categories usable. Live ancestor markers
  continue to come from the game log. Raw `entities`, generic encounter hints,
  discovery triggers and other extraction categories are not automatic map pins.

## Check a pipeline build

```powershell
node scripts/check-map-data.js C:/path/to/pipeline/maps
```

This verifies every tile against the layout, downloads the public map JSON
through the application's hash/size checks, and compares marker positions and
all 196 local tile hashes with the public manifest. The report is saved to
`output/map-data-review/report.json`. It does not publish data.
The checker accepts canonical `maps/` and compatibility `map/` exports. It
resolves image references relative to that directory and prefers the language
dictionary under `Languages/` when available.

Add `--serve` to expose an isolated loopback fixture containing the local map,
with other display assets from the public feed. In a second terminal:

```powershell
npm run pack -- --skip-scanner
$env:OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:<printed-port>/overlay/v1/manifest.json'
$env:OVERKOT_MAP_EXPECTATIONS = 'output/map-data-review/report.json'
node scripts/check-overlay-map.js
```

The native check compares category counts, checks all marker images, verifies
ASAR reloads use cached assets, and captures both maps in an isolated profile.

Validation on September 12, 2026, using the 14:46 UTC local extraction: all 196
tile placements matched and 180 markers rendered (3 enclaves, 16 trees, 3 vendors,
17 sap, 6 pools, 3 organs, 66 bosses, 29 entrances, 37 locations). Five explicitly
disabled records were excluded. The public feed checked at 15:09 UTC still had
the older JSON, no entrance layer, and six different tiles (79, 93, 120, 121,
136, 148). Updating the desktop does not publish the API's source build or change
its projection rules; rerun the comparison after API publication.
