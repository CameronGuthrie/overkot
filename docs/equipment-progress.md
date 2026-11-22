# Equipment XP

Open **Player → Equipment** from the dock to browse weapon and Pact types from the current inventory snapshot. Search by name and filter by category, ownership, or historical XP records. The widget uses the overlay's existing inventory data and makes no additional game requests.

The displayed XP is the highest value found for an equipment type across `XPInfo` and currently owned copies. Duplicate records never add XP together. A recrafted weapon therefore keeps its historical XP record while the current copy's XP is shown separately when it differs. A historical record does not mean the equipment is currently owned. Missing XP is shown as unavailable; zero remains a valid value.

Missing or malformed ownership sections are reported as unavailable. A type is classified as **No longer owned** only when its relevant ownership category can be read completely and contains no copy. A known owned copy remains positive evidence even when another record is unreadable.

Melee and ranged weapons use the same Preludes 17 mastery threshold as the build exporter: 112,500 XP at rank 30. Their bars show XP toward that threshold, not progress through estimated ranks. The weapon XP curve is half the former curve; Pact XP and Envoy Rank thresholds are unchanged. Pact ranks, unclassified weapon mastery, partial ranks and total Envoy mastery are not inferred. Only types present in the snapshot are listed; this is not a full equipment catalogue.

The module projects a small, read-only model through `createEquipmentProgressModel().read(inventory, context)`. It retains no history between accounts and exposes no account, session or item-instance identifiers. Shared inventory widget controls display live/cached status, timestamps and refresh errors. Search controls stay mounted when snapshots change so typing retains focus.

Run `node --test test/equipmentProgress.test.js` to check historical ownership, duplicate XP, zero/missing values, invalid records, category conflicts and account isolation.
