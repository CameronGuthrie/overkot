'use strict';

(function(root, factory) {
  const motion = factory();
  if (typeof module === 'object' && module.exports) module.exports = motion;
  else root.PlayerMarkerMotion = motion;
})(typeof window === 'object' ? window : globalThis, function() {
  const normalize = heading => ((heading % 360) + 360) % 360;
  const shortestTurn = (from, to) => ((to - from + 540) % 360) - 180;
  const defaultNow = () => typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();

  // Interpolate facing only. Callers always draw at the latest actual position.
  function createPlayerMarkerMotion({ duration = 120, now = defaultNow } = {}) {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Invalid marker animation duration');
    if (typeof now !== 'function') throw new TypeError('Marker animation clock must be a function');
    let from = null, target = null, delta = 0, began = 0, animating = false;

    function reset(heading = null) {
      from = target = Number.isFinite(heading) ? normalize(heading) : null;
      delta = 0; began = 0; animating = false;
      return { heading: target, animating: false };
    }
    function sample(time = now()) {
      if (!animating) return { heading: target, animating: false };
      const progress = Math.max(0, Math.min(1, Number.isFinite(time) ? (time - began) / duration : 0));
      if (progress >= 1) { from = target; animating = false; return { heading: target, animating: false }; }
      const eased = progress * progress * (3 - 2 * progress);
      return { heading: normalize(from + delta * eased), animating: true };
    }
    function setHeading(heading, { immediate = false } = {}) {
      if (!Number.isFinite(heading)) return reset();
      heading = normalize(heading);
      if (immediate || target === null || duration === 0) return reset(heading);
      if (Math.abs(shortestTurn(target, heading)) < 1e-9) return sample();
      const time = now(), current = sample(time).heading;
      from = current; target = heading; delta = shortestTurn(from, target); began = time;
      animating = Math.abs(delta) >= 1e-9;
      return sample(time);
    }
    return { setHeading, sample, reset };
  }
  return { createPlayerMarkerMotion };
});
