# Experimental Linux packages and paused macOS builds

Windows 10/11 remains the supported platform. The default
[release pipeline](release-pipeline.md) also builds and publishes the experimental
Debian/Ubuntu/Mint amd64 DEB, Arch x64 Pacman and portable x64 AppImage. Local `npm run build:deb`,
`npm run build:linux:portable` and the separate manual
[Debian test workflow](../.github/workflows/build-linux-deb.yml) build without publishing. See
[Linux overlay testing](linux-mint.md) for the current runtime behavior,
installation steps, and live-data limitations. The broader Linux/macOS build
matrix below remains disabled; macOS is still on hold.
Local Arch-based builds use `npm run build:arch` for a native Pacman package and
the shared `npm run build:linux:portable` for AppImage. See [Arch testing](linux-arch.md).
The Arch package is included in new releases and checked in an official Arch Linux CI container.

The Linux packages remain experimental until tested against real games and
target desktops. RPM and macOS retain build configuration for future testing.

| Platform | Package formats | Current scope |
| --- | --- | --- |
| Windows x64 | NSIS installer, portable EXE | Existing tested game integration and overlay. |
| Debian/Ubuntu/Mint x64 | DEB, portable AppImage | DEB and AppImage included in new releases, built on Debian 12; experimental X11 overlay and Wine/Proton game integration. |
| Arch-based x64 | Pacman, shared portable AppImage | Included in new releases; experimental desktop and Wine/Proton game integration. |
| Fedora/Red Hat-based x64 | Retained RPM configuration | On hold. |
| macOS Intel x64 | DMG, ZIP | On hold: companion tools; no native game process or live inventory integration. |
| macOS Apple Silicon arm64 | DMG, ZIP | On hold: same companion scope, configured for Apple Silicon. |

Companion tools include market browsing and listing management, wiki search,
maps, the event calendar, and world clocks. Selling from live inventory and
inventory-driven widgets require a working game connection. Linux already has
game process discovery, Wine/Proton log discovery, and a native game-only scanner
installed by the DEB or Pacman package with process-read capability. A `/proc` fallback supports
development. The AppImage bundles the same helper with ordinary user permissions,
so Linux restrictions can block a separately launched game's live inventory.
The AppImage does not install the native package helper's capability. These integrations
still need verification against a running game.
Custom Wine/Proton prefixes may require choosing `EE.log` and the screenshot
folder in Settings. Linux process permissions can prevent inventory reads.
Treat that as an unsupported game connection; do not run Overkot as root or
weaken system-wide process access controls.

