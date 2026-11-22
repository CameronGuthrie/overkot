'use strict';

/** Event-driven decoration only: values, timer clocks and hit areas never move. */
const OverkotMotionModule = (() => {
  function create({ document: doc, window: win, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, storage } = {}) {
    const samples = new Map(), inventories = new Map(), recent = new Map(), active = new Map();
    const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const leaseKey = 'overkot:appearance-motion-lease';
    let destroyed = false;
    const scope = element => element?.closest?.('[data-motion-level]') || doc?.documentElement;
    const level = element => scope(element)?.dataset.motionLevel || 'standard';
    const enabled = element => !destroyed && !doc?.hidden && level(element) !== 'off';
    function duration(ms, element) {
      if (!enabled(element)) return 0;
      const speed = Number(scope(element)?.dataset.motionSpeed) || 100;
      return Math.round(ms * 100 / speed * (level(element) === 'subtle' ? .8 : 1));
    }
    function release(element) {
      const value = active.get(element);
      if (!value) return;
      clearTimer(value.timer); value.decoration.remove(); active.delete(element);
    }
    function refreshScope(root) {
      const d = root.dataset;
      const off = d.motionRequested === 'off' || (d.respectReducedMotion !== 'false' && media?.matches);
      d.motionLevel = off ? 'off' : d.motionRequested || 'standard';
      d.ambientMotion = String(d.ambientRequested === 'true' && !off);
      if (off) for (const element of active.keys()) if (scope(element) === root) release(element);
    }
    function configure(values = {}, root = doc?.documentElement) {
      if (!root || destroyed) return;
      root.dataset.motionRequested = values.motionLevel || 'standard';
      root.dataset.motionSpeed = String(values.motionSpeed ?? 100);
      root.dataset.respectReducedMotion = String(values.respectReducedMotion !== false);
      root.dataset.ambientRequested = String(values.ambientMotion === true);
      root.dataset.eventEmphasis = String(values.eventEmphasis !== false);
      root.style.setProperty('--event-strength', values.motionLevel === 'subtle' ? '.1' : values.motionLevel === 'expressive' ? '.35' : '.22');
      root.style.setProperty('--event-complete-strength', values.motionLevel === 'subtle' ? '.15' : values.motionLevel === 'expressive' ? '.5' : '.35');
      refreshScope(root);
    }
    function systemChanged() {
      for (const root of doc?.querySelectorAll?.('[data-motion-requested]') || []) refreshScope(root);
    }
    function clearEffects() { for (const element of active.keys()) release(element); }
    function visibilityChanged() {
      if (doc?.documentElement) doc.documentElement.dataset.motionPaused = String(doc.hidden);
      if (doc?.hidden) clearEffects();
    }
    const trim = (map, limit) => { while (map.size > limit) map.delete(map.keys().next().value); };
    function lease(key, until, preview) {
      if (!storage || preview) return true;
      try {
        const stored = JSON.parse(storage.getItem(leaseKey) || '[]');
        const leases = Array.isArray(stored) ? stored.filter(value => Number.isFinite(value?.until) && value.until > now()).slice(0, 2) : [];
        if (leases.length >= 2 || leases.some(value => value.key === key)) return false;
        storage.setItem(leaseKey, JSON.stringify([...leases, { key, until }]));
      } catch { /* A restricted storage partition still gets a local motion cap. */ }
      return true;
    }
    function emphasize(element, kind = 'progress', key) {
      if (!element || !enabled(element) || scope(element)?.dataset.eventEmphasis === 'false' || active.size > 0
        || element.isConnected === false || element.closest?.('[hidden], .hidden, .collapsed')) return false;
      if (!['complete', 'progress', 'activate', 'urgent', 'error', 'success'].includes(kind)) return false;
      const timestamp = now(), identity = String(key || `${kind}:${timestamp}`);
      if (recent.has(identity) && timestamp - recent.get(identity) < 30000) return false;
      const ms = duration(kind === 'activate' ? 420 : 850, element);
      if (!lease(identity, timestamp + ms, !!element.closest?.('[data-appearance-preview]'))) return false;
      const decoration = doc.createElement('span');
      decoration.className = `appearance-event appearance-event--${kind}`;
      decoration.setAttribute('aria-hidden', 'true');
      decoration.style.setProperty('--event-duration', `${ms}ms`);
      element.appendChild(decoration);
      recent.set(identity, timestamp); trim(recent, 256);
      const timer = setTimer(() => release(element), ms + 30);
      active.set(element, { decoration, timer });
      return true;
    }
    function sample(key, { value, complete = false, urgent = false, element } = {}) {
      if (destroyed || typeof key !== 'string') return false;
      const next = { value: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null, complete: !!complete, urgent: !!urgent };
      const previous = samples.get(key); samples.set(key, next); trim(samples, 2048);
      // The first sample deliberately has no payoff. Refreshes, widget opens,
      // remounts and imported configurations cannot replay old completions.
      if (!previous) return false;
      if (next.complete && !previous.complete) return emphasize(element, 'complete', `${key}:complete`);
      if (next.urgent && !previous.urgent) return emphasize(element, 'urgent', `${key}:urgent`);
      if (next.value !== null && previous.value !== null && next.value > previous.value &&
        (Math.floor(next.value * 4) > Math.floor(previous.value * 4) || next.value - previous.value >= .1)) {
        return emphasize(element, 'progress', `${key}:${Math.floor(next.value * 4)}`);
      }
      return false;
    }
    function inventory(key, snapshot, element) {
      if (destroyed || !snapshot || !['live', 'cached'].includes(snapshot.status)) return false;
      const rank = snapshot.rankSource === 'inventory-mastery' && Number.isFinite(snapshot.currentRank) ? snapshot.currentRank : null;
      const rows = new Map((snapshot.rows || []).slice(0, 2000).filter(row => row && typeof row.id === 'string').map(row => [row.id, {
        owned: row.owned === true, complete: row.completed === true || row.complete === true || row.mastered === true,
      }]));
      const previous = inventories.get(key); inventories.set(key, { rank, rows }); trim(inventories, 64);
      if (!previous) return false;
      if (rank !== null && previous.rank !== null && rank > previous.rank) return emphasize(element, 'complete', `${key}:rank:${rank}`);
      for (const [id, row] of rows) {
        const prior = previous.rows.get(id);
        if (!prior) continue;
        if (row.complete && !prior.complete) return emphasize(element, 'complete', `${key}:${id}:complete`);
        if (row.owned && !prior.owned) return emphasize(element, 'success', `${key}:${id}:owned`);
      }
      return false;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; clearEffects(); samples.clear(); inventories.clear(); recent.clear();
      media?.removeEventListener?.('change', systemChanged);
      doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      win?.removeEventListener?.('unload', destroy);
    }
    media?.addEventListener?.('change', systemChanged);
    doc?.addEventListener?.('visibilitychange', visibilityChanged);
    visibilityChanged();
    win?.addEventListener?.('unload', destroy, { once: true });
    return { configure, enabled, duration, emphasize, sample, inventory, destroy };
  }
  return { create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OverkotMotionModule;
else {
  let storage;
  try { storage = window.localStorage; } catch { /* Storage may be unavailable. */ }
  window.OverkotMotion = OverkotMotionModule.create({ document, window, storage });
}
