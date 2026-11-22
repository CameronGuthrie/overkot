/**
 * Timer Utilities — Shared between renderer.js and widget-host.js
 *
 * Provides timer duration lookup, categorization, display name resolution,
 * time formatting, and HTML rendering for timer entries.
 */

// ═══════════════════════════════════════════════════════════
// Timer durations (data loaded from main process via IPC)
// ═══════════════════════════════════════════════════════════
let timerDurationsData = null;

function setTimerDurationsData(data) {
  timerDurationsData = data;
}

function getTimerDuration(tag) {
  const d = timerDurationsData;
  if (!d) return 1800; // fallback before data is loaded
  const lower = tag.toLowerCase();

  // Exact tag match
  if (d.exact[lower] !== undefined) return d.exact[lower];

  // Substring pattern matches
  for (const [pattern, seconds] of Object.entries(d.patterns)) {
    if (lower.includes(pattern)) return seconds;
  }

  // PendingRecipe lookup
  if (lower.startsWith('pendingrecipe:')) {
    const recipe = lower.slice('pendingrecipe:'.length);
    return d.recipes[recipe] !== undefined ? d.recipes[recipe] : d.recipeDefaultSeconds;
  }

  return d.defaultSeconds;
}

// ═══════════════════════════════════════════════════════════
// Timer categorization
// ═══════════════════════════════════════════════════════════

const BOSS_TAGS = ['curlailsiege', 'kearnholdsiege', 'pollutiontowerodell', 'pollutiontowerkearnhold', 'pollutiontowerairdelands', 'mendicantkingspawned'];

function categorizeTimer(tag) {
  const lower = tag.toLowerCase();
  if (BOSS_TAGS.includes(lower) || lower.includes('siege') || lower.includes('pollutiontower') || lower.includes('-subboss') || lower.includes('spawned') || lower.includes('fencerduelsworddeco')) return 'boss';
  if (lower.startsWith('pendingrecipe:')) return 'crafting';
  return 'other';
}

/**
 * Look up a display name for a timer tag using the names map from main process.
 * Falls back to a cleaned-up version of the raw tag.
 */
