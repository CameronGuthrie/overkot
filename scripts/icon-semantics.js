'use strict';

// Authored roles, not a positional colour algorithm. Indices refer to the
// unchanged upstream shapes in assets/icons/lucide/<source>.svg.
const part = (name, channel, indices, motion = 'none', origin = '12px 12px') => ({ name, channel, indices, motion, origin });
const icon = (description, parts, fit = 1) => ({ description, fit, parts });
const p = (name, indices, motion, origin) => part(name, 'primary', indices, motion, origin);
const a = (name, indices, motion, origin) => part(name, 'secondary', indices, motion, origin);
const d = (name, indices, motion, origin) => part(name, 'detail', indices, motion, origin);

const widgets = {
  'collection-log': icon('A loose volume leans gently beside two upright books.', [p('shelf-books', [0, 1]), a('loose-book', [2], 'book-lean', '14px 20px')]),
  cosmetics: icon('The single shirt silhouette sways lightly from its collar.', [p('shirt', [0], 'fabric-sway', '12px 3px')]),
  'mastery-tracker': icon('The earned check settles inside a stationary badge.', [p('badge', [0]), a('earned-check', [1], 'confirm-settle')]),
  resources: icon('A complete top crate lifts above the two stationary base crates.', [p('base-crates', [0, 1, 2, 3, 4, 5, 6, 7]), a('top-crate', [8, 9, 10, 11], 'stock-lift')]),
  enhancements: icon('The gem remains rigid while its inner facets catch a brief glint.', [p('gem-outline', [1]), a('gem-facets', [0, 2], 'facet-glint')]),
  'crafting-planner': icon('Checklist markers become clear in reading order while the board stays fixed.', [p('clipboard-and-lines', [0, 1, 2, 3]), a('first-marker', [4], 'read-first'), a('second-marker', [5], 'read-second')]),
  activity: icon('The single activity waveform gives a restrained double heartbeat.', [p('activity-wave', [0], 'heartbeat')]),
  'crafting-log': icon('The pen makes a short writing stroke beside its stationary notebook.', [p('notebook', [0, 1, 2, 3, 4]), a('writing-pen', [5], 'pencil-write', '13px 11px')]),
  'session-analysis': icon('The complete chart bars grow from their shared baseline; the trend stays fixed.', [p('trend-line', [3]), a('chart-bars', [0, 1, 2, 4, 5], 'bars-grow', '12px 21px')]),
  boss: icon('The skull stays legible while its eye sockets briefly narrow together.', [p('skull-and-nose', [0, 1]), a('eye-sockets', [2, 3], 'skull-watch', '12px 12px')]),
  crafting: icon('The anvil head gives a small impact response on a stable stand.', [p('anvil-stand', [2, 3, 4]), a('anvil-head', [0, 1], 'anvil-impact', '12px 12px')]),
  other: icon('The stopwatch hand turns about its actual dial centre at 12,14.', [p('stopwatch-case', [0, 2]), a('stopwatch-hand', [1], 'clock-turn', '12px 14px')]),
  affiliation: icon('An affiliation check settles into its protective shield.', [p('shield', [0]), a('affiliation-check', [1], 'confirm-settle')]),
  factions: icon('The single flag silhouette gives a restrained, pole-anchored wave.', [p('flag', [0], 'flag-wave', '4px 22px')]),
  odeinfamy: icon('A single flame rises from its fixed base, then rests.', [p('flame', [0], 'flame-rise', '12px 21px')]),
  wiki: icon('The pages open slightly around a stationary book spine.', [p('book-spine', [0]), a('book-pages', [1], 'book-open', '12px 13px')]),
  groupfinder: icon('Two complete people settle together as a group.', [p('front-person', [0, 1], 'person-settle', '10px 21px'), a('back-person', [2], 'person-settle', '10px 21px')]),
  minimap: icon('The folded map opens slightly as one coherent sheet.', [p('map-sheet', [0], 'map-open'), a('map-folds', [1, 2], 'map-open')]),
  arena: icon('The complete crossed swords make a small, opposing parry.', [p('first-sword', [0, 1, 3, 4], 'sword-parry-first', '16px 16px'), a('second-sword', [2, 5, 6, 7], 'sword-parry-second', '8px 16px')]),
  'world-watch': icon('Only the globe meridian narrows to imply rotation; the world and equator remain fixed.', [p('world-and-equator', [0, 2]), a('meridian', [1], 'globe-turn')]),
  calendar: icon('Calendar dates are emphasized in two reading-order rows.', [p('calendar-frame', [0, 1, 2, 3]), a('first-date-row', [4, 5, 6], 'read-first'), a('second-date-row', [7, 8, 9], 'read-second')]),
  clock: icon('Clock hands turn inside a stationary face about 12,12.', [p('clock-face', [0]), a('clock-hands', [1], 'clock-turn', '12px 12px')]),
  weather: icon('The sun arc and cloud stay fixed; rays make a gentle six-degree turn while rain falls a short, bounded distance.', [p('cloud', [5]), a('sun-arc', [4]), a('sun-rays', [0, 1, 2, 3], 'sun-ray-turn'), d('rain', [6, 7], 'rain-fall', '9px 21px')]),
  'build-exporter': icon('The complete output arrow moves left while the document stays fixed.', [p('document', [0, 1]), a('output-arrow', [2, 3], 'send-left')]),
  'temper-tracker': icon('A coherent hammer makes a small strike from the grip end.', [p('hammer-handle', [0], 'hammer-strike', '5px 20px'), a('hammer-head', [1, 2], 'hammer-strike', '5px 20px')]),
  'wolf-training': icon('The complete paw shifts weight without separating the toes from the pad.', [p('paw-pad', [3], 'paw-step', '11px 20px'), a('paw-toes', [0, 1, 2], 'paw-step', '11px 20px')]),
  'data-inventory': icon('The database stays rigid while its middle record band becomes briefly prominent.', [p('database-case', [0, 1]), a('record-band', [2], 'record-read')]),
  'data-ee-log': icon('The command prompt stays fixed while its terminal cursor blinks once, then rests.', [p('log-document', [0, 1]), a('command-prompt', [2]), a('terminal-cursor', [3], 'cursor-blink')]),
  'title-tracker': icon('The trophy cup and handles catch light while the stand remains fixed.', [p('trophy-stand', [0, 1, 3]), a('trophy-cup', [2, 4, 5], 'trophy-glint')]),
  player: icon('The complete portrait gives a small greeting inside its stationary card.', [p('contact-card', [0, 2, 4]), a('portrait', [1, 3], 'portrait-greet', '12px 17px')]),
  daily: icon('Two checklist checks are emphasized in reading order without changing the list layout.', [p('daily-lines', [0, 1, 2]), a('first-check', [4], 'read-first'), a('second-check', [3], 'read-second')]),
  // Filled silhouettes carry more optical weight than two-unit outlines.
  // This local .9 fit balances the brand sack at the same requested icon size.
  market: icon('The original single-colour market sack settles under its weight; a local optical fit balances its filled silhouette.', [p('market-sack', [0, 1], 'bag-settle', '12px 22px')], .9),
};

