// Keep renderer content restrictions without background anti-debug scans.
// The old synchronous process/PowerShell watchdogs stalled the main process
// and could terminate legitimate sessions when diagnostic tools were open.
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https: overkot-map-tiles: overkot-game-data:",
  "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com https://*.firebaseapp.com https://api.soulframe.com wss://*.firebaseio.com",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function createHeadersHandler(rendererRoot) {
  return (details, callback) => {
    // Apply the app policy to our HTML documents only. Remote sites own their
    // policies, and image/data responses do not need a document policy.
    let localDocument = false;
    try {
      const file = fileURLToPath(details.url);
      const relative = path.relative(rendererRoot, file);
      localDocument = ['mainFrame', 'subFrame'].includes(details.resourceType)
        && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
        && path.extname(file).toLowerCase() === '.html';
    } catch {}
    if (!localDocument) { callback({}); return; }
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] } });
  };
}

function initGuard() {
  const { app, session } = require('electron');
  const install = () => {
    session.defaultSession.webRequest.onHeadersReceived(
      createHeadersHandler(path.join(app.getAppPath(), 'src', 'renderer')));
  };
  if (app.isReady()) install();
  else app.once('ready', install);
}

module.exports = { initGuard, createHeadersHandler };
