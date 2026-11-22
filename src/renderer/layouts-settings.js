/** Named arrangements are saved separately from ordinary Settings autosave. */
(function () {
  'use strict';

  function mount({ api, flushPending = async () => true }) {
    const host = document.getElementById('saved-layouts');
    if (!host) return { receiveConfig() {}, refresh() {}, dispose() {} };
    const $ = id => document.getElementById(id);
    const select = $('layout-select'), name = $('layout-name'), status = $('layout-status'), startup = $('layout-startup');
    const listeners = [];
    let layouts = [], selectedId = '', startupLayoutId = null, config = {}, busy = false, ready = false, disposed = false;
    let revision = 0, nameDirty = false, confirmingDelete = false, message = '', messageError = false, loadError = false;
    const selected = () => layouts.find(layout => layout.id === selectedId);
    const tr = (key, fallback, values = {}) => {
      let text = window.i18n?.translations?.[config.language || 'en']?.[key]
        || window.i18n?.translations?.en?.[key] || fallback;
      for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, String(value));
      return text;
    };
    const on = (element, event, callback) => {
      element.addEventListener(event, callback);
      listeners.push(() => element.removeEventListener(event, callback));
    };
    const notify = (text, error = false) => { message = text; messageError = error; };
    const buttonIds = ['layout-save', 'layout-apply', 'layout-update', 'layout-rename', 'layout-delete',
      'layout-import', 'layout-export', 'layout-delete-confirm', 'layout-delete-cancel', 'layout-retry'];

    function render() {
      if (disposed) return;
      host.setAttribute('aria-busy', String(busy));
      const current = selected();
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = tr('layoutsChoose', 'Choose a saved layout…');
      select.append(placeholder);
      for (const layout of layouts) {
        const option = document.createElement('option');
        option.value = layout.id;
        option.textContent = layout.name;
        select.append(option);
      }
      select.value = selectedId;
      startup.replaceChildren();
      const lastUsed = document.createElement('option');
      lastUsed.value = ''; lastUsed.textContent = tr('layoutsStartupLastUsed', 'Last used arrangement');
      startup.append(lastUsed);
      for (const layout of layouts) {
        const option = document.createElement('option'); option.value = layout.id; option.textContent = layout.name; startup.append(option);
      }
      startup.value = layouts.some(layout => layout.id === startupLayoutId) ? startupLayoutId : '';
      startup.disabled = busy || !ready;
      select.disabled = busy || !ready || layouts.length === 0;
      name.disabled = busy || !ready;
      name.placeholder = tr('layoutsNamePlaceholder', 'For example, Exploring or Trading');
      for (const id of buttonIds) $(id).disabled = busy || !ready;
      const validName = name.value.trim().length > 0 && name.value.trim().length <= 80;
      $('layout-save').disabled = busy || !ready || !validName || layouts.length >= 50;
      for (const id of ['layout-apply', 'layout-update', 'layout-rename', 'layout-delete', 'layout-export']) {
        $(id).disabled = busy || !ready || !current || (['layout-update', 'layout-rename'].includes(id) && !validName);
      }
      $('layout-retry').hidden = !loadError;
      $('layout-retry').disabled = busy;
      $('layout-empty').hidden = !ready || layouts.length > 0;
      $('layout-summary').hidden = !current;
      if (current) {
        const visible = Object.values(current.layout?.widgetVisibility || {}).filter(value => value === true).length;
        const opened = Object.values(current.layout?.widgetOpen || {}).filter(value => value === true).length;
        const edge = current.layout?.dockEdge || 'bottom';
        const translatedEdge = tr('layoutsEdge' + edge[0].toUpperCase() + edge.slice(1), edge);
        $('layout-summary').textContent = tr('layoutsSummary', 'Widgets: {widgets} · Open panels: {open} · Bar: {edge}',
          { widgets: visible, open: opened, edge: translatedEdge });
      }
      $('layout-delete-prompt').hidden = !confirmingDelete || !current;
      if (confirmingDelete && current) $('layout-delete-question').textContent = tr('layoutsDeleteQuestion',
        'Delete “{name}” from your saved layouts?', { name: current.name });
      status.textContent = message;
      status.dataset.error = String(messageError);
      for (const element of host.querySelectorAll('[data-i18n]')) {
        const text = tr(element.dataset.i18n, element.textContent);
        element.textContent = text;
      }
    }

    function receiveLayouts(next, preferredId) {
      const previous = selected();
      layouts = Array.isArray(next) ? next.filter(layout => layout && typeof layout.id === 'string' && typeof layout.name === 'string') : [];
      if (preferredId !== undefined) { selectedId = preferredId; nameDirty = false; }
      if (!selected()) selectedId = '';
      const current = selected();
      if (!nameDirty || previous?.name !== current?.name) name.value = current?.name || '';
      ready = true;
      loadError = false;
      if (!current) confirmingDelete = false;
    }

    async function refresh() {
      if (disposed || busy) return;
      const startingRevision = revision;
      busy = true; render();
      try {
        const result = await api.layoutsList();
        if (disposed || startingRevision !== revision) return;
        if (!result?.ok) throw new Error(result?.message || tr('layoutsLoadFailed', 'Could not load your layouts. Try again.'));
        receiveLayouts(result.layouts);
        startupLayoutId = result.startupLayoutId ?? null;
      } catch (error) {
        if (!disposed && startingRevision === revision) {
          loadError = true;
          notify(error.message || tr('layoutsLoadFailed', 'Could not load your layouts. Try again.'), true);
        }
      } finally { busy = false; render(); }
    }

    async function act(action) {
      if (busy || !ready || disposed) return;
      const current = selected(), requestedName = name.value.trim();
      if (['apply', 'update', 'rename', 'delete', 'export'].includes(action) && !current) return;
      if (['save', 'update', 'rename'].includes(action) && (!requestedName || requestedName.length > 80)) return;
      busy = true; confirmingDelete = false;
      notify(tr('layoutsWorking', 'Updating layouts…')); render();
      try {
        if (['save', 'update', 'apply', 'import'].includes(action) && await flushPending() === false) {
          throw new Error(tr('layoutsPendingFailed', 'Save your other settings successfully before changing layouts.'));
        }
        if (disposed) return;
        const methods = {
          save: () => api.layoutsSave({ name: requestedName }),
          update: () => api.layoutsSave({ id: current.id, name: requestedName }),
          apply: () => api.layoutsApply(current.id), rename: () => api.layoutsRename({ id: current.id, name: requestedName }),
          delete: () => api.layoutsDelete(current.id), import: () => api.layoutsImport(), export: () => api.layoutsExport(current.id),
        };
        const result = await methods[action]();
        if (disposed) return;
        if (!result?.ok) throw new Error(result?.message || tr('layoutsActionFailed', 'The layout could not be changed. Try again.'));
        if (result.canceled) { notify(''); return; }
        if (Object.hasOwn(result, 'startupLayoutId')) startupLayoutId = result.startupLayoutId;
        if (Array.isArray(result.layouts)) receiveLayouts(result.layouts,
          result.id || (action === 'delete' ? '' : current?.id));
        if (['save', 'update', 'rename', 'import'].includes(action)) {
          nameDirty = false; name.value = selected()?.name || requestedName;
        }
        const labels = {
          save: ['layoutsSaved', 'Saved “{name}”.'], update: ['layoutsUpdated', 'Updated “{name}” from your current arrangement.'],
          apply: ['layoutsApplied', 'Applied “{name}”.'], rename: ['layoutsRenamed', 'Renamed to “{name}”.'],
          delete: ['layoutsDeleted', 'Deleted the saved layout. Your current arrangement is unchanged.'],
          import: ['layoutsImported', 'Imported “{name}”. Choose Apply to use it.'], export: ['layoutsExported', 'Exported “{name}”.'],
        };
        const [key, fallback] = labels[action];
        notify(tr(key, fallback, { name: selected()?.name || current?.name || requestedName }));
      } catch (error) {
        if (!disposed) notify(error.message || tr('layoutsActionFailed', 'The layout could not be changed. Try again.'), true);
      } finally { busy = false; render(); }
    }

    async function changeStartup() {
      if (busy || !ready || disposed) return;
      const requestedId = startup.value || null;
      busy = true; notify(tr('layoutsWorking', 'Updating layouts…')); render();
      try {
        if (await flushPending() === false) throw new Error(tr('layoutsPendingFailed', 'Save your other settings successfully before changing layouts.'));
        if (disposed) return;
        const result = await api.layoutsSetStartup(requestedId);
        if (disposed) return;
        if (!result?.ok) throw new Error(result?.message || 'The startup layout could not be saved. Try again.');
        if (Array.isArray(result.layouts)) receiveLayouts(result.layouts);
        startupLayoutId = result.startupLayoutId ?? null;
        const chosen = layouts.find(layout => layout.id === startupLayoutId);
        notify(chosen ? tr('layoutsStartupSaved', 'Startup will use “{name}”.', { name: chosen.name })
          : tr('layoutsStartupCurrent', 'Startup will restore your last used arrangement.'));
      } catch (error) { if (!disposed) notify(error.message || 'The startup layout could not be saved. Try again.', true); }
      finally { busy = false; render(); }
    }

    on(select, 'change', () => {
      selectedId = select.value; nameDirty = false; confirmingDelete = false;
      name.value = selected()?.name || ''; notify(''); render();
    });
    on(name, 'input', () => { nameDirty = true; confirmingDelete = false; render(); });
    on(startup, 'change', () => { void changeStartup(); });
    for (const action of ['save', 'apply', 'update', 'rename', 'import', 'export']) {
      on($('layout-' + action), 'click', () => { void act(action); });
    }
    on($('layout-delete'), 'click', () => { confirmingDelete = true; render(); $('layout-delete-confirm').focus(); });
    on($('layout-delete-confirm'), 'click', () => { void act('delete'); });
    on($('layout-delete-cancel'), 'click', () => { confirmingDelete = false; render(); $('layout-delete').focus(); });
    on($('layout-retry'), 'click', () => { notify(''); void refresh(); });
    render(); void refresh();
    return {
      receiveConfig(next) {
        if (disposed) return;
        config = next || {};
        if (Array.isArray(config.savedLayouts)) { revision++; receiveLayouts(config.savedLayouts); }
        if (Object.hasOwn(config, 'startupLayoutId')) startupLayoutId = config.startupLayoutId;
        render();
      },
      refresh,
      dispose() { disposed = true; revision++; listeners.forEach(remove => remove()); },
    };
  }

  window.LayoutsSettings = { mount };
}());
