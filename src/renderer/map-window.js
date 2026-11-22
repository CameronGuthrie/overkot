// ═══════════════════════════════════════════════════════════════
// Expanded Map Window – canvas-based tile renderer
// ═══════════════════════════════════════════════════════════════

const TILE_SIZE  = 512;
const GRID_COLS  = 14;
const GRID_ROWS  = 14;
const MAP_PX_W   = GRID_COLS * TILE_SIZE; // 7168
const MAP_PX_H   = GRID_ROWS * TILE_SIZE;
const ZONE_GRID_SIZE = 3584;
const ZONE_ORIGIN    = 1792;
const TOTAL_TILES    = GRID_COLS * GRID_ROWS; // 196

const container  = document.getElementById('map-container');
const canvas     = document.getElementById('map-canvas');
const ctx        = canvas.getContext('2d');
const updateTileStatus = window.MapAppearance.bindTileStatus(document.getElementById('map-loading'), () => window.api.openSettings('connections'));
const coordRead  = document.getElementById('coord-readout');
const tooltipEl  = document.getElementById('map-tooltip');

const tileImages = [];
const tileUsed = new Map();
let tilesLoaded  = 0;
let mapLabels = {};
let mapTilesVersion = '';
let mapTilesSource = 'bundled';
let mapTilesRequireSignIn = false;
let mapInfoLoaded = false;
let zoom         = 1;
let panX         = 0, panY = 0;
let dragging     = false;
let dragStartX   = 0, dragStartY = 0;
let panStartX    = 0, panStartY  = 0;
let followingPlayer = true, followContext = null, viewInitialized = false;
let worldBlocked = false, worldEntry = null;
const MIN_ZOOM   = 0.03;
const MAX_ZOOM   = 4;
let renderScheduled = false;

function mapTileUrl(idx) {
  const version = mapTilesVersion ? `?v=${encodeURIComponent(mapTilesVersion)}` : '';
  return `overkot-map-tiles://tile/${idx}.webp${version}`;
}

function applyMapTileInfo(info) {
  const nextVersion = info && info.version ? String(info.version) : '';
  const nextSource = info && info.source ? String(info.source) : 'bundled';
  const requiresSignIn = info?.requiresSignIn === true;
  const sameFeed = mapInfoLoaded && nextVersion === mapTilesVersion && nextSource === mapTilesSource;
  if (!info?.reload && sameFeed && requiresSignIn === mapTilesRequireSignIn) return;
  mapInfoLoaded = true;
  mapTilesVersion = nextVersion;
  mapTilesSource = nextSource;
  mapTilesRequireSignIn = requiresSignIn;
  if (nextVersion && !requiresSignIn) MapPOIs.retryMissingLegendIcons(legendPanel);
  if (sameFeed && !info?.reload && requiresSignIn) scheduleRender();
  else { loadTiles(sameFeed && !info?.reload); loadMapPOIs(); }
}

// Player location marker
let playerMarker = null; // { px, py, heading }
let playerLocationRevision = 0, playerExpiryTimer = null;
let headingContext = null;
let appearanceConfig = {}, appearanceRevision = 0;
const playerHeadingMotion = window.PlayerMarkerMotion.createPlayerMarkerMotion();
const worldDropLayer = window.WorldDropMarkers?.create({ requestRender: () => scheduleRender() });
const centerPlayerButton = document.getElementById('center-player-btn');
const ancestorLayer = AncestorMarkers.create({ requestRender: () => {
  if (tooltipEl) tooltipEl.classList.remove('visible');
  scheduleRender();
} });


// Map POI icons
let mapPOIs = [];        // [{ px, py, img, size, shadow, category }]
let mapPOIsLoaded = false;
let mapPOILoadGeneration = 0;

// ── Legend / POI visibility ──────────────────────────────────
const LEGEND_CATEGORIES = [
  { key: 'enclaves',  icon: 'ChampionFaction.webp', translationKey: 'legendEnclaves' },
  { key: 'trees',     icon: 'Tree.webp',            translationKey: 'legendWorldTrees' },
  { key: 'avakot',    icon: 'Vendor.webp',           translationKey: 'legendAvakotVendors' },
  { key: 'sap',       icon: 'Pickup.webp',            translationKey: 'legendWevetwoodSap' },
  { key: 'vadagar',   icon: 'Stag.webp',              translationKey: 'legendVadagarPools' },
  { key: 'organs',    icon: 'Tower.webp',              translationKey: 'legendOdeOrgans' },
  { key: 'bosses',    icon: 'SubBossBarTopper.webp',   translationKey: 'legendBossEncounters' },
  { key: 'dungeons',  icon: 'EntranceDown.webp',       translationKey: 'legendDungeons' },
  { key: 'locations', icon: 'MapLocationComplete.webp', translationKey: 'legendLocations' },
];
let poiVisibility = {};  // { enclaves: true, trees: true, … }
LEGEND_CATEGORIES.forEach(c => { poiVisibility[c.key] = true; });

