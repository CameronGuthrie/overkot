'use strict';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// The largest widget icon is 34 CSS pixels. Keep detail for high-DPI displays.
const THUMBNAIL_SIZE = 160;

function compactTemperIcon(bytes, nativeImage = require('electron').nativeImage) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Bound native decoding independently of the compressed download size.
  const longestSide = Math.max(width, height);
  if (!width || !height || longestSide > 4096 || longestSide <= THUMBNAIL_SIZE) return null;

  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const size = width >= height ? { width: THUMBNAIL_SIZE } : { height: THUMBNAIL_SIZE };
  const thumbnail = image.resize({ ...size, quality: 'best' }).toPNG();
  return thumbnail.length > 0 && thumbnail.length < bytes.length ? thumbnail : null;
}

module.exports = { compactTemperIcon };
