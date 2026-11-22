/**
 * Widget Data — Shared constants and rendering functions for game data widgets
 *
 * Used by both renderer.js and widget-host.js.
 * Provides affiliation, faction standing, and Group Finder widget rendering.
 */

// ═══════════════════════════════════════════════════════════
// Affiliation constants & rendering
// ═══════════════════════════════════════════════════════════

function formatWidgetNumber(value) {
  return value.toLocaleString(globalThis.document?.documentElement?.lang || undefined);
}

function affiliationProgressHtml(progress, translations = {}) {
  if (!progress || !Number.isSafeInteger(progress.remaining) || progress.remaining < 0) return '';
  translations = translations || {};
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const knownCap = Number.isSafeInteger(progress.cap) && progress.cap > 0 && Number.isSafeInteger(progress.earned)
    && progress.earned >= 0 && progress.earned + progress.remaining === progress.cap;
  const pct = knownCap ? progress.earned / progress.cap * 100 : null;
  return `<div class="affiliation-header">
    <span class="affiliation-label">${esc(translations.affiliationEarned || 'Earned today')}</span>
    <span class="affiliation-value">${knownCap ? `${formatWidgetNumber(progress.earned)} / ${formatWidgetNumber(progress.cap)}` : esc(translations.affiliationDailyCapUnavailable || 'Daily cap unavailable')}</span>
  </div>${knownCap ? `<div class="timer-bar affiliation-bar">
    <div class="timer-bar-fill" style="width:${pct}%;background:var(--bar-color)"></div>
    <div class="timer-bar-text">${Math.round(pct)}%</div>
  </div>` : ''}
  <div class="affiliation-remaining">${formatWidgetNumber(progress.remaining)} ${esc(translations.affiliationRemaining || 'remaining')}</div>`;
}

function renderAffiliationWidget(mod, dailyAffiliation, translations, widgetVisibility, namesMap) {
  const content = mod.querySelector('.affiliation-content');
  const emptyEl = mod.querySelector('.widget-empty');
  if (!content || !emptyEl) return;

  const progressHtml = affiliationProgressHtml(dailyAffiliation, translations);
  if (!progressHtml) {
    emptyEl.classList.remove('hidden');
    content.innerHTML = '';
    if (widgetVisibility && widgetVisibility.affiliation !== false) {
      mod.classList.remove('widget-hidden');
    } else if (widgetVisibility) {
      mod.classList.add('widget-hidden');
    }
    return;
  }

  mod.classList.remove('widget-hidden');
  emptyEl.classList.add('hidden');

  const html = `<div class="affiliation-entry">${progressHtml}</div>`;

  if (content.innerHTML !== html) {
    content.innerHTML = html;
  }
}

// ═══════════════════════════════════════════════════════════
// Faction standing constants & rendering
// ═══════════════════════════════════════════════════════════

/**
 * Standing rank table:
 *   Rank 0: 0 → 5,000       (cap 5,000)
 *   Rank 1: 5,000 → 10,000  (cap 5,000)
 *   Rank 2: 10,000 → 30,000 (cap 20,000)
 *   Rank 3: 30,000 → 50,000 (cap 20,000)
 *   Rank 4: 50,000 → 80,000 (cap 30,000)
 *   Rank 5: 80,000 → 110,000 (cap 30,000)
 */
const STANDING_RANKS = [
  { rank: 0, required: 0,     cap: 5000   },
  { rank: 1, required: 5000,  cap: 5000   },
  { rank: 2, required: 10000, cap: 20000  },
  { rank: 3, required: 30000, cap: 20000  },
  { rank: 4, required: 50000, cap: 30000  },
  { rank: 5, required: 80000, cap: 30000  },
];

// Only display these three factions
const FACTION_TAGS = ['ChampionSyndicate', 'FeySyndicate', 'SilentRoseSyndicate'];

// Fallback names if lang files haven't loaded
const FACTION_FALLBACK = {
  ChampionSyndicate: 'Champions',
  FeySyndicate: 'The Fey',
  SilentRoseSyndicate: 'Silent Rose',
};

function renderFactionsWidget(mod, factions, translations, widgetVisibility, namesMap) {
  const content = mod.querySelector('.factions-content');
  const emptyEl = mod.querySelector('.widget-empty');
  if (!content || !emptyEl) return;

  const displayFactions = factions
    ? factions.filter(f => FACTION_TAGS.includes(f.tag))
    : [];

  if (displayFactions.length === 0) {
    emptyEl.classList.remove('hidden');
    content.innerHTML = '';
    if (widgetVisibility && widgetVisibility.factions !== false) {
      mod.classList.remove('widget-hidden');
    } else if (widgetVisibility) {
      mod.classList.add('widget-hidden');
    }
    return;
  }

  mod.classList.remove('widget-hidden');
  emptyEl.classList.add('hidden');

  let html = '';
  for (const faction of displayFactions) {
    const name = (namesMap && namesMap[faction.tag]) || FACTION_FALLBACK[faction.tag] || faction.tag;
    const rank = faction.title;
    const standing = faction.standing;

    const rankInfo = STANDING_RANKS[rank] || STANDING_RANKS[STANDING_RANKS.length - 1];
    const rankFloor = rankInfo.required;
    const progressInRank = Math.max(standing - rankFloor, 0);
    const rankCap = rankInfo.cap;
    const pct = Math.min(Math.max(progressInRank / rankCap, 0), 1) * 100;

    const rankLabel = translations.factionRank || 'Rank';

    const factionBarHtml = `
      <div class="timer-bar faction-bar">
        <div class="timer-bar-fill" style="width:${pct}%;background:var(--bar-color)"></div>
        <div class="timer-bar-text">${Math.round(pct)}%</div>
      </div>`;

    html += `<div class="faction-entry">
      <div class="faction-header">
        <span class="faction-name">${esc(name)}</span>
        <span class="faction-rank">${esc(rankLabel)} ${rank} / ${STANDING_RANKS.length - 1}</span>
      </div>
      <div class="faction-standing-row">
        <span class="faction-standing-label">${formatWidgetNumber(progressInRank)} / ${formatWidgetNumber(rankCap)}</span>
      </div>${factionBarHtml}
    </div>`;
  }

  if (content.innerHTML !== html) {
    content.innerHTML = html;
  }
}

