/**
 * Localized timer names from compact update packs, with a selected-language
 * fallback to the existing owned JSON endpoint while the feed is unavailable.
 *
 * Directory layout (under appPaths):
 *   lang/en.json, lang/de.json, …     – fallback language data
 *   cache/en-names.json, …            – derived name maps (tag → display name)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { writeEncryptedText, readEncryptedText, writeEncryptedJSON, readEncryptedJSON } = require('./fileEncryption');
const { getCollectionCatalog } = require('./collectionCatalog');

const { services } = require('./serviceConfig');
const LANGUAGE_BASE = services.dataOrigin && `${services.dataOrigin}/protected/files`;
const { SUPPORTED_LOCALES, normalizeLocale } = require('./gameLocales');
let dataManager = null;
const languageDownloads = new Map();
const languageMemory = new Map();


/** Bump when derive logic changes to force cache rebuild */
const CACHE_VERSION = 6;
const BLESSED_MEETING_TAG = 'UPGRADEGIVEN_GODANDGHOST';
const BLESSED_MEETING_KEY = '/SF/Language/SystemMessages/AncestorBoosterNotification';
// Selected-key translations preserve the corrected label with older compact
// feeds or offline caches. A supplied game-language key takes precedence.
const BLESSED_MEETING_NAMES = {
  de: 'Gesegnete Begegnung', en: 'Blessed Meeting', es: 'Encuentro bendito', fr: 'Rencontre Bénie',
  it: 'Incontro Benedetto', ja: '祝福された出会い', ko: '축복받은 만남', pl: 'Błogosławione spotkanie',
  pt: 'Bendito Encontro', ru: 'Благословенная встреча', tc: '蒙福相會', th: 'จุดนัดพบเพื่อรับพร',
  tr: 'Kutsanmış Buluşma', uk: 'Благословенна зустріч', zh: '受祝福的会面',
};
function recipeTag(itemType) {
  if (typeof itemType !== 'string') return null;
  const leaf = itemType.split('/').pop().replace(/RecipeItem$/, '').replace(/Blueprint$/, '').replace(/Recipe$/, '');
  return leaf ? `PendingRecipe:${leaf}` : null;
}
function approvedRecipeNames(names) {
  const approved = new Set(getCollectionCatalog().items.map(row => recipeTag(row.recipe?.itemType)).filter(Boolean));
  return Object.fromEntries(Object.entries(names).filter(([tag]) => !tag.startsWith('PendingRecipe:') || approved.has(tag)));
}
function withTimerNameCorrections(names, locale, entries = {}) {
  const value = entries[BLESSED_MEETING_KEY] || names[BLESSED_MEETING_KEY];
  return { ...approvedRecipeNames(names), [BLESSED_MEETING_TAG]: typeof value === 'string' && value.trim()
    ? value : BLESSED_MEETING_NAMES[normalizeLocale(locale)] };
}
let _debug = false;

function _log(...args) {
  if (!_debug) return;
  const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  console.log(`[${ts}][LANG]`, ...args);
}

// ═══════════════════════════════════════════════════════
// Refresh the selected fallback language
// ═══════════════════════════════════════════════════════

/**
 * Revalidate a single language JSON. Writes to lang/<code>.json.
 * Returns true on success, false on failure.
 */
async function downloadLanguage(locale) {
  if (!LANGUAGE_BASE) return false;
  locale = normalizeLocale(locale);
  if (languageDownloads.has(locale)) return languageDownloads.get(locale);
  const task = refreshLanguage(locale).finally(() => languageDownloads.delete(locale));
  languageDownloads.set(locale, task);
  return task;
}

