// Shared display contract for the expanded map, minimap and offline fixtures.
// Level overrides are tri-state: null/missing does not mean disabled.
const MapPOIs = (() => {
  const layers = ['faction_enclaves', 'world_trees', 'avakot_spawns', 'sap_trees',
    'vadagar_pools', 'ode_organs', 'boss_encounters', 'named_locations', 'dungeon_entrances'];
  const factions = {
    MapChampionFactionMarkerInfo: ['ChampionFaction.webp', 'ChampionHubName'],
    MapFeyFactionMarkerInfo: ['AlcasChildrenFactionIcon.webp', 'FeyHubName'],
    MapSilentRoseFactionMarkerInfo: ['SilentRoseFactionIcon.webp', 'SilentRoseEnclave'],
  };
  // Generic camp/patrol objectives are not useful persistent boss landmarks.
  const hiddenBossTypes = new Set(['BossBanneret', 'BossBanneretPatrol', 'BossCollectorShip']);
  const presets = {
    world_trees: ['trees', 'Tree.webp', 38, 34, false, 'World Tree', '/SF/Language/Locations/MapTree'],
    avakot_spawns: ['avakot', 'Vendor.webp', 34, 34, false, 'Avakot', '/SF/Language/NPC/Avakot'],
    sap_trees: ['sap', 'Pickup.webp', 30, 30, false, 'Wevetwood Sap', '/SF/Language/Items/WevetWoodSap'],
    vadagar_pools: ['vadagar', 'Stag.webp', 38, 38, false, 'Vadagar Pool', '/SF/Language/Locations/VadagarPool'],
    ode_organs: ['organs', 'Tower.webp', 42, 42, true, 'The Organ', '/SF/Language/Locations/TheOrgan'],
  };
  const humanize = value => typeof value === 'string'
    ? value.replace(/^SubBoss/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').trim() : '';
  const validPosition = p => p && Number.isFinite(p.x) && Number.isFinite(p.z)
    && (p.y === undefined || Number.isFinite(p.y)) && Math.abs(p.x) <= 1792 && Math.abs(p.z) <= 1792;
  const worldToMapPixel = (x, z) => ({ px: (x + 1792) * 2, py: (1792 - z) * 2 });
  const getTilePos = index => ({ x: Math.floor(index / 14) * 512, y: (13 - index % 14) * 512 });

  function rows(name, data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    if (name === 'dungeon_entrances') {
      // Raw schema 2 groups waypoints by dungeon category. Compact feeds may
      // provide a positions array instead. Portals and hints are not entrances.
      if (Array.isArray(data.positions)) return data.positions;
      return Object.entries(data).flatMap(([category, entries]) => Array.isArray(entries)
        ? entries.filter(row => row && typeof row === 'object').map(row => ({ ...row, category: row.category || category })) : []);
    }
    const field = name === 'faction_enclaves' ? 'enclaves' : name === 'vadagar_pools' ? 'pools' : 'positions';
    return Array.isArray(data[field]) ? data[field] : [];
  }

  function normalize(data) {
    const result = [], seen = new Set();
    const hasEntrances = data.dungeon_entrances != null;
    for (const name of layers) {
      for (const row of rows(name, data[name])) {
        if (!row || row.enabled === false || !validPosition(row.position)) continue;
        let preset = presets[name], zOrder = 0;
        if (name === 'faction_enclaves') {
          if (!Object.hasOwn(factions, row.entity_type)) continue;
          const faction = factions[row.entity_type];
          preset = ['enclaves', faction[0], 48, 42, true, row.faction || 'Faction Enclave', '/SF/Language/Locations/' + faction[1]];
          zOrder = 1;
        } else if (name === 'avakot_spawns' && row.npc_type !== 'AvakotVendorNpc') continue;
        else if (name === 'boss_encounters') {
          if (row.is_siege || hiddenBossTypes.has(row.subboss_type)) continue;
          preset = ['bosses', 'SubBossBarTopper.webp', 38, 34, true,
            humanize(row.subboss_type) || 'Boss Encounter', row.subboss_type ? '/SF/Language/Characters/' + row.subboss_type : null];
          zOrder = 2;
        } else if (name === 'dungeon_entrances') {
          preset = ['dungeons', 'EntranceDown.webp', 34, 30, true,
            humanize(row.name) || humanize(row.category) || 'Dungeon Entrance', row.loc_tag];
        } else if (name === 'named_locations') {
          if (row.has_position === false) continue;
          const legacyDungeon = /dungeon/i.test(row.name || '');
          if (hasEntrances && legacyDungeon) continue;
          preset = legacyDungeon
            ? ['dungeons', 'EntranceDown.webp', 34, 30, true, humanize(row.name) || 'Dungeon Entrance', row.loc_tag]
            : ['locations', 'MapLocationComplete.webp', 42, 38, false, humanize(row.name) || 'Location', row.loc_tag];
        }
        if (!preset) continue;
        const [category, icon, size, miniSize, shadow, label, labelKey] = preset;
        // Preserve distinct boss candidates at one hint; collapse duplicate
        // records of the same marker without rounding away corrected positions.
        const id = JSON.stringify([category, row.position.x, row.position.z, labelKey || label]);
        if (seen.has(id)) continue;
        seen.add(id);
        let detail = ['bosses', 'vadagar', 'organs'].includes(category)
          ? 'Possible encounter location; may be inactive.' : '';
        if (category === 'dungeons') detail = 'Entrance; quest and access requirements may apply.';
        if (row.start_hidden === true) detail = 'Hidden initially; availability depends on game progress.';
        result.push({ ...worldToMapPixel(row.position.x, row.position.z), icon, size, miniSize, shadow,
          category, zOrder, label, labelKey, detail });
      }
    }
    return result.sort((a, b) => a.zOrder - b.zOrder);
  }

  async function load(api, isCurrent = () => true) {
    const entries = await Promise.all(layers.map(async name => {
      try { return [name, await api.getMapData(name)]; } catch { return [name, null]; }
    }));
    if (!isCurrent()) return [];
    const markers = normalize(Object.fromEntries(entries));
    const keys = [...new Set(markers.map(row => row.labelKey).filter(key => typeof key === 'string'))];
    let resolved = {};
    if (keys.length && api?.resolveLocationNames) {
      try { resolved = await api.resolveLocationNames(keys) || {}; } catch {}
    }
    for (const marker of markers) {
      const translated = resolved[marker.labelKey];
      if (typeof translated === 'string' && translated && translated !== marker.labelKey) marker.label = translated;
    }
    return markers;
  }

  let legendRevision = 0;
  function retryMissingLegendIcons(panel) {
    if (!panel) return;
    const revision = ++legendRevision;
    for (const icon of panel.querySelectorAll('img')) {
      // An earlier signed-out load may still be in flight. A distinct URL
      // also prevents Chromium from joining that request on sign-in.
      if (!icon.naturalWidth) icon.src = `${icon.src.split('?')[0]}?retry=${revision}`;
    }
  }

  const title = marker => [marker.label, marker.detail].filter(Boolean).join('\n');
  // Keep a dense whole-island overview legible, especially in the minimap.
  const iconSize = (marker, zoom) => marker.size * Math.min(1, Math.max(0.35, zoom / 0.12));
  return { layers, rows, normalize, load, retryMissingLegendIcons, title, iconSize, validPosition, worldToMapPixel, getTilePos };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MapPOIs;
