'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createMouseShortcuts } = require('../src/modules/mouseShortcuts');

function fixture(platform = 'win32') {
  const events = [], children = [];
  const monitor = createMouseShortcuts({ platform, onPress: value => events.push(['press', value]),
    onCapture: value => events.push(['capture', value]), onError: error => events.push(['error', error.message]),
    start() {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    } });
  return { monitor, children, events };
}

test('mouse monitoring is lazy and sends only the two bindings, capture mode and window IDs', () => {
  const { monitor, children, events } = fixture();
  assert.ok(monitor.setState({ interactionHotkey: 'F11', overlayVisibilityHotkey: 'Ctrl+F2' }));
  assert.equal(children.length, 0);
  const state = { interactionHotkey: 'Ctrl+Mouse4', overlayVisibilityHotkey: 'WheelLeft', gamePid: 321, settingsHwnd: '12345' };
  assert.ok(monitor.setState(state));
  const [child] = children;
  assert.equal(child.stdin.read().toString(), 'Ctrl+Mouse4|WheelLeft|0|321|12345\n');
  assert.ok(monitor.setState(state));
  assert.equal(child.stdin.read(), null);
  child.stdout.write('ready\npress:Ctrl+Mouse4\ncapture:garbage\npress:F11\n');
  assert.deepEqual(events, [['press', 'Ctrl+Mouse4']]);
  assert.ok(monitor.setState({ capture: true }));
  child.stdout.write('capture:Mouse3\n');
  assert.deepEqual(events.at(-1), ['capture', 'Mouse3']);
  assert.ok(monitor.setState({}));
  assert.equal(child.killed, true);
  child.stdout.write('press:WheelLeft\n');
  child.emit('exit', 0);
  assert.equal(events.length, 2);
});

test('native mouse errors release the hook and do not disable keyboard-only operation', () => {
  const { monitor, children, events } = fixture();
  monitor.setState({ overlayVisibilityHotkey: 'Mouse5' });
  children[0].emit('error', new Error('unavailable'));
  children[0].emit('exit', 1);
  assert.deepEqual(events, [['error', 'unavailable']]);
  assert.ok(monitor.setState({ capture: true }));
  assert.equal(children.length, 2);
  monitor.stop();
  assert.equal(children[1].killed, true);
  const other = fixture('linux');
  assert.equal(other.monitor.setState({ interactionHotkey: 'Mouse5' }), false);
  assert.ok(other.monitor.setState({ interactionHotkey: 'F13' }));
  assert.equal(other.children.length, 0);
});
