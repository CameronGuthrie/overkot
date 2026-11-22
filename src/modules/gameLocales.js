'use strict';

const languages = require('../../langs/_languages.json');
const SUPPORTED_LOCALES = Object.freeze(languages.map(language => language.code));
const languageFiles = new Set(SUPPORTED_LOCALES.map(code => `Languages_${code}.json`));

// Game data and saved preferences use "tc". Browsers and operating systems
// report Traditional Chinese as a script or region variant of "zh".
function normalizeLocale(value) {
  if (typeof value !== 'string') return 'en';
  const tag = value.toLowerCase().replaceAll('_', '-');
  if (SUPPORTED_LOCALES.includes(tag)) return tag;
  try {
    const locale = new Intl.Locale(tag);
    if (locale.language === 'zh' && locale.maximize().script === 'Hant') return 'tc';
    if (SUPPORTED_LOCALES.includes(locale.language)) return locale.language;
  } catch { /* Unrecognised saved preferences fall back to English. */ }
  return 'en';
}

module.exports = { SUPPORTED_LOCALES, normalizeLocale, isGameLanguageFile: name => languageFiles.has(name) };
