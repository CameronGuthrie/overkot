const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHeadersHandler } = require('../src/modules/guard');

const root = path.resolve('portable app/resources/app.asar/src/renderer');
const handle = createHeadersHandler(root);
function headers(url, resourceType = 'mainFrame', responseHeaders = {}) {
  let result;
  handle({ url, resourceType, responseHeaders }, value => { result = value; });
  return result;
}

test('packaged app documents permit map tiles and item artwork while retaining script restrictions', () => {
  for (const type of ['mainFrame', 'subFrame']) {
    const result = headers(pathToFileURL(path.join(root, 'widget-host.html')).href, type,
      { 'content-security-policy': ['old policy'], 'Content-Type': ['text/html'] });
    const policy = result.responseHeaders['Content-Security-Policy'][0];
    assert.match(policy, /img-src[^;]*overkot-map-tiles:/);
    assert.match(policy, /img-src[^;]*overkot-game-data:/);
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.equal(result.responseHeaders['content-security-policy'], undefined);
    assert.deepEqual(result.responseHeaders['Content-Type'], ['text/html']);
  }
});

test('remote wiki policies and non-document asset headers are left untouched', () => {
  for (const [url, type] of [
    ['https://wiki.avakot.org/Orlick', 'mainFrame'],
    ['https://wiki.avakot.org/challenge', 'subFrame'],
    ['overkot-map-tiles://tile/0.webp', 'image'],
    [pathToFileURL(path.join(root, 'minimap.js')).href, 'script'],
    [pathToFileURL(path.join(root, '..', 'external.html')).href, 'mainFrame'],
    [pathToFileURL(path.join(root + '-other', 'index.html')).href, 'mainFrame'],
    ['data:text/html,loading', 'mainFrame'],
  ]) assert.deepEqual(headers(url, type, { 'Content-Security-Policy': ['site policy'] }), {});
});
