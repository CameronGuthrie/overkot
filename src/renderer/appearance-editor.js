/* Schema-driven appearance drafts. General settings keep their existing autosave. */
(function () {
  'use strict';
  const A = window.OverkotAppearance;
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let host, source = {}, draft, saved, library = [], savedLibrary = [];
  let initialized = false, busy = false, scope = '', selectedPreset = '';
  let undo = [], redo = [], previewRevision = 0, previewChain = Promise.resolve();
  let pendingImport = null, message = '', messageError = false;
  const controls = new Map();
  let messages = {};
  let language;
  function tr(key, fallback, values) {
    const text = messages[key] || fallback;
    return values ? text.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token) : text;
  }
  const widgetName = id => tr('appearance.widget.' + id, A.widgetNames[id] || id);
  const sectionNames = {
    corners: ['Corners & borders', 'One shape language, from panels to progress tracks.'],
    colors: ['Palette', 'Set the accents and semantic colours used throughout the overlay.'],
    transparency: ['Opacity', 'Background controls the outer panel; Elements controls text, icons, images and bars. Inner surface controls headers, buttons and cards inside. Choose a widget above for its own values.'],
    typography: ['Typography', 'Comfortable text and stable, easy-to-scan numbers.'],
    geometry: ['Spacing & density', 'Give compact and spacious arrangements their own rhythm.'],
    dock: ['Dock', 'Keep familiar hit areas while adjusting the icons inside.'],
    icons: ['Animated icons', 'Give icons their own palette and movement. Theme follows the current style; Custom sets primary, accent and optional detail colours. Each symbol uses only the colours its natural parts need.'],
    progress: ['Progress bars', 'Tune tracks, fills, labels and milestone emphasis.'],
    effects: ['Surface effects', 'Static shadows and restrained glow; no continuous blur.'],
    motion: ['Motion', 'Tabs fade into view and the dock responds to hover and presses. Event emphasis highlights timer milestones, new collection items and rank increases. Ambient animation adds movement to the weather forecast.'],
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const $ = id => document.getElementById(id);
  const button = (id, label, action, className = '') => {
    const node = el('button', 'settings-button ' + className, label);
    node.type = 'button'; if (id) node.id = id;
    node.addEventListener('click', action);
    return node;
  };
  const snapshot = () => ({ appearance: clone(draft), presets: clone(library), selectedPreset });
  const newPreset = (name, appearance) => ({ id: 'style-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36)), name, appearance: clone(appearance) });
  const dirty = () => initialized && (!same(draft, saved) || !same(library, savedLibrary));
  const contrastLocked = (key, field) => draft?.base === 'high-contrast' &&
    (field.type === 'color' || ['backgroundOpacity', 'elementOpacity', 'surfaceOpacity', 'textOpacity', 'barOpacity'].includes(key));
  function target() {
    return scope ? (draft.widgets[scope] ||= {}) : draft.global;
  }
  function notify(text, error = false) { message = text; messageError = error; renderStatus(); }
  function mutate(change) {
    if (!initialized || busy) return;
    const before = snapshot();
    change();
    draft = A.normalize(draft);
    if (same(before, snapshot())) return;
    undo.push(before); if (undo.length > 80) undo.shift(); redo = [];
    message = ''; messageError = false;
    render(); schedulePreview();
  }
  function restore(state) {
    draft = clone(state.appearance); library = clone(state.presets); selectedPreset = state.selectedPreset;
    message = ''; render(); schedulePreview();
  }
  function schedulePreview() {
    const revision = ++previewRevision;
    // Paint immediately with the same renderer tokens used by real widget windows.
    window.OverkotTheme.apply({ ...source, appearance: draft });
    renderPreview();
    previewChain = previewChain.catch(() => {}).then(async () => {
      if (revision !== previewRevision) return;
      try {
        const result = await window.api.appearancePreview(clone(draft));
        if (result?.ok === false) throw new Error(result.message || tr('appearancePreviewCouldNotBeShown', 'Preview could not be shown.'));
      } catch (error) {
        if (revision === previewRevision) notify(error.message || tr('appearancePreviewIsUnavailableYourSavedAppearanceIs', 'Preview is unavailable. Your saved appearance is unchanged.'), true);
      }
    });
  }
  async function apply() {
    if (!dirty() || busy) return;
    busy = true; renderStatus();
    try {
      await previewChain;
      const result = await window.api.appearanceApply({ appearance: clone(draft), presets: clone(library) });
      if (result?.ok === false || result === false) throw new Error(result?.message || tr('appearanceCouldNotSaveAppearanceTryAgain', 'Could not save appearance. Try again.'));
      draft = A.normalize(result?.appearance || draft);
      library = A.normalizePresets(result?.presets || library);
      saved = clone(draft); savedLibrary = clone(library);
      source = { ...source, appearance: saved, appearancePresets: savedLibrary };
      undo = []; redo = [];
      notify(tr('appearanceAppearanceApplied', 'Appearance applied.'));
    } catch (error) { notify(error.message, true); }
    finally { busy = false; render(); }
  }
  async function cancel() {
    if (busy || !initialized) return;
    busy = true; ++previewRevision; renderStatus();
    try {
      await previewChain;
      const result = await window.api.appearanceCancel();
      if (result?.ok === false) throw new Error(result.message || tr('appearanceCouldNotRestoreAppearance', 'Could not restore appearance.'));
      draft = clone(saved); library = clone(savedLibrary); undo = []; redo = []; pendingImport = null;
      if (!library.some(p => p.id === selectedPreset)) selectedPreset = '';
      $('appearance-name').value = library.find(p => p.id === selectedPreset)?.name || '';
      window.OverkotTheme.apply({ ...source, appearance: draft });
      notify(tr('appearanceDraftDiscardedSavedAppearanceRestored', 'Draft discarded. Saved appearance restored.'));
    } catch (error) { notify(error.message, true); }
    finally { busy = false; render(); }
  }
  function makeSelect(id, options, onChange) {
    const node = el('select', 'custom-select'); node.id = id;
    for (const option of options) {
      const item = el('option', '', option.label); item.value = option.value; node.append(item);
    }
    node.addEventListener('change', onChange); return node;
  }
  function build() {
    host = $('appearance-editor'); if (!host || !A) return;
    host.innerHTML = `
      <div class="appearance-toolbar">
        <span class="appearance-eyebrow" data-label="appearanceLiveCustomization">LIVE CUSTOMIZATION</span>
        <div class="appearance-history"></div>
      </div>
      <section class="appearance-stage" aria-label="Live appearance preview" data-aria-label="appearanceLiveAppearancePreview">
        <div class="appearance-stage-heading"><span data-label="appearanceLivePreview">Live preview</span><span id="appearance-preview-caption" data-label="appearanceGlobalDefaults">Global defaults</span></div>
        <div class="appearance-preview-surface" data-scene="forest">
          <div class="appearance-preview-rail" aria-hidden="true"></div>
          <div id="appearance-preview-card" class="timer-widget" data-widget="boss" data-appearance-preview>
            <div class="widget-body">
              <div class="appearance-sample-title"><span class="appearance-sample-icon"></span><strong data-label="appearanceKearnholdSiege">Kearnhold siege</strong><span class="appearance-state-badge" data-label="appearanceActive">Active</span></div>
              <div class="timer-entry"><div class="timer-header"><span class="timer-name" data-label="appearanceTheTormentStag">The Torment Stag</span><span class="timer-countdown">00:04:08</span></div>
                <div class="timer-bar"><div class="timer-bar-fill"></div><span class="timer-bar-text">68%</span></div></div>
              <div class="appearance-sample-meta"><span id="appearance-sample-status" data-label="appearanceNextEncounter">Next encounter</span><span data-label="appearance4ActiveTimers">4 active timers</span></div>
            </div>
          </div>
        </div>
        <div class="appearance-preview-actions" aria-label="Preview actions" data-aria-label="appearancePreviewActions"></div>
      </section>
      <section class="appearance-presets" aria-label="Built-in appearance presets" data-aria-label="appearanceBuiltInAppearancePresets">
        <div class="appearance-section-title"><h2 data-label="appearanceStartWithAStyle">Start with a style</h2><span data-label="appearanceChangesPreviewBeforeYouApply">Changes preview before you apply</span></div>
        <div class="appearance-preset-grid"></div>
      </section>
      <section class="settings-section appearance-library" aria-label="Your appearance presets" data-aria-label="appearanceYourAppearancePresets">
        <div class="appearance-section-title"><h2 data-label="appearanceYourPresets">Your presets</h2><div id="appearance-file-actions"></div></div>
        <div class="appearance-library-row"><label class="sr-only" for="appearance-preset" data-label="appearanceSavedPreset">Saved preset</label><select id="appearance-preset" class="custom-select"></select><input id="appearance-name" class="settings-input" type="text" maxlength="64" placeholder="Give this style a name" data-placeholder="appearanceGiveThisStyleAName" aria-label="Preset name" data-aria-label="appearancePresetName"></div>
        <div class="appearance-library-actions"></div>
        <p class="settings-hint" data-label="appearancePresetLibraryChangesAreSavedWithApply">Preset library changes are saved with Apply. Export shares appearance only.</p>
      </section>
      <section id="appearance-import-review" class="settings-section" aria-label="Review imported preset" data-aria-label="appearanceReviewImportedPreset" hidden><h2 id="appearance-import-name"></h2><p id="appearance-import-summary" class="settings-hint"></p><div class="settings-actions"></div></section>
      <div class="appearance-scope-row"><div><label for="appearance-scope" data-label="appearanceEditing">Editing</label><select id="appearance-scope" class="custom-select"></select></div><div id="appearance-scope-actions"></div></div>
      <p id="appearance-inheritance" class="settings-hint"></p>
      <p id="appearance-contrast-note" class="settings-hint" hidden data-label="appearanceHighContrastKeepsBackgroundsAndElementsOpaque">High Contrast keeps backgrounds and elements opaque for readability. Corner shape, decorative border thickness and border opacity remain adjustable.</p>
      <div id="appearance-groups"></div>
      <div class="appearance-commit-bar"><span id="appearance-status" role="status" aria-live="polite"></span><div></div></div>`;
    for (const node of host.querySelectorAll('[data-label]')) node.textContent = tr(node.dataset.label, node.textContent);
    for (const attribute of ['aria-label', 'placeholder']) {
      for (const node of host.querySelectorAll('[data-' + attribute + ']')) {
        node.setAttribute(attribute, tr(node.getAttribute('data-' + attribute), node.getAttribute(attribute)));
      }
    }
    host.querySelector('.appearance-history').append(
      button('appearance-undo', tr('appearanceUndo', 'Undo'), () => { if (undo.length) { redo.push(snapshot()); restore(undo.pop()); } }),
      button('appearance-redo', tr('appearanceRedo', 'Redo'), () => { if (redo.length) { undo.push(snapshot()); restore(redo.pop()); } })
    );
    const shortcuts = el('nav', 'appearance-shortcuts');
    shortcuts.setAttribute('aria-label', tr('appearanceAppearanceSections', 'Appearance sections'));
    for (const [section, name] of [['corners', 'Corners & borders'], ['transparency', 'Opacity'], ['typography', 'Typography'], ['icons', 'Animated icons'], ['motion', 'Motion']]) {
      shortcuts.append(button('', tr('appearance.section.' + section, name), () => {
        const group = host.querySelector(`[data-section="${section}"]`);
        group.open = true; group.scrollIntoView({ block: 'start', behavior: 'instant' }); group.querySelector('summary').focus();
      }));
    }
    host.querySelector('.appearance-toolbar').after(shortcuts);
    const card = $('appearance-preview-card');
    card.querySelector('.appearance-sample-icon').append(window.WidgetIcons.create('boss'));
    for (const id of ['boss', 'player', 'crafting', 'clock']) {
      const icon = el('span', 'appearance-dock-icon');
      icon.append(window.WidgetIcons.create(id)); host.querySelector('.appearance-preview-rail').append(icon);
    }
    host.querySelector('.appearance-preview-actions').append(
      button('appearance-preview-hover', tr('appearanceHover', 'Hover'), () => card.classList.toggle('appearance-demo-hover')),
      button('appearance-preview-loading', tr('appearanceLoading', 'Loading'), () => { card.classList.toggle('appearance-demo-loading'); $('appearance-sample-status').textContent = card.classList.contains('appearance-demo-loading') ? tr('appearanceReconnecting', 'Reconnecting…') : tr('appearanceNextEncounter', 'Next encounter'); }),
      button('appearance-preview-progress', tr('appearanceProgress', 'Progress'), () => sampleProgress(false)),
      button('appearance-preview-complete', tr('appearanceComplete', 'Complete'), () => sampleProgress(true)),
      button('appearance-preview-scene', tr('appearanceBackdrop', 'Backdrop'), () => { const surface = host.querySelector('.appearance-preview-surface'); surface.dataset.scene = surface.dataset.scene === 'forest' ? 'bright' : surface.dataset.scene === 'bright' ? 'dark' : 'forest'; })
    );
    for (const [id, builtin] of Object.entries(A.builtins)) {
      const node = button('', '', () => mutate(() => { draft = clone(builtin.appearance); selectedPreset = ''; }), 'appearance-preset-card');
      node.dataset.builtin = id;
      node.append(el('strong', '', tr('appearance.preset.' + id, builtin.name)), el('span', '', tr('appearance.preset.' + id + '.hint', builtin.description)));
      host.querySelector('.appearance-preset-grid').append(node);
    }
    $('appearance-file-actions').append(button('appearance-import', tr('appearanceImport', 'Import…'), importPreset), button('appearance-export', tr('appearanceExport', 'Export…'), exportPreset));
    $('appearance-preset').addEventListener('change', () => {
      const chosen = library.find(p => p.id === $('appearance-preset').value);
      if (chosen) mutate(() => { selectedPreset = chosen.id; draft = clone(chosen.appearance); $('appearance-name').value = chosen.name; });
    });
    host.querySelector('.appearance-library-actions').append(
      button('appearance-save-preset', tr('appearanceSaveAsNew', 'Save as new'), () => savePreset('new')),
      button('appearance-duplicate-preset', tr('appearanceDuplicate', 'Duplicate'), () => savePreset('duplicate')),
      button('appearance-rename-preset', tr('appearanceRename', 'Rename'), () => savePreset('rename')),
      button('appearance-delete-preset', tr('appearanceDelete', 'Delete'), () => mutate(() => { library = library.filter(p => p.id !== selectedPreset); selectedPreset = ''; }))
    );
    const scopeSelect = $('appearance-scope');
    for (const [value, label] of [['', tr('appearanceGlobalDefaults', 'Global defaults')], ...A.widgetIds.map(id => [id, widgetName(id)])]) {
      const option = el('option', '', label); option.value = value; scopeSelect.append(option);
    }
    scopeSelect.addEventListener('change', () => { scope = scopeSelect.value; render(); });
    $('appearance-scope-actions').append(button('appearance-reset-scope', tr('appearanceResetScope', 'Reset scope'), () => mutate(() => {
      if (scope) delete draft.widgets[scope]; else draft.global = {};
    })));
    const baseGroup = el('div', 'settings-section appearance-base-row');
    const baseLabel = el('label', '', tr('appearanceBasePalette', 'Base palette')); baseLabel.htmlFor = 'appearance-base';
    baseGroup.append(baseLabel, makeSelect('appearance-base', Object.entries(A.palettes).map(([value, p]) => ({value, label: tr('appearance.palette.' + value, p.name)})), () => mutate(() => { draft.base = $('appearance-base').value; })));
    $('appearance-groups').append(baseGroup);
    for (const [section, [title, description]] of Object.entries(sectionNames)) {
      const details = el('details', 'settings-section appearance-group'); details.dataset.section = section;
      details.open = section === 'corners' || section === 'icons' || section === 'motion';
      const summary = el('summary'); summary.append(el('strong', '', tr('appearance.section.' + section, title)), el('span', 'appearance-section-count'));
      const inner = el('div', 'appearance-group-content');
      inner.append(el('p', 'settings-hint', tr('appearance.section.' + section + '.hint', description)));
      const reset = button('', tr('appearanceResetSection', 'Reset section'), () => mutate(() => {
        for (const [key, field] of Object.entries(A.fields)) if (field.section === section) delete target()[key];
      }), 'appearance-section-reset'); reset.dataset.resetSection = section;
      inner.append(reset);
      for (const [key, field] of Object.entries(A.fields)) if (field.section === section) inner.append(makeField(key, field));
      if (section === 'icons') {
        const preview = el('div', 'appearance-icon-preview'); preview.id = 'appearance-icon-preview';
        preview.setAttribute('aria-label', tr('appearanceAnimatedIconColourPreview', 'Animated icon colour preview'));
        for (const [id, label] of [['clock', tr('appearanceClock', 'Clock')], ['crafting', tr('appearanceCrafting', 'Crafting')], ['weather', tr('appearanceWeather', 'Weather')], ['collection-log', tr('appearanceCollection', 'Collection')], ['wolf-training', tr('appearanceTraining', 'Training')], ['minimap', tr('appearanceMap', 'Map')]]) {
          const item = el('div', 'appearance-icon-demo');
          item.append(window.WidgetIcons.create(id), el('span', '', label));
          preview.append(item);
        }
        const legend = el('div', 'appearance-icon-legend');
        for (const [channel, label] of [['primary', tr('appearancePrimary', 'Primary')], ['secondary', tr('appearanceAccent', 'Accent')], ['detail', tr('appearanceDetail', 'Detail')]]) {
          const item = el('span', '', label); item.dataset.iconChannel = channel; legend.append(item);
        }
        inner.append(preview, legend, el('p', 'settings-hint', tr('appearanceSimpleSymbolsUseOneColourNaturalAccents', 'Simple symbols use one colour; natural accents use a second, and details such as rain can use a third. This preview plays continuously; live icons follow Hover, Loop or Off. Motion Off and system reduced motion stop decorative animation. Apply saves these choices with your style.')));
      }
      if (section === 'progress') inner.append(el('p', 'settings-hint', tr('appearanceInsideLabelsMoveBelowTracksThatAre', 'Inside labels move below tracks that are too thin for the selected text size.')));
      if (section === 'motion') inner.append(el('p', 'settings-hint', tr('appearanceSystemReducedMotionTakesPriorityWhileRespect', 'System reduced motion takes priority while “Respect reduced motion” is on. Off stops all decorative animation; values still update.')));
      details.append(summary, inner); $('appearance-groups').append(details);
    }
    const commitActions = host.querySelector('.appearance-commit-bar > div');
    commitActions.append(button('appearance-reset-all', tr('appearanceResetAll', 'Reset all'), () => mutate(() => { draft = { version: 1, base: 'classic', global: {}, widgets: {} }; selectedPreset = ''; })), button('appearance-cancel', tr('appearanceCancel', 'Cancel'), cancel), button('appearance-apply', tr('appearanceApply', 'Apply'), apply, 'appearance-primary'));
    $('appearance-import-review').querySelector('.settings-actions').append(button('appearance-import-preview', tr('appearancePreviewThisPreset', 'Preview this preset'), () => {
      if (!pendingImport) return;
      const imported = pendingImport;
      const existing = library.find(p => p.name === imported.preset.name && same(p.appearance, imported.preset.appearance));
      if (!existing && library.length >= A.MAX_PRESETS) { notify(tr('appearanceLibraryFull', 'The library holds up to {max} styles. Delete a style to make room for another.', { max: A.MAX_PRESETS }), true); return; }
      mutate(() => {
        draft = clone(imported.preset.appearance);
        const preset = existing || newPreset(imported.preset.name, draft);
        if (!existing) library.push(preset);
        selectedPreset = preset.id; $('appearance-name').value = preset.name;
      });
      pendingImport = null; render(); notify(tr('appearanceImportedStyleIsPreviewingApplyToSave', 'Imported style is previewing. Apply to save, or Cancel to restore.'));
    }), button('appearance-import-cancel', tr('appearanceDismiss', 'Dismiss'), () => { pendingImport = null; render(); }));
  }
  document.addEventListener('keydown', event => {
    if (!host || $('panel-appearance').hidden || !event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA)$/.test(event.target.tagName) && event.target.type !== 'range') return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); $(event.shiftKey ? 'appearance-redo' : 'appearance-undo').click(); }
    else if (event.key.toLowerCase() === 'y') { event.preventDefault(); $('appearance-redo').click(); }
  });
  function makeField(key, field) {
    const row = el('div', 'appearance-field'); row.dataset.field = key;
    const label = el('label', '', tr('appearance.field.' + key, field.label)); label.htmlFor = 'appearance-' + key;
    const content = el('div', 'appearance-field-control'); let input;
    if (field.type === 'select') {
      input = makeSelect('appearance-' + key, field.options.map(option => ({ ...option, label: tr('appearance.option.' + option.value, option.label) })), () => mutate(() => { target()[key] = input.value; }));
    } else {
      input = el('input'); input.id = 'appearance-' + key;
      input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'range' : 'color';
      if (field.type === 'number') { input.min = field.min; input.max = field.max; input.step = field.step ?? 1; }
      input.addEventListener(field.type === 'boolean' ? 'change' : 'input', () => mutate(() => {
        target()[key] = field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value;
      }));
    }
    const output = el('output'); output.htmlFor = input.id;
    const origin = el('span', 'appearance-origin');
    const reset = button('', '↶', () => mutate(() => { delete target()[key]; }), 'appearance-field-reset');
    reset.dataset.resetField = key; reset.title = tr('appearanceResetField', 'Return {label} to its inherited value', { label: label.textContent }); reset.setAttribute('aria-label', reset.title);
    controls.set(key, { row, input, output, origin, reset, field });
    content.append(input, output); row.append(label, content, origin, reset); return row;
  }
  function render() {
    if (!host || !initialized) return;
    const values = A.resolve({ ...source, appearance: draft }, scope || undefined);
    // The editing controls stay legible even when the overlay text is transparent.
    const chrome = A.resolve({ ...source, appearance: draft });
    if (draft.base === 'high-contrast') {
      const palette = A.palettes['high-contrast'];
      Object.assign(chrome, {textColor: palette.text, mutedColor: palette.muted, accentColor: palette.accent, surfaceColor: palette.panel});
      Object.assign(values, {backgroundColor: palette.base, surfaceColor: palette.panel, elevatedColor: palette.surface,
        headerColor: palette.header, textColor: palette.text, mutedColor: palette.muted, accentColor: palette.accent,
        secondaryColor: palette.secondary, borderColor: '#ffffff', progressColor: palette.accent, trackColor: palette.surface,
        successColor: '#adffbd', warningColor: '#ffff00', dangerColor: '#ffb5a9', infoColor: palette.blue,
        iconPrimaryColor: palette.text, iconSecondaryColor: palette.accent, iconDetailColor: palette.secondary,
        backgroundOpacity: 100, elementOpacity: 100, surfaceOpacity: 100, textOpacity: 100, barOpacity: 100});
    }
    for (const [key, value] of Object.entries({ '--settings-text': chrome.textColor, '--settings-muted': chrome.mutedColor,
      '--settings-accent': chrome.accentColor })) document.documentElement.style.setProperty(key, value);
    for (const [key, value] of Object.entries({ '--text-primary': chrome.textColor, '--text-secondary': chrome.mutedColor,
      '--text-muted': chrome.mutedColor, '--theme-accent': chrome.accentColor, '--bg-panel': chrome.surfaceColor })) host.style.setProperty(key, value);
    const overrides = scope ? draft.widgets[scope] || {} : draft.global;
    for (const [key, control] of controls) {
      const { input, output, origin, reset, field } = control;
      const value = values[key];
      if (field.type === 'boolean') input.checked = value; else input.value = value;
      output.textContent = field.type === 'number' ? String(value) + (field.unit || '') : field.type === 'color' ? String(value).toUpperCase() : '';
      const custom = Object.hasOwn(overrides, key);
      origin.textContent = contrastLocked(key, field) ? tr('appearanceContrast', 'Contrast') : custom ? tr('appearanceOverride', 'Override') : scope ? tr('appearanceGlobal', 'Global') : tr('appearanceBase', 'Base');
      origin.dataset.custom = String(custom); reset.disabled = !custom || busy;
      input.disabled = busy || contrastLocked(key, field) || (!!scope && field.section === 'dock')
        || (['iconPrimaryColor', 'iconSecondaryColor', 'iconDetailColor'].includes(key) && values.iconPalette !== 'custom');
      control.row.hidden = !!scope && field.section === 'dock';
    }
    $('appearance-base').value = draft.base;
    $('appearance-base').disabled = busy || !!scope;
    $('appearance-contrast-note').hidden = draft.base !== 'high-contrast';
    $('appearance-scope').value = scope;
    $('appearance-inheritance').textContent = scope
      ? tr('appearanceScopeHint', '{widget} inherits global defaults. Editing a value creates an override. Select ↶ to use the global value again.', { widget: widgetName(scope) })
      : tr('appearanceBasePaletteGlobalDefaultsWidgetOverridesReturns', 'Base palette → global defaults → widget overrides. ↶ returns a value to its base. Circular clock faces and status dots keep their shape.');
    for (const node of host.querySelectorAll('.appearance-group')) {
      const keys = Object.keys(A.fields).filter(k => A.fields[k].section === node.dataset.section);
      const count = keys.filter(k => Object.hasOwn(overrides, k)).length;
      node.querySelector('.appearance-section-count').textContent = count ? tr('appearanceCustomCount', '{count} custom', { count }) : scope ? tr('appearanceInherited', 'Inherited') : tr('appearanceBase', 'Base');
      node.hidden = !!scope && node.dataset.section === 'dock';
    }
    for (const node of host.querySelectorAll('[data-builtin]')) node.setAttribute('aria-pressed', String(same(draft, A.builtins[node.dataset.builtin].appearance)));
    const select = $('appearance-preset');
    const options = [['', library.length ? tr('appearanceChooseASavedStyle', 'Choose a saved style…') : tr('appearanceNoSavedStylesYet', 'No saved styles yet')], ...library.map(p => [p.id, p.name])];
    if (!same([...select.options].map(o => [o.value, o.textContent]), options)) {
      select.replaceChildren(...options.map(([value, name]) => { const option = el('option', '', name); option.value = value; return option; }));
    }
    select.value = selectedPreset;
    $('appearance-import-review').hidden = !pendingImport;
    if (pendingImport) {
      $('appearance-import-name').textContent = pendingImport.preset.name;
      const summary = pendingImport.summary || {};
      const appearance = pendingImport.preset.appearance;
      const motion = summary.motionLevel || A.resolve({ appearance }).motionLevel;
      const description = tr('appearanceImportSummary', '{palette} · {global} global values · {widgets} widget overrides · {motion} motion.', {
        palette: tr('appearance.palette.' + appearance.base, A.palettes[appearance.base]?.name || appearance.base),
        global: summary.globalCount ?? Object.keys(appearance.global).length,
        widgets: summary.widgetCount ?? Object.keys(appearance.widgets).length,
        motion: tr('appearance.option.' + motion, motion)
      });
      $('appearance-import-summary').textContent = [description, ...(pendingImport.warnings || []), tr('appearanceImportPreviewHint', 'Preview does not save changes.')].join(' ');
    }
    renderStatus(); renderPreview();
  }
  function renderStatus() {
    if (!host) return;
    const changed = dirty();
    $('appearance-status').textContent = message || (busy ? tr('appearanceUpdatingAppearance', 'Updating appearance…') : changed ? tr('appearanceUnsavedAppearancePreviewingAcrossWindows', 'Unsaved appearance · previewing across windows') : tr('appearanceSavedAppearanceLivePreviewReady', 'Saved appearance · live preview ready'));
    $('appearance-status').dataset.error = String(messageError);
    $('appearance-apply').disabled = busy || !changed;
    $('appearance-cancel').disabled = busy || !changed;
    $('appearance-undo').disabled = busy || undo.length === 0;
    $('appearance-redo').disabled = busy || redo.length === 0;
    const selectedExists = library.some(p => p.id === selectedPreset);
    $('appearance-rename-preset').disabled = busy || !selectedExists;
    $('appearance-delete-preset').disabled = busy || !selectedExists;
    for (const node of host.querySelectorAll('button:not(#appearance-apply):not(#appearance-cancel):not(#appearance-undo):not(#appearance-redo):not(#appearance-rename-preset):not(#appearance-delete-preset):not([data-reset-field])')) node.disabled = busy || !initialized;
    host.setAttribute('aria-busy', String(busy));
    const values = A.resolve({ ...source, appearance: draft }, scope || undefined);
    for (const [key, { input, field }] of controls) input.disabled = busy || !initialized || contrastLocked(key, field) || (!!scope && field.section === 'dock')
      || (['iconPrimaryColor', 'iconSecondaryColor', 'iconDetailColor'].includes(key) && values.iconPalette !== 'custom');
    for (const id of ['appearance-base', 'appearance-scope', 'appearance-preset', 'appearance-name']) if ($(id)) $(id).disabled = busy || !initialized || (id === 'appearance-base' && !!scope);
  }
  function renderPreview() {
    if (!draft || !host) return;
    const card = $('appearance-preview-card'); const widget = scope || undefined;
    card.dataset.widget = scope || 'appearance-preview';
    window.OverkotTheme.apply({ ...source, appearance: draft }, { root: card, widgetId: widget });
    $('appearance-preview-caption').textContent = scope ? widgetName(scope) : tr('appearanceGlobalDefaults', 'Global defaults');
    const rail = host.querySelector('.appearance-preview-rail');
    for (const [key, value] of Object.entries(window.OverkotTheme.variables({ ...source, appearance: draft }))) rail.style.setProperty(key, value);
    const icons = $('appearance-icon-preview');
    if (icons) {
      const values = window.OverkotTheme.apply({ ...source, appearance: draft }, { root: icons, widgetId: widget });
      icons.dataset.iconMotion = values.iconMotion === 'off' ? 'off' : 'loop';
      const legend = host.querySelector('.appearance-icon-legend');
      for (const [key, value] of Object.entries(window.OverkotTheme.variables({ ...source, appearance: draft }, widget))) legend.style.setProperty(key, value);
    }
  }
  function sampleProgress(complete) {
    const card = $('appearance-preview-card'); card.classList.remove('appearance-demo-loading');
    const value = complete ? 100 : card.dataset.progress === '84' ? 48 : 84;
    card.dataset.progress = String(value); card.querySelector('.timer-bar-fill').style.width = value + '%';
    card.querySelector('.timer-bar-text').textContent = value + '%';
    card.querySelector('.timer-countdown').textContent = complete ? tr('appearanceReady', 'Ready') : '00:02:16';
    card.querySelector('.appearance-state-badge').textContent = complete ? tr('appearanceComplete', 'Complete') : tr('appearanceActive', 'Active');
    $('appearance-sample-status').textContent = complete ? tr('appearanceEncounterAvailable', 'Encounter available') : tr('appearanceNextEncounter', 'Next encounter');
    window.OverkotMotion?.emphasize(card, complete ? 'complete' : 'progress', 'preview:' + Date.now());
  }
  function savePreset(mode) {
    const chosen = library.find(p => p.id === selectedPreset);
    let name = $('appearance-name').value.trim();
    if (mode === 'duplicate') {
      const template = tr('appearanceDuplicateName', '{name} copy');
      const available = Math.max(0, 64 - template.replace('{name}', '').length);
      const original = name || chosen?.name || tr('appearanceMyStyle', 'My style');
      name = template.replace('{name}', () => original.slice(0, available).replace(/[\uD800-\uDBFF]$/, ''));
    }
    try { name = A.presetName(name); }
    catch { notify(tr('appearanceInvalidName', 'Give the preset a name between 1 and 64 characters.'), true); $('appearance-name').focus(); return; }
    if (mode === 'rename' && !chosen) return;
    if (mode !== 'rename' && library.length >= A.MAX_PRESETS) { notify(tr('appearanceLibraryFull', 'The library holds up to {max} styles. Delete a style to make room for another.', { max: A.MAX_PRESETS }), true); return; }
    mutate(() => {
      if (mode === 'rename') chosen.name = name;
      else {
        const preset = newPreset(name, draft);
        library.push(preset); selectedPreset = preset.id;
      }
      $('appearance-name').value = name;
    });
  }
  async function importPreset() {
    if (busy) return; busy = true; renderStatus();
    try {
      const result = await window.api.appearanceImport();
      if (result?.canceled) return;
      if (!result?.ok || !result.preset) throw new Error(result?.message || tr('appearanceThisFileCouldNotBeImported', 'This file could not be imported.'));
      pendingImport = result; notify(tr('appearanceFileValidatedReviewItBelowBeforePreviewing', 'File validated. Review it below before previewing.'));
    } catch (error) { pendingImport = null; notify(error.message, true); }
    finally { busy = false; render(); if (pendingImport) $('appearance-import-review').scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
  }
  async function exportPreset() {
    if (busy) return; busy = true; renderStatus();
    try {
      const result = await window.api.appearanceExport({ name: $('appearance-name').value.trim() || tr('appearanceOverkotStyle', 'Overkot style'), appearance: clone(draft) });
      if (result?.canceled) return;
      if (result?.ok === false) throw new Error(result.message || tr('appearanceThisPresetCouldNotBeExported', 'This preset could not be exported.'));
      notify(tr('appearanceAppearanceExportedNoLayoutAccountDataOr', 'Appearance exported. No layout, account data or personal paths included.'));
    } catch (error) { notify(error.message, true); }
    finally { busy = false; render(); }
  }
  window.OverkotAppearanceEditor = {
    setLanguage(code, catalogue) {
      messages = catalogue;
      if (code === language) return;
      language = code;
      if (!host) return;
      const typedName = $('appearance-name').value;
      const openSections = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.section));
      const focused = host.contains(document.activeElement) && document.activeElement.id;
      message = '';
      controls.clear();
      build();
      $('appearance-name').value = typedName;
      for (const node of host.querySelectorAll('details')) node.open = openSections.has(node.dataset.section);
      render();
      if (focused) $(focused)?.focus();
    },
    receiveConfig(config) {
      source = { ...source, ...config };
      if (!host) build();
      if (!host || !A) return;
      if (!initialized || (!dirty() && !busy)) {
        saved = A.extract(config); draft = clone(saved);
        savedLibrary = clone(config.appearancePresets || []); library = clone(savedLibrary);
        initialized = true;
      }
      render();
    },
  };
})();
