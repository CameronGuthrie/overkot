# Player position and dungeon discovery

On Windows and experimental Linux Wine/Proton builds, Player location in Settings → Overlay enables read-only live character
tracking. It samples positions for the Mini-Map and overworld map up to ten times per second.
The directional marker has an orange-yellow fill, a dark brown outline and a
small notch at its base. It points where the character faces, independently of
the camera. Settings → Widgets → Mini-Map has independent colour pickers for
the marker fill, marker outline and dungeon room outlines, with Reset buttons.
Changes update all open map views immediately and persist across restarts.
Both overworld maps start at a nearby zoom. Center on player returns to the
current arrow position at the current zoom and enables continuous following.
Zooming and resizing keep the player centered while following. Dragging pauses
following; Center on player resumes it. Fit map in the expanded overworld view
shows the complete map and pauses following.
Center on player is unavailable until a fresh live position arrives. Facing turns interpolate
through the shortest angle over 120 ms; position still uses the latest real sample.
The previous screenshot workflow remains commented in the source for future use.

## Dungeon maps

Room outlines use a single configurable stroke and no tile fills or room-type colors.
**Settings → Widgets → Mini-Map → Reveal dungeon as you explore** is enabled by
default on all platforms. Turn it off to show the complete current dungeon layout
in both map views, even before live player tracking becomes available. Turning
it back on restores progressive reveal without marking unvisited rooms explored.

With progressive reveal enabled, unexplored outlines stay hidden. A circular area
around the player becomes visible while walking, with a soft inward feather at
the edge. Previously discovered areas
remain visible after moving away. Feathering never discloses outside the reveal
radius, and the arrow retains its full opacity.
Teleporting reveals the destination without drawing a discovered path through the
space between. Panning and zooming do not erase discovery.

With progressive reveal enabled, the compact dungeon map follows the player at
a zoom where the revealed circle touches both edges of the viewport's shorter
dimension. Zoom buttons and scrolling
adjust that view while keeping the player centered. Dragging pauses following;
Center on player resumes it at the selected zoom. Resizing keeps the player
centered. The expanded dungeon overlay retains its full-map fit and free panning.
With reveal disabled, both views start fitted to the whole dungeon and allow free
panning and zooming. Center and fit dungeon returns to that full layout.

The room feed uses layout-local coordinates. The reader samples typed room frames
from the character's current region. The overlay matches the complete decoded room
graph against these world frames to recover its final position and rotation,
including movement applied after the initial loading placement. Every room's
position, height and facing must agree, with at least three distinct room frames
and a unique fit. The graph must belong to the current dungeon entry. No position
clicks are needed. Until placement can be verified,
the map shows a waiting message and keeps undiscovered outlines hidden when
progressive reveal is enabled. With it disabled, the layout remains visible
while player placement waits for verification.

The legacy three-point alignment remains an explicit development option, disabled
in the normal overlay. Saved automatic alignment requires fresh native proof again
after an overlay restart, before it can reveal additional areas.

For identified accounts, discovery and verified alignment are stored under `dungeon-discovery` in
the application's data directory. They are isolated by account, running game
process, log entry, generated layout and map-data revision. Restarting the overlay
can resume the same active entry. Leaving and reentering, even with the same layout
fingerprint, starts a fresh map. Missing live positions never reveal additional
areas. Unsupported layouts retain their explanatory state.

## Reader support and validation

The native helper recovers its profile from the running Soulframe Windows image
on every launch. It uses bounded PE sections, exact engine registration names,
registration parent links and factory constructors to locate the current native
types and vtables. Getter instructions verify the supported player, camera,
world-transform and region-table offsets. Executable hashes identify sessions;
they do not act as a build allowlist. Compatible hotfixes can move code, data and
vtables without requiring an overlay release or a new address list.

Malformed images, conflicting registrations, ambiguous getters and incompatible
layouts disable tracking. The helper still verifies live type ancestry,
player/avatar references, camera and world transforms, and a unique character
before emitting a pose. Layout changes can still require a reader update.
Normal-permission live validation succeeded against hotfix `2026.11.13.15.34`,
including its relocated getters and shifted player vtable.

