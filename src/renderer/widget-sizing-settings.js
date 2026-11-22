/** Panel dimensions are saved independently of Appearance and ordinary settings. */
(function () {
  'use strict';
  function mount({ api, flushPending = async () => true }) {
    const host = document.getElementById('widget-sizing');
    if (!host) return { receiveConfig() {}, refresh() {}, dispose() {} };
    const $ = id => document.getElementById(id);
    const select = $('widget-size-select'), width = $('widget-size-width'), height = $('widget-size-height');
    const autoWidth = $('widget-size-auto-width'), autoHeight = $('widget-size-auto-height');
    const mode = $('widget-resize-mode'), status = $('widget-size-status');
    const listeners = [];
    let state = { sizes: {}, mode: 'grid', widgets: [] }, currentConfig = {}, selectedId = '';
    let ready = false, busy = false, dirty = false, disposed = false, message = '', error = false, loadFailed = false;
    const tr = (key, fallback, values = {}) => {
      const text = window.i18n?.translations?.[currentConfig.language || 'en']?.[key] || fallback;
      return text.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
    };
    const selected = () => state.widgets.find(widget => widget.id === selectedId);
    const label = id => {
      const fallback = window.OverkotAppearance?.widgetNames?.[id] || id.replaceAll('-', ' ');
      return window.OverkotTutorials ? tr(window.OverkotTutorials.widgetTutorialPrefix(id) + 'Name', fallback) : fallback;
    };
    const on = (node, type, callback) => { node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback)); };
    const notify = (text, failed = false) => { message = text; error = failed; };

    function render() {
      if (disposed) return;
      const widget = selected(), size = state.sizes[selectedId] || {};
      host.setAttribute('aria-busy', String(busy));
      select.disabled = mode.disabled = busy || !ready;
      mode.value = state.mode;
      $('widget-size-apply').disabled = busy || !ready || !widget || !dirty;
      $('widget-size-reset').disabled = busy || !ready || !widget;
      autoWidth.disabled = autoHeight.disabled = busy || !ready || !widget;
      width.disabled = busy || !ready || !widget || autoWidth.checked;
      height.disabled = busy || !ready || !widget || autoHeight.checked;
      $('widget-size-retry').hidden = !loadFailed;
      $('widget-size-retry').disabled = busy;
      status.textContent = message;
      status.dataset.error = String(error);
      if (!widget) return;
      width.min = widget.minWidth;
      height.min = widget.minHeight;
      $('widget-size-height-label').textContent = widget.id === 'minimap' || widget.id.startsWith('data-') ? tr('settingsDefaultHeight', 'Default height') : tr('settingsFitContent', 'Fit content');
      $('widget-size-limits').textContent = tr('settingsMinSize', 'Minimum {width} × {height} px. Enter exact dimensions in 1 px steps.', { width: widget.minWidth, height: widget.minHeight });
      const saved = currentConfig['widgetBounds_' + widget.id];
      const currentWidth = widget.currentWidth || saved?.width || size.width || widget.width;
      const currentHeight = widget.currentHeight || saved?.height || size.height || widget.height;
      $('widget-size-current').textContent = tr('settingsCurrentSize', 'Current size: {width} × {height} px', { width: Math.round(currentWidth), height: Math.round(currentHeight) });
      if (dirty) $('widget-size-current').textContent += ' · ' + tr('settingsUnappliedSize', 'Size changes have not been applied.');
    }

    function populate() {
      select.replaceChildren();
      for (const widget of [...state.widgets].sort((a, b) => label(a.id).localeCompare(label(b.id), undefined, { sensitivity: 'base' }))) {
        const option = document.createElement('option'); option.value = widget.id; option.textContent = label(widget.id); select.append(option);
      }
      if (!selected()) selectedId = select.children[0]?.value || '';
      select.value = selectedId;
    }

    function restoreFields() {
      const widget = selected();
      if (!widget) { render(); return; }
      const size = state.sizes[selectedId] || {};
      autoWidth.checked = size.width == null;
      autoHeight.checked = size.height == null;
      width.value = String(size.width || widget.width);
      height.value = String(size.height || widget.currentHeight || widget.height);
      dirty = false;
      render();
    }

    function accept(result, restore = true) {
      if (!result?.ok) throw new Error(result?.message || tr('settingsWidgetSizeFailed', 'Widget sizes could not be saved. Try again.'));
      state = { sizes: result.sizes || {}, mode: result.mode === 'free' ? 'free' : 'grid',
        widgets: (result.widgets || []).filter(widget => !['daily', 'market'].includes(widget.id)) };
      ready = true; loadFailed = false;
      populate();
      if (restore) restoreFields();
    }

    async function refresh() {
      if (busy || disposed) return;
      busy = true; render();
      try { const result = await api.widgetSizesGet(); if (disposed) return; accept(result); notify(''); }
      catch (failure) { ready = false; loadFailed = true; notify(failure.message || tr('settingsWidgetSizeUnavailable', 'Widget sizes are unavailable. Try again.'), true); }
      finally { busy = false; render(); }
    }

    async function change(method, value, success, restore = true) {
      if (busy || !ready || disposed) return;
      busy = true; render();
      try {
        if (!(await flushPending())) throw new Error(tr('settingsWidgetSizeSavePending', 'Save the pending settings changes before changing widget sizes.'));
        const result = await api[method](value);
        if (disposed) return;
        accept(result, restore);
        notify(success);
      } catch (failure) { notify(failure.message || tr('settingsWidgetSizeFailed', 'Widget sizes could not be saved. Try again.'), true); }
      finally { busy = false; render(); }
    }

    function payload() {
      const widget = selected();
      if (!widget) throw new Error(tr('settingsWidgetSizeChoose', 'Choose a widget to resize.'));
      const axis = (input, auto, minimum, name) => {
        if (auto.checked) return null;
        const value = input.value.trim() === '' ? NaN : Number(input.value);
        if (!Number.isInteger(value) || value < minimum || value > 32768) throw new Error(tr('settingsInvalidSize', '{name} must be a whole number from {minimum} to 32768 px.', { name, minimum }));
        return value;
      };
      return { id: selectedId, width: axis(width, autoWidth, widget.minWidth, tr('settingsWidth', 'Width')), height: axis(height, autoHeight, widget.minHeight, tr('settingsHeight', 'Height')) };
    }
    on(select, 'change', () => { selectedId = select.value; notify(''); restoreFields(); });
    for (const input of [width, height, autoWidth, autoHeight]) on(input, input.type === 'checkbox' ? 'change' : 'input', () => { dirty = true; notify(''); render(); });
    on($('widget-size-form'), 'submit', event => {
      event.preventDefault();
      try { void change('widgetSizesSet', payload(), tr('settingsWidgetSizeSaved', 'Widget size saved.')); }
      catch (failure) { notify(failure.message, true); render(); }
    });
    on($('widget-size-reset'), 'click', () => void change('widgetSizesReset', { id: selectedId }, tr('settingsWidgetSizeReset', 'Widget size reset. Other widgets keep their sizes.')));
    on(mode, 'change', () => void change('widgetSizesMode', mode.value, tr('settingsWidgetResizeSaved', 'Corner resizing preference saved.'), false));
    on($('widget-size-retry'), 'click', () => void refresh());
    void refresh();
    return {
      refresh,
      receiveConfig(config) {
        const languageChanged = config?.language !== currentConfig.language;
        currentConfig = config || {};
        if (languageChanged && ready) populate();
        for (const widget of state.widgets) {
          const bounds = config?.['widgetBounds_' + widget.id];
          if (Number.isFinite(bounds?.width) && bounds.width > 0) widget.currentWidth = bounds.width;
          if (Number.isFinite(bounds?.height) && bounds.height > 0) widget.currentHeight = bounds.height;
        }
        if (config?.widgetSizes) state.sizes = config.widgetSizes;
        if (['grid', 'free'].includes(config?.widgetResizeMode)) state.mode = config.widgetResizeMode;
        if (!dirty && !busy) restoreFields(); else render();
      },
      dispose() { disposed = true; for (const remove of listeners) remove(); },
    };
  }
  window.WidgetSizingSettings = { mount };
})();
