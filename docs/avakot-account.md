# avakot.dev account connection

Open **Settings → Connections → Sign in with avakot.dev**. Overkot opens
`account.avakot.dev` in the default browser. Sign in there and approve the
Overkot request. The overlay receives a credential limited to this connection;
passwords never pass through Overkot. Approve Market access through this central
connection to use the linked Market account for trading. Existing presence-only
connections need **Reconnect for Market** once. Market's account menu opens the
same Connections settings; signing out there also clears the derived Market session.

The same native connection authorizes protected game-data downloads. The main
process derives a five-minute, read-only data token, refreshes it before expiry,
and clears it on sign-out or an account change. The token stays out of the renderer.
Verified saved maps and display data remain usable offline; a first launch without
an account waits for a connection. Local game inventory and timers still work.

The connection shares the Soulframe account ID and its resolved public profile
name, plus whether that game session is online. The account portal labels this
as an **Overkot observation**, independently of any name imported from Market.
It is an additional verification source, not a server-issued proof of Soulframe
account ownership. No game nonce, inventory, or password is sent to Avakot.

Online requires the current running inventory poller, successful live inventory
within 90 seconds, and a public profile name matching that exact account ID.
Cached inventory, the login screen, a running process alone, and signing in to
Avakot do not indicate an online game session. Avakot and Daily Brief share
one background profile lookup every 15 minutes per connected account. Missing
names retry after a minute, subject to the shared profile cooldown.
The public profile lookup also requires the current game log to confirm the
same account ID. A logout, login in progress, or login without an ID suspends
those lookups until Overkot can confirm the account again.

While online, Overkot renews status every 45 seconds. Logout, expired game
credentials, or game exit immediately queue an offline report. App shutdown
also attempts an offline report, with a three-second exit budget. If the app
crashes or cannot reach Avakot, the server's 120-second lease expires to offline.
Unchanged offline status does not generate recurring presence writes.
Remembered connections are revalidated every five minutes; Settings offers
Retry connection and Sign out if restoring a saved sign-in encounters an outage.

Credentials are stored separately from settings in `avakot-account-session.bin`
under the app data directory, protected by Electron `safeStorage`. If encrypted
OS storage is unavailable (including a plaintext Linux backend), the sign-in
lasts only for the current app session. Tokens and authorization secrets never
appear in renderer state, logs, or browser URLs.

Sign out in Settings to remove the local credential and revoke it remotely.
If the network is unavailable, local sign-out still succeeds and the online
lease expires; the account portal can revoke the remaining remote connection.
Approving a new Overkot connection replaces the previous one. Credentials expire
after 30 days, and changing the account password or revoking the connection
invalidates them.

## Local verification

The backend and account portal changes in `avakot-account` are deployed.
Release checks on September 21, 2026 confirmed the portal responds and the
production overlay API requires its connection credential. Protocol, lifecycle,
IPC and Settings tests use synthetic accounts; they do not approve a real login.
The app build does not deploy either service or register an OIDC client.

For local development, start the account project's Auth/Firestore emulators,
API, and Vite portal. Before `npm start` in this directory, set:

```powershell
$env:OVERKOT_ACCOUNT_API_URL = 'http://127.0.0.1:3000'
$env:OVERKOT_ACCOUNT_PORTAL_URL = 'http://127.0.0.1:5173'
```

Only the production origins and loopback HTTP origins are accepted; packaged
builds always use production. Run the protocol, lifecycle, IPC and Settings tests:

```powershell
node --test test/avakotAccount.test.js test/avakotAccountIpc.test.js test/avakotAccountSettings.test.js
```
