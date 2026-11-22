'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let created = 0;
  function node() {
    created++;
    return { className: '', children: [], dataset: {}, style: {}, attributes: {}, parentElement: null,
      append(...nodes) { for (const value of nodes) this.insertBefore(value, null); },
      insertBefore(value, before) {
        if (value.parentElement) value.remove();
        const position = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(position, 0, value); value.parentElement = this;
      },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(value => value !== this); this.parentElement = null; },
      setAttribute(key, value) { this.attributes[key] = value; },
    };
  }
  const document = { createElement: node }, container = node();
  const context = vm.createContext({ document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/timer-utils.js'), 'utf8'), context);
  return { container, node, reconcile: context.reconcileNormalTimers, get created() { return created; } };
}
const timer = (key, remaining = 900, name = 'Kearnhold siege') => ({ key, remaining, name, time: `00:${remaining}`, tag: 'KearnholdSiege' });

test('countdown ticks update truthful values while retaining every timer node and running event decoration', () => {
  const f = fixture();
  const first = f.reconcile(f.container, [timer('a'), timer('b', 450)]);
  const parts = first[0]._overkotTimerParts;
  const event = f.node(); event.className = 'appearance-event'; first[0].append(event);
  const created = f.created;
  const next = f.reconcile(f.container, [timer('a', 899), timer('b', 449)]);
  assert.equal(next[0], first[0]); assert.equal(next[1], first[1]);
  assert.equal(next[0]._overkotTimerParts.fill, parts.fill); assert.equal(f.created, created, 'a tick allocates no DOM nodes');
  assert.ok(next[0].children.includes(event), 'slow event payoff survives the next tick');
  assert.equal(parts.countdown.textContent, '00:899');
  assert.equal(parts.fill.style.width, `${(1800 - 899) / 1800 * 100}%`);
  assert.equal(parts.bar.attributes['aria-valuenow'], '50.1');
});

test('reorder and removal preserve surviving nodes, labels and accessible progress', () => {
  const f = fixture(), original = f.reconcile(f.container, [timer('a'), timer('b')]);
  const second = f.reconcile(f.container, [timer('b', 30, 'A very long localized name'), timer('a', 0)]);
  assert.equal(second[0], original[1]); assert.equal(second[1], original[0]);
  assert.equal(second[0].dataset.urgent, 'true'); assert.equal(second[0]._overkotTimerParts.name.title, 'A very long localized name');
  assert.equal(second[1].dataset.complete, 'true'); assert.equal(second[1]._overkotTimerParts.label.textContent, '100%');
  f.reconcile(f.container, [timer('a', -10)]);
  assert.equal(f.container.children.length, 1); assert.equal(f.container.children[0], original[0]); assert.equal(original[1].parentElement, null);
});

test('duplicate timer identities retain separate FIFO nodes without allocation or orphan growth', () => {
  const f = fixture();
  const original = f.reconcile(f.container, [timer('same-tag-and-expiry'), timer('same-tag-and-expiry')]);
  assert.equal(original.length, 2); assert.notEqual(original[0], original[1]);
  const created = f.created;
  for (let tick = 1; tick <= 5; tick++) {
    const entries = f.reconcile(f.container, [timer('same-tag-and-expiry', 900 - tick), timer('same-tag-and-expiry', 900 - tick)]);
    assert.equal(entries[0], original[0]); assert.equal(entries[1], original[1]);
    assert.equal(f.container.children.length, 2); assert.equal(f.created, created, 'duplicate ticks allocate no extra DOM');
  }
  const remaining = f.reconcile(f.container, [timer('same-tag-and-expiry', 890)]);
  assert.equal(remaining[0], original[0]); assert.equal(f.container.children.length, 1);
  assert.equal(original[1].parentElement, null, 'the unused duplicate is removed');
  f.reconcile(f.container, []);
  assert.equal(f.container.children.length, 0); assert.equal(original[0].parentElement, null);
});

test('countdown visibility and localized completion update without remounting bars or injecting names as markup', () => {
  const f = fixture(), first = f.reconcile(f.container, [timer('a')])[0];
  f.reconcile(f.container, [timer('a', 0, '<img src=x onerror=alert(1)>')], { hideCountdown: true, readyLabel: 'Prêt' });
  const parts = first._overkotTimerParts;
  assert.equal(parts.countdown.hidden, true); assert.equal(parts.countdown.textContent, 'Prêt');
  assert.equal(parts.name.textContent, '<img src=x onerror=alert(1)>:');
  assert.equal(parts.bar.attributes['aria-label'], '<img src=x onerror=alert(1)>');
  f.reconcile(f.container, [timer('a', 0)], { hideCountdown: false, readyLabel: 'Bereit' });
  assert.equal(f.container.children[0], first); assert.equal(parts.countdown.hidden, false); assert.equal(parts.countdown.textContent, 'Bereit');
});
