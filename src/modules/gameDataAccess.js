'use strict';

const { EventEmitter } = require('node:events');
const axios = require('axios');
const { imagePath } = require('./gameDataImages');
const { isGameLanguageFile } = require('./gameLocales');
const { services } = require('./serviceConfig');
const DATA_ORIGIN = services.dataOrigin;
const MANIFEST_URL = DATA_ORIGIN && `${DATA_ORIGIN}/protected/overlay/v2/manifest.json`;
const FILES_BASE = DATA_ORIGIN && `${DATA_ORIGIN}/protected/files`;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const CACHE_LIMIT = 32 * 1024 * 1024;
const missingAccount = () => Object.assign(new Error('Connect your avakot.dev account in Settings > Connections to download game data.'), { code: 'DATA_SIGN_IN_REQUIRED' });
const changedAccount = () => Object.assign(new Error('The avakot.dev connection changed. Retry game data with the current account.'), { code: 'DATA_ACCOUNT_CHANGED' });

function protectedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== DATA_ORIGIN || url.username || url.password || url.search || url.hash || String(value).includes('%')) return false;
  return /^\/protected\/overlay\/v2\/(?:manifest\.json|objects\/[a-f0-9]{64}\.(?:json\.br|webp|png))$/.test(url.pathname)
    || url.pathname === '/protected/files/epithets.json'
    || (url.pathname.startsWith('/protected/files/') && isGameLanguageFile(url.pathname.slice('/protected/files/'.length)))
    || (url.pathname.startsWith('/protected/images/') && !!imagePath(url.pathname.slice('/protected/images'.length)));
}

class GameDataAccess extends EventEmitter {
  constructor({ account, http = axios, now = Date.now, imageBase = services.imageBase }) {
    super(); Object.assign(this, { account, transport: http, now });
    this.imageBase = imageBase;
    this.identity = this.currentIdentity(); this.revision = 0; this.accessToken = null; this.expiresAt = 0; this.pending = null;
    this.images = new Map(); this.imageBytes = 0; this.imageRequests = new Map();
    this.onAccount = () => {
      const next = this.currentIdentity();
      if (next === this.identity) return;
      this.identity = next; this.revision++; this.accessToken = null; this.expiresAt = 0; this.pending = null;
      this.images.clear(); this.imageBytes = 0; this.imageRequests.clear(); this.emit('changed', { signedIn: !!next });
    };
    account.on('changed', this.onAccount);
    this.http = { get: (url, options) => this.get(url, options) };
  }
  currentIdentity() { return this.account.snapshot().signedIn === true && this.account.token ? this.account.token : null; }
  async token() {
    this.onAccount();
    const identity = this.identity, revision = this.revision;
    if (!identity) throw missingAccount();
    if (this.accessToken && this.expiresAt > this.now() + 60_000) return this.accessToken;
    if (this.pending?.identity === identity) return this.pending.promise;
    const promise = Promise.resolve().then(() => this.account.request('data-authorization', { method: 'POST', body: {}, token: identity })).then(result => {
      if (revision !== this.revision || identity !== this.currentIdentity()) throw changedAccount();
      const expiresAt = Math.min(Date.parse(result?.expiresAt), this.now() + Math.min(300, result?.expiresIn) * 1000);
      if (result?.tokenType !== 'Bearer' || result?.scope !== 'overlay:read' || typeof result?.accessToken !== 'string'
        || result.accessToken.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.accessToken)
        || !Number.isFinite(expiresAt) || expiresAt <= this.now() + 1000) throw new Error('The data service returned an invalid authorization.');
      this.accessToken = result.accessToken; this.expiresAt = expiresAt; return this.accessToken;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = null; });
    this.pending = { identity, promise }; return promise;
  }
  async get(url, options = {}, retry = true) {
    if (!protectedUrl(url)) return this.transport.get(url, options);
    this.onAccount();
    const identity = this.identity, revision = this.revision;
    const token = await this.token();
    if (revision !== this.revision || identity !== this.identity || identity !== this.currentIdentity()) throw changedAccount();
    try {
      const response = await this.transport.get(url, { ...options, maxRedirects: 0,
        headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      if (revision !== this.revision || identity !== this.identity || identity !== this.currentIdentity()) throw changedAccount();
      return response;
    } catch (error) {
      if (retry && error.response?.status === 401 && revision === this.revision && identity === this.identity && identity === this.currentIdentity()) {
        if (this.accessToken === token) { this.accessToken = null; this.expiresAt = 0; }
        return this.get(url, options, false);
      }
      throw error;
    }
  }
  async imageResponse(request) {
    let path;
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'overkot-game-data:' || url.hostname !== 'images' || url.port || url.username || url.password || url.search || url.hash) throw new Error();
      path = imagePath(request.url);
    } catch { return new Response('Not found', { status: 404 }); }
    if (!path || !['GET', 'HEAD'].includes(request.method || 'GET')) return new Response('Not found', { status: 404 });
    this.onAccount();
    if (!this.imageBase && !DATA_ORIGIN) return new Response('Game artwork is unavailable in this build.', { status: 503 });
    if (!this.imageBase && !this.identity) return new Response('Connect your avakot.dev account to load game artwork.', { status: 401 });
    const revision = this.revision;
    try {
      let image = this.images.get(path);
      if (!image) {
        let work = this.imageRequests.get(path);
        if (!work) {
          const options = { responseType: 'arraybuffer', timeout: 20000, maxRedirects: 0,
            maxContentLength: IMAGE_LIMIT, maxBodyLength: IMAGE_LIMIT, decompress: false, headers: { 'Accept-Encoding': 'identity' } };
          const download = this.imageBase ? this.transport.get(this.imageBase + path, options)
            : this.get(`${DATA_ORIGIN}/protected/images${path}`, options);
          work = download.then(response => {
            const bytes = Buffer.from(response.data);
            if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error('Game artwork exceeds its size limit.');
            const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
            const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
            if (!(png && path.endsWith('.png')) && !(webp && path.endsWith('.webp'))) throw new Error('Invalid game artwork.');
            if (revision !== this.revision || this.identity !== this.currentIdentity()) throw changedAccount();
            const item = { bytes, type: png ? 'image/png' : 'image/webp' };
            while (this.imageBytes + bytes.length > CACHE_LIMIT && this.images.size) {
              const oldest = this.images.keys().next().value; this.imageBytes -= this.images.get(oldest).bytes.length; this.images.delete(oldest);
            }
            this.images.set(path, item); this.imageBytes += bytes.length; return item;
          }).finally(() => { if (this.imageRequests.get(path) === work) this.imageRequests.delete(path); });
          this.imageRequests.set(path, work);
        }
        image = await work;
      }
      if (revision !== this.revision || this.identity !== this.currentIdentity()) throw changedAccount();
      return new Response(request.method === 'HEAD' ? null : image.bytes, { headers: { 'Content-Type': image.type,
        'Content-Length': String(image.bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { return new Response(error.code === 'DATA_SIGN_IN_REQUIRED' ? 'Sign in to download game artwork.' : 'Game artwork is unavailable.', { status: error.code === 'DATA_SIGN_IN_REQUIRED' ? 401 : 502 }); }
  }
  dispose() {
    this.account.removeListener('changed', this.onAccount); this.revision++; this.accessToken = null; this.pending = null;
    this.images.clear(); this.imageRequests.clear(); this.imageBytes = 0;
  }
}

module.exports = { GameDataAccess, DATA_ORIGIN, MANIFEST_URL, FILES_BASE, IMAGE_LIMIT, protectedUrl };
