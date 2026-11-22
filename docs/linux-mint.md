# Linux Mint / Debian overlay builds

The amd64 DEB and x64 portable AppImage are experimental native Linux Electron
builds, produced on Debian 12. Start testing on Linux Mint or Debian with an X11
desktop session and Soulframe in a window or borderless window through
Wine/Proton. Both formats include the overlay and a native Linux scanner;
neither ships or executes the Windows C# `hostservice.exe`.

## Build and install

Use Node.js 22.12+ on Linux. From the application repository:

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y build-essential libx11-dev libarchive-tools libopenjp2-tools clang zlib1g-dev libssl-dev cmake
npm ci
npm test
npm run build:deb

# Portable release without installing Overkot
npm run build:linux:portable
```

Install the .NET 8 SDK before building the native player-position reader.
NativeAOT includes the required runtime in the ELF companion
`overkot-position-reader-core`; a small C `overkot-position-reader` launcher
opens the game before starting it. Installed packages and AppImage users do not
need a .NET installation.

The build statically links OpenSSL into that companion using the official
[NativeAOT static OpenSSL option](https://github.com/dotnet/runtime/blob/v8.0.22/src/coreclr/nativeaot/docs/compiling.md#using-statically-linked-openssl).
`libssl-dev` and CMake are build prerequisites; the finished reader does not
depend on the host's OpenSSL major version. Rebuild packages against updated
build-system libraries when servicing the bundled OpenSSL code.

No Market API secret is required. Set `OVERKOT_MARKET_UI=disabled` for a standalone
build without the optional private frontend. Each command builds
only its requested format, writes a SHA-256 checksum beside it under `dist/`, and
never publishes. `build:linux:portable` runs `build.js --linux --portable`, selecting
only AppImage. Windows developers can use a Debian 12 Linux container/VM or the
manual **Linux Mint and Debian test packages** workflow. That workflow requires
no integration secret and uploads the packages and
checksums. New normal releases also build the DEB and AppImage alongside
Windows, submit them to VirusTotal, and publish their download and scan links
through the [release pipeline](release-pipeline.md).

Install the downloaded package from its directory (substitute its actual name):

```bash
sha256sum -c overkot-0.0.17-linux-amd64.deb.sha256
sudo apt install ./overkot-0.0.17-linux-amd64.deb
```

The DEB install configures the root-owned native session scanner and small C
player-position launcher with `CAP_SYS_PTRACE`, allowing them to read a same-user Soulframe process under normal
Linux process restrictions. Only those game-specific helpers receive this capability;
the Electron app runs as your normal user. No system-wide ptrace setting is
changed, and the scanner has no background service or network listener.
The position launcher validates and opens the game, drops capabilities, then
executes its `overkot-position-reader-core` NativeAOT companion. The companion
has no file capabilities, so its runtime threads start unprivileged.

Launch **Overkot** from the application menu. APT resolves the declared system
libraries, including `libcap2-bin` used to configure the helper. This is a local
DEB installation, not an APT repository subscription;
install later packages manually. An APT repository and Linux automatic updates
are not configured. Remove the package with `sudo apt remove overkot`.

## Run the portable AppImage

Download the AppImage and its checksum to the same directory. For the current
preview:

```bash
sha256sum -c overkot-0.0.17-linux-x86_64.AppImage.sha256
chmod +x overkot-0.0.17-linux-x86_64.AppImage
./overkot-0.0.17-linux-x86_64.AppImage
```

Run it as your normal user. It requires no Overkot package installation or
administrator launch. Debian 12 is the build baseline; an AppImage still needs
the host desktop libraries required by Electron. Older Debian releases and
other desktops need separate testing.

The AppImage normally uses FUSE 2. On Debian 12, install `libfuse2` if it is
missing; Ubuntu 24.04 names this package `libfuse2t64`. If FUSE is unavailable,
extract and run without mounting:

```bash
./overkot-0.0.17-linux-x86_64.AppImage --appimage-extract-and-run
```

For a runtime that does not support that option, use
`./overkot-0.0.17-linux-x86_64.AppImage --appimage-extract`,
then launch `./squashfs-root/AppRun` from the same directory. These methods are
documented in the official [AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
The launcher preserves Electron's renderer sandbox. If the desktop blocks its
sandbox, use the DEB; `--no-sandbox` is not part of the portable launcher.

Portable means the application runs without installation. Preferences, cache
and downloaded data use `$XDG_DATA_HOME/Overkot`, or
`~/.local/share/Overkot` when `XDG_DATA_HOME` is unset or relative. Browser
profiles use Electron's normal user configuration directory. These data remain
on the computer when the AppImage is moved or deleted, and the DEB and AppImage
share the same Overkot preferences. Replace the AppImage manually to update it;
Linux automatic app updates are not configured.

The AppImage helper has ordinary user permissions. Unlike the DEB installation,
it does not configure `CAP_SYS_PTRACE`, so Linux process restrictions can block
live game inventory while the companion tools remain available. See
[Live Soulframe account data](#live-soulframe-account-data) below.

## Overlay behavior

- With `DISPLAY` available, Overkot prefers Electron's X11 backend, including
  XWayland on a Wayland desktop. An explicit `--ozone-platform` is respected.
- Test a native X11 session first. XWayland behavior still depends on the
  compositor, especially above fullscreen games.
- On X11/XWayland, the rail, attached/floating panels and expanded dungeon map
  follow fullscreen workspaces. A bundled, ordinary-user X11 helper gives the
  overlay a layer above fullscreen games: KDE critical
  notification, with standard notification and dock fallbacks for other window
  managers. It also requests compositing for transparent overlay windows.
  Popouts follow the rail as transient windows and retain native move/resize.
  While Overkot is inactive it raises visible overlay windows without focusing
  them; hidden panels stay hidden. This applies to Arch and Debian-based builds.
  See [fullscreen validation](linux-fullscreen-testing.md) for local checks and
  the remaining desktop/game acceptance checks.
- Native Wayland is a limited companion mode for window behavior: Electron
  cannot supply the existing always-on-top and global positioning controls.
  `overkot --ozone-platform=wayland` selects that backend explicitly.
- Linux starts with mouse interaction enabled. Enable click-through only after
  checking the interaction hotkey. Shift+F1 activates the overlay even when
  click-through is disabled; with click-through enabled, it toggles interaction.
  A failed hotkey registration returns windows to interactive mode instead of
  leaving them inaccessible.
- On X11/XWayland, dragging uses the desktop cursor in logical screen coordinates
  and retains the requested window size across drags, including at fractional
  scaling. Releasing the pointer
  outside the drag handle or switching applications ends the drag.
- Hide when the game closes uses Linux process detection. Hide when the game
  loses focus is unavailable on Linux; that setting remains disabled.

See the [Electron window limitations](https://www.electronjs.org/docs/latest/api/base-window)
and [Electron 40 shortcut portal setup](https://github.com/electron/electron/blob/v40.10.6/docs/api/global-shortcut.md).

## Live Soulframe account data

There are two separate connections. Signing into avakot.dev or the Market uses
the existing web/API sign-in flow. Live Soulframe inventory requires the running
game's account ID and session nonce. A website sign-in alone does not provide
that game session.

On Linux, process detection locates Soulframe under Wine/Proton. The app discovers
`EE.log` in supported prefix locations and launches the packaged native helper.
The helper verifies the target is named Soulframe and that its real, effective,
saved and filesystem user IDs match the caller. It opens only that process's
maps and memory, drops its capabilities, and returns bounded account/session
candidates over its private output pipe. It accepts no arbitrary memory-read
request and returns no raw memory. The app validates candidates using the existing
inventory client, then polls the same live inventory API used on Windows.
Choose the log and screenshot locations in Settings when using a custom prefix.

The scanner reads ASCII and UTF-16LE strings, handles chunk boundaries, and
limits each pass by bytes, time and candidate count. It runs outside Electron's
main process, keeping the overlay responsive. A native JavaScript `/proc`
scanner remains the fallback for development/unpacked runs without the helper.
No installed .NET runtime is needed by either scanner backend or by the native
player-position reader included in Linux packages.

## Live player maps and Arena Finder

Linux packages include a native reader for live character position, facing and
dungeon room frames under Wine/Proton. This does not depend on the desktop's
Wayland or X11 session. Installed DEB and Pacman packages configure the reader's
process-read capability; AppImage retains ordinary user permissions and can be
blocked by Linux process restrictions. Settings → Overlay → Player location
reports tracking status. Use an installed package if a portable read is blocked.

Dungeon room counts come from the game log. Unexplored room outlines stay hidden
until live position and dungeon placement are verified, then reveal as you walk.
Arena Finder independently decodes the current room list, so player tracking and
an open Mini-Map are not required. Missing metadata shows a waiting state rather
than claiming that the arena is absent. See [player tracking](player-tracking.md)
and [Arena Finder](arena-finder.md).

Linux Yama can prevent separately launched applications from reading one another,
even under the same user. The installed helper's capability addresses the usual
restricted-access mode without elevating Electron. Stronger kernel policies,
container capability limits, or filesystems that block file capabilities can
still deny access. See the [kernel Yama documentation](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html).

When the app reports that process access is blocked, live inventory is unavailable
in that session. Companion features remain usable. Do not run the overlay as
root or disable system-wide process protections to make this test build work.

The DEB readers live at `/opt/Overkot/resources/bin/overkot-session-scanner` and
`/opt/Overkot/resources/bin/overkot-position-reader`, with the uncapped companion
at `/opt/Overkot/resources/bin/overkot-position-reader-core`. All are removed with
the package. Reinstalling the DEB restores root ownership and launcher capabilities
while ensuring the companion has none.
The AppImage bundles its own readers and launches them with ordinary user
permissions; it does not use the DEB's capability setup.
Yama restricted mode commonly blocks access to a separately launched game in
the portable build. Use the DEB when the AppImage reports **Access blocked** and
live inventory or player tracking is required. Steam/Proton, standalone Wine and sandboxed launchers
still need testing against a real game session before live linking is called
supported.

## Acceptance checks on Mint

Record Mint version, desktop, X11/Wayland session, Wine/Proton version and launcher.

1. Install the DEB and launch from the menu; separately launch the AppImage
   without installing it. Quit, relaunch, and verify settings persistence for
   each format. Test the AppImage's extract-and-run path when FUSE is absent.
2. In windowed/borderless Soulframe, verify transparency, topmost placement,
   dragging, docking, hotkey interaction, click-through, scaling and monitors.
   With click-through off, Shift+F1 should focus Overkot from the game. At 125%
   scaling, repeated widget drags should preserve size and stop on release.
3. Check automatic game/log discovery, then verify a live inventory refresh.
   If permission is denied, check that the UI explains it and remains responsive.
   Walk and turn in the overworld, then enter a dungeon and check player
   following, room-outline reveal and Arena Finder against the generated arena.
4. Log out/in and restart the game; confirm reconnection or a clear blocked state.
5. Check Market/account sign-in, map, wiki, calendar and clocks independently.

Package creation and automated tests do not replace these real desktop/game
checks. Keep the build experimental until they pass.

## Automated Linux validation

The native package was built in Debian 12 and installed through APT in an
isolated test container. Xvfb checks with Openbox and Cinnamon's Muffin window
manager run Electron as an ordinary user with its renderer sandbox enabled.
They verify always-on-top, physical X11 mouse pass-through, both directions of
the interaction hotkey, and Shift+F1 activation with the fresh Linux defaults.
Drag checks cover stationary cursors, fast releases outside the handle, long
gestures and repeated gestures at 100% and 125% scaling. They do not simulate a
Wayland compositor or a fullscreen game.

The committed regression tests cover asynchronous window-manager replies,
fractional-size rounding across 1,050 movements, intentional resize/collapse
changes, pointer capture cleanup and hotkey activation:

```bash
node --test test/windowDrag.test.js test/windowDragRenderer.test.js test/overlayRuntime.test.js
```

`scripts/check-linux-scanner.js` tests the installed helper against synthetic
processes under Yama mode 1: same-user sibling reads, ASCII/UTF-16LE extraction,
rejection of unrelated and other-user processes, denied reads without the
capability, and invalid arguments. Run this administrative QA orchestrator only
in an isolated Linux test container with `SYS_PTRACE` in its bounding set; it
launches the helper and fixtures as ordinary users and never changes Yama policy.
No real game account or inventory API is involved in the scanner check.
