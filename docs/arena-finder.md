# Arena Finder

Arena Finder uses the same current dungeon fingerprint and extracted room tables
as the Mini-Map. A complete decoded layout containing the exact wave-arena room
for that room set confirms the arena. A complete current layout without that
room confirms its absence. Room outlines and map images are not required for
this check, and the Mini-Map does not need to be open.

The matching rooms are:

- Glades: `/SF/Levels/Procs/GladesofAndurin/GoAxDeadendGarrenRood.level`.
- Undercity: `/SF/Levels/Procs/UnderCityMidrath/UnderCityArena.level`, included in
  `/SF/Levels/Procs/UnderCityGauntlet`.

The Glades room also runs `UnderCityArena.lua`, with `Function=Mission`,
`Tag=ArenaScriptTrigger` and `GladesArenaAiSpec`. Its different room name caused
the earlier matcher to miss Glades arenas on both Windows and Linux. In the
inspected Glades image export this is tile **24**. Tile **32** is the separate
`GoAxGarrenRoodBossArena` quest boss room, which runs `GarrenFight.lua` and
`StagQuest.lua` and is excluded. Image numbers are export-order details; detection
uses the exact decoded room name and canonical room set, including feed aliases.

When the current layout cannot be decoded, the existing EE.log physics
diagnostic remains a fallback. Ordinary asset preloads, the catalogue of
possible rooms, and wave messages alone do not confirm an arena. Wave and tier
messages still supply progress after the current arena has been confirmed.
Fallback diagnostics and wave blocks must belong to the selected instance;
delayed lines from an older log cursor cannot confirm a newer dungeon. A wave
already confirmed in the same instance is retained across a metadata refresh
and shown again when room confirmation returns.

Changing instances or leaving the dungeon invalidates the previous detection.
Late metadata results must not restore a room from an older trip. A missing or
unsupported layout means detection is unavailable, not proof that no arena was
generated. The widget shows **Waiting for dungeon data…** in this case, including
on Wine/Proton when the fallback physics diagnostic is never logged. **No arena
found** requires a complete current layout without the wave-arena room.

`test/fixtures/underCityGauntlet.json` preserves the current generator's ordered
room names, portal counts, caps and serialization metadata. Its two minimal
fingerprints are explicitly synthetic complete encodings for positive and
negative decoder tests; they are not claimed to be live game captures.

`test/fixtures/gladesProcLevel.json` preserves the real Glades component table.
`gladesArenaEvidence.json` records the inspected cache hashes, script identities,
quest exclusion and synthetic complete positive/negative fingerprints. The native
Electron check exercises Glades and Undercity through the real decoder, main
process, preload and widget with the Mini-Map disabled. Both rooms reuse the same
`UnderCityArena.lua: New wave:` progress messages; no extra log marker is needed.
