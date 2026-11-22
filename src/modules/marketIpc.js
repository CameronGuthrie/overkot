const path = require('node:path');
const { fileURLToPath } = require('node:url');

function marketWindowBounds(saved, screen) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]));
  const area = valid ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(area.width, Math.max(620, valid ? saved.width : 960));
  const height = Math.min(area.height, Math.max(460, valid ? saved.height : 720));
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(valid ? saved.x : area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(valid ? saved.y : area.y + (area.height - height) / 2, area.y + area.height - height))) };
}

function isMarketFrame(event, rendererRoot, pageOnly = false) {
  try {
    const file = fileURLToPath(event.senderFrame.url);
    const relative = path.relative(rendererRoot, file);
    return (pageOnly ? ['market.html'] : ['market.html', 'widget-host.html', 'index.html']).includes(relative);
  } catch { return false; }
}

function registerMarketIpc({ ipcMain, market, rendererRoot, openWindow, retryConnection = () => ({ ok: false }) }) {
  const isSettings = event => {
    try { return path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html'; } catch { return false; }
  };
  ipcMain.on('market:open', event => { if (isMarketFrame(event, rendererRoot) || isSettings(event)) openWindow(); });
  const handlers = {
    state: () => market.snapshot(), refresh: () => market.refresh(), login: value => market.login(value),
    'avakot-login': value => market.loginWithAvakot(value), 'avakot-cancel': () => market.cancelAvakotLogin(),
    logout: () => market.sharedAccount ? { ok: false, error: 'ACCOUNT_CONNECTION_REQUIRED' } : market.logout(),
    'connection-retry': () => retryConnection(), browse: value => market.browse(value), create: value => market.createListing(value),
    update: value => market.updateListing(value), 'copy-contact': value => market.copyContact(value), website: value => market.openWebsite(value),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    ipcMain.handle(`market:${action}`, (event, value) => {
      if (!isMarketFrame(event, rendererRoot, !['state', 'website'].includes(action))
        && !(isSettings(event) && ['state', 'logout', 'connection-retry'].includes(action))) {
        return { ok: false, error: 'FORBIDDEN', message: 'Open the Market window to use this action.' };
      }
      return handler(value);
    });
  }
}

module.exports = { registerMarketIpc, isMarketFrame, marketWindowBounds };
