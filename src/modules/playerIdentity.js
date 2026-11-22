const NAME_PATTERN = /^[A-Za-z0-9.,_-]{4,32}$/;
const ACCOUNT_PATTERN = /^[a-f0-9]{24}$/i;

function validName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value) ? value : null;
}

// Only accept the requested player's entry, never Results[0] blindly.
function profileDisplayName(profile, accountId) {
  if (!ACCOUNT_PATTERN.test(accountId || '') || !Array.isArray(profile?.Results)) return null;
  const player = profile.Results.find(entry => {
    const id = entry?.AccountId?.$oid || entry?.AccountId;
    return typeof id === 'string' && id.toLowerCase() === accountId.toLowerCase();
  });
  return validName(player?.DisplayName);
}

// Serializes service lifecycle changes and discards lookups from old logins.
class GroupFinderIdentity {
  constructor({ service, api, fallback = () => null, now = Date.now, log = () => {} }) {
    Object.assign(this, { service, api, fallback, now, log });
    this.accountId = null;
    this.generation = 0;
    this.nextRefresh = 0;
    this.ready = false;
    this.pending = null;
    this.lifecycle = Promise.resolve();
    this.watcher = null;
  }

  connect(accountId, name = null) {
    this.disconnect();
    this.accountId = accountId;
    this.observedName = validName(name);
    return this.refresh();
  }

  observeLogin(login) {
    if (!ACCOUNT_PATTERN.test(login?.accountId || '') || !validName(login.name)) {
      return this.accountId ? this.disconnect() : undefined;
    }
    if (login.accountId !== this.accountId) return this.connect(login.accountId, login.name);
    if (login.name !== this.observedName) {
      this.observedName = login.name;
      this.nextRefresh = 0;
    }
    return this.refresh();
  }

  watchGame(readLogin, isRunning) {
    this.stopWatching();
    const poll = () => {
      if (!isRunning()) return this.stopWatching();
      return this.observeLogin(readLogin());
    };
    this.watcher = setInterval(poll, 1000);
    this.watcher.unref?.();
    return poll();
  }

  stopWatching() {
    clearInterval(this.watcher);
    this.watcher = null;
    if (this.accountId) return this.disconnect();
  }

  disconnect() {
    this.generation++;
    this.accountId = null;
    this.observedName = null;
    this.ready = false;
    this.nextRefresh = 0;
    this.pending = null;
    // Invalidate visible identity even if the previous login is still awaiting auth.
    const shutdown = Promise.resolve(this.service.shutdown()).catch(() => {});
    this.lifecycle = Promise.allSettled([this.lifecycle, shutdown]).then(() => {});
    return this.lifecycle;
  }

  refresh() {
    if (!this.accountId || this.pending || this.now() < this.nextRefresh) return this.pending;
    const accountId = this.accountId, generation = this.generation;
    this.nextRefresh = this.now() + 60_000;
    const work = (async () => {
      const profile = !this.observedName && this.api ? await this.api.fetchProfile(accountId).catch(() => null) : null;
      if (generation !== this.generation) return;
      const name = this.observedName || profileDisplayName(profile, accountId) || validName(this.fallback(accountId));
      if (!name) { this.log('Waiting for an Envoy invite name'); return; }
      this.lifecycle = this.lifecycle.then(async () => {
        if (generation !== this.generation) return;
        if (this.ready) {
          await this.service.setDisplayName(name);
        } else {
          await this.service.shutdown();
          if (generation !== this.generation) return;
          const initialized = await this.service.initialize(accountId, name, 1);
          if (generation !== this.generation) return;
          if (!initialized) return;
          await this.service.restoreMyListing();
          if (generation !== this.generation) return;
          await this.service.setDisplayName(name);
          if (generation !== this.generation) return;
          this.service.startBackgroundListeners();
          this.service.pushUpdate();
          this.ready = true;
        }
        this.nextRefresh = this.observedName && this.observedName !== name ? 0 : this.now() + 15 * 60_000;
      }).catch(() => { this.log('Group Finder identity update will retry'); });
      await this.lifecycle;
    })().catch(() => { this.log('Envoy lookup will retry'); }).finally(() => {
      if (this.pending === work) this.pending = null;
    });
    this.pending = work;
    return work;
  }
}

module.exports = { validName, profileDisplayName, GroupFinderIdentity };
