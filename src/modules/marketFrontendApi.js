'use strict';

// The bundled website gets a JSON API, never the desktop integration key or
// session token. IPC must restrict this entry point to the local Market frame.
const MAX_BODY_BYTES = 256 * 1024;
const { imageUrl: gameImageUrl } = require('./gameDataImages');
const SECRET_KEYS = new Set(['token', 'sessiontoken', 'accesstoken', 'refreshtoken', 'idtoken', 'devicecode',
  'clientsecret', 'secret', 'apikey', 'xapikey', 'xinternalapikey', 'apisecret', 'authorization', 'cookie', 'setcookie',
  'password', 'passwordhash', 'currentpassword', 'newpassword', 'nonce', 'csrftoken', 'xcsrftoken']);

// Keep these routes aligned with the ordinary marketplace UI. Administrative,
// internal, webhook, OAuth and desktop authorization endpoints are deliberately
// absent: account authorization and grant exchange stay in the main process.
const ROUTES = [
  ['GET', /^\/(?:public\/config|catalogue\/feed|catalogue\/languages\/[a-z]{2}|arc-values\/overview|fundraiser\/pride)$/],
  ['GET', /^\/items\/(?:slug\/[^/]+|[^/]+\/(?:listings|arc-values))$/],
  ['GET', /^\/(?:listings\/(?:search|recent)|(?:listing|offer)\/[^/]+)$/],
  ['GET', /^\/envoys(?:\/[^/]+(?:\/(?:listings|history))?)?$/],
  ['GET', /^\/me(?:\/(?:settings|reports|customization|trade-modal-prefs|availability|blocks|offers(?:\/summary)?|listings(?:\/history)?|verification\/status))?$/],
  ['PATCH', /^\/me\/(?:settings|password|email|avatar|name-color|trade-modal-prefs|availability)$/],
  ['POST', /^\/me\/(?:activity|presence|blocks|offers|listings(?:\/bulk|\/[^/]+\/refresh)?|verification\/request)$/],
  ['PATCH', /^\/me\/(?:listings|offers)\/[^/]+$/],
  ['DELETE', /^\/me\/(?:blocks\/[^/]+|listings\/[^/]+\/history|verification)$/],
  ['POST', /^\/(?:upvotes|reports|store\/checkout)$/],
  ['GET', /^\/store\/(?:packs|my-purchases)$/],
  ['POST', /^\/auth\/(?:sign-in|sign-out|resend-verification|forgot-password)$/],
  ['GET', /^\/auth\/(?:discord|patreon)\/status$/],
  ['DELETE', /^\/auth\/discord\/unlink$/],
  ['PATCH', /^\/auth\/discord\/privacy$/],
  ['POST', /^\/auth\/discord\/sync-roles$/],
];

const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const errorBody = (code, message) => ({ error: { code, message } });

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('VALIDATION_FAILED', 'Choose a valid market request.');
  const { path, body } = input;
  const method = input.method === undefined ? 'GET' : typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/v1/') || /[\\#\x00-\x20\x7f]/.test(path)) {
    throw fault('VALIDATION_FAILED', 'Choose a valid market API path.');
  }
  const pathname = path.split('?')[0];
  let decoded;
  try {
    decoded = pathname.split('/').slice(1).map(segment => {
      const value = decodeURIComponent(segment);
      // Reject both encoded separators and double-encoded traversal. Neither
      // the URL parser nor a future server decoder may reinterpret the route.
      if (!value || value === '.' || value === '..' || /[/\\%?#\x00-\x20\x7f]/.test(value)) throw new Error('Unsafe segment');
      return value;
    }).join('/');
    decodeURIComponent(path.slice(pathname.length));
  } catch { throw fault('VALIDATION_FAILED', 'Choose a valid market API path.'); }
  const route = '/' + decoded.slice(3);
  if (!ROUTES.some(([verb, pattern]) => method === verb && pattern.test(route))) {
    throw fault('ENDPOINT_UNAVAILABLE', 'Open the market website to use this account action.', 403);
  }
  let parsedBody;
  if (body !== undefined && body !== null) {
    if (method === 'GET') throw fault('VALIDATION_FAILED', 'Market reads cannot include a request body.');
    try {
      const serialized = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) throw new Error('Body too large');
      parsedBody = JSON.parse(serialized);
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) throw new Error('Expected object');
    } catch { throw fault('VALIDATION_FAILED', 'Choose a valid JSON request of up to 256 KB.'); }
  }
  return { route: path.slice(4), pathname: route, method, body: parsedBody };
}

