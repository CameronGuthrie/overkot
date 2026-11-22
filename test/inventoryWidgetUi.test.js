'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const descendants = node => [node, ...node.children.flatMap(descendants)];
const snapshot = (amount = 1234, status = 'live') => ({ status, amount, updatedAt: 1800000000000 });

function fixture({ tickMs = 1000, synchronousSnapshot = null } = {}) {
  const document = { activeElement: null };
  function createElement(tag) {
    const handlers = new Map();
    let ownText = '';
    const item = { tagName: tag, className: '', dataset: {}, style: {}, children: [], attributes: {}, hidden: false,
      value: '', parentNode: null, scrollTop: 0,
      append(...children) { for (const child of children) { child.parentNode = item; item.children.push(child); } },
      replaceChildren(...children) {
        if (item.children.some(child => descendants(child).includes(document.activeElement))) document.activeElement = null;
        for (const child of item.children) child.parentNode = null;
        ownText = ''; item.children = []; item.scrollTop = 0; item.append(...children);
      },
      setAttribute(name, value) { item.attributes[name] = value; },
      addEventListener(type, listener) { handlers.set(type, [...(handlers.get(type) || []), listener]); },
      click() { return Promise.all((handlers.get('click') || []).map(handler => handler({ target: item }))); },
      focus() { document.activeElement = item; },
    };
    Object.defineProperty(item, 'textContent', {
      get() { return ownText + item.children.map(child => child.textContent).join(''); },
      set(value) { item.replaceChildren(); ownText = String(value); },
    });
    return item;
  }
  document.createElement = createElement;
  const requests = [], renders = [], timers = new Map();
  let listener, unsubscribeCount = 0, cleanupCount = 0, setupCount = 0, resizes = 0, nextTimer = 0, now = 1800000000000;
  const api = {
    getInventoryWidget(id) { assert.equal(id, 'fixture'); const request = deferred(); requests.push(request); return request.promise; },
    onInventoryWidgetChanged(id, callback) {
      assert.equal(id, 'fixture'); listener = callback;
      if (synchronousSnapshot) callback(synchronousSnapshot);
      return () => { unsubscribeCount++; };
    },
  };
  const context = { TRANSLATIONS: { de: { inventoryLive: 'Live-Inventar', widgetsRetry: 'Erneut versuchen', inventoryUpdated: 'Stand: {time}' } }, window: {}, document, Intl, Date: class extends Date { static now() { return now; } },
    setInterval(callback, ms) { assert.equal(ms, tickMs); const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/inventory-widget-ui.js'), 'utf8'), context);
  const element = createElement('div');
  let input;
  const handle = context.window.InventoryWidgetUI.mount(element, { id: 'fixture', api, tickMs,
    onResize() { resizes++; },
    setup(toolbar, { node }) {
      setupCount++; input = node('input', 'fixture-search'); toolbar.append(input);
      return () => { cleanupCount++; };
    },
    render(body, value, helpers) {
      assert.equal(setupCount, 1, 'controls are set up before subscription can render');
      renders.push({ value, language: helpers.language, now: helpers.now });
      body.append(helpers.node('p', 'fixture-value', helpers.number(value.amount)));
    },
  });
  const find = className => descendants(element).find(node => node.className === className);
  return { element, handle, document, requests, renders, timers, input, find,
    emit(value) { listener(value); },
    fireTimers() { now += tickMs; for (const callback of [...timers.values()]) callback(); },
    get unsubscribeCount() { return unsubscribeCount; }, get cleanupCount() { return cleanupCount; },
    get setupCount() { return setupCount; }, get resizes() { return resizes; },
  };
}

test('a newer inventory event wins over a pending getter response or rejection', async () => {
  for (const rejects of [false, true]) {
    const f = fixture();
    const newer = snapshot(30);
    f.emit(newer);
    if (rejects) f.requests[0].reject(new Error('older failure'));
    else f.requests[0].resolve(snapshot(10));
    await tick();
    assert.equal(f.handle.getSnapshot(), newer);
    assert.equal(f.find('fixture-value').textContent, '30');
    assert.equal(f.find('inventory-widget-status').dataset.status, 'live');
    f.handle.destroy();
  }
});

test('overlapping getters accept only the latest requested result', async () => {
  const f = fixture();
  const newestRead = f.handle.refresh();
  f.requests[1].resolve(snapshot(40)); await newestRead;
  f.requests[0].resolve(snapshot(20)); await tick();
  assert.equal(f.handle.getSnapshot().amount, 40);
  assert.equal(f.find('fixture-value').textContent, '40');
  f.handle.destroy();
});

test('a failed initial getter has a focusable retry that survives timed repaint', async () => {
  const f = fixture();
  f.requests[0].reject(new Error('offline')); await tick();
  assert.equal(f.find('inventory-widget-status').dataset.status, 'error');
  assert.equal(f.find('inventory-widget-status-label').textContent, 'Could not load this widget.');
  const retry = f.find('inventory-widget-retry');
  assert.equal(retry.hidden, false); retry.focus();
  f.fireTimers();
  assert.equal(f.find('inventory-widget-retry'), retry);
  assert.equal(f.document.activeElement, retry);
  const clicked = retry.click();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(snapshot(50)); await clicked;
  assert.equal(f.find('inventory-widget-status').dataset.status, 'live');
  assert.equal(retry.hidden, true);
  assert.equal(f.find('fixture-value').textContent, '50');
  f.handle.destroy();
});

test('failed refresh retains the last successful value and a new event clears the error', async () => {
  const f = fixture();
  const good = snapshot(60);
  f.requests[0].resolve(good); await tick();
  const pending = f.handle.refresh(); f.requests[1].reject(new Error('temporary')); await pending;
  assert.equal(f.handle.getSnapshot(), good);
  assert.equal(f.find('fixture-value').textContent, '60');
  assert.equal(f.find('inventory-widget-status').dataset.status, 'error');
  f.emit(snapshot(70));
  assert.equal(f.find('inventory-widget-retry').hidden, true);
  assert.equal(f.find('fixture-value').textContent, '70');
  f.handle.destroy();
});

test('destroy unsubscribes and clears timers once, ignores late results and prevents further reads', async () => {
  const f = fixture();
  assert.equal(f.timers.size, 1);
  const renders = f.renders.length, resizes = f.resizes;
  f.handle.destroy(); f.handle.destroy();
  assert.equal(f.unsubscribeCount, 1);
  assert.equal(f.cleanupCount, 1);
  assert.equal(f.timers.size, 0, 'even timer id zero is cleared');
  f.emit(snapshot(80)); f.requests[0].resolve(snapshot(90)); await tick();
  await f.handle.refresh(); f.handle.setLanguage('de'); f.handle.repaint(); f.fireTimers();
  assert.equal(f.requests.length, 1);
  assert.equal(f.renders.length, renders);
  assert.equal(f.resizes, resizes);
});

test('toolbar nodes keep keyboard focus, entered text and selection across updates and language changes', async () => {
  const f = fixture();
  assert.equal(f.find('inventory-widget-toolbar').style.display, 'none');
  f.requests[0].resolve(snapshot()); await tick();
  assert.equal(f.find('inventory-widget-toolbar').style.display, '');
  f.input.value = 'my search'; f.input.selectionStart = 2; f.input.selectionEnd = 5; f.input.focus();
  f.fireTimers(); f.emit(snapshot()); f.handle.setLanguage('de');
  assert.equal(f.setupCount, 1);
  assert.equal(f.find('fixture-search'), f.input);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.input.value, 'my search');
  assert.equal(f.input.selectionStart, 2); assert.equal(f.input.selectionEnd, 5);
  assert.equal(f.find('fixture-value').textContent, '1.234');
  assert.equal(f.find('inventory-widget-status-label').textContent, 'Live-Inventar');
  assert.equal(f.find('inventory-widget-retry').textContent, 'Erneut versuchen');
  assert.match(f.find('inventory-widget-footer').textContent, /^Stand: /);
  assert.equal(f.renders.at(-1).language, 'de');
  assert.equal(f.renders.at(-1).now, 1800000001000);
  f.handle.destroy();
});

test('connect and waiting snapshots hide stale controls and do not render inventory details', async () => {
  const f = fixture();
  f.requests[0].resolve(snapshot(12)); await tick();
  const rendered = f.renders.length;
  f.emit(snapshot(999, 'waiting'));
  assert.equal(f.renders.length, rendered);
  assert.equal(f.find('fixture-value'), undefined);
  assert.equal(f.find('inventory-widget-toolbar').style.display, 'none');
  assert.match(f.find('inventory-widget-status-label').textContent, /Waiting/);
  f.emit(snapshot(999, 'connect'));
  assert.match(f.find('inventory-widget-status-label').textContent, /Connect/);
  f.handle.destroy();
});

test('widgets without local ticking allocate no timer', () => {
  const f = fixture({ tickMs: 0 });
  assert.equal(f.timers.size, 0);
  f.handle.destroy();
});

test('a subscription may synchronously supply initial inventory after toolbar setup', () => {
  const f = fixture({ synchronousSnapshot: snapshot(33) });
  assert.equal(f.find('fixture-value').textContent, '33');
  assert.equal(f.setupCount, 1);
  f.handle.destroy();
});

test('body scroll position survives inventory events and local countdown repaint', async () => {
  const f = fixture();
  f.requests[0].resolve(snapshot()); await tick();
  const body = f.find('inventory-widget-body'); body.scrollTop = 145;
  f.fireTimers(); assert.equal(body.scrollTop, 145);
  f.emit(snapshot(99)); assert.equal(body.scrollTop, 145);
  f.handle.destroy();
});
