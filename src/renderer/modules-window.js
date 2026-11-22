/**
 * Modules Window – Renderer Script
 *
 * Shows toggleable checkboxes for each timer module.
 * Changes are saved immediately via IPC and broadcast to the main window.
 */

const $ = (sel) => document.querySelector(sel);

const MODULE_DEFS = [
  { id: 'boss', nameKey: 'bossTimers', descKey: 'bossTimersDesc' },
  { id: 'crafting', nameKey: 'craftingTimers', descKey: 'craftingTimersDesc' },
  { id: 'other', nameKey: 'otherTimers', descKey: 'otherTimersDesc' },
  { id: 'affiliation', nameKey: 'affiliationModule', descKey: 'affiliationModuleDesc' },
  { id: 'factions', nameKey: 'factionsModule', descKey: 'factionsModuleDesc' },
];

document.addEventListener('DOMContentLoaded', async () => {
  $('#close-btn').addEventListener('click', () => window.api.windowClose());

  // Get current state from config
  const state = await window.api.getState();
  const config = state?.config || {};
  const visibility = config.moduleVisibility || {};
  const lang = config.language || 'en';
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  // Apply translated window title and close tooltip
  $('#modules-title').textContent = t.modulesTitle;
  $('#close-btn').title = t.tooltipClose;

  const body = $('#modules-body');

  for (const def of MODULE_DEFS) {
    const checked = visibility[def.id] === true;

    const row = document.createElement('label');
    row.className = 'module-toggle-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.dataset.module = def.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'module-toggle-name';
    nameSpan.textContent = t[def.nameKey];

    const descSpan = document.createElement('span');
    descSpan.className = 'module-toggle-desc';
    descSpan.textContent = t[def.descKey];

    row.appendChild(cb);
    row.appendChild(nameSpan);
    row.appendChild(descSpan);
    body.appendChild(row);

    cb.addEventListener('change', () => {
      // Build full visibility object from all checkboxes
      const vis = {};
      body.querySelectorAll('input[data-module]').forEach(c => {
        vis[c.dataset.module] = c.checked;
      });
      window.api.saveConfig({ moduleVisibility: vis });
    });
  }
});
