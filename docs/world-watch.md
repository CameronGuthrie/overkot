# World Watch preview

Enable **Widgets → World Watch**. The Now tab puts the existing animated Midrath
clock beside the animated weather, with the next weather change below. The Today
card shows the UTC calendar date, ancestor encounter and Zenith offerings. Click
it to open today's full calendar.

Forecast and Calendar stay inside the same window. Their longer content scrolls
inside the panel. The default window is 350px wide and about 311px high including
its header; it supports widths down to 300px and can collapse to its header. It
works as a floating widget or a dock cell. The three original widgets remain
available independently, and existing layouts are preserved.

The combined widget uses the same clock, weather and calendar services as the
original widgets, including cached data, ancestor settings and the shared
offerings preference. New labels currently fall back to English; existing
component translations and localized dates still apply. Tab buttons support
Left/Right, Home and End keys. Weather retains its reduced-motion behavior.

When the account's timers contain **Blessed Meeting**, the Today/ancestor button
fills as its 23-hour cooldown elapses and shows the percentage and remaining
time beside the ancestor's name. The countdown uses the server's expiry time,
including an existing cached timer, and updates every second between inventory
refreshes. An explicitly expired timer shows Ready until the next inventory
update removes it. A missing or invalid timer shows no fill, percentage or Ready
label. The button keeps the same height and still opens today's calendar.

## Local Windows preview

Version: `0.0.12-preview.world-watch.2`.

```powershell
npm ci
npm run build:portable
```

The output is `dist/overkot-portable-0.0.12-preview.world-watch.2.exe`, with a
matching `.sha256` file. This command only builds locally. Keep this preview out
of release tags, release workflows and download/update feeds until it is approved
for public release. A preview version name alone does not prevent publication.

The portable executable uses the usual Overkot settings folder. Close another
running copy before trying it, then select World Watch in the widget picker.

## Checks

```powershell
npm test
node scripts/check-world-watch.js --source
node scripts/check-world-watch.js --packaged
```

The UI harness uses an isolated profile and fixture data. It checks animation,
fixed-height tabs, keyboard navigation, language and offerings changes, offline
recovery, UTC rollover, floating and docked layouts, collapse and reopen, multiple
instances, and cleanup after pending requests. Blessed Meeting checks cover
cached startup, live state broadcasts, 0% and 50% fill, local expiry, removal,
renewal, translated names and unchanged dimensions in both layouts.
Screenshots are written beneath
`output/world-watch-check-*`. The packaged check loads the built ASAR renderer
in the packaged Electron runtime with the harness main process.
