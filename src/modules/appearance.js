'use strict';

/** Appearance data shared by main and sandboxed renderers. No executable preset content. */
const OverkotAppearance = (() => {
  const VERSION = 1;
  const MAX_FILE_BYTES = 256 * 1024;
  const MAX_PRESETS = 50;
  // Native fallback fonts work in offline and network-restricted windows. CJK
  // families share code points but draw different glyphs for each language.
  const scriptFonts = {
    ja: { suffix: 'JP', sans: ['Yu Gothic UI', 'Hiragino Sans', 'Noto Sans CJK JP'], serif: ['Yu Mincho', 'Hiragino Mincho ProN', 'Noto Serif CJK JP'], mono: ['MS Gothic', 'Noto Sans Mono CJK JP'] },
    ko: { suffix: 'KR', sans: ['Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR'], serif: ['Batang', 'AppleMyungjo', 'Noto Serif CJK KR'], mono: ['GulimChe', 'Noto Sans Mono CJK KR'] },
    zh: { suffix: 'SC', sans: ['Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC'], serif: ['SimSun', 'Songti SC', 'Noto Serif CJK SC'], mono: ['NSimSun', 'Noto Sans Mono CJK SC'] },
    tc: { suffix: 'TC', sans: ['Microsoft JhengHei UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC'], serif: ['PMingLiU', 'Songti TC', 'Noto Serif CJK TC'], mono: ['MingLiU', 'Noto Sans Mono CJK TC'] },
    th: { suffix: 'Thai', sans: ['Leelawadee UI', 'Thonburi', 'Noto Sans Thai', 'Tahoma', 'Loma', 'Garuda'], serif: ['Angsana New', 'Silom', 'Norasi'], mono: ['Ayuthaya'] },
  };
  function scriptFontFor(language = '') {
    const tag = String(language).toLowerCase();
    const code = /^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(tag) ? 'tc' : tag.split('-')[0];
    return Object.hasOwn(scriptFonts, code) ? scriptFonts[code] : null;
  }
  function webFontFamily(family, language) {
    const script = scriptFontFor(language);
    return script ? `Noto ${family === 'serif' ? 'Serif' : 'Sans'} ${script.suffix}` : null;
  }
  function fontStack(family, language) {
    const script = scriptFontFor(language);
    const names = [];
    if (family === 'serif') names.push('Georgia', 'Palatino Linotype', ...(script?.serif || ['Noto Serif']));
    if (family === 'mono') names.push('Cascadia Code', 'Consolas', 'Courier New', ...(script?.mono || []));
    if (script) {
      if (family === 'serif') names.push(webFontFamily(family, language));
      names.push(...script.sans, webFontFamily('system', language));
    }
    const stack = [...new Set(names)].map(name => `'${name}'`);
    stack.push(family === 'mono' ? 'monospace' : family === 'serif' ? 'serif' : "system-ui, -apple-system, 'Segoe UI', sans-serif");
    return stack.join(', ');
  }
  const palettes = {
    classic: { name: 'Classic', base: '#000000', panel: '#1b1b1b', surface: '#252525', header: '#282828', text: '#c8c8c8', muted: '#8c8c8c', accent: '#70b878', secondary: '#d9bc7b', blue: '#87cefa' },
    'dark-mint': { name: 'Dark Mint', base: '#101713', panel: '#1b211e', surface: '#27312b', header: '#28342d', text: '#d5e1da', muted: '#99afa2', accent: '#8bbda5', secondary: '#d9bc7b', blue: '#8dbad3' },
    midnight: { name: 'Midnight', base: '#0f1420', panel: '#191f2c', surface: '#252f40', header: '#2a3448', text: '#dce5f4', muted: '#9eacc4', accent: '#8eb9ec', secondary: '#c4ace4', blue: '#8eb9ec' },
    ember: { name: 'Ember', base: '#1c1410', panel: '#28201a', surface: '#372b22', header: '#3b2e24', text: '#eddfcf', muted: '#bba38e', accent: '#dea66f', secondary: '#d8c48d', blue: '#a6bdc4' },
    'high-contrast': { name: 'High Contrast', base: '#000000', panel: '#000000', surface: '#242424', header: '#111111', text: '#ffffff', muted: '#dedede', accent: '#ffff00', secondary: '#00ffff', blue: '#75dfff' },
  };
  const choices = (...values) => values.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
  const number = (label, section, value, min, max, step = 1) => ({ type: 'number', label, section, default: value, min, max, step });
  const select = (label, section, value, options) => ({ type: 'select', label, section, default: value, options: choices(...options) });
  const bool = (label, section, value) => ({ type: 'boolean', label, section, default: value });
  const color = (label, value) => ({ type: 'color', label, section: 'colors', default: value });
  const fields = {
    backgroundColor: color('Background', '#000000'), surfaceColor: color('Panel surface', '#1b1b1b'),
    elevatedColor: color('Raised surface', '#252525'), headerColor: color('Header surface', '#282828'),
    textColor: color('Primary text', '#c8c8c8'), mutedColor: color('Secondary text', '#8c8c8c'),
    accentColor: color('Accent', '#70b878'), secondaryColor: color('Secondary accent', '#d9bc7b'),
    borderColor: color('Borders', '#70b878'), progressColor: color('Progress fill', '#70b878'),
    trackColor: color('Progress track', '#252525'), successColor: color('Success', '#70b878'),
    warningColor: color('Warning', '#d9bc7b'), dangerColor: color('Error', '#ed807d'), infoColor: color('Information', '#87cefa'),
    backgroundOpacity: number('Background opacity', 'transparency', 100, 0, 100),
    elementOpacity: number('Elements opacity', 'transparency', 100, 0, 100),
    surfaceOpacity: number('Inner surface opacity', 'transparency', 100, 0, 100),
    textOpacity: number('Text opacity', 'transparency', 100, 0, 100),
    barOpacity: number('Bar opacity', 'transparency', 100, 0, 100),
    borderOpacity: number('Border opacity', 'transparency', 24, 0, 100),
    widgetOutlineOpacity: number('Widget outline opacity', 'transparency', 100, 0, 100),
    fontFamily: select('Font family', 'typography', 'system', ['system', 'serif', 'mono']),
    fontSize: number('Text size', 'typography', 12, 10, 20),
    fontWeight: number('Text weight', 'typography', 400, 300, 700, 100),
    lineHeight: number('Line height', 'typography', 1.4, 1.1, 1.8, 0.05),
    numericStyle: select('Number spacing', 'typography', 'tabular', ['tabular', 'proportional']),
    density: select('Density', 'geometry', 'comfortable', ['compact', 'comfortable', 'spacious']),
    padding: number('Panel padding', 'geometry', 8, 2, 24),
    spacing: number('Content spacing', 'geometry', 6, 2, 20),
    cornerShape: select('Corner shape', 'corners', 'rounded', ['sharp', 'rounded', 'pill']),
    cornerRadius: number('Corner radius', 'corners', 10, 0, 32),
    borderWidth: number('Border thickness', 'corners', 1, 0, 4, 0.5),
    iconSize: number('Dock icon size', 'dock', 21, 16, 28),
    iconSpacing: number('Dock icon spacing', 'dock', 4, 0, 16),
    activeIndicator: select('Active indicator', 'dock', 'line', ['line', 'dot', 'none']),
    iconMotion: select('Icon animation', 'icons', 'hover', ['hover', 'loop', 'off']),
    iconPalette: select('Icon colours', 'icons', 'theme', ['theme', 'custom']),
    iconPrimaryColor: { ...color('Icon primary', '#c8c8c8'), section: 'icons' },
    iconSecondaryColor: { ...color('Icon accent', '#70b878'), section: 'icons' },
    iconDetailColor: { ...color('Icon detail', '#d9bc7b'), section: 'icons' },
    iconSpeed: number('Icon animation speed', 'icons', 100, 50, 200, 5),
    barHeight: number('Bar height', 'progress', 16, 4, 28),
    barShape: select('Bar shape', 'progress', 'inherit', ['inherit', 'sharp', 'rounded', 'pill']),
    barLabels: select('Bar labels', 'progress', 'inside', ['inside', 'below', 'hidden']),
    milestoneEmphasis: bool('Emphasize milestones', 'progress', true),
    shadow: number('Shadow strength', 'effects', 15, 0, 100),
    glow: number('Accent glow', 'effects', 0, 0, 100),
    backgroundTreatment: select('Surface treatment', 'effects', 'none', ['none', 'tint']),
    motionLevel: select('Motion level', 'motion', 'standard', ['off', 'subtle', 'standard', 'expressive']),
    motionSpeed: number('Motion speed', 'motion', 100, 50, 200, 5),
    ambientMotion: bool('Ambient animation', 'motion', false),
    eventEmphasis: bool('Event emphasis', 'motion', true),
    respectReducedMotion: bool('Respect system reduced motion', 'motion', true),
  };
  // Group border controls together; units are shared by every editor control.
  fields.borderColor.section = 'corners';
  fields.borderOpacity.section = 'corners';
  for (const key of ['fontSize', 'padding', 'spacing', 'cornerRadius', 'borderWidth', 'iconSize', 'iconSpacing', 'barHeight']) fields[key].unit = 'px';
  for (const key of ['backgroundOpacity', 'elementOpacity', 'surfaceOpacity', 'textOpacity', 'barOpacity', 'borderOpacity', 'widgetOutlineOpacity', 'motionSpeed', 'shadow', 'glow']) fields[key].unit = '%';
  fields.lineHeight.unit = '×';
  fields.iconSpeed.unit = '%';
  const widgetNames = {
    boss: 'Boss timers', crafting: 'Crafting timers', other: 'Other timers', affiliation: 'Affiliation', factions: 'Factions',
    odeinfamy: 'Ode infamy', wiki: 'Wiki', groupfinder: 'Group finder', minimap: 'Mini-map', arena: 'Arena',
    'world-watch': 'World watch', clock: 'Clock', weather: 'Weather', 'build-exporter': 'Build exporter',
    'temper-tracker': 'Temper tracker', 'title-tracker': 'Title tracker', 'wolf-training': 'Wolf training',
    'data-inventory': 'Inventory data', 'data-ee-log': 'Log data', player: 'Player', daily: 'Daily brief',
    'collection-log': 'Collection log', cosmetics: 'Cosmetics', 'mastery-tracker': 'Mastery tracker', resources: 'Resources',
    enhancements: 'Enhancements', 'crafting-planner': 'Crafting planner', activity: 'Activity', 'crafting-log': 'Crafting log',
    'session-analysis': 'Session analysis',
  };
  const widgetIds = Object.keys(widgetNames);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const defaults = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.default]));
  const resolveBase = value => Object.hasOwn(palettes, value) ? value : 'classic';

  function validField(key, value) {
    const field = fields[key];
    if (!field) return false;
    if (field.type === 'color') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    if (field.type === 'boolean') return typeof value === 'boolean';
    if (field.type === 'select') return field.options.some(option => option.value === value);
    return typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max;
  }
  function readValues(value, location, strict, warnings) {
    if (value === undefined) return {};
    if (!isRecord(value)) {
      if (strict) throw new Error(`${location} must contain appearance properties.`);
      return {};
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(fields, key)) { warnings.push(`Ignored unknown property ${location}.${key}.`); continue; }
      if (!validField(key, item)) {
        if (strict) {
          const field = fields[key];
          throw new Error(`${field.label} in ${location} ${field.type === 'number' ? `must be a number from ${field.min} to ${field.max}` : field.type === 'color' ? 'must be a six-digit hex color such as #8bbda5' : field.type === 'boolean' ? 'must be true or false' : 'has an unsupported option'}.`);
        }
        continue;
      }
      result[key] = typeof item === 'string' && fields[key].type === 'color' ? item.toLowerCase() : item;
    }
    return result;
  }
  function normalize(value, { strict = false, warnings = [] } = {}) {
    if (value === undefined || value === null) value = {};
    if (!isRecord(value)) { if (strict) throw new Error('Appearance must be an object.'); value = {}; }
    if (Object.hasOwn(value, 'version') && value.version !== VERSION && strict) throw new Error(`Appearance version ${String(value.version)} is not supported. This app supports version ${VERSION}.`);
    for (const key of Object.keys(value)) if (!['version', 'base', 'global', 'widgets'].includes(key)) warnings.push(`Ignored unknown appearance field ${key}.`);
    if (Object.hasOwn(value, 'base') && !Object.hasOwn(palettes, value.base) && strict) throw new Error('The base palette is not supported by this version of Overkot.');
    const result = { version: VERSION, base: resolveBase(value.base), global: readValues(value.global, 'global', strict, warnings), widgets: {} };
    if (value.widgets !== undefined && !isRecord(value.widgets) && strict) throw new Error('Widget overrides must be an object keyed by widget name.');
    if (isRecord(value.widgets)) for (const [id, overrides] of Object.entries(value.widgets)) {
      if (!widgetIds.includes(id)) { warnings.push(`Ignored unknown widget ${id}.`); continue; }
      const checked = readValues(overrides, widgetNames[id], strict, warnings);
      if (Object.keys(checked).length) result.widgets[id] = checked;
    }
    return result;
  }
  /** Capture legacy values once, without replacing explicit zero values. */
  function extract(config = {}) {
    if (isRecord(config.appearance)) return normalize(config.appearance);
    const global = {};
    for (const [oldKey, newKey] of [['backgroundOpacity', 'backgroundOpacity'], ['fontOpacity', 'textOpacity'], ['barOpacity', 'barOpacity'], ['widgetOutlineOpacity', 'widgetOutlineOpacity']]) {
      if (typeof config[oldKey] === 'number' && Number.isFinite(config[oldKey])) global[newKey] = Math.max(0, Math.min(100, config[oldKey]));
    }
    return normalize({ base: resolveBase(config.theme), global });
  }
  function resolve(config = {}, widgetId) {
    const appearance = extract(config), palette = palettes[appearance.base];
    const colors = { backgroundColor: palette.base, surfaceColor: palette.panel, elevatedColor: palette.surface,
      headerColor: palette.header, textColor: palette.text, mutedColor: palette.muted, accentColor: palette.accent,
      secondaryColor: palette.secondary, borderColor: palette.accent, progressColor: palette.accent, trackColor: palette.surface,
      successColor: palette.accent, warningColor: palette.secondary, infoColor: palette.blue };
    return { ...defaults, ...colors, ...(appearance.base === 'high-contrast' ? { borderOpacity: 100 } : {}),
      ...appearance.global, ...(appearance.widgets[widgetId] || {}), base: appearance.base };
  }
  const appearanceConfig = config => {
    const appearance = extract(config);
    const values = resolve({ appearance });
    return { appearance, theme: appearance.base, backgroundOpacity: values.backgroundOpacity,
      fontOpacity: values.textOpacity, barOpacity: values.barOpacity, widgetOutlineOpacity: values.widgetOutlineOpacity };
  };
  const make = (base, global = {}) => normalize({ base, global });
  const builtins = {
    classic: { name: 'Classic', description: 'Fully opaque panels with soft corners and full timer labels.', appearance: make('classic') },
    grove: { name: 'Spirit', description: 'Moss, warm ivory and rounded panels. Quiet and clear over the world.', appearance: make('dark-mint', { cornerShape: 'rounded', cornerRadius: 12, backgroundOpacity: 82, surfaceOpacity: 96, textColor: '#e3ede6', mutedColor: '#a9c0af', barHeight: 10, barLabels: 'below', shadow: 25, backgroundTreatment: 'tint', motionLevel: 'standard' }) },
    obsidian: { name: 'Grace', description: 'Crisp square edges, fine blue borders and a compact rhythm.', appearance: make('midnight', { cornerShape: 'sharp', cornerRadius: 0, borderWidth: 1, borderOpacity: 80, backgroundOpacity: 90, density: 'compact', padding: 6, spacing: 4, barShape: 'sharp', barHeight: 8, barLabels: 'below', motionLevel: 'subtle' }) },
    ember: { name: 'Courage', description: 'Warm bronze with pill controls, soft tracks and expressive feedback.', appearance: make('ember', { cornerShape: 'pill', cornerRadius: 18, barShape: 'pill', barHeight: 12, barLabels: 'below', backgroundOpacity: 86, glow: 15, shadow: 30, ambientMotion: true, motionLevel: 'expressive' }) },
    'high-contrast': { name: 'High Contrast', description: 'Opaque black, white and yellow with square geometry and strong focus.', appearance: make('high-contrast', { cornerShape: 'sharp', cornerRadius: 0, borderWidth: 2, motionLevel: 'subtle' }) },
  };
  function presetName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Give the preset a name between 1 and 64 characters.');
    return value.trim();
  }
  function normalizePresets(value, { strict = false } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || (strict && value.length > MAX_PRESETS)) {
      if (strict) throw new Error(`Keep at most ${MAX_PRESETS} custom presets.`);
      return [];
    }
    const result = [], seen = new Set();
    for (const preset of value.slice(0, MAX_PRESETS)) {
      try {
        if (!isRecord(preset) || typeof preset.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(preset.id) || seen.has(preset.id)) throw new Error('Custom preset identifiers must be unique letters, numbers, dashes or underscores.');
        if (!isRecord(preset.appearance)) throw new Error('Each custom preset must contain appearance values.');
        result.push({ id: preset.id, name: presetName(preset.name), appearance: normalize(preset.appearance, { strict }) });
        seen.add(preset.id);
      } catch (error) { if (strict) throw error; }
    }
    return result;
  }
  function exportPreset(name, appearance) {
    return JSON.stringify({ format: 'overkot-appearance', version: VERSION, name: presetName(name),
      metadata: { application: 'Overkot', createdAt: new Date().toISOString() },
      appearance: normalize(appearance, { strict: true }) }, null, 2) + '\n';
  }
  function validateImport(text) {
    try {
      if (typeof text !== 'string') throw new Error('Choose a JSON appearance preset file.');
      if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new Error('This preset is too large. Appearance files must be 256 KB or smaller.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('This file is not valid JSON. Choose an exported Overkot appearance preset.'); }
      if (!isRecord(data) || data.format !== 'overkot-appearance') throw new Error('This is not an Overkot appearance preset.');
      if (data.version !== VERSION) throw new Error(`Preset version ${String(data.version ?? '(missing)')} is not supported. This app supports version ${VERSION}.`);
      if (!isRecord(data.appearance)) throw new Error('The file is missing its appearance values.');
      const warnings = [];
      for (const key of Object.keys(data)) if (!['format', 'version', 'name', 'metadata', 'appearance'].includes(key)) warnings.push(`Ignored unknown file field ${key}.`);
      const appearance = normalize(data.appearance, { strict: true, warnings });
      const name = presetName(data.name);
      return { ok: true, preset: { name, appearance }, warnings,
        summary: { base: palettes[appearance.base].name, globalCount: Object.keys(appearance.global).length,
          widgetCount: Object.keys(appearance.widgets).length, motionLevel: resolve({ appearance }).motionLevel } };
    } catch (error) { return { ok: false, message: error.message }; }
  }
  return { VERSION, MAX_FILE_BYTES, MAX_PRESETS, fields, defaults, palettes, builtins, widgetIds, widgetNames,
    validField, normalize, normalizePresets, extract, resolve, resolveBase, appearanceConfig, fontStack, webFontFamily, presetName, exportPreset, validateImport, copy };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OverkotAppearance;
else window.OverkotAppearance = OverkotAppearance;