async function refreshLanguage(locale) {
  const { LANG_DIR } = require('./appPaths');
  const url = `${LANGUAGE_BASE}/Languages_${locale}.json`;
  const dest = path.join(LANG_DIR, `${locale}.json`);
  const metaPath = path.join(LANG_DIR, `${locale}-http.json`);
  let meta = {};
  try {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    if (meta.url === url && Date.now() < meta.nextCheck && meta.nextCheck <= Date.now() + 24 * 60 * 60 * 1000) {
      return fs.existsSync(dest);
    }
    const headers = { 'Accept-Encoding': 'gzip, deflate, br' };
    if (fs.existsSync(dest) && meta.url === url && meta.etag) headers['If-None-Match'] = meta.etag;
    if (fs.existsSync(dest) && meta.url === url && meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
    _log(`Refreshing selected language ${locale}...`);
    const resp = await (dataManager?.http || axios).get(url, { timeout: 15000, responseType: 'text', headers, maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024, validateStatus: status => status === 200 || status === 304 });
    const text = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    if (resp.status !== 304) {
      const entries = JSON.parse(text);
      if (!entries || Array.isArray(entries) || typeof entries !== 'object'
          || !Object.entries(entries).some(([key, value]) => key.startsWith('/SF/Language/') && typeof value === 'string')) {
        throw new Error('Invalid language data');
      }
      const temp = `${dest}.tmp`;
      writeEncryptedText(temp, text);
      fs.renameSync(temp, dest);
      languageMemory.delete(locale);
    }
    fs.writeFileSync(metaPath, JSON.stringify({ url, etag: resp.headers.etag || meta.etag,
      lastModified: resp.headers['last-modified'] || meta.lastModified, nextCheck: Date.now() + 24 * 60 * 60 * 1000 }));
    return true;
  } catch (e) {
    _log(`  Failed to download ${locale}.json: ${e.message}`);
    try { fs.writeFileSync(metaPath, JSON.stringify({ ...meta, url, nextCheck: Date.now() + 15 * 60 * 1000 })); } catch {}
    return false;
  }
}


// ═══════════════════════════════════════════════════════
// Load raw language data
// ═══════════════════════════════════════════════════════

/**
 * Load a language JSON file. Returns {} if not found.
 * @param {string} locale
 * @returns {Record<string, string>}
 */
function loadLanguageData(locale, { compact = true } = {}) {
  locale = normalizeLocale(locale);
  const compactData = compact && dataManager?.readJSON(`locations/${locale}.json`);
  if (compactData) return compactData;
  const { LANG_DIR } = require('./appPaths');
  const filePath = path.join(LANG_DIR, `${locale}.json`);
  try {
    const stat = fs.statSync(filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (languageMemory.get(locale)?.signature === signature) return languageMemory.get(locale).entries;
    const text = readEncryptedText(filePath);
    if (text !== null) {
      const entries = JSON.parse(text);
      languageMemory.set(locale, { signature, entries });
      return entries;
    }
  } catch (e) {
    _log(`Failed to load ${locale}.json: ${e.message}`);
  }
  return {};
}

// ═══════════════════════════════════════════════════════
// Derive display names (tag → localized name)
// ═══════════════════════════════════════════════════════

/**
 * Compass direction translations
 */
const COMPASS = {
  de: { East: 'Ost', South: 'Süd', North: 'Nord' },
  en: { East: 'East', South: 'South', North: 'North' },
  es: { East: 'Este', South: 'Sur', North: 'Norte' },
  fr: { East: 'Est', South: 'Sud', North: 'Nord' },
  it: { East: 'Est', South: 'Sud', North: 'Nord' },
  ja: { East: '東', South: '南', North: '北' },
  ko: { East: '동', South: '남', North: '북' },
  pl: { East: 'Wschód', South: 'Południe', North: 'Północ' },
  pt: { East: 'Leste', South: 'Sul', North: 'Norte' },
  ru: { East: 'Восток', South: 'Юг', North: 'Север' },
  tc: { East: '東', South: '南', North: '北' },
  th: { East: 'ตะวันออก', South: 'ใต้', North: 'เหนือ' },
  uk: { East: 'Схід', South: 'Південь', North: 'Північ' },
  tr: { East: 'Doğu', South: 'Güney', North: 'Kuzey' },
  zh: { East: '东', South: '南', North: '北' },
};

/**
 * Derive localized display names from raw language data.
 * Port of Rust derive_names_from_entries().
 * @param {Record<string, string>} entries – full language JSON (key→value)
 * @param {string} locale – e.g. 'en'
 * @returns {Record<string, string>} – tag→display name
 */
function deriveNames(entries, locale) {
  const map = {};
  const get = (k) => entries[k] || null;

  // ── CollectorTimer ──
  const v1 = get('/SF/Language/Objectives/CollectorTaleTitle');
  const v2 = get('/SF/Language/Subtitles/Quests/DFOGRQ00160Deora');
  if (v1 && v2) {
    const words1 = v1.split(/\s+/);
    const words2 = v2.split(/\s+/);
    let best = '';
    for (let s1 = 0; s1 < words1.length; s1++) {
      for (let len = 1; len <= words1.length - s1; len++) {
        const phrase1 = words1.slice(s1, s1 + len);
        for (let s2 = 0; s2 <= words2.length - len; s2++) {
          const phrase2 = words2.slice(s2, s2 + len);
          if (phrase1.every((w, i) => w.toLowerCase() === phrase2[i].toLowerCase())) {
            const matched = phrase1.join(' ');
            if (matched.length > best.length) best = matched;
          }
        }
      }
    }
    if (best) map['CollectorTimer'] = best;
  }

  // ── Siege events ──
  const siegeCompleted = get('/SF/Language/Progression/SiegeCompleted');
  const siegeFailed = get('/SF/Language/Progression/SiegeFailed');
  const extractFirst = (s) => (s || '').split(/\s+/)[0] || '';
  let siegeWord = null;
  if (siegeCompleted) siegeWord = extractFirst(siegeCompleted);
  else if (siegeFailed) siegeWord = extractFirst(siegeFailed);

  if (siegeWord) {
    const fort = get('/SF/Language/Locations/FortCurlail') || get('/SF/Language/Locations/FortCurlailName');
    if (fort) {
      const place = fort.split(/\s+/).pop() || fort;
      map['CurlailSiege'] = `${place} ${siegeWord}`;
    }
    const kfort = get('/SF/Language/Locations/KearnholdFortName');
    if (kfort) {
      const place = kfort.split(/\s+/).pop() || kfort;
      map['KearnholdSiege'] = `${place} ${siegeWord}`;
    }
    const mfort = get('/SF/Language/Locations/MirifuirName');
    if (mfort) {
      const place = mfort.split(/\s+/).pop() || mfort;
      map['MirifuirSiege'] = `${place} ${siegeWord}`;
    }
  }

  // ── FencerDuelSwordDeco (Captain Carmo duels) ──
  const captainCarmo = get('/SF/Language/Characters/CaptainCarmoName');
  if (captainCarmo) {
    const compass = COMPASS[locale] || COMPASS.en;
    const localiseSuffix = (suffix) => {
      if (!suffix) return '';
      if (suffix === 'Vertonn') {
        const v = get('/SF/Language/Locations/VertonnVillageName');
        return v || suffix;
      }
      // Split CamelCase cardinals (e.g. SouthEast → ['South','East']) and
      // localise each piece, falling back to the raw word if missing.
      const parts = suffix.match(/[A-Z][a-z]*/g) || [suffix];
      return parts.map(p => compass[p] || p).join(' ');
    };
    const variants = ['North', 'East', 'SouthEast', 'Vertonn', 'South', ''];
    for (const v of variants) {
      const sub = localiseSuffix(v);
      map[`FencerDuelSwordDeco${v}`] = sub ? `${captainCarmo} (${sub})` : captainCarmo;
    }
  }

  // ── Direct character keys (SubBoss, events) ──
  const DIRECT = [
    [BLESSED_MEETING_TAG, BLESSED_MEETING_KEY],
    ['RuinsHint12-SubBoss', '/SF/Language/Characters/SubBossNimrod'],
    ['CorruptedNestSidae-SubBoss', '/SF/Language/Characters/SubBossWazzard'],
    ['MendicantKingSpawned', '/SF/Language/Characters/MendicantKing'],
    ['Oasis-SubBoss', '/SF/Language/Characters/SubBossArmoredMockery'],
    ['SapTrees-SubBoss', '/SF/Language/Characters/SubBossCorruptedSproutFolk'],
    ['SlaneCenoteCave-SubBoss', '/SF/Language/Characters/SubBossSpider'],
    ['LargeRuinsCamp-SubBoss', '/SF/Language/Characters/SubBossMaceBanneret'],
    ['GalvinarCorruptedB-SubBoss', '/SF/Language/Characters/SubBossMendicantKnight'],
    ['StoneHengeA-SubBoss', '/SF/Language/Characters/SubBossHunter'],
    ['VadagarStag-SubBoss', '/SF/Language/Characters/MimicGarren'],
    ['Dungeon-NeathPortal-A-Moray-SubBoss', '/SF/Language/Characters/SubBossCorruptedSproutFolkProc'],
    ['Dungeon-UndercityPortalWyndounGranary-SubBoss', '/SF/Language/Characters/SubBossGreatswordProc'],
    ['Dungeon-UndercityPortalUplandsTheater-SubBoss', '/SF/Language/Characters/SubBossAxeOfficerProc'],
    ['Dungeon-GladesUplands-SubBoss', '/SF/Language/Characters/SubBossArmoredMockery'],
    ['Dungeon-NeathPortal-C-Digsite-SubBoss', '/SF/Language/Characters/SubBossSpiderProc'],
    ['Dungeon-UndercityPortalHillside-SubBoss', '/SF/Language/Characters/SubBossMaceOfficerProc'],
    ['NextRefill', '/SF/Language/Items/WevetSeedConsumableName'],
  ];
  for (const [tag, key] of DIRECT) {
    const val = get(key);
    if (val) map[tag] = val;
  }

  // ── Syndicate swap ──
  const syndicateMsg = get('/SF/Language/Syndicates/InitiationWaitingMessage');
  map['LastSyndicateSwapTime'] = syndicateMsg || 'Syndicate Swap';

  // ── Daily Affiliation cap label ──
  // TODO: update the path once confirmed in a future game build; currently
  // mirrors the Warframe-style key found in the lang files.
  const dailyStandingCap = get('/Lotus/Language/Syndicates/DailyStandingCap');
  if (dailyStandingCap) map['DailyAffiliation'] = dailyStandingCap;

  // ── Faction syndicate names ──
  const factionKeys = [
    ['ChampionSyndicate', '/SF/Language/Syndicates/ChampionName'],
    ['FeySyndicate', '/SF/Language/Syndicates/FeyName'],
    ['SilentRoseSyndicate', '/SF/Language/Syndicates/SilentRoseName'],
    ['OdeSyndicate', '/SF/Language/Syndicates/OdeName'],
    ['OdeSyndicateDesc', '/SF/Language/Syndicates/OdeDesc'],
  ];
  for (const [tag, key] of factionKeys) {
    const val = get(key);
    if (val) map[tag] = val;
  }

  // ── PollutionTower (Organ) timers ──
  const polluterBase = get('/SF/Language/Progression/PolluterTowerStartedB');
  if (polluterBase) {
    const dirs = COMPASS[locale] || COMPASS['en'];
    const towers = [
      ['PollutionTowerODell', 'East'],
      ['PollutionTowerKearnhold', 'South'],
      ['PollutionTowerAirdelands', 'North'],
    ];
    for (const [tag, dir] of towers) {
      map[tag] = `${polluterBase} ${dirs[dir] || dir}`;
    }
  }

  // ── HardModeSubBoss variants (prefix with "The Cogah") ──
  const cogahPrefix = get('/SF/Language/Lore/TheCogahTitle')
    || get('/SF/Language/Characters/TheCogah')
    || 'The Cogah';
  for (const [tag, name] of Object.entries(map)) {
    if (tag.endsWith('-SubBoss')) {
      const hmTag = tag.replace('-SubBoss', '-HardModeSubBoss');
      if (!map[hmTag]) map[hmTag] = `${cogahPrefix} ${name}`;
    }
  }

  // Recipe labels follow the same approved catalogue that drives collections.
  // Keep tag formation identical to inventoryPoller; future recipes have no
  // bundled identifier or derived translation until they become obtainable.
  for (const row of getCollectionCatalog().items) {
    const tag = recipeTag(row.recipe?.itemType);
    if (!tag) continue;
    const val = get(row.langKey) || row.name;
    if (val) map[tag] = val;
  }

  return map;
}

// ═══════════════════════════════════════════════════════
// Names cache management
// ═══════════════════════════════════════════════════════

/**
 * Get the cached names path for a locale.
 */
function namesCachePath(locale) {
  const { CACHE_DIR } = require('./appPaths');
  return path.join(CACHE_DIR, `${locale}-names.json`);
}

/**
 * Ensure localized names are available for a locale.
 * Downloads language data if needed, derives names, caches result.
 * Returns tag→display name map (may be empty if download fails).
 *
 * @param {string} locale – e.g. 'en'
 * @returns {Promise<Record<string, string>>}
 */
async function ensureNamesForLanguage(locale, { network = true } = {}) {
  locale = normalizeLocale(locale);
  const { LANG_DIR } = require('./appPaths');
  _log(`Ensuring names for locale: ${locale}`);

  if (network && dataManager?.manifest?.files[`names/${locale}.json`]) {
    await Promise.all([dataManager.ensureAsset(`names/${locale}.json`), dataManager.ensureAsset(`locations/${locale}.json`)]);
  }
  const compactNames = dataManager?.readJSON(`names/${locale}.json`);
  if (compactNames && Object.values(compactNames).every(value => typeof value === 'string')) {
    return withTimerNameCorrections(compactNames, locale, loadLanguageData(locale, { compact: false }));
  }
  if (network) await downloadLanguage(locale);
  const langFile = path.join(LANG_DIR, `${locale}.json`);
  let sourceVersion = null;
  try { const stat = fs.statSync(langFile); sourceVersion = `${stat.size}:${stat.mtimeMs}`; } catch {}

  // 1. Check existing cache (encrypted)
  const cachePath = namesCachePath(locale);
  try {
    const cache = readEncryptedJSON(cachePath);
    if (cache && cache.version === CACHE_VERSION && cache.names && cache.sourceVersion === sourceVersion) {
      _log(`  Loaded ${Object.keys(cache.names).length} cached names for ${locale}`);
      return withTimerNameCorrections(cache.names, locale, loadLanguageData(locale, { compact: false }));
    }
    if (cache) _log(`  Cache version mismatch (${cache.version} vs ${CACHE_VERSION}), rebuilding...`);
  } catch (e) {
    _log(`  Bad cache file, rebuilding: ${e.message}`);
  }

  // 2. Ensure language JSON is downloaded
  if (!fs.existsSync(langFile)) {
    return withTimerNameCorrections({}, locale);
  }

  // 3. Load and derive
  const entries = loadLanguageData(locale, { compact: false });
  if (Object.keys(entries).length === 0) {
    _log(`  Empty language data for ${locale}`);
    return withTimerNameCorrections({}, locale);
  }

  const names = withTimerNameCorrections(deriveNames(entries, locale), locale, entries);
  _log(`  Derived ${Object.keys(names).length} names for ${locale}`);

  // 4. Write cache (encrypted)
  try {
    const cacheObj = { version: CACHE_VERSION, sourceVersion, locale, names };
    writeEncryptedJSON(cachePath, cacheObj);
    _log(`  Cached names written to ${cachePath}`);
  } catch (e) {
    _log(`  Failed to write names cache: ${e.message}`);
  }

  return names;
}

/**
 * Look up a display name for a timer tag.
 * @param {Record<string, string>} namesMap – from ensureNamesForLanguage()
 * @param {string} tag – e.g. 'RuinsHint12-SubBoss' or 'PendingRecipe:BromiusHelm'
 * @returns {string} – localized display name, or cleaned-up tag as fallback
 */
function lookupName(namesMap, tag) {
  if (!namesMap || !tag) return tag || '';

  // Exact match
  if (namesMap[tag]) return namesMap[tag];

  // PendingRecipe: try with and without the prefix
  if (tag.startsWith('PendingRecipe:')) {
    const itemKey = tag.slice('PendingRecipe:'.length);
    if (namesMap[`PendingRecipe:${itemKey}`]) return namesMap[`PendingRecipe:${itemKey}`];
    // Clean fallback: remove Recipe/Blueprint suffixes
    return itemKey
      .replace(/RecipeItem$/, '')
      .replace(/Blueprint$/, '')
      .replace(/Recipe$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2'); // CamelCase → spaces
  }

  // Fallback: humanise the tag
  return tag
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

module.exports = {
  downloadLanguage,
  ensureNamesForLanguage,
  lookupName,
  loadLanguageData,
  setDebug: (v) => { _debug = v; },
  SUPPORTED_LOCALES,
  deriveNames,
  CACHE_VERSION,
  setDataManager: manager => { dataManager = manager; },
};
