/** Small, keyboard-accessible tours that never change a user's widget layout. */
'use strict';

const tutorialId = new URLSearchParams(window.location.search).get('tour') || 'app';
const $ = selector => document.querySelector(selector);
let config = {};
const tr = (key, fallback) => window.i18n?.translations?.[config.language || 'en']?.[key] || fallback;
let tutorial = null;
let stepIndex = 0;
let finishing = false;
let configRevision = 0;
const TUTORIAL_ICON_PATHS = {
  timer: 'M9 2h6m-3 0v3m6 2 2-2M12 9v4l3 2M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2',
  boss: 'M5 9 3 4l6 3 3-4 3 4 6-3-2 5M5 10h14v6l-7 5-7-5zM8 13h2m4 0h2m-5 4h2',
  affiliation: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
  flag: 'M5 22V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0',
  star: 'm12 2 3 6.5 7 1-5 5 1.2 7-6.2-3.3L5.8 22 7 14.5l-5-5 7-1z',
  group: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M17 3a4 4 0 0 1 0 8m5 10v-2a4 4 0 0 0-3-3.9',
  arena: 'M4 3v5l12 12m4-17v5L8 20M2 16l6 6m8 0 6-6M3 21l3-3m12 0 3 3',
  calendar: 'M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M7 13h2m6 0h2M7 17h2m6 0h2',
  weather: 'M7 16H6a4 4 0 1 1 .6-7.95A6 6 0 0 1 18 7a4.5 4.5 0 0 1 0 9h-1M9 17l-1 3m5-3-1 3m5-3-1 3',
  temper: 'm14 2 7 7-8 8-6-6zM3 21l7-7m-6 1 5 5M17 5l-6 6',
  paw: 'M8 14c-2 1-4 4-2 6 2 2 4-1 6-1s4 3 6 1c2-2 0-5-2-6-2-2-6-2-8 0M6 11c-2 0-3-4-1-5 2-1 4 5 1 5M10 8c-2 0-3-6-1-6 3 0 3 6 1 6M14 8c-2 0-2-6 1-6 2 0 1 6-1 6M18 11c-3 0-1-6 1-5 2 1 1 5-1 5',
  database: 'M20 5c0 2-4 3-8 3S4 7 4 5s4-3 8-3 8 1 8 3zM4 5v14c0 2 4 3 8 3s8-1 8-3V5M4 12c0 2 4 3 8 3s8-1 8-3',
  log: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8m-8 4h8',
  title: 'M8 3h8v5a4 4 0 0 1-8 0zM8 4H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 12v5m-4 4h8m-7-4h6v4',
};

function tutorialIcon(name, className = 'tutorial-symbol') {
  if (className === 'tutorial-symbol' && name === tutorial?.icon && window.WidgetIcons?.catalogue?.[tutorialId]) {
    const svg = window.WidgetIcons.create(tutorialId, document); svg.classList.add(className); return svg;
  }
  if (Object.hasOwn(TUTORIAL_ICON_PATHS, name)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ class: className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', TUTORIAL_ICON_PATHS[name]); svg.append(path);
    return svg;
  }
  const node = document.createElement('span');
  const sharedIcons = ['market', 'settings', 'widgets', 'check', 'search', 'clipboard', 'refresh', 'map-pin', 'info', 'eye'];
  node.className = `${className} icon-${sharedIcons.includes(name) ? name : 'widgets'}`;
  return node;
}

function renderTutorialVisual(step) {
  const visual = $('#tutorial-visual');
  const emblem = document.createElement('span');
  emblem.className = 'tutorial-emblem';
  if (tutorialId === 'app') {
    const image = document.createElement('img');
    image.src = '../../assets/overkot.png'; image.alt = '';
    emblem.append(image);
  } else emblem.append(tutorialIcon(tutorial.icon));
  visual.replaceChildren(emblem);
  if (step.chord) {
    const chord = document.createElement('kbd'); chord.className = 'tutorial-chord'; chord.textContent = step.chord;
    visual.append(chord);
  } else if (step.visual === 'widgets' || step.visual === 'layout') {
    const arrow = document.createElement('span'); arrow.className = 'tutorial-arrow'; arrow.textContent = '→';
    const icons = document.createElement('span'); icons.className = 'tutorial-icon-row';
    icons.append(...['timer', 'map-pin', 'clock', 'widgets'].map(name => tutorialIcon(name, 'tutorial-mini-icon')));
    visual.append(arrow, icons);
  } else if (step.visual === 'ready') visual.append(tutorialIcon('check'));
}

