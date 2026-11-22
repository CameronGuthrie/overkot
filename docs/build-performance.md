# Build speed and Windows signing

`npm run build:portable:no-obfuscate` bundles the app, compiles the helper,
packages Electron, and compresses everything into a self-extracting portable.
Obfuscation is already disabled; the regular `build:portable` command runs the
same build.

The pinned electron-builder 26.8.1 uses a 7-Zip LZMA archive with `-mx=9` for
the default portable target, even with the overall `normal` compression setting.
This archive pass can take much longer than bundling or executable preparation.

The builder logs `signing with signtool.exe` before resolving signing credentials.
Without a certificate or signing hook, its signing manager immediately returns
without running SignTool. That message does not indicate a signed file or tell
you which work is consuming the time afterward. Windows Authenticode inspection
of both current Overkot executables reports `NotSigned`. Icon and version edits
are separate from a certificate-backed signature.

For local iteration:

| Command | Output | Tradeoff |
| --- | --- | --- |
| `npm run pack` | `dist/win-unpacked/Overkot.exe` | Runs directly from the folder; skips creation of a portable archive. |
| `npm run build:portable:fast` | `dist/overkot-portable-0.0.9-fast.exe` | ZIP compression inside the portable; faster build with a larger file. |
| `npm run build:portable:no-obfuscate` | `dist/overkot-portable-0.0.9.exe` | Default LZMA compression for the smaller distribution file. |

Names follow the package version. The fast portable remains compressed and uses
the same app, helper, locales, and executable metadata. It has a distinct name
so it does not overwrite the normal portable. Signing configuration is unchanged.

Build output now reports preparation time, packaging progress every 15 seconds,
and final packaging/total times, so a preceding signing message no longer looks
like the operation occupying the whole wait.

## Local measurement

Measured on September 12, 2026 in an isolated workspace, using the same app
content, Electron 40.10.6, and cached build tools:

| Portable mode | Total build | Compression/package compiler | File size |
| --- | ---: | ---: | ---: |
| Default LZMA | 99.9 s | 7-Zip: 93.4 s; NSIS: 0.4 s | 89.9 MB |
| Fast ZIP | 34.8 s | NSIS: 29.1 s; no separate 7-Zip archive pass | 136.6 MB |

Sizes use decimal MB. Fast was about 2.9 times faster with a 52% larger file in
this run; other machines and cold caches will differ. Signing checks took
milliseconds and skipped signing in both builds. The fast executable was
launched with an isolated profile and verified to load the packaged main window
using Electron 40.10.6 and the English locale, then quit normally.

Avoid running two builds against the same workspace simultaneously: they share
the staging directory and unpacked output, even when artifact names differ.

References: [portable ZIP option](https://www.electron.build/v26/docs/api/app-builder-lib.interface.portableoptions/#usezip),
[compression options](https://www.electron.build/v26/docs/configuration/#compression).
