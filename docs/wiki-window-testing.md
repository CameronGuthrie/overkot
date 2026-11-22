# Wiki window crash and validation

Wiki Search uses the `wikiWebsite` origin in the service profile. Community builds leave the search field disabled until a MediaWiki site is configured. Calendar entries remain readable offline.

Windows portable extraction can use a short path such as `ADMIN~1.WOR` under
`%TEMP%`. Node encodes its tilde as `%7E` in a file URL while Chromium leaves it
literal. Comparing those URL strings rejected every toolbar IPC request even
though the wiki article loaded normally. The IPC gate now compares decoded
local filenames and still requires the exact toolbar window and main frame.

The window's drag region covers the brand and empty titlebar space; the
navigation and close buttons sit in a separate non-draggable group.

The controls check uses real Windows mouse input after focusing the article,
changing its zoom, resizing, maximizing, and repeating searches. It does not
refocus the toolbar before each click. The search check also records main-process
acknowledgements for every toolbar action, including refresh on the live wiki.

For the local beta, point both checks at its actual packaged runtime and archive:

```powershell
$env:OVERKOT_PACKAGED_DIRECTORY = (Resolve-Path 'dist-beta/title-tracker/win-unpacked').Path
node scripts/check-wiki-controls.js
node scripts/check-wiki-search.js --game --clickable-widgets --native-foreground
node scripts/check-wiki-search.js --game --clickable-widgets --native-foreground --live-wiki
node scripts/check-wiki-portable.js
```

Both checks honor this path for their runtime and app assets. Add `--source` to
check current source before rebuilding. Build the local beta with
`npm run build:beta:portable`; do not publish or push it during local review.

`check-wiki-portable.js` launches the delivered portable executable through its
normal extraction path with isolated settings. It keeps the real packaged state
and uses a loopback-only debugging connection to exercise searches and toolbar
commands. This catches temporary-path differences that the unpacked test wrapper
cannot reproduce. The native controls check additionally accepts a short-path
`OVERKOT_PACKAGED_DIRECTORY` for verifying real mouse input through that alias.

The portable crash on the `vetch` search exposed a second, packaging-specific
problem: `electronLanguages: ["en", ...]` removed both `en-US.pak` and `en-GB.pak`.
Those are Chromium runtime resources, separate from the app's `langs/en.json`.
The failing portable reported an empty runtime locale and "locale resources are
not loaded" before terminating while opening the wiki. The same executable and
saved profile opened Vetch successfully with its included French runtime locale.

Both English packs are now explicitly included. An `afterPack` check rejects
missing or empty English packs and any missing configured locale before an
installer or portable is produced.

The September 2026 Windows crash dump showed a null pointer read at `0xd0` in
`InspectableWebContents::GetView`, called from `WebContentsView::NonClientHitTest`
while `InspectableWebContents` was being destroyed. Windows reported exception
`0xc000041d` in the main process, so the entire overlay exited.

This matches [Electron #50042](https://releases.electronjs.org/pr/50042), which
fixes native hit-testing against a partially destroyed view. The fix was first
backported to Electron 40.8.0. The app now uses 40.10.6 instead of 40.6.1, with
the lockfile updated so clean installs and portable builds include the fix.
JavaScript navigation error handling cannot catch this native crash.

On Windows with Node.js 22.12 or newer, build the unpacked app and exercise its
actual bundled main process and packaged runtime resources:

```powershell
npm ci
npm test
npm run pack -- --skip-scanner
node scripts/check-wiki-search.js
node scripts/check-wiki-search.js --live-wiki
node scripts/check-wiki-controls.js
node scripts/check-packaged-content.js --live-wiki
```

`--skip-scanner` reuses the existing native helper under `assets/bin`; omit it
when rebuilding that helper. The checks use disposable profiles under ignored
`output/` directories. The wiki integration check disables game discovery and
native helper execution, then submits Enter through the real wiki widget. It
keeps normal native window rendering and the app's focus/click-through handlers.
Both check scripts use hardlinks to the packaged executable, DLLs, ICU data and
locale files, with a fixture bootstrap to isolate services. They no longer run
inside development Electron, whose extra locale files masked this omission.
The wiki check asserts the UK English runtime locale loads before searching.
It checks searches, minimize/restore, maximize, close/reopen, and twenty cancelled
searches with the window under the cursor to exercise hit-testing during teardown.
The live variant searches `vetch`, Bromius and Verminia on the public wiki. Screenshots
and the tested Electron version are included in its output.

`check-wiki-controls.js` uses the source browser controller with packaged chrome
and preload assets, opens the wiki with an offline fixture, and uses mouse input
on Back, Forward, Refresh, Open in browser, Retry and Close. The search check above
exercises the bundled browser controller through the app's normal IPC.
It also checks refresh history, in-page history, Shift+F5 in both surfaces,
and delayed success/error responses while another window has focus. Searches
activate the wiki when requested; later page loads and errors preserve the
current foreground window. Use `--source` to check current source with the
packaged runtime before rebuilding. These wiki GUI checks launch normally and
assert native visibility and focus. Windows' hidden startup flag can otherwise
hide the first window despite Electron emitting its `show` event. Controls,
article and retry-state captures are saved alongside the controls-check summary.

Rebuild the portable after validation:

```powershell
npm run build:portable:no-obfuscate -- --skip-scanner
```

The output is `dist/overkot-portable-<package.json version>.exe`. An already-running portable
continues using its previously extracted runtime until it is closed and relaunched.