// Restore saved visibility from config
(async () => {
  if (window.api && window.api.getState) {
    try {
      const revision = appearanceRevision;
      const state = await window.api.getState();
      const cfg = state && state.config;
      if (cfg && revision === appearanceRevision) { appearanceConfig = { ...cfg }; scheduleRender(); }
      if (cfg && cfg.poiVisibility) {
        for (const k of Object.keys(poiVisibility)) {
          if (typeof cfg.poiVisibility[k] === 'boolean') poiVisibility[k] = cfg.poiVisibility[k];
        }
      }
    } catch (_) {}
  }
})();

function worldToMapPixel(worldX, worldZ) {
  return MapPOIs.worldToMapPixel(worldX, worldZ);
}

function drawPlayerPin(ctx, mapPx, mapPy, scale, heading) {
  window.MapAppearance.drawPlayerMarker(ctx, { x: mapPx, y: mapPy, heading,
    color: window.MapAppearance.playerColor(appearanceConfig), outlineColor: window.MapAppearance.playerOutlineColor(appearanceConfig),
    scale: 1 / Math.max(scale, 0.06) });
}

function drawPlayerEdgeIndicator(ctx, clampedPx, clampedPy, realPx, realPy, scale) {
  const s = 1 / Math.max(scale, 0.06);
  const size = 10 * s;
  const angle = Math.atan2(realPy - clampedPy, realPx - clampedPx);

  ctx.save();
  ctx.translate(clampedPx, clampedPy);
  ctx.rotate(angle);

  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, -size * 0.7);
  ctx.lineTo(-size * 0.6,  size * 0.7);
  ctx.closePath();

  ctx.fillStyle = window.MapAppearance.playerColor(appearanceConfig);
  ctx.fill();
  ctx.lineWidth = 2 * s;
  ctx.strokeStyle = window.MapAppearance.playerOutlineColor(appearanceConfig);
  ctx.stroke();

  ctx.restore();
}

// Column-major, Z-flipped tile layout
function getTilePos(idx) {
  return MapPOIs.getTilePos(idx);
}

function scheduleRender() {
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      render();
    });
  }
}

// ── Overlap spreading: nudge overlapping POIs apart ──────────
// Returns an array of { px, py } displaced positions parallel to mapPOIs.
// Higher-zOrder POIs stay closer to their true position.
let lastSpreadZoom = -1;
let cachedSpread = [];

// ── Pre-rendered POI stamps (bake glow/shadow once) ──────────
const stampCache = {};
const STAMP_PAD = 32;

function buildPOIStamp(img, hasShadow) {
  const key = img.src + (hasShadow ? '_s' : '');
  if (stampCache[key]) return stampCache[key];

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const cw = iw + STAMP_PAD * 2;
  const ch = ih + STAMP_PAD * 2;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const sx = c.getContext('2d');

  // Glow pass
  sx.shadowColor = 'rgba(255, 255, 255, 0.4)';
  sx.shadowBlur = 8;
  sx.shadowOffsetX = 0;
  sx.shadowOffsetY = 0;
  sx.drawImage(img, STAMP_PAD, STAMP_PAD, iw, ih);

  // Drop shadow pass
  if (hasShadow) {
    sx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    sx.shadowBlur = 16;
    sx.shadowOffsetX = 0;
    sx.shadowOffsetY = 6;
    sx.drawImage(img, STAMP_PAD, STAMP_PAD, iw, ih);
  }

  const stamp = { canvas: c, pad: STAMP_PAD, iw, ih };
  stampCache[key] = stamp;
  return stamp;
}

