// Read-only. Run from the private repository with the globally installed Firebase CLI.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

async function main() {
  const [cliDirectory, output] = process.argv.slice(2);
  if (!cliDirectory || !output) throw new Error('Expected Firebase CLI package directory and private output directory');
  const cli = createRequire(path.resolve(cliDirectory, 'package.json'));
  const project = 'soulframe-overlay-group-finder';
  await fs.mkdir(output, { recursive: true });
  const databasePath = path.join(output, 'database.rules.json');
  const databaseGet = cli('./lib/commands/database-get').command.runner();
  await databaseGet('/.settings/rules', { project, output: databasePath, pretty: true, nonInteractive: true });
  const api = cli('./lib/gcp/rules');
  const names = new Set(['projects/' + project + '/releases/cloud.firestore',
    'projects/' + project + '/releases/cloud.firestore/(default)']);
  const matches = (await api.listAllReleases(project)).filter(release => names.has(release.name));
  if (matches.length !== 1) throw new Error('Could not identify exactly one default Firestore release');
  const files = await api.getRulesetContent(matches[0].rulesetName);
  if (files.length !== 1 || typeof files[0].content !== 'string') throw new Error('Unexpected Firestore source format');
  await fs.writeFile(path.join(output, 'firestore.rules'), files[0].content);
  const normalize = value => value.replace(/\r\n/g, '\n').trim();
  const digest = data => createHash('sha256').update(data).digest('hex');
  console.log('Firestore release: ' + matches[0].rulesetName);
  console.log('Firestore source SHA-256: ' + digest(normalize(files[0].content)));
  console.log('RTDB normalized JSON SHA-256: ' + digest(JSON.stringify(JSON.parse(await fs.readFile(databasePath, 'utf8')))));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
