'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const languages = require('../langs/_languages.json');
const appearance = require('../src/modules/appearance');

test('all Group Finder selectors use the language registry and keep the selection after a UI language change', () => {
  const ids = ['gf-filter-lang', 'gf-profile-lang1', 'gf-profile-lang2', 'gf-create-lang-val'];
  function makeSelect(optional) {
    return { value: '', options: optional ? [{ value: '' }] : [],
      querySelector() { return this.options.find(option => !option.value); },
      replaceChildren(...options) { this.options = options; },
      appendChild(option) { this.options.push(option); } };
  }
  const selects = Object.fromEntries(ids.map((id, index) => [id, makeSelect(index === 0 || index === 2)]));
  const document = { getElementById: id => selects[id], createElement: () => ({ style: {} }), addEventListener() {} };
  const context = vm.createContext({ window: { OverkotAppearance: appearance }, document, LANGUAGES: languages });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/group-finder.js'), 'utf8'), context);
  vm.runInContext('populateLanguageOptions({ language: "uk" })', context);
  assert.deepEqual(ids.map(id => selects[id].value), ['', 'en', '', 'en']);
  ids.forEach((id, index) => { selects[id].value = ['tc', 'uk', 'th', 'zh'][index]; });
  vm.runInContext('populateLanguageOptions({ language: "th" })', context);
  for (const id of ids) {
    const choices = selects[id].options.filter(option => option.value);
    assert.deepEqual(choices.map(option => option.value), languages.map(entry => entry.code));
    assert.equal(choices.find(option => option.value === 'tc').lang, 'zh-Hant-TW');
    assert.equal(choices.find(option => option.value === 'th').textContent, 'ไทย');
  }
  assert.deepEqual(ids.map(id => selects[id].value), ['tc', 'uk', 'th', 'zh']);
});
