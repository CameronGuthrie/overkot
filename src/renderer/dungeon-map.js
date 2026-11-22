'use strict';

window.DungeonMapWidget = {
  mount(element, { api = window.api, config = {}, onResize = () => {}, autoSwitch = false,
    onActiveChanged = () => {}, overlay = false, onExpand = null, onClose = () => {}, allowManualAlignment = false,
    followPlayer = autoSwitch } = {}) {
    let settings = { ...config }, snapshot = null, observedState = null, revision = 0, destroyed = false, refreshing = false;
    let zoom = 1, panX = 0, panY = 0, dragging = null, scheduled = false;
    let interactionActive = false, interactionRevision = 0;
    let location = null, lastPlayerLocation = null, sceneKey = '', paths = [], active = !autoSwitch, pendingFit = false;
    const compact = followPlayer && !overlay;
    const progressiveReveal = () => settings.dungeonMapProgressiveReveal !== false;
    const playerFollowView = () => compact && progressiveReveal();
    let following = playerFollowView(), playerZoomFactor = 1;
    const discoverySettings = { radius: 45, cellSize: 8 };
    const nearbySpan = discoverySettings.radius * 2;
    let exploration = window.DungeonExploration?.createExploration(discoverySettings), scope = null, dirty = false;
    let alignment = { status: 'unavailable', points: 0 }, aligning = false, alignmentBusy = false, alignmentMessage = '';
    let saveTimer = null, syncTimer = null, staleTimer = null, discoveryRequest = 0, alignmentRequest = 0, playerRequest = 0;
    let discoveryLoaded = false, discoveryPending = false;
    let trackingSession = null, minimumPoseTime = 0;
    const headingMotion = window.PlayerMarkerMotion?.createPlayerMarkerMotion({ now: () => typeof performance === 'object' ? performance.now() : Date.now() });
    const unsubscribers = [];
    const worldDropLayer = window.WorldDropMarkers?.create({ requestRender: () => schedule(false) });
    element.innerHTML = `<section class="dungeon-map" data-status="loading" data-overlay="${overlay}">
      <div class="dungeon-map-heading"><span class="dungeon-map-name">Dungeon Map</span><span class="dungeon-map-mode"></span></div>
      <div class="dungeon-map-viewport"><canvas aria-label="Dungeon room outlines"></canvas>
        <div class="dungeon-map-empty" role="status"><span class="dungeon-map-empty-title"></span><span class="dungeon-map-empty-detail"></span><button type="button" data-action="retry" hidden>Retry map</button></div>
        <div class="dungeon-map-guide" role="status" hidden><strong></strong><span></span></div>
      </div>
      <div class="dungeon-map-controls">
        <button type="button" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" data-action="fit" title="${playerFollowView() ? 'Center on player' : 'Center and fit dungeon'}" aria-label="${playerFollowView() ? 'Center on player' : 'Center and fit dungeon'}"><span class="icon-map-center" aria-hidden="true"></span></button>
        ${allowManualAlignment ? `<button type="button" data-action="align" title="Align your live position with this dungeon" aria-label="Align player position" aria-pressed="false">Align</button>
        <button type="button" data-action="reset-alignment" title="Restart player alignment" hidden>Reset</button>` : ''}
        ${!overlay ? `<button type="button" data-action="glass" title="See-through map" aria-label="See-through map" aria-pressed="false"><span class="icon-eye"></span></button>` : ''}
        ${onExpand && !overlay ? '<button type="button" data-action="expand" title="Expand dungeon overlay" aria-label="Expand dungeon overlay"><span class="icon-expand" aria-hidden="true"></span></button>' : ''}
        ${overlay ? '<button type="button" data-action="close" title="Close dungeon overlay" aria-label="Close dungeon overlay">×</button>' : ''}
        <span class="dungeon-map-room-count"></span>
      </div>
      <div class="dungeon-map-footer" role="status"></div>
    </section>`;
    const $ = selector => element.querySelector(selector);
    const root = $('.dungeon-map'), viewport = $('.dungeon-map-viewport'), canvas = $('canvas');
    const mapLayer = document.createElement('canvas'), revealMask = document.createElement('canvas');
    let mapDirty = true;
    const empty = $('.dungeon-map-empty'), emptyTitle = $('.dungeon-map-empty-title'), emptyDetail = $('.dungeon-map-empty-detail');
    const footer = $('.dungeon-map-footer'), guide = $('.dungeon-map-guide');
    const widget = element.closest('.timer-widget');
    const translation = (key, fallback) => {
      const dictionary = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
      return dictionary[settings.language]?.[key] || dictionary.en?.[key] || fallback;
    };
    const screenPoint = ([x, z]) => [panX + x * zoom, panY - z * zoom];
    const localPoint = ([x, z], transform) => {
      const c = Math.cos(transform.rotation), s = Math.sin(transform.rotation);
      x *= transform.scale || 1; z *= transform.scale || 1;
      return [transform.x + x * c + z * s, transform.z - x * s + z * c];
    };
    const hasLayout = () => ['placed', 'schematic'].includes(snapshot?.mode) && !!snapshot?.rooms?.length;
    const identity = () => snapshot?.mode === 'placed' && ['world', 'layout-local'].includes(snapshot.coordinateSpace)
      && snapshot.state?.active && snapshot.state.instanceId != null && snapshot.version != null
      ? { instanceId: snapshot.state.instanceId, revision: snapshot.version } : null;
    const sameScope = (a, b) => a != null && b != null && JSON.stringify(a) === JSON.stringify(b);
    const freshMemory = data => data?.status === 'found' && data.source === 'memory' && data.isOverworld === false
      && Number.isFinite(data.sampledAt) && Date.now() - data.sampledAt >= 0 && Date.now() - data.sampledAt <= 2000
      && data.sampledAt >= minimumPoseTime && data.instanceId === snapshot?.state?.instanceId;

    function mergeExploration(saved) {
      if (!exploration || !saved) return false;
      const checked = window.DungeonExploration.createExploration(discoverySettings);
      if (!checked.restore(saved)) return false;
      const current = exploration.snapshot(), seen = new Set();
      const cells = [];
      // Keep current discovery if a bounded save is already full. Late loads
      // never replace circles revealed while the request was in flight.
      for (const point of [...current.cells, ...saved.cells]) {
        const key = `${Math.floor(point[0] / current.cellSize)},${Math.floor(point[1] / current.cellSize)}`;
        if (!seen.has(key) && cells.length < window.DungeonExploration.MAX_CELLS) { seen.add(key); cells.push(point); }
      }
      return exploration.restore({ ...current, cells });
    }

    function flushDiscovery() {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      if (!dirty || scope == null || !exploration || !api.saveDungeonDiscovery) return;
      const capturedScope = scope, capturedScene = sceneKey, saved = exploration.snapshot();
      dirty = false;
      Promise.resolve().then(() => api.saveDungeonDiscovery({ scope: capturedScope, exploration: saved })).then(result => {
        if (destroyed || capturedScene !== sceneKey || !sameScope(capturedScope, scope)) return;
        if (!result?.ok) { dirty = true; return; }
        if (result.exploration) { mergeExploration(result.exploration); schedule(); }
      }).catch(() => { if (!destroyed && capturedScene === sceneKey && sameScope(capturedScope, scope)) dirty = true; });
    }
    function saveSoon() {
      if (destroyed || saveTimer !== null || !dirty || scope == null || !api.saveDungeonDiscovery) return;
      saveTimer = setTimeout(flushDiscovery, 750);
    }
    async function loadDiscovery() {
      const target = identity();
      if (!target || !exploration || !api.getDungeonDiscovery || discoveryPending) return;
      const request = ++discoveryRequest, scene = sceneKey, alignRevision = alignmentRequest;
      discoveryPending = true;
      try {
        const result = await api.getDungeonDiscovery(target);
        if (destroyed || request !== discoveryRequest || scene !== sceneKey || !result?.ok || result.scope == null) return;
        if (scope != null && !sameScope(scope, result.scope)) return;
        scope = result.scope;
        discoveryLoaded = !result.exploration || mergeExploration(result.exploration);
        if (alignRevision === alignmentRequest && result.alignment) alignment = result.alignment;
        saveSoon(); updatePlayerLocation(); present();
      } catch { /* Preserve already discovered geometry while storage is unavailable. */ }
      finally { if (request === discoveryRequest) discoveryPending = false; }
    }
    function syncDiscovery() {
      if (syncTimer !== null) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (destroyed || !identity()) return;
        saveSoon(); if (!discoveryLoaded || !api.onDungeonDiscoveryChanged) loadDiscovery(); syncDiscovery();
      }, 3000);
    }
    function leaveScene() {
      worldDropLayer?.clear();
      flushDiscovery();
      discoveryRequest++; alignmentRequest++;
      discoveryLoaded = discoveryPending = false;
      for (const timer of [syncTimer, staleTimer]) if (timer !== null) clearTimeout(timer);
      syncTimer = staleTimer = null;
      exploration?.clear(); scope = null; dirty = false; location = null; trackingSession = null;
      headingMotion?.reset(); mapDirty = true;
      following = playerFollowView(); playerZoomFactor = 1;
      alignment = { status: 'unavailable', points: 0 }; aligning = false; alignmentBusy = false; alignmentMessage = ''; minimumPoseTime = 0;
    }
    function schedule(mapChanged = true) {
      if (mapChanged) mapDirty = true;
      if (destroyed || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; render(); });
    }
    function centerOnPlayer() {
      if (!location || !freshMemory(lastPlayerLocation) || !viewport.clientWidth || !viewport.clientHeight
        || !viewport.getClientRects().length) return false;
      // Keep a nearby view independent of how large this generated dungeon is.
      // Zoom controls retain their chosen scale as the player walks or resizes.
      const nextZoom = Math.max(.001, Math.min(20, Math.min(viewport.clientWidth, viewport.clientHeight) / nearbySpan * playerZoomFactor));
      const nextX = viewport.clientWidth / 2 - location.position.x * nextZoom;
      const nextY = viewport.clientHeight / 2 + location.position.z * nextZoom;
      if (zoom !== nextZoom || panX !== nextX || panY !== nextY) mapDirty = true;
      zoom = nextZoom; panX = nextX; panY = nextY;
      pendingFit = false; return true;
    }
    function fit() {
      if (playerFollowView() && !aligning) {
        following = true; pendingFit = true;
        const centered = centerOnPlayer(); present(); return centered;
      }
      if (!snapshot?.bounds || !viewport.clientWidth || !viewport.clientHeight || !viewport.getClientRects().length) return false;
      const { x, z } = snapshot.bounds;
      zoom = Math.min((viewport.clientWidth - 44) / Math.max(1, x[1] - x[0]), (viewport.clientHeight - 44) / Math.max(1, z[1] - z[0]));
      zoom = Math.max(.001, Math.min(20, zoom));
      panX = viewport.clientWidth / 2 - (x[0] + x[1]) / 2 * zoom;
      panY = viewport.clientHeight / 2 + (z[0] + z[1]) / 2 * zoom;
      pendingFit = false; schedule(); return true;
    }
    function zoomAt(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
      const next = Math.max(.001, Math.min(20, zoom * factor));
      if (playerFollowView() && !aligning) {
        const base = Math.min(viewport.clientWidth, viewport.clientHeight) / nearbySpan;
        if (!base) return;
        playerZoomFactor = next / base;
        if (following && centerOnPlayer()) { schedule(); return; }
      }
      panX = x - (x - panX) * next / zoom; panY = y - (y - panY) * next / zoom; zoom = next; schedule();
    }
    function rebuildPaths() {
      paths = (hasLayout() ? snapshot.rooms : []).map(room => {
        const chains = room.outline.map(chain => ({ ...chain, points: chain.points.map(point => localPoint(point, room.transform)) }));
        const points = chains.flatMap(chain => chain.points);
        const bounds = points.reduce((box, [x, z]) => [Math.min(box[0], x), Math.min(box[1], z), Math.max(box[2], x), Math.max(box[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
        const center = points.length ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
          : [room.transform.x, room.transform.z];
        return { room, chains, center };
      });
    }
    function rebuildMapLayer(width, height, ratio) {
      if (mapLayer.width !== canvas.width || mapLayer.height !== canvas.height) { mapLayer.width = canvas.width; mapLayer.height = canvas.height; }
      const context = mapLayer.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      mapDirty = false;
      if (!hasLayout() || snapshot.mode !== 'placed') return;
      const circles = exploration?.circles() || [];
      const masked = progressiveReveal() && !aligning;
      if (masked && !circles.length && !location) return;
      const radius = discoverySettings.radius * zoom;
      const visibleCircles = circles.filter(point => {
        const [x, y] = screenPoint(point);
        return x + radius >= 0 && y + radius >= 0 && x - radius <= width && y - radius <= height;
      });
      if (location) visibleCircles.push([location.position.x, location.position.z]);
      context.save();
      if (masked) {
        context.beginPath();
        for (const point of visibleCircles) {
          const [x, y] = screenPoint(point);
          context.moveTo(x + radius, y); context.arc(x, y, radius, 0, Math.PI * 2);
        }
        context.clip();
      }
      for (const { chains, center } of paths) {
        if (chains.length) {
          context.beginPath();
          for (const chain of chains) {
            chain.points.forEach((point, i) => { const [x, y] = screenPoint(point); if (i) context.lineTo(x, y); else context.moveTo(x, y); });
            if (chain.closed) context.closePath();
          }
          context.strokeStyle = window.MapAppearance.outlineColor(settings);
          context.lineWidth = overlay ? 1.8 : 1.3; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke();
        } else {
          const [x, y] = screenPoint(center);
          context.strokeStyle = window.MapAppearance.outlineColor(settings); context.lineWidth = 1.5;
          context.beginPath(); context.moveTo(x - 4, y - 4); context.lineTo(x + 4, y + 4);
          context.moveTo(x + 4, y - 4); context.lineTo(x - 4, y + 4); context.stroke();
        }
      }
      if (masked) {
        // Blur a solid union, rather than stacking translucent circle stamps.
        // The inset makes the fade point inward; the exact outer clip above
        // prevents its blur from revealing any unexplored pixel beyond radius.
        const feather = Math.min(12, Math.max(2, radius * .18), radius * .4);
        const padding = Math.ceil(feather * 2), innerRadius = Math.max(.001, radius - feather);
        const maskWidth = Math.ceil((width + padding * 2) * ratio), maskHeight = Math.ceil((height + padding * 2) * ratio);
        if (revealMask.width !== maskWidth || revealMask.height !== maskHeight) { revealMask.width = maskWidth; revealMask.height = maskHeight; }
        const mask = revealMask.getContext('2d');
        mask.setTransform(1, 0, 0, 1, 0, 0); mask.clearRect(0, 0, maskWidth, maskHeight);
        mask.setTransform(ratio, 0, 0, ratio, padding * ratio, padding * ratio);
        mask.beginPath();
        for (const point of visibleCircles) {
          const [x, y] = screenPoint(point);
          mask.moveTo(x + innerRadius, y); mask.arc(x, y, innerRadius, 0, Math.PI * 2);
        }
        mask.fillStyle = '#fff'; mask.fill();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalCompositeOperation = 'destination-in';
        context.filter = `blur(${feather * .45 * ratio}px)`;
        context.drawImage(revealMask, -padding * ratio, -padding * ratio);
      }
      context.restore();
    }
    function render() {
      if (destroyed || !active || document.hidden || !viewport.getClientRects().length) return;
      // Native background windows may throttle timers. Never paint a stale
      // marker even when the expiry callback has not had a turn to run yet.
      if (location && !freshMemory(lastPlayerLocation)) { location = null; headingMotion?.reset(); exploration?.reveal(null); trackingSession = null; mapDirty = true; }
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      if (playerFollowView() && following && !aligning) centerOnPlayer();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); mapDirty = true;
      }
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      if (mapDirty) rebuildMapLayer(width, height, ratio);
      context.drawImage(mapLayer, 0, 0, width, height);
      if (location && !aligning) {
        worldDropLayer?.draw(context, {
          width, height, pixelRatio: ratio, enabled: settings.showWorldDrops !== false,
          dungeon: { ...identity(), coordinateSpace: snapshot.coordinateSpace, scope },
          isRevealed: (x, z) => !progressiveReveal() || exploration.isRevealed(x, z),
          project: (x, z) => { const [screenX, screenY] = screenPoint([x, z]); return { x: screenX, y: screenY }; },
        });
        const [x, y] = screenPoint([location.position.x, location.position.z]);
        const motion = headingMotion?.sample() || { heading: location.heading, animating: false };
        window.MapAppearance.drawPlayerMarker(context, { x, y, heading: motion.heading,
          color: window.MapAppearance.playerColor(settings), outlineColor: window.MapAppearance.playerOutlineColor(settings) });
        if (motion.animating) schedule(false);
      }
    }
    function updateVisibility(state) {
      observedState = state || { active: false };
      const next = !autoSwitch || (settings.dungeonMapAutoSwitch !== false && observedState.active === true);
      if (!next) finishPan();
      if (autoSwitch) element.hidden = !next;
      if (next !== active) { active = next; onActiveChanged(active); onResize(); if (active && pendingFit) fit(); }
      setAppearance();
    }
    function setAppearance() {
      root.dataset.seeThrough = String(overlay || !!settings.dungeonMapSeeThrough);
      const opacity = Math.max(0, Math.min(100, Number(settings.dungeonMapBackgroundOpacity ?? 45))) / 100;
      root.style.setProperty('--dungeon-map-background-opacity', String(opacity));
      $('[data-action="glass"]')?.setAttribute('aria-pressed', String(!!settings.dungeonMapSeeThrough));
      widget?.classList.toggle('dungeon-map-glass', active && !!settings.dungeonMapSeeThrough);
      schedule();
    }
    function localizeControls() {
      const labels = [
        ['zoom-in', 'mapZoomIn', 'Zoom in'], ['zoom-out', 'mapZoomOut', 'Zoom out'],
        ['glass', 'mapSeeThrough', 'See-through map'], ['expand', 'mapExpandDungeon', 'Expand dungeon overlay'],
        ['close', 'mapCloseDungeon', 'Close dungeon overlay'], ['align', 'mapAlignTitle', 'Align your live position with this dungeon'],
        ['reset-alignment', 'mapResetAlignment', 'Restart player alignment'],
      ];
      for (const [action, key, fallback] of labels) {
        const button = $(`[data-action="${action}"]`);
        if (!button) continue;
        button.title = translation(key, fallback);
        button.setAttribute('aria-label', button.title);
      }
      canvas.setAttribute('aria-label', translation('mapCanvas', 'Dungeon room outlines'));
      $('[data-action="retry"]').textContent = translation('mapRetry', 'Retry map');
      const reset = $('[data-action="reset-alignment"]');
      if (reset) reset.textContent = translation('settingsHotkeyReset', 'Reset');
    }
    function present() {
      const state = snapshot?.state || observedState;
      updateVisibility(state);
      $('.dungeon-map-name').textContent = state?.name || translation('dungeonMapWidget') || 'Dungeon Map';
      root.dataset.status = snapshot?.mode || 'loading';
      root.dataset.followPlayer = String(playerFollowView());
      root.dataset.following = String(playerFollowView() && following);
      const available = hasLayout();
      empty.hidden = available;
      $('.dungeon-map-mode').textContent = available ? snapshot.mode === 'schematic' ? translation('mapConnections', 'Connections') : translation('mapRoomOutlines', 'Room outlines') : '';
      $('.dungeon-map-room-count').textContent = available ? translation('mapRoomCount', 'Rooms: {count}').replace('{count}', snapshot.rooms.length) : '';
      for (const action of ['zoom-in', 'zoom-out', 'fit']) $('[data-action="' + action + '"]').disabled = !available;
      const fitButton = $('[data-action="fit"]');
      fitButton.title = playerFollowView() ? translation('mapCenterPlayer', 'Center on player') : translation('mapFitDungeon', 'Center and fit dungeon');
      fitButton.setAttribute('aria-label', fitButton.title);
      if (playerFollowView() && !aligning) fitButton.disabled = !available || !location;
      const alignButton = $('[data-action="align"]'), resetButton = $('[data-action="reset-alignment"]');
      const canAlign = allowManualAlignment && !!identity() && snapshot.coordinateSpace === 'layout-local' && !!api.addDungeonAlignmentPoint && !!exploration;
      if (alignButton) {
        alignButton.disabled = !canAlign || alignmentBusy;
        alignButton.textContent = aligning ? translation('mapStopAligning', 'Stop aligning') : translation('mapAlign', 'Align');
        alignButton.setAttribute('aria-pressed', String(aligning));
      }
      if (resetButton) { resetButton.hidden = !aligning; resetButton.disabled = alignmentBusy || !api.resetDungeonAlignment; }
      root.dataset.aligning = String(aligning);
      if (!available) {
        const reason = snapshot?.reason || (!snapshot && state?.active ? 'waiting' : null);
        emptyTitle.textContent = !state?.active ? translation('mapEnterDungeon', 'Enter a dungeon') : reason === 'waiting' ? translation('mapReadingDungeon', 'Reading dungeon layout…') : translation('mapUnavailable', 'Map unavailable');
        emptyDetail.textContent = !state?.active ? translation('mapDungeonEmpty', 'Your map appears here when a dungeon is entered.')
          : reason === 'waiting' ? translation('mapWaitingLayout', 'Waiting for the dungeon fingerprint in the game log.')
            : reason === 'unsupported' ? translation('mapUnsupportedLayout', 'This dungeon layout format is not supported yet.')
              : reason === 'decode' ? translation('mapLayoutReadFailed', 'The dungeon layout could not be read. Retry after updating Game Data in Settings.')
                : translation('mapDownloadFailed', 'Dungeon map data could not be loaded. Check Game Data in Settings.');
      }
      $('[data-action="retry"]').hidden = available || !state?.active || !['unsupported', 'decode', 'data'].includes(snapshot?.reason);
      $('[data-action="retry"]').disabled = refreshing;
      footer.textContent = !available ? '' : snapshot.mode === 'schematic' ? translation('mapNeedOutlines', 'Player tracking needs positioned room outlines')
        : snapshot.missingRooms?.length ? translation('mapMissingOutlines', 'Room outlines unavailable: {count}').replace('{count}', snapshot.missingRooms.length)
          : !progressiveReveal() ? translation('mapFullDungeon', 'Full dungeon · drag to pan · wheel to zoom')
          : location ? Number.isFinite(location.heading) ? playerFollowView()
            ? following ? translation('mapFollowingZoom', 'Following player · drag to explore · wheel to zoom') : translation('mapPanned', 'Map panned · center on player to follow')
            : translation('mapLivePosition', 'Live player position · drag to pan · wheel to zoom') : translation('mapFacingUnavailable', 'Live player position · facing unavailable')
            : exploration?.size ? translation('mapSavedAreas', 'Discovered areas saved · waiting for live player position')
              : !allowManualAlignment && snapshot.coordinateSpace === 'layout-local' && alignment.status !== 'verified' ? translation('mapFindingDungeon', 'Finding dungeon position…') : translation('mapPanZoom', 'Drag to pan · wheel to zoom');
      guide.hidden = !available || (!aligning && snapshot.mode === 'placed' && (!progressiveReveal() || !!exploration?.size));
      if (!guide.hidden) {
        const title = guide.querySelector('strong'), detail = guide.querySelector('span');
        title.textContent = snapshot.mode === 'schematic' ? translation('mapPositionUnavailable', 'Positioned map unavailable')
          : aligning ? translation('mapAlignmentPoints', 'Align player position · {count}/3 points').replace('{count}', Math.min(3, alignment.points || 0))
            : alignment.status === 'verified' || snapshot.coordinateSpace === 'world' ? translation('mapWaitPlayer', 'Waiting for player position')
              : allowManualAlignment ? translation('mapAlignPlayer', 'Align player position') : translation('mapFindingDungeon', 'Finding dungeon position…');
        detail.textContent = snapshot.mode === 'schematic' ? translation('mapSchematicHint', 'This layout only has schematic connections. Exploration needs accurately positioned room outlines.')
          : aligning ? alignmentMessage || (freshMemory(lastPlayerLocation)
            ? translation('mapAlignClick', 'Click where you are standing. Move at least 8 units before the next point; the third point verifies alignment.')
            : translation('mapAlignWaiting', 'Waiting for live player tracking. When available, click where you are standing.'))
            : alignment.status === 'verified' || snapshot.coordinateSpace === 'world' ? translation('mapWalkToReveal', 'Walk to reveal a circle of the dungeon around you.')
              : allowManualAlignment ? translation('mapAlignHint', 'Choose Align, then mark your position at three different places. The map preview is only visible while aligning.')
                : translation('mapWaitForPlacement', 'Waiting for live dungeon placement. Keep the game and dungeon loaded.');
      }
      schedule();
    }
    async function refresh(state) {
      const request = ++revision;
      refreshing = true;
      if (state) {
        if (!state.active || state.instanceId !== snapshot?.state?.instanceId) { leaveScene(); sceneKey = ''; }
        updateVisibility(state); snapshot = null; paths = []; present();
      }
      else present();
      try {
        let next = await api.getDungeonMap();
        if (destroyed || request !== revision) return;
        // Only layouts for this generated instance belong in the minimap.
        // Reject old cache/protocol responses containing a room catalogue.
        if (!['placed', 'schematic'].includes(next?.mode)) next = { ...next, mode: 'unavailable', rooms: [], bounds: null,
          coordinateSpace: null, reason: next?.reason || (next?.state?.active ? 'unsupported' : 'outside') };
        const key = JSON.stringify([next.version, next.state?.instanceId, next.state?.key, next.state?.set, next.state?.levelPath, next.state?.layoutCode, next.mode]);
        const changedScene = key !== sceneKey;
        if (changedScene) { leaveScene(); sceneKey = key; }
        snapshot = next; refreshing = false; rebuildPaths(); updatePlayerLocation(); present();
        if (changedScene && identity()) { loadDiscovery(); syncDiscovery(); }
        if (key !== root.dataset.scene) { root.dataset.scene = key; pendingFit = true; fit(); }
      } catch {
        if (destroyed || request !== revision) return;
        leaveScene(); sceneKey = ''; refreshing = false; paths = []; snapshot = { state: observedState, reason: 'data', rooms: [], mode: 'unavailable' }; present();
      }
    }
    function setConfig(next) {
      const previousReveal = progressiveReveal();
      const languageChanged = settings.language !== next.language;
      settings = { ...next };
      if (languageChanged) localizeControls();
      updateVisibility(observedState);
      if (previousReveal !== progressiveReveal()) { finishPan(); fit(); }
      present();
    }
    root.addEventListener('click', async event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'retry' && !refreshing) { await refresh(snapshot?.state || observedState); return; }
      if (action === 'zoom-in') zoomAt(1.4);
      if (action === 'zoom-out') zoomAt(1 / 1.4);
      if (action === 'fit') fit();
      if (action === 'expand' && onExpand) onExpand();
      if (action === 'close') onClose();
      if (action === 'glass') {
        const next = !settings.dungeonMapSeeThrough;
        settings.dungeonMapSeeThrough = next; setAppearance();
        try { await api.saveConfig({ dungeonMapSeeThrough: next }); } catch { /* Keep this window usable offline. */ }
      }
      if (action === 'align' && allowManualAlignment && !$('[data-action="align"]').disabled) {
        finishPan(); aligning = !aligning; alignmentMessage = ''; location = null; headingMotion?.reset(); exploration?.reveal(null); present();
        if (!aligning) updatePlayerLocation();
      }
      if (action === 'reset-alignment' && allowManualAlignment && aligning && !alignmentBusy && api.resetDungeonAlignment) {
        const target = identity(), scene = sceneKey, request = ++alignmentRequest;
        if (!target) return;
        alignmentBusy = true; present();
        try {
          const result = await api.resetDungeonAlignment(target);
          if (destroyed || scene !== sceneKey || request !== alignmentRequest) return;
          if (result?.ok) {
            minimumPoseTime = Date.now() + 1; location = null; headingMotion?.reset(); dirty = false; exploration?.clear();
            if (result.scope != null) scope = result.scope;
            alignment = result.alignment || { status: 'unavailable', points: 0 };
            alignmentMessage = 'Alignment cleared. Click where you are standing to mark the first point.';
          } else alignmentMessage = result?.message || 'Alignment could not be reset.';
        } catch { if (scene === sceneKey) alignmentMessage = 'Alignment could not be reset.'; }
        finally { if (!destroyed && scene === sceneKey && request === alignmentRequest) { alignmentBusy = false; present(); } }
      }
    });
    async function markAlignment(clientX, clientY) {
      const target = identity();
      if (!target || !allowManualAlignment || !aligning || alignmentBusy || !api.addDungeonAlignmentPoint) return;
      if (!freshMemory(lastPlayerLocation)) { alignmentMessage = 'Waiting for live player tracking. Keep the game running, then mark your position again.'; present(); return; }
      const rect = viewport.getBoundingClientRect();
      const map = { x: (clientX - rect.left - panX) / zoom, z: (panY - clientY + rect.top) / zoom };
      if (!Number.isFinite(map.x) || !Number.isFinite(map.z)) return;
      const scene = sceneKey, request = ++alignmentRequest;
      alignmentBusy = true; alignmentMessage = 'Checking this position…'; present();
      try {
        const result = await api.addDungeonAlignmentPoint({ ...target, map });
        if (destroyed || scene !== sceneKey || request !== alignmentRequest) return;
        if (result?.alignment) alignment = result.alignment;
        alignmentMessage = result?.message || result?.alignment?.message || (result?.ok
          ? alignment.status === 'verified' ? 'Alignment verified. Walk to uncover the map.' : 'Point saved. Move at least 8 units, then click your new position.'
          : 'This point could not be used. Try again while your player position is being tracked.');
        if (result?.ok && alignment.status === 'verified') {
          aligning = false;
          if (api.getPlayerLocation) receivePlayerLocation(await api.getPlayerLocation());
        }
      } catch { if (scene === sceneKey) alignmentMessage = 'This point could not be saved. Try again.'; }
      finally { if (!destroyed && scene === sceneKey && request === alignmentRequest) { alignmentBusy = false; present(); } }
    }
    const canPan = () => !destroyed && active && !document.hidden && document.hasFocus()
      && (interactionActive || (!overlay && settings.clickThrough !== true));
    function finishPan(event) {
      if (!dragging || (event?.pointerId !== undefined && event.pointerId !== dragging.pointerId)) return;
      const { pointerId } = dragging;
      dragging = null;
      // Clear the gesture before release, which may synchronously emit lostpointercapture.
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch { /* The native window may have already released its capture. */ }
    }
    function releaseInteraction() {
      interactionRevision++;
      interactionActive = false;
      finishPan();
    }
    const wheel = event => {
      if (!canPan()) return;
      event.preventDefault(); const rect = viewport.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - rect.left, event.clientY - rect.top);
    };
    const pointerDown = event => {
      if (dragging || event.button !== 0 || event.isPrimary === false || !(event.buttons & 1) || !canPan()) return;
      dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, moved: false };
      try { viewport.setPointerCapture(event.pointerId); }
      catch { dragging = null; }
    };
    const pointerMove = event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      if (!(event.buttons & 1) || !canPan()) { finishPan(event); return; }
      if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) > 4) dragging.moved = true;
      if (playerFollowView() && dragging.moved && following) { following = false; pendingFit = false; present(); }
      panX = dragging.panX + event.clientX - dragging.x; panY = dragging.panY + event.clientY - dragging.y; schedule();
    };
    const pointerUp = event => {
      const mark = dragging && event.pointerId === dragging.pointerId && !dragging.moved && aligning && canPan();
      finishPan(event);
      if (mark) markAlignment(event.clientX, event.clientY);
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('pointermove', pointerMove);
    viewport.addEventListener('pointerup', pointerUp);
    for (const event of ['pointercancel', 'lostpointercapture']) viewport.addEventListener(event, finishPan);
    window.addEventListener('blur', finishPan);
    const observer = new ResizeObserver(() => {
      if (playerFollowView() && following && !aligning) centerOnPlayer();
      else if (pendingFit) fit();
      schedule();
    }); observer.observe(viewport);
    const visible = () => { if (document.hidden) finishPan(); else { updatePlayerLocation(); present(); } }; document.addEventListener('visibilitychange', visible);
    if (api.onDungeonStateChanged) unsubscribers.push(api.onDungeonStateChanged(refresh));
    if (api.onMapTilesUpdated) unsubscribers.push(api.onMapTilesUpdated(() => refresh()));
    if (api.onConfigChanged) unsubscribers.push(api.onConfigChanged(setConfig));
    if (api.onOverlayInteraction) unsubscribers.push(api.onOverlayInteraction(next => {
      interactionRevision++;
      interactionActive = next === true;
      if (!interactionActive) finishPan();
    }));
    // A map mounted after the native window becomes ready may miss its first
    // interaction event. A newer event always wins over this asynchronous snapshot.
    if ((overlay || settings.clickThrough === true) && api.getState) {
      const request = interactionRevision;
      Promise.resolve().then(() => api.getState()).then(state => {
        if (destroyed || request !== interactionRevision) return;
        interactionActive = state?.overlayInteractive === true;
        if (!interactionActive) finishPan();
      }).catch(() => {});
    }
    function updatePlayerLocation() {
      const data = lastPlayerLocation;
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null; location = null;
      const point = data?.dungeon, target = identity();
      if (freshMemory(data)) staleTimer = setTimeout(() => { staleTimer = null; updatePlayerLocation(); present(); }, Math.max(1, data.sampledAt + 2001 - Date.now()));
      if (!target || !freshMemory(data) || point?.alignmentVerified !== true || point.instanceId !== target.instanceId
        || point.revision !== target.revision || point.coordinateSpace !== snapshot.coordinateSpace || point.scope == null
        || !Number.isFinite(point.position?.x) || !Number.isFinite(point.position?.z)
        || Math.abs(point.position.x) > 10000000 || Math.abs(point.position.z) > 10000000 || !exploration || aligning) {
        exploration?.reveal(null); headingMotion?.reset(); trackingSession = null; return;
      }
      if (scope != null && !sameScope(scope, point.scope)) {
        if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
        discoveryRequest++; discoveryLoaded = discoveryPending = false; exploration.clear(); headingMotion?.reset(); dirty = false; trackingSession = null;
      }
      scope = point.scope;
      alignment = { status: 'verified', points: 3 };
      location = { position: { x: point.position.x, z: point.position.z }, heading: Number.isFinite(point.heading) ? (point.heading % 360 + 360) % 360 : null };
      headingMotion?.setHeading(location.heading);
      if (playerFollowView() && following && !aligning) centerOnPlayer();
      const result = exploration.reveal(location.position, { continuous: trackingSession !== null && trackingSession === data.trackingSession });
      trackingSession = data.trackingSession;
      if (result.changed) { dirty = true; saveSoon(); }
    }
    function receivePlayerLocation(data) {
      if (destroyed) return;
      if (data?.source === 'memory' && lastPlayerLocation?.source === 'memory' && Number.isFinite(data.sampledAt)
        && Number.isFinite(lastPlayerLocation.sampledAt) && data.sampledAt < lastPlayerLocation.sampledAt) return;
      worldDropLayer?.update(data);
      lastPlayerLocation = data; updatePlayerLocation(); present();
    }
    if (api.onPlayerLocation) unsubscribers.push(api.onPlayerLocation(data => { playerRequest++; receivePlayerLocation(data); }));
    if (api.onDungeonDiscoveryChanged) unsubscribers.push(api.onDungeonDiscoveryChanged(data => {
      const target = identity();
      if (destroyed || !target || data?.instanceId !== target.instanceId || data.revision !== target.revision || data.scope == null) return;
      if (data.reset) {
        discoveryRequest++;
        discoveryLoaded = discoveryPending = false;
        if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
        scope = data.scope; dirty = false; exploration?.clear(); location = null; headingMotion?.reset(); trackingSession = null; minimumPoseTime = Date.now() + 1;
      } else if (scope != null && !sameScope(scope, data.scope)) return;
      else scope = data.scope;
      if (data.exploration) discoveryLoaded = mergeExploration(data.exploration);
      if (data.alignment) alignment = data.alignment;
      present();
    }));
    const initialPlayerRequest = playerRequest;
    if (api.getPlayerLocation) Promise.resolve(api.getPlayerLocation()).then(data => {
      if (!destroyed && initialPlayerRequest === playerRequest) receivePlayerLocation(data);
    }).catch(() => {});
    localizeControls(); setAppearance(); present(); refresh();
    function destroy() {
      if (destroyed) return;
      finishPan();
      leaveScene();
      destroyed = true; revision++; observer.disconnect(); document.removeEventListener('visibilitychange', visible);
      worldDropLayer?.clear();
      window.removeEventListener('blur', finishPan);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('pointermove', pointerMove);
      viewport.removeEventListener('pointerup', pointerUp);
      for (const event of ['pointercancel', 'lostpointercapture']) viewport.removeEventListener(event, finishPan);
      for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe();
      widget?.classList.remove('dungeon-map-glass');
    }
    return { setConfig, destroy, fit, refresh, releaseInteraction, get active() { return active; } };
  },
};
