(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameDataImages = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const SCHEME = 'overkot-game-data';
  const IMAGE_BASE = `${SCHEME}://images`;
  const LEGACY_IMAGE_ORIGIN = 'https://dap1x6lmnonv6.cloudfront.net';
  const isTemperIconKey = key => typeof key === 'string' && /^temper-icons\/[a-f0-9]{64}\.png$/.test(key);
  const temperIconUrl = key => isTemperIconKey(key) ? `overkot-map-tiles://data/${key}` : null;
  function imagePath(value) {
    if (typeof value !== 'string' || value.length > 1000 || /[%\\?#\u0000-\u0020\u007f]/.test(value)) return null;
    let path = value;
    if (path.startsWith('SF/Interface/Graphics/')) path = '/' + path;
    if (path.startsWith(IMAGE_BASE + '/')) path = path.slice(IMAGE_BASE.length);
    else if (path.startsWith(LEGACY_IMAGE_ORIGIN + '/')) path = path.slice(LEGACY_IMAGE_ORIGIN.length);
    else if (path.startsWith('https://avakot.market/api/v1/data-assets/')) path = path.slice('https://avakot.market/api/v1/data-assets'.length);
    else if (path.startsWith('/api/v1/data-assets/')) path = path.slice('/api/v1/data-assets'.length);
    if (!/^\/SF\/Interface\/Graphics\/[A-Za-z0-9_./-]+\.(?:png|webp)$/.test(path)
      || path.split('/').some(part => part === '.' || part === '..')) return null;
    return path;
  }
  function imageUrl(value) { const path = imagePath(value); return path ? IMAGE_BASE + path : null; }
  function marketImageUrl(value) {
    const game = imageUrl(value);
    if (game) return game;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && ![LEGACY_IMAGE_ORIGIN, 'https://d2855gck1tg5bh.cloudfront.net'].includes(url.origin) ? url.href : '';
    } catch { return ''; }
  }
  return Object.freeze({ SCHEME, IMAGE_BASE, LEGACY_IMAGE_ORIGIN, imagePath, imageUrl, marketImageUrl, isTemperIconKey, temperIconUrl });
});
