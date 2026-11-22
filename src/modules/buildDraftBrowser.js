'use strict';

const http = require('node:http');
const { randomBytes } = require('node:crypto');

const { services } = require('./serviceConfig');

function validImportUrl(url, website = services.buildWebsite) {
  if (!website || typeof url !== 'string') return false;
  const prefix = `${website}/?new=1&import=1#lg=v1z.`;
  if (!url.startsWith(prefix)) return false;
  const payload = url.slice(prefix.length);
  return payload.length > 0 && payload.length <= 32764 && !/[^A-Za-z0-9_-]/.test(payload);
}
async function openBuildDraft(url, { shell, website = services.buildWebsite, platform = process.platform, lifetime = 60000 } = {}) {
  if (!validImportUrl(url, website)) throw new Error('Invalid build destination');
  if (platform !== 'win32' || url.length <= 2081) return shell.openExternal(url);
  // Windows openExternal accepts only 2081 characters. A one-use local redirect
  // lets the default browser navigate the complete fragment without truncation,
  // temporary build files, or uploading the payload to a link-shortening server.
  const route = '/' + randomBytes(24).toString('hex');
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.url !== route || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
    response.writeHead(302, { Location: url });
    response.once('finish', close);
    response.end();
  });
  let timer;
  function close() { clearTimeout(timer); server.close(); }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  server.on('error', close);
  timer = setTimeout(close, lifetime); timer.unref();
  try { await shell.openExternal(`http://127.0.0.1:${server.address().port}${route}`); }
  catch (error) { close(); throw error; }
}
module.exports = { openBuildDraft, validImportUrl };
