# Avakot Market module

Enable **Avakot Market** in the Widgets picker, then select the plain bag icon in the Overkot app bar. The icon stays lit while the Market window is open and clears when it closes. Selecting it again focuses the existing window. The launcher works in both free and docked layouts, without an extra floating widget or dock tile. The market window follows the existing overlay focus and game visibility settings.

The window builds the actual Svelte frontend from `avakot-market`'s
`new-redesign-preview` branch. Listings, item search, profiles, settings, themes,
and the sidebar follow that shared UI. Browse public listings and copy a trader's
whisper without signing in. Publishing or managing listings requires your Market account.

**Login**, **Sign up**, and the embedded account connection actions open
**Overkot Settings → Connections**. Connect your avakot.dev account there and
approve linked Market sign-in in your browser. The account portal also offers
account creation. Existing Overkot connections require **Reconnect for Market**
once, because their original permission covered presence only. If Market is not
linked yet, use **Manage account** to connect it, then **Retry Market connection**.
Market signs in automatically with that verified connection. It never guesses a
Market identity from your email or display name.

The desktop always adds **Sell from inventory** to the shared sidebar.
It opens the existing inventory picker and prefilled listing composer
inside the Market window. The signed-in Market Envoy must match the current
Soulframe character and inventory must be live before publishing; publishing
checks this again against the live profile. Guests can open the inventory view
and its sign-in action opens Overkot Connections.

The inventory page follows the Market's current colors, fonts, and controls.
It uses the main page scrollbar and the shell's announcement once. Its account
state follows live connection updates, including when an older refresh finishes
after sign-in or sign-out. The listing composer retains the full visible page
height even when a search leaves only one item, keeping its publishing controls
accessible.

While Market is enabled and you are signed in, Overkot keeps your market status **Online – In game**, including when the market window is closed or unfocused. Disabling Market, signing out, or exiting Overkot ends this automatic presence.

## Testing the portable

1. Open the locally built portable under `dist-beta/title-tracker/` and enable the Market widget. If Soulframe is closed, disable **Hide when game closed** in Settings to test browsing.
2. Browse and filter listings, search the item catalogue, open an item or Envoy profile, and copy a whisper without signing in. Check that Login and Sign up open Connections and that Sell from inventory is visible.
3. With Soulframe connected, open **Sell from inventory**. Search, filter categories, sort by quantity, and switch between grid and list views. Turn on **Group by item** to collect copies of each item inside a collapsible group; grouping starts off. Expand temper icons to show their names, and use the craftwork text colours to identify weapon tiers.
4. Choose **List item**, enter a price or leave it blank for offers, set the quantity, then choose **Publish listing**. Item identity and supported weapon, mote, and rune attributes are filled from inventory.
5. Use your Market profile to manage listings with the shared market UI. Sign out from Connections or disconnect Soulframe and check that inventory publishing becomes unavailable while the sidebar link remains visible. Publishing creates a real market listing.

This client uses keyless desktop grant exchange and a short-lived Market session.
The account issuer, Market API and guest gateway each need the matching server
support. Deploy those services through their respective release workflows.

## Inventory behavior

Only approved catalogue items are matched. Matching uses exact source paths and unambiguous legacy identities; displayed names are never used to guess IDs. Inventory history and unfinished crafts do not count as owned stock. Equipped, installed, locked, already-listed, and unsupported copies are excluded from available quantities. Variants with incomplete attributes remain visible with an explanation and cannot be quick-listed.

Category labels and temper names use the market's category labels and language data. Weapon craftwork text follows the official [craftwork tier colours](https://wiki.avakot.org/Weapons#Craftwork), with stronger saturation for readability against the overlay's dark background.

Publishing reads inventory again and checks the game session, the public character profile, and current market commitments. The game account ID, session nonce, and raw inventory never go to the market API or the renderer. Price edits retain existing barter items and their attributes. Resuming an offer or increasing its quantity checks available inventory again. Expired listings must be recreated because the market's resume operation does not extend their expiry.

Listings are not automatically published, repriced, closed, or completed when inventory changes. Trading still takes place in Soulframe. Browse and account data refresh on opening the window; game inventory updates arrive through the existing poller. After a network failure during publishing, check your profile's listings before retrying because the server may have saved the request.

## Authentication and development

