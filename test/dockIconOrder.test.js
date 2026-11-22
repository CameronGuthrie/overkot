'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(edge = 'bottom', options = {}) {
  const vertical = edge === 'left' || edge === 'right';
  const elements = new Map(), frames = new Map(), saves = [], toggles = [], keyboard = [];
  let context, frameId = 0;
  function element(tag = 'span') {
    const listeners = new Map(), classes = new Set(), captures = new Set();
    const node = {
      tagName: tag.toUpperCase(), dataset: {}, style: {}, children: [], attributes: {}, parentNode: null,
      textContent: '', title: '', hidden: false, disabled: false, scrollLeft: 0, scrollTop: 0,
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
      },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
      dispatch(type, event) { for (const callback of listeners.get(type) || []) { callback(event); if (event.stopped) break; } },
      appendChild(child) { return this.insertBefore(child, null); },
      insertBefore(child, before) {
        child.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index, 0, child); child.parentNode = this; return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
      },
      cloneNode() { const copy = element(tag); copy.className = this.className; copy.dataset = { ...this.dataset }; return copy; },
      closest(selector) { return selector === '.dock-widget-button' && this.dataset.widget ? this : null; },
      setPointerCapture(id) { captures.add(id); }, hasPointerCapture: id => captures.has(id),
      releasePointerCapture(id) { captures.delete(id); },
      focus() { document.activeElement = this; },
      getBoundingClientRect() {
        const index = container.children.indexOf(this);
        if (this === container) return { left: 8, top: 8, right: vertical ? 48 : 208, bottom: vertical ? 208 : 48, width: vertical ? 40 : 200, height: vertical ? 200 : 40 };
        const left = vertical ? 8 : 8 + index * 40 - container.scrollLeft;
        const top = vertical ? 8 + index * 40 - container.scrollTop : 8;
        return { left, top, width: 36, height: 36, right: left + 36, bottom: top + 36 };
      },
    };
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => { classes.clear(); value.split(' ').filter(Boolean).forEach(name => classes.add(name)); } });
    Object.defineProperty(node, 'nextElementSibling', { get: () => node.parentNode?.children[node.parentNode.children.indexOf(node) + 1] || null });
    return node;
  }
  const container = element('nav'), document = element(), window = element();
  document.body = element('body');
  document.body.dataset.dockEdge = edge;
  document.body.classList.toggle('dock-vertical', vertical);
  document.querySelector = selector => {
    if (selector === '#widget-launchers') return container;
    if (selector === '#dock-order-announcement') return document.body.children.find(node => node.id === 'dock-order-announcement') || null;
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  document.createElement = element;
  document.createElementNS = (_namespace, tag) => element(tag);
  window.innerWidth = vertical ? 48 : 1000;
  window.innerHeight = vertical ? 1000 : 48;
  window.ALL_WIDGET_IDS = ['boss', 'crafting', 'wiki', 'clock'];
  window.api = {
    saveConfig: update => { saves.push(JSON.parse(JSON.stringify(update))); return options.save ? options.save(update) : Promise.resolve(true); },
    toggleDockWidget: id => { toggles.push(id); return Promise.resolve(true); },
    openMarket: () => toggles.push('market'), setDockKeyboardActive: active => keyboard.push(active),
  };
  context = vm.createContext({ window, document, TRANSLATIONS: { en: {} }, console: { error() {} },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/widget-icons.js'), 'utf8'), context);
  window.WidgetIcons = context.WidgetIcons;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8'), context);
  const initial = { dockEdge: edge, widgetVisibility: { boss: true, crafting: true, wiki: true, market: true }, ...options.config };
  const run = code => vm.runInContext(code, context);
  context.fixtureConfig = initial;
  run('config = fixtureConfig; renderWidgetButtons(); bindDockIconReordering();');
  function event(surface, type, overrides = {}) {
    const value = { pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: 26, clientY: 26, detail: 1,
      target: container, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
      ...overrides };
    surface.dispatch(type, value);
    return value;
  }
  return { container, document, window, saves, toggles, keyboard, run, event,
    order: () => container.children.map(node => node.dataset.widget),
    button: id => container.children.find(node => node.dataset.widget === id),
    drag(id, position = 175) {
      const button = this.button(id), rect = button.getBoundingClientRect();
      event(container, 'pointerdown', { target: button, clientX: rect.left + 18, clientY: rect.top + 18 });
      event(document, 'pointermove', vertical ? { clientY: position } : { clientX: position });
    },
    click(button, detail = 1) {
      const click = event(container, 'click', { target: button, detail });
      if (!click.stopped) button.dispatch('click', click);
      return click;
    },
    frame() { const scheduled = [...frames.values()]; frames.clear(); scheduled.forEach(callback => callback()); },
  };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('Market stays lit while its window is open and clears when it closes', async () => {
  const f = fixture('bottom', { config: { widgetOpen: { market: true } } });
  const button = f.button('market');
  assert.equal(button.classList.contains('is-open'), false, 'Market uses runtime window state, not saved widget preferences');
  assert.equal(button.attributes['aria-pressed'], 'false');
  f.run('dockState = { marketOpen: true }; renderWidgetButtons();');
  assert.equal(button.classList.contains('is-open'), true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.match(button.attributes['aria-label'], /^Focus /);
  f.click(button);
  await flush();
  assert.deepEqual(f.toggles, ['market']);
  assert.equal(button.classList.contains('is-open'), true, 'Focusing the existing Market keeps its active indicator');
  f.run('dockState = { marketOpen: false }; renderWidgetButtons();');
  assert.equal(button.classList.contains('is-open'), false);
  assert.equal(button.attributes['aria-pressed'], 'false');
});

test('saved icon order ignores duplicate and unknown IDs while retaining disabled widget slots', async () => {
  const f = fixture('bottom', { config: { dockWidgetOrder: ['wiki', 'clock', 'boss', 'crafting', 'market', 'wiki', 'unknown'] } });
  assert.deepEqual(f.order(), ['wiki', 'boss', 'crafting', 'market']);
  f.drag('boss', 10);
  f.event(f.document, 'pointerup', { buttons: 0 });
  await flush();
  assert.deepEqual(f.order(), ['boss', 'wiki', 'crafting', 'market']);
  assert.deepEqual(f.saves[0].dockWidgetOrder, ['boss', 'clock', 'wiki', 'crafting', 'market']);
  assert.deepEqual(f.toggles, []);
});

test('left-button dragging reorders icons on all four edges and suppresses the release click', async () => {
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const f = fixture(edge);
    const button = f.button('boss');
    f.drag('boss');
    assert.deepEqual(f.order(), ['crafting', 'wiki', 'market', 'boss'], edge);
    assert.equal(f.document.body.classList.contains('dock-icons-dragging'), true, edge);
    f.event(f.document, 'pointerup', { buttons: 0 });
    assert.equal(f.click(button).stopped, true, edge);
    await flush();
    assert.deepEqual(f.saves[0].dockWidgetOrder, ['crafting', 'wiki', 'market', 'clock', 'boss'], edge);
    assert.deepEqual(f.toggles, [], edge);
    assert.equal(f.document.body.classList.contains('dock-icons-dragging'), false, edge);
    assert.deepEqual(f.keyboard, [true, false], 'Dragging keeps auto-hide paused until release');
  }
});

test('a click or movement below the threshold still toggles its widget without saving order', async () => {
  const f = fixture();
  const button = f.button('boss');
  f.event(f.container, 'pointerdown', { target: button });
  f.event(f.document, 'pointermove', { clientX: 29, clientY: 28 });
  f.event(f.document, 'pointerup', { buttons: 0 });
  assert.equal(f.click(button).stopped, false);
  await flush();
  assert.deepEqual(f.toggles, ['boss']);
  assert.deepEqual(f.saves, []);
});

test('cancelled drags restore the stored order and allow the next ordinary click', async () => {
  for (const cancellation of ['pointercancel', 'lostpointercapture', 'Escape', 'blur']) {
    const f = fixture();
    f.drag('market', 10);
    if (cancellation === 'Escape') f.event(f.document, 'keydown', { key: 'Escape' });
    else if (cancellation === 'blur') f.event(f.window, 'blur');
    else f.event(cancellation === 'lostpointercapture' ? f.container : f.document, cancellation, { target: f.container });
    assert.deepEqual(f.order(), ['boss', 'crafting', 'wiki', 'market'], cancellation);
    assert.deepEqual(f.saves, [], cancellation);
    const button = f.button('boss');
    f.event(f.container, 'pointerdown', { target: button });
    f.event(f.document, 'pointerup', { buttons: 0 });
    f.click(button);
    await flush();
    assert.deepEqual(f.toggles, ['boss'], cancellation);
  }
});

test('keyboard reordering retains focus and saves without changing any widget open state', async () => {
  const f = fixture();
  const button = f.button('wiki');
  f.run("moveDockIconWithKeyboard('wiki', -1)");
  await flush();
  assert.deepEqual(f.order(), ['boss', 'wiki', 'crafting', 'market']);
  assert.equal(f.document.activeElement, button);
  assert.deepEqual(Object.keys(f.saves[0]), ['dockWidgetOrder']);
  assert.deepEqual(f.toggles, []);
});

test('order saves are serialized and retain the latest arrangement while an earlier save is pending', async () => {
  const responses = [];
  const f = fixture('left', { save: () => new Promise(resolve => responses.push(resolve)) });
  f.run("moveDockIconWithKeyboard('boss', 1)");
  f.run("moveDockIconWithKeyboard('boss', 1)");
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.order(), ['crafting', 'wiki', 'boss', 'market']);
  responses.shift()(true);
  await flush();
  assert.equal(f.saves.length, 2);
  responses.shift()(true);
  await flush();
  assert.deepEqual(f.order(), ['crafting', 'wiki', 'boss', 'market']);
  assert.deepEqual(f.saves[1].dockWidgetOrder, ['crafting', 'wiki', 'boss', 'clock', 'market']);
});

test('a rejected save restores the stored arrangement and exposes a retry hint', async () => {
  const f = fixture('bottom', { save: () => Promise.resolve(false) });
  f.run("moveDockIconWithKeyboard('wiki', -1)");
  await flush();
  assert.deepEqual(f.order(), ['boss', 'crafting', 'wiki', 'market']);
  assert.match(f.run('rendererWarning'), /Could not save widget order/);
});

test('scrolling while an icon is held reaches overflowed icons without changing widget visibility', () => {
  for (const edge of ['bottom', 'right']) {
    const f = fixture(edge);
    f.drag('boss', 205);
    f.frame();
    assert.equal(edge === 'right' ? f.container.scrollTop : f.container.scrollLeft, 6);
    f.event(f.document, 'pointercancel');
    assert.deepEqual(f.toggles, []);
    assert.deepEqual(f.saves, []);
  }
});
