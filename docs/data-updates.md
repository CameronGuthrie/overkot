# Remote game data

Official desktop releases v0.0.17 through v0.0.19 read the account-protected version 2 feed.
The public `/files/*` and `/overlay/*` routes were retired on 22 November 2026.
The legacy image distribution was disabled and its S3 read permission was removed.
Users of earlier builds can upgrade to v0.0.19 and connect their avakot.dev account.
Community builds can select their own version 2 feed with `dataManifest`. [Build instructions](../README.md)
Version 2 adds compact wolf labels/progression and vector dungeon outlines with
ordered generator tables. Dungeon geometry is fetched only for the active set;
verified cached sets remain available offline.
The API projects only the display data the overlay needs from the private S3
pipeline build. Connect avakot.dev in **Settings → Connections** to authorize downloads.
The main process exchanges the existing native account credential for a five-minute,
read-only data token and refreshes it before expiry. No shared API key is bundled,
and no game inventory is uploaded to authorize data. Signed-out clients keep using
verified saved data; a first launch without authorization shows a waiting state.

Item artwork uses the `overkot-game-data://images` protocol. The official profile reads
validated artwork paths from its protected API. A community profile can set `imageBase`
to a static server with the same `/SF/Interface/Graphics/` layout. Those requests carry
no account credentials. Both paths refuse redirects, limit each image to 8 MiB and
check PNG/WebP signatures. The official profile clears tokens and its in-memory artwork
cache on sign-out. Tokens stay in the main process.

The v0.0.19 installer also contained 35 legacy temper WebPs (218,592 bytes)
alongside its UI code, translations and application artwork. The packaging
rules now omit those WebPs along with the map tiles and map markers. The
public source excludes the CDN fixture directories. Maintainers can keep local
copies in `assets/map-tiles/`, `assets/map-icons/`, `assets/map-json/` and
`assets/tempers/`; Git ignores them. Tests use synthetic map imagery.

The main process checks the manifest every six hours using ETags. It requests
only changed, needed files: the chosen locale, enabled module catalogues and
shared map assets and temper icons. JSON uses Brotli. The app verifies PNG and
WebP downloads against their manifest sizes and SHA-256 digests. Three
concurrent downloads, request deduplication and retry backoff limit
client traffic. There are no user-specific ZIP requests. Updates operate per
compact file/tile, not as binary patches.

After connecting avakot.dev, a single background worker warms the persistent map
cache before a game connection is needed. It fetches known marker icons, small
POI layers, map labels for the selected locale, the 196 shared map tiles
from the center outward, and the manifest's temper icons. Opening a widget
can request an icon immediately using the same cache. Installation and startup
can complete offline. Three consecutive
unavailable assets pause warmup until a later scheduled data check; existing
hash verification, retry backoff and offline fallback still apply. Quitting
stops further background requests.

The app saves a PNG thumbnail up to 160 pixels on its longest side when that
reduces the object's size. It keeps the source SHA-256 for CDN change checks
and the thumbnail SHA-256 for checking the local bytes. An upgrade can convert
verified full-size icons already on disk while offline. Shared icon references
use the same file. In an isolated copy of the v0.0.19 cache, the 41 distinct
temper PNGs occupied 6,285,982 bytes before conversion and 1,478,887 bytes
afterward. Their source images remain available through the protected feed.

Wire and decoded SHA-256/length checks run before installation. The downloaded
cache survives restarts and offline use. Failed downloads retain verified older
files; a missing retired hash triggers one bounded manifest refresh. A first
offline launch has no game data, so modules show a waiting state. There is no
packaged snapshot fallback. Legacy downloaded map caches remain readable.

The API refreshes its source pointer at most once per minute and prepares fixed
projections once per loaded build. Protected responses use `private, no-store`
and CloudFront caching is disabled for protected routes. The app's hash-verified local
cache remains available offline. Source permissions are read-only and
limited to existing pipeline builds plus the required icon paths. When the
version 2 manifest has no compact pack for a language, the app uses the
selected game dictionary from the protected CDN. Thai, Ukrainian and
Traditional Chinese use this path while the manifest advertises 12 languages.

In the original compact feed, all JSON across 12 languages, the calendar and
dungeon geometry shrinks from about 8.0 MB to 1.78 MB. A client downloads its
selected language and active dungeon set. The 196 original map tiles
total about 35 MB for the first full map cache. Subsequent launches reuse
verified files; later releases download only changed tiles and markers.

The September 12 map extraction corrects positions and supplies explicit dungeon
entrances. The public feed must publish that build and preserve nullable level
overrides; older projections omit valid pool candidates. See [map display data](map-data.md)
for the schema, comparison tool and native verification. Live ancestor discovery
still comes from the player's game log.

## Verification and publishing

```powershell
npm test
node scripts/audit-pipeline-sources.js --local C:/path/to/soulframe-pipeline-runner/output
npm run build:portable:fast -- --skip-scanner
```

The audit is read-only and uses the developer's AWS CLI identity; AWS credentials
are never included in the app. Its report is under `output/pipeline-source-audit`.
The old `scripts/build-data.js` remains an offline schema-1 fixture generator;
production publication belongs to `soulframe-node-api` and the pipeline project.
Developer imports prefer `Artifacts/ava_api_items.json`, `Languages/` and
`maps/map-json/`, with fallback to the previous export paths. Normal tile image
paths come from `tile_layout.json`, so the exporter can rename its tile folder.
The local feed and calendar generators default to `soulframe-pipeline-runner/output`;
`--source` selects another extraction. These source paths do not change the
public overlay manifest or its asset keys.

For native checks, run `bun scripts/check-overlay-live-source.ts --serve` in the
API project, then run `scripts/check-temper-tracker.js`, `check-inventory-widgets.js`,
`check-build-exporter.js` and `check-overlay-map.js` here. These use synthetic
inventory, an isolated profile, the packaged Electron runtime and ASAR renderers.
Only the public test-feed network is allowed. Set `OVERKOT_DATA_MANIFEST_URL` to
the production manifest to verify the deployed feed instead.

Release validation on September 12, 2026: all 289 production entries downloaded
and passed the desktop's hash/size checks; every locale catalogue validated;
the next manifest check returned 304 with zero asset downloads; all 289 cached
entries worked after an offline restart. Native map, minimap, calendar, temper
tracker and build-export checks passed against the production feed in an
isolated staged checkout. Its 122 unit tests passed and its 2.96 MB ASAR contained
no game snapshot directories. Restricted raw/typed routes still returned 404;
repeated image GETs were served as CloudFront cache hits.