function computeSpreadPositions(pois, currentZoom) {
  // Cache: only recompute when zoom changes meaningfully
  if (Math.abs(currentZoom - lastSpreadZoom) < currentZoom * 0.01 && cachedSpread.length === pois.length) {
    return cachedSpread;
  }
  lastSpreadZoom = currentZoom;

  const positions = pois.map(p => ({ px: p.px, py: p.py }));

  // Separation factor: full spread when zoomed out, reduced when zoomed in
  // so nearby icons still nudge apart without drifting far from true position
  const spreadFactor = currentZoom > 0.15 ? 0.25 : 0.4;

  // Minimum distance between icon centers (in map pixels)
  // Match the displayed icon sizes, including the smaller overview markers.
  const iterations = 3;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < pois.length; i++) {
      for (let j = i + 1; j < pois.length; j++) {
        const ri = MapPOIs.iconSize(pois[i], currentZoom) / currentZoom * spreadFactor;
        const rj = MapPOIs.iconSize(pois[j], currentZoom) / currentZoom * spreadFactor;
        const minDist = ri + rj;

        const dx = positions[j].px - positions[i].px;
        const dy = positions[j].py - positions[i].py;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDist && dist > 0.001) {
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;

          // Higher zOrder POIs move less (they're more important)
          const wi = pois[i].zOrder >= 2 ? 0.2 : 1;
          const wj = pois[j].zOrder >= 2 ? 0.2 : 1;
          const total = wi + wj;

          positions[i].px -= nx * overlap * (wi / total);
          positions[i].py -= ny * overlap * (wi / total);
          positions[j].px += nx * overlap * (wj / total);
          positions[j].py += ny * overlap * (wj / total);
        } else if (dist <= 0.001) {
          // Exactly same position — push apart arbitrarily
          positions[j].px += minDist * 0.5;
          positions[i].px -= minDist * 0.5;
        }

        // Clamp: don't let icons drift too far from their true position
        const maxDrift = 80 / currentZoom;
        const dxi = positions[i].px - pois[i].px;
        const dyi = positions[i].py - pois[i].py;
        const di = Math.sqrt(dxi * dxi + dyi * dyi);
        if (di > maxDrift) {
          positions[i].px = pois[i].px + (dxi / di) * maxDrift;
          positions[i].py = pois[i].py + (dyi / di) * maxDrift;
        }
        const dxj = positions[j].px - pois[j].px;
        const dyj = positions[j].py - pois[j].py;
        const dj = Math.sqrt(dxj * dxj + dyj * dyj);
        if (dj > maxDrift) {
          positions[j].px = pois[j].px + (dxj / dj) * maxDrift;
          positions[j].py = pois[j].py + (dyj / dj) * maxDrift;
        }
      }
    }
  }

  cachedSpread = positions;
  return positions;
}

