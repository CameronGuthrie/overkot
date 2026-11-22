/**
 * Minimap — Shared canvas-based tile map renderer
 *
 * Used by both renderer.js (main overlay) and widget-host.js (standalone widget).
 * Provides tile rendering, POI loading/drawing, player pin, overlap spreading,
 * pan/zoom controls, legend panel, and live player centering.
 *
 * Consumers call Minimap.init(options) to bootstrap, and can access state via
 * the Minimap namespace (e.g. Minimap.playerMarker, Minimap.scheduleRender()).
 */

// ═══════════════════════════════════════════════════════════
// Minimap namespace (avoids polluting global scope)
// ═══════════════════════════════════════════════════════════

const Minimap = (() => {
  // ── Constants ────────────────────────────────────────────
  const TILE_SIZE   = 512;
  const GRID_COLS   = 14;
  const GRID_ROWS   = 14;
  const MAP_PX      = GRID_COLS * TILE_SIZE; // 7168
  const TOTAL_TILES = GRID_COLS * GRID_ROWS; // 196
  const MIN_ZOOM    = 0.03;
  const MAX_ZOOM    = 2;
  const STAMP_PAD   = 32;

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

  const MM_EYE_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;color:var(--text-muted)"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const MM_EYE_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;color:var(--text-muted)"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  // ── Mutable state ────────────────────────────────────────
  let inited = false;
  const tileImages = [];
  const tileUsed = new Map();
  let mapTilesVersion = '';
  let mapTilesSource = 'bundled';
  let mapTilesRequireSignIn = false;
  let mapInfoLoaded = false;
  let updateTileStatus;
  let zoom = window.MapAppearance.DEFAULT_OVERWORLD_ZOOM;
  let panX = 0, panY = 0;
  let dragging = false;
  let dragStartX = 0, dragStartY = 0;
  let panStartX = 0, panStartY = 0;
  let renderScheduled = false;
  let animationId = null;
  let viewInitialized = false, followingPlayer = true, followContext = null;
  let worldEntry = null, worldBlocked = false;

  let playerMarker = null; // { x, z, heading, isOverworld }
  let playerLocationRevision = 0, playerExpiryTimer = null, centeredTrackingSession = null;
  let headingContext = null, updateCenterButton = () => {};
  let appearanceConfig = {};
  const playerHeadingMotion = window.PlayerMarkerMotion.createPlayerMarkerMotion();
  const worldDropLayer = window.WorldDropMarkers?.create({ requestRender: () => scheduleRender() });
  const ancestorLayer = AncestorMarkers.create({ requestRender: () => {
    const viewport = _$('#minimap-viewport');
    if (viewport) viewport.title = '';
    scheduleRender();
  } });
  let locateState = 'idle'; // 'idle' | 'found'

  function hasLivePosition() {
    const age = Date.now() - playerMarker?.sampledAt;
    return playerMarker?.source === 'memory' && playerMarker.isOverworld === true
      && Number.isFinite(playerMarker.sampledAt) && age >= 0 && age <= 2000
      && MapPOIs.validPosition({ x: playerMarker.x, z: playerMarker.z });
  }
  function clearPlayerMarker() {
    if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
    stopAnimation(); playerHeadingMotion.reset(); headingContext = null;
    playerExpiryTimer = null; playerMarker = null; locateState = 'idle'; worldDropLayer?.clear();
    updateCenterButton(); scheduleRender();
  }
  function centerOnPlayer() {
    if (!hasLivePosition()) { clearPlayerMarker(); return false; }
    stopAnimation();
    followingPlayer = true;
    const centered = syncPlayerCenter();
    updateCenterButton(); scheduleRender(); return centered;
  }
  function initializeView() {
    const viewport = _$('#minimap-viewport');
    if (!viewport?.clientWidth || !viewport.clientHeight) return false;
    if (!viewInitialized) {
      panX = (viewport.clientWidth - MAP_PX * zoom) / 2;
      panY = (viewport.clientHeight - MAP_PX * zoom) / 2;
      viewInitialized = true;
    }
    return true;
  }
  function syncPlayerCenter() {
    if (!hasLivePosition() || !initializeView()) return false;
    const viewport = _$('#minimap-viewport');
    const point = worldToMapPixel(playerMarker.x, playerMarker.z);
    panX = viewport.clientWidth / 2 - point.px * zoom;
    panY = viewport.clientHeight / 2 - point.py * zoom;
    return true;
  }


  let pois = [];
  let poisLoaded = false;
  let poiVisibility = {};
  LEGEND_CATEGORIES.forEach(c => { poiVisibility[c.key] = true; });

  let lastSpreadZoom = -1;
  let cachedSpread = [];
  const stampCache = {};

  let mapLabels = {};
  let dungeonWidget = null;

  // Reference to $ helper (set during init)
  let _$ = (sel) => document.querySelector(sel);

  function mapTileUrl(idx) {
    const version = mapTilesVersion ? `?v=${encodeURIComponent(mapTilesVersion)}` : '';
    return `overkot-map-tiles://tile/${idx}.webp${version}`;
  }


  function loadTiles(keepDecoded = false) {
    tileImages.forEach((img, idx) => {
      if (keepDecoded && img.complete && img.naturalWidth > 0) return;
      img.onload = null; img.onerror = null; img.src = '';
      delete tileImages[idx];
      tileUsed.delete(idx);
    });
    scheduleRender();
  }

  function ensureTile(idx) {
    tileUsed.set(idx, performance.now());
    if (!tileImages[idx]) {
      const img = new Image();

      img.onload = () => {
        if (tileImages[idx] === img) scheduleRender();
      };
      img.onerror = () => {
        if (tileImages[idx] !== img) return;
        img.tileFailed = true;
        scheduleRender();
      };
      tileImages[idx] = img;
      img.src = mapTileUrl(idx);
    }
    return tileImages[idx];
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
    if (inited) {
      if (nextVersion && !requiresSignIn) MapPOIs.retryMissingLegendIcons(_$('#minimap-legend-panel'));
      if (sameFeed && !info?.reload && requiresSignIn) scheduleRender();
      else { loadTiles(sameFeed && !info?.reload); loadPOIs(); }
    }
  }

  // ── Coordinate conversion ────────────────────────────────
  function worldToMapPixel(worldX, worldZ) {
    return MapPOIs.worldToMapPixel(worldX, worldZ);
  }

  function getTilePos(idx) {
    return MapPOIs.getTilePos(idx);
  }

  // ── Render scheduling ────────────────────────────────────
  function scheduleRender() {
    if (!renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        render();
      });
    }
  }

  // ── Drawing helpers ──────────────────────────────────────
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

  // ── Pre-rendered POI stamps ──────────────────────────────
  function buildStamp(img, hasShadow) {
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

    sx.shadowColor = 'rgba(255, 255, 255, 0.4)';
    sx.shadowBlur = 8;
    sx.shadowOffsetX = 0;
    sx.shadowOffsetY = 0;
    sx.drawImage(img, STAMP_PAD, STAMP_PAD, iw, ih);

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

  // ── Overlap spreading ────────────────────────────────────
  function computeSpread(currentPois, currentZoom) {
    if (Math.abs(currentZoom - lastSpreadZoom) < currentZoom * 0.01 && cachedSpread.length === currentPois.length) {
      return cachedSpread;
    }
    lastSpreadZoom = currentZoom;

    const positions = currentPois.map(p => ({ px: p.px, py: p.py }));
    const spreadFactor = currentZoom > 0.15 ? 0.25 : 0.4;
    const iterations = 3;

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < currentPois.length; i++) {
        for (let j = i + 1; j < currentPois.length; j++) {
          const ri = MapPOIs.iconSize(currentPois[i], currentZoom) / currentZoom * spreadFactor;
          const rj = MapPOIs.iconSize(currentPois[j], currentZoom) / currentZoom * spreadFactor;
          const minDist = ri + rj;

          const dx = positions[j].px - positions[i].px;
          const dy = positions[j].py - positions[i].py;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < minDist && dist > 0.001) {
            const overlap = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;

            const wi = currentPois[i].zOrder >= 2 ? 0.2 : 1;
            const wj = currentPois[j].zOrder >= 2 ? 0.2 : 1;
            const total = wi + wj;

            positions[i].px -= nx * overlap * (wi / total);
            positions[i].py -= ny * overlap * (wi / total);
            positions[j].px += nx * overlap * (wj / total);
            positions[j].py += ny * overlap * (wj / total);
          } else if (dist <= 0.001) {
            positions[j].px += minDist * 0.5;
            positions[i].px -= minDist * 0.5;
          }

          const maxDrift = 80 / currentZoom;
          const dxi = positions[i].px - currentPois[i].px;
          const dyi = positions[i].py - currentPois[i].py;
          const di = Math.sqrt(dxi * dxi + dyi * dyi);
          if (di > maxDrift) {
            positions[i].px = currentPois[i].px + (dxi / di) * maxDrift;
            positions[i].py = currentPois[i].py + (dyi / di) * maxDrift;
          }
          const dxj = positions[j].px - currentPois[j].px;
          const dyj = positions[j].py - currentPois[j].py;
          const dj = Math.sqrt(dxj * dxj + dyj * dyj);
          if (dj > maxDrift) {
            positions[j].px = currentPois[j].px + (dxj / dj) * maxDrift;
            positions[j].py = currentPois[j].py + (dyj / dj) * maxDrift;
          }
        }
      }
    }

    cachedSpread = positions;
    return positions;
  }

  // ── Main render ──────────────────────────────────────────
  function render() {
    const canvas = _$('#minimap-canvas');
    const viewport = _$('#minimap-viewport');
    if (!canvas || !viewport || document.hidden || !viewport.getClientRects().length) return;

    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w === 0 || h === 0) return;
    initializeView();
    if (followingPlayer) syncPlayerCenter();

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Culling: only draw visible tiles
    const viewLeft = -panX / zoom;
    const viewTop = -panY / zoom;
    const viewRight = viewLeft + w / zoom;
    const viewBottom = viewTop + h / zoom;

    const visibleTiles = new Set();
    let painted = 0, failed = false;
    for (let idx = 0; idx < TOTAL_TILES; idx++) {
      const pos = getTilePos(idx);
      if (pos.x + TILE_SIZE < viewLeft || pos.x > viewRight ||
          pos.y + TILE_SIZE < viewTop || pos.y > viewBottom) continue;
      visibleTiles.add(idx);
      const img = ensureTile(idx);
      if (img.complete && img.naturalWidth > 0) {
        painted++;
        ctx.drawImage(img, pos.x, pos.y, TILE_SIZE, TILE_SIZE);
      } else if (img.tileFailed) failed = true;
    }
    updateTileStatus?.(mapLabels, {
      visible: visibleTiles.size, painted, failed, requiresSignIn: mapTilesRequireSignIn,
    });
    // Release decoded tiles after zooming/panning away. An overview may need all
    // 196, while a zoomed view keeps at most 64 (about 64 MiB of decoded pixels).
    const limit = Math.max(64, visibleTiles.size);
    const retired = [...tileUsed.keys()].filter(idx => !visibleTiles.has(idx))
      .sort((a, b) => tileUsed.get(a) - tileUsed.get(b));
    while (tileUsed.size > limit && retired.length) {
      const idx = retired.shift();
      const img = tileImages[idx];
      if (img) { img.onload = null; img.onerror = null; img.src = ''; }
      delete tileImages[idx];
      tileUsed.delete(idx);
    }

    // Draw map POI icons
    if (poisLoaded) {
      const visiblePOIs = pois.filter(poi => poiVisibility[poi.category]);
      const spreadPOIs = computeSpread(visiblePOIs, zoom);

      for (let i = 0; i < visiblePOIs.length; i++) {
        const poi = visiblePOIs[i];
        if (!poi.img || !poi.img.complete || poi.img.naturalWidth === 0) continue;
        if (poi.category && !poiVisibility[poi.category]) continue;
        const sp = spreadPOIs[i];
        const iconSize = MapPOIs.iconSize(poi, zoom) / zoom;
        const ix = sp.px - iconSize / 2;
        const iy = sp.py - iconSize / 2;
        if (ix + iconSize < viewLeft || ix > viewRight ||
            iy + iconSize < viewTop || iy > viewBottom) continue;
        const stamp = buildStamp(poi.img, poi.shadow);
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

    // Draw player marker pin
    if (playerMarker && !hasLivePosition()) clearPlayerMarker();
    if (playerMarker && playerMarker.isOverworld) {
      const mp = worldToMapPixel(playerMarker.x, playerMarker.z);
      const margin = 18 / zoom;
      const inView = mp.px >= viewLeft + margin && mp.px <= viewRight - margin &&
                     mp.py >= viewTop + margin && mp.py <= viewBottom - margin;
      if (inView) {
        const facing = playerHeadingMotion.sample();
        drawPlayerPin(ctx, mp.px, mp.py, zoom, facing.heading);
        if (facing.animating) scheduleRender();
      } else {
        const cx = Math.max(viewLeft + margin, Math.min(viewRight - margin, mp.px));
        const cy = Math.max(viewTop + margin, Math.min(viewBottom - margin, mp.py));
        drawPlayerEdgeIndicator(ctx, cx, cy, mp.px, mp.py, zoom);
      }
    }

    ctx.restore();
  }

  // ── POI loading ──────────────────────────────────────────
  let poiGeneration = 0;
  async function loadPOIs() {
    const generation = ++poiGeneration;
    const current = () => generation === poiGeneration;
    const markers = await MapPOIs.load(window.api, current);
    if (!current()) return;
    const images = new Map();
    pois = markers.map(marker => {
      if (!images.has(marker.icon)) {
        const img = new Image();
        img.onload = img.onerror = () => { if (current()) scheduleRender(); };
        img.src = `overkot-map-tiles://data/map-icons/${marker.icon.replace(/\.webp$/, '.png')}?v=${encodeURIComponent(mapTilesVersion)}`;
        images.set(marker.icon, img);
      }
      return { ...marker, size: marker.miniSize, img: images.get(marker.icon) };
    });
    for (const key of Object.keys(stampCache)) delete stampCache[key];
    lastSpreadZoom = -1;
    poisLoaded = true;
    scheduleRender();
  }

  // ── Zoom / pan helpers ───────────────────────────────────
  function fitToView(factor = 1) {
    const viewport = _$('#minimap-viewport');
    if (!viewport) return;
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (w === 0 || h === 0) return;
    stopAnimation(); followingPlayer = false; viewInitialized = true;
    zoom = Math.min(w / MAP_PX, h / MAP_PX) * 0.95 * factor;
    panX = (w - MAP_PX * zoom) / 2;
    panY = (h - MAP_PX * zoom) / 2;
    updateCenterButton();
    scheduleRender();
  }

  function zoomAt(factor, cx, cy) {
    stopAnimation();
    if (!initializeView()) return;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const ratio = newZoom / zoom;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    zoom = newZoom;
    if (followingPlayer) syncPlayerCenter();
    scheduleRender();
  }

  function animateTo(targetMapPx, targetMapPy, targetZoom, durationMs) {
    stopAnimation();
    followingPlayer = false; viewInitialized = true; updateCenterButton();
    const viewport = _$('#minimap-viewport');
    if (!viewport) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;

    const startPanX = panX;
    const startPanY = panY;
    const startZoom = zoom;
    const endZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    const endPanX = vw / 2 - targetMapPx * endZoom;
    const endPanY = vh / 2 - targetMapPy * endZoom;

    const start = performance.now();
    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function step(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / durationMs, 1);
      const ease = easeInOutCubic(progress);

      zoom = startZoom + (endZoom - startZoom) * ease;
      panX = startPanX + (endPanX - startPanX) * ease;
      panY = startPanY + (endPanY - startPanY) * ease;
      render();

      if (progress < 1) {
        animationId = requestAnimationFrame(step);
      } else {
        animationId = null;
      }
    }
    animationId = requestAnimationFrame(step);
  }
  function stopAnimation() {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
  }

  // ── Legend panel ──────────────────────────────────────────
  function buildLegend(config) {
    const mmLegendPanel = _$('#minimap-legend-panel');
    if (!mmLegendPanel) return;
    const lang = (config && config.language) || 'en';
    const tr = typeof TRANSLATIONS === 'undefined' ? {} : { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
    mapLabels = tr;
    for (const [id, label] of [
      ['minimap-zoom-in', tr.mapZoomIn || 'Zoom in'], ['minimap-zoom-out', tr.mapZoomOut || 'Zoom out'],
      ['minimap-expand', tr.mapOpenFull || 'Open full map'], ['minimap-legend-btn', tr.mapLegend || 'Map Legend'],
    ]) {
      const button = _$('#' + id);
      if (button) { button.title = label; button.setAttribute('aria-label', label); }
    }
    scheduleRender();
    updateCenterButton();

    const mmLegendTitle = _$('#minimap-legend-title');
    if (mmLegendTitle) mmLegendTitle.textContent = tr.mapLegend || 'Map Legend';

    mmLegendPanel.querySelectorAll('.minimap-legend-row').forEach(el => el.remove());

    for (const cat of LEGEND_CATEGORIES) {
      const row = document.createElement('div');
      row.className = 'minimap-legend-row' + (poiVisibility[cat.key] ? '' : ' hidden-cat');
      row.dataset.cat = cat.key;

      const icon = document.createElement('img');
      icon.className = 'minimap-legend-icon';
      icon.src = `overkot-map-tiles://data/map-icons/${cat.icon.replace(/\.webp$/, ".png")}`;
      icon.alt = '';

      const label = document.createElement('span');
      label.className = 'minimap-legend-label';
      label.textContent = tr[cat.translationKey] || cat.key;

      const eye = document.createElement('span');
      eye.className = 'minimap-legend-eye';
      eye.innerHTML = poiVisibility[cat.key] ? MM_EYE_OPEN : MM_EYE_CLOSED;

      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(eye);

      row.addEventListener('click', () => {
        poiVisibility[cat.key] = !poiVisibility[cat.key];
        row.classList.toggle('hidden-cat', !poiVisibility[cat.key]);
        eye.innerHTML = poiVisibility[cat.key] ? MM_EYE_OPEN : MM_EYE_CLOSED;
        lastSpreadZoom = -1; // invalidate spread cache
        scheduleRender();
        if (window.api && window.api.saveConfig) {
          window.api.saveConfig({ poiVisibility });
        }
      });

      mmLegendPanel.appendChild(row);
    }
  }

  // ── Initialization ───────────────────────────────────────
  /**
   * Initialize the minimap. Call once per window.
   * @param {Object} options
   * @param {Object} options.config - Current app config (for poiVisibility restore)
   * @param {Function} [options.$] - Optional DOM selector override
   */
  function init(options) {
    if (inited) return;
    inited = true;

    const config = options.config || {};
    appearanceConfig = { ...config };
    if (options.$) _$ = options.$;

    const viewport = _$('#minimap-viewport');
    const canvas = _$('#minimap-canvas');
    const loadingEl = _$('#minimap-loading');
    if (!viewport || !canvas) return;
    if (loadingEl) updateTileStatus = window.MapAppearance.bindTileStatus(loadingEl, () => window.api.openSettings('connections'));

    // Dungeon outlines share the minimap's space and automatically give it
    // back to the overworld on exit, preserving the overworld pan and zoom.
    const content = viewport.closest?.('.minimap-content');
    if (content && window.DungeonMapWidget && window.api?.getDungeonMap) {
      const panel = document.createElement('div');
      panel.className = 'minimap-dungeon-map'; panel.hidden = true;
      content.appendChild(panel);
      dungeonWidget = window.DungeonMapWidget.mount(panel, {
        api: window.api, config, autoSwitch: true,
        onExpand: () => window.api.openDungeonOverlay(),
        onActiveChanged: active => {
          content.classList.toggle('dungeon-active', active);
          if (!active) scheduleRender();
        },
      });
      window.addEventListener('unload', () => dungeonWidget?.destroy(), { once: true });
    }

    // Restore POI visibility from config
    if (config.poiVisibility) {
      for (const k of Object.keys(poiVisibility)) {
        if (typeof config.poiVisibility[k] === 'boolean') poiVisibility[k] = config.poiVisibility[k];
      }
    }

    // Load verified tiles and display data through the main-process cache.
    const loadInitialMap = () => {
      mapInfoLoaded = true;
      loadTiles();
      loadPOIs();
    };
    if (window.api && window.api.getMapTiles) {
      window.api.getMapTiles().then(info => {
        if (!mapInfoLoaded) applyMapTileInfo(info);
      }).catch(() => { if (!mapInfoLoaded) loadInitialMap(); });
    } else loadInitialMap();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
    if (window.api && window.api.onMapTilesUpdated) {
      window.api.onMapTilesUpdated(applyMapTileInfo);
    }
    let language = config.language || 'en';
    window.api?.onMapLanguageUpdated?.(locale => { if (locale === language) loadPOIs(); });
    window.api?.onConfigChanged?.(next => {
      const previousColor = window.MapAppearance.playerColor(appearanceConfig);
      const previousOutline = window.MapAppearance.playerOutlineColor(appearanceConfig);
      const previousDrops = appearanceConfig.showWorldDrops;
      appearanceConfig = { ...appearanceConfig, ...next };
      if (window.MapAppearance.playerColor(appearanceConfig) !== previousColor
        || window.MapAppearance.playerOutlineColor(appearanceConfig) !== previousOutline
        || appearanceConfig.showWorldDrops !== previousDrops) scheduleRender();
      if (typeof next.language === 'string' && next.language !== language) {
        language = next.language;
        buildLegend(next);
        loadPOIs();
        viewport.title = '';
      }
    });

    // Pan (drag)
    viewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stopAnimation();
      initializeView();
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panStartX = panX;
      panStartY = panY;
      viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener('pointerleave', () => { viewport.title = ''; });
    viewport.addEventListener('pointermove', (e) => {
      const rect = viewport.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      viewport.title = dragging ? '' : ancestorLayer.titleAt(x, y);
      if (!dragging && !viewport.title && poisLoaded) {
        const visiblePOIs = pois.filter(poi => poiVisibility[poi.category]);
        const spread = computeSpread(visiblePOIs, zoom);
        for (let i = visiblePOIs.length - 1; i >= 0; i--) {
          const poi = visiblePOIs[i];
          if (!poi.img?.complete || !poi.img.naturalWidth) continue;
          if (Math.abs(x - (panX + spread[i].px * zoom)) <= MapPOIs.iconSize(poi, zoom) / 2 &&
              Math.abs(y - (panY + spread[i].py * zoom)) <= MapPOIs.iconSize(poi, zoom) / 2) {
            viewport.title = MapPOIs.title(poi);
            break;
          }
        }
      }
      if (!dragging) return;
      if (e.buttons !== undefined && !(e.buttons & 1)) { dragging = false; return; }
      if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > 4 && followingPlayer) {
        followingPlayer = false; updateCenterButton();
      }
      panX = panStartX + (e.clientX - dragStartX);
      panY = panStartY + (e.clientY - dragStartY);
      scheduleRender();
    });
    viewport.addEventListener('pointerup', () => { dragging = false; });
    viewport.addEventListener('pointercancel', () => { dragging = false; });
    viewport.addEventListener('lostpointercapture', () => { dragging = false; });
    window.addEventListener('blur', () => { dragging = false; });

    // Mouse wheel zoom
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAt(factor, cx, cy);
    }, { passive: false });

    // Zoom buttons
    const zoomInBtn = _$('#minimap-zoom-in');
    const zoomOutBtn = _$('#minimap-zoom-out');
    const expandBtn = _$('#minimap-expand');
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => {
      zoomAt(1.5, viewport.clientWidth / 2, viewport.clientHeight / 2);
    });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
      zoomAt(1 / 1.5, viewport.clientWidth / 2, viewport.clientHeight / 2);
    });
    if (expandBtn) expandBtn.addEventListener('click', () => {
      if (dungeonWidget?.active) window.api.openDungeonOverlay();
      else window.api.openMapWindow();
    });

    // Center enables live following at the user's current zoom.
    const locateBtn = _$('#minimap-locate');
    updateCenterButton = () => {
      if (!locateBtn) return;
      const available = hasLivePosition();
      locateBtn.disabled = !available;
      locateBtn.title = available
        ? followingPlayer ? mapLabels.mapFollowingPause || 'Following player · drag to pause' : mapLabels.mapCenterPlayer || 'Center on player'
        : mapLabels.mapWaitingLivePosition || 'Waiting for live player position';
      locateBtn.setAttribute('aria-label', locateBtn.title);
      locateBtn.setAttribute('aria-disabled', String(!available));
      locateBtn.setAttribute('aria-pressed', String(available && followingPlayer));
    };
    locateBtn?.addEventListener('click', () => {
      playerLocationRevision++;
      centerOnPlayer(); updateCenterButton();
    });
    updateCenterButton();

    /* Legacy screenshot workflow: intentionally disabled and kept intact.
       To restore capture mode, wire this original handler and result receiver
       in place of the live-only control above. The watcher and IPC remain.

    // ── "Where am I?" button ──────────────────────────────
    const locateBtn = _$('#minimap-locate');
    const locateOverlay = _$('#minimap-locate-overlay');
    let captureWatching = false;
    function hasLivePosition() {
      const age = Date.now() - playerMarker?.sampledAt;
      return playerMarker?.source === 'memory' && playerMarker.isOverworld === true
        && Number.isFinite(playerMarker.sampledAt) && age >= 0 && age <= 2000
        && MapPOIs.validPosition({ x: playerMarker.x, z: playerMarker.z });
    }
    function updateLocateButton() {
      if (!locateBtn) return;
      locateBtn.title = hasLivePosition() ? 'Center on player' : captureWatching ? 'Cancel position capture' : 'Find position with F6';
      locateBtn.setAttribute('aria-label', locateBtn.title);
    }
    if (locateBtn) {
      locateBtn.addEventListener('click', async () => {
        playerLocationRevision++;
        if (hasLivePosition()) {
          if (captureWatching) window.api.cancelLocatePlayer();
          captureWatching = false; locateState = 'found'; locateBtn.classList.remove('watching');
          dismissLocateOverlay(); updateLocateButton();
          const point = worldToMapPixel(playerMarker.x, playerMarker.z);
          animateTo(point.px, point.py, zoom, 200);
          return;
        }
        if (captureWatching) {
          window.api.cancelLocatePlayer();
          captureWatching = false;
          locateState = 'idle';
          locateBtn.classList.remove('watching');
          dismissLocateOverlay(); updateLocateButton();
          return;
        }
        captureWatching = true;
        locateState = 'watching';
        locateBtn.classList.add('watching');
        showLocateOverlay(); updateLocateButton();

        const result = await window.api.locatePlayer();
        if (!captureWatching) return;
        if (result.status !== 'watching') {
          captureWatching = false;
          locateState = 'error';
          locateBtn.classList.remove('watching');
          dismissLocateOverlay(); updateLocateButton();
          setTimeout(() => { locateState = 'idle'; }, 4000);
        }
      });
    }
    updateLocateButton();

    function showLocateOverlay() {
      if (locateOverlay) locateOverlay.classList.remove('hidden', 'hiding');
    }
    function dismissLocateOverlay() {
      if (!locateOverlay || locateOverlay.classList.contains('hidden')) return;
      locateOverlay.classList.add('hiding');
      locateOverlay.addEventListener('animationend', () => {
        locateOverlay.classList.add('hidden');
        locateOverlay.classList.remove('hiding');
      }, { once: true });
    }

    // Location events and the initial snapshot share one revision. A delayed
    // snapshot must never restore a position from an earlier game context.
    function clearPlayerMarker() {
      if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
      stopAnimation();
      playerExpiryTimer = null; playerMarker = null; locateState = captureWatching ? 'watching' : 'idle';
      updateLocateButton(); scheduleRender();
    }
    function receivePlayerLocation(data, animate) {
      const memory = data?.source === 'memory';
      if (!memory || data?.captureCompleted === true) {
        captureWatching = false;
        if (locateBtn) locateBtn.classList.remove('watching');
        dismissLocateOverlay();
      }
      const age = Date.now() - data?.sampledAt;
      const valid = data?.status === 'found' && data.isOverworld === true
        && /(?:^|\/)MidrathRedux(?:\.level)?$/.test(data.zone || '') && MapPOIs.validPosition(data.position)
        && (data.heading == null || Number.isFinite(data.heading))
        && (!memory || (Number.isFinite(data.sampledAt) && age >= 0 && age <= 2000));
      if (!valid) { clearPlayerMarker(); return; }
      if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
      playerExpiryTimer = null;
      playerMarker = { x: data.position.x, z: data.position.z, heading: data.heading ?? null,
        isOverworld: true, source: data.source || 'capture', sampledAt: data.sampledAt, instanceId: data.instanceId };
      locateState = captureWatching ? 'watching' : 'found'; updateLocateButton(); scheduleRender();
      if (memory) {
        const marker = playerMarker;
        playerExpiryTimer = setTimeout(() => { if (marker === playerMarker) clearPlayerMarker(); }, 2001 - age);
      }
      const session = data.trackingSession || 'memory';
      if (animate && (!memory || centeredTrackingSession !== session)) {
        if (memory) centeredTrackingSession = session;
        const mp = worldToMapPixel(data.position.x, data.position.z);
        animateTo(mp.px, mp.py, 0.35, 600);
      }
    }
    */

    // Location events and user actions outrank the initial asynchronous snapshot.
    function receivePlayerLocation(data, animate) {
      const age = Date.now() - data?.sampledAt;
      const valid = !worldBlocked && (!worldEntry || data?.instanceId === worldEntry)
        && data?.status === 'found' && data.source === 'memory' && data.isOverworld === true
        && /(?:^|\/)MidrathRedux(?:\.level)?$/.test(data.zone || '') && MapPOIs.validPosition(data.position)
        && (data.heading == null || Number.isFinite(data.heading))
        && Number.isFinite(data.sampledAt) && age >= 0 && age <= 2000;
      if (!valid) { clearPlayerMarker(); return; }
      if (playerMarker && data.trackingSession === playerMarker.trackingSession
        && data.instanceId === playerMarker.instanceId && data.sampledAt < playerMarker.sampledAt) return;
      worldDropLayer?.update(data);
      if (playerExpiryTimer !== null) clearTimeout(playerExpiryTimer);
      const context = JSON.stringify([data.trackingSession, data.instanceId]);
      if (context !== followContext) {
        // A delayed first snapshot must respect a view the user already panned
        // or fitted. Subsequent process/entry changes start a new following view.
        if (followContext !== null) followingPlayer = true;
        followContext = context;
      }
      playerHeadingMotion.setHeading(data.heading ?? null, { immediate: context !== headingContext });
      headingContext = context;
      playerMarker = { x: data.position.x, z: data.position.z, heading: data.heading ?? null,
        isOverworld: true, source: 'memory', sampledAt: data.sampledAt,
        instanceId: data.instanceId, trackingSession: data.trackingSession };
      locateState = 'found'; updateCenterButton(); scheduleRender();
      const marker = playerMarker;
      playerExpiryTimer = setTimeout(() => { if (marker === playerMarker) clearPlayerMarker(); }, 2001 - age);
      if (followingPlayer) syncPlayerCenter();
    }
    const locationSubscriptions = [];
    if (window.api.onPlayerLocation) locationSubscriptions.push(window.api.onPlayerLocation(data => {
      playerLocationRevision++; receivePlayerLocation(data, true);
    }));
    if (window.api.onDungeonStateChanged) locationSubscriptions.push(window.api.onDungeonStateChanged(state => {
      playerLocationRevision++;
      worldBlocked = state?.active || state?.status !== 'outside' || !['/SF/Levels/MidrathRedux', '/SF/Levels/Procs/MidrathProc'].includes(state.levelPath?.replace(/\.level$/, ''));
      worldEntry = !worldBlocked && state.instanceId || null;
      if (worldBlocked
        || (state.instanceId && playerMarker?.instanceId !== state.instanceId)) {
        followContext = null; followingPlayer = true; centeredTrackingSession = null; clearPlayerMarker();
      }
    }));
    if (window.api.getPlayerLocation) {
      const revision = playerLocationRevision;
      Promise.resolve(window.api.getPlayerLocation()).then(data => {
        if (revision === playerLocationRevision) receivePlayerLocation(data, false);
      }).catch(() => {});
    }
    window.addEventListener('unload', () => {
      playerLocationRevision++; clearPlayerMarker();
      for (const unsubscribe of locationSubscriptions) if (typeof unsubscribe === 'function') unsubscribe();
    }, { once: true });

    ancestorLayer.connect(window.api);

    // Start nearby rather than fitting the whole island. A late live snapshot
    // centers this same view; resize and data refresh never reset chosen zoom.
    requestAnimationFrame(() => {
      initializeView();
      if (followingPlayer) syncPlayerCenter();
      scheduleRender();
    });

    // Re-render on resize via ResizeObserver
    const ro = new ResizeObserver(() => {
      initializeView(); if (followingPlayer) syncPlayerCenter(); scheduleRender();
    });
    ro.observe(viewport);

    // ── Legend panel ───────────────────────────────────────
    const mmLegendPanel = _$('#minimap-legend-panel');
    const mmLegendBtn   = _$('#minimap-legend-btn');

    if (mmLegendBtn) {
      mmLegendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mmLegendPanel) mmLegendPanel.classList.toggle('hidden');
      });
    }

    // Close legend when clicking elsewhere
    document.addEventListener('pointerdown', (e) => {
      if (mmLegendPanel && !mmLegendPanel.classList.contains('hidden') &&
          !mmLegendPanel.contains(e.target) &&
          e.target !== mmLegendBtn) {
        mmLegendPanel.classList.add('hidden');
      }
    });

    buildLegend(config);
  }

  // ── Public API ───────────────────────────────────────────
  return {
    init,
    scheduleRender,
    render,
    fitToView,
    zoomAt,
    animateTo,
    worldToMapPixel,

    // State accessors (for external config updates)
    get playerMarker() { return playerMarker; },
    set playerMarker(val) { playerMarker = val; },
    get locateState() { return locateState; },
    set locateState(val) { locateState = val; },
    get poiVisibility() { return poiVisibility; },
    get inited() { return inited; },
    get following() { return followingPlayer; },

    invalidateSpreadCache() { lastSpreadZoom = -1; },
    rebuildLegend(config) { buildLegend(config); },
  };
})();
