# Daily Brief

Daily Brief gathers daily allowances, the ancestor encounter, Zenith's weapon
offerings, Avakot's Gots, faction vendor weapons, and the calendar in one floating pop-out.
The former standalone Calendar selection migrates to Daily Brief. The five
inventory widgets migrate to the tabbed [Player panel](player-widget.md).

The brief starts closed. By default it opens after your first live inventory
on Soulframe login and when a new UTC day starts while you are connected.
**Done** closes it; ordinary inventory updates do not reopen it. The dock icon
opens or closes it manually. Change **Show automatically** in the brief or
Settings → Widgets → Daily Brief to turn either trigger off. Disabling Daily
Brief in the picker disables automatic opening too.

Daily Brief has its own draggable title bar, native resizing and remembered
position and dimensions. It does not attach to the widget grid or consume
space beside docked panels. Minimize affects only the brief; clicking its bar
icon restores the same window. Closing it leaves Overkot running. Today,
Vendors and Calendar scroll inside the chosen window size.

Daily reset is **00:00 UTC**, independently of your computer's timezone. A
hidden overlay keeps a pending brief until it can be shown, without taking
input focus from the game. Sleep across midnight is handled on resume; a clock
moving backward does not replay the reset. Cached inventory cannot cause a
login popup. Previous-day allowances are withheld until a fresh observation.

The Today overview shows exact remaining affiliation and trade allowances,
alongside **total played time** from the requested account's public profile
`Stats.TimePlayedSec`. Playtime is cumulative, displayed as hours and minutes;
it is not reset at midnight or inferred from the current session. Profile
requests are shared while pending and refresh at most every 15 minutes after
success, with a one-minute retry after failure. Refresh checks immediately.
Unavailable values remain blank, and an earlier result is labelled if a
refresh fails. No daily maximum or earned percentage is guessed.

Today's ancestor is shown prominently, with smaller lines for the next
**Tuvalkane** and **Zenith** encounters. A visit on the following UTC day reads
**Tomorrow**. These dates come from the account's unlocked-ancestor calendar;
locked or unavailable encounters are identified rather than guessed.

Avakot's Gots appears only in **Vendors**, which shows actual live stock with prices, purchase
limits and expiration times. His stock can change during the day, so those
timers are separate from the daily reset. Faction weapons show standing costs,
rank requirements, Officer craftwork and **calculated daily Tempers** from the
game's seeded selection. Temper labels use their actual catalogue names,
with their matching logos; item artwork appears beside vendor item names.
Search by item or Temper name; optionally include all
faction favors. No purchase or claim action is performed. See
[vendor data and verification](daily-vendors.md).

The public faction catalogue is cached for offline use. Avakot's shelf requires
a live game session; possible catalogue entries never stand in for actual stock.
Missing data remains unavailable. Game credentials stay in the main process.

Run `node --test test/dailyBrief.test.js test/dailyBriefRenderer.test.js
test/dailyVendors.test.js` for scheduler, rendering and vendor data checks.
`node scripts/check-inventory-widgets.js` exercises the real Electron windows
with an isolated synthetic account and no external requests.
