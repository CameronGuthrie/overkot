const test = require('node:test');
const assert = require('node:assert/strict');
const { compactTemperIcon } = require('../src/modules/temperIconThumbnail');

function pngHeader(width, height) {
  const bytes = Buffer.alloc(100);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('small, malformed and oversized images skip native decoding', () => {
  const decoder = { createFromBuffer() { assert.fail('unexpected image decode'); } };
  for (const bytes of [Buffer.alloc(64), pngHeader(48, 32), pngHeader(4097, 100), pngHeader(0, 512)]) {
    assert.equal(compactTemperIcon(bytes, decoder), null);
  }
});

test('thumbnail resize preserves aspect ratio and keeps the smaller representation', () => {
  for (const [width, height, size] of [[512, 256, { width: 160 }], [256, 512, { height: 160 }]]) {
    const source = pngHeader(width, height);
    for (const png of [Buffer.alloc(80), Buffer.alloc(120)]) {
      const decoder = { createFromBuffer(bytes) {
        assert.equal(bytes, source);
        return {
          isEmpty: () => false,
          resize(options) {
            assert.deepEqual(options, { ...size, quality: 'best' });
            return { toPNG: () => png };
          },
        };
      } };
      assert.equal(compactTemperIcon(source, decoder), png.length < source.length ? png : null);
    }
  }
});
