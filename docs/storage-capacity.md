# Equipment storage

Open **Player → Overview** from the dock. It shows free equipment slots,
occupied slots by category, a capacity bar, and an over-capacity warning.

The inventory's `UniversalBin.Slots` is the remaining allowance, not the total.
The total is calculated by adding it to counted equipment in `Melee`, `LongGuns`,
`Suits`, and `WeaponSkins`. Records with `IgnoreBinCount` are excluded; repeated
instance IDs are counted once. Negative free slots remain visible.

Missing categories or malformed equipment records withhold the total rather
than guessing. Saved inventory is labelled with its original timestamp. No
inventory modification or extra game request is needed.
