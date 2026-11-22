'use strict';

const fs = require('node:fs');
const path = require('node:path');

function configureWikiTestProfile(directory, live = false) {
  const wikiWebsite = live ? 'https://wiki.avakot.org' : 'https://wiki.example.test';
  const filename = path.join(directory, 'wiki-services.json');
  fs.writeFileSync(filename, JSON.stringify({ wikiWebsite }));
  process.env.OVERKOT_SERVICES_FILE = filename;
  return wikiWebsite;
}

module.exports = { configureWikiTestProfile };
