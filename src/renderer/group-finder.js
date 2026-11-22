/**
 * Group Finder – Renderer Script
 * 
 * Manages the Group Finder widget window UI:
 *   - Tab navigation (Home, Browse, My Listing, Profile)
 *   - Listing cards rendering
 *   - Create / Edit listing modals
 *   - Join request workflow
 *   - Invite workflow (copy name, mark invited)
 *   - Real-time state updates from main process
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Language display map ────────────────────────────────────
const LANG_NAMES = Object.fromEntries(LANGUAGES.map(({ code, name }) => [code, name]));

// ─── Translations ────────────────────────────────────────────
let t = {};

// Map stored goal values to their interface labels.
const GOAL_KEY_MAP = {
  'Kill / Clear': 'gfGoalKill',
  'Farm / Grind': 'gfGoalFarm',
  'Complete Quest': 'gfGoalCompleteQuest',
  'Explore / Discover': 'gfGoalExplore',
  'Learn / Teach': 'gfGoalLearn',
  'Just Hanging Out': 'gfGoalHangout',
  'Other': 'gfGoalOther',
};

function tAct(val) { return (ACTIVITY_KEY_MAP[val] && t[ACTIVITY_KEY_MAP[val]]) || val; }
function tGoal(val) { return (GOAL_KEY_MAP[val] && t[GOAL_KEY_MAP[val]]) || val; }

const STATUS_KEY_MAP = {
  open: 'gfStatusOpen',
  pending: 'gfStatusPending',
  full: 'gfStatusFull',
  in_progress: 'gfStatusInProgress',
  stale: 'gfStatusStale',
  closed: 'marketUiClosed',
  accepted: 'gfStatusAccepted',
  declined: 'gfStatusDeclined',
  invited: 'gfStatusInvited',
  joined: 'gfStatusJoined',
};

function statusLabel(status) {
  return t[STATUS_KEY_MAP[status]] || t.gfUnknown || 'Unknown';
}

// ─── State ───────────────────────────────────────────────────
let state = {
  configured: false,
  playerId: null,
  displayName: 'Player',
  groupSize: 1,
  maxGroupSize: 4,
  listings: [],
  myListing: null,
  myRequests: [],
  incomingRequests: [],
  onlinePlayers: {},
  activityTypes: [],
  goalTypes: [],
  regions: [],
  thresholds: { hostOffline: 45000, stale: 120000, autoClose: 600000 },
};

let currentTab = 'home';
let profileLoaded = false;
let suggestedListings;
let suggestionsRequest = 0;

// ─── Initialization ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load translations from app config
  let config = {};
  try {
    const appState = await window.api.getState();
    config = appState?.config || {};
    const lang = config.language || 'en';
    t = { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
    document.documentElement.lang = window.i18n?.localeTags?.[lang] || lang;
  } catch (e) {
    t = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS.en) || {};
  }
  populateLanguageOptions(config);
  applyStaticTranslations();
  window.api.onConfigChanged((next) => {
    const lang = next.language || 'en';
    t = { ...TRANSLATIONS.en, ...TRANSLATIONS[lang] };
    document.documentElement.lang = window.i18n?.localeTags?.[lang] || lang;
    populateLanguageOptions(next);
    applyStaticTranslations();
    if (state.configured) renderAll();
  });

  // Close button
  $('#gf-close-btn').addEventListener('click', () => window.api.windowClose());

  // Refresh button
  $('#gf-refresh-btn').addEventListener('click', () => manualRefresh());

  // Load initial state
  try {
    const initialState = await window.api.gfGetState();
    if (initialState) {
      state = { ...state, ...initialState };
    }
  } catch (e) {
    console.error('[GF] Failed to get initial state:', e);
  }

  // Check if configured
  if (!state.configured) {
    showUnconfigured();
    return;
  }

  hideUnconfigured();
  bindEvents();
  populateFilters();
  renderAll();
  loadProfile();
  loadSuggestions();

  // Listen for real-time state updates
  window.api.gfOnStateUpdate((data) => {
    const accountChanged = state.playerId !== data.playerId;
    if (accountChanged) profileLoaded = false;
    state = { ...state, ...data };
    renderAll();
    if (accountChanged) {
      loadProfile();
      suggestedListings = undefined;
      renderSuggestions();
      if (currentTab === 'home') loadSuggestions();
    }
  });

});

// ─── Unconfigured State ──────────────────────────────────────
function showUnconfigured() {
  $('#gf-unconfigured').classList.remove('hidden');
  $('#gf-tabs').classList.add('hidden');
  $$('.gf-panel').forEach(p => p.classList.remove('active'));
}

function hideUnconfigured() {
  $('#gf-unconfigured').classList.add('hidden');
  $('#gf-tabs').classList.remove('hidden');
}

// ─── Apply Static Translations ───────────────────────────────
function applyStaticTranslations() {
  // Title bar
  const titleText = $('.title-text');
  if (titleText) titleText.textContent = t.gfTitle || 'Group Finder';

  // Button tooltips
  const refreshBtn = $('#gf-refresh-btn');
  if (refreshBtn) refreshBtn.title = t.gfRefresh || 'Refresh';
  const closeBtn = $('#gf-close-btn');
  if (closeBtn) closeBtn.title = t.tooltipClose || 'Close';

  // Unconfigured state
  const unconfigH3 = document.querySelector('#gf-unconfigured h3');
  if (unconfigH3) unconfigH3.textContent = t.gfFirebaseNotConfigured || 'Firebase Not Configured';
  $('#gf-firebase-instructions').textContent = t.gfFirebaseInstructions || 'The Group Finder requires a Firebase backend to function.';
  $('#gf-firebase-setup').textContent = t.gfFirebaseBuildSetup || 'Set groupFirebase in your build’s service configuration to connect your Firebase project.';
  $('#gf-invite-name-note').textContent = t.gfInviteNameNote || 'Invite names are player-reported. Check the name in Soulframe before inviting someone.';
  $('#gf-firebase-services').textContent = t.gfFirebaseServices || 'Required services:';

  // Tabs
  document.querySelectorAll('.gf-tab').forEach(tab => {
    const tabId = tab.dataset.tab;
    const map = { home: 'gfTabHome', browse: 'gfTabBrowse', 'my-listing': 'gfTabMyListing', profile: 'gfTabProfile' };
    if (map[tabId] && t[map[tabId]]) {
      // Preserve any badge elements
      const badge = tab.querySelector('.gf-tab-badge');
      tab.textContent = t[map[tabId]];
      if (badge) tab.appendChild(badge);
    }
  });

  // Quick create button
  const quickCreate = $('#gf-quick-create');
  if (quickCreate) quickCreate.innerHTML = `<span>+</span> ${t.gfCreateGroupListing || 'Create a Group Listing'}`;

  // Section headers
  const myListingHeader = document.querySelector('#gf-home-my-listing > .gf-section-header');
  if (myListingHeader) myListingHeader.textContent = t.gfYourActiveListing || 'Your Active Listing';
  const suggestionsHeader = document.querySelector('#gf-home-suggestions > .gf-section-header');
  if (suggestionsHeader) suggestionsHeader.textContent = t.gfSuggestedGroups || 'Suggested Groups';
  renderSuggestions();

  // Browse filters: first option text
  const filterAct = $('#gf-filter-activity');
  if (filterAct && filterAct.options[0]) filterAct.options[0].textContent = t.gfAllActivities || 'All Activities';
  for (const option of filterAct.options) if (option.value) option.textContent = tAct(option.value);
  const filterLang = $('#gf-filter-lang');
  if (filterLang && filterLang.options[0]) filterLang.options[0].textContent = t.gfAnyLanguage || 'Any Language';
  const filterRegion = $('#gf-filter-region');
  if (filterRegion && filterRegion.options[0]) filterRegion.options[0].textContent = t.gfAnyRegion || 'Any Region';

  // My Listing tab — No active listing
  const noListingEmpty = document.querySelector('#gf-no-listing .gf-empty');
  if (noListingEmpty) {
    const icon = noListingEmpty.querySelector('.gf-empty-icon');
    noListingEmpty.textContent = '';
    if (icon) noListingEmpty.appendChild(icon);
    noListingEmpty.appendChild(document.createTextNode(t.gfNoActiveListing || "You don't have an active listing."));
  }
  const createFromTabBtn = $('#gf-create-from-tab');
  if (createFromTabBtn) createFromTabBtn.textContent = t.gfCreateListing || 'Create a Listing';

  // My Listing tab — Detail section headers
  const myListingDetailHeader = document.querySelector('#gf-my-listing-detail > .gf-section-header');
  if (myListingDetailHeader) myListingDetailHeader.textContent = t.gfYourListing || 'Your Listing';
  const incomingHeader = $('#gf-incoming-header');
  if (incomingHeader) {
    const badge = incomingHeader.querySelector('.gf-tab-badge');
    incomingHeader.textContent = (t.gfRequests || 'Requests') + ' ';
    if (badge) incomingHeader.appendChild(badge);
  }
  const acceptedHeader = document.querySelectorAll('#gf-my-listing-detail > .gf-section-header')[2];
  if (acceptedHeader) acceptedHeader.textContent = t.gfAcceptedPlayers || 'Accepted Players';

  // My Listing buttons
  const editBtn = $('#gf-edit-listing');
  if (editBtn) editBtn.textContent = t.gfEditListing || 'Edit Listing';
  const closeListBtn = $('#gf-close-listing');
  if (closeListBtn) closeListBtn.textContent = t.gfCloseListing || 'Close Listing';

  // Profile tab
  const profileHeader = document.querySelector('#tab-profile > .gf-section-header');
  if (profileHeader) profileHeader.textContent = t.gfPlayerProfile || 'Player Profile';
  document.querySelectorAll('#gf-profile-form .gf-label').forEach((label, i) => {
    const keys = ['gfDisplayName', 'gfPrimaryLanguage', 'gfSecondaryLanguage', 'gfRegionPreference'];
    if (keys[i] && t[keys[i]]) label.textContent = t[keys[i]];
  });
  const profileNameInput = $('#gf-profile-name');
  if (profileNameInput) profileNameInput.placeholder = t.gfDetectedFromGame || '(detected from game)';
  const lang2None = document.querySelector('#gf-profile-lang2 option[value=""]');
  if (lang2None) lang2None.textContent = t.gfNone || 'None';
  const regionNoPref = document.querySelector('#gf-profile-region option[value="No preference"]');
  if (regionNoPref) regionNoPref.textContent = t.gfNoPreference || 'No Preference';
  const savePrefsBtn = $('#gf-save-profile');
  if (savePrefsBtn) savePrefsBtn.textContent = t.gfSavePreferences || 'Save Preferences';
  $('#gf-profile-saved-label').textContent = t.gfSaved || 'Saved';

  // Create modal
  const createModalHeader = document.querySelector('#gf-create-modal .gf-modal-header span');
  if (createModalHeader) createModalHeader.textContent = t.gfCreateGroupListingModal || 'Create Group Listing';
  document.querySelectorAll('#gf-create-modal .gf-label').forEach((label, i) => {
    const keys = ['gfActivityType', 'gfGoal', 'gfSlotsNeeded', 'gfLanguageLabel', 'gfRegion'];
    if (keys[i] && t[keys[i]]) label.textContent = t[keys[i]];
  });
  // Activity type options
  document.querySelectorAll('#gf-create-activity option').forEach(opt => {
    const translated = tAct(opt.value);
    if (translated) opt.textContent = translated;
  });
  // Goal options
  document.querySelectorAll('#gf-create-goal option').forEach(opt => {
    const translated = tGoal(opt.value);
    if (translated) opt.textContent = translated;
  });
  // Slots options
  const slotsSelect = $('#gf-create-slots');
  if (slotsSelect) {
    const opt1 = slotsSelect.querySelector('option[value="1"]');
    const opt2 = slotsSelect.querySelector('option[value="2"]');
    if (opt1) opt1.textContent = t.gfOnePlayer || '1 player';
    if (opt2) opt2.textContent = t.gfTwoPlayers || '2 players';
    const opt3 = slotsSelect.querySelector('option[value="3"]');
    if (opt3) opt3.textContent = t.gfThreePlayers || '3 players';
  }
  // Language/region requirement selects
  document.querySelectorAll('#gf-create-lang-req option, #gf-create-region-req option').forEach(opt => {
    if (opt.value === 'none') opt.textContent = t.gfNoPreferenceLower || 'No preference';
    if (opt.value === 'preferred') opt.textContent = t.gfPreferred || 'Preferred';
    if (opt.value === 'required') opt.textContent = t.gfRequired || 'Required';
  });
  const createCancelBtn = $('#gf-create-cancel');
  if (createCancelBtn) createCancelBtn.textContent = t.gfCancel || 'Cancel';
  const createSubmitBtn = $('#gf-create-submit');
  if (createSubmitBtn) createSubmitBtn.textContent = t.gfCreateListing || 'Create Listing';

  // Edit modal
  const editModalHeader = document.querySelector('#gf-edit-modal .gf-modal-header span');
  if (editModalHeader) editModalHeader.textContent = t.gfEditListingModal || 'Edit Listing';
  document.querySelectorAll('#gf-edit-modal .gf-label').forEach((label, i) => {
    const keys = ['gfActivityType', 'gfGoal'];
    if (keys[i] && t[keys[i]]) label.textContent = t[keys[i]];
  });
  const editCancelBtn = $('#gf-edit-cancel');
  if (editCancelBtn) editCancelBtn.textContent = t.gfCancel || 'Cancel';
  const editSubmitBtn = $('#gf-edit-submit');
  if (editSubmitBtn) editSubmitBtn.textContent = t.gfSaveChanges || 'Save Changes';
}

// ─── Event Binding ───────────────────────────────────────────
function bindEvents() {
  // Tab switching
  $$('.gf-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      switchTab(tabId);
    });
  });

  // Quick create (home tab)
  $('#gf-quick-create').addEventListener('click', openCreateModal);

  // Create from My Listing tab
  $('#gf-create-from-tab').addEventListener('click', openCreateModal);

  // Create modal
  $('#gf-create-modal-close').addEventListener('click', closeCreateModal);
  $('#gf-create-cancel').addEventListener('click', closeCreateModal);
  $('#gf-create-submit').addEventListener('click', submitCreateListing);

  // Language/region requirement toggles in create modal
  $('#gf-create-lang-req').addEventListener('change', (e) => {
    $('#gf-create-lang-val').disabled = e.target.value === 'none';
  });
  $('#gf-create-region-req').addEventListener('change', (e) => {
    $('#gf-create-region-val').disabled = e.target.value === 'none';
  });

  // Edit modal
  $('#gf-edit-modal-close').addEventListener('click', closeEditModal);
  $('#gf-edit-cancel').addEventListener('click', closeEditModal);
  $('#gf-edit-submit').addEventListener('click', submitEditListing);

  // Edit / Close listing buttons
  $('#gf-edit-listing').addEventListener('click', openEditModal);
  $('#gf-close-listing').addEventListener('click', async () => {
    if (confirm(t.gfCloseConfirm || 'Close your listing? This cannot be undone.')) {
      await window.api.gfCloseListing();
      showToast(t.gfListingClosed || 'Listing closed');
    }
  });

  // Browse filters
  $('#gf-filter-activity').addEventListener('change', renderBrowse);
  $('#gf-filter-lang').addEventListener('change', renderBrowse);
  $('#gf-filter-region').addEventListener('change', renderBrowse);

  // Profile save
  $('#gf-save-profile').addEventListener('click', saveProfile);

  // Close modals on overlay click
  $('#gf-create-modal').addEventListener('click', (e) => {
    if (e.target === $('#gf-create-modal')) closeCreateModal();
  });
  $('#gf-edit-modal').addEventListener('click', (e) => {
    if (e.target === $('#gf-edit-modal')) closeEditModal();
  });
}

// ─── Tab Navigation ──────────────────────────────────────────
function switchTab(tabId) {
  currentTab = tabId;
  $$('.gf-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  $$('.gf-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));

  // Load suggestions when switching to home
  if (tabId === 'home') loadSuggestions();
}

// ─── Populate Filter Dropdowns ───────────────────────────────
function populateLanguageOptions(config) {
  const family = window.OverkotAppearance.resolve(config).fontFamily;
  for (const id of ['gf-filter-lang', 'gf-profile-lang1', 'gf-profile-lang2', 'gf-create-lang-val']) {
    const select = document.getElementById(id);
    const placeholder = select.querySelector('option[value=""]');
    const previous = select.value || (placeholder ? '' : 'en');
    select.replaceChildren(...(placeholder ? [placeholder] : []));
    for (const { code, name, locale } of LANGUAGES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      option.lang = locale || code;
      option.style.fontFamily = window.OverkotAppearance.fontStack(family, code);
      select.appendChild(option);
    }
    select.value = previous;
  }
}

function populateFilters() {
  const actSelect = $('#gf-filter-activity');
  const regionSelect = $('#gf-filter-region');

  // Activities
  for (const act of state.activityTypes) {
    const opt = document.createElement('option');
    opt.value = act;
    opt.textContent = tAct(act);
    actSelect.appendChild(opt);
  }

  // Regions
  for (const r of (state.regions || ['EU', 'NA', 'APAC'])) {
    if (r === 'No preference') continue;
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    regionSelect.appendChild(opt);
  }
}

// ─── Render All ──────────────────────────────────────────────
function renderAll() {
  $('#gf-profile-name').value = state.displayName || '';
  renderHome();
  renderBrowse();
  renderMyListing();
  renderTabBadges();
}

// ─── Home Tab ────────────────────────────────────────────────
function renderHome() {
  // Player status
  $('#gf-home-name').textContent = state.displayName || t.gfPlayerDefault || 'Player';
  $('#gf-home-group').textContent = state.groupSize === 1
    ? `${t.gfSolo || 'Solo'} (1/${state.maxGroupSize})`
    : `${t.gfGroup || 'Group'} (${state.groupSize}/${state.maxGroupSize})`;

  // Show/hide quick create based on whether we have a listing
  if (state.myListing) {
    $('#gf-quick-create').classList.add('hidden');
    $('#gf-home-my-listing').classList.remove('hidden');
    $('#gf-home-my-listing-card').innerHTML = buildListingCardHTML(state.myListing, { compact: true });
  } else {
    $('#gf-quick-create').classList.remove('hidden');
    $('#gf-home-my-listing').classList.add('hidden');
  }
}

async function loadSuggestions() {
  const request = ++suggestionsRequest;
  const accountId = state.playerId;
  let listings;
  try {
    listings = await window.api.gfGetSuggestions() || [];
  } catch (e) {
    listings = null;
  }
  if (request !== suggestionsRequest || state.playerId !== accountId) return;
  suggestedListings = listings;
  renderSuggestions();
}

function renderSuggestions() {
  const container = $('#gf-suggestions-list');
  if (suggestedListings === null) {
    container.innerHTML = `<div class="gf-empty">${escapeHtml(t.gfFailedSuggestions || 'Failed to load suggestions.')}</div>`;
    return;
  }
  if (!suggestedListings?.length) {
    const message = suggestedListings === undefined
      ? t.gfLoadingSuggestions || 'Loading suggestions...'
      : t.gfNoSuggestions || 'No matching listings right now. Check back soon or create your own!';
    container.innerHTML = `<div class="gf-empty"><div class="gf-empty-icon"><span class="icon-search"></span></div>${escapeHtml(message)}</div>`;
    return;
  }
  container.replaceChildren();
  for (const listing of suggestedListings) {
    const card = document.createElement('div');
    card.className = 'gf-card';
    card.innerHTML = buildListingCardHTML(listing, { showActions: true });
    bindCardActions(card, listing);
    container.appendChild(card);
  }
}

// ─── Browse Tab ──────────────────────────────────────────────
function renderBrowse() {
  const actFilter = $('#gf-filter-activity').value;
  const langFilter = $('#gf-filter-lang').value;
  const regionFilter = $('#gf-filter-region').value;

  let listings = state.listings.filter(l => {
    if (l.status === 'closed' || l.status === 'stale') return false;
    if (actFilter && l.activityType !== actFilter) return false;
    if (langFilter && l.languageValue && l.languageRequirement === 'required' &&
        l.languageValue !== langFilter) return false;
    if (regionFilter && l.regionValue && l.regionRequirement === 'required' &&
        l.regionValue !== regionFilter) return false;
    return true;
  });

  // Sort: open first, then by created date (newest first)
  const statusOrder = { open: 0, pending: 1, full: 2, in_progress: 3 };
  listings.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 9;
    const sb = statusOrder[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  $('#gf-browse-header').textContent = `${t.gfOpenListings || 'Open Listings'} (${listings.length})`;

  const container = $('#gf-browse-list');
  if (listings.length === 0) {
    container.innerHTML = `
      <div class="gf-empty">
        <div class="gf-empty-icon"><span class="icon-clipboard"></span></div>
        ${escapeHtml(t.gfNoListingsMatch || 'No listings match your filters.')}
      </div>`;
    return;
  }

  container.innerHTML = '';
  for (const listing of listings) {
    const card = document.createElement('div');
    card.className = 'gf-card';
    card.innerHTML = buildListingCardHTML(listing, { showActions: true, showMyRequest: true });
    bindCardActions(card, listing);
    container.appendChild(card);
  }
}

// ─── My Listing Tab ──────────────────────────────────────────
function renderMyListing() {
  const hasListing = !!state.myListing;
  $('#gf-no-listing').classList.toggle('hidden', hasListing);
  $('#gf-my-listing-detail').classList.toggle('hidden', !hasListing);

  if (!hasListing) return;

  const listing = state.myListing;

  // Listing info card
  $('#gf-my-listing-info').innerHTML = buildListingCardHTML(listing, { compact: false, isOwn: true });

  // Incoming requests
  const pendingRequests = state.incomingRequests.filter(r => r.status === 'pending');
  const acceptedRequests = state.incomingRequests.filter(
    r => r.status === 'accepted' || r.status === 'invited' || r.status === 'joined'
  );

  // Incoming requests badge
  const badge = $('#gf-incoming-badge');
  if (pendingRequests.length > 0) {
    badge.textContent = pendingRequests.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // Render pending requests
  const incomingContainer = $('#gf-incoming-requests');
  if (pendingRequests.length === 0) {
    incomingContainer.innerHTML = `<div class="gf-empty" style="font-size:11px;">${escapeHtml(t.gfNoPendingRequests || 'No pending requests.')}</div>`;
  } else {
    incomingContainer.innerHTML = '';
    for (const req of pendingRequests) {
      incomingContainer.appendChild(buildRequestCard(req, 'incoming'));
    }
  }

  // Render accepted players
  const acceptedContainer = $('#gf-accepted-players');
  if (acceptedRequests.length === 0) {
    acceptedContainer.innerHTML = `<div class="gf-empty" style="font-size:11px;">${escapeHtml(t.gfNoAcceptedPlayers || 'No accepted players yet.')}</div>`;
  } else {
    acceptedContainer.innerHTML = '';
    for (const req of acceptedRequests) {
      acceptedContainer.appendChild(buildRequestCard(req, 'accepted'));
    }
  }
}

// ─── Tab Badges ──────────────────────────────────────────────
function renderTabBadges() {
  const myListingTab = document.querySelector('.gf-tab[data-tab="my-listing"]');
  const pendingCount = state.incomingRequests.filter(r => r.status === 'pending').length;

  // Remove existing badge
  const existingBadge = myListingTab.querySelector('.gf-tab-badge');
  if (existingBadge) existingBadge.remove();

  if (pendingCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'gf-tab-badge';
    badge.textContent = pendingCount;
    myListingTab.appendChild(badge);
  }
}

// ─── Build Listing Card HTML ─────────────────────────────────
function buildListingCardHTML(listing, opts = {}) {
  const { compact = false, showActions = false, showMyRequest = false, isOwn = false } = opts;

  const isHostOnline = state.onlinePlayers?.[listing.hostPlayer] === true
    && listing.status !== 'stale';

  const slotsOpen = listing.slotsTotal - listing.slotsFilled;
  const isMyOwnListing = listing.hostPlayer === state.playerId;

  // Slot pips
  let slotPips = '';
  for (let i = 0; i < listing.slotsTotal; i++) {
    if (i === 0) slotPips += `<span class="gf-slot-pip host" title="${escapeHtml(t.gfHost || 'Host')}"></span>`;
    else if (i < listing.slotsFilled) slotPips += `<span class="gf-slot-pip filled" title="${escapeHtml(t.gfFilled || 'Filled')}"></span>`;
    else slotPips += `<span class="gf-slot-pip empty" title="${escapeHtml(t.gfOpen || 'Open')}"></span>`;
  }

  // Tags
  let tags = '';
  if (listing.languageValue && listing.languageRequirement !== 'none') {
    const langName = LANG_NAMES[listing.languageValue] || listing.languageValue;
    const req = listing.languageRequirement === 'required' ? ` ${t.gfReq || '(req)'}` : '';
    tags += `<span class="gf-tag lang">${escapeHtml(langName)}${escapeHtml(req)}</span>`;
  }
  if (listing.regionValue && listing.regionRequirement !== 'none' &&
      listing.regionValue !== 'No preference') {
    const req = listing.regionRequirement === 'required' ? ` ${t.gfReq || '(req)'}` : '';
    tags += `<span class="gf-tag region">${listing.regionValue}${req}</span>`;
  }

  // My request on this listing
  let myRequestHtml = '';
  if (showMyRequest && !isMyOwnListing) {
    const myReq = state.myRequests.find(r => r.listingId === listing.id);
    if (myReq) {
      myRequestHtml = `<span class="gf-my-request-badge ${escapeHtml(myReq.status)}">${escapeHtml(t.gfYourRequest || 'Your request')}: ${escapeHtml(statusLabel(myReq.status))}</span>`;
    }
  }

  // Actions
  let actionsHtml = '';
  if (showActions && !isMyOwnListing) {
    const myReq = state.myRequests.find(r => r.listingId === listing.id);
    if (!myReq) {
      if (listing.status === 'open' && slotsOpen > 0) {
        actionsHtml = `<button class="gf-btn primary small" data-action="join" data-listing="${listing.id}">${escapeHtml(t.gfRequestToJoin || 'Request to Join')}</button>`;
      }
    } else if (myReq.status === 'pending') {
      actionsHtml = `<button class="gf-btn danger small" data-action="cancel" data-listing="${listing.id}">${escapeHtml(t.gfCancelRequest || 'Cancel Request')}</button>`;
    } else if (myReq.status === 'accepted' || myReq.status === 'invited') {
      actionsHtml = `<span class="gf-request-status ${escapeHtml(myReq.status)}">${escapeHtml(statusLabel(myReq.status))}</span>`;
    }
  }

  const createdAgo = listing.createdAt ? formatTimeAgo(listing.createdAt) : '';

  return `
    <div class="gf-card-header">
      <span class="gf-card-activity">${escapeHtml(tAct(listing.activityType))}</span>
      <span class="gf-card-goal">${escapeHtml(tGoal(listing.goalType))}</span>
      <span class="gf-card-status ${escapeHtml(listing.status)}">${escapeHtml(statusLabel(listing.status))}</span>
    </div>
    <div class="gf-card-body">
      <div class="gf-card-row">
        <span class="gf-card-host">
          <span class="gf-status-dot ${isHostOnline ? 'online' : 'offline'}"></span>
          ${escapeHtml(listing.hostDisplayName || t.gfUnknown || 'Unknown')}
          ${isMyOwnListing ? `<span style="color:var(--accent-blue);font-size:10px;">${escapeHtml(t.gfYou || '(you)')}</span>` : ''}
        </span>
      </div>
      <div class="gf-card-row">
        <div class="gf-card-meta">
          <span class="gf-card-slots">
            <span class="gf-slots-visual">${slotPips}</span>
          </span>
          <span>${listing.slotsFilled}/${listing.slotsTotal} ${escapeHtml(t.gfPlayers || 'players')}</span>
          ${slotsOpen > 0 ? `<span style="color:var(--accent-green);">${slotsOpen} ${escapeHtml(t.gfOpenSlots || 'open')}</span>` : ''}
        </div>
      </div>
      ${tags ? `<div class="gf-card-row"><div class="gf-card-tags">${tags}</div></div>` : ''}
      ${myRequestHtml ? `<div class="gf-card-row">${myRequestHtml}</div>` : ''}
      ${createdAgo ? `<div class="gf-card-row" style="font-size:10px;color:var(--text-muted);">${escapeHtml(t.gfCreated || 'Created')} ${createdAgo}</div>` : ''}
    </div>
    ${actionsHtml ? `<div class="gf-card-actions">${actionsHtml}</div>` : ''}
  `;
}

// ─── Bind Card Actions ───────────────────────────────────────
function bindCardActions(card, listing) {
  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const listingId = btn.dataset.listing;

      btn.disabled = true;
      try {
        if (action === 'join') {
          await window.api.gfRequestJoin(listingId);
          showToast(t.gfJoinRequestSent || 'Join request sent!');
        } else if (action === 'cancel') {
          await window.api.gfCancelRequest(listingId);
          showToast(t.gfRequestCancelled || 'Request cancelled');
        }
      } catch (err) {
        console.error(`[GF] Action ${action} failed:`, err);
        showToast(t.gfActionFailed || 'Action failed — try again');
      }
      btn.disabled = false;
    });
  });
}

// ─── Build Request Card (for My Listing tab) ─────────────────
function buildRequestCard(req, type) {
  const card = document.createElement('div');
  card.className = 'gf-request-card';

  const info = document.createElement('div');
  info.className = 'gf-request-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'gf-request-name';
  nameEl.innerHTML = `
    <span class="gf-status-dot online" style="width:6px;height:6px;"></span>
    ${escapeHtml(req.playerDisplayName || req.playerId)}
  `;

  const detailEl = document.createElement('div');
  detailEl.className = 'gf-request-detail';
  detailEl.textContent = req.requestedAt ? `${t.gfRequested || 'Requested'} ${formatTimeAgo(req.requestedAt)}` : '';

  info.appendChild(nameEl);
  info.appendChild(detailEl);
  card.appendChild(info);

  if (type === 'incoming' && req.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'gf-request-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'gf-btn success small';
    acceptBtn.innerHTML = `<span class="icon-check"></span> ${escapeHtml(t.gfAccept || 'Accept')}`;
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      await window.api.gfAcceptRequest(state.myListing.id, req.playerId);
      showToast(t.gfPlayerAccepted.replace('{name}', () => req.playerDisplayName || req.playerId));
    });

    const declineBtn = document.createElement('button');
    declineBtn.className = 'gf-btn danger small';
    declineBtn.innerHTML = `<span class="icon-x-mark"></span> ${escapeHtml(t.gfDecline || 'Decline')}`;
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      await window.api.gfDeclineRequest(state.myListing.id, req.playerId);
      showToast(t.gfPlayerDeclined.replace('{name}', () => req.playerDisplayName || req.playerId));
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    card.appendChild(actions);
  }

  if (type === 'accepted') {
    const statusEl = document.createElement('span');
    statusEl.className = `gf-request-status ${req.status}`;
    statusEl.textContent = statusLabel(req.status);
    card.appendChild(statusEl);

    // Invite workflow
    const inviteRow = document.createElement('div');
    inviteRow.className = 'gf-invite-row';

    // Copy name button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'gf-copy-btn';
    copyBtn.innerHTML = `<span class="icon-clipboard"></span> /invite ${escapeHtml(req.playerDisplayName || req.playerId)}`;
    copyBtn.addEventListener('click', () => {
      const inviteCmd = `/invite ${req.playerDisplayName || req.playerId}`;
      navigator.clipboard.writeText(inviteCmd).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `<span class="icon-check"></span> ${escapeHtml(t.gfCopied || 'Copied!')}`;
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `<span class="icon-clipboard"></span> /invite ${escapeHtml(req.playerDisplayName || req.playerId)}`;
        }, 2000);
      });
    });

    inviteRow.appendChild(copyBtn);

    // Mark as invited button (if not already)
    if (req.status === 'accepted') {
      const markBtn = document.createElement('button');
      markBtn.className = 'gf-btn small';
      markBtn.textContent = t.gfMarkInvited || 'Mark Invited';
      markBtn.addEventListener('click', async () => {
        await window.api.gfMarkInvited(state.myListing.id, req.playerId);
        showToast(t.gfPlayerMarkedInvited.replace('{name}', () => req.playerDisplayName || req.playerId));
      });
      inviteRow.appendChild(markBtn);
    }

    info.appendChild(inviteRow);
  }

  return card;
}

// ─── Create Listing Modal ────────────────────────────────────
function getCreateCooldownRemainingMs() {
  // Server enforces 60s between listing creates per accountId. Mirror it
  // locally for instant UI feedback.
  const lastMs = state.myListing?.createdAt || state.cooldowns?._lastCreateMs || 0;
  const cooldown = state.cooldowns?.createMs || 60_000;
  if (!lastMs) return Math.max(0, state.cooldowns?.createRemainingMs || 0);
  const elapsed = Date.now() - lastMs;
  return Math.max(0, cooldown - elapsed);
}

function openCreateModal() {
  if (state.myListing) {
    showToast(t.gfAlreadyHaveListing || 'You already have an active listing');
    switchTab('my-listing');
    return;
  }
  const remaining = getCreateCooldownRemainingMs();
  if (remaining > 0) {
    showToast((t.gfCooldownWait || 'Wait %s before creating another listing').replace('%s', `${Math.ceil(remaining / 1000)}s`));
    return;
  }
  $('#gf-create-modal').classList.remove('hidden');

  // Reset form
  $('#gf-create-activity').value = 'General Grouping';
  $('#gf-create-goal').value = 'Other';
  $('#gf-create-slots').value = '3';
  $('#gf-create-lang-req').value = 'none';
  $('#gf-create-lang-val').disabled = true;
  $('#gf-create-region-req').value = 'none';
  $('#gf-create-region-val').disabled = true;
}

function closeCreateModal() {
  $('#gf-create-modal').classList.add('hidden');
}

async function submitCreateListing() {
  const btn = $('#gf-create-submit');
  btn.disabled = true;
  btn.textContent = t.gfCreating || 'Creating...';

  try {
    const data = {
      activityType: $('#gf-create-activity').value,
      goalType: $('#gf-create-goal').value,
      slotsNeeded: parseInt($('#gf-create-slots').value, 10),
      languageRequirement: $('#gf-create-lang-req').value,
      languageValue: $('#gf-create-lang-val').value,
      regionRequirement: $('#gf-create-region-req').value,
      regionValue: $('#gf-create-region-val').value,
    };

    const result = await window.api.gfCreateListing(data);
    if (result) {
      state.cooldowns = { ...(state.cooldowns || {}), _lastCreateMs: Date.now() };
      closeCreateModal();
      showToast(t.gfListingCreated || 'Listing created!');
      switchTab('my-listing');
    } else {
      const remaining = getCreateCooldownRemainingMs();
      if (remaining > 0) {
        showToast((t.gfCooldownWait || 'Wait %s before creating another listing').replace('%s', `${Math.ceil(remaining / 1000)}s`));
      } else {
        showToast(t.gfFailedCreate || 'Failed to create listing');
      }
    }
  } catch (err) {
    console.error('[GF] Create listing error:', err);
    showToast(t.gfErrorCreating || 'Error creating listing');
  }

  btn.disabled = false;
  btn.textContent = t.gfCreateListing || 'Create Listing';
}

// ─── Edit Listing Modal ──────────────────────────────────────
function openEditModal() {
  if (!state.myListing) return;
  const modal = $('#gf-edit-modal');
  modal.classList.remove('hidden');

  // Populate edit activity dropdown
  const editActivity = $('#gf-edit-activity');
  editActivity.innerHTML = '';
  for (const act of state.activityTypes) {
    const opt = document.createElement('option');
    opt.value = act;
    opt.textContent = tAct(act);
    if (act === state.myListing.activityType) opt.selected = true;
    editActivity.appendChild(opt);
  }

  // Populate edit goal dropdown
  const editGoal = $('#gf-edit-goal');
  editGoal.innerHTML = '';
  for (const goal of state.goalTypes) {
    const opt = document.createElement('option');
    opt.value = goal;
    opt.textContent = tGoal(goal);
    if (goal === state.myListing.goalType) opt.selected = true;
    editGoal.appendChild(opt);
  }

}

function closeEditModal() {
  $('#gf-edit-modal').classList.add('hidden');
}

async function submitEditListing() {
  const btn = $('#gf-edit-submit');
  btn.disabled = true;

  try {
    await window.api.gfUpdateListing({
      activityType: $('#gf-edit-activity').value,
      goalType: $('#gf-edit-goal').value,
    });
    closeEditModal();
    showToast(t.gfListingUpdated || 'Listing updated');
  } catch (err) {
    showToast(t.gfFailedUpdate || 'Failed to update listing');
  }

  btn.disabled = false;
}

// ─── Profile ─────────────────────────────────────────────────
async function loadProfile() {
  if (profileLoaded) return;
  const accountId = state.playerId;
  if (!accountId) return;
  try {
    const profile = await window.api.gfGetProfile();
    if (state.playerId !== accountId) return;
    if (profile) {
      $('#gf-profile-name').value = state.displayName || '';
      if (profile.primaryLanguage) $('#gf-profile-lang1').value = profile.primaryLanguage;
      if (profile.secondaryLanguage) $('#gf-profile-lang2').value = profile.secondaryLanguage;
      if (profile.regionPreference) $('#gf-profile-region').value = profile.regionPreference;
      profileLoaded = true;
    }
  } catch (e) {
    console.log('[GF] Profile load failed (may not exist yet)');
  }

  // Default the name field
  if (!$('#gf-profile-name').value) {
    $('#gf-profile-name').value = state.displayName || '';
  }
}

async function saveProfile() {
  const btn = $('#gf-save-profile');
  btn.disabled = true;

  try {
    await window.api.gfSavePreferences({
      primaryLanguage: $('#gf-profile-lang1').value,
      secondaryLanguage: $('#gf-profile-lang2').value || null,
      regionPreference: $('#gf-profile-region').value,
    });

    const saved = $('#gf-profile-saved');
    saved.classList.add('visible');
    setTimeout(() => saved.classList.remove('visible'), 2000);
  } catch (e) {
    showToast(t.gfFailedSavePrefs || 'Failed to save preferences');
  }

  btn.disabled = false;
}

// ─── Utility Functions ───────────────────────────────────────

/** Manual refresh triggered by button click. */
async function manualRefresh() {
  const btn = $('#gf-refresh-btn');
  const icon = btn?.querySelector('.icon-refresh');
  if (icon) icon.classList.add('spinning');

  try {
    const freshState = await window.api.gfGetState();
    if (freshState) {
      state = { ...state, ...freshState };
      renderAll();
      if (currentTab === 'home') loadSuggestions();
    }
    showToast(t.gfRefreshed || 'Refreshed');
  } catch (e) {
    console.error('[GF] Manual refresh failed:', e);
    showToast(t.gfRefreshFailed || 'Refresh failed');
  }

  setTimeout(() => { if (icon) icon.classList.remove('spinning'); }, 600);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatTimeAgo(timestamp) {
  const ms = typeof timestamp === 'number' ? timestamp : Date.now();
  const diff = Date.now() - ms;
  if (diff < 60_000) return t.gfJustNow || 'just now';
  if (diff < 3600_000) return (t.gfMinutesAgo || '{n}m ago').replace('{n}', Math.floor(diff / 60_000));
  if (diff < 86400_000) return (t.gfHoursAgo || '{n}h ago').replace('{n}', Math.floor(diff / 3600_000));
  return (t.gfDaysAgo || '{n}d ago').replace('{n}', Math.floor(diff / 86400_000));
}

function showToast(message) {
  // Remove existing toasts
  document.querySelectorAll('.gf-toast').forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = 'gf-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  // Auto-remove after animation
  setTimeout(() => toast.remove(), 2500);
}
