# Appearance presets, version 1

Settings → Appearance edits a draft. Choose a built-in style or base palette,
then adjust global defaults or choose a widget in the scope selector. Changes
preview in local windows and embedded widget frames. **Apply** saves; **Cancel**
restores the previously saved appearance. Other settings retain their existing
autosave behavior. Closing Settings also discards unapplied appearance changes.

The resolved order is:

1. Shared defaults and colors from the selected base palette.
2. Explicit global appearance values.
3. Explicit values for the current widget, where present.

A built-in style supplies a complete starting draft using the same data model;
it is not an extra hidden precedence layer. A saved custom preset captures that
draft, including widget overrides. Selecting a widget shows which values are
inherited. Resetting a field removes its explicit value; resetting a widget
returns all of its fields to global inheritance. Section and whole-appearance
resets, undo and redo operate within the editing session.

In **Opacity**, **Background opacity** controls the outer panel and its backdrop
effects. **Elements opacity** independently controls foreground text, icons,
bars, item images and map/canvas content. **Inner surface opacity** controls
headers, buttons and smaller cards inside a panel. The Text and Bar opacity sliders
remain finer adjustments within Elements opacity. These values can be global
or overridden for a single widget, and round-trip in named presets and exports.
Setting Background to zero keeps the elements visible; setting Elements to zero
keeps the background visible. Settings editing controls stay readable so these
choices can be reversed. High Contrast keeps backgrounds and elements opaque.

Classic starts at 100% background opacity, including the rendered card rather
than an additional hidden alpha reduction. Existing saved opacity choices are
preserved. Spirit, Grace and Courage keep their authored starting values.

## Geometry and motion

**Corner shape** offers Sharp, Rounded and Pill. **Corner radius** accepts
0–32 px; zero is an explicit sharp value. **Border thickness** accepts 0–4 px;
zero removes decorative borders while keyboard focus remains visible. Border
color and opacity are independent. Bar shape may inherit the shared corner
treatment or use a specific sharp, rounded or pill treatment. Circular artwork
such as celestial bodies and status dots keeps its functional shape.

If an inside progress caption cannot fit the chosen track height and text size,
the renderer places it below the track to preserve readability. The requested
inside-label setting is retained in saved and exported data.

Motion has Off, Subtle, Standard and Expressive levels. Speed, ambient effects
and event emphasis are independent controls. Respect system reduced motion is
enabled by default: a system request disables decorative animation regardless
of the chosen level. Turn that option off only to use the explicit app level.
Off disables motion within the selected scope. An explicit widget motion level
overrides its global default; reset that field to inherit or select Off for
that widget to disable it throughout. Timing and progress data continue to update.

High Contrast forces readable opaque palette colors. It does not erase saved
opacity preferences; they are restored when selecting another palette.

## Export envelope

Export writes a UTF-8 JSON file through the native save dialog. It contains one
named appearance, not account credentials, layout, saved positions, timers,
game file paths or unrelated application settings.

```json
{
  "format": "overkot-appearance",
  "version": 1,
  "name": "Quiet square",
  "metadata": {
    "application": "Overkot",
    "createdAt": "2026-11-17T12:00:00.000Z"
  },
  "appearance": {
    "version": 1,
    "base": "dark-mint",
    "global": {
      "cornerShape": "sharp",
      "cornerRadius": 0,
      "borderWidth": 0,
      "borderColor": "#8bbda5",
      "borderOpacity": 80,
      "barShape": "inherit",
      "motionLevel": "subtle",
      "ambientMotion": false,
      "eventEmphasis": true,
      "respectReducedMotion": true
    },
    "widgets": {
      "clock": {
        "cornerShape": "rounded",
        "cornerRadius": 12,
        "borderWidth": 1
      }
    }
  }
}
```

Base palette IDs are `classic`, `dark-mint`, `midnight`, `ember` and
`high-contrast`. Built-in styles such as Spirit and Grace are editor
starting points that export their underlying palette and explicit values.

The shared allowlist in `src/modules/appearance.js` is authoritative. Its
`fields` descriptors define labels, types, defaults, choices and numeric bounds
for colors, opacity, typography, spacing, corners, borders, dock, progress,
effects and motion. Widget keys must come from its `widgetIds` list. Overrides
use the same validation rules as global values.

## Import compatibility

Import first validates the entire file and displays its name, palette, counts
of global values and overridden widgets, motion level and compatibility notes.
Previewing an import stages it in the editor and adds its validated name to the
draft preset library. An exact existing name-and-appearance match is reused.
**Apply** saves both the imported appearance and named library entry; **Cancel**
discards the draft import. The 50-preset library limit is checked before staging.
Canceling the chooser, dismissing the import summary or importing an invalid
file leaves the current appearance intact.

- Maximum file size: 256 KiB. The main process checks the file before reading
  and the shared validator also checks the encoded text length.
- Only envelope and appearance version 1 are supported. Unsupported versions,
  malformed JSON, unsupported palettes, invalid types, invalid choices and
  out-of-range numbers produce plain-language errors.
- Missing optional appearance fields inherit defaults or the selected palette.
  Missing required envelope format, version, name or appearance is rejected.
- Unknown file fields, appearance fields, properties and widget IDs are ignored
  with compatibility notes. They are never executed or copied into app config.
- Hex colors must contain six digits. Numbers must be finite JSON numbers and
  booleans must be actual `true` or `false` values.
- Preset names are trimmed, contain 1–64 characters and exclude control
  characters. The local library supports at most 50 presets with unique IDs.
- Metadata is descriptive only. Export generates it anew; it has no effect on
  appearance, paths or application behavior.

Exporting then importing a valid preset preserves its appearance data,
including explicit zero radii and border widths, widget overrides and motion.
No imported content is interpreted as CSS, HTML, JavaScript or a file path.

## Maintenance

Keep the schema, renderer token resolver and main-process appearance session in
sync. Main broadcasts effective appearance to every local frame during preview
and restores saved appearance on cancellation or owner-window destruction.
Apply patches only appearance fields and the custom-preset library onto the
latest configuration so concurrent changes in other windows are preserved.
