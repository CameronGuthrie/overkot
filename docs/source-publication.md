# Source publication notes

A fresh checkout builds with the standalone Market launcher and optional services
disconnected. Official builds select the service profile in `config/` and the
private Market frontend. Developers can select their own endpoints or local
fixtures. [Build instructions](../README.md)

## Services and release history

1. The maintainer revoked the previously distributed Market key. The obsolete
   GitHub Actions secret and local environment assignment were removed.
   Published versions v0.0.17, v0.0.18 and v0.0.19 contain the keyless account
   flow. The v0.0.16 packages predate that migration. On 21 November 2026,
   production recorded 17 successful native Market grant exchanges between
   22:33 and 23:40 UTC following the observed key deletion. Those aggregate
   counts include possible renewals and do not identify client versions.
   The public game-data feeds were retired on 22 November 2026. Official clients
   can use the protected feed with their own account. [v0.0.17](https://github.com/CameronGuthrie/soulframe-overlay/releases/tag/v0.0.17),
   [v0.0.18](https://github.com/CameronGuthrie/soulframe-overlay/releases/tag/v0.0.18),
   [v0.0.19](https://github.com/CameronGuthrie/soulframe-overlay/releases/tag/v0.0.19)
2. Rotate credentials previously distributed in desktop packages or committed
   anywhere in history before exposing that history. Removing a value from the
   current source is insufficient: inspect the full Git history, tags, branches,
   releases, CI artifacts/logs, ASAR archives, installers and cached/generated
   bundles. An old distributed key must be treated as extractable. A fresh
   reviewed public repository can keep the earlier private history separate.
3. Audit the proposed public tree and its history for private datasets, source
   assets, third-party licences and configuration. Keep private Market source,
   raw pipeline extraction data, server credentials and account-signing keys
   outside it. Runtime website secrets belong in Secrets Manager, never public
   environment variables, container build arguments or browser chunks.
4. Build from a clean checkout without production secrets or the private Market
   source. Verify local game inventory/timers, the optional Market launcher,
   signed-out waiting states and verified offline data. Audit the resulting
   package as well as source. Exercise data-token expiry, logout/account changes,
   anonymous gateway restrictions and proxy path/size/signature checks.

The desktop authorizes the signed-in account. A modified client can use a grant
obtained by its user. Protected data tokens expire after five minutes. Website
service keys stay on their servers. Guest website routes expose the images and
public reads used by those sites. A visitor can save displayed content.

On 22 November 2026 the game API received an AWS concurrency limit of 150.
Its highest observed concurrency in the preceding 45 days was 92. All clients
share that capacity. The telemetry relay admits 60
validated batches per minute per warm instance, and Group Finder listing
queries return at most 50 documents per request. Sustained traffic can still
incur charges. The existing AWS budget covers the shared account and sends
alerts. [Firebase controls and remaining ownership work](usage-analytics.md)

## Asset redistribution review

| Material reviewed | Evidence and disposition |
| --- | --- |
| Original Overkot code | The package declares AGPL-3.0-only. See the [project licence](../LICENSE). Third-party components retain their own licences. |
| Lucide SVG subset | Keep the [combined ISC and Feather MIT notice](../assets/icons/lucide/LICENSE) with the icons. The [manifest](../assets/icons/lucide/manifest.json) identifies the pinned sources. |
| Noto Sans JP, KR, SC and TC Regular | All four tracked TTFs identify version 2.004-H2, Adobe copyright 2014–2021, the reserved name “Source” and SIL OFL 1.1 in their name tables. Include the [upstream OFL notice](../assets/fonts/OFL.txt) alongside the fonts. [Google Fonts upstream notice](https://github.com/google/fonts/blob/main/ofl/notosansjp/OFL.txt) |
| Map and game data | The desktop downloads map tiles, markers, map JSON and temper images from the configured game-data feed. Git ignores local copies in `assets/map-tiles/`, `assets/map-icons/`, `assets/map-json/` and `assets/tempers/`. The public tree contains the app catalogues in `src/data` and test fixtures. [Game-data delivery](data-updates.md) |
| Branding and artwork | The app tree contains the application logos, generated installer art, `assets/new-icons` and the Market sack. The sack geometry also appears in two generated renderer catalogues. |
| Translations and flags | The `langs` submodule pins the dictionaries and flag images maintained with the translations. [Localisation repository](https://github.com/CameronGuthrie/overkot-localisations) |

## Reviewing a source archive

Run these commands from the App checkout to inspect a committed revision. The
ZIP listing should contain `LICENSE`, `assets/fonts/OFL.txt` and
`assets/icons/lucide/LICENSE` when that revision includes the notices.

```sh
git archive --format=zip --output=../overkot-source-review.zip 'HEAD^{tree}'
tar -tf ../overkot-source-review.zip
```

Git includes the revision’s application code, app artwork, catalogues, test fixtures
and Firebase rules. The export rules exclude local build output, private Market
checkouts, debug logs, private environment files and Terraform configuration
values and state. The official service profile holds public endpoints and
Firebase client identifiers. [Export rules](../.gitattributes)

Git archives contain an empty `langs/` directory because translations live in a
separate repository. To build from a clone, initialize the submodule as described
in the README. For an extracted source ZIP, populate `langs/` from the revision
shown by `git ls-tree <app-revision> langs` in the App repository. The build uses
the language registry, dictionaries and flag images from that revision.
[Build instructions](../README.md) · [Localisation repository](https://github.com/CameronGuthrie/overkot-localisations)

These exclusions apply to archives of revisions containing the rules. A clone of
the private repository still includes the original assets and historical commit
metadata. Making this repository public would expose those files and commits
directly. Historical author or committer records contain a personal email
address. Use a separately reviewed snapshot and a verified GitHub noreply
address for the first public commit if the private history must stay private.
