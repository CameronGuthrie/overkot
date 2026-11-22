'use strict';

const OverkotTheme = (() => {
  const appearance = typeof module !== 'undefined' && module.exports
    ? require('../modules/appearance') : window.OverkotAppearance;
  const presets = {
    classic: { name: 'Classic', base: '#000000', panel: '#1b1b1b', surface: '#252525', header: '#282828', text: '#c8c8c8', muted: '#8c8c8c', accent: '#70b878', secondary: '#d9bc7b', blue: '#87cefa' },
    'dark-mint': { name: 'Dark Mint', base: '#101713', panel: '#1b211e', surface: '#27312b', header: '#28342d', text: '#d5e1da', muted: '#99afa2', accent: '#8bbda5', secondary: '#d9bc7b', blue: '#8dbad3' },
    midnight: { name: 'Midnight', base: '#0f1420', panel: '#191f2c', surface: '#252f40', header: '#2a3448', text: '#dce5f4', muted: '#9eacc4', accent: '#8eb9ec', secondary: '#c4ace4', blue: '#8eb9ec' },
    ember: { name: 'Ember', base: '#1c1410', panel: '#28201a', surface: '#372b22', header: '#3b2e24', text: '#eddfcf', muted: '#bba38e', accent: '#dea66f', secondary: '#d8c48d', blue: '#a6bdc4' },
    'high-contrast': { name: 'High Contrast', base: '#000000', panel: '#000000', surface: '#242424', header: '#111111', text: '#ffffff', muted: '#dedede', accent: '#ffff00', secondary: '#00ffff', blue: '#75dfff' },
  };
  const resolve = key => Object.hasOwn(presets, key) ? key : 'classic';
  const alpha = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : fallback;
  const rgba = (hex, opacity = 1) => `rgba(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(',')},${opacity})`;
  const px = value => `${Math.round(value * 100) / 100}px`;
  let currentConfig = {};
  const requestedFonts = new Set();
  function loadLanguageFont(family, language) {
    const name = appearance.webFontFamily(family, language);
    if (!name || requestedFonts.has(name)) return;
    const policy = document.querySelector?.('meta[http-equiv="Content-Security-Policy"]')?.content || '';
    if (!policy.includes('https://fonts.googleapis.com') || !policy.includes('https://fonts.gstatic.com')) return;
    requestedFonts.add(name);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${name.replaceAll(' ', '+')}:wght@400;600&display=swap`;
    document.head.appendChild(link);
  }
  function variables(config = {}, widgetId) {
    const a = appearance.resolve(config, widgetId);
    const selected = resolve(a.base ?? config.theme), theme = presets[selected];
    const highContrast = selected === 'high-contrast';
    const bg = highContrast ? 1 : alpha(a.backgroundOpacity, 1);
    const surface = highContrast ? 1 : alpha(a.surfaceOpacity, 1);
    const elements = highContrast ? 1 : alpha(a.elementOpacity, 1);
    // Foreground colours receive the Elements multiplier once. Raster art and
    // canvas use the shared numeric token in CSS; never fade a whole panel.
    const text = highContrast ? 1 : alpha(a.textOpacity, 1) * elements;
    const bar = highContrast ? 1 : alpha(a.barOpacity, 1) * elements;
    const border = alpha(a.borderOpacity, .24);
    const panelRadius = a.cornerShape === 'sharp' ? 0 : a.cornerShape === 'pill' ? Math.min(a.cornerRadius, 18) : a.cornerRadius;
    const controlRadius = a.cornerRadius === 0 || a.cornerShape === 'sharp' ? 0 : a.cornerShape === 'pill' ? 999 : Math.min(a.cornerRadius, 12);
    const barShape = a.barShape === 'inherit' ? a.cornerShape : a.barShape;
    const barRadius = a.cornerRadius === 0 || barShape === 'sharp' ? 0 : barShape === 'pill' ? 999 : Math.min(a.cornerRadius, a.barHeight / 2);
    const density = { compact: .8, comfortable: 1, spacious: 1.25 }[a.density] ?? 1;
    const outline = alpha(config.appearance ? a.widgetOutlineOpacity : config.widgetOutlineOpacity ?? a.widgetOutlineOpacity, 1);
    const accent = highContrast ? theme.accent : a.accentColor;
    const borderColor = highContrast ? '#ffffff' : a.borderColor;
    const textColor = highContrast ? theme.text : a.textColor;
    const muted = highContrast ? theme.muted : a.mutedColor;
    const background = highContrast ? theme.base : a.backgroundColor;
    const surfaceColor = highContrast ? theme.surface : a.elevatedColor;
    const secondary = highContrast ? theme.secondary : a.secondaryColor;
    const speed = 100 / a.motionSpeed;
    const captionSize = Math.max(9, a.fontSize - 3);
    const barLabels = a.barLabels === 'inside' && a.barHeight < captionSize + 3 ? 'below' : a.barLabels;
    return {
      '--bg-base': rgba(background, bg), '--bg-panel': highContrast ? theme.panel : a.surfaceColor,
      '--widget-bg': rgba(highContrast ? theme.panel : a.surfaceColor, bg), '--widget-header-bg': rgba(highContrast ? theme.header : a.headerColor, surface),
      '--background-opacity': String(bg), '--surface-opacity': String(surface), '--elements-opacity': String(elements),
      '--text-elements-opacity': String(text), '--bar-elements-opacity': String(bar),
      '--bg-widget': rgba(surfaceColor, surface), '--bg-widget-inactive': rgba(surfaceColor, surface),
      '--bg-widget-hover': highContrast ? '#333333' : rgba(accent, .15), '--bg-widget-active': highContrast ? '#444444' : rgba(accent, .24),
      '--text-primary': rgba(textColor, text), '--text-secondary': rgba(muted, text), '--text-muted': rgba(muted, text), '--text-color': rgba(textColor, text),
      '--bar-color': rgba(highContrast ? theme.accent : a.progressColor, bar), '--bg-bar-track': rgba(highContrast ? theme.surface : a.trackColor, bar), '--bar-text-color': rgba(textColor, text),
      '--accent-green': rgba(highContrast ? theme.accent : a.successColor, text), '--accent-yellow': rgba(highContrast ? theme.secondary : a.warningColor, text), '--accent-blue': rgba(highContrast ? theme.blue : a.infoColor, text),
      '--state-success': rgba(highContrast ? '#adffbd' : a.successColor, text), '--state-warning': rgba(highContrast ? '#ffff00' : a.warningColor, text), '--state-danger': rgba(highContrast ? '#ffb5a9' : a.dangerColor, text),
      '--theme-accent': rgba(accent, text), '--theme-secondary': rgba(secondary, text), '--focus-color': rgba(accent, 1),
      '--icon-primary': rgba(!highContrast && a.iconPalette === 'custom' ? a.iconPrimaryColor : textColor, text),
      '--icon-secondary': rgba(!highContrast && a.iconPalette === 'custom' ? a.iconSecondaryColor : accent, text),
      '--icon-detail': rgba(!highContrast && a.iconPalette === 'custom' ? a.iconDetailColor : secondary, text),
      '--icon-duration': `${Math.round(900 * speed * 100 / a.iconSpeed)}ms`,
      '--icon-angle': a.motionLevel === 'expressive' ? '28deg' : a.motionLevel === 'subtle' ? '10deg' : '18deg',
      '--icon-travel': a.motionLevel === 'expressive' ? '2px' : a.motionLevel === 'subtle' ? '.5px' : '1px',
      '--theme-border': rgba(borderColor, border),
      '--widget-outline-color': rgba(borderColor, border * outline),
      '--theme-accent-soft': highContrast ? theme.surface : rgba(accent, .11 * surface),
      '--theme-secondary-soft': highContrast ? theme.surface : rgba(secondary, .10 * surface), '--theme-control': rgba(surfaceColor, surface),
      '--font-ui': appearance.fontStack(a.fontFamily, config.locale || config.language), '--font-size': px(a.fontSize), '--font-weight': String(a.fontWeight), '--line-height': String(a.lineHeight),
      '--font-mono': appearance.fontStack('mono', config.locale || config.language), '--numeric-style': a.numericStyle === 'proportional' ? 'proportional-nums' : 'tabular-nums',
      '--type-small': px(Math.max(9, a.fontSize - 2)), '--type-caption': px(captionSize), '--type-title': px(a.fontSize + 1), '--type-display': px(a.fontSize + 10),
      '--widget-padding': px(a.padding * density), '--widget-padding-x': px((a.padding + 4) * density), '--widget-spacing': px(a.spacing * density), '--density': String(density),
      '--radius-panel': px(panelRadius), '--radius-control': px(controlRadius), '--radius-inner': px(Math.max(0, panelRadius - a.borderWidth)), '--radius-bar': px(barRadius),
      '--border-width': px(a.borderWidth), '--dock-icon-size': px(a.iconSize), '--dock-icon-gap': px(a.iconSpacing), '--icon-size': px(a.iconSize), '--icon-spacing': px(a.iconSpacing), '--bar-opacity': '1',
      '--bar-height': px(a.barHeight), '--bar-label-display': barLabels === 'hidden' ? 'none' : 'flex', '--bar-label-position': barLabels === 'below' ? 'relative' : 'absolute', '--bar-label-offset': barLabels === 'below' ? px(a.barHeight + 2) : '0px', '--bar-label-space': barLabels === 'below' ? px(a.fontSize + 4) : '0px', '--bar-overflow': barLabels === 'below' ? 'visible' : 'hidden', '--milestone-opacity': a.milestoneEmphasis ? String(.4 * bar) : '0',
      '--panel-surface-treatment': a.backgroundTreatment === 'tint' ? `linear-gradient(135deg, ${rgba(accent, .07 * bg)}, transparent 65%)` : 'linear-gradient(transparent, transparent)',
      '--surface-treatment': a.backgroundTreatment === 'tint' ? `linear-gradient(135deg, ${rgba(accent, .07 * surface)}, transparent 65%)` : 'linear-gradient(transparent, transparent)',
      '--surface-shadow': `inset 0 -12px 24px ${rgba('#000000', highContrast ? 0 : a.shadow * .0035 * bg)}`,
      '--surface-glow': `inset 0 0 16px ${rgba(accent, highContrast ? 0 : a.glow * .0015 * bg)}`,
      '--popup-shadow': `0 6px 22px ${rgba('#000000', highContrast ? 0 : a.shadow * .008)}`,
      '--effect-glow': `${Math.round(a.glow * .1)}px`,
      '--motion-fast': `${Math.round(120 * speed)}ms`, '--motion-base': `${Math.round(220 * speed)}ms`, '--motion-event': `${Math.round(850 * speed)}ms`,
      '--motion-ease': 'cubic-bezier(.2,.75,.25,1)', '--motion-distance': a.motionLevel === 'expressive' ? '3px' : a.motionLevel === 'subtle' ? '1px' : '2px',
    };
  }
  function refreshIcons(root = document) {
    const icons = [...(root.querySelectorAll?.('svg[data-widget-icon]') || [])];
    if (root.matches?.('svg[data-widget-icon]')) icons.unshift(root);
    for (const svg of icons) {
      if (svg.closest?.('[data-appearance-preview], .appearance-icon-preview')) continue;
      // Use the whole control as the animation scope so hovering its text or
      // padding, and focusing its checkbox, work just like hovering the glyph.
      const iconScope = svg.closest?.('.dock-button, .widget-card') || svg.parentElement;
      if (!iconScope) continue;
      const id = svg.getAttribute('data-widget-icon');
      const iconValues = appearance.resolve(currentConfig, id);
      for (const [key, value] of Object.entries(variables(currentConfig, id))) {
        if (key.startsWith('--icon-')) iconScope.style.setProperty(key, value);
      }
      iconScope.dataset.iconMotion = iconValues.iconMotion;
      iconScope.dataset.iconPalette = iconValues.iconPalette;
      window.OverkotMotion?.configure(iconValues, iconScope);
    }
  }
  function apply(config = {}, { root = document.documentElement, widgetId } = {}) {
    if (widgetId === undefined && root === document.documentElement) widgetId = new URLSearchParams(window.location.search).get('widget') || undefined;
    const values = appearance.resolve(config, widgetId);
    root.dataset.theme = resolve(values.base ?? config.theme);
    root.dataset.cornerShape = values.cornerShape;
    root.dataset.activeIndicator = values.activeIndicator;
    root.dataset.iconMotion = values.iconMotion;
    root.dataset.iconPalette = values.iconPalette;
    for (const [key, value] of Object.entries(variables(config, widgetId))) {
      root.style.setProperty(key, value);
      if (root === document.documentElement) document.body?.style.removeProperty(key);
    }
    if (root === document.documentElement) {
      currentConfig = config;
      root.lang = config.locale || window.i18n?.localeTags?.[config.language] || config.language || 'en';
      loadLanguageFont(values.fontFamily, root.lang);
      // Resolve inside each card too, for multi-widget legacy surfaces and previews.
      for (const widget of document.querySelectorAll('.timer-widget[data-widget]')) {
        for (const [key, value] of Object.entries(variables(config, widget.dataset.widget))) widget.style.setProperty(key, value);
        window.OverkotMotion?.configure(appearance.resolve(config, widget.dataset.widget), widget);
        const iconValues = appearance.resolve(config, widget.dataset.widget);
        widget.dataset.iconMotion = iconValues.iconMotion;
        widget.dataset.iconPalette = iconValues.iconPalette;
      }
      // Dock and picker symbols inherit the same per-widget icon overrides as
      // their panels. Dedicated appearance previews manage their own scope.
      refreshIcons(document);
    }
    window.OverkotMotion?.configure(values, root);
    return values;
  }
  return { presets, resolve, variables, apply, refreshIcons };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OverkotTheme;
else {
  window.OverkotTheme = OverkotTheme;
  // Set the default before paint; get the saved theme once the preload is ready.
  OverkotTheme.apply();
  let revision = 0;
  window.api?.onThemeChanged?.(config => { revision++; OverkotTheme.apply(config); });
  document.addEventListener('DOMContentLoaded', async () => {
    const request = revision;
    try { const state = await window.api.getState(); if (revision === request) OverkotTheme.apply({ ...state.config, locale: state.locale || state.config?.locale }); } catch { /* Keep the default palette. */ }
  });
}
