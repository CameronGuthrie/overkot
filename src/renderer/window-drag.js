/** Bind a window title/handle with capture so releases outside it still end the drag. */
function bindWindowDrag(region, { threshold = 3, exclude = 'button, input, select, textarea, a, .no-drag',
  onStart = () => {}, onEnd = () => {}, onClick = () => {} } = {}) {
  let active = null;
  region.style.webkitAppRegion = 'no-drag';
  region.style.touchAction = 'none';
  region.addEventListener('pointerdown', event => {
    if (event.button !== 0 || active || event.isPrimary === false || event.target.closest(exclude)) return;
    event.preventDefault();
    const state = { pointerId: event.pointerId, x: event.screenX, y: event.screenY,
      dx: 0, dy: 0, snap: event.shiftKey, moved: false, frame: 0 };
    active = state;
    region.setPointerCapture(event.pointerId);
    onStart();
    window.api.windowDragStart(threshold, state.snap);

    const flush = () => {
      state.frame = 0;
      window.api.windowMoveBy(state.dx, state.dy, state.snap);
      state.dx = 0;
      state.dy = 0;
    };
    const move = event => {
      if (event.pointerId !== state.pointerId) return;
      if ((event.buttons & 1) === 0) { finish(false); return; }
      const dx = event.screenX - state.x;
      const dy = event.screenY - state.y;
      if (!state.moved && Math.max(Math.abs(dx), Math.abs(dy)) > threshold) state.moved = true;
      if (!state.moved) return;
      state.dx += dx;
      state.dy += dy;
      state.x = event.screenX;
      state.y = event.screenY;
      state.snap = event.shiftKey;
      if (!state.frame) state.frame = requestAnimationFrame(flush);
    };
    const modifiers = event => {
      if (state.snap === event.shiftKey) return;
      state.snap = event.shiftKey;
      if (!state.frame) state.frame = requestAnimationFrame(flush);
    };
    const finish = (released, event) => {
      if (active !== state || (event && event.pointerId !== state.pointerId)) return;
      active = null;
      region.removeEventListener('pointermove', move);
      region.removeEventListener('pointerup', up);
      region.removeEventListener('pointercancel', abort);
      region.removeEventListener('lostpointercapture', abort);
      window.removeEventListener('blur', blur);
      document.removeEventListener('keydown', modifiers);
      document.removeEventListener('keyup', modifiers);
      if (state.frame) cancelAnimationFrame(state.frame);
      if (released) flush();
      window.api.windowDragEnd(!released);
      if (region.hasPointerCapture(state.pointerId)) region.releasePointerCapture(state.pointerId);
      onEnd();
      if (released && !state.moved) onClick();
    };
    const up = event => finish(true, event);
    const abort = event => finish(false, event);
    const blur = () => finish(false);
    region.addEventListener('pointermove', move);
    region.addEventListener('pointerup', up);
    region.addEventListener('pointercancel', abort);
    region.addEventListener('lostpointercapture', abort);
    window.addEventListener('blur', blur);
    document.addEventListener('keydown', modifiers);
    document.addEventListener('keyup', modifiers);
  });
}
