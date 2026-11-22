/**
 * Changelog Window – Renderer Script
 *
 * Loads and displays the changelog from the main process.
 * Latest version is featured at the top; previous versions are collapsible.
 */

const $ = (sel) => document.querySelector(sel);

let t = {};

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderVersion(v, isFeatured) {
  const cls = isFeatured ? 'changelog-entry featured' : 'changelog-entry';
  const tag = isFeatured ? t.latest || 'Latest' : '';
  const badge = tag ? `<span class="changelog-badge">${tag}</span>` : '';
  return `<div class="${cls}">
    <div class="changelog-entry-header">
      <span class="changelog-version">${esc(v.version)}</span>${badge}
    </div>
    <ul class="changelog-changes">${v.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
  </div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#close-btn').addEventListener('click', () => window.api.windowClose());

  // Load translations
  const state = await window.api.getState();
  const config = state?.config || {};
  const lang = config.language || 'en';
  t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  // Apply translated window title and close tooltip
  $('#changelog-title').textContent = `${t.changelogTitle} - ${t.title}`;
  $('#close-btn').title = t.tooltipClose;

  try {
    const data = await window.api.getChangelog();
    const body = $('#changelog-body');
    if (!data || !data.versions || data.versions.length === 0) {
      body.innerHTML = '<p class="changelog-empty">' + (t.noChangelog || 'No changelog available.') + '</p>';
      return;
    }

    const [latest, ...previous] = data.versions;

    let html = renderVersion(latest, true);

    if (previous.length > 0) {
      html += `<div class="changelog-previous">
        <button class="changelog-toggle" id="toggle-previous">
          <span class="changelog-toggle-arrow">▶</span> ${t.previousChanges || 'Previous Changes'} (${previous.length})
        </button>
        <div class="changelog-previous-list hidden" id="previous-list">
          ${previous.map(v => renderVersion(v, false)).join('')}
        </div>
      </div>`;
    }

    body.innerHTML = html;

    // Toggle previous changes
    const toggleBtn = $('#toggle-previous');
    const prevList = $('#previous-list');
    if (toggleBtn && prevList) {
      toggleBtn.addEventListener('click', () => {
        const open = !prevList.classList.contains('hidden');
        prevList.classList.toggle('hidden', open);
        toggleBtn.querySelector('.changelog-toggle-arrow').textContent = open ? '\u25B6' : '\u25BC';
      });
    }
  } catch {
    $('#changelog-body').innerHTML = '<p class="changelog-empty">' + (t.failedChangelog || 'Failed to load changelog.') + '</p>';
  }
});