function render() {
  if (document.hidden) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  initializeView();
  if (followingPlayer && hasLivePlayerPosition()) updatePlayerCenter();

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // Viewport culling
  const viewLeft   = -panX / zoom;
  const viewTop    = -panY / zoom;
  const viewRight  = viewLeft + w / zoom;
  const viewBottom = viewTop  + h / zoom;

  let painted = 0, failed = false;
  const visibleTiles = new Set();
  for (let idx = 0; idx < TOTAL_TILES; idx++) {
    const pos = getTilePos(idx);
    if (pos.x + TILE_SIZE < viewLeft || pos.x > viewRight ||
        pos.y + TILE_SIZE < viewTop  || pos.y > viewBottom) continue;
    visibleTiles.add(idx);
    const img = ensureTile(idx);
    if (img.complete && img.naturalWidth > 0) {
      painted++;
      ctx.drawImage(img, pos.x, pos.y, TILE_SIZE, TILE_SIZE);
    } else if (img.tileFailed) failed = true;
  }
  updateTileStatus(mapLabels, {
    visible: visibleTiles.size, painted, failed, requiresSignIn: mapTilesRequireSignIn,
  });
  const keepCount = Math.max(64, visibleTiles.size);
  const retired = [...tileUsed.keys()].filter(idx => !visibleTiles.has(idx))
    .sort((a, b) => tileUsed.get(a) - tileUsed.get(b));
  while (tileUsed.size > keepCount && retired.length) {
    const idx = retired.shift();
    const image = tileImages[idx];
    if (image) { image.onload = null; image.onerror = null; image.src = ''; }
    delete tileImages[idx];
    tileUsed.delete(idx);
  }

  // Draw map POI icons
  if (mapPOIsLoaded) {
    // Compute spread positions to reduce overlap at low zoom
    const visiblePOIs = mapPOIs.filter(poi => poiVisibility[poi.category]);
    const spreadPOIs = computeSpreadPositions(visiblePOIs, zoom);

    for (let i = 0; i < visiblePOIs.length; i++) {
      const poi = visiblePOIs[i];
      if (!poi.img || !poi.img.complete || poi.img.naturalWidth === 0) continue;
      if (poi.category && !poiVisibility[poi.category]) continue;
      const sp = spreadPOIs[i];
      const isHovered = (poi === hoveredPOI);
      const baseSize = MapPOIs.iconSize(poi, zoom) / zoom;
      const iconSize = isHovered ? baseSize * 1.35 : baseSize;
      const ix = sp.px - iconSize / 2;
      const iy = sp.py - iconSize / 2;
      if (ix + iconSize < viewLeft || ix > viewRight ||
          iy + iconSize < viewTop || iy > viewBottom) continue;
      // Draw pre-rendered stamp (glow + shadow baked in)
      const stamp = buildPOIStamp(poi.img, poi.shadow);
      const stampScale = iconSize / stamp.iw;
      ctx.drawImage(stamp.canvas,
        ix - stamp.pad * stampScale, iy - stamp.pad * stampScale,
        stamp.canvas.width * stampScale, stamp.canvas.height * stampScale);
    }
  }


  // Keep ancestor dots on the same world transform as the tiles and player.
  if (ancestorLayer.draw(ctx, {
    width: w, height: h,
    project: (x, z) => {
      const point = worldToMapPixel(x, z);
      return { x: panX + point.px * zoom, y: panY + point.py * zoom };
    },
  })) scheduleRender();

  worldDropLayer?.draw(ctx, {
    width: w, height: h, enabled: appearanceConfig.showWorldDrops !== false,
    project: (x, z) => {
      const point = worldToMapPixel(x, z);
      return { x: panX + point.px * zoom, y: panY + point.py * zoom };
    },
  });

  // Draw player marker pin (always on top, clamped to edge when off-screen)
  if (playerMarker && !hasLivePlayerPosition()) clearPlayerMarker();
  if (playerMarker) {
    const ppx = playerMarker.px;
    const ppy = playerMarker.py;
    const margin = 18 / zoom;
    const inView = ppx >= viewLeft + margin && ppx <= viewRight - margin &&
                   ppy >= viewTop + margin && ppy <= viewBottom - margin;
    if (inView) {
      const facing = playerHeadingMotion.sample();
      drawPlayerPin(ctx, ppx, ppy, zoom, facing.heading);
      if (facing.animating) scheduleRender();
    } else {
      const cx = Math.max(viewLeft + margin, Math.min(viewRight - margin, ppx));
      const cy = Math.max(viewTop + margin, Math.min(viewBottom - margin, ppy));
      drawPlayerEdgeIndicator(ctx, cx, cy, ppx, ppy, zoom);
    }
  }

  ctx.restore();
}

function fitToView() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  followingPlayer = false; viewInitialized = true;
  zoom = Math.min(w / MAP_PX_W, h / MAP_PX_H) * 0.95;
  panX = (w - MAP_PX_W * zoom) / 2;
  panY = (h - MAP_PX_H * zoom) / 2;
  updateCenterPlayerButton();
  scheduleRender();
}

function initializeView() {
  if (viewInitialized || !container.clientWidth || !container.clientHeight) return false;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, window.MapAppearance.DEFAULT_OVERWORLD_ZOOM));
  panX = (container.clientWidth - MAP_PX_W * zoom) / 2;
  panY = (container.clientHeight - MAP_PX_H * zoom) / 2;
  viewInitialized = true;
  return true;
}

function zoomAt(factor, cx, cy) {
  initializeView();
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const ratio   = newZoom / zoom;
  panX = cx - (cx - panX) * ratio;
  panY = cy - (cy - panY) * ratio;
  zoom = newZoom;
  if (followingPlayer && hasLivePlayerPosition()) updatePlayerCenter();
  scheduleRender();
}

function pixelToWorld(px, py) {
  const mapX = (px / MAP_PX_W) * ZONE_GRID_SIZE - ZONE_ORIGIN;
  const mapZ = ZONE_ORIGIN - (py / MAP_PX_H) * ZONE_GRID_SIZE;
  return { x: Math.round(mapX), z: Math.round(mapZ) };
}

// ── Tile loading ──────────────────────────────────────────────

// ─── Map POI icon loading ────────────────────────────────────

// Hovered POI reference (for enlargement).
let hoveredPOI = null;

