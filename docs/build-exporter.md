# Build Exporter

In an official build, enable **Build Exporter** in Modules, then click **Open on avakot.build**. A community build enables that button when its service profile sets `buildWebsite` to a compatible planner. The button shows the configured host.
The module reads fresh inventory and opens the currently equipped NORMAL loadout
as an unsaved website draft in the default browser. The website handles review,
editing, login and Save & share, just as it does for Little Genius's Armory export.

The module contains only the export button, with no build name or success footer.
It supports floating/docked layouts, collapse, sizing, themes and opacity.
It stays disabled until the current session has inventory and an equipped preset.
It does not offer a cached account's build as the current build. Loading, session
changes, missing gear, network failures and browser failures use the button's
tooltip and accessible description. A failed export changes it to **Retry export**;
the button stays the same size throughout loading, success and retry.
Repeated clicks share one pending export.

## Build mapping

The conversion follows Little Genius's `armoryService.ts`, `armoryFingerprint.ts`,
`armorySkills.ts` and `armoryTransfer.ts`:

- Select the NORMAL preset referenced by `CurrentLoadOutIds`, not the first preset.
- Resolve exact equipped inventory instances and each slot's selected `cus` config.
- Carry weapons, Pact, helmet, cuirass, leggings, talisman and joinery by game path.
- Preserve Rune rank and the Courage/Spirit/Grace/bonus mote socket order, each
  mote's rolled virtue and exact compatible grip. Fingerprints can be objects or JSON.
- Calculate Envoy Rank from the inventory's equipment mastery, completed
  discoveries and readable player skill ranks using the published XP curve,
  shared with the mastery panel. `PlayerLevel`, profile statistics and a fixed
  release ceiling do not determine rank. Use the calculated rank for the virtue
  pool, DynamicVirtues coordinates and the separate Orengall/Bromius quest bonuses.
  Carry zero-based selected skill-tree levels for website hydration.
- Map positive temper tags to website language keys, including stacks (two per
  temper, eight total) and weapon-specific meanings for shared melee/casting tags.
  Craftwork follows the game's Worn/Military/Officer/Noble/Masterwork/Legendary
  quality order, raised when required to fit the detected temper count.
- Use the published item mastery threshold (112,500 weapon XP in Preludes 17).
  Partial weapon ranks remain editable at zero, with review feedback.
  Curses and random roll seeds are not represented by the website's planner.

Incomplete inventory mastery marks the export for review. If no inventory rank
can be calculated, the planner's editable rank starts at zero; a profile level
is never substituted. No inventory or profile data is modified.

The [remote display feed](data-updates.md) supplies a compact, verified temper
alias catalogue derived from the game's per-weapon data. The rest comes directly
from inventory paths. The old `src/data/build-export.json` is a test fixture and
is excluded from packaging. The button waits for its first catalogue download.

## Browser handoff

The website's existing import contract is
`https://avakot.build/?new=1&import=1#lg=v1z.<deflate-raw-base64url>`.
Its envelope requires `{v:1, source:"little-genius", state}`. That source marker
is retained for compatibility; the website currently labels these imported
drafts as Little Genius imports. No website changes are required.

Only the planner fields are serialized. Account IDs, session nonces, inventory
instance IDs, other inventory sections and fingerprints never enter the link.
The code is in the URL fragment, not the query string. Website limits of 100 KB
uncompressed and 32,768 encoded characters are enforced before opening it.

Windows [Electron shell.openExternal](https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options)
limits URLs to 2,081 characters. Larger compressed exports open a short,
unpredictable loopback URL which redirects once to the complete website link.
The listener binds only to 127.0.0.1, sends no-store/no-referrer headers, and closes
after use, a launch failure or 60 seconds. No temporary build file or server-side
short-link upload is needed. The app makes one fresh inventory read per export;
idle module status comes from the existing poller without additional polling.

## Checks

```powershell
node --test test/buildExporter.test.js test/buildDraftBrowser.test.js
node scripts/check-build-export-contract.js C:/path/to/soulframe-builds
npm run pack -- --skip-scanner
node scripts/check-build-exporter.js
```

The contract check uses the actual website decoder and skill mapper. Native
checks use synthetic inventory and intercept browser opening; they do not send
account data or publish a build. They cover fresh data, reconnects, errors,
packaged assets/CSP, docking, live themes, module toggles and sizing.