// ═══════════════════════════════════════════════════════════
// Ode Infamy widget rendering — single syndicate, no ranks
// ═══════════════════════════════════════════════════════════

const ODE_INFAMY_TAG = 'OdeSyndicate';
const ODE_INFAMY_FALLBACK = 'Ode Infamy';

function renderOdeInfamyWidget(mod, factions, translations, widgetVisibility, namesMap, dailyOde) {
  if (!mod) return;
  const content = mod.querySelector('.odeinfamy-content');
  const emptyEl = mod.querySelector('.widget-empty');
  if (!content || !emptyEl) return;

  const entry = Array.isArray(factions)
    ? factions.find(f => f.tag === ODE_INFAMY_TAG)
    : null;

  // Update widget header title from lang map (OdeDesc) when available
  const titleEl = mod.querySelector('.widget-title');
  if (titleEl) {
    const headerName = (namesMap && namesMap.OdeSyndicateDesc)
      || (translations && translations.odeInfamyWidget)
      || ODE_INFAMY_FALLBACK;
    if (titleEl.textContent !== headerName) titleEl.textContent = headerName;
  }

  if (!entry) {
    emptyEl.classList.remove('hidden');
    if (translations && translations.noOdeInfamyData) {
      emptyEl.textContent = translations.noOdeInfamyData;
    }
    content.innerHTML = '';
    return;
  }

  emptyEl.classList.add('hidden');

  const name = (namesMap && namesMap[ODE_INFAMY_TAG]) || translations?.odeInfamyWidget || ODE_INFAMY_FALLBACK;
  const standingLabel = (translations && translations.odeInfamyStanding) || 'Standing';
  const standing = Number(entry.standing) || 0;

  // Both widgets use the same rank-derived allowance and their own balance.
  const progressHtml = affiliationProgressHtml(dailyOde, translations);
  const dailyHtml = progressHtml ? `<div class="affiliation-entry odeinfamy-daily">${progressHtml}</div>` : '';

  const html = `<div class="faction-entry">
    <div class="faction-header">
      <span class="faction-name">${esc(name)}</span>
    </div>
    <div class="faction-standing-row">
      <span class="faction-standing-label">${esc(standingLabel)}: ${formatWidgetNumber(standing)}</span>
    </div>
  </div>${dailyHtml}`;

  if (content.innerHTML !== html) {
    content.innerHTML = html;
  }
}

// ═══════════════════════════════════════════════════════════
// Group Finder widget rendering (compact status card)
// ═══════════════════════════════════════════════════════════

function renderGroupFinderWidgetCard(gfState, translations, $) {
  const dot = $('#gf-widget-dot');
  const statusText = $('#gf-widget-status-text');
  const listingVal = $('#gf-widget-listing');
  const listingsCount = $('#gf-widget-listings-count');
  const requestsRow = $('#gf-widget-requests-row');
  const requestsBadge = $('#gf-widget-requests');

  if (!dot || !statusText) return;

  if (!gfState || !gfState.configured) {
    dot.className = 'gf-widget-dot offline';
    statusText.textContent = translations.gfNotConfigured || 'Not Configured';
    if (listingVal) listingVal.textContent = '—';
    if (listingsCount) listingsCount.textContent = '—';
    if (requestsRow) requestsRow.style.display = 'none';
    return;
  }

  // Online status
  const online = !!gfState.playerId;
  dot.className = online ? 'gf-widget-dot online' : 'gf-widget-dot offline';
  statusText.textContent = online ? (gfState.displayName || translations.gfOnline || 'Online') : (translations.gfOffline || 'Offline');

  // My listing summary
  if (gfState.myListing) {
    const l = gfState.myListing;
    const label = l.title || translations[ACTIVITY_KEY_MAP[l.activityType]] || l.activityType || translations.gfActive || 'Active';
    const members = l.slotsFilled || 1;
    if (listingVal) listingVal.textContent = `${label} (${members}/${l.slotsTotal || gfState.maxGroupSize || 4})`;
  } else {
    if (listingVal) listingVal.textContent = translations.gfNone || 'None';
  }

  // Open (non-full) active listings count
  const openListings = gfState.listings
    ? gfState.listings.filter(l => l.status === 'open' || (l.status === 'pending' && l.slotsFilled < l.slotsTotal))
    : [];
  if (listingsCount) listingsCount.textContent = String(openListings.length);

  // Incoming requests badge
  const pending = gfState.incomingRequests
    ? gfState.incomingRequests.filter(r => r.status === 'pending').length
    : 0;
  if (pending > 0) {
    if (requestsRow) requestsRow.style.display = '';
    if (requestsBadge) requestsBadge.textContent = String(pending);
  } else if (requestsRow) {
    requestsRow.style.display = 'none';
  }
}
