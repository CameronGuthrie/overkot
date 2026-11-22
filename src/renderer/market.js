'use strict';

// The renderer receives only public account and inventory projections. Credentials,
// market requests, inventory validation and session storage belong to the main process.
(() => {
  const $ = id => document.getElementById(id);
  const api = window.api;
  let state = { authenticated: false, catalogue: [], inventory: { rows: [] }, listings: [], trading: {} };
  let stateRevision = 0;
  let stateLoaded = false;
  let stateLoadError = '';
  let signinRevision = 0;
  let tab = 'browse';
  let browseKind = 'any';
  let advancedFilters = null;
  const selectedBrowseTempers = new Set();
  let browseRows = [];
  let browseMeta = {};
  let browseRevision = 0;
  let browseBusy = false;
  let browseLoaded = false;
  let composer = null;
  let closingListing = null;
  let mutationBusy = false;
  let toastTimer;
  let configRevision = 0;
  let categoryDisplayNames = new Map();
  let catalogueById = new Map();
  const pendingListings = new Set();
  const expandedInventoryGroups = new Set();
  const expandedTemperDetails = new Set();
  const TRADE_SLOT_COUNT = 6;
  const QUALITY_LABELS = { NONE: ['marketUiStock', 'Stock'], WORN: ['marketUiStock', 'Stock'], MILITARY: ['marketUiMilitary', 'Military'], OFFICER: ['marketUiOfficer', 'Officer'], NOBLE: ['marketUiNoble', 'Noble'], MASTERWORK: ['marketUiSovereign', 'Sovereign'], LEGENDARY: ['marketUiLegendary', 'Legendary'] };
  const TEMPER_LIMITS = { NONE: [0, 1], WORN: [0, 1], MILITARY: [1, 3], OFFICER: [2, 4], NOBLE: [3, 5], MASTERWORK: [4, 6], LEGENDARY: [4, 8] };
  const GRIP_LABELS = { UNIVERSAL: ['marketUiUniversal', 'Universal'], BowSkill: ['marketUiBow', 'Bow'], ThrowingKnivesSkill: ['marketUiFlyblade', 'Flyblade'], HeavySkill: ['marketUiHeavy', 'Heavy'], SwordSkill: ['marketUiLongBlade', 'Long Blade'], CastSkill: ['marketUiMagick', 'Magick'], PolearmSkill: ['marketUiPolearm', 'Polearm'], ShieldsSkill: ['marketUiShield', 'Shield'], DaggerSkill: ['marketUiShortBlade', 'Short Blade'] };
  // Keep display labels aligned with avakot.market; category values remain API IDs.
  const CATEGORY_LABELS = { armor: ['marketUiArmour', 'Armour'], blueprint: ['marketUiChaosChordstone', 'Chaos Chordstone'], cosmetic: ['marketUiAccessories', 'Accessories'], 'key-item': ['marketUiKeys', 'Keys'], kintsugi: ['marketUiJoinery', 'Joinery'], 'quest-item': ['marketUiMiscellaneous', 'Miscellaneous'], resource: ['marketUiResources', 'Resources'], mote: ['marketUiTotems', 'Totems'], rune: ['marketUiRunes', 'Runes'], totem: ['marketUiTalisman', 'Talisman'], weapon: ['marketUiWeapons', 'Weapons'], weapons: ['marketUiWeapons', 'Weapons'] };
  const ARCS_IMAGE = 'overkot-game-data://images/SF/Interface/Graphics/StoreItems/Currency/ArcsBundleSmall.png';

  let language = '';
  let interfaceMessages = null;
  const tr = (key, fallback, values = {}) => (interfaceMessages?.[key] || fallback).replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
  const localLabel = pair => Array.isArray(pair) ? tr(...pair) : undefined;

  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const formatNumber = value => number(value).toLocaleString(document.documentElement?.lang || undefined);
  const titleCase = value => String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  const enumMessages = {
    ACTIVE: 'marketUiActive', PAUSED: 'marketUiPaused', CLOSED: 'marketUiClosed',
    AVAILABLE: 'marketUiAvailable', OFFLINE: 'marketUiOffline', ONLINE: 'gfOnline',
    COURAGE: 'inventoryCourage', GRACE: 'inventoryGrace', SPIRIT: 'inventorySpirit',
  };
  const enumLabel = value => interfaceMessages?.[enumMessages[String(value).toUpperCase()]] || titleCase(value);
  const categoryLabel = category => state.categoryLabels?.[category] || categoryDisplayNames.get(category) || localLabel(CATEGORY_LABELS[category]) || titleCase(category);
  const rows = () => Array.isArray(state.inventory?.rows) ? state.inventory.rows : [];
  const catalogue = () => Array.isArray(state.catalogue) ? state.catalogue : [];
  const myListings = () => Array.isArray(state.listings) ? state.listings : [];
  const nameOf = item => item?.name || item?.item?.name || catalogue().find(entry => entry.id === item?.itemId)?.name || tr('marketUiUnknownItem', 'Unknown item');
  const statusOf = listing => String(listing.status || '').toUpperCase();
  const isOpen = listing => ['ACTIVE', 'PAUSED'].includes(statusOf(listing));
  const messageOf = result => result?.message || (typeof result?.error === 'string' ? result.error : result?.error?.message) || tr('marketUiTheMarketCouldNotCompleteThis', 'The market could not complete this request. Please try again.');

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function button(text, className, action) {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }

  function itemImage(item) {
    const source = window.GameDataImages.marketImageUrl(item?.imageUrl || item?.item?.imageUrl);
    const fallback = () => { const element = node('span', 'item-image item-fallback icon-market'); element.setAttribute('aria-hidden', 'true'); return element; };
    if (!source) return fallback();
    const image = node('img', 'item-image');
    image.src = source;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.replaceWith(fallback()), { once: true });
    return image;
  }

  function empty(target, title, description, actionText, action) {
    const box = node('div', 'empty-state');
    const symbol = node('span', 'empty-symbol icon-market');
    symbol.setAttribute('aria-hidden', 'true');
    box.append(symbol, node('h3', '', title));
    if (description) box.append(node('p', '', description));
    if (actionText) box.append(button(actionText, 'primary-button', action));
    target.replaceChildren(box);
  }

  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
  }

  function errorAt(id, message) {
    $(id).textContent = message || '';
    $(id).hidden = !message;
  }

  async function invoke(method, payload) {
    try {
      if (typeof api?.[method] !== 'function') return { ok: false, message: tr('marketUiMarketIntegrationIsUnavailableInThis', 'Market integration is unavailable in this app version.') };
      return await api[method](payload);
    } catch {
      return { ok: false, message: tr('marketUiUnableToReachTheMarketCheck', 'Unable to reach the market. Check your connection and try again.') };
    }
  }

  function applyLanguage(config = {}) {
    const next = config.language || 'en';
    if (next === language) return;
    language = next;
    const i18n = window.i18n;
    interfaceMessages = i18n?.translations?.[language] || i18n?.translations?.en;
    document.documentElement.lang = i18n?.localeTags?.[language] || language;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      const text = interfaceMessages?.[element.dataset.i18n];
      if (text) element.textContent = text;
    }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const marker = 'data-i18n-' + attribute;
      for (const element of document.querySelectorAll('[' + marker + ']')) {
        const text = interfaceMessages?.[element.getAttribute(marker)];
        if (text) element.setAttribute(attribute, text);
      }
    }
    for (const [id, labels] of [['browse-quality-min', QUALITY_LABELS], ['browse-quality-max', QUALITY_LABELS], ['browse-grip', GRIP_LABELS]]) {
      const select = $(id);
      for (const [value, pair] of Object.entries(labels)) {
        if (id === 'browse-grip' && value === 'UNIVERSAL') continue;
        let option = Array.from(select.options).find(existing => existing.value === value);
        if (!option) { option = node('option'); option.value = value; select.append(option); }
        const label = localLabel(pair);
        option.textContent = value === 'WORN' ? tr('marketUiLegacyOption', '{label} (legacy)', { label }) : label;
      }
    }
    renderAccount();
    renderInventory();
    renderMine();
    renderNotice();
    renderAdvancedFilters();
    renderBrowseControls();
    if (browseLoaded) renderBrowseResults();
    if (composer) { renderComposerLabels(); renderTradeSlots(); renderTradeEditor(); updatePreview(); updateComposerGate(); }
  }

  function openWebsite(section) {
    void invoke('openMarketWebsite', section).then(result => { if (result?.ok === false) toast(messageOf(result)); });
  }

  function showAccount() {
    if (document.body.classList.contains('inventory-embedded') && api.openAccountSettings) {
      void api.openAccountSettings();
      return;
    }
    renderAccount();
    errorAt('login-error', '');
    if (!$('account-dialog').open) $('account-dialog').showModal();
  }

  function setTab(next, focus = false) {
    if (document.body.classList.contains('inventory-embedded')) next = 'inventory';
    tab = next;
    for (const key of ['browse', 'inventory', 'mine']) {
      $('tab-' + key).setAttribute('aria-selected', String(key === tab));
      $('tab-' + key).tabIndex = key === tab ? 0 : -1;
      $('panel-' + key).hidden = key !== tab;
    }
    if (focus) $('tab-' + next).focus();
    if (next === 'browse' && !browseLoaded && !browseBusy) void browse();
    if (next === 'inventory') renderInventory();
    if (next === 'mine') renderMine();
  }

  function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const priorAccount = state.authenticated ? state.user?.id : null;
    const browserSignin = !!state.signIn?.pending && !state.authenticated;
    const priorSigninError = state.signIn?.error;
    const nextAccount = snapshot.authenticated ? snapshot.user?.id : null;
    state = { ...snapshot, inventory: snapshot.inventory || { rows: [] }, trading: snapshot.trading || {} };
    stateLoaded = true;
    stateLoadError = '';
    catalogueById = new Map(catalogue().map(item => [item.id, item]));
    categoryDisplayNames = new Map([...rows(), ...catalogue()].filter(item => item.categoryLabel).map(item => [item.category, item.categoryLabel]));
    stateRevision++;
    if (priorAccount !== nextAccount) {
      expandedInventoryGroups.clear();
      expandedTemperDetails.clear();
      browseRevision++;
      browseBusy = false;
      browseLoaded = false;
      browseRows = [];
      browseMeta = {};
      if (composer && !mutationBusy) $('composer-dialog').close();
    }
    renderAccount();
    if (browserSignin && nextAccount && nextAccount !== priorAccount) {
      $('account-dialog').close(); toast(tr('marketUiSignedInToAvakotMarket', 'Signed in to Avakot Market.'));
    }
    if (state.authenticated && state.signIn?.error && state.signIn.error !== priorSigninError) toast(state.signIn.error);
    renderBrowseControls();
    // Sign-in may finish before the catalogue/language request. Refresh already
    // loaded cards from cached listings when those display definitions arrive.
    if (browseLoaded && !browseBusy && browseRows.length) renderBrowseResults();
    renderInventory();
    renderMine();
    renderNotice();
    $('inventory-count').textContent = rows().filter(row => row.canList && number(row.availableQuantity) > 0).length;
    $('mine-count').textContent = myListings().filter(listing => statusOf(listing) === 'ACTIVE').length;

    if (priorAccount !== nextAccount || !browseLoaded) {
      if (tab === 'browse' && !browseBusy) void browse();
    }
    updateComposerGate();
  }

  function renderAccount() {
    $('connection-status').textContent = state.authenticated ? tr('marketUiSignedInAs', 'Signed in as {name}', { name: state.user?.displayHandle || tr('marketUiEnvoy', 'Envoy') }) : tr('marketUiBrowsingPublicListingsSignInTo', 'Browsing public listings · Sign in to manage your trades');
    const signedIn = !!state.authenticated;
    $('account-name').textContent = signedIn ? state.user?.displayHandle || tr('marketUiMyAccount', 'My account') : tr('marketUiSignIn', 'Sign in');
    $('account-button').querySelector('.status-dot').classList.toggle('online', signedIn);
    $('account-title').textContent = signedIn ? tr('marketUiYourMarketAccount', 'Your market account') : tr('marketUiSignInToTheMarket', 'Sign in to the market');
    $('login-form').hidden = signedIn;
    $('account-details').hidden = !signedIn;
    const pending = !!state.signIn?.pending;
    $('avakot-login').disabled = pending;
    $('avakot-login').textContent = pending ? tr('marketUiWaitingForSignIn', 'Waiting for sign-in…') : tr('marketUiSignInWithAvakotDev', 'Sign in with avakot.dev');
    $('avakot-pending').hidden = !pending;
    $('avakot-code').textContent = state.signIn?.userCode || '';
    $('email-login').hidden = pending;
    for (const id of ['login-email', 'login-password', 'login-submit', 'login-remember']) $(id).disabled = pending;
    errorAt('avakot-error', state.signIn?.error);
    if (signedIn) {
      $('account-summary').textContent = `${state.user?.displayHandle || tr('marketUiEnvoy', 'Envoy')}${state.user?.platform ? ' · ' + state.user.platform : ''}`;
      $('account-verification').textContent = state.user?.inGameVerified && !state.user?.envoyNameReverificationRequired
        ? tr('marketUiEnvoyVerifiedYouCanCreateListings', 'Envoy verified. You can create listings from your inventory.')
        : tr('marketUiVerifyYourEnvoyNameOnAvakotMarket', 'Verify your Envoy name on Avakot Market before creating listings.');
      $('account-storage').textContent = state.sessionPersistent ? tr('marketUiYouWillStaySignedInOn', 'You will stay signed in on this computer.') : tr('marketUiThisSessionEndsWhenYouQuit', 'This session ends when you quit Overkot.');
    }
  }

  function tradeGate() {
    if (!stateLoaded) return stateLoadError || tr('marketUiLoadingYourAccountAndInventory', 'Loading your account and inventory…');
    if (!state.authenticated && state.accountConnection?.signedIn) {
      return state.accountConnection.error || tr('marketUiConnectingMarketWithYourAvakotDev', 'Connecting Market with your avakot.dev account…');
    }
    if (!state.authenticated) return tr('marketUiSignInToPublishAListing', 'Sign in to publish a listing from your inventory.');
    if (state.trading?.tradingDisabled) return tr('marketUiTradingIsTemporarilyUnavailableOnAvakot', 'Trading is temporarily unavailable on Avakot Market.');
    if (['LISTING_RESTRICTED', 'SUSPENDED', 'BANNED'].includes(state.user?.restrictionState)) {
      return tr('marketUiYourMarketAccountHasATrading', 'Your market account has a trading restriction. Check your account on Avakot Market.');
    }
    if (!state.user?.inGameVerified || state.user?.envoyNameReverificationRequired) return tr('marketUiVerifyYourEnvoyNameOnAvakot', 'Verify your Envoy name on Avakot Market before publishing listings.');
    return '';
  }

  function renderNotice() {
    const notice = $('market-notice');
    notice.replaceChildren();
    let text = '';
    if (state.trading?.tradingDisabled) text = state.trading.tradingDisabledMessage || tr('marketUiTradingIsTemporarilyUnavailableYouCan', 'Trading is temporarily unavailable. You can still look through your inventory.');
    else if (state.trading?.arcsTradeDisabled) text = tr('marketUiArcsTradingIsTemporarilyUnavailableYou', 'Arcs trading is temporarily unavailable. You can accept items or publish an open offer.');
    notice.hidden = !text;
    if (text) notice.append(node('span', '', text));
  }

  function categoryOptions(select, items) {
    const previous = select.value;
    const categories = [...new Set(items.map(item => item.category).filter(Boolean))].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
    const signature = categories.map(category => `${category}:${categoryLabel(category)}`).join('|');
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    const all = node('option', '', tr('marketUiAllCategories', 'All categories'));
    all.value = '';
    select.replaceChildren(all);
    for (const category of categories) {
      const option = node('option', '', categoryLabel(category));
      option.value = category;
      select.append(option);
    }
    if (categories.includes(previous)) select.value = previous;
  }

  function renderBrowseControls() {
    $('browse-sort').disabled = !advancedFilters;
    $('browse-sort').title = advancedFilters ? '' : tr('marketUiRecentListingsAreShownNewestFirst', 'Recent listings are shown newest first. Choose advanced filters for other sort orders.');
    for (const option of $('browse-sort').options) {
      option.hidden = !advancedFilters && option.value !== 'recent';
    }
    renderAdvancedFilters();
  }

  function resetBrowse() {
    browseKind = 'any'; advancedFilters = null; selectedBrowseTempers.clear();
    $('browse-advanced-form').reset(); $('browse-sort').value = 'recent';
    $('browse-title').textContent = tr('marketUiRecentListings', 'Recent listings');
    renderBrowseControls();
    void browse();
  }

  function renderAdvancedFilters() {
    $('browse-advanced-form').hidden = !browseKind || browseKind === 'any';
    $('browse-temper-controls').hidden = browseKind !== 'tempers';
    $('browse-advanced-hint').textContent = browseKind === 'tempers'
      ? tr('marketUiFindWeaponsWithSelectedTempersTempers', 'Find weapons with selected tempers. Tempers are traits on the listed weapon.')
      : tr('marketUiFilterWeaponListingsByTheirTraits', 'Filter weapon listings by their traits.');
    for (const button of document.querySelectorAll('[data-browse-kind]')) button.setAttribute('aria-pressed', String(button.dataset.browseKind === browseKind));
    renderBrowseTempers();
  }

  function renderBrowseTempers() {
    const options = new Map();
    for (const item of catalogue()) for (const temper of item.possibleTempers || []) {
      if (typeof temper.unique_name === 'string') options.set(temper.unique_name, temper.displayName || temper.name || tr('marketUiUnknownTemper', 'Unknown temper'));
    }
    const query = $('browse-temper-search').value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    for (const [id, name] of [...options].sort((a, b) => a[1].localeCompare(b[1]))) {
      if (query && !name.toLocaleLowerCase().includes(query) && !selectedBrowseTempers.has(id)) continue;
      const label = node('label');
      const input = node('input'); input.type = 'checkbox'; input.value = id;
      input.checked = selectedBrowseTempers.has(id);
      input.disabled = !input.checked && selectedBrowseTempers.size >= 8;
      input.addEventListener('change', () => {
        if (input.checked && selectedBrowseTempers.size < 8) selectedBrowseTempers.add(id);
        else { selectedBrowseTempers.delete(id); input.checked = false; }
        for (const control of $('browse-temper-options').querySelectorAll('input')) control.disabled = !control.checked && selectedBrowseTempers.size >= 8;
        $('browse-temper-count').textContent = tr('marketUiSelectedTempers', '{count} of 8 tempers selected', { count: selectedBrowseTempers.size });
      });
      label.append(input, node('span', '', name)); fragment.append(label);
    }
    if (!fragment.childNodes.length) fragment.append(node('p', 'muted', options.size ? tr('marketUiNoMatchingTempers', 'No matching tempers.') : tr('marketUiRefreshTheCatalogueToLoadTemper', 'Refresh the catalogue to load temper filters.')));
    $('browse-temper-options').replaceChildren(fragment);
    $('browse-temper-count').textContent = tr('marketUiSelectedTempers', '{count} of 8 tempers selected', { count: selectedBrowseTempers.size });
  }

  function applyAdvancedFilters() {
    if (!$('browse-advanced-form').reportValidity()) return;
    advancedFilters = { q: $('browse-query').value, qualityMin: $('browse-quality-min').value,
      qualityMax: $('browse-quality-max').value, moonsteel: $('browse-moonsteel').value,
      weaponGripType: $('browse-grip').value, tempers: browseKind === 'tempers' ? [...selectedBrowseTempers] : [],
      temperMatch: $('browse-temper-match').value };
    if (!['recent', 'lowest', 'highest'].includes($('browse-sort').value)) $('browse-sort').value = 'recent';
    $('browse-title').textContent = browseKind === 'tempers' ? tr('marketUiWeaponsMatchingTempers', 'Weapons matching tempers') : tr('marketUiWeaponListings', 'Weapon listings');
    renderBrowseControls();
    void browse();
  }

  function temperDetails(item) {
    const weapon = item.attributes?.weapon || item.weapon || item;
    const definition = catalogueById.get(item.itemId || item.item?.id || item.id);
    const options = definition?.possibleTempers || item.possibleTempers || [];
    return (Array.isArray(weapon.tempers) ? weapon.tempers : []).map(temper => {
      const keys = typeof temper === 'string' ? [temper] : [temper?.unique_name, temper?.id, temper?.tag, temper?.name, temper?.temperName];
      const option = options.find(entry => [entry.unique_name, entry.id, entry.tag, entry.name, entry.displayName].some(value => value && keys.some(key => String(key).toLowerCase() === String(value).toLowerCase())));
      const name = option?.displayName || option?.name || (typeof temper === 'object' && (temper?.displayName || temper?.label || temper?.name)) || tr('marketUiUnknownTemper', 'Unknown temper');
      return { name, icon: option?.icon || (typeof temper === 'object' && temper?.icon) || '' };
    });
  }

  function variantLabels(item, includeTempers = true) {
    const attributes = item.attributes || {};
    const weapon = attributes.weapon || item.weapon || item;
    const mote = attributes.mote || item.mote;
    const rune = attributes.rune || item.rune;
    const labels = [];
    if (weapon.quality) labels.push(localLabel(QUALITY_LABELS[weapon.quality]) || titleCase(weapon.quality));
    if (weapon.moonsteel) labels.push(tr('marketUiMoonsteel', 'Moonsteel'));
    if (includeTempers) labels.push(...temperDetails(item).map(temper => temper.name));
    const virtue = mote?.virtue || item.moteVirtue;
    if (virtue) labels.push(enumLabel(virtue));
    const moteLevel = mote?.upgradeLevel ?? item.moteUpgradeLevel;
    if (moteLevel != null) labels.push(`Totem +${moteLevel}`);
    const grip = mote?.gripType || item.moteGripType;
    if (grip) labels.push(localLabel(GRIP_LABELS[grip]) || titleCase(grip));
    const runeLevel = rune?.upgradeLevel ?? item.runeUpgradeLevel;
    if (runeLevel != null) labels.push(`Rune +${runeLevel}`);
    return labels;
  }

  function temperIcon(temper) {
    const plaque = node('span', 'market-temper-icon');
    plaque.title = temper.name;
    plaque.setAttribute('aria-hidden', 'true');
    const fallback = () => plaque.replaceChildren(node('span', 'temper-icon-fallback', '◇'));
    const source = window.GameDataImages.temperIconUrl(temper.icon) || window.GameDataImages.marketImageUrl(temper.icon);
    if (!source) fallback();
    else {
      const image = node('img'); image.src = source; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', fallback, { once: true });
      plaque.append(image);
    }
    return plaque;
  }

  function appendVariants(target, item, compactOnly = false) {
    const labels = variantLabels(item, false);
    const weapon = item.attributes?.weapon || item.weapon || item;
    if (weapon.tempersAny) labels.push(tr('marketUiAnyTempers', 'Any tempers'));
    if (weapon.quality && weapon.moonsteel === null) labels.push(tr('marketUiAnyMoonsteel', 'Any Moonsteel'));
    if (labels.length) {
      const tags = node('div', 'tag-row');
      labels.forEach((label, index) => {
        const tag = node('span', 'tag', label);
        if (index === 0 && weapon.quality) { tag.classList.add('craftwork-tier'); tag.dataset.quality = weapon.quality; }
        tags.append(tag);
      });
      target.append(tags);
    }
    const tempers = temperDetails(item);
    if (!tempers.length) return;
    const icons = node('span', 'temper-icons');
    for (const temper of tempers) icons.append(temperIcon(temper));
    if (compactOnly) {
      icons.title = tempers.map(temper => temper.name).join(' · ');
      icons.setAttribute('aria-label', icons.title);
      target.append(icons);
      return;
    }
    const details = node('details', 'temper-details');
    const key = `${item.key || item.id || item.itemId || item.item?.id || ''}:${JSON.stringify(weapon)}`;
    details.dataset.variantKey = key;
    details.open = expandedTemperDetails.has(key);
    const summary = node('summary');
    const disclosure = node('span', 'temper-disclosure', '⌄'); disclosure.setAttribute('aria-hidden', 'true');
    summary.append(icons, disclosure);
    const names = node('ul', 'temper-names');
    for (const temper of tempers) { const entry = node('li'); entry.append(temperIcon(temper), node('span', '', temper.name)); names.append(entry); }
    const label = () => summary.setAttribute('aria-label', details.open
      ? tr('marketUiHideTemperNames', 'Hide temper names ({count})', { count: tempers.length }) : tr('marketUiShowTemperNames', 'Show temper names ({count})', { count: tempers.length }));
    label(); details.addEventListener('toggle', () => {
      label();
      if (details.open) expandedTemperDetails.add(key); else expandedTemperDetails.delete(key);
    });
    details.append(summary, names);
    target.append(details);
  }

  function priceLabel(listing) {
    const amount = number(listing.terms?.priceAmount);
    if (amount > 0) {
      const unit = listing.terms?.priceUnit;
      if (!unit || String(unit).toLowerCase() === 'arcs') return tr('marketUiArcsValue', '{amount} Arcs', { amount: formatNumber(amount) });
      return `${formatNumber(amount)} ${unit}`;
    }
    if (listing.terms?.acceptedItems?.length) return tr('marketUiItemTrade', 'Item trade');
    return tr('marketUiOpenToOffers', 'Open to offers');
  }

  function listingCard(listing, own = false) {
    const card = node('article', 'listing-card');
    const top = node('div', 'listing-top');
    const info = node('div', 'listing-info');
    info.append(node('strong', 'listing-name', nameOf(listing)));
    const meta = node('div', 'listing-meta');
    meta.append(node('span', '', tr('marketUiAvailableCount', '{count} available', { count: formatNumber(listing.quantity) })), node('span', '', listing.type === 'REQUEST' ? tr('marketUiWantsToBuy', 'Wants to buy') : tr('marketUiSelling', 'Selling')));
    if (listing.platform) meta.append(node('span', '', listing.platform));
    if (own) meta.append(node('span', 'tag' + (statusOf(listing) === 'ACTIVE' ? ' active' : ''), enumLabel(listing.status)));
    info.append(meta);
    appendVariants(info, listing);
    top.append(itemImage(listing), info, node('div', 'listing-price', priceLabel(listing)));
    card.append(top);
    if (listing.terms?.acceptedItems?.length) {
      const accepted = node('div', 'listing-note accepted-trade-summary');
      accepted.append(node('span', 'accepted-trade-label', listing.type === 'REQUEST' ? tr('marketUiOffers', 'Offers') : tr('marketUiAccepts', 'Accepts')));
      for (const entry of listing.terms.acceptedItems) {
        const row = node('div', 'accepted-trade-item');
        if (entry.type === 'ARCS') row.append(node('span', '', tr('marketUiArcsValue', '{amount} Arcs', { amount: formatNumber(entry.amount) })));
        else {
          const name = catalogueById.get(entry.itemId || entry.item?.id)?.name || catalogue().find(item => item.slug === entry.itemSlug)?.name || entry.name || entry.itemName || entry.item?.name || tr('marketUiItem', 'Item');
          row.append(node('span', '', `${number(entry.quantity || 1)} × ${name}`));
          appendVariants(row, entry);
        }
        accepted.append(row);
      }
      card.append(accepted);
    }
    if (listing.terms?.termsNote) card.append(node('p', 'listing-note', listing.terms.termsNote));
    const footer = node('div', 'listing-footer');
    if (own) {
      const expiry = listing.expiresAt ? new Date(listing.expiresAt) : null;
      const expiration = expiry && !Number.isNaN(expiry.getTime())
        ? tr('marketUiExpires', 'Expires {date}', { date: expiry.toLocaleDateString(document.documentElement?.lang || undefined) })
        : tr('marketUiYourListing', 'Your listing');
      footer.append(node('span', 'muted', expiration));
      const actions = node('div', 'listing-actions');
      if (isOpen(listing)) {
        const edit = button(tr('marketUiEdit', 'Edit'), 'secondary-button small-button', () => openComposer(null, listing));
        const pause = button(statusOf(listing) === 'PAUSED' ? tr('marketUiResume', 'Resume') : tr('marketUiPause', 'Pause'), 'secondary-button small-button', () => void changeStatus(listing));
        const close = button(tr('marketUiClose', 'Close'), 'secondary-button small-button', () => showCloseListing(listing));
        for (const control of [edit, pause, close]) control.disabled = pendingListings.has(listing.id);
        actions.append(edit, pause, close);
      }
      footer.append(actions);
    } else {
      const seller = listing.seller || {};
      const identity = node('span', 'seller-name', seller.handle || seller.displayHandle || tr('marketUiEnvoy', 'Envoy'));
      const available = seller.inGame || seller.availabilityStatus === 'in-game' ? tr('marketUiInGame', 'In game') : enumLabel(seller.availabilityStatus || 'offline');
      identity.append(node('span', 'muted', ` · ${available}`));
      const contact = button(tr('marketUiCopyWhisper', 'Copy whisper'), 'secondary-button small-button', async () => {
        contact.disabled = true;
        const result = await invoke('marketCopyContact', listing.id);
        contact.disabled = false;
        toast(result?.ok ? tr('marketUiWhisperCopiedPasteItIntoSoulframe', 'Whisper copied. Paste it into Soulframe chat.') : messageOf(result));
      });
      footer.append(identity, contact);
    }
    card.append(footer);
    return card;
  }

  async function browse(append = false) {
    const revision = ++browseRevision;
    browseBusy = true;
    $('browse-more').disabled = true;
    if (!append) {
      browseRows = [];
      browseMeta = {};
      $('browse-count').textContent = '';
      $('browse-more').hidden = true;
      $('browse-limit').hidden = true;
      empty($('browse-results'), tr('marketUiLoadingListings', 'Loading listings…'), tr('marketUiFindingTradesOnAvakotMarket', 'Finding trades on Avakot Market.'));
    }
    const query = {
      view: $('browse-view').value,
      sort: advancedFilters ? $('browse-sort').value : 'recent',
      availability: $('browse-availability').value,
      page: append ? number(browseMeta.page || 1) + 1 : 1,
    };
    if (advancedFilters) query.advanced = { ...advancedFilters };
    if (append && browseMeta.nextCursor) query.cursor = browseMeta.nextCursor;
    const result = await invoke('marketBrowse', query);
    if (revision !== browseRevision) return;
    browseBusy = false;
    $('browse-more').disabled = false;
    if (!result?.ok) {
      if (append) toast(messageOf(result));
      else empty($('browse-results'), tr('marketUiCouldNotLoadListings', 'Could not load listings'), messageOf(result), tr('marketUiTryAgain', 'Try again'), () => void browse());
      return;
    }
    browseLoaded = true;
    browseMeta = result.meta || {};
    const incoming = Array.isArray(result.listings) ? result.listings : [];
    browseRows = [...new Map((append ? [...browseRows, ...incoming] : incoming).map(listing => [listing.id, listing])).values()];
    renderBrowseResults();
  }

  function renderBrowseResults() {
    $('browse-results').replaceChildren(...browseRows.map(listing => listingCard(listing)));
    const limitedAvailability = !!advancedFilters && $('browse-availability').value !== 'any';
    if (!browseRows.length) {
      if (advancedFilters) empty($('browse-results'), tr('marketUiNoMatchesInThisSearch', 'No matches in this search'), limitedAvailability
        ? tr('marketUiNarrowTheItemOrTraitFilters', 'Narrow the item or trait filters, or choose Anyone. Availability is checked within the first 50 search matches.')
        : tr('marketUiTryAnotherItemNameRemoveA', 'Try another item name, remove a trait filter, or change the listing type.'));
      else empty($('browse-results'), tr('marketUiNoListingsYet', 'No listings yet'), tr('marketUiTryADifferentListingTypeOr', 'Try a different listing type or availability filter.'));
    }
    $('browse-count').textContent = number(browseMeta.total) > browseRows.length
      ? tr('marketUiListingsTotal', '{count} of {total} listings', { count: browseRows.length, total: number(browseMeta.total) }) : tr('marketUiListingsCount', '{count} listings', { count: browseRows.length });
    $('browse-more').hidden = !!advancedFilters || !(browseMeta.hasNextPage || browseMeta.hasMore);
    $('browse-limit').hidden = !advancedFilters;
    $('browse-limit').textContent = limitedAvailability
      ? tr('marketUiAvailabilityIsCheckedWithinTheFirst', 'Availability is checked within the first 50 search matches. Narrow item or trait filters, or choose Anyone to see more.')
      : tr('marketUiAdvancedSearchReturnsUpTo50', 'Advanced search returns up to 50 matches. Add item or trait filters to narrow the results.');
  }

  function inventoryAvailable() {
    return state.inventory?.available !== false && state.inventory?.summary?.inventoryAvailable !== false;
  }

  function renderInventory() {
    const focused = document.activeElement;
    const focusWithinResults = $('inventory-results').contains(focused);
    const focusedRow = focusWithinResults ? focused.closest('.inventory-card')?.dataset.rowKey : null;
    const focusedGroup = focusWithinResults ? focused.closest('.inventory-group')?.dataset.itemId : null;
    const focusedTemper = focusWithinResults ? focused.closest('.temper-details')?.dataset.variantKey : null;
    categoryOptions($('inventory-category'), rows());
    const available = inventoryAvailable();
    $('inventory-dot').classList.toggle('online', available && rows().length > 0);
    const summary = state.inventory?.summary || {};
    const player = state.inventory?.playerName;
    $('inventory-status').textContent = !stateLoaded ? tr('marketUiLoadingYourAccountAndInventory', 'Loading your account and inventory…') : !available
      ? state.inventory?.reason || tr('marketUiConnectToSoulframeAndOpenYour', 'Connect to Soulframe and open your inventory to load your items.')
      : tr('marketUiMatchedInventory', '{player}{count} matched items · Select an item to review and publish an offer.', { player: player ? player + ' · ' : '', count: rows().length });
    const gate = tradeGate();
    const notice = $('inventory-gate');
    notice.hidden = !gate;
    notice.replaceChildren();
    if (gate) {
      notice.append(node('span', '', gate));
      if (!stateLoaded) {
        if (stateLoadError) notice.append(button(tr('marketUiRetry', 'Retry'), 'text-button', () => void refresh()));
      } else if (!state.authenticated && !state.accountConnection?.busy) {
        notice.append(button(state.accountConnection?.signedIn ? tr('marketUiOpenConnections', 'Open Connections') : tr('marketUiSignIn', 'Sign in'), 'text-button', showAccount));
      }
      else if (state.authenticated && !state.trading?.tradingDisabled) notice.append(button(tr('marketUiManageAccount', 'Manage account ↗'), 'text-button', () => openWebsite('account')));
    }
    const query = $('inventory-search').value.trim().toLocaleLowerCase();
    const category = $('inventory-category').value;
    const filtered = rows().filter(row => (!category || row.category === category) && (!query || `${row.name} ${categoryLabel(row.category)} ${variantLabels(row).join(' ')}`.toLocaleLowerCase().includes(query)) && (!$('inventory-available').checked || row.canList && number(row.availableQuantity) > 0));
    const sort = $('inventory-sort').value;
    filtered.sort((a, b) => sort === 'quantity' ? number(b.quantity) - number(a.quantity) || nameOf(a).localeCompare(nameOf(b)) : sort === 'available' ? number(b.availableQuantity) - number(a.availableQuantity) || nameOf(a).localeCompare(nameOf(b)) : nameOf(a).localeCompare(nameOf(b)));
    $('inventory-summary').textContent = tr('marketUiItemsCount', '{count} items', { count: filtered.length });
    if (summary.unmatchedEntries) $('inventory-summary').textContent += ' · ' + tr('marketUiUnmatchedItems', '{count} items not in market catalogue', { count: number(summary.unmatchedEntries) });
    const fragment = document.createDocumentFragment();
    const inventoryCard = row => {
      const canList = row.canList && number(row.availableQuantity) > 0 && available;
      const card = node('article', 'inventory-card' + (canList ? '' : ' unavailable'));
      card.dataset.rowKey = row.key;
      card.append(itemImage(row), node('span', 'inventory-amount', '×' + formatNumber(row.quantity)));
      const details = node('div', 'inventory-details');
      details.append(node('strong', 'listing-name', nameOf(row)), node('span', 'muted inventory-category', categoryLabel(row.category)));
      appendVariants(details, row);
      const held = [];
      if (number(row.equippedQuantity)) held.push(tr('marketUiEquippedCount', '{count} equipped', { count: row.equippedQuantity }));
      if (number(row.listedQuantity)) held.push(tr('marketUiListedCount', '{count} listed', { count: row.listedQuantity }));
      if (number(row.protectedQuantity)) held.push(tr('marketUiProtectedCount', '{count} protected', { count: row.protectedQuantity }));
      if (held.length) details.append(node('p', 'inventory-warning', held.join(' · ')));
      if (Array.isArray(row.warnings) && row.warnings.length) details.append(node('p', 'inventory-warning', row.warnings.join(' ')));
      const actions = node('div', 'inventory-actions');
      const create = button(tr('marketUiListItem', 'List item'), 'primary-button small-button inventory-list-item', () => openComposer(row));
      create.disabled = !canList || !!gate;
      create.title = gate || (!canList ? tr('marketUiThisItemIsNotCurrentlyAvailable', 'This item is not currently available to list.') : tr('marketUiReviewThePrefilledListing', 'Review the prefilled listing'));
      actions.append(node('span', '', tr('marketUiAvailableCount', '{count} available', { count: number(row.availableQuantity) })), create);
      card.append(details, actions);
      return card;
    };
    const grouped = $('inventory-grouped').checked;
    $('inventory-results').classList.toggle('grouped-view', grouped);
    if (grouped) {
      const groups = new Map();
      for (const row of filtered) {
        // Never merge variants or transaction keys, including same-name catalogue items.
        const key = row.itemId || row.key;
        if (!groups.has(key)) groups.set(key, { key, rows: [], quantity: 0, availableQuantity: 0 });
        const group = groups.get(key);
        group.rows.push(row); group.quantity += number(row.quantity); group.availableQuantity += number(row.availableQuantity);
      }
      const ordered = [...groups.values()].sort((a, b) => (sort === 'quantity' ? b.quantity - a.quantity : sort === 'available' ? b.availableQuantity - a.availableQuantity : 0) || nameOf(a.rows[0]).localeCompare(nameOf(b.rows[0])));
      for (const group of ordered) {
        const details = node('details', 'inventory-group');
        details.dataset.itemId = group.key;
        details.open = expandedInventoryGroups.has(group.key);
        const summary = node('summary', 'inventory-group-heading');
        const label = node('span', 'inventory-group-label');
        label.append(node('strong', '', nameOf(group.rows[0])), node('span', 'muted', tr('marketUiVariantSummary', 'Variants: {variants} · Owned: {owned} · Available: {available}', { variants: group.rows.length, owned: group.quantity, available: group.availableQuantity })));
        summary.append(itemImage(group.rows[0]), label);
        const children = node('div', 'inventory-group-items');
        for (const row of group.rows) children.append(inventoryCard(row));
        details.append(summary, children);
        details.addEventListener('toggle', () => { if (details.open) expandedInventoryGroups.add(group.key); else expandedInventoryGroups.delete(group.key); });
        fragment.append(details);
      }
      $('inventory-summary').textContent = tr('marketUiGroupSummary', '{count} groups · {summary}', { count: groups.size, summary: $('inventory-summary').textContent });
    } else {
      for (const row of filtered) fragment.append(inventoryCard(row));
    }
    $('inventory-results').replaceChildren(fragment);
    if (focusWithinResults) {
      const candidates = [...$('inventory-results').querySelectorAll('summary, .inventory-list-item')];
      const replacement = candidates.find(control => focusedTemper ? control.closest('.temper-details')?.dataset.variantKey === focusedTemper
        : focusedRow ? control.classList.contains('inventory-list-item') && control.closest('.inventory-card')?.dataset.rowKey === focusedRow
          : control.classList.contains('inventory-group-heading') && control.closest('.inventory-group')?.dataset.itemId === focusedGroup);
      replacement?.focus({ preventScroll: true });
    }
    if (!filtered.length) empty($('inventory-results'), !available ? tr('marketUiInventoryUnavailable', 'Inventory unavailable') : rows().length ? tr('marketUiNoMatchingItems', 'No matching items') : tr('marketUiNoMarketItemsFound', 'No market items found'), !available ? state.inventory?.reason || tr('marketUiLaunchSoulframeSignInAndLet', 'Launch Soulframe, sign in, and let Overkot read your inventory. Items appear here when the inventory is available.') : rows().length ? tr('marketUiTryADifferentSearchCategoryOr', 'Try a different search, category, or availability filter.') : tr('marketUiTradeableItemsWillAppearWhenThey', 'Tradeable items will appear when they match the market catalogue.'), !available ? tr('marketUiRefresh', 'Refresh') : null, () => void refresh());
  }

  function renderMine() {
    if (!state.authenticated) {
      empty($('mine-results'), tr('marketUiYourListingsLiveHere', 'Your listings live here'), tr('marketUiSignInToReviewYourActive', 'Sign in to review your active trades and update them without leaving the game.'), tr('marketUiSignIn', 'Sign in'), showAccount);
      return;
    }
    const filter = $('mine-status').value;
    const query = $('mine-search').value.trim().toLocaleLowerCase();
    const filtered = myListings().filter(listing => (!filter || (filter === 'open' ? isOpen(listing) : statusOf(listing) === filter)) && (!query || nameOf(listing).toLocaleLowerCase().includes(query)));
    $('mine-results').replaceChildren(...filtered.map(listing => listingCard(listing, true)));
    if (!filtered.length) empty($('mine-results'), tr('marketUiNoListingsHereYet', 'No listings here yet'), tr('marketUiChooseAnItemFromYourInventory', 'Choose an item from your inventory to create a prefilled offer.'), tr('marketUiBrowseYourInventory', 'Browse your inventory'), () => setTab('inventory'));
  }

  function acceptedCatalogueItem(slot) {
    return catalogue().find(item => item.id === slot?.itemId) || {
      id: slot?.itemId, name: slot?.itemName || tr('marketUiItemUnavailableInCatalogue', 'Item unavailable in catalogue'), imageUrl: slot?.imageUrl,
      category: '', attributeType: slot?.weapon ? 'weapon' : slot?.mote ? 'mote' : slot?.rune ? 'rune' : null,
      acceptedQuantityMax: slot?.quantity != null ? 999 : 1,
    };
  }

  function acceptedAttributeType(item) {
    if (item?.attributeType) return item.attributeType;
    const category = String(item?.category || '').toLowerCase();
    return ['weapon', 'weapons'].includes(category) ? 'weapon' : ['mote', 'rune'].includes(category) ? category : null;
  }

  function acceptedQuantityMax(item) {
    return number(item?.acceptedQuantityMax) || (item?.category === 'resource' || item?.slug === 'moonsteel-thread' ? 999 : 1);
  }

  function acceptedPayload(slot) {
    if (slot.type === 'ARCS') return { type: 'ARCS', amount: slot.amount };
    const entry = { type: 'ITEM', itemId: slot.itemId };
    if (slot.quantity != null) entry.quantity = slot.quantity;
    if (slot.weapon) entry.weapon = { ...slot.weapon, tempers: [...(slot.weapon.tempers || [])] };
    if (slot.mote) entry.mote = { ...slot.mote };
    if (slot.rune) entry.rune = { ...slot.rune };
    return entry;
  }

  function currentAcceptedItems() {
    return (composer?.slots || []).filter(Boolean).map(acceptedPayload);
  }

  function tradeTermsChanged() {
    return !!composer && JSON.stringify(currentAcceptedItems()) !== JSON.stringify(composer.original?.acceptedItems || []);
  }

  function acceptedSlotsFor(listing) {
    const terms = listing?.terms || {};
    const source = Array.isArray(terms.acceptedItems) && terms.acceptedItems.length ? terms.acceptedItems
      : number(terms.priceAmount) > 0 ? [{ type: 'ARCS', amount: number(terms.priceAmount) }] : [];
    const slots = source.slice(0, TRADE_SLOT_COUNT).map(entry => {
      if (entry.type === 'ARCS') return { type: 'ARCS', amount: number(entry.amount) };
      const item = catalogue().find(item => item.id === entry.itemId);
      const kind = acceptedAttributeType(item);
      const slot = { type: 'ITEM', itemId: entry.itemId, itemName: entry.itemName, imageUrl: entry.imageUrl };
      if (entry.quantity != null) slot.quantity = number(entry.quantity);
      if (entry.weapon || kind === 'weapon' || entry.quality != null || entry.tempersAny != null) {
        slot.weapon = entry.weapon ? { ...entry.weapon, tempers: [...(entry.weapon.tempers || [])] }
          : { quality: entry.quality ?? '', moonsteel: entry.moonsteel ?? null, tempers: [...(entry.tempers || [])], tempersAny: entry.tempersAny === true };
      }
      if (entry.mote || kind === 'mote' || entry.moteVirtue != null || entry.moteGripType != null) {
        slot.mote = entry.mote ? { ...entry.mote } : { virtue: entry.moteVirtue ?? 'COURAGE', upgradeLevel: entry.moteUpgradeLevel ?? 0, gripType: entry.moteGripType ?? 'UNIVERSAL' };
      }
      if (entry.rune || kind === 'rune' || entry.runeUpgradeLevel != null) slot.rune = entry.rune ? { ...entry.rune } : { upgradeLevel: entry.runeUpgradeLevel ?? 0 };
      return slot;
    });
    while (slots.length < TRADE_SLOT_COUNT) slots.push(null);
    return slots;
  }

  function tradeSlotDescription(slot) {
    if (!slot) return tr('marketUiAddItemOrArcs', 'Add item or Arcs');
    if (slot.type === 'ARCS') return tr('marketUiArcsValue', '{amount} Arcs', { amount: formatNumber(slot.amount) });
    const item = acceptedCatalogueItem(slot);
    return `${number(slot.quantity || 1)} × ${item.name}`;
  }

  function tradeValidation() {
    if (!composer || composer.listingId && !tradeTermsChanged()) return '';
    let arcsCount = 0;
    for (let index = 0; index < composer.slots.length; index++) {
      const slot = composer.slots[index];
      if (!slot) continue;
      const slotNumber = index + 1;
      if (slot.type === 'ARCS') {
        if (state.trading?.arcsTradeDisabled) return tr('marketUiErrorRemoveRcsWhileRcs', 'Slot {index}: remove Arcs while Arcs trading is disabled.', { index: slotNumber });
        if (++arcsCount > 1) return tr('marketUiUseOneArcsSlotPerTrade', 'Use one Arcs slot per trade.');
        if (!Number.isInteger(slot.amount) || slot.amount < 1 || slot.amount > 100000) return tr('marketUiErrorEnterBetweenAndRcs', 'Slot {index}: enter between 1 and 100,000 Arcs.', { index: slotNumber });
        continue;
      }
      const item = catalogue().find(item => item.id === slot.itemId);
      if (!item || item.tradeable === false) return tr('marketUiErrorChooseAnAvailableTradeable', 'Slot {index}: choose an available tradeable item.', { index: slotNumber });
      if (slot.quantity != null && (!Number.isInteger(slot.quantity) || slot.quantity < 1 || slot.quantity > acceptedQuantityMax(item))) return tr('marketUiQuantityRange', 'Slot {index}: enter a quantity from 1 to {max}.', { index: slotNumber, max: acceptedQuantityMax(item) });
      if (slot.weapon) {
        const limits = TEMPER_LIMITS[slot.weapon.quality];
        if (!limits) return tr('marketUiErrorChooseTheWeaponQuality', 'Slot {index}: choose the weapon quality.', { index: slotNumber });
        if (!slot.weapon.tempersAny) {
          const tempers = slot.weapon.tempers || [];
          if (tempers.length < limits[0] || tempers.length > limits[1]) return tr('marketUiTemperRange', 'Slot {index}: choose {min}–{max} tempers, or accept any tempers.', { index: slotNumber, min: limits[0], max: limits[1] });
          if (tempers.some(temper => tempers.filter(value => value === temper).length > 2)) return tr('marketUiErrorATemperCanBe', 'Slot {index}: a temper can be selected at most twice.', { index: slotNumber });
        }
      }
    }
    if (composer.source.type === 'REQUEST' && !composer.slots.some(Boolean)) return tr('marketUiChooseAtLeastOneItemOr', 'Choose at least one item or Arcs for this buy request.');
    return '';
  }

  function renderTradeSlots() {
    if (!composer) return;
    $('trade-slot-count').textContent = tr('marketUiSlotsUsed', '{used} / {total} slots', { used: composer.slots.filter(Boolean).length, total: TRADE_SLOT_COUNT });
    $('trade-disabled-note').hidden = !state.trading?.arcsTradeDisabled;
    const fragment = document.createDocumentFragment();
    composer.slots.forEach((slot, index) => {
      const control = button('', 'trade-slot' + (composer.activeSlot === index ? ' active' : ''), () => {
        composer.activeSlot = index;
        composer.editorMode = slot?.type === 'ARCS' ? 'ARCS' : 'ITEM';
        renderTradeSlots(); renderTradeEditor();
        $('trade-slot-editor').scrollIntoView({ block: 'nearest' });
        $('trade-search')?.focus();
      });
      control.dataset.slot = String(index);
      control.setAttribute('aria-label', tr('marketUiSlotDescription', 'Slot {index}: {description}', { index: index + 1, description: tradeSlotDescription(slot) }));
      control.setAttribute('aria-pressed', String(composer.activeSlot === index));
      control.append(node('span', 'trade-slot-number', String(index + 1)));
      if (!slot) control.append(node('span', 'trade-slot-plus', '+'), node('span', '', tr('marketUiAddToTrade', 'Add to trade')));
      else {
        const item = slot.type === 'ARCS' ? { name: tr('marketUiArcs', 'Arcs'), imageUrl: ARCS_IMAGE } : acceptedCatalogueItem(slot);
        control.append(itemImage(item), node('strong', 'trade-slot-name', item.name), node('span', 'trade-slot-quantity', slot.type === 'ARCS' ? formatNumber(slot.amount) : `×${number(slot.quantity || 1)}`));
        if (slot.type === 'ITEM') {
          appendVariants(control, slot, true);
        }
      }
      fragment.append(control);
    });
    $('trade-slots').replaceChildren(fragment);
  }

  function acceptedSelect(labelText, id, options, value, change) {
    const label = node('label', '', labelText);
    const select = node('select'); select.id = id;
    for (const [key, text] of options) { const option = node('option', '', text); option.value = key; select.append(option); }
    select.value = value;
    select.addEventListener('change', () => { change(select.value); renderTradeSlots(); updatePreview(); });
    label.append(select);
    return label;
  }

  function acceptedNumber(labelText, id, value, maximum, change) {
    const label = node('label', '', labelText);
    const input = node('input'); input.id = id; input.type = 'number'; input.min = '1'; input.max = String(maximum); input.step = '1'; input.required = true; input.value = value;
    input.addEventListener('input', () => { change(number(input.value)); renderTradeSlots(); updatePreview(); });
    label.append(input);
    return label;
  }

  function renderTradeEditor() {
    if (!composer || composer.activeSlot == null) { $('trade-slot-editor').hidden = true; $('trade-editor-content').replaceChildren(); return; }
    const index = composer.activeSlot, slot = composer.slots[index];
    const content = $('trade-editor-content'); content.replaceChildren();
    $('trade-slot-editor').hidden = false;
    $('trade-editor-title').textContent = tr('marketUiSlotTitle', 'Trade slot {index}', { index: index + 1 });
    $('trade-mode-item').setAttribute('aria-pressed', String(composer.editorMode === 'ITEM'));
    $('trade-mode-arcs').setAttribute('aria-pressed', String(composer.editorMode === 'ARCS'));
    $('trade-mode-arcs').disabled = !!state.trading?.arcsTradeDisabled || composer.slots.some((entry, i) => i !== index && entry?.type === 'ARCS');
    $('trade-mode-arcs').title = state.trading?.arcsTradeDisabled ? tr('marketUiArcsTradingIsDisabled', 'Arcs trading is disabled') : $('trade-mode-arcs').disabled ? tr('marketUiArcsAlreadyOccupyAnotherSlot', 'Arcs already occupy another slot') : '';
    $('trade-mode-clear').disabled = !slot;
    if (composer.editorMode === 'ARCS') {
      const field = acceptedNumber(tr('marketUiArcsAmount', 'Arcs amount'), 'trade-arcs-amount', slot?.amount || 1, 100000, value => { slot.amount = value; });
      field.querySelector('input').disabled = !!state.trading?.arcsTradeDisabled;
      content.append(field);
      return;
    }
    const searchLabel = node('label', '', tr('marketUiFindAnItem', 'Find an item'));
    const search = node('input'); search.id = 'trade-search'; search.type = 'search'; search.placeholder = tr('marketUiSearchTheMarketCatalogue', 'Search the market catalogue…'); search.autocomplete = 'off';
    searchLabel.append(search);
    const results = node('div', 'trade-search-results'); results.id = 'trade-search-results';
    content.append(searchLabel, results);
    const showSuggestions = () => {
      const query = search.value.trim().toLocaleLowerCase();
      results.replaceChildren();
      if (!query) return;
      const items = catalogue().filter(item => item.tradeable !== false && `${item.name} ${item.category}`.toLocaleLowerCase().includes(query)).slice(0, 8);
      for (const item of items) {
        const select = button('', 'trade-search-result', () => {
          const next = { type: 'ITEM', itemId: item.id };
          if (acceptedQuantityMax(item) > 1) next.quantity = 1;
          const kind = acceptedAttributeType(item);
          if (kind === 'weapon') next.weapon = { quality: '', moonsteel: false, tempers: [], tempersAny: false };
          if (kind === 'mote') next.mote = { virtue: 'COURAGE', upgradeLevel: 0, gripType: 'UNIVERSAL' };
          if (kind === 'rune') next.rune = { upgradeLevel: 0 };
          composer.slots[index] = next;
          renderTradeSlots(); renderTradeEditor(); updatePreview();
        });
        select.append(itemImage(item), node('span', '', item.name), node('small', 'muted', categoryLabel(item.category)));
        results.append(select);
      }
      if (!items.length) results.append(node('p', 'muted', tr('marketUiNoMatchingTradeableItems', 'No matching tradeable items.')));
    };
    search.addEventListener('input', showSuggestions);
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.click(); }
    });
    if (slot?.type !== 'ITEM') return;
    const item = acceptedCatalogueItem(slot);
    const selected = node('div', 'trade-selected-item');
    selected.append(itemImage(item), node('strong', '', item.name));
    content.append(selected);
    if (acceptedQuantityMax(item) > 1) content.append(acceptedNumber(tr('marketUiQuantity', 'Quantity'), 'trade-item-quantity', slot.quantity ?? 1, acceptedQuantityMax(item), value => { slot.quantity = value; }));
    else content.append(node('p', 'field-hint', tr('marketUiOneItemPerSlotAddAnother', 'One item per slot. Add another slot for another copy.')));
    if (slot.weapon) renderAcceptedWeapon(content, slot, item);
    if (slot.mote) {
      const controls = node('div', 'trade-variant-fields');
      controls.append(acceptedSelect(tr('marketUiVirtue', 'Virtue'), 'trade-mote-virtue', ['COURAGE', 'GRACE', 'SPIRIT'].map(value => [value, enumLabel(value)]), slot.mote.virtue, value => { slot.mote.virtue = value; }),
        acceptedSelect(tr('marketUiUpgradeLevel', 'Upgrade level'), 'trade-mote-level', [0, 1, 2, 3].map(value => [String(value), '+' + value]), String(slot.mote.upgradeLevel), value => { slot.mote.upgradeLevel = number(value); }),
        acceptedSelect(tr('marketUiGrip', 'Grip'), 'trade-mote-grip', Object.entries(GRIP_LABELS).map(([id, pair]) => [id, localLabel(pair)]), slot.mote.gripType, value => { slot.mote.gripType = value; }));
      content.append(controls);
    }
    if (slot.rune) content.append(acceptedSelect(tr('marketUiUpgradeLevel', 'Upgrade level'), 'trade-rune-level', [0, 1, 2, 3].map(value => [String(value), '+' + value]), String(slot.rune.upgradeLevel), value => { slot.rune.upgradeLevel = number(value); }));
  }

  function renderAcceptedWeapon(content, slot, item) {
    const controls = node('div', 'trade-variant-fields');
    const qualities = [['', tr('marketUiChooseQuality', 'Choose quality…')], ...Object.entries(QUALITY_LABELS).map(([id, pair]) => [id, localLabel(pair)]).filter(([key]) => key !== 'WORN' || slot.weapon.quality === 'WORN')];
    const qualityField = acceptedSelect(tr('marketUiCraftwork', 'Craftwork'), 'trade-weapon-quality', qualities, slot.weapon.quality, value => { slot.weapon.quality = value; renderTradeEditor(); });
    const qualitySelect = qualityField.querySelector('select');
    if (slot.weapon.quality) { qualitySelect.classList.add('craftwork-tier'); qualitySelect.dataset.quality = slot.weapon.quality; }
    for (const option of qualitySelect.options) if (option.value) { option.classList.add('craftwork-tier'); option.dataset.quality = option.value; }
    controls.append(qualityField);
    const moonsteel = node('label', 'checkbox-label');
    const moonsteelInput = node('input'); moonsteelInput.id = 'trade-weapon-moonsteel'; moonsteelInput.type = 'checkbox'; moonsteelInput.checked = !!slot.weapon.moonsteel;
    moonsteelInput.indeterminate = slot.weapon.moonsteel == null;
    moonsteelInput.addEventListener('change', () => { slot.weapon.moonsteel = moonsteelInput.checked; renderTradeSlots(); updatePreview(); });
    moonsteel.append(moonsteelInput, node('span', '', tr('marketUiMoonsteel', 'Moonsteel')));
    if (item.canBeShiny !== false) controls.append(moonsteel);
    content.append(controls);
    const any = node('label', 'checkbox-label');
    const anyInput = node('input'); anyInput.id = 'trade-any-tempers'; anyInput.type = 'checkbox'; anyInput.checked = !!slot.weapon.tempersAny;
    anyInput.addEventListener('change', () => { slot.weapon.tempersAny = anyInput.checked; if (anyInput.checked) slot.weapon.tempers = []; renderTradeEditor(); renderTradeSlots(); updatePreview(); });
    any.append(anyInput, node('span', '', tr('marketUiAcceptAnyTempers', 'Accept any tempers'))); content.append(any);
    if (slot.weapon.tempersAny) return;
    const options = Array.isArray(item.possibleTempers) ? item.possibleTempers : [];
    const limits = TEMPER_LIMITS[slot.weapon.quality] || [0, 8];
    content.append(node('p', 'field-hint', tr('marketUiTemperLimit', '{count} selected · {min}–{max} tempers for this quality. Each temper can be selected twice.', { count: slot.weapon.tempers.length, min: limits[0], max: limits[1] })));
    const list = node('div', 'trade-temper-list');
    for (const [index, temper] of slot.weapon.tempers.entries()) {
      const option = options.find(entry => entry.unique_name === temper);
      list.append(button(`${option?.displayName || option?.name || temper} ×`, 'secondary-button small-button', () => { slot.weapon.tempers.splice(index, 1); renderTradeEditor(); renderTradeSlots(); updatePreview(); }));
    }
    content.append(list);
    const label = node('label', '', tr('marketUiAddATemper', 'Add a temper'));
    const select = node('select'); select.id = 'trade-temper-select';
    const placeholder = node('option', '', tr('marketUiChooseATemper', 'Choose a temper…')); placeholder.value = ''; select.append(placeholder);
    for (const temper of options) {
      const option = node('option', '', temper.displayName || temper.name || temper.unique_name); option.value = temper.unique_name;
      option.disabled = slot.weapon.tempers.length >= limits[1] || slot.weapon.tempers.filter(value => value === temper.unique_name).length >= 2;
      select.append(option);
    }
    select.addEventListener('change', () => { if (!select.value) return; slot.weapon.tempers.push(select.value); renderTradeEditor(); renderTradeSlots(); updatePreview(); });
    label.append(select); content.append(label);
  }

  function renderComposerLabels() {
    const editing = !!composer.listingId;
    $('composer-title').textContent = editing ? tr('marketUiEditListing', 'Edit listing') : tr('marketUiCreateListing', 'Create listing');
    $('composer-eyebrow').textContent = editing ? tr('marketUiListingEyebrow', 'YOUR MARKET LISTING') : tr('marketUiInventoryEyebrow', 'FROM YOUR INVENTORY');
    if (!mutationBusy) $('composer-submit').textContent = editing ? tr('marketUiSaveChanges', 'Save changes') : tr('marketUiPublishListing', 'Publish listing');
    const source = composer.source;
    const detail = node('div', 'listing-info');
    detail.append(node('strong', 'listing-name', nameOf(source)), node('span', 'muted', categoryLabel(source.category || source.item?.category || '')));
    appendVariants(detail, source);
    $('composer-item').replaceChildren(itemImage(source), detail);
    $('composer-description').textContent = editing ? tr('marketUiReviewTheQuantityAndTermsBefore', 'Review the quantity and terms before saving your changes.') : tr('marketUiInventoryAvailable', '{count} available in your inventory. Item traits are filled in automatically.', { count: number(source.availableQuantity) });
    $('trade-terms-label').textContent = source.type === 'REQUEST' ? tr('marketUiOfferingInReturn', 'Offering in return') : tr('marketUiAcceptedInReturn', 'Accepted in return');
    $('trade-builder-hint').textContent = source.type === 'REQUEST' ? tr('marketUiChooseTheItemsOrArcsYou', 'Choose the items or Arcs you are offering in return. Up to six slots.') : tr('marketUiAddItemsOrArcsToBuild', 'Add items or Arcs to build your trade. Leave all six slots empty for open offers.');
  }

  function openComposer(row, listing = null) {
    if (!state.authenticated) { showAccount(); return; }
    const gate = tradeGate();
    if (gate) { toast(gate); return; }
    composer = { rowKey: row?.key, listingId: listing?.id, name: nameOf(row || listing), source: row || listing,
      slots: acceptedSlotsFor(listing), activeSlot: null, editorMode: 'ITEM',
      original: listing ? { quantity: number(listing.quantity), acceptedItems: [] } : null };
    if (listing) composer.original.acceptedItems = currentAcceptedItems();
    renderComposerLabels();
    const quantityMax = row ? Math.min(number(row.availableQuantity), number(row.maxQuantity) || 999) : Math.max(number(listing.quantity), number(catalogue().find(item => item.id === listing.itemId)?.maxQuantity) || 999);
    $('composer-quantity').max = Math.max(1, quantityMax);
    $('composer-quantity').value = listing ? listing.quantity : 1;
    renderTradeSlots(); renderTradeEditor();
    errorAt('composer-error', '');
    updatePreview();
    updateComposerGate();
    $('composer-dialog').showModal();
  }

  function updateComposerGate() {
    if (!composer) return;
    let gate = tradeGate();
    if (composer.rowKey) {
      const fresh = rows().find(row => row.key === composer.rowKey);
      if (!fresh || !fresh.canList || number(fresh.availableQuantity) < number($('composer-quantity').value) || !inventoryAvailable()) gate = tr('marketUiYourInventoryChangedRefreshItAnd', 'Your inventory changed. Refresh it and choose an available item again.');
    }
    if (!gate) gate = tradeValidation();
    $('composer-submit').disabled = mutationBusy || !!gate;
    if (gate) { errorAt('composer-error', gate); composer.gateError = true; }
    else if (composer.gateError) { errorAt('composer-error', ''); composer.gateError = false; }
  }

  function updatePreview() {
    if (!composer) return;
    const terms = composer.slots.filter(Boolean).map(tradeSlotDescription).join(' + ');
    $('composer-preview').textContent = `${number($('composer-quantity').value)} × ${composer.name} · ${terms || tr('marketUiOpenToOffers', 'Open to offers')}`;
    updateComposerGate();
  }

  async function submitComposer(event) {
    event.preventDefault();
    if (!composer || mutationBusy || !$('composer-form').reportValidity()) return;
    updateComposerGate();
    if ($('composer-submit').disabled) return;
    mutationBusy = true;
    $('composer-submit').disabled = true;
    $('composer-submit').textContent = composer.listingId ? tr('marketUiSaving', 'Saving…') : tr('marketUiPublishing', 'Publishing…');
    errorAt('composer-error', '');
    const values = { quantity: number($('composer-quantity').value), acceptedItems: currentAcceptedItems() };
    const editing = !!composer.listingId;
    const draft = editing ? { id: composer.listingId } : { ...values, rowKey: composer.rowKey };
    if (editing) {
      if (values.quantity !== composer.original.quantity) draft.quantity = values.quantity;
      if (tradeTermsChanged()) draft.acceptedItems = values.acceptedItems;
      if (Object.keys(draft).length === 1) {
        mutationBusy = false;
        $('composer-dialog').close();
        toast(tr('marketUiNoChangesToSave', 'No changes to save.'));
        return;
      }
    }
    const result = await invoke(editing ? 'marketUpdateListing' : 'marketCreateListing', draft);
    mutationBusy = false;
    $('composer-submit').textContent = editing ? tr('marketUiSaveChanges', 'Save changes') : tr('marketUiPublishListing', 'Publish listing');
    if (!result?.ok) {
      errorAt('composer-error', messageOf(result));
      updateComposerGate();
      return;
    }
    if (result.state) applyState(result.state);
    $('composer-dialog').close();
    toast(result.warning || (editing ? tr('marketUiListingUpdated', 'Listing updated.') : tr('marketUiYourListingIsLiveOnAvakot', 'Your listing is live on Avakot Market.')));
    setTab('mine');
    if (!result.state) await refresh();
    browseLoaded = false;
  }

  async function changeStatus(listing) {
    if (pendingListings.has(listing.id)) return;
    const next = statusOf(listing) === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    pendingListings.add(listing.id);
    renderMine();
    const result = await invoke('marketUpdateListing', { id: listing.id, status: next });
    pendingListings.delete(listing.id);
    if (result?.ok) {
      if (result.state) applyState(result.state);
      else await refresh();
      browseLoaded = false;
      toast(result.warning || (next === 'ACTIVE' ? tr('marketUiListingResumed', 'Listing resumed.') : tr('marketUiListingPaused', 'Listing paused.')));
    } else toast(messageOf(result));
    renderMine();
  }

  function showCloseListing(listing) {
    closingListing = listing;
    $('close-description').textContent = `${number(listing.quantity)} × ${nameOf(listing)} · ${priceLabel(listing)}`;
    errorAt('close-error', '');
    $('close-dialog').showModal();
  }

  async function closeListing() {
    if (!closingListing || $('confirm-close').disabled) return;
    $('confirm-close').disabled = true;
    const result = await invoke('marketCloseListing', closingListing.id);
    $('confirm-close').disabled = false;
    if (!result?.ok) { errorAt('close-error', messageOf(result)); return; }
    $('close-dialog').close();
    if (result.state) applyState(result.state);
    else await refresh();
    browseLoaded = false;
    toast(result.warning || tr('marketUiListingClosed', 'Listing closed.'));
  }

  async function refresh() {
    if ($('market-refresh').disabled) return;
    const revision = stateRevision;
    $('market-refresh').disabled = true;
    const result = await invoke('marketRefresh');
    $('market-refresh').disabled = false;
    if (!result?.ok) {
      toast(messageOf(result));
      if (!stateLoaded) { stateLoadError = tr('marketUiCouldNotLoadYourMarketConnection', 'Could not load your Market connection. Refresh to try again.'); renderInventory(); }
      return;
    }
    // Live account and inventory events can arrive while this read is pending.
    // An older reply must never replace the state already delivered by an event.
    if (result.state && stateRevision === revision) applyState(result.state);
    if (tab === 'browse' && !browseBusy) await browse();
    if (result.warning) toast(result.warning);
  }

  async function login(event) {
    event.preventDefault();
    if ($('login-submit').disabled || !$('login-form').reportValidity()) return;
    const credentials = { email: $('login-email').value.trim(), password: $('login-password').value, remember: $('login-remember').checked };
    $('login-password').value = '';
    $('login-submit').disabled = true;
    $('avakot-login').disabled = true;
    $('login-submit').textContent = tr('marketUiSigningIn', 'Signing in…');
    errorAt('login-error', '');
    const result = await invoke('marketLogin', credentials);
    credentials.password = '';
    $('login-submit').disabled = false;
    $('avakot-login').disabled = false;
    $('login-submit').textContent = tr('marketUiSignIn', 'Sign in');
    if (!result?.ok) {
      // Authentication may succeed before a catalogue/network error. The
      // account form is then hidden, so surface that failure outside it.
      if (state.authenticated) { $('account-dialog').close(); toast(messageOf(result)); }
      else errorAt('login-error', messageOf(result));
      return;
    }
    if (result.state) applyState(result.state);
    else await refresh();
    $('account-dialog').close();
    toast(result.warning || tr('marketUiSignedInToAvakotMarket', 'Signed in to Avakot Market.'));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (document.body.classList.contains('inventory-embedded')) setTab('inventory');
    $('market-close').addEventListener('click', () => api.windowClose());
    $('market-website').addEventListener('click', () => openWebsite('home'));
    $('market-refresh').addEventListener('click', () => void refresh());
    $('account-button').addEventListener('click', showAccount);
    $('register-link').addEventListener('click', () => openWebsite('register'));
    $('reset-link').addEventListener('click', () => openWebsite('reset'));
    $('manage-account').addEventListener('click', () => openWebsite('account'));
    $('login-form').addEventListener('submit', login);
    $('avakot-login').addEventListener('click', async () => {
      const revision = ++signinRevision;
      $('avakot-login').disabled = true;
      $('login-password').value = '';
      errorAt('login-error', ''); errorAt('avakot-error', '');
      const result = await invoke('marketAvakotLogin', { remember: $('login-remember').checked });
      if (revision !== signinRevision) return;
      if (result?.state) applyState(result.state);
      if (!result?.ok) { renderAccount(); errorAt('avakot-error', messageOf(result)); }
    });
    $('avakot-cancel').addEventListener('click', async () => {
      ++signinRevision;
      const result = await invoke('marketAvakotCancel');
      if (result?.state) applyState(result.state);
      if (!result?.ok) errorAt('avakot-error', messageOf(result));
    });
    $('logout').addEventListener('click', async () => {
      $('logout').disabled = true;
      const result = await invoke('marketLogout');
      $('logout').disabled = false;
      if (!result?.ok) { toast(messageOf(result)); return; }
      if (result.state) applyState(result.state);
      $('account-dialog').close();
      toast(tr('marketUiSignedOutOfAvakotMarket', 'Signed out of Avakot Market.'));
    });
    document.querySelectorAll('[data-tab]').forEach(control => {
      control.addEventListener('click', () => setTab(control.dataset.tab));
      control.addEventListener('keydown', event => {
        const tabs = ['browse', 'inventory', 'mine'];
        const index = tabs.indexOf(control.dataset.tab);
        let next;
        if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
        if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
        if (event.key === 'Home') next = tabs[0];
        if (event.key === 'End') next = tabs[tabs.length - 1];
        if (next) { event.preventDefault(); setTab(next, true); }
      });
    });
    for (const button of document.querySelectorAll('[data-browse-kind]')) button.addEventListener('click', () => {
      if (button.dataset.browseKind === 'any') { resetBrowse(); return; }
      browseKind = button.dataset.browseKind;
      if (browseKind !== 'tempers') selectedBrowseTempers.clear();
      renderAdvancedFilters(); applyAdvancedFilters();
    });
    $('browse-advanced-form').addEventListener('submit', event => { event.preventDefault(); applyAdvancedFilters(); });
    $('browse-clear-filters').addEventListener('click', resetBrowse);
    $('browse-temper-search').addEventListener('input', renderBrowseTempers);
    for (const id of ['browse-view', 'browse-sort', 'browse-availability']) $(id).addEventListener('change', () => void browse());
    $('browse-more').addEventListener('click', () => { if (!browseBusy) void browse(true); });
    for (const id of ['inventory-search', 'inventory-category', 'inventory-sort', 'inventory-available', 'inventory-grouped']) $(id).addEventListener(id.endsWith('search') ? 'input' : 'change', renderInventory);
    for (const layout of ['grid', 'list']) $('inventory-' + layout).addEventListener('click', () => {
      $('inventory-results').classList.toggle('list-view', layout === 'list');
      $('inventory-grid').setAttribute('aria-pressed', String(layout === 'grid'));
      $('inventory-list').setAttribute('aria-pressed', String(layout === 'list'));
    });
    $('mine-search').addEventListener('input', renderMine);
    $('mine-status').addEventListener('change', renderMine);
    $('sell-item').addEventListener('click', () => setTab('inventory'));
    $('composer-form').addEventListener('submit', submitComposer);
    $('composer-quantity').addEventListener('input', updatePreview);
    $('trade-mode-item').addEventListener('click', () => {
      if (!composer || composer.activeSlot == null) return;
      composer.editorMode = 'ITEM'; renderTradeEditor(); $('trade-search')?.focus();
    });
    $('trade-mode-arcs').addEventListener('click', () => {
      if (!composer || composer.activeSlot == null || $('trade-mode-arcs').disabled) return;
      composer.editorMode = 'ARCS';
      if (composer.slots[composer.activeSlot]?.type !== 'ARCS') composer.slots[composer.activeSlot] = { type: 'ARCS', amount: 1 };
      renderTradeSlots(); renderTradeEditor(); updatePreview(); $('trade-arcs-amount')?.focus();
    });
    $('trade-mode-clear').addEventListener('click', () => {
      if (!composer || composer.activeSlot == null) return;
      composer.slots[composer.activeSlot] = null; composer.activeSlot = null;
      renderTradeSlots(); renderTradeEditor(); updatePreview();
    });
    $('trade-editor-done').addEventListener('click', () => {
      if (!composer) return;
      const selected = composer.activeSlot;
      if (tradeValidation()) { updateComposerGate(); return; }
      composer.activeSlot = null; renderTradeSlots(); renderTradeEditor();
      $('composer-dialog').scrollTop = 0;
      $('trade-slots').querySelector(`[data-slot="${selected}"]`)?.focus({ preventScroll: true });
    });
    $('confirm-close').addEventListener('click', () => void closeListing());
    document.querySelectorAll('[data-close-dialog]').forEach(control => control.addEventListener('click', () => {
      if (mutationBusy && control.dataset.closeDialog === 'composer-dialog') return;
      $(control.dataset.closeDialog).close();
    }));
    $('composer-dialog').addEventListener('cancel', event => { if (mutationBusy) event.preventDefault(); });
    $('composer-dialog').addEventListener('close', () => {
      if (!$('composer-dialog').open) { composer = null; errorAt('composer-error', ''); }
    });
    $('account-dialog').addEventListener('close', () => { $('login-password').value = ''; });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        if (tab === 'browse' && $('browse-advanced-form').hidden) document.querySelector('[data-browse-kind="weapons"]').click();
        $(tab === 'browse' ? 'browse-query' : tab === 'inventory' ? 'inventory-search' : 'mine-search').focus();
      }
    });
    const subscriptions = [];
    const subscribe = (method, callback) => {
      const remove = api[method]?.(callback);
      if (typeof remove === 'function') subscriptions.push(remove);
    };
    window.addEventListener('pagehide', () => { for (const remove of subscriptions) remove(); clearTimeout(toastTimer); }, { once: true });
    subscribe('onMarketChanged', applyState);
    subscribe('onConfigChanged', config => {
      configRevision++;
      applyLanguage(config);
      $('login-remember').checked = config.marketRememberSession !== false;
    });
    applyLanguage({});
    if (api.getState) {
      const revision = configRevision;
      try {
        const appState = await api.getState();
        if (revision === configRevision) {
          applyLanguage(appState?.config);
          $('login-remember').checked = appState?.config?.marketRememberSession !== false;
        }
      } catch { /* Keep the default if the app state is temporarily unavailable. */ }
    }
    const revision = stateRevision;
    const initial = await invoke('marketGetState');
    if (stateRevision === revision) {
      if (initial?.ok === false) {
        toast(messageOf(initial));
        stateLoadError = tr('marketUiCouldNotLoadYourMarketConnection', 'Could not load your Market connection. Refresh to try again.');
        renderInventory();
      } else applyState(initial?.state || initial);
    }
    await refresh();
  });
})();
