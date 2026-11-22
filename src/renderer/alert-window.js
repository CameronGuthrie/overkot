// Uses window.api exposed by preload.js (contextIsolation:true).
// Do NOT use require('electron') here — see preload.js note on the
// alert-window IPC for why.

const lifetime = 8000;
const progressFill = document.getElementById('progress-fill');
let dismissed = true, disposed = false;
let deadline = 0, frame = null, expiryTimer = null, revision = 0;

function cancelSchedules() {
  revision++;
  if (frame !== null) cancelAnimationFrame(frame);
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  frame = expiryTimer = null;
}

function dismiss() {
  if (dismissed || disposed) return;
  dismissed = true;
  cancelSchedules();
  // A click closes immediately. Native nonactivating alerts cannot reliably
  // deliver animationend, and decorative motion must never delay dismissal.
  window.api.dismissAlert();
}

function updateProgress(current) {
  if (current !== revision) return;
  frame = null;
  if (dismissed || disposed) return;
  const remaining = Math.max(0, Math.min(1, (deadline - performance.now()) / lifetime));
  progressFill.style.transform = `scaleX(${remaining})`;
  if (!remaining) { dismiss(); return; }
  frame = requestAnimationFrame(() => updateProgress(current));
}

// A monotonic deadline controls the lifetime; frames only paint its fraction.
// The independent timeout still closes a hidden or frame-throttled window.
// Neither animation speed nor reduced-motion settings change this deadline.
progressFill.style.animation = 'none';
progressFill.style.transition = 'none';
window.api.onAlertData((data) => {
  if (disposed) return;
  cancelSchedules();
  document.getElementById('alert-name').textContent = data?.name || '';
  document.getElementById('alert-label').textContent = data?.readyLabel || 'Ready';
  dismissed = false;
  deadline = performance.now() + lifetime;
  const current = revision;
  progressFill.style.transform = 'scaleX(1)';
  expiryTimer = setTimeout(() => {
    if (current !== revision || disposed || dismissed) return;
    expiryTimer = null;
    progressFill.style.transform = 'scaleX(0)';
    dismiss();
  }, lifetime);
  frame = requestAnimationFrame(() => updateProgress(current));
});

document.getElementById('alert-close').addEventListener('click', dismiss);
window.addEventListener('unload', () => { disposed = true; cancelSchedules(); }, { once: true });
