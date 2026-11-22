# Session Gains

Open **Player → Session** from the dock to compare resource stacks,
consumables and available currency fields against your first live inventory
snapshot. Search the list, show unchanged holdings by clearing **Changed only**,
or choose **Restart** to start a fresh comparison from the current live snapshot.

The widget measures **net inventory changes**. Using a consumable, spending
currency, crafting or trading affects the totals. It cannot distinguish those
actions from pickups and does not claim to count gross loot.

**Net / hour** divides each item's net change by the time between its baseline
and its last complete live observation. The observed window advances when a new
inventory snapshot arrives. A zero-length window has no rate. Cached inventory
never starts a session; if a live session later pauses, its observations and
rates stay frozen until another live snapshot arrives.

Tracking is held in memory. Disconnecting, changing accounts, starting another
game session, or restarting the overlay clears the baseline. Tracking continues
while the widget is enabled even when its panel is closed.

## Data handling

- `MiscItems` and `Consumables` use exact `ItemType` identities and aggregate
  duplicate `ItemCount` stacks within each section.
- Only exact `RegularCredits` and `PremiumCredits` fields represent currencies.
  Missing fields are unavailable, never zero.
- A missing or malformed section is withheld. This prevents a partial response
  from inventing spending or losses. A complete empty array is a real zero.
- A section first available later gets its own baseline at that first complete
  observation. Hover its item name to inspect the starting amount and time.
- Older live snapshots cannot roll back the latest observations.

## Verification

Run `node --test test/sessionGains.test.js` for aggregation, positive and negative
net changes, rate calculation, partial data, cache handling, session boundaries,
out-of-order snapshots and reset behavior. In the app, enable the widget, verify
that saved inventory waits for a live update, acquire or spend an item, and
check that **Restart** clears the comparison while search remains usable.
