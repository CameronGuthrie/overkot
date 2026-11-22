# Startup layout

Settings > Widgets > Saved layouts has a separate **Startup layout** choice.
The default, **Last used arrangement**, restores the current bar edge, widget
choices, open panels, docking, positions and sizes from the normal configuration.
No named layout is required, and this preserves existing users' arrangements.

Choosing a named layout saves its ID separately from the layout selected for
**Apply**. It does not rearrange the current space. At the next launch, the saved
arrangement is applied before the first native window is created. Deleting that
layout atomically returns startup to **Last used arrangement**. An invalid or
unavailable startup choice preserves the current configuration. Importing or
applying a layout never changes the startup choice implicitly.

Run `node --test test/startupLayout.test.js test/layoutIpc.test.js
test/layoutsSettings.test.js test/config.test.js` for migration, selection and
fallback coverage. Native startup checks use isolated profiles:

```
node scripts/check-settings.js --source --startup-only --startup-layout=current
node scripts/check-settings.js --source --startup-only --startup-layout=named
```

## First-open layout choice

The first-open prompt is wired into startup, but its default preset is deliberately
unset while the layout is being decided. This preview does not show a placeholder
prompt or change existing users' widgets.

To enable it, define `DEFAULT_LAYOUT` in `src/modules/startupLayout.js` with a stable
`id`, a user-facing `description` and `config` containing the chosen `layoutMode`,
`widgetVisibility` and, for a docked layout, `gridLayout.columns`.

New profiles will then see **Use default layout**, **Choose my widgets** and
**Not now**. Accepting applies the preset once; choosing widgets opens the picker;
dismissing defers the choice until another launch. Existing saved layouts are
preserved, including selections made while the prompt is open. The dialog is
independent of overlay click-through and game visibility.

Run `node --test test/startupLayout.test.js test/config.test.js` to check the
disabled, accepted, custom, deferred and existing-profile paths.