Native Linux and macOS windows stay available without the game. Linux prefers
X11/XWayland when an X display is available, unless explicitly overridden. The Windows
foreground-game attachment behavior is unavailable on those platforms. Linux
window behavior also depends on the desktop: Wayland restricts programmatic
positioning and always-on-top windows, and global hotkeys depend on compositor
support. Start overlay testing with an X11 session; neither a successful build
nor launching a window proves that an overlay works over a game. See Electron's
[window limitations](https://www.electronjs.org/docs/latest/api/base-window#winsetalwaysontopflag-level-relativelevel)
and [global shortcut documentation](https://www.electronjs.org/docs/latest/api/global-shortcut).

## Linux package formats

- **AppImage** is the portable release format for Debian/Ubuntu/Mint x64 and is
  also used for local Arch-based testing. It
  runs as an ordinary user without installing Overkot through a package manager.
  Preferences and caches still use `$XDG_DATA_HOME/Overkot` (default
  `~/.local/share/Overkot`), and browser profiles use Electron's normal user
  configuration directory. Moving or deleting the executable leaves those
  data in place. See [Arch launch instructions](linux-arch.md#run-the-portable-appimage)
  for FUSE requirements and local test scope. Other Linux families need separate testing.
- **DEB** integrates with Debian/Ubuntu-based desktops through APT.
- **RPM** integrates with Fedora and compatible Red Hat-based desktops through DNF.
- **Pacman** integrates with Arch-based desktops as a local `.pkg.tar.xz` package.

These formats cover package managers, not every distro release or configuration.
Older distributions can lack libraries required by the bundled Electron runtime.
The initial build matrix targets x64 Linux; Linux ARM packages are not part of it.
The AppImage launcher preserves Electron's renderer sandbox. AppImage may
require FUSE 2 (`libfuse2` on Debian 12); the official
[AppImage troubleshooting guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
also describes `--appimage-extract-and-run` and manual extraction when FUSE is
unavailable. Restore the executable bit with `chmod +x overkot-*.AppImage` before
launching. If a desktop blocks the AppImage sandbox, use the DEB or Pacman
package. See the
[portable launch instructions](linux-mint.md#run-the-portable-appimage) for
checksums, permissions and the live-inventory limitation.

## Build locally

These development commands do not represent a supported Linux or macOS release.
For Debian/Mint testing, use `npm run build:deb` for the installer or
`npm run build:linux:portable` for AppImage instead of building all formats.
For local Arch testing, use `npm run build:arch` for the native package; the same
AppImage command provides the portable option. See [Arch build prerequisites](linux-arch.md#build-locally).

Run these commands from the application repository, where `package.json` lives.
Use Node.js 22.12 or newer and `npm ci`. Build Linux packages on Linux and macOS
packages on macOS; the build script rejects packaging for another operating
system. A Linux VM works for producing the Linux files from a Windows workstation.
Debian 12 is the release build baseline for Linux DEB and AppImage; use that
distribution for matching local portable builds. macOS packaging needs a Mac or
a hosted macOS runner.
The utilities below follow electron-builder's
[Linux build prerequisites](https://www.electron.build/v26/docs/features/multi-platform-build/#linux);
Ubuntu supplies `bsdtar` through `libarchive-tools`.

On Ubuntu 24.04, install the packaging utilities before building:

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y build-essential rpm libarchive-tools libopenjp2-tools
npm ci
npm test
npm run build:linux
```

This creates all four Linux formats and a SHA-256 checksum file beside each
package under `dist/`. Names follow `overkot-<version>-linux-<arch>.<extension>`;
architecture labels can differ by package format. The Pacman extension is
`.pkg.tar.xz`. The current portable preview is
`overkot-0.0.13-linux-x86_64.AppImage`.

On a Mac, install Xcode Command Line Tools (`xcode-select --install`) if needed:

```bash
npm ci
npm test

# Local test packages for this Mac's architecture; no Apple account required
npm run build:mac -- --adhoc

# Or choose an architecture explicitly
npm run build:mac -- --x64 --adhoc
npm run build:mac -- --arm64 --adhoc
```

DMG and ZIP files are named `overkot-0.0.11-mac-x64` or
`overkot-0.0.11-mac-arm64`, with their respective extensions and checksums.
Run builds sequentially: they share `.build/` and `dist/` staging locations.
The Windows scanner EXE is only staged in Windows builds.

To review a target configuration from any OS without compiling or packaging:

```bash
npm run build:linux -- --inspect-config
npm run build:arch -- --inspect-config
npm run build:linux:portable -- --inspect-config
npm run build:mac -- --arm64 --adhoc --inspect-config
```

All local commands use `publish: never`. Native packages have no automatic app
update channel yet; install a newer native package or replace the AppImage manually.
Windows, DEB and AppImage share the release pipeline for new releases, while
`latest.yml` is only the Windows update feed.

## GitHub build workflow (paused)

The manual workflow
[Linux and macOS test packages (paused)](../.github/workflows/build-platforms.yml)
has an explicit `if: ${{ false }}` guard on its build job. Dispatching it skips
packaging while platform work is on hold. Remove that guard and the paused
workflow label when deliberately resuming native builds.

The retained matrix runs Node tests and packages on three native hosted runners:
Ubuntu 24.04 x64, macOS 15 Intel, and macOS 15 Apple Silicon. These labels are explicit to avoid
architecture changes when GitHub changes a `latest` label; see GitHub's
[available runner images](https://github.com/actions/runner-images#available-images).

After re-enabling the job on the repository's default branch, open its page in
**Actions → Run workflow**, select the branch, and start it.
Download the platform artifact from the completed run's **Artifacts** section.
Each artifact contains the packages and checksums and is retained for 14 days.
GitHub's artifact download wraps them in a ZIP; after extraction, restore the
AppImage executable bit with `chmod +x overkot-*.AppImage` before launching it.

The workflow is manual only. It has read-only repository permissions, uses no
deployment or signing secrets, and does not create a release, upload to S3, or
publish updater metadata. Running it consumes the repository's normal Actions
minutes and artifact storage allowance when re-enabled.

## macOS distribution

`--adhoc` signs the app with an ad-hoc identity and disables notarization and
hardened runtime for local test builds. This
allows packaging tests without an Apple Developer account, but does not provide
a trusted publisher identity or Gatekeeper approval. Downloaded test builds may
be blocked or require an explicit per-app approval; see Apple's
[guidance for opening downloaded apps](https://support.apple.com/en-gb/102445).
Do not disable Gatekeeper globally.

Before distributing a normal macOS release, arrange an Apple Developer account,
a Developer ID Application certificate, and notarization credentials. The
standard `npm run build:mac` command leaves electron-builder's normal signing
discovery enabled; omit `--adhoc` for that release process. A dedicated signing
and notarization workflow must be configured and verified before public macOS
distribution. ZIP and DMG packages alone do not complete that work. See
[electron-builder's macOS signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)
for certificate discovery and the differences between test and release signing.

## Native release checks still needed

1. Re-enable the manual build workflow and verify every requested package and checksum
   is produced. A passing unit suite and package build are only the first checks.
2. Install, launch, quit, relaunch, and uninstall on clean Debian/Ubuntu,
   Arch-based, and Fedora/Red Hat-based test desktops. Check AppImage on each
   family as well as its native package; record distro, desktop, and architecture.
3. Verify the app is visible and usable without the game, settings persist,
   market sign-in and browsing work, and the wiki, map, calendar, and clocks load.
   Use test listings when checking market management.
4. On Linux, test X11 and Wayland separately, including hotkeys, moving windows,
   multiple monitors, scaling, and game fullscreen/borderless behavior. Test
   Wine/Proton process and log discovery, inventory refresh, and game restart
   without changing system security settings. Record unsupported combinations.
5. On both Intel and Apple Silicon Macs, test a downloaded artifact on a second
   Mac, the normal app launch/close cycle, and companion tools. Verify the final
   Developer ID signature and notarization before a public release.

A Mint launch has been reported, and automated Linux X11 checks cover the overlay.
Full live-game, desktop and display combinations still need acceptance testing.
Keep Linux marked experimental until those checks pass; macOS remains on hold.
