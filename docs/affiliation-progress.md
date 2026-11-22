# Daily affiliation progress

Daily Affiliation and Ode Infamy use the game's current daily limit rather than
a fixed 16,000. `DailyAffiliation` and `DailyAffiliationOde` in inventory are
remaining allowances. The displayed maximum is calculated from the game's player
level and its extracted rule: `base + perRank × PlayerLevel`.

The November 18, 2026 build supplies a base of 30,000 and 1,000 per rank, so rank
21 has a 51,000 daily cap. This agrees with the published
[Envoy Rank rules](https://wiki.avakot.org/Envoy_Rank). The inventory player level
is appropriate here because the game's own Faction Standing interface passes its
player-level result to the cap method; this does not change the separately
calculated Envoy Rank and mastery widgets.

## Game source and authoring

`src/data/affiliation-rules.json` is a small source-attributed snapshot extracted
offline from the installed executable. The Faction Standing script separately
calls `gGameData:GetDailyStandingLimit(bin)` for the remaining allowance and a
`gGameConfig` method (atom `0x2c7ac218`) for the maximum. Its native implementation
multiplies player level by one configuration field and adds another. The values
are native defaults, so the formatted package export need not contain them.

`scripts/build-affiliation-rules.js` parses the PE file without loading, launching
or attaching to the game. It follows the exact Luau method registration to the
native multiply/add routine, derives the configuration field offsets from that
routine, then reads the corresponding constructor stores. The constructor must
reference the table labelled `SFGameConfig`; unrelated classes with the same field
offsets are rejected. Missing, changed or ambiguous evidence stops authoring.
Neither coefficients nor executable offsets are silently guessed after updates.

```powershell
npm run data:affiliation -- --executable <Soulframe.x64.exe> --version <versionInfo.json>
```

The snapshot records the game build label, executable SHA-256 and native evidence
locations. Raw executable and package data, private paths and account inventory
are never packaged. Normal app startup reads the bundled snapshot and current
inventory; it does not inspect the executable.

## Incomplete observations

Without a readable player level or rule, the raw remaining allowance is still
shown, while the maximum, earned amount and percentage remain unavailable.
Remaining allowance is never clamped to an obsolete cap. Live and saved inventory
use the same calculation, and cached earned totals are recalculated from their
raw inventory when available.
