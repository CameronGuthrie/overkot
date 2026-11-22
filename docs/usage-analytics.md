# Usage analytics

Official stable Overkot packages send a small allowlist of usage events through the
`collectUsage` callable function in `soulframe-overlay` (London) to GA4 property
`553887388`, web stream `G-K06RMTHN3P`. Development runs do not collect or send
usage. Community packages omit the collector unless their build profile supplies `usageFirebase`.
There is no in-app opt-in/out setting.

| Event | When | Additional parameter |
| --- | --- | --- |
| `app_launch` | App starts | — |
| `app_running` | Every five minutes while running | — |
| `app_exit` | App quits; delivered on next launch | — |
| `feature_open` | Explicitly opening a feature | `feature` |
| `feature_use` | Locate-player request, successful build export, listing creation or join request | `action` |
| `widget_enabled` | Enabling a widget | `widget` |

Events also contain the app version, operating system, session ID, event time,
and estimated focused-window engagement since the previous event. Running in the
tray does not count as engagement. Automatic visible widgets are not counted as
feature opens. A random installation ID persists locally and is independent of
the Soulframe account and Firebase authentication UID. Reinstalling with cleared
app data creates a new identity; installation counts are not unique-person counts.

No Envoy names, game account IDs, inventory, session nonces, screenshots, search
queries, chat or file paths enter this pipeline. Both client and relay restrict
event names and parameters; the server rejects unknown fields. Advertising use
and personalization are explicitly denied in the GA payload.

The encrypted local `usage-queue.json` under the Overkot app-data directory holds
at most 200 queued events plus one 25-event batch. Events expire after 48 hours.
Delivery normally happens at most once a minute, with exponential retry backoff
up to 30 minutes. Network failure never prevents startup, interaction or quit.
Receipts deduplicate acknowledged batches across retries and restarts. An ambiguous
failure after GA accepts a request but before its receipt is saved can still
produce a duplicate; this is best-effort telemetry, not an accounting ledger.

Firebase anonymous authentication is required. Firestore holds only hashed rate
limit keys and batch receipts, inaccessible to client reads or writes. Rate-limit
documents expire after 24 hours and receipts after 72 hours via TTL (deletion is
asynchronous). The relay also limits requests per installation, auth UID and
source IP per minute. Source IPs are not forwarded to GA or stored in these
documents; normal Google Cloud request logs are separate. Anonymous auth and
rate limits discourage abuse but cannot attest that a desktop client is genuine.

Each running `collectUsage` instance admits up to 60 authenticated, validated
batches per rolling minute, including retries for previously delivered batches.
Excess requests receive `resource-exhausted` before the handler opens a
Firestore transaction or sends events to GA. The stable desktop client backs
off and retries. The function is configured for two instances in
`europe-west2`, each with 20 concurrent requests, 256 MiB memory and a
30-second timeout. Cloud Monitoring recorded 43,956 requests in the 14 days
reviewed on 22 November 2026, with a peak of 10 requests in one minute across
the service.