The central account credential remains encrypted with OS-protected `safeStorage`.
After explicit Market permission, the main process requests a 60-second, single-use
grant from `auth.avakot.dev/v1/overlay/market-authorization`. It sends only that
grant to Market's `auth/desktop/avakot`; Market verifies and consumes it with the
account service using its pinned service signing key, then issues its ordinary
session. Both servers recheck connection ownership and account restrictions.
No central bearer credential is sent to Market, and neither credential nor grant
reaches a renderer.

The Market token stays in memory; independent saved Market sessions are not
restored. Restarting Overkot derives a fresh session from the saved central
connection. Signing out or switching the central account immediately clears the
Market session and attempts revocation. Delayed responses cannot restore the
previous identity. Outages retry automatically; a missing verified Market link
requires the account portal and an explicit retry. Both matching server changes
must be deployed for this connection flow to work.

The main process redeems the central account grant without a shared integration key.
Market issues a server-marked desktop session lasting fifteen minutes; Overkot
refreshes it through the central connection before expiry. Authenticated reads and
writes use this bearer session directly. Guest browsing uses the Market website's
narrow, read-only gateway; the website's service credential stays on its server.
The renderer receives neither credential. App IPC accepts requests only from the
isolated local Market window's main frame at `overkot-market://app`. External HTTPS
navigation opens the system browser. Game artwork passes through the protected
main-process image protocol described in [game data access](data-updates.md).

### Optional Market frontend

`OVERKOT_MARKET_UI=auto` is the default. A standalone source build includes a small Market website
launcher. Set `marketWebsite` in the service profile to enable its browser button. `disabled` always uses that launcher. `enabled` requires the private
frontend checkout and fails clearly if it is unavailable. Explicit source paths
and commit pins also fail on errors instead of silently changing the UI. Official
CI uses `enabled` with its existing read-only source checkout and pinned commit.
No community build needs access to the private frontend repository.

Packaged builds and source runs against production ignore `OVERKOT_MARKET_API_KEY`.
They use the public gateway for guest reads and the account grant for sign-in.
Users of older builds that depended on the retired integration key need to upgrade.

For local development, set `OVERKOT_MARKET_API_URL=http://127.0.0.1:3000/v1`
before starting Overkot from source, adjusting the port for your test server.
If that server requires a test key, set `OVERKOT_MARKET_API_KEY` in the process
environment or the ignored `.env.local` file. Use a local database and test
account for development writes.

### Shared frontend updates and local review

When the optional private checkout is present, `npm start`, `npm run dev`, and
packaged builds fetch `origin/new-redesign-preview` and build its committed frontend. The default
source is the sibling `../../avakot-market` repository; the script leaves its
checked-out branch and uncommitted files untouched. If it is absent, `auto`
uses the built-in community website launcher without fetching private source.
Set `OVERKOT_MARKET_REPOSITORY` to use another authorized checkout. An explicit
checkout, commit pin or `enabled` mode fails if that source cannot be used.

The adapters under `scripts/market-ui/` add the desktop titlebar, Connections navigation,
JSON transport, and inventory route. Upstream components and styles are built
from the fetched branch. Structural changes that invalidate an adapter anchor
fail the build explicitly. Build-time dependencies are reused only when their
lock matches; otherwise they are installed in an ignored build directory.

`.build/market-ui/market-source.json` records the branch, exact source commit,
and dependency lock hash. Packaged apps include the same metadata. Updates
arrive with each app build; installed apps do not download or execute remote UI
code at runtime.

Build a normal Windows portable for local review:

```powershell
npm run build:portable:fast
```

This writes the portable to `dist/`. It does not tag, push, publish, upload, or
deploy either application. Optional isolated beta builds remain available through
`npm run build:beta:portable`.

Validation:

```powershell
node --test test/*.test.js
node scripts/check-market-redesign.js
node scripts/check-market-app.js
npm run build:portable:fast
node scripts/check-wiki-portable.js dist/overkot-portable-0.0.13-fast.exe --market
```

The redesign UI check uses fixture data, an isolated Electron profile, and blocks
external network requests. It verifies guest browsing, the inventory sidebar,
the composer, and sign-out without creating live listings. Screenshots and its
result summary are written under `output/`. `check-market.js` continues to cover
the inventory composer's standalone legacy harness.
The portable check launches the actual delivered executable with an isolated
profile and checks both account buttons, Settings reuse, the inventory iframe,
its sign-in action, and the Market close button.