async function loadMapPOIs() {
  const generation = ++mapPOILoadGeneration;
  const current = () => generation === mapPOILoadGeneration;
  const markers = await MapPOIs.load(window.api, current);
  if (!current()) return;
  const images = new Map();
  const nextPOIs = markers.map(marker => {
    if (!images.has(marker.icon)) {
      const img = new Image();
      // One pair of handlers per icon, independent of marker count.
      img.addEventListener('load', () => { if (current()) scheduleRender(); }, { once: true });
      img.addEventListener('error', () => { if (current()) scheduleRender(); }, { once: true });
      img.src = `overkot-map-tiles://data/map-icons/${marker.icon.replace(/\.webp$/, '.png')}?v=${encodeURIComponent(mapTilesVersion)}`;
      images.set(marker.icon, img);
    }
    return { ...marker, img: images.get(marker.icon) };
  });
  mapPOIs = nextPOIs;
  for (const key of Object.keys(stampCache)) delete stampCache[key];
  lastSpreadZoom = -1;
  hoveredPOI = null;
  if (tooltipEl) tooltipEl.classList.remove('visible');
  mapPOIsLoaded = true;
  scheduleRender();
}

function loadTiles(keepDecoded = false) {
  tilesLoaded = 0;
  tileImages.forEach((image, idx) => {
    if (keepDecoded && image.complete && image.naturalWidth > 0) { tilesLoaded++; return; }
    image.onload = null; image.onerror = null; image.src = '';
    delete tileImages[idx];
    tileUsed.delete(idx);
  });
  scheduleRender();
}

function ensureTile(idx) {
  tileUsed.set(idx, performance.now());
  if (tileImages[idx]) return tileImages[idx];
  const img = new Image();
  tileImages[idx] = img;
  img.onload = () => {
    if (tileImages[idx] !== img) return;
    tilesLoaded++;
    scheduleRender();
  };
  img.onerror = () => {
    if (tileImages[idx] !== img) return;
    img.tileFailed = true;
    scheduleRender();
  };
  img.src = mapTileUrl(idx);
  return img;
}

// ── Pointer drag (pan) ───────────────────────────────────────

container.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // Don't start dragging when clicking on control buttons
  if (e.target.closest('.map-ctrl-btn, .map-coord-readout, .map-legend-panel')) return;
  initializeView();
  dragging   = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  panStartX  = panX;
  panStartY  = panY;
  container.setPointerCapture(e.pointerId);
});

function showMapTooltip(text, x, y) {
  tooltipEl.textContent = text;
  tooltipEl.classList.add('visible');
  tooltipEl.style.left = Math.max(4, Math.min(container.clientWidth - tooltipEl.offsetWidth - 4, x + 14)) + 'px';
  tooltipEl.style.top = Math.max(4, Math.min(container.clientHeight - tooltipEl.offsetHeight - 4, y - tooltipEl.offsetHeight - 8)) + 'px';
}

container.addEventListener('pointermove', (e) => {
  // Coordinate readout
  const rect = container.getBoundingClientRect();
  const mx   = (e.clientX - rect.left - panX) / zoom;
  const my   = (e.clientY - rect.top  - panY) / zoom;
  const wc   = pixelToWorld(mx, my);
  if (coordRead) coordRead.textContent = `X: ${wc.x}  Z: ${wc.z}`;

  const ancestorTitle = !dragging && ancestorLayer.titleAt(e.clientX - rect.left, e.clientY - rect.top);
  if (ancestorTitle && tooltipEl) {
    if (hoveredPOI) { hoveredPOI = null; scheduleRender(); }
    showMapTooltip(ancestorTitle, e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  // POI hover tooltip (only when not dragging)
  if (!dragging && tooltipEl && mapPOIsLoaded) {
    let hit = null;
    const visiblePOIs = mapPOIs.filter(poi => poiVisibility[poi.category]);
    const spreadPos = computeSpreadPositions(visiblePOIs, zoom);
    // Iterate in reverse so higher z-order (drawn on top) gets hit priority
    for (let i = visiblePOIs.length - 1; i >= 0; i--) {
      const poi = visiblePOIs[i];
      if (!poi.label) continue;
      if (poi.category && !poiVisibility[poi.category]) continue;
      const sp = spreadPos[i];
      const iconSize = MapPOIs.iconSize(poi, zoom) / zoom;
      const dx = mx - sp.px;
      const dy = my - sp.py;
      if (Math.abs(dx) <= iconSize / 2 && Math.abs(dy) <= iconSize / 2) {
        hit = poi;
        break;
      }
    }
    if (hit !== hoveredPOI) {
      hoveredPOI = hit;
      scheduleRender();
    }
    if (hit) {
      showMapTooltip(MapPOIs.title(hit), e.clientX - rect.left, e.clientY - rect.top);
    } else {
      tooltipEl.classList.remove('visible');
    }
  } else if (tooltipEl) {
    if (hoveredPOI) { hoveredPOI = null; scheduleRender(); }
    tooltipEl.classList.remove('visible');
  }

  if (!dragging) return;
  if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) <= 4) return;
  if (followingPlayer) { followingPlayer = false; updateCenterPlayerButton(); }
  panX = panStartX + (e.clientX - dragStartX);
  panY = panStartY + (e.clientY - dragStartY);
  scheduleRender();
});