On Windows, run Soulframe, its launcher and Overkot normally under the same
Windows account. Settings → Overlay → Player location reports when Windows
denies read access. The reader checks whether the game is still running using
its pinned process ID.

During a search, the percentage in Settings shows how far the reader has
advanced through the selected regions in the current pass. Windows device
allocations marked as noncached or write-combined are excluded. If a player
object is present while its avatar or camera is still loading, the reader
checks it again at the end of the pass before deciding whether to retry.

For a slow search, select **Copy tracking report** under **Settings → Overlay →
Player location** while the percentage is moving. Two reports about 15 seconds
apart show the change in bytes read, progress, and completed passes. Each report
also shows whether a live position reached the app and whether it could be
placed on the map. The report omits player coordinates, account IDs, and paths.

Once the active game log identifies Midrath, the overworld maps can show a
verified position even while Overkot is waiting to identify the account.
In a dungeon, a completed name-only login allows temporary exploration of the
current visit once live placement is verified. Both maps can show nearby weapon
drops in these sessions. Saving discovery across restarts requires an identified
account. If Settings says it is waiting for the current area, check the
**Game log · EE.log** path under **Settings → Game files**.

The map shows the first verified position before collecting nearby room and
item data. A completed search that finds no unique avatar retries after
one second. Consecutive misses back off to a maximum ten-second pause between
searches. Once acquired, the helper reads small live transform samples instead
of repeating the scan. It requests query/read access only and performs no writes or injection.
Only sanitized positions, headings, timestamps and opaque session identity reach
the overlay. Process pointers, credentials and raw scan bytes do not reach the UI.
Samples older than two seconds are removed from the maps.

The same read-only session can supply nearby loaded ground-weapon pickups to the
maps. See [dropped weapon markers](world-drops.md) for identity checks, Moonsteel
indicators, expiry and the separate marker visibility setting.

Build the Windows development reader with `npm run build:position-reader`. Linux
builds compile a small C launcher `overkot-position-reader` and its native
`overkot-position-reader-core` companion using .NET 8 NativeAOT. Building requires
the .NET 8 SDK, Clang and zlib development headers. The packaged Linux reader
needs no installed .NET runtime and never launches a Windows executable.
Both platforms compile and include their reader automatically.

On Linux, the reader finds the mapped Soulframe PE image under Wine/Proton and
uses the same verified profile, pose and room-frame checks. It reads the game's
`/proc` maps and memory independently of the X11/Wayland display backend. Installed
DEB and Pacman packages configure `CAP_SYS_PTRACE` only for the root-owned C
launcher. It validates the same-user Soulframe target, opens its read-only handles,
drops capabilities, then executes the companion. All NativeAOT runtime threads
therefore start without capabilities; the companion file and Electron remain
unprivileged. AppImage runs the launcher with ordinary permissions,
so Linux process restrictions may block tracking. Use the installed package when
Settings → Overlay → Player location reports blocked reader permissions.
Room counts can be decoded from the game log even while live tracking is blocked;
unexplored dungeon outlines remain hidden until a verified live position arrives.

Real Arch/Wayland game sessions still need acceptance testing. Synthetic process
checks and package checks do not establish compatibility with every Wine/Proton
version or compositor.

Tests cover independently relocated sections, registrations, getters and vtables,
ASLR, conflicting or incompatible profiles, malformed PE headers, cardinal facing,
malformed/reflected transforms, native CLI guards,
NDJSON protocol framing, stale samples, transitions, complete room-graph matching,
scope isolation and circular exploration. Actual normal-permission validation
against the supported running game confirmed world position and character facing;
F6 metadata represents the third-person camera, so it is only an approximate
position cross-check and cannot validate character facing by itself.

Live Glades validation matched all eight generated rooms against 18 loaded native
frames. All 67 mapped samples stayed inside the current entrance room, with no
manual alignment points. Refreshing room evidence preserved the tracking session.
