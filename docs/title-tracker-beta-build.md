# Optional local Title Tracker beta

Title Tracker is included in normal builds for the upcoming 0.0.14 release.
This optional beta retains its separate app identity and output directory for
local testing. Its build command never publishes, and does not change the public
package version or website installer/update feeds.

```powershell
npm run build:beta:portable
```

The Windows portable and its SHA-256 checksum are written to
`dist-beta/title-tracker/overkot-title-tracker-beta-0.0.13-beta.title-tracker.1.exe`.
The beta has its own app ID and package name, while its runtime executable stays
`Overkot.exe` for the existing packaged UI checks. It shares the normal Overkot
settings folder, so tracker preferences persist between launches. Close another
running copy of Overkot before testing.

The build reads `current.json`, the matching build manifest and
`Artifacts/epithets.json` directly from the `soulframe-pipeline-data` S3 bucket
using the AWS CLI. It verifies the manifest's byte count and SHA-256 before
embedding the normalized title catalogue. AWS CLI read access is required; a
missing, corrupt or unavailable catalogue stops the beta build. The user's local
example JSON is not a build source. No S3 write or feed publication is performed.

The beta build command accepts Windows portable and unpacked targets only;
installer targets are rejected. It uses a separate `.build/beta/app` stage and
`dist-beta/title-tracker` output, sets `publish: never`, removes updater feed
configuration, and disables automatic app updates in the beta runtime.

Normal build commands embed the `stable` channel and use the checked-in,
verified title catalogue. They do not require AWS CLI access. The beta channel
controls the test package identity and update behavior; it no longer controls
whether Title Tracker is available. For ordinary source development:

```powershell
npm run dev
```

For an unpacked beta and isolated packaged checks:

```powershell
npm run build:beta:pack
$env:OVERKOT_PACKAGED_DIRECTORY = (Resolve-Path 'dist-beta/title-tracker/win-unpacked').Path
# Run the requested packaged UI check here.
Remove-Item Env:OVERKOT_PACKAGED_DIRECTORY
```

The packaged `src/build-channel.json` records the channel and local-only status
for inspection. The channel comes from the compiled build, rather than an
editable user preference or this metadata file. Title Tracker is available on
both channels. Remote game data continues to update independently of app
updates. See [Title Tracker](title-tracker.md) for catalogue refresh and validation.

```powershell
node --test test/buildChannel.test.js test/packaging.test.js
node scripts/build.js --win --portable --beta --inspect-config
```