container.addEventListener('pointerleave', () => {
  if (tooltipEl) tooltipEl.classList.remove('visible');
  if (hoveredPOI) { hoveredPOI = null; scheduleRender(); }
});

container.addEventListener('pointerup',     () => { dragging = false; });
container.addEventListener('pointercancel', () => { dragging = false; });

// ── Mouse wheel zoom ─────────────────────────────────────────

container.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect   = container.getBoundingClientRect();
  const cx     = e.clientX - rect.left;
  const cy     = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  zoomAt(factor, cx, cy);
}, { passive: false });

// ── Button controls ──────────────────────────────────────────

document.getElementById('zoom-in-btn').addEventListener('click', () => {
  zoomAt(1.5, container.clientWidth / 2, container.clientHeight / 2);
});
document.getElementById('zoom-out-btn').addEventListener('click', () => {
  zoomAt(1 / 1.5, container.clientWidth / 2, container.clientHeight / 2);
});
document.getElementById('zoom-fit-btn').addEventListener('click', () => {
  fitToView();
});
centerPlayerButton?.addEventListener('click', () => {
  playerLocationRevision++;
  centerOnPlayer(); updateCenterPlayerButton();
});

// ── Titlebar close button ────────────────────────────────────

document.getElementById('close-btn').addEventListener('click', () => {
  window.api.windowClose();
});

