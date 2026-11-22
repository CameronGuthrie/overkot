'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseEnv } = require('node:util');

const urlFields = ['releases', 'marketApi', 'marketPublicApi', 'marketWebsite', 'accountApi', 'accountPortal',
  'dataOrigin', 'dataManifest', 'calendarManifest', 'epithets', 'vendorCatalog'];
const origins = new Set(['marketWebsite', 'accountApi', 'accountPortal', 'dataOrigin', 'wikiWebsite', 'buildWebsite']);
const productionAccountApi = 'https://auth.avakot.dev';
const productionTargets = {
  accountPortal: 'https://account.avakot.dev',
  marketApi: 'https://api.avakot.market/v1',
  dataOrigin: 'https://d2855gck1tg5bh.cloudfront.net',
};
const firebaseFields = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

// The original installation used the unscoped storage directory. Pin its entire
// normalized profile, including both Firebase client configs and optional feeds.
const legacyProfileHash = 'ea24469e306e4f5e597082fa79c01092d65dc8af16f224bf7c8cab00fc0adb18';

function serviceUrl(value, field) {
  if (!value) return '';
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || (origins.has(field) && url.pathname !== '/')) throw new Error(`Invalid service URL for ${field}. Use HTTPS or loopback HTTP.`);
  return url.href.replace(/\/$/, '');
}

function readServiceConfig(env = process.env, { envFile } = {}) {
  let filename = env.OVERKOT_SERVICES_FILE;
  if (filename === undefined && envFile) {
    try {
      const local = parseEnv(fs.readFileSync(envFile, 'utf8')).OVERKOT_SERVICES_FILE;
      if (local) filename = path.resolve(path.dirname(envFile), local);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read the local service configuration.');
    }
  }
  const input = filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
  const settings = {};
  // Existing development fixture switches remain available in source runs and at build time.
  const overrides = { accountApi: env.OVERKOT_ACCOUNT_API_URL, accountPortal: env.OVERKOT_ACCOUNT_PORTAL_URL,
    marketApi: env.OVERKOT_MARKET_API_URL, dataManifest: env.OVERKOT_DATA_MANIFEST_URL,
    calendarManifest: env.OVERKOT_CALENDAR_MANIFEST_URL, epithets: env.OVERKOT_EPITHETS_URL };
  for (const field of urlFields) settings[field] = serviceUrl(overrides[field] || input[field], field);
  // Omit unset optional fields so existing profiles keep their credential and cache directories.
  if (input.imageBase) {
    if (settings.dataOrigin === productionTargets.dataOrigin) throw new Error('The production data service supplies its own artwork.');
    settings.imageBase = serviceUrl(input.imageBase, 'imageBase');
  }
  for (const field of ['wikiWebsite', 'buildWebsite']) {
    if (input[field]) settings[field] = serviceUrl(input[field], field);
  }
  if (settings.accountApi === productionAccountApi) {
    for (const [field, target] of Object.entries(productionTargets)) {
      if (settings[field] && settings[field] !== target) throw new Error(`The production account issuer requires its registered ${field} endpoint.`);
    }
  }
  for (const field of ['groupFirebase', 'usageFirebase']) {
    const config = input[field];
    if (!config) { settings[field] = null; continue; }
    if (!config.projectId || !config.appId || !config.apiKey || (field === 'groupFirebase' && !config.databaseURL)) {
      throw new Error(`Incomplete public Firebase client configuration for ${field}.`);
    }
    settings[field] = Object.fromEntries(firebaseFields.filter(key => typeof config[key] === 'string').map(key => [key, config[key]]));
  }
  // Preserve installed credentials and queues only for their original services.
  const officialFile = path.resolve(__dirname, '../../config/official-services.json');
  const hash = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  const official = filename && path.resolve(filename) === officialFile && hash === legacyProfileHash;
  settings.storageScope = official ? '' : hash.slice(0, 24);
  return settings;
}

// esbuild embeds the allowlisted public settings. Installed packages ignore environment overrides.
const services = typeof __OVERKOT_SERVICES__ === 'undefined'
  ? readServiceConfig(process.env, { envFile: path.resolve(__dirname, '../../.env.local') })
  : __OVERKOT_SERVICES__;
module.exports = { services, readServiceConfig };
