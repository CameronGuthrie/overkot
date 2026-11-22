'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function isAvakotAccountSettingsFrame(event, rendererRoot) {
  try {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed?.()) return false;
    return path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html';
  } catch { return false; }
}

// Keep this allowlist explicit: credentials never belong in a renderer snapshot.
function publicAvakotAccountState(state = {}) {
  const string = value => typeof value === 'string' ? value : '';
  return {
    signedIn: state.signedIn === true,
    hasCredential: state.hasCredential === true,
    busy: state.busy === true,
    authorizing: state.authorizing === true,
    account: state.account ? { email: string(state.account.email), displayName: string(state.account.displayName) } : null,
    game: { online: state.game?.online === true, accountId: string(state.game?.accountId), displayName: string(state.game?.displayName) },
    sessionPersistent: state.sessionPersistent === true,
    marketSignIn: state.marketSignIn === true,
    error: string(state.error),
  };
}

function registerAvakotAccountIpc({ ipcMain, account, rendererRoot }) {
  const handlers = {
    state: () => account.snapshot(), login: () => account.signIn(), cancel: () => account.cancelSignIn(),
    logout: () => account.signOut(), open: () => account.openAccount(), reconnect: () => account.reconnect(),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    ipcMain.handle(`avakot-account:${action}`, async event => {
      if (!isAvakotAccountSettingsFrame(event, rendererRoot)) {
        return { ok: false, message: 'Open Settings to manage your avakot.dev account.' };
      }
      try {
        const result = await handler();
        if (action === 'state') return publicAvakotAccountState(result);
        return {
          ok: result?.ok !== false,
          state: publicAvakotAccountState(result?.state || account.snapshot()),
          ...(typeof result?.message === 'string' ? { message: result.message } : {}),
        };
      } catch {
        // Exception details can contain request credentials or local storage paths.
        return { ok: false, message: 'Could not update your avakot.dev account. Please try again.' };
      }
    });
  }
}

module.exports = { registerAvakotAccountIpc, isAvakotAccountSettingsFrame, publicAvakotAccountState };
