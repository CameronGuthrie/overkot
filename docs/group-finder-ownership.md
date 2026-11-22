# Group Finder ownership

Group Finder uses Firebase Anonymous Authentication. The signed-in Firebase UID owns a profile, presence record, listings and outgoing join requests. Only the listing host can respond to requests. Invite names are player-reported. Two players can use the same display name and their records still have separate owners.

The desktop selects a local sign-in for each game profile. It stores the Firebase session with operating-system encryption. With no usable system keyring, the session lasts until the app exits. Clearing app data, changing devices or losing the keyring creates a new Group Finder identity. Another installation cannot use a public game ID or alias to recover the old records.

## Run your own project

Enable Anonymous Authentication, Realtime Database and Firestore in your Firebase project. Set `groupFirebase` in the JSON file passed to the build through `OVERKOT_SERVICES_FILE`. Use the **web app configuration** from Firebase Project Settings, including `apiKey`, `appId`, `projectId` and `databaseURL`. Administrative credentials belong in the operator’s deployment environment. Community builds leave Group Finder disconnected until configured.

The desktop uses these paths in version 2.

| Store | Path | Access |
| --- | --- | --- |
| Realtime Database | `groupFinder/v2/presence/{uid}` | The owner writes presence. Signed-in peers can read the individual online flag. |
| Firestore | `groupFinder/v2/players/{uid}` | The owner reads and writes their profile and preferences. |
| Firestore | `groupFinder/v2/listings/{id}` | Signed-in users browse up to 50 listings per query. The host creates and edits a listing. |
| Firestore | `groupFinder/v2/listingRequests/{listingId}_{uid}` | The requester and listing host read the request. The requester can cancel it and the host can respond. |

The rules limit new listings to one per minute per UID and join requests to one per 30 seconds per UID. A build that knows a Firebase web configuration can create an anonymous identity. A separate public build or a person with several identities can still generate billable traffic. Monitor authentication volume, active listeners, reads and RTDB bandwidth on the project.

## Verify locally

Install project dependencies, the Firebase CLI and a JDK supported by the CLI. These commands run only synthetic users against the loopback emulators in the `demo-overkot-rules` project. Start them from the repository root.

```sh
node --test test/groupFinderAuthStore.test.js test/groupFinderCapacity.test.js
firebase emulators:exec --project demo-overkot-rules --config firebase/firebase.json --only "auth,database,firestore" "node firebase/check-security-rules.cjs && node --test test/groupFinderAuthStore.test.js"
```

The second command exercises persisted sign-in after a restart, profile switching, presence registration, host and guest lifecycle, bounded queries and rejection of cross-owner and legacy writes.

## Upgrade an existing deployment

1. Build a release candidate with the intended service configuration. On a dedicated staging project, deploy the index configuration and the two rulesets. Wait for all indexes to report ready. Check that one installed client can host and another can request a place. Restart the host and check that it regains its listing.
2. Make the compatible desktop release available for download and tell existing users to upgrade and recreate their listings. Historical records are keyed by an unverified game ID. The app starts fresh and leaves those records unclaimed.
3. When ready to require the upgrade, deploy the final rules to both databases in the intended project. Run the index command first if existing indexes need updating. Replace `YOUR_PROJECT_ID` explicitly.

   ```sh
   firebase deploy --project YOUR_PROJECT_ID --config firebase/firebase.json --only "firestore:indexes"
   firebase deploy --project YOUR_PROJECT_ID --config firebase/firebase.json --only "database,firestore:rules"
   ```

4. Check the active Realtime Database and Firestore rules in the Firebase console against this checkout. Each database activates independently. Use two consenting test installations to check listing, joining, responding and reconnecting. Both final rulesets deny client access to the old top-level collections and presence paths. Earlier desktop releases require an upgrade to use Group Finder.

If part of the cutover fails, retry the missing rules deployment and read it back. Keep the owner-only policies in force while resolving client or index errors.
