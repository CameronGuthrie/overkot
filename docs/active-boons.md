# Active Boons

Open **Player → Boons** from the dock to see account boons from your current inventory. Each card shows the time remaining and the expiration date. The soonest expiration appears first. Countdown updates run locally every second; the widget reuses the existing inventory connection.

Expired records leave the active list as their countdown ends. **Show ended** reveals the expired records still present in the inventory. Saved inventory remains usable offline, with a notice that its expiration times need confirmation in game. Missing boon information is distinguished from an inventory that explicitly reports no boons.

The widget reads `Boosters[].ItemType` and `ExpiryDate`. Expiration is interpreted as Unix seconds; missing, zero, malformed or millisecond-shaped values are reported as unreadable rather than presented as permanent boons. Duplicate item types use the latest valid expiration and never add durations together. Names use the overlay's existing inventory label lookup with readable fallbacks.

The model projects only boon identifiers, names and expiry times. It does not send raw inventory or account credentials to the renderer. There are no game-changing actions or additional network requests.