// Events outrank the initial asynchronous snapshot, including context resets.
function hasLivePlayerPosition() {
  const age = Date.now() - playerMarker?.sampledAt;
  return playerMarker?.source === 'memory' && Number.isFinite(playerMarker.sampledAt)
    && age >= 0 && age <= 2000 && Number.isFinite(playerMarker.px) && Number.isFinite(playerMarker.py);
}
function updateCenterPlayerButton() {
  container.dataset.following = String(followingPlayer);
  if (!centerPlayerButton) return;
  const available = hasLivePlayerPosition();
  centerPlayerButton.disabled = !available;
  centerPlayerButton.title = available
    ? followingPlayer ? mapLabels.mapFollowingDrag || 'Following player · drag to explore' : mapLabels.mapCenterPlayer || 'Center on player'
    : mapLabels.mapWaitingLivePosition || 'Waiting for live player position';
  centerPlayerButton.setAttribute('aria-label', centerPlayerButton.title);
  centerPlayerButton.setAttribute('aria-disabled', String(!available));
  centerPlayerButton.setAttribute('aria-pressed', String(followingPlayer));
}
function updatePlayerCenter() {
  if (!hasLivePlayerPosition()) return false;
  if (!container.clientWidth || !container.clientHeight) return false;
  panX = container.clientWidth / 2 - playerMarker.px * zoom;
  panY = container.clientHeight / 2 - playerMarker.py * zoom;
  return true;
}
function centerOnPlayer() {
  if (!hasLivePlayerPosition()) { clearPlayerMarker(); return false; }
  initializeView(); followingPlayer = true; updateCenterPlayerButton();
  if (!updatePlayerCenter()) return false;
  scheduleRender(); return true;
}
function clearPlayerMarker() {
  if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
  playerHeadingMotion.reset(); headingContext = null;
  playerExpiryTimer = null; playerMarker = null; worldDropLayer?.clear(); updateCenterPlayerButton(); scheduleRender();
}
function receivePlayerLocation(data) {
  // Area notifications can overtake a queued live sample. Once the current
  // world entry is known, only that entry may move this map or restore its pin.
  if (worldBlocked || data?.status === 'found' && worldEntry !== null && data.instanceId !== worldEntry) return;
  const memory = data?.source === 'memory', age = Date.now() - data?.sampledAt;
  const valid = data?.status === 'found' && memory && data.isOverworld === true
    && /(?:^|\/)MidrathRedux(?:\.level)?$/.test(data.zone || '') && MapPOIs.validPosition(data.position)
    && (data.heading == null || Number.isFinite(data.heading))
    && Number.isFinite(data.sampledAt) && age >= 0 && age <= 2000;
  if (!valid) { clearPlayerMarker(); return; }
  if (playerMarker && data.trackingSession === playerMarker.trackingSession
    && data.instanceId === playerMarker.instanceId && data.sampledAt < playerMarker.sampledAt) return;
  worldDropLayer?.update(data);
  if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
  playerExpiryTimer = null;
  const mp = worldToMapPixel(data.position.x, data.position.z);
  const context = JSON.stringify([data.trackingSession, data.instanceId]);
  if (followContext !== null && context !== followContext) followingPlayer = true;
  followContext = context;
  playerHeadingMotion.setHeading(data.heading ?? null, { immediate: context !== headingContext });
  headingContext = context;
  playerMarker = { px: mp.px, py: mp.py, heading: data.heading ?? null,
    source: 'memory', sampledAt: data.sampledAt, instanceId: data.instanceId, trackingSession: data.trackingSession };
  initializeView();
  if (followingPlayer) updatePlayerCenter();
  updateCenterPlayerButton(); scheduleRender();
  if (memory) {
    const marker = playerMarker;
    playerExpiryTimer = setTimeout(() => { if (marker === playerMarker) clearPlayerMarker(); }, 2001 - age);
  }
}
const playerLocationSubscriptions = [];
if (window.api?.onPlayerLocation) playerLocationSubscriptions.push(window.api.onPlayerLocation(data => {
  playerLocationRevision++; receivePlayerLocation(data);
}));
if (window.api?.onDungeonStateChanged) playerLocationSubscriptions.push(window.api.onDungeonStateChanged(state => {
  playerLocationRevision++;
  const outside = state?.active === false && state.status === 'outside'
    && ['/SF/Levels/MidrathRedux', '/SF/Levels/Procs/MidrathProc'].includes(state.levelPath?.replace(/\.level$/, ''));
  const entry = outside ? state.instanceId || null : null;
  const wasBlocked = worldBlocked, changedEntry = worldEntry !== null && worldEntry !== entry;
  worldBlocked = !outside; worldEntry = entry;
  if (!outside || wasBlocked || changedEntry || (playerMarker && entry && playerMarker.instanceId !== entry)) {
    followingPlayer = true; followContext = null; clearPlayerMarker();
  }
}));
updateCenterPlayerButton();
if (window.api?.getPlayerLocation) {
  const revision = playerLocationRevision;
  Promise.resolve(window.api.getPlayerLocation()).then(data => {
    if (revision === playerLocationRevision) receivePlayerLocation(data);
  }).catch(() => {});
}
window.addEventListener('unload', () => {
  playerLocationRevision++; clearPlayerMarker();
  for (const unsubscribe of playerLocationSubscriptions) if (typeof unsubscribe === 'function') unsubscribe();
}, { once: true });

ancestorLayer.connect(window.api);

// ── Resize handling ──────────────────────────────────────────

window.addEventListener('resize', () => {
  initializeView();
  if (followingPlayer) updatePlayerCenter();
  scheduleRender();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });

// ── Legend panel ─────────────────────────────────────────────

const legendPanel = document.getElementById('map-legend-panel');
const legendBtn   = document.getElementById('legend-btn');
const legendTitle = document.getElementById('map-legend-title');

