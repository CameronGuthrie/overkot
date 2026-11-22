# Collection and mastery widgets

Enable these panels in **Add / remove widgets**. Each has its own dock icon,
can float or attach to the dock, and follows the existing overlay interaction
and layout controls. They are local additions; this change does not publish a
release or change the app version.

| Widget | Features |
| --- | --- |
| Collection Log | Weapons, armour, Pacts and cosmetics; owned/missing/history filters, search, starred goals, grid/list views, and an Armory view with individual copies, XP, quality and recorded Tempers. Discoveries includes memory completion targets and world-tree bits. |
| Envoy Rank & Mastery | Envoy Rank calculated from inventory mastery, mastery breakdown and progress, compact rank view, full mastery checklist and pinned goals with XP to the next equipment rank. |
| Cosmetics | Dedicated cosmetics catalogue and ownership log. |
| Resources | Resource, consumable and currency quantities, search, category and held filters. |
| Enhancements & Joineries | Runes/motes, totems, techniques and joineries, with rank and virtue filters and copy counts. |
| Crafting Planner | Saved targets and quantities, shared ingredient totals and inventory deficits. Published alternative ingredient paths share stock. Reforge recipes are identified explicitly. |
| Crafting Log | Ancestor rank/XP and permanently recorded recipe/quality combinations. |
| Activity | Chronological observed inventory changes, gains/spending and XP filters, and a restart control. |
| Session Analysis | Observed mastery gains, rates, rank-ups and session history, with current, seven-day, thirty-day and all-history views. |

These combine related little.genius widgets: mastery rank/breakdown/checklist/
planner become one Mastery panel; joineries and enhancements share a panel;
the item chest is the Collection Log's Armory view; journal/pickup feeds share
Activity. Existing Daily Brief, timers, factions, World Watch, Wolf Training,
Player, Temper Tracker and Build Exporter cover the corresponding existing
features.

## Game data

`src/data/collection-catalog.json` is a generated, validated display snapshot
from the published `soulframe-pipeline-data` S3 build and a reviewed positive
availability snapshot. It contains 590 catalogue items, 70 mastery equipment
definitions, and 58 discovery
targets (42 memory sets and 16 world trees). Source build IDs and SHA-256 hashes
are retained, along with the availability snapshot's SHA-256. The raw S3
artifacts and AWS credentials are never packaged.
esbuild includes the compact snapshot in the main-process bundle, so collection
totals and progression metadata remain available offline.

Regenerate the snapshot locally with configured read access to the S3 bucket:

```powershell
npm run data:collection:availability
npm run data:collection
```

The authoring command validates the current S3 pointer, manifest, sizes and
content hashes. It reads only; it does not upload or publish. An explicit local
pipeline output can be inspected with `--source <directory>`, or a snapshot can
be written elsewhere using `--out <file>`. Normal application startup never
reads a sibling repository or calls little.genius's catalogue API.

`scripts/data/collection-availability.json` is the authoring list of approved
paths and source evidence. Its builder reads the public wiki item tables and
the moderated market catalogue, including nontradeable wiki items. Wiki tags
`Unobtainable`, `Archive`, `Archived`, `Off`, `Disabled`, `Upcoming Content` and
`Upcoming` override market approval. Explicit wiki IDs or unique exact names
within the matching item category establish identity; ambiguous or unknown
items stay excluded. A published crafting entry can approve the recipe of an
independently approved product, but never approves its ingredients implicitly.
Each source's URL and SHA-256 are recorded. The availability builder's optional
`--source <items.json>` uses a local extraction for identity matching only.

Filtering happens before packaging, including recipe IDs, ingredients,
alternatives and mastery definitions. Excluded item IDs are not shipped as a
negative list. The bundler rejects unapproved references or an availability
hash mismatch. Inventory observations cannot reintroduce unknown item rows,
lore scans or enhancement compatibility paths into collection snapshots.
Unknown equipment contributes only an aggregate count and makes calculated
mastery partial. Items without sufficient published evidence are withheld
until the list is refreshed; catalogue totals cover this reviewed subset.

Localized labels come from the selected game language file on the existing
owned CloudFront feed, with snapshot names as a fallback. Images use validated
`/SF/Interface/Graphics/...png` paths on the existing image CDN and load only
as displayed. Their failure does not prevent text or progress from working.
Collection, mastery, cosmetics, resources, enhancements, crafting recipes and
materials, crafting history, Activity and Player Equipment use these thumbnails.
Discoveries use the game's location/tree markers, and palettes without individual
art use its palette swatch. Unknown or failed artwork keeps a small category
symbol in the same space. The widget HTML permits the owned image CDN explicitly;
the shared image helper rejects unrelated hosts and unsafe asset paths.
This snapshot is refreshed when regenerated and rebuilt; it is not added to
the automatic overlay/v2 manifest feed by this change.

## Progress and source limits

