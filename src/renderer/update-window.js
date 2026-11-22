'use strict';
const $ = selector => document.querySelector(selector);
let t = {}, platformSupport = {}, actionBusy = false, updateRevision = 0;
let updateState = { phase: 'checking', supported: true, currentVersion: '', version: null, changes: [], percent: 0 };
const tr = (key, fallback, values = {}) => (t[key] || fallback).replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const formatBytes = value => {
  const bytes = positive(value);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

function renderUpdate(state) {
  updateState = { ...updateState, ...state };
  state = updateState;
  const phase = state.phase, installing = phase === 'installing';
  const installError = phase === 'error' && state.errorStage === 'install';
  const canInstall = state.supported && !!state.version && (phase === 'ready' || installing || installError);
  const canDownload = state.supported && !!state.version && (phase === 'available'
    || phase === 'error' && (!state.errorStage || state.errorStage === 'download'));
  const busy = actionBusy || ['checking', 'downloading', 'installing'].includes(phase);
  const version = state.version || state.currentVersion;
  $('#update-heading').textContent = version ? `Overkot ${version}` : 'Overkot';
  $('#update-version-path').hidden = !state.version;
  $('#update-version-path').textContent = state.version ? tr('updateVersionPath', 'Installed {installed} · New {version}', { installed: state.currentVersion || '—', version: state.version }) : '';
  const badges = { checking: tr('updateBadgeChecking', 'CHECKING'), current: tr('updateBadgeCurrent', 'UP TO DATE'), available: tr('updateBadgeAvailable', 'NEW VERSION'), downloading: tr('updateBadgeDownloading', 'DOWNLOADING'), ready: tr('updateBadgeReady', 'READY TO INSTALL'), installing: tr('updateBadgeInstalling', 'INSTALLING'), error: tr('updateBadgeRetry', 'TRY AGAIN'), blocked: tr('updateBadgeBlocked', 'UPDATE REQUIRED') };
  $('#update-eyebrow').textContent = badges[phase] || tr('updateBadge', 'APP UPDATE');
  const messages = {
    unsupported: ['updateUnsupported', 'App updates are available in the installed Windows version. You can download the installer below.'],
    idle: ['updateIdle', 'Check for a newer version of Overkot.'],
    checking: ['updateChecking', 'Checking for updates…'],
    current: ['updateCurrent', 'You have the latest version.'],
    available: ['updateAvailable', 'A new version is available.'],
    downloading: ['updateDownloading', 'Downloading update…'],
    ready: ['updateReady', 'Your update is ready.'],
    installing: ['updateInstalling', 'Preparing to restart and install your update…'],
    error: ['updateError', 'Could not complete the update. Check your connection and try again.'],
    blocked: ['updateBlocked', 'This version is no longer available. Please download the latest installer.'],
  };
  const message = messages[phase] || messages.idle;
  $('#update-status').textContent = tr(...message);
  if (installError) $('#update-status').textContent = tr('updateInstallFailed', 'Could not start installation. Your downloaded update is still ready; try again.');
  if (phase === 'unsupported' && (state.installerAvailable === false || platformSupport.platform && platformSupport.platform !== 'win32')) {
    $('#update-status').textContent = tr('updatePlatformPackage', 'Install a newer package to update Overkot on this platform.');
  }
  const percent = phase === 'ready' || installError ? 100 : Math.max(0, Math.min(100, Number(state.percent) || 0));
  const indeterminate = phase === 'checking' || installing;
  $('#update-progress-card').hidden = !['checking', 'available', 'downloading', 'ready', 'installing'].includes(phase) && !(phase === 'error' && state.version);
  $('#update-progress').hidden = false;
  if (indeterminate) {
    $('#update-progress').removeAttribute('value');
    $('#update-progress').removeAttribute('aria-valuenow');
  } else {
    $('#update-progress').value = percent;
    $('#update-progress').setAttribute('aria-valuenow', String(percent));
  }
  const progressLabels = { checking: tr('updateProgressChecking', 'Checking for updates'), available: tr('updateProgressAvailable', 'Ready to download'), downloading: tr('updateProgressDownloading', 'Downloading update'), ready: tr('updateProgressReady', 'Download complete'), installing: tr('updateProgressInstalling', 'Preparing installation'), error: tr('updateProgressError', 'Download interrupted') };
  $('#update-progress-label').textContent = installError ? tr('updateRetryInstallation', 'Ready to retry installation') : progressLabels[phase] || tr('updateProgressLabel', 'Update progress');
  $('#update-progress').setAttribute('aria-valuetext', indeterminate ? $('#update-progress-label').textContent : `${percent}%`);
  $('#update-percent').textContent = indeterminate ? '' : `${percent}%`;
  const total = positive(state.total), transferred = positive(state.transferred), speed = positive(state.bytesPerSecond);
  $('#update-transfer').textContent = phase === 'downloading'
    ? [total ? tr('updateTransferTotal', '{transferred} of {total}', { transferred: formatBytes(Math.min(transferred, total)), total: formatBytes(total) }) : transferred ? tr('updateTransferReceived', '{transferred} downloaded', { transferred: formatBytes(transferred) }) : tr('updateDownloadStarting', 'Starting your download…'), speed ? `${formatBytes(speed)}/s` : ''].filter(Boolean).join(' · ')
    : installing ? tr('updateReopens', 'Overkot will reopen when installation is complete.')
      : installError ? tr('updateRetryHint', 'Your download is complete. Choose Restart and install to try again.')
      : phase === 'ready' ? tr('updateRestartHint', 'Restart when you are ready. Closing Overkot will not install this update.') : tr('updateDownloadHint', 'No download starts until you choose Download update.');
  const changes = Array.isArray(state.changes) ? state.changes.filter(change => typeof change === 'string').slice(0, 50) : [];
  $('#update-notes').replaceChildren(...changes.map(change => { const li = document.createElement('li'); li.textContent = change; return li; }));
  $('#update-notes-section').hidden = !state.version;
  if (state.version && !changes.length) {
    const li = document.createElement('li'); li.textContent = tr('updateNotesUnavailable', 'Release notes are not available yet.'); $('#update-notes').append(li);
  }
  // This policy is fixed, including when an older profile still says automatic:true.
  $('#update-policy').textContent = state.supported ? tr('updatePolicy', 'Overkot checks at startup. Downloads and installation start only when you choose.') : '';
  $('#update-check').hidden = !state.supported || installError || ['ready', 'installing', 'blocked'].includes(phase);
  $('#update-check').disabled = busy;
  $('#update-download').hidden = !canDownload;
  $('#update-download').disabled = busy;
  $('#update-install').hidden = !canInstall;
  $('#update-install').disabled = busy;
  $('#update-installer').hidden = state.installerAvailable === false || (platformSupport.platform && platformSupport.platform !== 'win32') || !['unsupported', 'blocked'].includes(phase);
  $('#update-later').textContent = tr(['ready', 'available', 'downloading'].includes(phase) ? 'updateLater' : 'tooltipClose', ['ready', 'available', 'downloading'].includes(phase) ? 'Later' : 'Close');
  $('#update-later').disabled = installing;
  $('#close-btn').disabled = installing;
}

async function runUpdateAction(action, install = false) {
  const installReady = updateState.phase === 'ready' || updateState.phase === 'error' && updateState.errorStage === 'install';
  if (actionBusy || updateState.phase === 'installing' || (install && !installReady)) return;
  const previous = { ...updateState }, revision = updateRevision;
  actionBusy = true;
  renderUpdate(install ? { ...updateState, phase: 'installing', errorStage: null } : updateState);
  let failed = false;
  try {
    const result = await action();
    if (install && result !== true) throw new Error('Update not ready');
    if (!install && revision === updateRevision && result?.phase) renderUpdate(result);
  } catch {
    failed = true;
    if (install) renderUpdate({ ...previous, phase: 'ready' });
  } finally {
    actionBusy = false;
    renderUpdate(updateState);
    if (failed) $('#update-status').textContent = install
      ? tr('updateInstallFailed', 'Could not start installation. Your downloaded update is still ready; try again.')
      : tr('updateError', 'Could not complete the update. Check your connection and try again.');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#close-btn').onclick = $('#update-later').onclick = () => { if (updateState.phase !== 'installing') window.api.windowClose(); };
  $('#update-check').onclick = () => runUpdateAction(() => window.api.checkAppUpdates());
  $('#update-download').onclick = () => runUpdateAction(() => window.api.downloadAppUpdate());
  $('#update-install').onclick = () => runUpdateAction(() => window.api.installAppUpdate(), true);
  $('#update-installer').onclick = () => window.api.downloadInstaller();
  const unsubscribe = window.api.onUpdateChanged(state => { updateRevision++; renderUpdate(state); });
  window.addEventListener('beforeunload', () => unsubscribe?.(), { once: true });
  try {
    const appState = await window.api.getState();
    platformSupport = appState.platformSupport || {};
    t = { ...TRANSLATIONS.en, ...TRANSLATIONS[appState.config?.language] };
  } catch { /* Update actions remain available when unrelated app state is unavailable. */ }
  $('#update-notes-heading').textContent = tr('settingsChangelog', "What's new");
  $('#update-title').textContent = tr('appUpdates', 'Overkot updates');
  for (const [id, key, fallback] of [
    ['update-check', 'checkAppUpdates', 'Check for app updates'], ['update-download', 'downloadUpdate', 'Download update'],
    ['update-install', 'restartAndInstall', 'Restart and install'], ['update-installer', 'downloadInstaller', 'Download installer'],
  ]) $('#' + id).textContent = tr(key, fallback);
  $('#close-btn').title = tr('tooltipClose', 'Close'); $('#close-btn').setAttribute('aria-label', tr('tooltipClose', 'Close'));
  renderUpdate(updateState);
  const request = updateRevision;
  try {
    const state = await window.api.getUpdateState();
    if (request === updateRevision) renderUpdate(state);
  } catch { if (request === updateRevision) renderUpdate({ phase: 'error' }); }
});