// SVG eye icons (inline to avoid extra asset files)
const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;color:#a0a0c0"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_CLOSED_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;color:#a0a0c0"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function buildLegendRows(lang) {
  const t = typeof TRANSLATIONS === 'undefined' ? {} : { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
  mapLabels = t;
  document.title = t.mapWorldTitle || 'Midrath – World Map';
  document.getElementById('world-map-title').textContent = document.title;
  scheduleRender();
  for (const [id, label] of [
    ['close-btn', t.tooltipClose || 'Close'], ['zoom-in-btn', t.mapZoomIn || 'Zoom in'],
    ['zoom-out-btn', t.mapZoomOut || 'Zoom out'], ['zoom-fit-btn', t.mapFitView || 'Fit to view'],
    ['legend-btn', t.mapLegend || 'Map Legend'],
  ]) {
    const button = document.getElementById(id);
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  updateCenterPlayerButton();
  if (legendTitle) legendTitle.textContent = t.mapLegend || 'Map Legend';

  // Remove old rows (keep the title)
  legendPanel.querySelectorAll('.map-legend-row').forEach(el => el.remove());

  for (const cat of LEGEND_CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'map-legend-row' + (poiVisibility[cat.key] ? '' : ' hidden-cat');
    row.dataset.cat = cat.key;

    const icon = document.createElement('img');
    icon.className = 'map-legend-icon';
    icon.src = `overkot-map-tiles://data/map-icons/${cat.icon.replace(/\.webp$/, ".png")}`;
    icon.alt = '';

    const label = document.createElement('span');
    label.className = 'map-legend-label';
    label.textContent = t[cat.translationKey] || cat.key;

    const eye = document.createElement('span');
    eye.className = 'map-legend-eye';
    eye.innerHTML = poiVisibility[cat.key] ? EYE_OPEN_SVG : EYE_CLOSED_SVG;

    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(eye);

    row.addEventListener('click', () => {
      poiVisibility[cat.key] = !poiVisibility[cat.key];
      row.classList.toggle('hidden-cat', !poiVisibility[cat.key]);
      eye.innerHTML = poiVisibility[cat.key] ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
      // Invalidate spread cache so hidden POIs don't affect layout
      lastSpreadZoom = -1;
      scheduleRender();
      // Persist
      if (window.api && window.api.saveConfig) {
        window.api.saveConfig({ poiVisibility });
      }
    });

    legendPanel.appendChild(row);
  }
}

// Toggle legend panel open/close
legendBtn.addEventListener('click', () => {
  legendPanel.classList.toggle('open');
});

// Close legend when clicking outside
document.addEventListener('pointerdown', (e) => {
  if (legendPanel.classList.contains('open') &&
      !legendPanel.contains(e.target) &&
      e.target !== legendBtn) {
    legendPanel.classList.remove('open');
  }
});

// Build legend with correct language
let mapLanguage = 'en';
(async () => {
  let lang = 'en';
  if (window.api && window.api.getState) {
    try {
      const state = await window.api.getState();
      if (state && state.config && state.config.language) lang = state.config.language;
    } catch (_) {}
  }
  mapLanguage = lang;
  buildLegendRows(lang);
})();

if (window.api?.onMapLanguageUpdated) {
  window.api.onMapLanguageUpdated(locale => {
    if (locale === mapLanguage) loadMapPOIs();
  });
}
if (window.api?.onConfigChanged) {
  window.api.onConfigChanged(config => {
    const previousColor = window.MapAppearance.playerColor(appearanceConfig);
    const previousOutline = window.MapAppearance.playerOutlineColor(appearanceConfig);
    const previousDrops = appearanceConfig.showWorldDrops;
    appearanceRevision++; appearanceConfig = { ...appearanceConfig, ...config };
    if (window.MapAppearance.playerColor(appearanceConfig) !== previousColor
      || window.MapAppearance.playerOutlineColor(appearanceConfig) !== previousOutline
      || appearanceConfig.showWorldDrops !== previousDrops) scheduleRender();
    let changed = false;
    if (typeof config.language === 'string' && config.language !== mapLanguage) {
      mapLanguage = config.language;
      loadMapPOIs();
      changed = true;
    }
    for (const key of Object.keys(poiVisibility)) {
      const next = config.poiVisibility?.[key];
      if (typeof next === 'boolean' && next !== poiVisibility[key]) {
        poiVisibility[key] = next;
        changed = true;
      }
    }
    if (changed) {
      lastSpreadZoom = -1;
      buildLegendRows(mapLanguage);
      scheduleRender();
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────

if (window.api && window.api.getMapTiles) {
  window.api.getMapTiles().then(info => {
    if (!mapInfoLoaded) applyMapTileInfo(info);
  }).catch(() => { if (!mapInfoLoaded) applyMapTileInfo(null); });
} else applyMapTileInfo(null);
if (window.api && window.api.onMapTilesUpdated) {
  window.api.onMapTilesUpdated(applyMapTileInfo);
}
requestAnimationFrame(() => {
  initializeView();
  if (followingPlayer) updatePlayerCenter();
  scheduleRender();
});
