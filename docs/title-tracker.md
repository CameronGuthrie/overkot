# Title Tracker

Enable **Title Tracker** in **Add / remove widgets**. It is included in normal
development and packaged builds for the upcoming 0.0.14 release; no beta channel
or environment setting is required.

The tracker lists enabled epithet challenges with a title, requirement,
progress bar and current/required count. Search titles and requirements, and
hide completed and incomplete rows independently. Multiple titles can be
pinned to the top. These choices and the Temper Tracker's filters and selected
dropdown persist in local settings.
The eye toggle hides the search and visibility controls and shows all
pinned titles. It retains the filters for when the toggle is turned off, and its
state persists between sessions.
Pins use a pushpin icon and highlight when selected. In pinned-only mode, the
outer window background and border disappear and titles start immediately at
the top. A slashed eye beside the first title's pin restores the full view.
Cached-data and unreadable-record notices appear in the full view; save failures
remain visible in either view so preferences can be retried.

The [optional local beta package](title-tracker-beta-build.md) remains available
for isolated build testing. Enabling the widget does not publish a release or
change the public package version and update feeds.

## Epithet source

Normal builds use the compact, validated catalogue checked in at
`src/data/title-catalog.json`. Its source and catalogue hash are recorded in
`src/data/title-catalog-source.json`. Development uses the same snapshot, so the
widget works immediately and offline without private AWS credentials.

To refresh the checked-in snapshot with an authorized AWS CLI account:

```powershell
node scripts/build-title-data.js --refresh
```

The refresh reads `current.json` from the existing
`s3://soulframe-pipeline-data` bucket, then the matching
`builds/<build_id>/manifest.json` and `Artifacts/epithets.json`. It verifies the
source file's manifest SHA-256 and byte count before projecting the display and
challenge fields. Review and commit the resulting catalogue and provenance
together. Normal release and CI builds validate those files instead of reading
the private bucket. The optional local beta uses a freshly verified S3 catalogue.

All source operations are reads. The refresh does not change the bucket, API,
CloudFront configuration, website or release feeds. AWS credentials stay with
the developer's AWS CLI and are never bundled with the application. Packaged
builds receive only the compact catalogue through `__OVERKOT_TITLE_CATALOG__`;
they never read the developer's pipeline directory or bundle raw pipeline data.

The bundled snapshot makes the public epithet feed optional. `EpithetsData`
supports `https://d2855gck1tg5bh.cloudfront.net/files/epithets.json` when available,
without making it a prerequisite for using the widget. It makes bounded HTTPS GET
requests, disables redirects, validates catalogs, limits downloads to 1 MiB,
deduplicates simultaneous requests and waits six hours between checks. A failed
check preserves its last good downloaded catalog or the bundled snapshot. Verified
downloaded catalogs are cached across sessions and revalidated using ETags.

## Inventory progress

`ChallengeProgress` contains `{ Name, Progress, Complete? }` records. Match the
current challenge name/path and its explicit legacy alias from epithets data.
These are cumulative totals, so duplicate or legacy/current records use the
highest value instead of being added together. Counts are clamped to the target.
Unrelated challenges and unknown title types are not assigned guessed names or
targets. Malformed known-title progress is ignored and counted for a UI warning.

An explicit `Complete: true` or an owned title in `FlavourItems` sets progress to
the target. This matters because completed legacy challenges can return
`Progress: 1` for targets such as 100 or 500. A valid total reaching the target
also marks completion. Owned title item paths accept the normal and store forms.
Rows with no observed challenge start at zero.

`TitleTracker` follows the existing inventory session lifecycle: `connect`,
`waiting`, `data`, `cached` and `live`. Expired/disconnected sessions clear displayed
account progress; cached inventory is labelled separately. The tracker emits
only changed snapshots and recomputes when its catalog changes.

## Local checks

```powershell
node --test test/titleTracker.test.js test/epithetsData.test.js
node --test test/titleTrackerRenderer.test.js test/temperTrackerPreferences.test.js
npm run build:portable
node scripts/check-title-tracker.js
```

Tests use synthetic inventory and epithets data. They cover current/legacy
matching, ownership, completion flags, malformed counts, catalog changes,
session transitions, request deduplication, ETags, corrupt caches, offline
fallback and size/URL restrictions. No account data or credentials are in them.