The admission window covers database work in each warm instance. New instances
start with empty windows. Function invocation, authentication, and retries
inside an admitted Firestore transaction can still incur usage. Direct Firebase
requests from a modified desktop client are governed by each service's own
rules and quotas. Official-client attestation would require a trusted provider
and support in distributed clients. [Firebase App Check providers](https://firebase.google.com/docs/app-check/custom-provider)

The GA Measurement Protocol API secret lives in Secret Manager as `GA_API_SECRET`.
Firebase web app configuration in the client is public configuration, not that
secret. Group Finder continues using its existing `soulframe-overlay-group-finder`
project; analytics deployment does not migrate its data.

## Deploy

From the App directory:

```powershell
Push-Location firebase/analytics
npm ci
Pop-Location
firebase deploy --config firebase/analytics.firebase.json --project soulframe-overlay --only functions:usage,firestore --non-interactive
```

For a change confined to the relay, deploy `--only functions:usage:collectUsage`
with the same config and project. Check that the new revision is ready and
serves production traffic. The developer CLI can verify the `GA_API_SECRET`
binding from function metadata without retrieving its value.

Anonymous sign-in must be enabled in the analytics project. Configure/rotate the
secret with `firebase functions:secrets:set GA_API_SECRET --project soulframe-overlay`
and redeploy the relay. Never place its value in source, the app, or shell history.

View events in [Google Analytics](https://analytics.google.com/analytics/web/#/a381932278p553887388/reports/reportinghub).
Event-scoped custom dimensions for `feature`, `action`, `widget`,
`app_version` and `operating_system` are registered for report breakdowns.
GA reporting is asynchronous. Google's [Measurement Protocol documentation](https://developers.google.com/analytics/devguides/collection/protocol/ga4)
warns that protocol-only collection has partial reporting; event counts and
explicit parameters are the basis for these reports, rather than automatic
website acquisition, retention or session metrics. Validate payload changes with
the [debug endpoint](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events);
an HTTP 2xx from the collection endpoint alone does not prove a valid event.

## Envoy identity in the legacy desktop

Group Finder resolves `Results[].DisplayName` from Soulframe's public
`/cdn/getProfileViewingData.php?playerId=...`, requiring its `AccountId.$oid`
to match the current account. The inventory snapshot inspected during development
did not contain a display name. Only an account-matched EE.log login name is used
as a fallback. Missing identity keeps posting unavailable and retries after a
minute; successful profiles refresh every 15 minutes. Account changes discard
in-flight results and tear down old presence/listeners. Existing owned listings
and join requests receive refreshed names. No fabricated account-ID alias is
published, and profile requests do not send an inventory session nonce.

### Legacy Group Finder rules before the 22 November 2026 cutover

The Group Finder project uses Firebase anonymous sign-in. The former Realtime
Database rules exposed only the `online` field to authenticated clients, validated
presence writes and denied client access to the unused `heartbeats` tree.
Versions 0.0.9 and later read only that field. Earlier releases also attempted
to read a full presence record during cleanup of other players' listings.
The former Firestore rules restricted those listing updates to the creator,
blocked player enumeration, limited profile fields, pinned each session's account
ID after creation and restricted join-request responses to the listing host.
Requesters could change their display names and cancel their own requests.
Listing queries required a limit of 1–50 and a zero or omitted offset.
The legacy desktop browsed 50 listings and restored one. It supported bounded
cursor pagination and individual listing reads. Incoming and outgoing join
requests used filtered listeners without a result limit.

**Historical exposure.** Legacy clients supplied a Soulframe account ID from
the game. Firebase authenticated the installation's anonymous UID without a
trusted link to that game account. Knowing a game account ID let an
authenticated client read its profile and online flag or write profile and
presence fields. The deployed v2 rules close these legacy paths and bind
record ownership to the Firebase Auth UID.
Group Finder had Cloud Billing enabled on 22 November 2026. Authenticated
clients can repeat queries and keep listeners open, incurring database reads
and outbound traffic beyond the project's included allowances.

### Firebase key and quota audit

On 21 November 2026, the web keys shipped for Group Finder
(`soulframe-overlay-group-finder`) and analytics (`soulframe-overlay`)
matched their live Firebase web-app configurations. Both keys had an API
allowlist of 27 services and no application or HTTP referrer restriction. The
analytics project's active Firestore rules denied all client reads and writes.
Firebase web keys identify the project; authorization comes from the service's
rules or the backend. [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys)

Google Cloud Service Usage reported these effective authentication quotas on
both projects. No consumer or administrator override appeared on these limits.

| API and quota metric | Effective limit |
| --- | --- |
| Identity Toolkit `default` | 180,000 requests per minute per project, 30,000 per minute per project per user |
| Identity Toolkit `sign_in_with_custom_token` | 20,000 custom-token sign-ins per minute per project |
| Secure Token `requests` | 6,000 requests per minute per project |
| Secure Token `secure_token_requests` | 18,000 token requests per minute per project |

### Group Finder ownership cutover

The public desktop release candidate uses the Firebase Auth UID for all Group
Finder records. Game names are invite labels. The candidate uses new paths and
the final rules close all legacy paths. Both production databases activated
the owner-only rules on 22 November 2026 at 10:30 UTC. Their live policy
sources matched public commit `a7be97d`. Players need a v2-compatible upgrade
to use Group Finder. The configuration, emulator checks and operator steps are in the
[Group Finder ownership guide](group-finder-ownership.md).

A future verified game-name badge would require independent proof. One candidate
would ask a consenting player to give the active loadout a short-lived, randomly
generated challenge name. The server would bind the challenge to the authenticated
requester and game account, fetch the matching account's public profile directly,
check the active-loadout name, and atomically consume the challenge once. The
existing backend profile type models `LoadOutPreset.n`. The public view of a
renamed loadout and its refresh latency still need verification with a consenting
account. Until then, Group Finder makes no claim about control of a Soulframe
account. [Soulframe Preludes 10, loadout changes](https://forums.soulframe.com/topic/3837-soulframe-preludes-10/)
