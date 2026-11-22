# Arch-based Linux builds

The x64 Pacman package and portable AppImage are experimental release packages
for Arch-based desktops, available from the website with checksums and matching
VirusTotal reports. Updates are manual. Start with an X11 desktop session. Real Soulframe
sessions under Wine/Proton and individual Arch derivatives still need testing.

## Build locally

Use Node.js 22.12+ on Linux. From the application repository:

```bash
npm ci
npm test

# Native Arch package only
npm run build:arch

# Portable Linux AppImage only
npm run build:arch:portable
```

Run the builds sequentially because they share staging directories. Each command
writes its package and SHA-256 checksum under `dist/` with `publish: never`.
`build:arch` runs `build.js --linux --pacman`; it does not build the other Linux
formats. `build:arch:portable` selects the same Linux AppImage as
`build:linux:portable`, shared with Debian testing.
No Market integration secret is required to build. The optional Market frontend
can be omitted with `OVERKOT_MARKET_UI=disabled`; see [Market build configuration](market.md).
Linux builds include the native C scanner and native
player-position reader, and omit the Windows scanners. Install the .NET 8 SDK,
Clang and zlib development headers to build the NativeAOT position-reader
companion and C launcher; the finished packages need no .NET runtime.
Release builds use Debian 12's `libssl-dev` and CMake to statically link OpenSSL
into the companion, so Arch's OpenSSL 4 does not require a compatibility package
to run Overkot. For local compilation, use that Debian VM/container baseline;
an Arch build host would also need compatible static `libssl.a` and `libcrypto.a`
archives, which are separate from ordinary shared runtime libraries.

On an updated Arch build host, install packaging tools with:

```bash
sudo pacman -S --needed base-devel libx11 libarchive openjpeg2 clang zlib
```

