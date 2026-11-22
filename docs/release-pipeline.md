# Windows and Linux release pipeline

## Repository and release controls

Development and official releases use [CameronGuthrie/overkot](https://github.com/CameronGuthrie/overkot). The former private repository is historical. Its Actions are disabled, and the release role trusts the new repository's immutable ID.

Only the repository owner can create or update branches and tags. Every workflow entry requires the owner's original and rerun identities on a protected ref. Outside pull requests do not start release workflows. External actions use full commit SHAs from the repository's selected action allowlist.

The owner approves jobs before either protected environment releases its credentials. `official-market-source` holds the read-only private Market checkout key. `production-release` holds the VirusTotal key and the existing AWS role and release distribution identifiers. Both environments permit `main` and `v*` tags.

The release role can read and write only `overkot-releases/releases/*` and invalidate the existing release CDN distribution. Its trust requires this repository, the owner, the `production-release` environment, an allowed release workflow and a permitted ref. GitHub publishes release assets with the job's scoped token.

## First release from the new repository

Version `0.0.20` is prepared in the package, lockfile and changelog. The local `App` checkout has the new repository as `origin`. Its source, native features and official service profile are the complete app.

1. Push the reviewed initial commit to `origin/main` when ready. Publishing source alone does not run the release workflow.
2. When authorizing a build, create `v0.0.20` at the reviewed commit and push that tag. The tag starts **Build & Release App**. Approve the private Market source and production scan environments as they become ready. Manual staging on `main` with version `v0.0.20` and `publish=false` is also supported.
3. Review the successful run and its complete `overkot-release-<commit>` artifact. It contains the four checked packages, their hashes, completed VirusTotal results and release metadata. Record that successful run's numeric ID. If staging preceded the tag, create the tag at the exact staged commit before promotion.
4. When authorizing publication, run **Promote retained release** from `main` with `version=v0.0.20` and that `source_run_id`. Approve the production environment. Promotion validates the source run and tag, then publishes the same retained bytes to the existing CDN and the new GitHub repository.

The CDN publisher uploads versioned files before updating `latest.json`, `latest.yml`, `changelog.json` and the stable Windows alias. The existing website reads those feeds and shows the promoted version automatically. Installed official Windows clients read the same update feed.

Release runs and artifacts from the historical repository cannot be selected as the new repository's source run. Historical tags and their original commit graph belong to the historical repository. Push the new root commit and the new release tag explicitly.

## Linux-only updates

For a Linux-only release such as v0.0.16, add `"platforms": ["linux"]` to
that version's entry in `changelog.json` and bump `package.json` and its lockfile
to the same version. The versioned notes select the scope for every trigger,
including tag pushes, staging, promotion and recovery. Omit `platforms` for a
normal Windows and Linux release.

Run **Build & Release App** on the release commit with `version=v0.0.16` and
`publish=false`. This skips Windows entirely and builds, checks and scans the
Debian, Arch and AppImage packages. Review the retained
`overkot-release-linux-<commit>` artifact. Once the tag exists at that commit,
promote using the same workflow with `publish=true` and the successful staging
`source_run_id`, or run **Promote retained release** on `main` with that tag and
source run ID. Promotion reuses the reviewed bytes.

Linux-only manifests retain schema 2, add `"scope": "linux"`, and require all
three Linux platform records with completed scan results. Promotion uploads
the versioned packages and manifest, then updates `changelog.json` and
`latest-linux.json`. It leaves `latest.json`, `latest.yml`, `overkot.exe`, and
the Windows packages untouched. The Linux GitHub release does not replace the
latest full release. A later full release uses a new version and the ordinary
pipeline.

The website reads the optional `latest-linux.json` feed separately and updates
only the Linux download cards when it is at least as recent as the full
release's Linux packages. Deploy the corresponding website feed support before
promoting the first Linux-only release. Windows downloads and updater behavior
continue to use their existing metadata. For **Publish retained GitHub
release** recovery, select `scope=linux` for a Linux-only source artifact.

Linux build runners install .NET SDK 8, Clang, zlib and OpenSSL development
libraries, and CMake to compile the position reader into a native ELF executable
with statically linked OpenSSL. Installed packages and AppImages do not require
a .NET runtime or a particular host OpenSSL major version. Rebuild releases
against updated build-system libraries when servicing the bundled OpenSSL code.

## Full releases

**Build & Release App** prepares four packages for v0.0.15: the Windows NSIS
installer, experimental Debian/Mint amd64 DEB, experimental Arch x64
`pkg.tar.xz`, and portable Linux x64 AppImage. Pushing a version tag or running
the workflow manually with `publish=false` builds, checks and scans the packages,
then retains them for review. Staging does not change the live downloads,
Windows updater feed or GitHub release.

For a first rehearsal before tagging, dispatch on `main` with
`version=v0.0.15` and `publish=false`. Once that run succeeds, create the tag
at its exact commit. The tag workflow can discover and reuse a successful
same-commit staging artifact, avoiding duplicate builds and scans.

Package version, requested version and changelog must agree. Manual staging can
precede creation of the tag; an existing tag must point to the checked-out
commit. To promote a reviewed release, run the same workflow manually on its
version tag, set `publish=true`, and provide the successful staging run's
`source_run_id`. The source must be a completed successful **Build & Release
App** run in this repository at that exact commit, with its complete release
artifact still available. Promotion reuses those retained bytes and scan results.

Local `npm run build:win`, `npm run build:deb -- --x64`,
`npm run build:arch -- --x64` and `npm run build:linux:portable -- --x64` build
packages without publishing. The separate Linux Mint/Debian test workflow also
retains test packages without publication.

## Configuration

The workflow uses these Actions secrets:

| Secret | Use |
| --- | --- |
| `VIRUSTOTAL_API_KEY` | Scan the exact Windows, DEB, Arch and AppImage packages. |
| `MARKET_SOURCE_READ_KEY` | Read-only SSH deploy key for fetching the private Market frontend source. |
| `AWS_DEPLOY_ROLE_ARN` | OIDC role for release bucket writes. |
| `CLOUDFRONT_DISTRIBUTION_ID_RELEASES` | Release CDN invalidation. |

The VirusTotal key is configured externally in repository Actions secrets.
A missing required secret stops preflight before building.
Keep keys out of the repository, artifacts, website, command-line arguments and
packaged app. The VirusTotal key is passed only to preflight and scanning.
GitHub uploads use the workflow's `GITHUB_TOKEN`.

`MARKET_SOURCE_READ_KEY` is a read-only deploy key for the private Market
repository. The validation and package jobs select the `official-market-source`
environment, which admits `main` and version tags. To migrate the existing
repository secret, first land the environment-aware workflow, then provision a
read-only replacement in the environment and retire the repository-level key
and secret. Earlier workflow revisions need the environment-aware checkout for
a fresh build after that cutover. Each staging run resolves one
`new-redesign-preview` revision and
retains its commit pin; all four packages and retries reuse that same
revision.

The app repository's `AWS_DEPLOY_ROLE_ARN` selects `overkot-app-release`.
The release operator can use this role from either release workflow on protected
`main` or a protected `v*` tag. It can read and write `overkot-releases/releases/*`
and invalidate the release distribution. The website repository uses its own
`AWS_DEPLOY_ROLE_ARN`, which selects `overkot-website-deploy` for the
`Deploy Website` workflow on protected `main`.

Merge changes to either production branch by pull request as a repository
admin. Repository admins manage version tags. Terraform pins the app and
website repository IDs and the release operator's GitHub user ID.

VirusTotal requests are serialized with at least 16 seconds between requests.
The free account's quota is shared with the CLI and other clients; avoid using
the same key concurrently. The scanner has a 450-request allowance per process,
which does not account for other account usage. Numeric and HTTP-date
`Retry-After` instructions are respected. A delay beyond the remaining scan
budget stops the scan so it can resume later. Account usage must comply with
the [VirusTotal API terms](https://docs.virustotal.com/reference/public-vs-premium-api).

## Staging checks and artifacts

The workflow serializes release runs and performs these steps:

1. `validate` checks version, release notes and configuration, then inventories
   retained artifacts for the selected source run.
2. `windows` runs the test suite, builds the installer and checks the packaged
   dock, widgets and preload in the native runtime. It retains the installer,
   blockmap, checksum and `latest.yml` in `overkot-windows-<commit>`.
3. `linux` runs the test suite and builds the DEB, Arch package and AppImage
   inside `node:22-bookworm` (Debian 12). This keeps the native scanner's libc
   baseline compatible with Debian 12. All three packages and checksums are
   retained in `overkot-linux-<commit>`.
4. `linux_qa` installs the retained native packages in separate Debian 12 and
   Arch containers. It checks scanner capabilities, scanner compatibility,
   packaged renderers as an ordinary user, reinstallation, the extracted
   AppImage runtime, and removal. QA outputs are retained separately. These
   container checks still need desktop testing for overlay behavior in supported
   X11 sessions.
5. `prepare_release` verifies checksums and scans the exact retained packages.
   Files over 32 MiB use the large-file upload URL; failed uploads obtain a fresh
   single-use URL. Every package must have completed analysis results before
   `release-<version>.json` is written.
6. The complete manifest, all four packages, checksums, Windows blockmap and
   updater metadata are retained in `overkot-release-<commit>`. This artifact is
   the input to promotion; no rebuilding or rescanning occurs during promotion.

Scan progress is saved after each accepted submission and successful poll in
`dist/scan-progress-<version>.json`. Entries bind the filename, size, SHA-256 and
analysis ID to the exact file. Completed entries also retain engine counts and
the analysis date. The workflow uploads `overkot-scan-progress-<commit>` even
when scanning fails. A rerun downloads this checkpoint and resumes the same
analyses instead of submitting completed or pending files again.

The scan budget defaults to 55 minutes. Local scanning accepts
`VIRUSTOTAL_SCAN_BUDGET_MINUTES` from 1 to 60 and an optional
`VIRUSTOTAL_SCAN_PROGRESS_FILE` path. Pending analysis, invalid results, request
failure or budget expiry stops preparation without writing a pending release
manifest. A retained analysis ID that has expired can recover a completed
report for the same verified SHA-256.

## Promotion order

After reviewing the staged packages and results, dispatch **Build & Release
App** on the release tag with `version=v0.0.15`, `publish=true`, and the staging
`source_run_id`.

1. Verify the successful source run and its exact commit, then download the
   complete retained release.
2. Validate all four packages, checksums, updater metadata and schema 2 scan
   results. Any malicious or suspicious engine count above zero blocks CDN and
   GitHub publication before writes; review the retained results first.
3. Upload immutable versioned packages, verification files and the manifest to
   S3. Conditional writes reuse identical bytes and refuse different bytes at an
   existing versioned URL. All immutable uploads precede public pointer updates.
4. Update `overkot.exe`, changelog and Windows `latest.yml`, then copy the exact
   versioned manifest to `latest.json` last. Invalidate those mutable CDN paths.
5. Publish the same retained packages, checksums and manifest as a GitHub release,
   verifying attachment sizes and SHA-256 digests.

The workflow does not reset the existing kill switch. Separate S3 pointer writes
are not an atomic transaction: a pointer or invalidation failure is reported as
a failed job. Immutable files exist first, and the website updates version,
downloads and scan information together from a validated `latest.json` response.

## Download and scan metadata

The website consumes `https://releases.overkot.com/releases/latest.json` for all
four download formats, checksums and VirusTotal results. Once the matching
website changes are deployed, later releases update these links through metadata
without another website deployment. New manifests use `schemaVersion: 2`.

Each `platforms` record contains `filename`, versioned `url`, `size`, `sha256`,
`checksumUrl` and this VirusTotal object. Counts below illustrate the shape;
the scanner always records the actual returned counts.

```json
{
  "url": "https://www.virustotal.com/gui/file/<sha256>",
  "status": "completed",
  "analysisId": "<VirusTotal analysis identifier>",
  "submittedAt": "<UTC ISO timestamp>",
  "analysedAt": "<UTC ISO timestamp from the analysis or completed file report>",
  "stats": {
    "harmless": 0,
    "malicious": 0,
    "suspicious": 0,
    "undetected": 60,
    "timeout": 0,
    "confirmed-timeout": 0,
    "failure": 0,
    "type-unsupported": 0
  }
}
```

The manifest also has `version` without `v`, and `publishedAt` as a UTC ISO
timestamp. Full-release schema 2 requires all four records; Linux-only schema 2
requires the three Linux records and `"scope": "linux"`:

| Platform key | Filename |
| --- | --- |
| `windows` | `overkot-setup-<version>.exe` |
| `linuxDeb` | `overkot-<version>-linux-amd64.deb` |
| `linuxArch` | `overkot-<version>-linux-x64.pkg.tar.xz` |
| `linuxAppImage` | `overkot-<version>-linux-x86_64.AppImage` |

All eight engine counts must be nonnegative integers, with at least one recorded
result. Counts and dates are snapshots; hash-specific VirusTotal links show the
latest vendor results. Submission or completion alone is not a safety verdict,
and zero detections do not establish that a file is safe.

The website validates filenames, checksum URLs and report hashes against the
release version. `latest.yml` remains the Windows updater feed; Linux requires
manual updates. DEBs use `sudo apt install ./<filename>` and Arch packages use
`sudo pacman -U ./<filename>`. These downloads are standalone packages, not APT
or pacman repositories. AppImages run after making the file executable.

See the [large-file upload API](https://docs.virustotal.com/reference/files-upload-url)
and [analysis object reference](https://docs.virustotal.com/reference/analyses-object).

## Recovery and offline validation

If preparation fails, rerun the original workflow run. Completed platform
artifacts are reused; saved scan progress resumes unfinished analyses. Once the
complete release artifact exists, preparation reuses its original manifest,
timestamps and IDs. Artifact retention must not have expired.

If CDN promotion fails, rerun that promotion with the same source run. Immutable
uploads and pointer writes reuse the original bytes. If GitHub publication fails
after the CDN succeeds, run **Publish retained GitHub release** with the tag and
the original staging run ID. Verification checks the repository name, immutable
repository ID and tag commit. The source must come from the same repository,
through a push or manual dispatch of the build workflow. Both the original run
and any rerun must identify the release owner. Recovery checks retained files
against CDN checksums and reuses matching GitHub attachments.

GitHub release verification compares the live tag with the source commit before
checking local files and again before creating a draft or making it public.
Annotated tags are resolved to the commit they reference. The final comparison
and GitHub's release update are separate API requests, so tag protection still
matters. [GitHub reference API](https://docs.github.com/en/rest/git/refs#get-a-reference)

If a tagged workflow needs a publication fix, keep its tag at the reviewed
commit. **Promote retained release** runs the current workflow from `main`,
checks out the original release tag, verifies the successful staging run
against that checkout, and publishes its retained files to the CDN and GitHub
in one sequential job. This also recovers a promotion where skipped build/QA
ancestors caused the publication jobs to be skipped. It never builds or scans.
Retained staging runs belong to the repository that built them. For example,
the original v0.0.13 staging run belongs to the historical desktop repository.
Recreating its tag in another repository does not transfer its run or artifacts.
The recovery job reads the repository name and immutable ID from the workflow
context and requires an explicit source run.

The workflow commit can differ from the release commit; source verification
uses the checked-out tag's commit, and package checksums and scan metadata
remain bound to the original retained bytes. The AWS OIDC role must allow the
`main` workflow ref used by this recovery path.

Historical schema 1 releases remain recoverable with their original package
sets, including Windows-only and Windows/DEB releases without newer Linux
formats. Every present package must still match its retained checksum and scan
record. Fresh full-release staging and promotion require all four packages and
schema 2; Linux-only releases require all three Linux formats and schema 2.
Historical recovery does not relax those fresh-release requirements.

Run the offline release checks without API keys or uploads:

```bash
node --test test/publishRelease.test.js test/releasePipeline.test.js test/scanRelease.test.js test/releaseWorkflow.test.js
```

The mocked tests cover hash binding, package completeness, completed engine
results, detection publication gates, resumable scanning, API pacing and retry
instructions, secret redaction, immutable uploads, pointer ordering and
historical recovery.