function lookupTimerName(names, tag) {
  if (!names || !tag) return tag || '';

  // Exact match
  if (names[tag]) return names[tag];

  // PendingRecipe: try with and without prefix
  if (tag.startsWith('PendingRecipe:')) {
    const itemKey = tag.slice('PendingRecipe:'.length);
    if (names[`PendingRecipe:${itemKey}`]) return names[`PendingRecipe:${itemKey}`];
    // Clean fallback
    return itemKey
      .replace(/RecipeItem$/, '')
      .replace(/Blueprint$/, '')
      .replace(/Recipe$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  // Fallback: humanise the tag
  return tag
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ═══════════════════════════════════════════════════════════
// Time formatting
// ═══════════════════════════════════════════════════════════

function formatTime(tag, remaining, translations) {
  if (remaining <= 0) return translations.ready;

  // Syndicate swap: show days if >= 24h
  if (tag.toLowerCase() === 'lastsyndicateswaptime' && remaining >= 86400) {
    const days = Math.ceil(remaining / 86400);
    return `${days} ${translations.days}`;
  }

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════
// Timer HTML rendering
// ═══════════════════════════════════════════════════════════

/** Retain live timer nodes so fill transitions and event sweeps can finish. */
function reconcileNormalTimers(container, rows, { hideCountdown = false, readyLabel = 'Ready' } = {}) {
  const existing = new Map();
  for (const entry of Array.from(container.children)) {
    const key = entry.dataset.timerKey;
    if (!existing.has(key)) existing.set(key, []);
    existing.get(key).push(entry);
  }
  const entries = [];
  const node = (tag, className) => { const element = document.createElement(tag); element.className = className; return element; };
  for (const [index, row] of rows.entries()) {
    let entry = existing.get(row.key)?.shift();
    if (!entry) {
      entry = node('div', 'timer-entry'); entry.dataset.timerKey = row.key;
      const header = node('div', 'timer-header'), name = node('span', 'timer-name'), countdown = node('span', 'timer-countdown');
      const bar = node('div', 'timer-bar'), fill = node('div', 'timer-bar-fill'), label = node('div', 'timer-bar-text');
      fill.style.background = 'var(--bar-color)'; bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      header.append(name, countdown); bar.append(fill, label); entry.append(header, bar);
      entry._overkotTimerParts = { name, countdown, bar, fill, label };
    }
    const { name, countdown, bar, fill, label } = entry._overkotTimerParts;
    const remaining = row.remaining, duration = getTimerDuration(row.tag);
    const progress = Math.min(Math.max((duration - Math.max(remaining, 0)) / Math.max(duration, 1), 0), 1) * 100;
    const ready = remaining <= 0;
    name.textContent = `${row.name}:`; name.title = row.name;
    countdown.textContent = ready ? readyLabel : row.time;
    countdown.className = ready ? 'timer-ready' : 'timer-countdown'; countdown.hidden = hideCountdown;
    entry.dataset.urgent = String(!ready && remaining <= 60); entry.dataset.complete = String(ready);
    fill.style.width = `${progress}%`; label.textContent = `${Math.round(progress)}%`;
    bar.setAttribute('aria-label', row.name); bar.setAttribute('aria-valuenow', String(Math.round(progress * 10) / 10));
    if (container.children[index] !== entry) container.insertBefore(entry, container.children[index] || null);
    entries.push(entry);
  }
  for (const bucket of existing.values()) for (const orphan of bucket) orphan.remove();
  return entries;
}

function renderNormal(name, timeStr, isReady, remaining, tag, hideCountdown, readyLabel) {
  const duration = getTimerDuration(tag);
  const elapsed = duration - Math.max(remaining, 0);
  const progress = Math.min(Math.max(elapsed / duration, 0), 1) * 100;

  const readyHtml = isReady
    ? `<span class="timer-ready">${readyLabel || 'Ready'}</span>`
    : `<span class="timer-countdown">${timeStr}</span>`;

  return `<div class="timer-entry" data-urgent="${!isReady && remaining <= 60}" data-complete="${isReady}">
    <div class="timer-header">
      <span class="timer-name" title="${esc(name).replace(/"/g, '&quot;')}">${esc(name)}:</span>
      ${hideCountdown ? '' : readyHtml}
    </div>
    <div class="timer-bar">
      <div class="timer-bar-fill" style="width:${progress}%;background:var(--bar-color)"></div>
      <div class="timer-bar-text">${Math.round(progress)}%</div>
    </div>
  </div>`;
}

function renderCompact(name, timeStr, isReady, remaining, tag, hideCountdown, readyLabel) {
  const duration = getTimerDuration(tag);
  const elapsed = duration - Math.max(remaining, 0);
  const progress = Math.min(Math.max(elapsed / duration, 0), 1) * 100;

  const readyHtml = isReady
    ? `<span class="timer-ready">${readyLabel || 'Ready'}</span>`
    : `<span class="timer-countdown">${timeStr}</span>`;

  return `<div class="timer-compact">
    <span class="timer-name">${esc(name)}:</span>
    <div class="timer-bar"><div class="timer-bar-fill" style="width:${progress}%;background:var(--bar-color)"></div></div>
    ${hideCountdown ? '' : readyHtml}
  </div>`;
}

function renderTextOnly(name, timeStr, isReady, hideCountdown, readyLabel) {
  const readyHtml = isReady
    ? `<span class="timer-ready">${readyLabel || 'Ready'}</span>`
    : `<span class="timer-countdown">${timeStr}</span>`;
  return `<div class="timer-text-only">
    <span class="timer-name">${esc(name)}:</span>
    ${hideCountdown ? '' : readyHtml}
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// HTML escape helper
// ═══════════════════════════════════════════════════════════

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
