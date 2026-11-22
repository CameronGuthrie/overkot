// Compatibility entry point for existing release commands. Builds are now
// minified, unobfuscated, and prepared outside the working source tree.
require('./build').main().catch(error => {
  console.error('[build]', error.message);
  process.exitCode = 1;
});
