'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/world-watch.js'), 'utf8'), context);
const tag = 'UPGRADEGIVEN_GODANDGHOST';
const total = 23 * 3600;
const now = 1_800_000_000;
function meeting(timers, totalSeconds = total, namesMap = { [tag]: 'Rencontre Bénie' }, time = now) {
  context.state = { timers, totalSeconds, namesMap }; context.now = time;
  const result = vm.runInContext('blessedMeetingTimer(state, now)', context);
  return result && JSON.parse(JSON.stringify(result));
}

test('World Watch never invents a Blessed Meeting cooldown when account data is missing or invalid', () => {
  for (const timers of [undefined, null, {}, [], [{ tag: 'CurlailSiege', expiryTime: now + total }],
    [{ tag, expiryTime: '1800000000' }], [{ tag, expiryTime: NaN }], [{ tag, expiryTime: 0 }], [null]]) {
    assert.equal(meeting(timers), null);
  }
  assert.equal(vm.runInContext('blessedMeetingTimer(null, now)', context), null);
});

test('World Watch fill measures elapsed 23-hour cooldown and retains its supplied localized name', () => {
  for (const [remaining, percent] of [[total, 0], [total / 2, 50], [0, 100], [-1, 100], [total + 100, 0]]) {
    assert.deepEqual(meeting([{ tag, expiryTime: now + remaining }]), {
      name: 'Rencontre Bénie', remaining: Math.max(0, remaining), percent, ready: remaining <= 0,
    });
  }
  assert.equal(meeting([{ tag: tag.toLowerCase(), expiryTime: now + 12 }], total,
    { '/SF/Language/SystemMessages/AncestorBoosterNotification': 'Blessed Meeting' }).name, 'Blessed Meeting');
});

test('cached expiry advances locally, refreshed inventory renews it, and removed timers clear it', () => {
  const timers = [{ tag, expiryTime: now + 2 }];
  assert.equal(meeting(timers, total, {}, now).remaining, 2);
  assert.equal(meeting(timers, total, {}, now + 1).remaining, 1);
  assert.equal(meeting(timers, total, {}, now + 2).ready, true);
  assert.equal(timers[0].expiryTime, now + 2, 'The server expiry is not rewritten');
  timers.push({ tag, expiryTime: now + total });
  assert.equal(meeting(timers).remaining, total, 'Newest actual expiry wins if inventory contains duplicates');
  assert.equal(meeting([]), null);
});

test('valid expiry still counts down without fabricating a percentage if total duration is unavailable', () => {
  for (const duration of [null, 0, -1, NaN, '82800']) {
    assert.deepEqual(meeting([{ tag, expiryTime: now + 17 }], duration, {}), {
      name: '', remaining: 17, percent: null, ready: false,
    });
  }
});
