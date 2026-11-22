'use strict';

const fs = require('node:fs');
const { parseEnv } = require('node:util');

// Read only this integration setting; do not import unrelated environment
// secrets into the app or renderer. Process environment takes precedence.
function readMarketApiKey({ env = process.env, envFile } = {}) {
  let value = env.OVERKOT_MARKET_API_KEY;
  if (value === undefined && envFile) {
    try { value = parseEnv(fs.readFileSync(envFile, 'utf8')).OVERKOT_MARKET_API_KEY; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read the local market integration configuration.');
    }
  }
  value = (value ?? '').trim();
  if (value && (value.length > 256 || !/^[\x21-\x7e]+$/.test(value))) {
    throw new Error('OVERKOT_MARKET_API_KEY must contain at most 256 printable characters without spaces.');
  }
  return value;
}

module.exports = { readMarketApiKey };
