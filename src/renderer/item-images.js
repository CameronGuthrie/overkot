/* Shared S3 item artwork for inventory and collection widgets. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../modules/gameDataImages') : root.GameDataImages);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ItemImages = api;
})(typeof globalThis === 'object' ? globalThis : this, function (GameDataImages) {
  'use strict';
  const IMAGE_ORIGIN = GameDataImages.IMAGE_BASE;
  const imageUrl = GameDataImages.imageUrl;
  const symbols = {
    weapon: 'm6 3 15 15-3 3L3 6zM3 16l5 5m-2-2-4 3M16 3l5 5',
    armor: 'm8 3 4 3 4-3 6 5-4 4v9H6v-9L2 8zM8 3v5h8V3',
    soul: 'm12 2 8 10-8 10-8-10zM12 6v12M8 12h8',
    cosmetic: 'm12 2 3 6 7 2-5 5 1 7-6-3-6 3 1-7-5-5 7-2z',
    discovery: 'm3 5 6-3 6 3 6-3v17l-6 3-6-3-6 3zM9 2v17m6-14v17',
    currency: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v12M15 8H10a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H9',
    item: 'm12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5m-9 5v9',
  };
  function create(icon, { className = '', category = '', document = globalThis.document } = {}) {
    const wrapper = document.createElement('span');
    wrapper.className = `item-thumbnail${className ? ' ' + className : ''}`;
    wrapper.setAttribute('aria-hidden', 'true');
    const type = String(category).toLowerCase();
    const kind = /weapon|melee|ranged|sidearm/.test(type) ? 'weapon' : /armor|armour/.test(type) ? 'armor'
      : /soul|pact/.test(type) ? 'soul' : /cosmetic/.test(type) ? 'cosmetic'
        : /discovery|location|tree/.test(type) ? 'discovery' : /currency/.test(type) ? 'currency' : 'item';
    const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    fallback.setAttribute('class', 'item-thumbnail-fallback'); fallback.setAttribute('viewBox', '0 0 24 24');
    fallback.setAttribute('fill', 'none'); fallback.setAttribute('stroke', 'currentColor');
    fallback.setAttribute('stroke-width', '1.3'); fallback.setAttribute('stroke-linejoin', 'round');
    fallback.setAttribute('stroke-linecap', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', symbols[kind]); fallback.appendChild(path); wrapper.appendChild(fallback);
    const defaultArtwork = /color palette|colour palette/.test(type) ? '/SF/Interface/Graphics/ColourCustomization/PaletteSwatchRaggedClean.png'
      : /tree/.test(type) ? '/SF/Interface/Graphics/WaypointMarkers/Tree.png'
        : /discovery|location/.test(type) ? '/SF/Interface/Graphics/WaypointMarkers/MapLocation.png' : null;
    const url = imageUrl(icon) || (!icon ? imageUrl(defaultArtwork) : null);
    if (url) {
      const img = document.createElement('img'); img.className = 'item-thumbnail-image';
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => { wrapper.classList.add('is-loaded'); }, { once: true });
      img.addEventListener('error', () => { img.hidden = true; wrapper.classList.remove('is-loaded'); wrapper.classList.add('is-missing'); }, { once: true });
      wrapper.appendChild(img); img.src = url;
    } else wrapper.classList.add('is-missing');
    return wrapper;
  }
  return Object.freeze({ IMAGE_ORIGIN, imageUrl, create });
});
