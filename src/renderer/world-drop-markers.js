/* Live, nearby weapon drops. This layer never creates detections or discovery. */
(function (root, factory) {
  const markers = factory();
  if (typeof module === 'object' && module.exports) module.exports = markers;
  else root.WorldDropMarkers = markers;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const MAX_AGE = 2000, MAX_ITEMS = 64, NEARBY_RADIUS = 80;
  const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
  const position = value => value && ['x', 'y', 'z'].every(key => finite(value[key]));
  const fresh = (sampledAt, now) => Number.isFinite(sampledAt) && now >= sampledAt && now - sampledAt <= MAX_AGE;
  const same = (a, b) => a != null && b != null && JSON.stringify(a) === JSON.stringify(b);

  function create({ now = Date.now, requestRender = () => {},
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true } = {}) {
    // Keep the phase stable while fresh telemetry replaces the same drops.
    const animationStartedAt = now();
    let snapshot = null, expiry = null;
    function clear() {
      if (expiry !== null) clearTimeout(expiry);
      expiry = null; snapshot = null;
    }
    function update(data) {
      const timestamp = now(), drops = data?.worldDrops;
      if (data?.status !== 'found' || data.source !== 'memory' || !position(data.position)
        || !fresh(data.sampledAt, timestamp) || !data.trackingSession
        || drops?.status !== 'available' || !fresh(drops.sampledAt, timestamp)
        || !Array.isArray(drops.items) || drops.items.length > MAX_ITEMS) { clear(); return; }
      if (snapshot && data.trackingSession === snapshot.trackingSession && data.instanceId === snapshot.instanceId
        && drops.sampledAt < snapshot.worldDrops.sampledAt) return;
      clear();
      const seen = new Set();
      const items = drops.items.filter(item => {
        if (!item || item.kind !== 'weapon' || typeof item.id !== 'string' || !item.id || item.id.length > 128
          || seen.has(item.id) || !position(item.position)) return false;
        seen.add(item.id);
        return Math.hypot(item.position.x - data.position.x, item.position.y - data.position.y, item.position.z - data.position.z) <= NEARBY_RADIUS;
      }).map(item => ({ ...item, position: { ...item.position },
        name: typeof item.name === 'string' ? item.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : null,
        shiny: item.shiny === true, dungeon: item.dungeon ? { ...item.dungeon, position: { ...item.dungeon.position } } : null }));
      if (!items.length) return;
      snapshot = { ...data, position: { ...data.position }, worldDrops: { sampledAt: drops.sampledAt, items } };
      expiry = setTimeout(() => { expiry = null; snapshot = null; requestRender(); }, Math.max(1, Math.min(data.sampledAt, drops.sampledAt) + MAX_AGE + 1 - timestamp));
    }
    function draw(context, { width, height, project, enabled = true, dungeon = null, isRevealed = () => false, pixelRatio = 1 } = {}) {
      const timestamp = now();
      if (!enabled || !snapshot || !fresh(snapshot.sampledAt, timestamp) || !fresh(snapshot.worldDrops.sampledAt, timestamp)
        || !(width > 0 && height > 0) || typeof project !== 'function') return 0;
      if (!dungeon && (snapshot.isOverworld !== true || !/(?:^|\/)MidrathRedux(?:\.level)?$/.test(snapshot.zone || ''))) return 0;
      const playerPosition = dungeon ? snapshot.dungeon?.position : snapshot.position;
      const player = finite(playerPosition?.x) && finite(playerPosition?.z) ? project(playerPosition.x, playerPosition.z) : null;
      const labels = [];
      const font = context.canvas && globalThis.getComputedStyle?.(context.canvas).fontFamily || 'system-ui';
      const animate = !reducedMotion();
      const wave = animate ? Math.sin((timestamp - animationStartedAt) * Math.PI / 1000) : 0;
      let painted = 0, paintedShiny = false;
      context.save();
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.beginPath(); context.rect(0, 0, width, height); context.clip();
      context.shadowBlur = 0;
      context.textAlign = 'center'; context.textBaseline = 'top';
      context.lineJoin = 'round'; context.lineCap = 'round';
      for (const item of snapshot.worldDrops.items) {
        let point = item.position;
        if (dungeon) {
          const mapped = item.dungeon;
          if (snapshot.isOverworld !== false || snapshot.instanceId !== dungeon.instanceId
            || mapped?.alignmentVerified !== true || mapped.instanceId !== dungeon.instanceId
            || mapped.revision !== dungeon.revision || mapped.coordinateSpace !== dungeon.coordinateSpace
            || !same(mapped.scope, dungeon.scope) || !finite(mapped.position?.x) || !finite(mapped.position?.z)
            || !isRevealed(mapped.position.x, mapped.position.z)) continue;
          point = mapped.position;
        }
        const screen = project(point.x, point.z);
        if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)
          || screen.x < 0 || screen.x > width || screen.y < 0 || screen.y > height) continue;
        const { x, y } = screen;
        if (item.shiny) {
          context.save();
          context.translate(x, y - (animate ? wave * 3 : 0));
          const scale = animate ? 1 + (wave + 1) * .15 : 1;
          context.scale(scale, scale);
          context.beginPath();
          for (let index = 0; index < 10; index++) {
            const angle = -Math.PI / 2 + index * Math.PI / 5, radius = index % 2 ? .46 : 1;
            const pointX = Math.cos(angle) * 5.5 * radius, pointY = Math.sin(angle) * 6 * radius;
            if (index === 0) context.moveTo(pointX, pointY); else context.lineTo(pointX, pointY);
          }
          context.closePath();
          context.shadowBlur = 9; context.shadowColor = '#da75ff';
          context.fillStyle = '#da75ff'; context.strokeStyle = '#ffffff'; context.lineWidth = 2.5;
          context.stroke(); context.fill(); context.shadowBlur = 0;
          context.beginPath(); context.moveTo(7, -6); context.lineTo(10, -6); context.moveTo(8.5, -7.5); context.lineTo(8.5, -4.5);
          context.strokeStyle = '#ffffff'; context.lineWidth = 1; context.stroke();
          context.restore();
          paintedShiny = true;
        } else {
          context.beginPath(); context.arc(x, y, 3, 0, Math.PI * 2);
          context.fillStyle = '#fff'; context.strokeStyle = 'rgba(0,0,0,.9)'; context.lineWidth = 2;
          context.stroke(); context.fill();
        }
        context.font = `${item.shiny ? '700 12px' : '600 11px'} ${font}`;
        let text = item.name || 'Dropped weapon';
        const maxWidth = Math.max(1, Math.min(item.shiny ? 200 : 170, width - 8));
        while (text.length > 1 && context.measureText(text).width > maxWidth) text = text.slice(0, -2).trimEnd() + '…';
        const textWidth = context.measureText(text).width;
        const labelX = Math.max(textWidth / 2 + 3, Math.min(width - textWidth / 2 - 3, x));
        // Keep the name beneath its dot. Stagger neighbouring names without
        // moving their actual world position or exposing off-screen anchors.
        const labelHeight = item.shiny ? 14 : 12;
        let labelY = y + (item.shiny ? 14 : 9);
        const overlapsPlayer = () => player && Math.abs(player.x - labelX) < textWidth / 2 + 12 && labelY < player.y + 14 && labelY + labelHeight > player.y - 14;
        while ((overlapsPlayer() || labels.some(label => Math.abs(label.x - labelX) < (label.width + textWidth) / 2 + 4 && Math.abs(label.y - labelY) < (label.height + labelHeight) / 2 + 1)) && labelY < y + 35) labelY += labelHeight + 1;
        if (labelY + labelHeight <= height) {
          context.strokeStyle = item.shiny ? '#000000' : 'rgba(0,0,0,.95)'; context.lineWidth = item.shiny ? 2 : 3;
          context.strokeText(text, labelX, labelY); context.fillStyle = item.shiny ? '#e098fb' : '#fff'; context.fillText(text, labelX, labelY);
          labels.push({ x: labelX, y: labelY, width: textWidth, height: labelHeight });
        }
        painted++;
      }
      context.restore();
      if (paintedShiny && animate) requestRender();
      return painted;
    }
    return { update, clear, draw };
  }
  return { create, MAX_AGE, MAX_ITEMS, NEARBY_RADIUS };
});