function renderTutorial(focusTitle = false) {
  const translations = window.i18n?.translations?.[config.language || 'en'];
  tutorial = OverkotTutorials.getTutorial(tutorialId, config, translations);
  $('#tutorial-eyebrow').textContent = tr('tourQuick', 'Quick tour');
  $('#tutorial-back').textContent = tr('tourBack', 'Back');
  $('#tutorial-skip').textContent = tr('tourSkip', 'Skip tour');
  $('#tutorial-disable-all').textContent = tr('tourDisable', 'Turn off all tours');
  $('#tutorial-close').title = tr('tourSkip', 'Skip tour');
  $('#tutorial-close').setAttribute('aria-label', $('#tutorial-close').title);
  if (!tutorial) {
    $('#tutorial-step-title').textContent = tr('tourUnavailableTitle', 'Tutorial unavailable');
    $('#tutorial-body').textContent = tr('tourUnavailableHint', 'This tutorial is not available in this version of Overkot.');
    $('#tutorial-progress').textContent = '';
    $('#tutorial-skip').textContent = tr('tourClose', 'Close');
    $('#tutorial-close').setAttribute('aria-label', tr('tourClose', 'Close'));
    return;
  }
  OverkotTheme.apply({ ...config, fontOpacity: 100 });
  const step = tutorial.steps[stepIndex];
  document.title = $('#tutorial-title').textContent = tutorial.name;
  $('#tutorial-progress').textContent = `${stepIndex + 1} / ${tutorial.steps.length}`;
  $('#tutorial-progress').setAttribute('aria-label', tr('tourProgress', 'Step {step} of {total}').replace('{step}', stepIndex + 1).replace('{total}', tutorial.steps.length));
  const segments = tutorial.steps.map((_step, index) => {
    const segment = document.createElement('span');
    segment.className = `tutorial-segment${index === stepIndex ? ' is-current' : index < stepIndex ? ' is-complete' : ''}`;
    return segment;
  });
  $('#tutorial-segments').replaceChildren(...segments);
  $('#tutorial-step-title').textContent = step.title;
  $('#tutorial-body').textContent = step.body;
  $('#tutorial-tip').textContent = step.tip || '';
  $('#tutorial-tip').hidden = !step.tip;
  $('#tutorial-action').hidden = !step.action;
  $('#tutorial-action').textContent = step.action?.label || '';
  $('#tutorial-action').disabled = finishing;
  $('#tutorial-back').disabled = finishing || stepIndex === 0;
  $('#tutorial-next').disabled = finishing;
  $('#tutorial-next').textContent = finishing ? tr('tourSaving', 'Saving…') : stepIndex === tutorial.steps.length - 1 ? tr('tourDone', 'Done') : tr('tourNext', 'Next');
  $('#tutorial-skip').disabled = finishing;
  $('#tutorial-close').disabled = finishing;
  $('#tutorial-disable-all').disabled = finishing;
  renderTutorialVisual(step);
  $('#tutorial-card').scrollTop = 0;
  if (focusTitle) $('#tutorial-step-title').focus({ preventScroll: true });
}

async function finishTutorial() {
  if (finishing) return;
  if (!tutorial) { window.api.windowClose(); return; }
  finishing = true;
  $('#tutorial-error').hidden = true;
  renderTutorial();
  try {
    if (await window.api.completeTutorial(tutorialId) === false) throw new Error('Completion was not saved');
    window.api.windowClose();
  } catch (error) {
    console.error('[TUTORIAL] Could not save completion:', error);
    finishing = false;
    $('#tutorial-error').textContent = tr('tourSaveFailed', 'Could not save your tutorial progress. Choose Done or Skip tour to retry.');
    $('#tutorial-error').hidden = false;
    renderTutorial();
  }
}

async function disableAllTutorials() {
  if (finishing) return;
  finishing = true;
  $('#tutorial-error').hidden = true;
  renderTutorial();
  try {
    if (await window.api.setTutorialsEnabled(false) !== true) throw new Error('Tutorial preference was not saved');
    window.api.windowClose();
  } catch (error) {
    console.error('[TUTORIAL] Could not turn off tours:', error);
    finishing = false;
    $('#tutorial-error').textContent = tr('tourDisableFailed', 'Could not turn off tours. Try again.');
    $('#tutorial-error').hidden = false;
    renderTutorial();
  }
}

function advanceTutorial(direction) {
  if (!tutorial || finishing) return;
  if (direction > 0 && stepIndex === tutorial.steps.length - 1) { void finishTutorial(); return; }
  stepIndex = Math.max(0, Math.min(tutorial.steps.length - 1, stepIndex + direction));
  renderTutorial(true);
}

function runTutorialAction() {
  const action = tutorial?.steps[stepIndex].action;
  // Only catalogue-owned method names can reach the preload bridge.
  if (action && ['openSettings', 'openWidgets', 'openGroupFinder', 'openMarket', 'openCalendarSettings'].includes(action.method)) window.api[action.method]?.();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#tutorial-back').addEventListener('click', () => advanceTutorial(-1));
  $('#tutorial-next').addEventListener('click', () => advanceTutorial(1));
  $('#tutorial-skip').addEventListener('click', () => void finishTutorial());
  $('#tutorial-close').addEventListener('click', () => void finishTutorial());
  $('#tutorial-disable-all').addEventListener('click', () => void disableAllTutorials());
  $('#tutorial-action').addEventListener('click', runTutorialAction);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); void finishTutorial();
    }
  });
  window.api.onConfigChanged?.(next => {
    configRevision++;
    config = next || {};
    renderTutorial();
  });
  const revision = configRevision;
  try {
    const state = await window.api.getState();
    if (configRevision === revision) config = state.config || {};
  } catch { /* Default shortcuts keep the tour usable if initial state is unavailable. */ }
  renderTutorial();
  $('#tutorial-next').focus();
});