const book = icon('The pages open slightly around a stationary book spine.', [p('book-spine', [0]), a('book-pages', [1], 'book-open', '12px 13px')]);
const close = icon('The complete close mark contracts slightly, then returns to rest.', [p('close-mark', [0, 1], 'close-settle')]);
const actions = {
  close,
  minimize: icon('The single minimize bar lowers briefly toward the window edge.', [p('minimize-bar', [0], 'minimize-drop')]),
  settings: icon('The complete gear turns about its fixed central hub.', [p('gear', [0], 'gear-turn'), a('gear-hub', [1])]),
  widgets: icon('The four layout cells settle in place without changing their spacing.', [p('layout-cells', [0, 1, 2, 3], 'grid-settle')]),
  grip: icon('The complete neutral grip lifts slightly to suggest a draggable surface.', [p('grip-dots', [0, 1, 2, 3, 4, 5], 'grip-lift')]),
  'chevron-down': icon('A single-colour chevron points gently downward, then rests.', [p('chevron', [0], 'chevron-guide')]),
  check: icon('The complete single-colour confirmation mark settles into place.', [p('confirmation', [0], 'confirm-settle')]),
  search: icon('The coherent magnifier makes a short horizontal scan.', [p('magnifier-handle', [0], 'search-scan', '11px 11px'), a('magnifier-lens', [1], 'search-scan', '11px 11px')]),
  clipboard: icon('The copy arrow moves left from a stationary clipboard.', [p('clipboard', [0, 1, 2]), a('copy-arrow', [3, 4], 'send-left')]),
  notepad: icon('The pen makes a short writing stroke inside a stationary note frame.', [p('note-frame', [0]), a('note-pen', [1], 'pencil-write', '9px 15px')]),
  'x-mark': close,
  // The (21,3) arrowhead is 12.73 units from the centre. A local .84 fit
  // keeps a full turn and its stroke inside the unchanged 24-unit viewport.
  refresh: icon('Both complete refresh arrows rotate together and pause after a full turn.', [p('refresh-arcs', [0, 2], 'refresh-turn'), a('refresh-arrowheads', [1, 3], 'refresh-turn')], .84),
  'map-pin': icon('The complete pin settles at its location with its centre remaining aligned.', [p('pin-shell', [0], 'pin-settle', '12px 22px'), a('pin-centre', [1], 'pin-settle', '12px 22px')]),
  'map-center': icon('The coherent crosshair focuses inward slightly, then rests.', [p('target-ring', [0], 'target-focus'), a('target-guides', [1, 2, 3, 4], 'target-focus')]),
  expand: icon('Four corners move a short distance in their own outward directions.', [p('north-west-corner', [0], 'expand-nw'), p('north-east-corner', [1], 'expand-ne'), p('south-west-corner', [2], 'expand-sw'), p('south-east-corner', [3], 'expand-se')]),
  info: icon('The information mark lifts slightly inside its stationary circle.', [p('information-circle', [0]), a('information-mark', [1, 2], 'info-attend')]),
  eye: icon('The eye blinks coherently, with the iris and eyelid moving together.', [p('eyelid', [0], 'eye-blink'), a('iris', [1], 'eye-blink')]),
  palette: icon('The palette stays fixed while two meaningful pigment groups catch light.', [p('palette-shell', [0]), a('cool-pigments', [1, 2], 'read-first'), d('warm-pigments', [3, 4], 'read-second')]),
  link: icon('Two complete links move slightly together, then return to rest.', [p('first-link', [0], 'link-first'), a('second-link', [1], 'link-second')]),
  folder: icon('The single folder silhouette opens slightly from its lower hinge.', [p('folder', [0], 'folder-open', '4px 20px')]),
  'book-open': book,
  market: widgets.market,
};

module.exports = { widgets, actions };
