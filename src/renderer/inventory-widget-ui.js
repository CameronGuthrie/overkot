'use strict';

/** Shared lifecycle for small inventory widgets; domain rendering stays modular. */
window.InventoryWidgetUI = {
  createLabels(language) {
    const controls = [];
    const tr = (key, fallback, values = {}) => {
      const messages = typeof TRANSLATIONS !== 'undefined' ? TRANSLATIONS[language] : null;
      return (messages?.[key] || fallback).replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
    };
    return {
      text: tr,
      bind(element, attribute, pair) {
        const update = () => {
          const value = tr(...pair);
          if (attribute === 'aria-label') element.setAttribute(attribute, value);
          else element[attribute] = value;
        };
        controls.push(update);
        update();
      },
      setLanguage(value) {
        language = value;
        controls.forEach(update => update());
      },
    };
  },
  mount(element, { id, api = window.api, language = 'en', onResize = () => {}, render, tickMs = 0, setup, labels = window.InventoryWidgetUI.createLabels(language) } = {}) {
    let snapshot = null, destroyed = false, revision = 0, failed = false, timer = null, cleanup = null, unsubscribe = null;
    const tr = labels.text;
    const node = (tag, className = '', text) => {
      const value = document.createElement(tag); value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    };
    const button = (className, text, handler) => {
      const value = node('button', className, text); value.type = 'button'; value.addEventListener('click', handler); return value;
    };
    const status = node('div', 'inventory-widget-status'); status.setAttribute('role', 'status');
    const statusLabel = node('span', 'inventory-widget-status-label');
    const retry = button('inventory-widget-retry', 'Retry', refresh); retry.hidden = true;
    status.append(statusLabel, retry);
    const toolbar = node('div', 'inventory-widget-toolbar');
    const body = node('div', 'inventory-widget-body');
    const footer = node('div', 'inventory-widget-footer');
    element.replaceChildren(status, toolbar, body, footer);
    const helpers = () => ({ node, button, tr, language, now: Date.now(),
      number: (value, options = {}) => new Intl.NumberFormat(language, { maximumFractionDigits: 0, ...options }).format(value),
      refresh: () => paint(), getSnapshot: () => snapshot });
    function paint() {
      if (destroyed) return;
      const scrollTop = body.scrollTop;
      body.replaceChildren();
      const labels = { live: tr('inventoryLive', 'Live inventory'), cached: tr('wolfCached', 'Saved inventory'), waiting: tr('inventoryWaiting', 'Waiting for inventory…'), connect: tr('inventoryConnect', 'Connect to Soulframe to see this widget.') };
      statusLabel.textContent = failed ? tr('inventoryLoadFailed', 'Could not load this widget.') : snapshot ? labels[snapshot.status] || '' : tr('inventoryLoading', 'Loading…');
      status.dataset.status = failed ? 'error' : snapshot?.status || 'loading';
      retry.textContent = tr('widgetsRetry', 'Retry');
      retry.hidden = !failed;
      const available = snapshot && (snapshot.status === 'live' || snapshot.status === 'cached');
      toolbar.style.display = available ? '' : 'none';
      if (available) {
        render(body, snapshot, helpers());
        window.OverkotMotion?.inventory(id, snapshot, body);
      }
      body.scrollTop = scrollTop;
      footer.textContent = snapshot?.updatedAt ? tr('inventoryUpdated', 'Inventory updated {time}', { time: new Date(snapshot.updatedAt).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' }) }) : '';
      onResize();
    }
    async function refresh() {
      if (destroyed) return;
      const requested = ++revision;
      try {
        const value = await api.getInventoryWidget(id);
        if (!destroyed && requested === revision) { snapshot = value; failed = false; paint(); }
      } catch {
        if (!destroyed && requested === revision) { failed = true; paint(); }
      }
    }
    const handle = { setLanguage(value) { language = value || 'en'; labels.setLanguage(language); paint(); }, destroy() {
      if (destroyed) return;
      destroyed = true; revision++; unsubscribe?.(); if (timer !== null) clearInterval(timer); cleanup?.();
    }, refresh, getSnapshot: () => snapshot, repaint: paint };
    cleanup = setup?.(toolbar, helpers(), handle);
    if (destroyed) { cleanup?.(); cleanup = null; return handle; }
    unsubscribe = api.onInventoryWidgetChanged(id, value => {
      if (destroyed) return;
      revision++; snapshot = value; failed = false; paint();
    });
    timer = tickMs > 0 && !destroyed ? setInterval(paint, tickMs) : null;
    paint(); void refresh();
    return handle;
  },
};
