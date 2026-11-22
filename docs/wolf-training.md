# Wolf training

Enable **Wolf Training** in the widget picker. It works in a floating window or the docked layout and updates from the existing inventory connection.

The widget shows one companion with its name, temperament, bond, energy and five training stats. It follows the companion in your current loadout, or uses the first readable companion when the loadout is unavailable. **Details** reveals the raw XP and allocated paw count for each stat.

The paw shapes distinguish three states:

- Sage fill shows progress toward the next trained paw.
- A gold outline means the paw has been trained and can be allocated in game.
- Solid gold means the paw has already been allocated in game.

The widget reports inventory state and does not allocate training points or modify the game. A rest notice is shown only when the save reports `NeedsRest`; its tooltip gives the recorded rest timestamp without inventing a rest completion timer. A saved inventory is clearly marked.

## Data and precision

`WolfTraining` reads `KubrowPets[].Details` and resolves the equipped companion from the active `LoadOutPresets.SENTINEL` preset. It emits compact snapshots through `wolf-training-changed`; inventory credentials and internal localization paths stay in the main process. Unreadable records are counted, duplicate identities are ignored, and expired sessions clear the cards.

Game strings and progression arrive through the content-addressed data feed as `wolf-training/<locale>.json`. Each document contains `schema: 1`, a `labels` map and `progression` with `maxEnergy`, `maxMaturity`, ascending `skillThresholds`, and optional ascending `bondThresholds`. A verified bond curve resolves the localized bond type; without one, the exact saved bond points remain visible and the tooltip explains that the type is unconfirmed. Label data may contain `/SF/Language/Pets/*` and `/SF/Language/Quests/OrengallPupName*` entries.

The offline energy maximum comes from the installed game's exact
`WolfCubPetPowerSuit.MaxEnergy` package attribute, projected into
`src/data/wolf-progression.json` with the game build label and source SHA-256.
Build `2026.11.18.14.58` specifies 150 energy. The authoring projection reads
`MaxEnergy` and `MaxMaturity` rather than the pet's current saved energy; identical
repeated package declarations are accepted, and conflicting declarations fail.
Regenerate it from a fresh installed-cache extraction using:

```powershell
node scripts/build-wolf-progression.js --source <formatted_packages.json> --version <versionInfo.json>
```

The exact older preview and verified overlay progressions still carrying the
retired 100-energy maximum are migrated to this snapshot, including offline
caches. Other explicit progression curves and future maxima remain authoritative.
The saved pet energy is never rewritten, and the number, bar and accessible
progress scale all use the same resolved maximum.

Progression carries `estimated` and `confirmedSkillLevels`. The verified offline skill curve is `[600, 2000, 3900, 6300, 9000]`. Bond transitions are `[125000, 421900, 1000000, 1953100]`, for Tame, Loyal, Loving and Soulbound; Wild is the initial display type. The localized type and exact saved points appear beside energy. The exact first-preview estimated curve migrates automatically, including in offline caches; other explicitly estimated catalogues retain their approximation note and `≈` markers. A future catalogue can replace the curves without an app release. Missing catalogue labels use readable English labels; an unknown companion name uses a generic wolf-cub label.

The current `/SF/Types/Game/Pets/OmenWolfs/WolfCubPetPowerSuit` package supplies energy 150, maturity 15, five paws per stat, skill base 50 / exponent 1.65 and bond base 25 / exponent 3. Native code verifies the placement of the base inside the exponent and rounding to the nearest 100 points:

```text
threshold(level) = floor(((base × level) ^ exponent) × 0.01 + 0.5) × 100
```

## Native evidence

The October 3, 2026 game executable was inspected without loading it or changing its process. Reproduce the script evidence with `soulkit scripts extract --path-filter Pet --output-dir <research>` and `--path-filter Interface`, then use `soulframe-reversing readable <bytecode> --output <readable> --executable <Soulframe.x64.exe>`. Addresses below are virtual addresses in that executable; they must be rechecked after a game update.

- `/SF/Interface/PupSummary.lua`, prototype 3 at PC 80, obtains bond type from `PlayerPetLib.GetPetSkillLevel(player, 8)`. Its initializer maps rank 1 through 5 to Wild, Tame, Loyal, Loving and Soulbound.
- `/SF/Scripts/Libs/PlayerPetLib.lua`, prototype 14, calls pet suit atom `0x55a66dd6`. Its native registration at `0x142206550` points to wrapper `0x141b4ea60`, which calls `0x1408094f0`. Stat 8 uses the bond XP level calculation; stats 1 through 5 return separately allocated paw bytes.
- The serializer at `0x141575433` pairs property-name descriptors with object fields: `0x142829438` → `mBondLevelPowerMod` → `+0x44e8`; `0x142829448` → `mBondLevelBaseValue` → `+0x44ec`; `0x142829458` → `mSkillLevelPowerMod` → `+0x44f0`; `0x142829468` → `mSkillLevelBaseValue` → `+0x44f4`; and `0x142829488` → `mMaxBond` → `+0x44fd`.
- Bond threshold wrapper `0x141b4e270` (atom `0x70d807a0`) calls `0x140535b00`. The latter multiplies the level by the base before the power call at `0x141bfaf00`, then rounds using float constants `0.01`, `0.5` and `100` at `0x141fffbc4`, `0x141fe6514` and `0x141fecbc8`. The skill threshold routine at `0x14119d844` uses the same rule with the skill fields. Skill XP levels are independently computed by `0x140cc1640` (atom `0x82b1de4f`).

Bond level 1 has a 15,600-point threshold, and the first named type is Wild. The widget keeps Wild as the baseline for lower scores as well, matching the in-game reading of 3,481 points. Named transitions start at native level 2 (125,000), followed by levels 3 through 5. It does not infer bond from maturity or allocated paws.

## Verification

Run `node --test test/wolfTraining.test.js` for save parsing, interpolation, localization, allocation, catalog validation and session lifecycle checks.

Run `node scripts/check-wolf-training.js --source` for an offline Electron check using synthetic inventory. After building the portable/unpacked runtime, run the same script with `--packaged` to exercise the packaged renderer, preload bridge and Chromium runtime. The checks write screenshots and an isolated app profile beneath `App/output`; they do not connect to the game or change the normal app profile.
