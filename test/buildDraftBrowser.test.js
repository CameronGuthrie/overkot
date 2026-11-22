const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openBuildDraft } = require('../src/modules/buildDraftBrowser');
const website = 'https://build.example.org';
const prefix = website + '/?new=1&import=1#lg=v1z.';
const get = url => new Promise((resolve, reject) => {
  http.get(url, response => { response.resume(); resolve({ status: response.statusCode, headers: response.headers }); }).on('error', reject);
});

test('a missing site leaves browser export disabled', async () => {
  await assert.rejects(openBuildDraft(prefix + 'a', { website: '', shell: { openExternal: () => assert.fail() } }), /Invalid build destination/);
});

test('opens short imports directly in the default browser', async () => {
  let opened;
  await openBuildDraft(prefix + 'abc_DEF-12', { website, platform: 'win32', shell: { openExternal: async url => { opened = url; } } });
  assert.equal(opened, prefix + 'abc_DEF-12');
});
test('long Windows imports use a one-use loopback redirect with the whole fragment intact', async () => {
  const destination = prefix + 'a'.repeat(5000); let local;
  await openBuildDraft(destination, { website, platform: 'win32', shell: { openExternal: async url => { local = url; } } });
  assert.equal(new URL(local).hostname, '127.0.0.1'); assert.ok(local.length < 150);
  assert.equal((await get(new URL('/wrong-route', local))).status, 404);
  const response = await get(local);
  assert.equal(response.status, 302); assert.equal(response.headers.location, destination);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  await assert.rejects(get(local));
});
test('a browser launch failure closes the temporary listener', async () => {
  let local;
  await assert.rejects(openBuildDraft(prefix + 'a'.repeat(3000), { website, platform: 'win32', shell: {
    openExternal: async url => { local = url; throw new Error('No browser'); },
  } }), /No browser/);
  await assert.rejects(get(local));
});
test('an unused redirect expires without retaining the build', async () => {
  let local;
  await openBuildDraft(prefix + 'a'.repeat(3000), { website, platform: 'win32', lifetime: 25, shell: { openExternal: async url => { local = url; } } });
  await new Promise(resolve => setTimeout(resolve, 60));
  await assert.rejects(get(local));
});
test('rejects destinations and content that are not generated build imports', async () => {
  for (const url of ['file:///test', 'https://example.com', prefix + 'a\r\nBad: header', prefix + 'a'.repeat(40000),
    'https://avakot.build/?new=1&import=1#lg=v1z.a', 'https://build.example.org.attacker.test/?new=1&import=1#lg=v1z.a']) {
    await assert.rejects(openBuildDraft(url, { website, shell: { openExternal: () => assert.fail('Must not open') } }), /Invalid build destination/);
  }
});
