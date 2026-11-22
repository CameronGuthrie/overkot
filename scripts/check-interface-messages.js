'use strict';

const fs = require('node:fs');
const path = require('node:path');
const english = require('../langs/en.json');

// The submodule checks every language against English. Also catch a new UI
// binding whose key is missing even from the English fallback.
const bindings = [
  /\bdata-(?:i18n(?:-(?:title|aria(?:-label)?|label|placeholder))?|label|aria-label|placeholder)="([a-zA-Z0-9_.-]+)"/g,
  /\b(?:tr|translate|dockText|translation)\(\s*['"]([a-zA-Z][a-zA-Z0-9_.-]*)['"]\s*[,)]/g,
];
const missing = new Set();
for (const dir of ['renderer', 'modules']) {
  const directory = path.join(__dirname, '..', 'src', dir);
  for (const file of fs.readdirSync(directory).filter(name => /\.(?:js|html)$/.test(name))) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const binding of bindings) {
      for (const [, key] of source.matchAll(binding)) {
        if (!Object.hasOwn(english, key)) missing.add(file + ' uses missing message ' + key);
      }
    }
  }
}
if (missing.size) throw new Error([...missing].join('\n'));
console.log('Interface message bindings checked.');
