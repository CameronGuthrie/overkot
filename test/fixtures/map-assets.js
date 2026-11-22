'use strict';

// A single solid RGB(31, 44, 50) square encoded as a 512 × 512 lossless WebP.
const tile = Buffer.from('UklGRi4AAABXRUJQVlA4TCIAAAAv/8F/AAdQln5Upv8BgUCyv/cMRfQ/4z//+c9//vOf//wf', 'base64');
// The renderer rasterizes map marker PNGs into canvas stamps. Use an 8 × 8 yellow square.
const marker = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGP8dViRARtgwio6aCUAeaQB7rSxUssAAAAASUVORK5CYII=', 'base64');

function serveMapAsset(request) {
  const url = new URL(request.url);
  if (url.hostname === 'data' && /^\/map-icons\/[A-Za-z]+\.png$/.test(url.pathname)) {
    return new Response(marker, { headers: { 'Content-Type': 'image/png' } });
  }
  const match = /^\/(0|[1-9]\d{0,2})\.webp$/.exec(url.pathname);
  if (url.hostname !== 'tile' || !match || Number(match[1]) >= 196) {
    return new Response('Unknown fixture tile', { status: 404 });
  }
  return new Response(tile, { headers: { 'Content-Type': 'image/webp' } });
}

module.exports = { tile, serveMapAsset };
