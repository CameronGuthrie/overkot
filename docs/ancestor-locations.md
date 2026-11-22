# Ancestor location accuracy

Ancestor discovery reads the `DynamicGodsAndGhostEncounter` start in `EE.log`.
Its `at pos` vector belongs to the encounter hint. The nearby `BoonNPC` resource
load identifies the ancestor but does not provide another position.

Both map views project that world X/Z directly, using the same transform as the
player pin. Ancestor dots do not participate in POI overlap spreading. Label
layout may move the name, but never moves the dot.

Both views show a translucent purple search area around that dot, with a
50-world-unit radius (100 units across) and a soft fade to transparent at the
edge. It scales with map zoom while the centre dot and name remain readable.
The area stays visible after the discovery pulse ends. This is a visual search
aid, not a guaranteed spawn boundary; the radius covers the measured Bromius
displacement below without introducing a directional coordinate correction.

The September 11, 2026 Bromius encounter logged X=248.954, Y=-27.65,
Z=-391.512 on `/DynamicRandomEncounterHint45`. The app maps this to
pixel (4081.908, 4367.024) before pan and zoom. The static ancestor hint list
does not contain this dynamic location; its nearest entry is about 112 world
units away, so snapping to that list would introduce a substantial error.

## Measured Bromius sighting

The user supplied `Soulframe0046.jpg`, saved September 11, 2026 at 22:22:13
local time. Its JPEG comment records zone `/SF/Levels/MidrathRedux`, player
position `(293, -20, -387)`, and heading 117. The image shows the player beside
Bromius with the interaction prompt visible.

Relative to the encounter hint, that player position is 44.046 world units
east, 4.512 north, and 7.65 higher: a horizontal separation of about 44.28.
The player projects to map pixel `(4170, 4358)`, about 88.09 pixels right and
9.02 pixels up from the hint before zoom. Both map views use this conversion.

This confirms a discrepancy in the input world positions, independently of
map drawing or image calibration. The screenshot records the player's
position, not Bromius's origin, so the difference is an approximate measure
of NPC displacement. It does not establish a reusable offset for Bromius or
other encounters, nor independently verify the map image's calibration.

## Spawn placement and limits

Inspection of the locally extracted `GodsAndGhostEncounter.lua` bytecode
(spawn routine, prototype 4) shows a query around the encounter hint followed
by placement through `RaycastLib`; the resulting position is passed to entity
creation. A waypoint branch can also replace that position. This supports
treating the logged hint as approximate, rather than as the NPC's final
position. No final NPC coordinates were found in the corresponding log lines.
The marker hover text makes that limitation explicit.

Do not apply a fixed eastward correction from one sighting, use the nearest
static hint, or apply the Python minimap's image calibration to these tiles.
None supplies the missing final spawn position. To distinguish spawn placement
from map alignment, compare an in-game F6 screenshot's player coordinates taken
beside the NPC with the logged hint and the terrain. Exact automatic placement
needs an observed source for the final NPC coordinates; a hint alone cannot
guarantee it.
