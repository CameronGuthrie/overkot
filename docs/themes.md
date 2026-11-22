# Appearance

Open Settings → **Appearance** for live preview, global defaults, per-widget overrides and a saved preset library. **Apply** persists appearance and **Cancel** restores the prior style. Existing palette and opacity selections are migrated without losing explicit zero values.

Start with **Classic**, **Spirit**, **Grace**, **Courage** or **High Contrast**. Spirit uses quiet rounded panels, Grace demonstrates square geometry and compact bars, and Courage uses pill controls and warmer event feedback. Base palettes remain Classic, Dark Mint, Midnight, Ember and High Contrast. Colors, independent opacities, fonts, density, icons, bars, effects and motion are editable.

In **Corners & borders**, choose Sharp, Rounded or Pill; set corner radius to 0 for completely sharp corners. Border thickness, color and opacity follow the same global/widget inheritance as other fields. Zero thickness removes decorative borders without removing keyboard focus indicators.

High Contrast uses black surfaces, white text, yellow and cyan accents, and prominent keyboard focus outlines. Its palette colors and background, surface, text and bar opacity controls show the effective fixed values and are disabled while selected. Corners and decorative border controls remain adjustable. Switching to another palette restores editable color and opacity preferences.

Use **Game data → Check for new data** in Settings to check the live feed immediately, download changes to data already in use, and refresh open widgets and maps. The result reports whether data changed, is current, or needs a retry. Cached data remains usable when the feed is unavailable.

Preview changes apply immediately to open local windows and docked widget frames; Apply persists them across restarts. Remote wiki pages keep their own styling. The calendar uses the shared typography and shows its date only in the picker.

In **Motion**, Player and Daily Brief tabs briefly fade their content in and draw an accent under the selected tab. Dock icons respond to hover and presses, and progress bars ease between values. **Event emphasis** adds a short sweep when a timer reaches a milestone, an item is acquired or mastered, or Envoy Rank increases; opening a widget does not replay old achievements. **Ambient animation** is off by default; enable it to see the weather forecast’s sun, clouds, rain and wind move. Set **Motion level** to Expressive for stronger feedback, or Off to stop decorative motion. System reduced motion takes priority while **Respect system reduced motion** is enabled.

The shared schema and palettes live in `src/modules/appearance.js`. `src/renderer/theme.js` resolves them into tokens and `theme.css` keeps widgets and popouts consistent. New local window HTML should load `appearance.js`, `motion.js` and `theme.js` in that order, as well as `theme.css`. Settings save only their own fields, preserving concurrent changes such as calendar ancestor overrides.

See [appearance format and editing behavior](appearance-format.md) for sharing,
validation, inheritance, resets and reduced-motion precedence, and
[visual review](appearance-review.md) for fixture evidence and measurement scope.

The new editor labels currently use English fallback text; existing translated
application labels remain available. Market embeds a separate frontend with
its own appearance controls; the overlay editor does not restyle that frontend.

The native `scripts/check-inventory-widgets.js` check exercises the current Player and Daily Brief panels with an isolated synthetic account. Calendar is now a Daily Brief tab; `check-calendar.js` delegates to the consolidated check.
