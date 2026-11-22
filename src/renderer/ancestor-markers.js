// Shared by the minimap and expanded map. Draw in screen pixels so the dot's
// centre stays on the logged world coordinate at every zoom level. This is an
// encounter hint, not the final NPC position chosen by the game's spawn query.
const AncestorMarkers = (() => {
  const PULSE_MS = 6000;
  const SEARCH_RADIUS_WORLD = 50;
  const FALLBACK_NAME = 'Unknown Ancestor';

  function create({ requestRender = () => {}, now = () => performance.now(),
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true } = {}) {
    let markers = new Map();
    let hitAreas = [];
    let revision = 0;

    function update(values, { notify = true } = {}) {
      const next = new Map();
      const timestamp = now();
      for (const marker of Array.isArray(values) ? values : []) {
        if (!marker || typeof marker.id !== 'string' || !Number.isFinite(marker.x) || !Number.isFinite(marker.z)) continue;
        const previous = markers.get(marker.id);
        const sameEncounter = previous && previous.startedAt === marker.startedAt;
        const named = typeof marker.ancestorName === 'string' && marker.ancestorName.trim().length > 0;
        const name = named ? marker.ancestorName.trim() : FALLBACK_NAME;
        const discovered = !sameEncounter || (previous.name === FALLBACK_NAME && named);
        next.set(marker.id, {
          ...marker, name,
          pulseStart: notify && discovered ? timestamp : sameEncounter ? previous.pulseStart : -Infinity,
        });
      }
      markers = next;
      hitAreas = [];
      requestRender();
    }

    function connect(api) {
      // A live update can beat the startup snapshot over IPC. Never overwrite
      // newer discoveries/removals with that late snapshot.
      api?.onAncestors?.(values => { revision++; update(values); });
      const initialRevision = revision;
      if (api?.getAncestors) {
        Promise.resolve(api.getAncestors()).then(values => {
          if (revision === initialRevision) update(values, { notify: false });
        }).catch(() => {});
      }
    }

    function titleAt(x, y) {
      for (let i = hitAreas.length - 1; i >= 0; i--) {
        const area = hitAreas[i];
        if ((x - area.x) ** 2 + (y - area.y) ** 2 <= 12 ** 2
            || (x >= area.label.x && x <= area.label.x + area.label.width
              && y >= area.label.y && y <= area.label.y + area.label.height)) {
          return `${area.name} — approximate location; search nearby`;
        }
      }
      return '';
    }

    function draw(ctx, { width, height, project }) {
      if (!(width > 0 && height > 0)) return false;
      const font = ctx.canvas && globalThis.getComputedStyle?.(ctx.canvas).fontFamily || 'system-ui';
      hitAreas = [];
      const timestamp = now();
      const animate = !reducedMotion();
      let active = false;
      let glow = 0;
      const labels = [];
      const visibleMarkers = [];
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.shadowBlur = 0;
      // Paint all search areas beneath the dots and names. Derive their screen
      // radius through the same world projection, so 50 units stays 50 units
      // while panning or zooming either map. This is a search aid, not a bound
      // guaranteed by the game's encounter hint.
      for (const marker of markers.values()) {
        const age = timestamp - marker.pulseStart;
        const pulsing = animate && age >= 0 && age < PULSE_MS;
        const strength = pulsing ? (1 - age / PULSE_MS) * (0.55 + 0.45 * Math.cos(age / 1600 * Math.PI * 2)) : 0;
        active ||= pulsing;
        glow = Math.max(glow, strength);
        const point = project(marker.x, marker.z);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const edge = project(marker.x + SEARCH_RADIUS_WORLD, marker.z);
        const radius = edge ? Math.hypot(edge.x - point.x, edge.y - point.y) : 0;
        if (Number.isFinite(radius) && radius > 0
            && point.x + radius > 0 && point.x - radius < width
            && point.y + radius > 0 && point.y - radius < height) {
          const haze = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
          haze.addColorStop(0, `rgba(199, 146, 234, ${0.3 + strength * 0.1})`);
          haze.addColorStop(0.55, `rgba(199, 146, 234, ${0.22 + strength * 0.08})`);
          haze.addColorStop(0.85, `rgba(199, 146, 234, ${0.08 + strength * 0.04})`);
          haze.addColorStop(1, 'rgba(199, 146, 234, 0)');
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = haze;
          ctx.fill();
        }
        // A partially visible search area must remain visible even if its
        // centre is outside the viewport. Never move the dot onto the edge.
        if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) {
          visibleMarkers.push({ marker, point, age, pulsing, strength });
        }
      }

      for (const { marker, point, age, pulsing, strength } of visibleMarkers) {
        if (pulsing) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 10 + (age % 1600) / 1600 * 12, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(211, 164, 249, ${strength * 0.8})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.shadowColor = '#c792ea';
        ctx.shadowBlur = 8 + strength * 12;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#c792ea';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff0ff';
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.font = `600 12px ${font}`;
        let labelText = marker.name;
        const maxTextWidth = Math.max(20, Math.min(200, width - 24));
        while (labelText.length > 1 && ctx.measureText(labelText).width > maxTextWidth) {
          labelText = labelText.slice(0, -2).trimEnd() + '…';
        }
        const labelWidth = ctx.measureText(labelText).width + 14;
        const labelHeight = 24;
        const labelX = Math.max(2, Math.min(width - labelWidth - 2, point.x - labelWidth / 2));
        const candidates = [point.y + 12, point.y - labelHeight - 12, point.y + 38];
        const overlaps = y => labels.some(label => labelX < label.x + label.width && labelX + labelWidth > label.x
          && y < label.y + label.height && y + labelHeight > label.y);
        const labelY = candidates.find(y => y >= 2 && y + labelHeight <= height - 2 && !overlaps(y))
          ?? Math.max(2, Math.min(height - labelHeight - 2, candidates[0]));
        const label = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
        labels.push(label);
        ctx.fillStyle = 'rgba(24, 14, 35, 0.94)';
        ctx.strokeStyle = 'rgba(211, 164, 249, 0.75)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(label.x, label.y, label.width, label.height, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f6e7ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, label.x + label.width / 2, label.y + label.height / 2);
        hitAreas.push({ ...point, name: marker.name, label });
      }
      // The rim also attracts attention when the new encounter is outside the
      // panned viewport. Animation is finite and never changes the map's view.
      if (glow > 0) {
        ctx.shadowColor = '#c792ea';
        ctx.shadowBlur = 14 * glow;
        ctx.strokeStyle = `rgba(211, 164, 249, ${glow * 0.85})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(2, 2, width - 4, height - 4);
      }
      ctx.restore();
      return active;
    }

    return { update, connect, draw, titleAt };
  }

  return { create, PULSE_MS, SEARCH_RADIUS_WORLD };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AncestorMarkers;
