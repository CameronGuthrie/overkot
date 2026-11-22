const { EventEmitter } = require('node:events');
const semver = require('semver');
const axios = require('axios');
const { findRelease } = require('./releaseNotes');
const { version: CURRENT_VERSION } = require('../../package.json');
const RELEASES_URL = require('./serviceConfig').services.releases;
const EMPTY_PROGRESS = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
const boundedBytes = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value)) : 0;

function releaseChanges(data, version) {
  const entry = findRelease(data, version);
  return Array.isArray(entry?.changes) ? entry.changes.filter(item => typeof item === 'string').slice(0, 50).map(item => item.slice(0, 600)) : [];
}

class Updater extends EventEmitter {
  constructor({ supported = false, backend, log = () => {}, fetch = axios.get,
    scheduleInstall = callback => setTimeout(callback, 250),
    makeToken = () => new (require('builder-util-runtime').CancellationToken)() } = {}) {
    super();
    supported = supported && !!RELEASES_URL;
    this.log = log;
    this.fetch = fetch;
    this.makeToken = makeToken;
    this.scheduleInstall = scheduleInstall;
    this.backend = supported ? (backend || require('electron-updater').autoUpdater) : null;
    this.state = { supported, installerAvailable: !!RELEASES_URL, automatic: false, currentVersion: CURRENT_VERSION,
      phase: supported ? 'idle' : 'unsupported', version: null, changes: [], errorStage: null, ...EMPTY_PROGRESS };
    this._sessionEnding = false;
    this._installGeneration = 0;
    if (!this.backend) return;
    this.backend.autoDownload = false;
    this.backend.autoRunAppAfterInstall = true;
    // Checking and downloading never authorize an installation on normal quit.
    this.backend.autoInstallOnAppQuit = false;
    this.backend.on('download-progress', progress => {
      if (this.state.phase !== 'downloading') return;
      const total = boundedBytes(progress?.total);
      const transferred = Math.min(total || Number.MAX_SAFE_INTEGER, boundedBytes(progress?.transferred));
      const percent = typeof progress?.percent === 'number' && Number.isFinite(progress.percent)
        ? progress.percent : total ? transferred / total * 100 : 0;
      this._set({ percent: Math.max(0, Math.min(100, Math.round(percent))), transferred, total,
        bytesPerSecond: boundedBytes(progress?.bytesPerSecond) });
    });
    // The promise paths report failures to the UI. Always handle the backend's
    // separate error event as well so an offline check cannot crash the app.
    this.backend.on('error', error => {
      this.log(`Update error: ${error.message}`);
      if (this.state.phase === 'installing') {
        this._installGeneration++;
        this._set({ phase: 'error', errorStage: 'install' });
      }
    });
  }

  snapshot() { return { ...this.state, changes: [...this.state.changes] }; }
  _set(values) {
    Object.assign(this.state, values);
    this.state.automatic = false;
    if (this.backend) { this.backend.autoDownload = false; this.backend.autoInstallOnAppQuit = false; }
    this.emit('changed', this.snapshot());
  }

  setAutomatic() {
    // Old profiles/callers cannot re-enable unattended downloads or installs.
    this._set({ automatic: false });
  }

  sessionEnding() {
    this._sessionEnding = true;
    // Do not launch an installer that Windows may terminate during shutdown.
    if (this.backend) this.backend.autoInstallOnAppQuit = false;
  }

  async _getJSON(name) {
    return (await this.fetch(`${RELEASES_URL}/${name}`, {
      timeout: 8000, maxRedirects: 0, maxContentLength: 512 * 1024,
      headers: { 'User-Agent': `overkot/${CURRENT_VERSION}` },
    })).data;
  }

  check() {
    if (!this.backend || this._downloadPromise || ['ready', 'installing'].includes(this.state.phase)) return Promise.resolve(this.snapshot());
    if (this._checkPromise) return this._checkPromise;
    this._checkPromise = this._check().finally(() => { this._checkPromise = null; });
    return this._checkPromise;
  }

  async _check() {
    this._set({ phase: 'checking', errorStage: null });
    try {
      const kill = await this._getJSON('killswitch.json').catch(() => null);
      if (kill && ['kill', 'force-update'].includes(kill.action) &&
        (!kill.affected_versions || semver.satisfies(CURRENT_VERSION, kill.affected_versions))) {
        this.emit('killswitch', { message: typeof kill.message === 'string' ? kill.message : '' });
        this._set({ phase: 'blocked' });
        return this.snapshot();
      }
      const result = await this.backend.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!semver.valid(version) || !semver.gt(version, CURRENT_VERSION)) {
        this._set({ phase: 'current', version: null, changes: [], ...EMPTY_PROGRESS });
        return this.snapshot();
      }
      const data = await this._getJSON('changelog.json').catch(() => null);
      this._set({ phase: 'available', version, changes: releaseChanges(data, version), ...EMPTY_PROGRESS });
    } catch (error) {
      this.log(`Update check failed: ${error.message}`);
      this._set({ phase: 'error', errorStage: 'check' });
    }
    return this.snapshot();
  }

  download(manual = true) {
    if (this._downloadPromise) return this._downloadPromise;
    if (manual !== true || !this.backend || this._sessionEnding || !this.state.version
      || !['available', 'error'].includes(this.state.phase)
      || this.state.errorStage === 'install') return Promise.resolve(this.snapshot());
    this._token = this.makeToken();
    this._downloadPromise = this._download(this._token).finally(() => {
      this._downloadPromise = null;
      this._token = null;
    });
    return this._downloadPromise;
  }

  async _download(token) {
    this._set({ phase: 'downloading', errorStage: null, ...EMPTY_PROGRESS });
    try {
      await this.backend.downloadUpdate(token);
      this._set(token.cancelled ? { phase: 'available', ...EMPTY_PROGRESS }
        : { phase: 'ready', percent: 100, bytesPerSecond: 0, transferred: this.state.total || this.state.transferred });
    } catch (error) {
      if (!token.cancelled) this.log(`Update download failed: ${error.message}`);
      this._set({ phase: token.cancelled ? 'available' : 'error', errorStage: token.cancelled ? null : 'download', ...EMPTY_PROGRESS });
    }
    return this.snapshot();
  }

  installNow() {
    if (!this.backend || !(this.state.phase === 'ready' || this.state.phase === 'error' && this.state.errorStage === 'install')
      || this._sessionEnding) return false;
    // A deliberate click opens the branded update-only NSIS progress page.
    const generation = ++this._installGeneration;
    this._set({ phase: 'installing', errorStage: null, bytesPerSecond: 0 });
    // Let the confirmation/progress surface paint before handing off to NSIS.
    // Windows shutdown during this short transition must not launch an installer.
    this.scheduleInstall(() => {
      if (this._sessionEnding || generation !== this._installGeneration || this.state.phase !== 'installing') return;
      try { this.backend.quitAndInstall(false, true); }
      catch (error) {
        this.log(`Update installation failed: ${error.message}`);
        this._set({ phase: 'error', errorStage: 'install' });
      }
    })?.unref?.();
    return true;
  }
}

module.exports = { Updater, CURRENT_VERSION, releaseChanges };