Arch's [base-devel package](https://archlinux.org/packages/core/any/base-devel/)
includes the C compiler, `libx11` provides headers for the fullscreen overlay helper,
[libarchive](https://archlinux.org/packages/core/x86_64/libarchive/files/)
provides `bsdtar`, and [openjpeg2](https://archlinux.org/packages/extra/x86_64/openjpeg2/files/)
provides the JPEG 2000 tools used by Linux packaging. Install Node.js and npm
separately if they are not already available. Windows developers can produce the
files in a Linux VM/container. Debian 12 remains the AppImage build baseline;
see [Debian build prerequisites](linux-mint.md#build-and-install).

## Install the native package

Keep the package and its checksum in the same directory. For the current Linux release:

```bash
sha256sum -c overkot-0.0.17-linux-x64.pkg.tar.xz.sha256
sudo pacman -U ./overkot-0.0.17-linux-x64.pkg.tar.xz
```

Use the actual filename if building another version. Pacman installs a local
package and resolves declared dependencies from your configured repositories;
see the official [pacman manual](https://man.archlinux.org/man/pacman.8.en).
Launch **Overkot** from the application menu as your normal user. This installs a
local package without adding a package repository or AUR entry. Install newer
packages with `pacman -U` manually; Linux automatic app updates are not configured.
Remove the app with `sudo pacman -R overkot`.

Installation configures the root-owned native session scanner and player-position
reader at `/opt/Overkot/resources/bin/overkot-session-scanner` and
`/opt/Overkot/resources/bin/overkot-position-reader` with `CAP_SYS_PTRACE`.
Only these game-specific helpers receive process-read capability; Electron runs as your
normal user. The position reader is a small C launcher: it validates and opens
the target game, drops capabilities, then executes `overkot-position-reader-core`.
That NativeAOT companion is root-owned and executable but has no file capability,
so its runtime threads start unprivileged. The declared `libcap` dependency
provides `setcap` and `getcap`. The installer
does not change system-wide process access settings or create a scanner service.
The upgrade hook repeats this setup when reinstalling or replacing the package.

## Run the portable AppImage

Keep the AppImage and checksum together, then run:

```bash
sha256sum -c overkot-0.0.17-linux-x86_64.AppImage.sha256
chmod +x overkot-0.0.17-linux-x86_64.AppImage
./overkot-0.0.17-linux-x86_64.AppImage
```

Run it as your normal user. If FUSE 2 is missing, Arch provides it through
[fuse2](https://archlinux.org/packages/extra/x86_64/fuse2/):

```bash
sudo pacman -S --needed fuse2
```

If FUSE is unavailable, extract and run without mounting:

```bash
./overkot-0.0.17-linux-x86_64.AppImage --appimage-extract-and-run
```

For a runtime without that option, use `--appimage-extract`, then launch
`./squashfs-root/AppRun`. These alternatives are described in the official
[AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
The launcher preserves Electron's renderer sandbox. Replace the AppImage manually
to update it.

Portable means the app runs without installation. Preferences, cache and
downloaded data still use `$XDG_DATA_HOME/Overkot`, or `~/.local/share/Overkot`
when `XDG_DATA_HOME` is unset or relative. Browser profiles use Electron's normal
user configuration directory. The native package and AppImage share this user
profile, and moving or deleting the AppImage leaves those data in place.

## Overlay and live data

With an X display available, the packaged launcher selects X11/XWayland before
Electron initializes, so dock placement and grid snapping work on a Wayland desktop.
Desktop-wide `ELECTRON_OZONE_PLATFORM_HINT` settings no longer override the
overlay's selection.
A deliberate `--ozone-platform=wayland` still selects native Wayland, where Electron
cannot position the dock or snap panels. See Electron's
[window positioning limitations](https://www.electronjs.org/docs/latest/api/browser-window).

On KDE Plasma, CachyOS or another Wayland desktop with XWayland installed, the
normal launcher should select XWayland automatically. To explicitly test that
backend, quit the existing Overkot process and run:

```bash
overkot --ozone-platform=x11 --log
# Or use the actual AppImage filename:
./overkot-0.0.17-linux-x86_64.AppImage --ozone-platform=x11 --log
```

Settings → Overlay reports the selected display backend. The `--log` startup
output also records it. Record the desktop/session with
`printf '%s / %s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"` when reporting a test.
An X11 session remains an option when XWayland is unavailable. Window stacking
and global hotkeys still depend on the compositor.
See [Linux overlay behavior](linux-mint.md#overlay-behavior) for hotkeys,
click-through and display details.

Both formats include Wine/Proton process/log discovery and the native game-only
scanner. The AppImage helper runs with ordinary user permissions, so Linux
process restrictions can block live inventory from a separately launched game.
Use the installed Pacman package when the AppImage reports **Access blocked**
for inventory or cannot read the player position in Settings → Overlay → Player
location. Its reader capabilities permit same-user game
reads under normal Linux restrictions; real game/launcher combinations still
need testing.
Live map position, facing and dungeon exploration work independently of Wayland
or X11 once the native reader can access the game. A dungeon's room count comes
from the log, but its unexplored outlines stay hidden until a verified live
position and dungeon placement arrive. Arena Finder uses decoded current room
data without requiring player tracking or an open map; unavailable room data
shows a waiting state. See [player tracking](player-tracking.md).
Companion features such as the wiki, map, calendar and Market remain available.
Custom prefixes may require choosing `EE.log` and the screenshot folder in
Settings. See [Linux live account data](linux-mint.md#live-soulframe-account-data)
for scanner behavior and the separate web/account sign-in flow.

## Desktop acceptance checks

Record the distribution, desktop, X11/Wayland session and Wine/Proton version.
For the local dock preview, change **Dock edge** to each of top, bottom, left and
right. Verify that the bar moves to the selected screen edge, stays there after
opening Settings, and returns there after hiding/showing it. Open two widgets;
they should initially align beside the bar. Hold Shift to arrange a panel, drag
it away from the bar, and release Shift to snap it to the grid. Drag it back onto
the bar while holding Shift to dock it. Repeat after quitting and relaunching.
Install, launch, quit and relaunch the native package; repeat with the AppImage
and check settings persistence. Exercise AppImage extract-and-run, dock movement,
transparency, click-through, hotkeys, scaling and multiple monitors. Test live
inventory with a real game session, including game restart and a clear blocked
state when permissions deny access. A package build or automated X11 check does
not complete those desktop/game checks.

The current preview passed automated checks in an official Arch Linux container:
native installation, reinstall restoring the scanner capability and launcher,
and removal; normal-user X11 startup, active renderer sandbox and settings
persistence for both the native package and AppImage extract-and-run. The
installed scanner passed same-user game-process fixtures for ASCII and UTF-16
data and rejected unrelated and other-user processes. Real desktop, Wayland and
Soulframe sessions remain part of the acceptance checks above.
