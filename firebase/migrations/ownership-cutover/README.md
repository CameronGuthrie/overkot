# Group Finder production cutover

This private runbook covers the existing `soulframe-overlay-group-finder` project. New Firebase projects should use the strict rules in the public checkout from the start.

**Completed on 22 November 2026 at 10:30 UTC.** Production Firestore and Realtime Database both run the owner-only policies from public commit `a7be97d`. The Firestore release points to ruleset `f0c028bd-3eca-488b-9537-dc2c03cfb58b`. Its source and the active RTDB policy matched the reviewed files on readback. The cutover went directly to the final policies. The v2 client uses Firebase UIDs and treats display names as invite labels. Stable v0.0.19 now requires an upgrade for Group Finder.

The following procedure records the migration from the retired policies. For this production project, continue with the compatible desktop release and the two-installation check in step 4 under **Activate**. Keep the final policies in force.

## Prepare the release

1. Build the Windows preview with the v2 Group Finder module and the intended project’s public web configuration. The community installer leaves Group Finder disabled by default. Rehearse the candidate using synthetic accounts on an emulator or a dedicated staging project. Verify posting, joining, responding, switching profiles, a restart that restores the original host UID, and logout clearing the visible name. Verify the indexed queries against a staging project before launch.
2. Prepare the official Group Finder-enabled preview and its download location before opening the compatibility window. Record a UTC cutoff, allow time to verify both databases and prepare a notice telling users to upgrade and recreate listings. A normal overlap should last only as long as the release smoke test. The helper caps it at two hours.
3. From the shared workspace root, fetch the two active rule sources again. The helper reads rules through the signed-in Firebase CLI. It never reads player records. The generator compares both sources against fixed fingerprints and stops for review if either has changed.

   ```powershell
   $cliDirectory = Join-Path (npm root -g) 'firebase-tools'
   $cutover = 'App/firebase/migrations/ownership-cutover'
   $private = '.local/group-finder-cutover'
   node "$cutover/read-current.cjs" $cliDirectory "$private/baseline"
   $deadline = (Get-Date).ToUniversalTime().AddMinutes(45).ToString('yyyy-MM-ddTHH:mm:ssZ')
   node "$cutover/prepare.cjs" "$private/baseline" public-overkot/firebase "$private/overlap" $deadline
   node "$cutover/prepare.cjs" "$private/baseline" public-overkot/firebase "$private/expired" '2000-01-01T00:00:00Z'
   ```

4. Rehearse both generated policies. The overlap test checks v2 ownership and legitimate legacy clients. The expired test confirms all legacy writes are denied while v2 clients still work. The strict canonical config must pass that test independently.

   ```powershell
   Set-Location public-overkot
   firebase emulators:exec --project demo-overkot-rules --config ../.local/group-finder-cutover/overlap/firebase.json --only "database,firestore" "node firebase/check-security-rules.cjs --verify-temporary-overlap"
   firebase emulators:exec --project demo-overkot-rules --config ../.local/group-finder-cutover/expired/firebase.json --only "database,firestore" "node firebase/check-security-rules.cjs"
   firebase emulators:exec --project demo-overkot-rules --config firebase/firebase.json --only "auth,database,firestore" "node firebase/check-security-rules.cjs && node --test test/groupFinderAuthStore.test.js"
   ```

5. On Windows, test the actual candidate runtime, renderer and preload with two isolated desktop profiles. Pass the matching checkout and its unpacked application directory. This private harness runs the Group Finder service, identity observer, Firebase SDK and IPC handlers from that exact checkout. It loads the renderer and preload directly from the candidate’s `resources/app.asar`, injects only the emulator connections, and supplies synthetic login lines. It verifies Windows-encrypted sign-in restoration on a newly launched host process. The unmodified official installer’s connection to the real project is checked during activation.

   ```powershell
   firebase emulators:exec --project demo-overkot-rules --config firebase/firebase.json --only "auth,database,firestore" "node ../App/firebase/migrations/ownership-cutover/check-windows.cjs . dist/win-unpacked"
   ```

## Activate

Run these steps from `public-overkot` only when the compatible official preview is ready to distribute. Each Firebase rules deployment goes live independently. Record the issue time and UTC deadline before deployment.

1. On 22 November 2026, all four required composite indexes were already READY in production. The production TTL policy on `listings.expiresAt` was ACTIVE. The public index file omits that operator-managed policy. Deploy only security rules for this cutover. If using the compatibility window, deploy its two rulesets and verify the exact UTC deadline in both live readbacks.

   ```powershell
   $project = 'soulframe-overlay-group-finder'
   firebase deploy --project $project --config ../.local/group-finder-cutover/overlap/firebase.json --only "database,firestore:rules"
   node ../App/firebase/migrations/ownership-cutover/read-current.cjs $cliDirectory ../.local/group-finder-cutover/active-overlap
   ```

2. Verify the actual installed Group Finder-enabled preview with two controlled installations. One hosts and the other requests to join. The host accepts, both see the response, and a restart restores the original host’s listing. Make that preview downloadable and announce the required upgrade before closing legacy access. Every minute of overlap retains the legacy game-ID weakness. Only v2 records have the new ownership guarantee during this period.
3. As soon as that preview is available and checked, deploy the strict rules. The overlap’s server-clock deadline also denies legacy reads and writes if a deployment is delayed. Long-lived disconnected clients may show cached data until they reconnect. They cannot commit to the old paths after enforcement. Old clients with expired anonymous credentials receive the same denial after signing in again.

   ```powershell
   firebase deploy --project $project --config firebase/firebase.json --only "database,firestore:rules"
   node ../App/firebase/migrations/ownership-cutover/read-current.cjs $cliDirectory ../.local/group-finder-cutover/active-final
   ```

4. Compare the active Firestore source and normalized RTDB JSON to the canonical files. Verify both controlled installations again. The final configuration leaves every legacy Group Finder path inaccessible to clients. Existing group records and preferences stay unclaimed. Lost or locked OS storage can yield a fresh Firebase identity, so start a new listing when necessary. The final rules preserve ownership independently of restarts and app versions.

If one deployment fails, read back each database, retry the missing strict ruleset and fix forward. If the preview needs replacement after the deadline, keep legacy access closed while preparing it. Never deploy the legacy baseline or a fresh overlap as a rollback. The generator deliberately rejects a readback of the final rules.
