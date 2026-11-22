# Calendar module

Enable **Calendar** in Overkot’s Widgets window. The day card shows the ancestor encounter and Zenith’s four offers. Use the arrows, date picker or **Today**; days reset at midnight UTC. Item and ancestor names open the existing wiki search. Floating, collapsed and docked layouts use the same card.

Click **Zenith’s offerings** to hide or show the offers. The widget resizes to
fit, and the preference survives date changes, restarts and switching between
floating and docked layouts.

**Ancestors…** opens account unlocks and manual checkboxes. Zenith and Dale Seer (called `Moose` in the source) stay in the pool. Overrides belong to the account that set them. **Reset to account unlocks** removes them and uses the latest inventory, including changes received while the panel is open. Missing inventory is shown explicitly; selecting all six optional ancestors manually allows an offline prediction.

The encounter asset’s `_questResources` maps Garren Rood to `TCDemoQuest`, Bromius and Orengall to their omen beast quests, and Tuvalkane, Verminia and Orlick to their discovery quests. Inventory completion dates establish completion; an opaque `Completed` progress string alone does not. Resident ranks are a fallback when the discovery quest is absent, with rank `-1` treated as locked. Other resident ancestors are not in this encounter pool. Cached inventory is marked as saved data and is account checked before reuse after login.

## Updating the data

Production uses the shared [remote display feed](data-updates.md), projected by
`soulframe-node-api` from the private S3 pipeline build. The old local calendar
generator remains useful for authoring fixtures, but is not a production source.

Input: `zenith-calendar.json`, plus `gods-and-ghosts-calendar.json/index.json` and its 64 variation files. The generator validates every pool and consecutive UTC dates, then removes resource paths, seeds and duplicate strings. Zenith and encounters can cover different date ranges; missing days display “No schedule published” independently.

There is no packaged calendar fallback. Previously verified downloads work
offline; a first launch waits for the remote calendar. Publish both source
calendars through the pipeline project, which causes a new compact object hash.

Enabled calendars check the small manifest at most every six hours, using ETags. A matching SHA-256 requires no data download. Changed data is one Brotli compressed projection, with compressed and decoded hashes, size limits, schedule validation, atomic cache replacement and offline fallback. No account inventory or unlock choices are sent to the calendar CDN. Disabled calendars make no calendar requests.

The verified September pipeline calendar contains all 64 unlock combinations
across 181 days, beginning June 14, 2026. It occupies 13,208 bytes of canonical
JSON / 1,006 bytes of Brotli. Older source fixtures remain only for tests.

## Checks

`node --test` covers date validation, unlocks, all 64 pools, override/reset/account changes and update failures. Calendar now opens in Daily Brief or World Watch. Run `node scripts/check-inventory-widgets.js` for the real Electron main/preload, Daily calendar, login/reset and dismissal behavior, Player tabs and picker lifecycle. The older `check-calendar.js` command delegates to this consolidated check. Screenshots use an isolated synthetic account and are saved under `output/inventory-widgets/`.
