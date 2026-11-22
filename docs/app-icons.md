# App and installer branding

`assets/overkot.png` is the artwork master. The dock, Settings, tutorials, the
focus reminder, wiki and embedded Market branding use this file. Linux and
macOS packaging and native window icons also use this PNG.

Windows native window icons use the generated `assets/overkot.ico`, including
popouts and Daily Brief. Electron loads the ICO frame at the icon size requested
by Windows. Passing the full-resolution PNG instead creates an oversized native
icon that Windows can crop in its taskbar hover preview.

Regenerate the Windows and installer assets after replacing the master:

```powershell
npm run assets:icons
```

This authoring command requires ImageMagick (`magick` on PATH, or
`MAGICK_BINARY` pointing to its executable). It preserves the original PNG and
uses Lanczos downsampling to create 32-bit ICO frames at 16, 20, 24, 32, 40, 48,
64, 96, 128 and 256 pixels. The tray, application executable, installer,
uninstaller and legacy icon aliases all use the same generated artwork.
Explicit ICO paths bypass electron-builder's PNG conversion cache.

The assisted installer uses a 600×228 header and a 656×1256 sidebar, four times
the standard NSIS artwork dimensions. The uninstaller shares those assets.
The wizard declares itself DPI-aware so Windows lays out its text and artwork
at the display's native scale instead of enlarging the entire dialog.
The shared NSIS bitmap helper loads the full artwork and uses GDI HALFTONE
downsampling into the control's actual pixel dimensions. It replaces the
coarse default resize in installer/uninstaller headers and sidebars, preserving
MUI's normal page behavior and image cleanup.

`assets/app-icons.json` records the master's dimensions and SHA-256 plus hashes
for each generated file. Every build checks those hashes, ICO frames and bitmap
dimensions before staging. Builds consume checked-in assets and do not require
ImageMagick. Installer-only bitmaps and the validation manifest stay outside the
installed app's runtime archive.

Validation:

```powershell
node --test test/appIcons.test.js test/packaging.test.js
npm run check:installer-branding
npm run build
```

Inspect the built installer before installing: verify its title-bar icon,
wizard header and sidebar, then close it. The generated ICO includes native
sizes for common Windows DPI settings, while the wizard bitmaps cover scales
up to 400% without enlarging their source artwork.
The native check compiles the same bitmap helper into a silent test executable
and verifies 100%/200% rendering, register preservation and handle cleanup.
It uses an isolated directory beneath `output` and installs nothing.
