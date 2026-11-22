# Local Linux dock test build

The dock compatibility preview is built locally for desktop testing. It is not a
release, and the build commands never publish it. The source package version stays
unchanged; only the staged app metadata receives
`0.0.13-preview.linux-dock.1`. Title Tracker is included, using the same checked-in
catalogue as ordinary builds.

From a Linux build host with the [Arch packaging prerequisites](linux-arch.md#build-locally),
run these commands sequentially:

```bash
npm ci
npm run build:arch -- --linux-test
npm run build:arch:portable -- --linux-test
```

Both packages and their SHA-256 checksums are written to `dist-beta/linux-dock/`.
Generated app files use `.build/linux-dock/app/`, separate from ordinary release
and Title Tracker beta staging. `--linux-test` accepts only Linux Pacman, AppImage
or unpacked builds. Packaging retains the existing `overkot` package identity and
user preferences so the friend can test against their current setup.

To install the local native preview on CachyOS or another Arch-based system:

```bash
sha256sum -c overkot-0.0.13-preview.linux-dock.1-linux-x64.pkg.tar.xz.sha256
sudo pacman -U ./overkot-0.0.13-preview.linux-dock.1-linux-x64.pkg.tar.xz
```

Pacman's package metadata replaces prerelease hyphens with underscores; the
application still reports the full preview version. Launch Overkot as your normal
user. This replaces the installed package; an ordinary release can be restored by
installing its package with `pacman -U`.

For the portable preview:

```bash
sha256sum -c overkot-0.0.13-preview.linux-dock.1-linux-x86_64.AppImage.sha256
chmod +x overkot-0.0.13-preview.linux-dock.1-linux-x86_64.AppImage
./overkot-0.0.13-preview.linux-dock.1-linux-x86_64.AppImage
```

If FUSE is unavailable, append `--appimage-extract-and-run`. Close the installed
app before launching the AppImage. Choose each **Dock edge** in Settings →
Overlay and open two widgets. Hold Shift to move a panel, release Shift to snap
it to the grid, and drag it back onto the bar while holding Shift to dock it.
Include a quick drag and release, then quit and relaunch to check persistence.
Record the desktop and session with
`printf '%s\n' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE"` if a problem remains.
