const fs = require('node:fs');
const path = require('node:path');

function toMacLocale(language) {
  return language === 'en-US' ? 'en' : language.replaceAll('-', '_');
}

function verifyRuntimeLocales(appOutDir, languages = [], options = {}) {
  // App UI codes ("en") are not Electron .pak filenames ("en-US").
  const mac = options.platform === 'darwin';
  const required = [...new Set(['en-US', 'en-GB', ...languages].map(language => mac ? toMacLocale(language) : language))];
  const frameworkResources = options.frameworkResources || path.join(appOutDir, `${options.productName || 'Overkot'}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources');
  const missing = required.filter(language => {
    // The app's .lproj directories can be empty localization markers. Verify
    // the actual Chromium strings in the framework, not those markers.
    const file = mac
      ? path.join(frameworkResources, `${language}.lproj`, 'locale.pak')
      : path.join(appOutDir, 'locales', `${language}.pak`);
    try {
      const stat = fs.statSync(file);
      return !stat.isFile() || stat.size === 0;
    }
    catch { return true; }
  });
  if (missing.length) throw new Error(`Packaged Electron locale files missing or empty: ${missing.join(', ')}. Check build.electronLanguages.`);
  return required;
}

module.exports = ({ appOutDir, packager }) => {
  const languages = packager.platformSpecificBuildOptions.electronLanguages || packager.config.electronLanguages || [];
  const platform = packager.platform.nodeName;
  const verified = verifyRuntimeLocales(appOutDir, languages, {
    platform,
    ...(platform === 'darwin' ? { frameworkResources: packager.getMacOsElectronFrameworkResourcesDir(appOutDir) } : {}),
  });
  console.log(`[build] Verified ${verified.length} packaged Electron locales, including English fallback`);
};
module.exports.verifyRuntimeLocales = verifyRuntimeLocales;
module.exports.toMacLocale = toMacLocale;