Ownership and XP history are separate: selling a mastered weapon makes it
currently missing while its historical XP remains visible. StoreItems aliases
normalize to game types, duplicate XP records use their maximum, and missing
inventory sections remain unknown. The main process projects only the fields
needed by each widget; raw inventory, account IDs, nonces and instance IDs are
not included in these widget snapshots.

Collection Log and Cosmetics also include approved appearances tagged
`Pre-Owned` by the reviewed wiki data. These default hairstyles, palettes and
other cosmetics can be available in game without a standalone inventory entry.
The availability builder preserves that tag only after establishing an exact,
unambiguous item identity; excluded items remain excluded. Applied skin and
transmog paths on held equipment, companion/mother customizations and the active
avatar provide additional positive appearance evidence. Repeated configurations
do not increase copy counts, and neither defaults nor applied paths invent Armory
copies or weapon ownership. This works with both live and saved inventory;
disconnected or waiting sessions still show ownership as unavailable.

Mastery follows the explicit XP tables and per-item contributions. Preludes 17
halves weapon XP: rank 30 now requires 112,500 XP, while Pacts still require
450,000 XP. Both retain rank 30 and contribute 100/200 mastery per rank.
The generator and runtime upgrade only the precisely recognized older weapon
curve, preserving current and future custom tables without halving twice.
These boundaries agree with the wiki's [item levelling table](https://wiki.avakot.org/Gameplay#Item_Levelling)
and [Envoy Rank rules](https://wiki.avakot.org/Envoy_Rank#Attainable_Mastery).
Envoy Rank is calculated programmatically from the inventory's mastery
contributions and the published rank XP curve. Historical equipment XP is
converted to item ranks and weighted mastery; completed discoveries and readable
player skill ranks contribute their published mastery amounts. The resulting
total selects the earned rank and progress to the next threshold. There is no
hard-coded rank 19 ceiling or catalogue-wide maximum applied to the character.
For example, 472,000 mastery XP yields ER 19 and 500,000 yields ER 20 using the
current table. `PlayerLevel`, `Stats.PlayerLevel` and profile endpoint levels
cannot replace that inventory calculation. No inventory or profile data is rewritten.

Incomplete history, unknown equipment and missing discovery data remain explicit
limits on the calculation. Known mastery is not presented as a proven complete
total; equipment-only progress does not become a claimed current Envoy Rank.
Locations award their explicit mastery only at the published memory cap; tree
bits award no mastery. Player skill ranks contribute only when their structure
can be read reliably. The older Player Equipment tab and Build Exporter use the
same published equipment mastery boundary. Build Exporter also uses the shared
inventory-derived Envoy Rank for its virtue pool and marks incomplete mastery
for review. Session Analysis uses inventory-derived rank observations and starts
a fresh baseline when the calculation basis changes, so profile-level refreshes
and old reported-level history cannot create invented rank gains.

Crafting totals cover the published ingredient list. The source currently
omits Dracs costs and does not provide an acquisition route for every item.
Some recipes are reforges requiring an existing copy. The planner does not
invent drop locations, vendor routes or recursive acquisition recipes.

Activity compares adjacent complete live observations. Purchases, crafting,
trades and consumption also change inventory; entries are not asserted to be
loot pickups. Cached snapshots do not create historical events. Changing
account, connection or cache/live state restarts the baseline.

Session Analysis stores bounded observed mastery history privately in the
existing encrypted app cache, separated by a hashed account key. No offline
play history is inferred. Crafting history has no invented timestamps or
repeat counts. Profile combat statistics are unavailable from the overlay's
inventory source and are not fabricated.

## Local verification

```powershell
npm test
node scripts/check-collection-widgets.js
npm run build:portable
node scripts/check-collection-widgets.js --packaged-renderers
node scripts/check-collection-widgets.js --packaged-renderers --live-images
```

The native check uses an isolated profile and fixture inventory through the
real main/preload/widget-host bridge. It exercises connection/cache/live
states, controls, ownership, goals, activity, privacy and narrow/wide layouts,
and writes screenshots plus a report under `output/collection-widgets`.
The optional packaged-renderer mode repeats these checks against the built
ASAR preload and renderer assets, using the isolated source-main fixture bridge.
`--live-images` additionally decodes real CDN artwork and captures image-filled
widgets. Only the owned image CDN is allowed through this check's network filter;
the game and other network services remain mocked. An image preflight can be run
alone with `--image-preflight` to diagnose an image-policy failure.

Verified locally on November 18, 2026: the Node suite, source Player/Daily Brief
checks and source/packaged collection checks passed. The Windows NSIS build
includes all 15 configured locales. A bundle audit found no remaining exact
references to the removed item, recipe, ingredient or mastery paths, nor their
unique language keys, description keys or icon paths. Evidence is under ignored
`output/collection-mastery-*`, `output/collection-widgets*` and
`output/inventory-widgets/`. No release was published.