function sanitizeMarketResponse(value) {
  let count = 0;
  const visit = (entry, depth) => {
    if (++count > 500000 || depth > 64) throw fault('INVALID_RESPONSE', 'The market returned an invalid response.', 502);
    if (Array.isArray(entry)) return entry.map(item => visit(item, depth + 1));
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry)
        .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, '')))
        .map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    return typeof entry === 'string' ? gameImageUrl(entry) || entry : entry;
  };
  return visit(value, 0);
}

function errorStatus(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  const code = error?.code || error?.error;
  if (['SIGN_IN_REQUIRED', 'UNAUTHENTICATED', 'UNAUTHORIZED'].includes(code)) return 401;
  if (['FORBIDDEN', 'APP_ACCESS_REQUIRED', 'RESTRICTION_ACTIVE'].includes(code)) return 403;
  if (code === 'RATE_LIMITED') return 429;
  if (['SESSION_CHANGED', 'BUSY'].includes(code)) return 409;
  if (['VALIDATION_FAILED', 'INVALID_RESPONSE'].includes(code)) return code === 'INVALID_RESPONSE' ? 502 : 422;
  return 502;
}

async function requestMarketFrontend(market, input) {
  let locked = false;
  try {
    const request = validateRequest(input);
    await market.initialize();
    const generation = market.generation;
    const checkSession = () => {
      if (market.generation !== generation) throw fault('SESSION_CHANGED', 'The market account changed. Refresh before continuing.', 409);
    };
    if (request.pathname === '/auth/sign-in') {
      const result = await market.login(request.body);
      if (!result?.ok) throw fault(result?.error || 'SIGN_IN_FAILED', result?.message || 'Sign-in could not be completed.', errorStatus(result));
      // login() changes the session generation intentionally. Read the full
      // account response required by the website, rather than its projection.
      const signedInGeneration = market.generation;
      const body = await market.request('me');
      if (market.generation !== signedInGeneration) throw fault('SESSION_CHANGED', 'The market account changed. Refresh before continuing.', 409);
      return { status: 200, body: sanitizeMarketResponse(body) };
    }
    if (request.pathname === '/auth/sign-out') {
      if (market.sharedAccount) throw fault('ACCOUNT_CONNECTION_REQUIRED', 'Open Overkot Settings > Connections to manage your sign-in.', 409);
      await market.logout();
      return { status: 200, body: { data: { status: 'signed_out' } } };
    }

    // The desktop heartbeat owns in-game availability while Market is enabled.
    // The website's idle timers must not mark the same session away or offline.
    const autoPresence = market.enabled && !!market.token;
    if (autoPresence && ((request.method === 'POST' && ['/me/activity', '/me/presence'].includes(request.pathname))
      || (request.method === 'PATCH' && request.pathname === '/me/availability'))) {
      const body = await market.request('me/availability');
      checkSession();
      return { status: 200, body: sanitizeMarketResponse(body) };
    }

    const mutatesListings = request.method !== 'GET' && /^\/me\/(?:listings|offers)(?:\/|$)/.test(request.pathname);
    if (mutatesListings) {
      if (market.mutating) throw fault('BUSY', 'A listing change is already in progress.', 409);
      market.mutating = true;
      locked = true;
    }
    checkSession();
    const token = market.token;
    const body = await market.request(request.route, { method: request.method, ...(request.body ? { body: request.body } : {}) });
    checkSession();
    if (request.method === 'GET' && request.pathname === '/me') {
      market.acceptAccountResponse(body, generation, token);
    }
    if (mutatesListings || (request.method !== 'GET' && /^\/me\/(?:settings|verification)(?:\/|$)/.test(request.pathname))) {
      // A failed follow-up read cannot turn a confirmed write into a failed
      // mutation that the UI might invite the player to submit a second time.
      try { await market.refresh(); } catch { /* The next refresh recovers. */ }
      checkSession();
    }
    return { status: 200, body: sanitizeMarketResponse(body) };
  } catch (error) {
    const status = errorStatus(error);
    return { status, body: errorBody(error?.code || 'MARKET_ERROR', error?.code ? error.message : 'The market could not complete this request. Please try again.') };
  } finally {
    if (locked) {
      market.mutating = false;
      market.update();
    }
  }
}

module.exports = { requestMarketFrontend, sanitizeMarketResponse };
