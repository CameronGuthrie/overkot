/**
 * Localization module – loads UI translations from langs/*.json files.
 * The pinned overkot-localisations submodule provides the registry and dictionaries.
 */

const fs = require('fs');
const path = require('path');

const LANGS_DIR = path.join(__dirname, '..', '..', 'langs');

/**
 * Load the languages metadata (code, display name, flag) from _languages.json.
 */
function loadLanguages() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LANGS_DIR, '_languages.json'), 'utf-8'));
  } catch (e) {
    console.error('[i18n] Failed to load _languages.json:', e.message);
    return [];
  }
}

/**
 * Load all translation JSON files from the langs/ directory.
 * Returns an object keyed by language code.
 */
function loadAllTranslations() {
  const translations = {};
  for (const { code } of LANGUAGES) {
    const file = `${code}.json`;
    try {
      translations[code] = JSON.parse(fs.readFileSync(path.join(LANGS_DIR, file), 'utf-8'));
    } catch (e) {
      console.error('[i18n] Failed to load ' + file + ':', e.message);
    }
  }
  return translations;
}

const LANGUAGES = loadLanguages();
const TRANSLATIONS = loadAllTranslations();

/**
 * Get translations for a language code.
 * Falls back to English if the requested code is not available.
 * @param {string} code - Language code (e.g., 'en', 'ja')
 * @returns {object}
 */
function getTranslations(code) {
  return TRANSLATIONS[code] || TRANSLATIONS.en;
}

function getLocaleTag(code) {
  const language = LANGUAGES.find(entry => entry.code === code);
  return language?.locale || language?.code || 'en';
}

// Sandboxed utility windows receive just the labels their local controls use.
function windowMessages(code, keys) {
  const dictionary = getTranslations(code);
  const labels = Object.fromEntries(keys.map(key => [key, dictionary?.[key] || TRANSLATIONS.en?.[key]]));
  return { locale: getLocaleTag(code), labels };
}

module.exports = { LANGUAGES, TRANSLATIONS, getTranslations, getLocaleTag, windowMessages };
