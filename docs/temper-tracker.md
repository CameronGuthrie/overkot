# Temper Tracker

Enable **Temper Tracker** in Modules. The default **Blacksmith unlocks** view
lists every temper with progress out of **10**, grouped into **Fully unlocked**
and **Incomplete**. Both groups are visible initially; **Hide unlocked** and
**Hide incomplete** independently hide either group. You can also group by
origin or name. A temper reaches full unlock at 10/10, including tempers that
none of your current weapons carry.

Select **On your weapons** for the existing inventory holdings view, including
unequipped weapons. Filter All / Held / Missing and group by origin, name or
weapon. Both views support searching by temper or weapon. Click a temper for
its blacksmith progress, description and a breakdown of carrying weapons,
craftwork, copies and equipped instances.

Counts come from the existing inventory poller. Acquiring, selling or deleting a
weapon changes the totals on the next successful inventory update. There are no
additional inventory requests or renderer timers. Icons download once per hash. Cached
inventory is labelled; logout clears the view. Search, filter, grouping, scroll
position and selected temper survive updates. The module supports the standard
floating/docked layouts, collapse, resize, themes and opacity settings.

The selected view, holdings filter, grouping for each view, hide controls,
search text and collapsed list groups are saved in your app preferences.
They restore when reopening the widget and after restarting the app. These
display preferences remain the same when connecting another account; counts
always come from the currently connected inventory. Invalid saved preferences
fall back to the default controls.

Blacksmith progress comes from banked temper items, independently of current
copies **on weapons**. Acquiring or deleting a weapon does not change unlock
progress unless the game's banked temper count also changes. Empty inventories
show zero progress and holdings; the tracker never accumulates deleted weapons
as collection progress.

## Inventory mapping

- Read `RawUpgrades` entries under `/SF/Types/Items/Aspects/Tempers/`. Their
  `ItemCount` supplies blacksmith progress, capped at 10; absent tempers start
  at 0. Duplicate records use the highest count, not a sum. Malformed counts
  are reported. Unknown banked types remain visible with their progress.
- Resolve the two distinct blacksmith item types `HeavyAttackDamageAndStaggerMod`
  (Full Force) and `MagickHeavyAttackDamageAndStaggerMod` (Arcane Barrage)
  separately from their shared weapon fingerprint tag.
- Read `Melee` and `LongGuns`; deduplicate inventory instance IDs.
- Parse each weapon's `AspectFingerprint.buffs`. Each entry is one copy, so two
  equal entries are a double stack. `Value` is a random roll seed, not quantity.
- Ignore curses and loadout configs when counting. Use the selected NORMAL
  preset only to annotate equipped weapons.
- Resolve canonical paths and tags using the catalogue. Resolve the shared
  `HeavyAttackDamageAndStaggerMod` tag per weapon: Full Force or Arcane Barrage.
- Preserve unfamiliar tags with their counts and source weapons. Report
  malformed fingerprints without losing other weapons' holdings.
- Send only display fields to renderers. Account IDs, nonces, inventory IDs,
  fingerprints and roll seeds are excluded.

The main process derives one snapshot per new inventory response while enabled.
Only changed display data is broadcast; unrelated XP or currency changes do not
redraw the tracker. Snapshots are rebuilt from inventory rather than incremented,
so account changes and weapon removal cannot leave stale totals.

## Catalogue

The [remote display feed](data-updates.md) supplies the selected language's
catalogue and verified PNG icons from S3. Names, descriptions and per-weapon
aliases come from the game's weapons/language data, including the correct Cowp
and Bypass mappings. TemperList and the old local JSON/WebPs are test/authoring
fixtures only and are excluded from the portable build. Catalogue updates
recalculate holdings even when inventory itself has not changed.

## Checks

```powershell
node --test test/temperTracker.test.js
node --test test/trackerPreferences.test.js test/temperTrackerPreferences.test.js
npm run pack -- --skip-scanner
node scripts/check-temper-tracker.js
```

The unit tests cover the 10-count unlock boundary, independent banked and weapon
counts, duplicate and malformed upgrades, unlock-only updates, stacks,
acquisition/removal, shared tags, malformed and unknown data, cache/session
changes, quiet unchanged polls and private-field exclusion. The native Electron
check uses synthetic inventory and allows only public feed requests to exercise
real IPC, the default unlock list, both hide controls,
live unlock transitions, view switching, search/details, filters, icons,
packaged ASAR/CSP, sizing, collapse, docking, themes and module toggles.
