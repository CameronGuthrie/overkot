#!/usr/bin/env node
'use strict';

// Authoring requires ImageMagick. Builds validate the checked-in results without
// an image tool, so a changed master can never silently reuse an older ICO.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ASSETS = path.resolve(__dirname, '../assets');
const FRAME_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
const ICO_FILES = Object.freeze(['overkot.ico', 'icon.ico', 'SF_TIMERS_LOGO.ico']);
const BITMAPS = Object.freeze({ 'installer-header.bmp': { width: 600, height: 228, logo: 200 },
  'installer-sidebar.bmp': { width: 656, height: 1256, logo: 520 } });
const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`${message}. Regenerate app branding with npm run assets:icons.`); };

function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('Invalid master icon PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function icoFrames(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) fail('Invalid app ICO');
  const count = bytes.readUInt16LE(4), frames = [];
  if (!count || count > 32 || bytes.length < 6 + count * 16) fail('Invalid app ICO frame table');
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16, length = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    const width = bytes[at] || 256, height = bytes[at + 1] || 256, bits = bytes.readUInt16LE(at + 6);
    if (width !== height || bits !== 32 || length < 24 || offset < 6 + count * 16 || offset + length > bytes.length) fail('Invalid app ICO frame');
    const image = bytes.subarray(offset, offset + length);
    if (image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
      const size = pngSize(image);
      if (size.width !== width || size.height !== height) fail('App ICO PNG frame size mismatch');
    } else if (image.length < 40 || image.readUInt32LE(0) !== 40 || image.readInt32LE(4) !== width
        || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(14) !== 32) fail('Invalid app ICO bitmap frame');
    frames.push(width);
  }
  return frames.sort((a, b) => a - b);
}

function bitmapSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM'
      || bytes.readUInt32LE(14) !== 40 || bytes.readUInt16LE(28) !== 24 || bytes.readUInt32LE(30) !== 0
      || bytes.readUInt32LE(2) !== bytes.length) fail('Invalid installer bitmap');
  return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
}

function validateAppIcons({ root = path.resolve(__dirname, '..'), assetsDir = path.join(root, 'assets') } = {}) {
  const read = name => {
    try { return fs.readFileSync(path.join(assetsDir, name)); }
    catch (error) { if (error.code === 'ENOENT') fail(`Missing app branding asset: ${name}`); throw error; }
  };
  const source = read('overkot.png'), size = pngSize(source);
  let manifest;
  try { manifest = JSON.parse(read('app-icons.json').toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) fail('Invalid app branding manifest'); throw error; }
  if (size.width !== size.height || size.width < 512 || manifest.schema !== 1 || manifest.source?.file !== 'overkot.png'
      || manifest.source.sha256 !== hash(source) || manifest.source.width !== size.width || manifest.source.height !== size.height) fail('App icon master or generated assets are stale');
  const expected = [...ICO_FILES, 'SF_TIMERS_LOGO.png', ...Object.keys(BITMAPS)].sort();
  if (!manifest.outputs || JSON.stringify(Object.keys(manifest.outputs).sort()) !== JSON.stringify(expected)) fail('App icon manifest is incomplete');
  for (const name of expected) {
    const data = read(name), entry = manifest.outputs[name];
    if (!entry || !HASH.test(entry.sha256) || entry.sha256 !== hash(data)) fail(`Generated app icon is stale: ${name}`);
    if (ICO_FILES.includes(name)) {
      if (JSON.stringify(icoFrames(data)) !== JSON.stringify(FRAME_SIZES)) fail(`App ICO lacks DPI sizes: ${name}`);
    } else if (name === 'SF_TIMERS_LOGO.png') {
      if (!data.equals(source)) fail('Legacy app logo differs from the master');
    } else {
      const actual = bitmapSize(data), expectedSize = BITMAPS[name];
      if (actual.width !== expectedSize.width || actual.height !== expectedSize.height) fail(`Installer bitmap has the wrong size: ${name}`);
    }
  }
  return { source: manifest.source, sizes: [...FRAME_SIZES], outputs: expected };
}

function buildAppIcons({ assetsDir = ASSETS, magick = process.env.MAGICK_BINARY || 'magick' } = {}) {
  assetsDir = path.resolve(assetsDir);
  const master = path.join(assetsDir, 'overkot.png'), source = fs.readFileSync(master), size = pngSize(source);
  if (size.width !== size.height || size.width < 512) fail('Master icon must be a square PNG of at least 512 pixels');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-app-icons-'));
  const run = args => {
    try { return execFileSync(magick, args, { windowsHide: true, stdio: 'pipe', timeout: 60000 }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('ImageMagick is required to regenerate app icons; install it or set MAGICK_BINARY.'); throw error; }
  };
  try {
    const icon = path.join(temporary, 'overkot.ico');
    run([master, '-alpha', 'on', '-strip', '-filter', 'Lanczos', '-define', `icon:auto-resize=${[...FRAME_SIZES].reverse().join(',')}`, '-depth', '8', icon]);
    const ico = fs.readFileSync(icon);
    if (JSON.stringify(icoFrames(ico)) !== JSON.stringify(FRAME_SIZES)) fail('ImageMagick did not generate every app icon size');
    for (const name of ICO_FILES) fs.writeFileSync(path.join(assetsDir, name), ico);
    fs.writeFileSync(path.join(assetsDir, 'SF_TIMERS_LOGO.png'), source);
    for (const [name, { width, height, logo }] of Object.entries(BITMAPS)) {
      const x = name === 'installer-header.bmp' ? width - logo - 20 : Math.floor((width - logo) / 2);
      const y = Math.floor((height - logo) / 2), output = path.join(temporary, name);
      // 4x artwork is reduced to the physical NSIS control size, including on
      // high-DPI monitors. Composite transparency onto the wizard's white panel.
      run(['-size', `${width}x${height}`, 'canvas:white', '(', master, '-filter', 'Lanczos', '-resize', `${logo}x${logo}`, '-strip', ')',
        '-geometry', `+${x}+${y}`, '-compose', 'over', '-composite', '-alpha', 'off', '-strip', '-depth', '8', `BMP3:${output}`]);
      fs.copyFileSync(output, path.join(assetsDir, name));
    }
    if (!fs.readFileSync(master).equals(source)) fail('Master icon changed while generating assets');
    const outputs = Object.fromEntries([...ICO_FILES, 'SF_TIMERS_LOGO.png', ...Object.keys(BITMAPS)]
      .map(name => [name, { sha256: hash(fs.readFileSync(path.join(assetsDir, name))) }]));
    fs.writeFileSync(path.join(assetsDir, 'app-icons.json'), JSON.stringify({ schema: 1, source: { file: 'overkot.png', sha256: hash(source), ...size }, outputs }, null, 2) + '\n');
    return validateAppIcons({ assetsDir });
  } finally {
    // Remove only the individual files made in our unique scratch directory.
    for (const name of ['overkot.ico', ...Object.keys(BITMAPS)]) {
      const filename = path.join(temporary, name);
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
    fs.rmdirSync(temporary);
  }
}

if (require.main === module) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/build-app-icons.js');
    console.log(JSON.stringify(buildAppIcons(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { FRAME_SIZES, ICO_FILES, BITMAPS, pngSize, icoFrames, bitmapSize, validateAppIcons, buildAppIcons };
