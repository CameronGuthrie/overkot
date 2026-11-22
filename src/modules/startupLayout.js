'use strict';

// Set this to the agreed preset before enabling the first-open layout prompt.
// Shape: { id, description, config: { layoutMode, widgetVisibility, gridLayout } }.
const DEFAULT_LAYOUT = null;

/** A named startup choice is explicit; otherwise keep the persisted space. */
async function restoreStartupSavedLayout({ config, onApply }) {
  const id = config.get('startupLayoutId', null);
  if (id === null || id === undefined) return 'last-used';
  const Layouts = require('./layouts'), library = config.get('savedLayouts', []);
  const entry = typeof id === 'string' && Array.isArray(library)
    ? library.slice(0, Layouts.MAX_LAYOUTS).find(layout => layout?.id === id) : null;
  let saved;
  try { saved = entry ? Layouts.normalizeSavedLayouts([entry], { strict: true })[0] : null; }
  catch { return 'missing'; }
  if (!saved) return 'missing';
  try {
    const result = await onApply(saved.layout);
    return result === false || result?.ok === false ? 'failed' : 'restored';
  } catch { return 'failed'; }
}

function hasLayout(config) {
  const saved = config.getAll();
  return ['widgetVisibility', 'moduleVisibility', 'layoutMode', 'gridLayout', 'widgetLayout']
    .some(key => Object.hasOwn(saved, key)) || Object.keys(saved).some(key => key.startsWith('widgetBounds_'));
}

async function offerStartupLayout({ config, dialog, preset = DEFAULT_LAYOUT, onApply, onCustomize, translations = {} }) {
  if (!preset) return 'unconfigured';
  if (config.get('startupLayoutChoice') || (!config.isFirstRun && !config.get('startupLayoutPending', false)) || hasLayout(config)) return 'skipped';
  if (!preset.id || !preset.description || !preset.config?.widgetVisibility ||
      !Object.values(preset.config.widgetVisibility).some(value => value === true)) return 'unconfigured';
  const tr = (key, fallback) => translations[key] || fallback;
  // Keep the choice available on a later launch if the dialog is dismissed.
  config.set('startupLayoutPending', true);
  const { response } = await dialog.showMessageBox({
    type: 'question', title: 'Overkot',
    message: tr('startupLayoutTitle', 'Would you like to use the default layout?'),
    detail: `${preset.description}\n\n${tr('startupLayoutDetail', 'You can change your widgets and layout in Settings at any time.')}`,
    buttons: [tr('startupLayoutUse', 'Use default layout'), tr('startupLayoutChoose', 'Choose my widgets'), tr('startupLayoutLater', 'Not now')],
    defaultId: 0, cancelId: 2, noLink: true,
  });
  // A layout selected while the prompt was open takes precedence.
  if (hasLayout(config) || config.get('startupLayoutChoice')) return 'skipped';
  if (response === 0) {
    config.setMany({ ...structuredClone(preset.config), startupLayoutPending: false, startupLayoutChoice: preset.id });
    onApply();
    return 'applied';
  }
  if (response === 1) {
    config.setMany({ startupLayoutPending: false, startupLayoutChoice: 'custom' });
    onCustomize();
    return 'custom';
  }
  return 'deferred';
}

module.exports = { DEFAULT_LAYOUT, offerStartupLayout, restoreStartupSavedLayout };
