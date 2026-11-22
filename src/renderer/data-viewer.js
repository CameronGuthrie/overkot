/* Snapshot viewers: source reads happen only on open or an explicit refresh. */
'use strict';

window.DataViewer = (() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const matches = (value, query) => query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    .every(word => String(value).toLocaleLowerCase().includes(word));
  const humanize = value => InventoryFormat.humanize(value);

  function mount(root, { kind, api = window.api, names = {}, language = 'en' } = {}) {
    function tr(key, fallback, variables) {
      const catalogue = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
      const text = catalogue[language]?.[key] || catalogue.en?.[key] || fallback;
      return variables ? text.replace(/\{(\w+)\}/g, (match, name) => variables[name] ?? match) : text;
    }
    const time = value => value && Number.isFinite(new Date(value).getTime())
      ? new Date(value).toLocaleString(language) : tr('gfUnknown', 'Unknown');
    const inventoryMode = kind === 'inventory';
    let snapshot = null, sections = [], busy = false, destroyed = false, limit = 100, newestFirst = true;
    let searchTimer;
    let displayNames = names;
    const opened = new Set();
    root.classList.add('data-viewer');
    root.replaceChildren();
    const header = el('div', 'data-heading');
    const title = el('h2');
    const refresh = el('button', 'data-refresh');
    refresh.type = 'button';
    header.append(title, refresh);
    const freshness = el('div', 'data-freshness');
    const hint = el('p', 'data-hint');
    const controls = el('div', 'data-controls');
    const search = el('input', 'data-search');
    search.type = 'search';
    const filter = el('select', 'data-filter');
    const option = (value, label) => { const node = el('option', '', label); node.value = value; return node; };
    controls.append(search, filter);
    const order = el('button', 'data-order');
    order.type = 'button';
    if (!inventoryMode) controls.append(order);
    const feedback = el('div', 'data-feedback');
    feedback.setAttribute('role', 'status');
    const count = el('div', 'data-count');
    count.setAttribute('aria-live', 'polite');
    const content = el('div', 'data-results');
    content.setAttribute('role', 'region');
    content.tabIndex = 0;
    const more = el('button', 'data-more');
    more.type = 'button';
    more.hidden = true;
    root.append(header, freshness, hint, controls, feedback, count, content, more);

    function level(value) {
      return tr('viewerLevel.' + value, value === 'plain' ? 'Other messages' : humanize(value));
    }
    function orderLabel() {
      order.textContent = newestFirst ? tr('viewerNewest', 'Newest first') : tr('viewerOldest', 'Oldest first');
      order.setAttribute('aria-label', tr('viewerOrderHint', '{order}. Change log order', { order: order.textContent }));
    }
    function setLabels() {
      title.textContent = inventoryMode ? tr('dataInventoryWidget', 'Data - Inventory') : tr('dataEeLogWidget', 'Data - EE.log');
      refresh.textContent = busy ? tr('viewerReading', 'Reading…') : tr('gfRefresh', 'Refresh');
      refresh.title = inventoryMode ? tr('viewerRefreshInventory', 'Request a fresh inventory while connected, or reload the saved snapshot') : tr('viewerRefreshLog', 'Read the latest entries from EE.log');
      hint.textContent = inventoryMode ? tr('viewerInventoryHint', 'Browse your last inventory snapshot. Refresh requests an update while connected to Soulframe.') : tr('viewerLogHint', 'A snapshot of recent game messages. Refresh reads the file again. Times are elapsed game-session times.');
      search.placeholder = inventoryMode ? tr('viewerSearchInventory', 'Search names, fields, IDs or values…') : tr('viewerSearchLog', 'Search messages, categories or times…');
      search.setAttribute('aria-label', search.placeholder);
      filter.setAttribute('aria-label', inventoryMode ? tr('viewerSection', 'Inventory section') : tr('viewerSeverity', 'Log severity'));
      content.setAttribute('aria-label', inventoryMode ? tr('viewerContents', 'Inventory contents') : tr('viewerEntries', 'Log entries'));
      const previous = filter.value;
      filter.replaceChildren(option('', inventoryMode ? tr('viewerAllSections', 'All sections') : tr('viewerAllLevels', 'All levels')));
      if (inventoryMode) {
        for (const section of sections) filter.append(option(section.key, section.label + ' (' + section.entries.length.toLocaleString(language) + ')'));
      } else {
        for (const severity of ['error', 'warning', 'info', 'debug', 'plain']) filter.append(option(severity, level(severity)));
      }
      filter.value = [...filter.options].some(item => item.value === previous) ? previous : '';
      orderLabel();
    }

    function highlight(node, text) {
      const value = String(text ?? '');
      const terms = search.value.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
      if (!terms.length) { node.textContent = value; return; }
      const pattern = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
      let start = 0;
      for (const match of value.matchAll(pattern)) {
        node.append(document.createTextNode(value.slice(start, match.index)), el('mark', '', match[0]));
        start = match.index + match[0].length;
      }
      node.append(document.createTextNode(value.slice(start)));
    }

    function scalar(value) {
      const node = el('span', 'data-value');
      const formatted = InventoryFormat.formatPrimitive(value, displayNames);
      const reference = InventoryFormat.valueKind(value) === 'reference' ? value.$oid : value;
      if (typeof reference === 'string' && (displayNames[reference] || reference.startsWith('/SF/'))) {
        node.classList.add('data-name');
        highlight(node, formatted);
        node.append(el('small', 'data-reference', reference));
      } else {
        node.classList.add(value === null ? 'data-null' : `data-${InventoryFormat.valueKind(value)}`);
        highlight(node, formatted);
      }
      return node;
    }

    function tree(value, depth = 0) {
      const decoded = InventoryFormat.parseStructured(value);
      if (decoded !== value) return tree(decoded, depth + 1);
      if (!['array', 'object'].includes(InventoryFormat.valueKind(value))) return scalar(value);
      if (depth > 12) return el('pre', 'data-raw', JSON.stringify(value, null, 2));
      const list = el('div', 'data-fields');
      const pairs = Array.isArray(value) ? value.map((entry, index) => [String(index + 1), entry])
        : Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
      if (!pairs.length) return el('span', 'data-null', Array.isArray(value) ? tr('viewerEmptyList', 'Empty list') : tr('viewerEmptyObject', 'Empty object'));
      let position = 0;
      const next = el('button', 'data-nested-more', tr('viewerMoreFields', 'Show more fields'));
      next.type = 'button';
      function appendFields() {
        next.remove();
        const end = Math.min(position + 50, pairs.length);
        for (; position < end; position++) {
          const [key, entry] = pairs[position];
          const row = el('div', 'data-field');
          const label = el('span', 'data-key', humanize(key)); label.title = key;
          row.append(label);
          if (['array', 'object'].includes(InventoryFormat.valueKind(entry))) {
            const detail = el('details', 'data-nested');
            detail.append(el('summary', '', `${Array.isArray(entry) ? 'List' : 'Details'} · ${Object.keys(entry).length}`));
            detail.addEventListener('toggle', () => { if (detail.open && detail.childElementCount === 1) detail.append(tree(entry, depth + 1)); });
            row.append(detail);
          } else row.append(tree(entry, depth + 1));
          list.append(row);
        }
        if (position < pairs.length) {
          next.textContent = tr('viewerMoreFieldsCount', 'Show more fields ({count} remaining)', { count: (pairs.length - position).toLocaleString(language) });
          list.append(next);
        }
      }
      next.addEventListener('click', appendFields);
      appendFields();
      return list;
    }

    function entryCard(entry, key) {
      const card = el('details', 'data-entry');
      const summary = el('summary', 'data-entry-heading');
      const label = el('span', 'data-entry-name'); highlight(label, entry.label);
      summary.append(label);
      if (entry.subtitle) summary.append(el('span', 'data-entry-subtitle', entry.subtitle));
      card.append(summary);
      const populate = () => {
        if (card.childElementCount > 1) return;
        const detail = el('div', 'data-entry-detail');
        detail.append(tree(entry.value));
        const raw = el('details', 'data-raw-details');
        raw.append(el('summary', '', tr('viewerOriginalJson', 'Original JSON')));
        raw.addEventListener('toggle', () => { if (raw.open && raw.childElementCount === 1) raw.append(el('pre', 'data-raw', JSON.stringify(entry.value, null, 2))); });
        detail.append(raw); card.append(detail);
      };
      card.addEventListener('toggle', () => { if (card.open) { opened.add(key); populate(); } else opened.delete(key); });
      if (opened.has(key)) { card.open = true; populate(); }
      return card;
    }

    function renderInventory() {
      const query = search.value.trim();
      const visible = sections.filter(section => !filter.value || section.key === filter.value)
        .map(section => ({ ...section, entries: section.entries.filter(entry => matches(`${section.label} ${section.key} ${entry.searchText}`, query)) }));
      const total = visible.reduce((sum, section) => sum + section.entries.length, 0);
      const all = sections.reduce((sum, section) => sum + section.entries.length, 0);
      count.textContent = tr('viewerInventoryCount', '{shown} of {total} entries · {sections} sections', { shown: total.toLocaleString(language), total: all.toLocaleString(language), sections: sections.length.toLocaleString(language) });
      let remaining = limit;
      for (const section of visible) {
        if ((!section.entries.length && query) || remaining <= 0) continue;
        const block = el('section', 'data-section');
        const title = el('h3', '', section.label);
        title.append(el('span', 'data-section-count', section.entries.length.toLocaleString(language)));
        title.title = section.key;
        block.append(title);
        if (!section.entries.length) block.append(el('p', 'data-empty', tr('viewerSectionEmpty', 'This section is empty.')));
        for (const entry of section.entries.slice(0, remaining)) block.append(entryCard(entry, entry.path));
        remaining -= section.entries.length;
        content.append(block);
      }
      if (!total && query) content.append(el('p', 'data-empty', tr('viewerNoItems', 'No inventory entries match your search. Try a name, field or item path.')));
      more.hidden = total <= limit;
      more.textContent = tr('viewerMore', 'Show more ({count} remaining)', { count: Math.max(0, total - limit).toLocaleString(language) });
    }

    function renderLog() {
      const records = snapshot?.records || [];
      let rows = records.filter(record => (!filter.value || record.severity === filter.value)
        && matches(`${record.timestamp || ''} ${record.category || ''} ${record.severity} ${record.message} ${record.raw || ''}`, search.value.trim()));
      if (newestFirst) rows = rows.slice().reverse();
      count.textContent = tr('viewerLogCount', '{shown} of {total} entries', { shown: rows.length.toLocaleString(language), total: records.length.toLocaleString(language) });
      for (const record of rows.slice(0, limit)) {
        const card = el('details', 'data-log-entry');
        card.dataset.severity = record.severity || 'info';
        const summary = el('summary', 'data-log-heading');
        const meta = el('span', 'data-log-meta');
        meta.append(el('time', 'data-log-time', record.timestamp || '—'), el('span', 'data-level', level(record.severity || 'info')), el('span', 'data-category', record.category || tr('viewerGame', 'Game')));
        let preview = String(record.message || '');
        if (record.json) {
          const start = preview.search(/[\[{]/);
          preview = `${start >= 0 ? preview.slice(0, start).trim() || tr('viewerStructured', 'Structured data') : tr('viewerStructured', 'Structured data')} · ${InventoryFormat.formatPrimitive(record.json)}`;
        } else if (preview.length > 500) preview = preview.slice(0, 500) + tr('viewerExpand', '… (expand to read)');
        const message = el('span', 'data-log-message'); highlight(message, preview);
        summary.append(meta, message); card.append(summary);
        card.addEventListener('toggle', () => {
          if (!card.open || card.childElementCount > 1) return;
          const detail = el('div', 'data-log-detail');
          if (record.detail !== null && record.detail !== undefined) detail.append(tree(record.detail));
          detail.append(el('div', 'data-raw-label', tr('viewerOriginalLog', 'Original log entry')), el('pre', 'data-raw', record.raw || record.message));
          card.append(detail);
        });
        content.append(card);
      }
      if (!rows.length) content.append(el('p', 'data-empty', records.length ? tr('viewerNoMatch', 'No log entries match your filters.') : tr('viewerNoLog', 'No log entries in this snapshot.')));
      more.hidden = rows.length <= limit;
      more.textContent = tr('viewerMore', 'Show more ({count} remaining)', { count: Math.max(0, rows.length - limit).toLocaleString(language) });
    }

    function render() {
      content.replaceChildren();
      if (!snapshot || (inventoryMode && !snapshot.inventory) || (!inventoryMode && !snapshot.ok)) {
        count.textContent = '';
        content.append(el('p', 'data-empty', busy ? tr('viewerReadingSnapshot', 'Reading snapshot…') : inventoryMode ? tr('viewerNoInventory', 'Connect to Soulframe to capture your inventory, then refresh this viewer.') : tr('viewerNoLogFile', 'Set the EE.log location in Settings, then refresh this viewer.')));
        more.hidden = true; return;
      }
      if (inventoryMode) renderInventory(); else renderLog();
    }

    let lastResult;
    function renderMetadata() {
      const result = lastResult;
      if (!result) return;
      const metadata = snapshot?.metadata || {};
      freshness.textContent = inventoryMode
        ? tr('viewerInventoryTimes', '{type} · Updated: {updated} · Read: {read}', { type: metadata.cached ? tr('wolfCached', 'Saved inventory') : tr('viewerInventorySnapshot', 'Inventory snapshot'), updated: time(metadata.savedAt || metadata.fetchedAt), read: time(metadata.readAt) })
        : tr('viewerFileTimes', 'File updated: {updated} · Read: {read}', { updated: time(metadata.fileModifiedAt), read: time(metadata.readAt) });
      freshness.title = metadata.path || metadata.source || '';
      const messages = [];
      if (result.error) messages.push(result.error.message);
      if (result.refresh?.message) messages.push(result.refresh.message);
      if (metadata.truncated) messages.push(tr('viewerTruncated', 'Showing the latest {count} log entries. Older entries were omitted to keep the viewer responsive.', { count: (metadata.recordCount ?? snapshot.records?.length ?? 0).toLocaleString(language) }));
      feedback.textContent = messages.join(' ');
      feedback.dataset.error = String(!!result.error);
    }

    async function read(force = false) {
      if (busy || destroyed) return;
      busy = true; refresh.disabled = true; refresh.textContent = tr('viewerReading', 'Reading…');
      feedback.textContent = ''; render();
      try {
        const result = await (force ? api.refreshDataSnapshot(kind) : api.getDataSnapshot(kind));
        if (destroyed) return;
        if (!result) throw new Error(tr('viewerNoSource', 'The data source did not return a snapshot.'));
        if (result.ok || !snapshot || result.invalidatePrevious || ['session-changed', 'inventory-waiting'].includes(result.error?.code)) snapshot = result;
        lastResult = result;
        renderMetadata();
        if (inventoryMode && snapshot.inventory) {
          displayNames = InventoryFormat.collectInventoryNames(snapshot.inventory, names, snapshot.names);
          sections = InventoryFormat.buildSections(snapshot.inventory, displayNames);
          setLabels();
        }
      } catch (error) {
        feedback.textContent = tr('viewerReadFailed', 'Could not read the snapshot. Try refreshing again.') + (error.message ? ' ' + error.message : '');
        feedback.dataset.error = 'true';
      } finally {
        busy = false;
        if (!destroyed) { refresh.disabled = false; refresh.textContent = tr('gfRefresh', 'Refresh'); render(); }
      }
    }
    refresh.addEventListener('click', () => read(true));
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { limit = 100; render(); content.scrollTop = 0; }, 120); });
    filter.addEventListener('change', () => { limit = 100; render(); content.scrollTop = 0; });
    order.addEventListener('click', () => { newestFirst = !newestFirst; orderLabel(); limit = 100; render(); content.scrollTop = 0; });
    more.addEventListener('click', () => { limit += 100; const position = content.scrollTop; render(); content.scrollTop = position; });
    setLabels();
    read();
    return {
      setLanguage(value) {
        if (value === language) return;
        language = value || 'en';
        setLabels(); renderMetadata(); render();
      },
      setNames(value) {
        if (JSON.stringify(names) === JSON.stringify(value || {})) return;
        names = value || {};
        if (snapshot?.inventory) {
          displayNames = InventoryFormat.collectInventoryNames(snapshot.inventory, snapshot.names, names);
          sections = InventoryFormat.buildSections(snapshot.inventory, displayNames);
          const position = content.scrollTop; render(); content.scrollTop = position;
        }
      },
      destroy() { destroyed = true; clearTimeout(searchTimer); },
    };
  }
  return { mount };
})();
