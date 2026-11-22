# Nearby dropped weapons

On Windows and experimental Linux Wine/Proton builds, live player tracking can
also identify loaded ground-weapon pickups.
The Mini-Map displays a small white dot with the weapon name underneath. A pale
diamond and sparkle distinguish a weapon whose live pickup data confirms
Moonsteel (`Shiny`). Stock craftwork and weapons without Tempers are included.
Unknown shiny metadata uses the ordinary dot; it is never guessed from the mesh,
quality, weapon name or number of Tempers.

Settings → Widgets → Mini-Map → **Show nearby dropped weapons** controls this
layer. It starts enabled. Disabling live player tracking also stops the native
reader. Unsupported native pickup layouts leave the player tracker running and
do not manufacture weapon markers.

Markers are temporary observations, not saved points of interest or inventory
items. Each complete observation replaces the previous set, so picking up or
despawning a weapon removes its marker on the next successful observation.
Unchanged player updates cannot prolong a weapon observation older than two
seconds. Leaving an area, changing accounts, losing tracking or changing game
process sessions clears the set. At most 64 pickups within 80 world units of the
fresh player position can reach the map.

Both overworld maps use the existing world-to-map projection. Dungeon views use
the same currently verified placement and discovery scope as the player arrow;
they show a pickup only in already revealed space. Weapon positions do not
expand discovery. Marker dots, shiny symbols and white labels keep their size
when zooming and follow the map's Elements opacity.

The native helper uses query/read access only, with no game writes or injection.
Ground pickups must be established from the current region's owned entities;
loading a weapon resource, carrying a weapon, or finding its name in EE.log is
insufficient. Only opaque runtime IDs, validated positions and confirmed weapon
metadata enter the application. Process addresses and raw memory remain outside
the renderer protocol. Display names resolve through the weapon catalogue and
the selected language, with the catalogue's English name as fallback. An
unresolved confirmed weapon is labelled **Dropped weapon**.

The JavaScript checks cover native protocol limits, independent sample clocks,
name resolution, unknown metadata, pickup replacement, stale/changed contexts,
nearby filtering and verified dungeon projection without new exploration.

## Native support and validation

Pickup discovery shares the existing bounded region-entity walk, refreshed once
per second. Particle-count changes do not force that walk on every player sample.
Scaled pickup models are supported through the verified world-position getter.
Item identity comes from the pickup's stored weapon resource, not its model name.

Moonsteel is the generated item's named `mShiny` field. The helper replays its
seed calculation locally using live scene and player context, after validating
the generator code, canonical item eligibility and subsequent item processing.
It resolves only already loaded resources through the game's bounded typed
resource cache. Unsupported code, missing resources, conflicting copies or
changing observations leave shiny status unknown while ordinary markers and
player tracking continue.

Live read-only validation against `2026.11.18.14.58` identified the user's Stock
Stultin about 1.1 units from the character, with a stable opaque ID and a verified
non-shiny result across three snapshots. Compiled native fixtures exercise shiny
and non-shiny seeds, eligibility exclusions, scaled loot, ownership loss,
resource-cache conflicts, deleted pickups and metadata changes. Isolated native
map fixtures cover compact and expanded overworld and dungeon renderers; their
shiny examples test rendering and do not claim a live Moonsteel drop was present.

```
node --test test/world-drop-reader.test.js test/world-drop-shiny.test.js test/worldDrops.test.js test/playerTracking.test.js
node scripts/check-world-drops.js --source
node scripts/check-world-drops.js --packaged
```
