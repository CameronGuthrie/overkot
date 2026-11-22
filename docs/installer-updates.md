# Installer and app updates

The Windows installer uses a short per-user NSIS wizard: release notes, Install,
progress, Finish. It installs or updates the same application and keeps settings.
It does not need administrator privileges or copy executables into a second
AppData directory. The scanner runs directly from resources/bin/hostservice.exe
with an argument array, without a command shell or runtime compilation.

Installed Windows builds check once after startup. They never download or install
an app update automatically. Existing automatic-update preferences migrate to off,
and there is no switch to restore unattended installation. Closing or quitting
Overkot leaves a downloaded update ready for a later explicit install.

The update window shows the Overkot icon, current and new versions, release
notes, and real download progress including size and transfer speed. Choose
**Download update**, then **Restart and install**. The latter first shows an
indeterminate preparation state, then opens the branded native installation
progress page with the target version and app artwork. In-app updates skip setup
choices and release notes already reviewed in the app, then reopen Overkot when
installation finishes. Fresh installs retain the ordinary assisted wizard.

Settings → Updates also offers a manual check. Offline errors never block startup,
and missing notes show a fallback. Portable/development builds do not run the
installed-app updater. Beta builds share their stable release's notes when needed.
The controller keeps electron-updater's `autoDownload` and
`autoInstallOnAppQuit` false; only a deliberate install action hands off to NSIS.
Recheck this integration when upgrading electron-updater. See the
[electron-builder update documentation](https://www.electron.build/v26/docs/features/auto-update/).

Build with `npm run build:no-obfuscate`. The output is
`dist/overkot-setup-<version>.exe`, its blockmap, SHA-256 checksum and `latest.yml`.
CI uploads versioned binaries before publishing metadata, retaining `overkot.exe`
as the public download alias. Never replace a published version with different
bytes: increase the version and build once. Preserve HTTPS and updater checksum
verification. Publish a release only after reviewing its notes and artifacts.

The current development version is `0.0.12-beta.5`. It adds Linux interaction fixes
and automated Windows/DEB publication with matching VirusTotal report links.
It retains the account branding updates to
**avakot.dev account** and **Sign in with avakot.dev**. It includes account connections
and browser sign-in for Market, Calendar and Temper Tracker improvements, and
market-access and overlay fixes. It sorts after
`0.0.11` and before stable `0.0.12`; `0.0.11b` is not a valid semantic version,
and `0.0.11-b` sorts before the already published `0.0.11`. This maintenance
build deliberately uses the existing `latest` feed so installed `0.0.11` and beta apps
receive it and subsequently receive stable `0.0.12`.

The [release pipeline](release-pipeline.md) builds both Windows and Linux DEB,
scans their exact retained packages, and publishes website metadata automatically.
GitHub release publication is a separate job that consumes the retained build
artifact. It verifies both packages against the already published CDN checksums,
skips matching uploaded assets, retries transient uploads, and publishes the draft
only after every attachment's digest matches. Uploaded files with different
digests are never overwritten. If that job fails, rerun only the failed job.
For older failed runs, dispatch **Publish retained GitHub release** with the
existing version tag and original **Build & Release App** run ID. This recovery
workflow verifies the tag's commit and does not build or publish to S3 again.

## Antivirus reports

There is no obfuscation, UPX or executable packer in the build. JavaScript still
uses normal esbuild bundling/minification; NSIS uses its standard compression.
The helper reads the Soulframe process to discover the current account/session.
That behavior can trigger heuristic detection even in a legitimate overlay.
The reported packed-JavaScript and generic dropper labels do not establish which
component caused a detection or guarantee that a packaging change resolves it.

Record the exact release hash, engine, detection name and date. Scan the final
installer and extracted app/helper separately to identify the flagged component.
If the sample is incorrectly detected, submit those exact files to the affected
vendor for review with a description of the helper's read-only game integration.
Do not ask users to disable antivirus or add broad exclusions. Release workflows
submit both packages to VirusTotal automatically; false-positive appeals to
individual vendors remain separate from those scans.

[Microsoft's developer FAQ](https://learn.microsoft.com/en-us/defender-xdr/developer-faq)
explains how to dispute detections and says there is no developer false-positive
prevention program. An unsigned release can also receive a separate SmartScreen
reputation warning; each new unsigned file starts without the previous file's
reputation ([Microsoft guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).
A clean local scan does not certify other engines or future definitions.

The [0.0.10 scan review](installer-antivirus-review.md) records the exact sample,
verified upstream DLL matches, explained behavior alerts and unresolved findings.

Validation: `npm test`, build the full installer, then run
`node scripts/check-updates.js` and `node scripts/check-group-finder.js` for the
packaged UI. These checks use isolated fixtures and block network requests.
