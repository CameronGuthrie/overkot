// Native checks use synthetic inventory and only allow the public overlay feed.
const axios = require('axios');
const manifest = process.env.OVERKOT_DATA_MANIFEST_URL || 'http://127.0.0.1:8791/overlay/v1/manifest.json';
process.env.OVERKOT_DATA_MANIFEST_URL = manifest;
const base = new URL('.', manifest);
const requests = [];
const offline = async () => { throw new Error('Game network disabled in native fixture'); };
const http = { get: async (url, options) => {
  const target = new URL(url);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.search || target.hash) return offline();
  const relative = target.pathname.slice(base.pathname.length);
  if (relative !== 'manifest.json' && !/^objects\/[a-f0-9]{64}\.(?:json\.br|png|webp)$/.test(relative)) return offline();
  requests.push(relative);
  return axios.get(url, options);
}, create: () => ({ get: offline, post: offline }) };
module.exports = { http, requests };
