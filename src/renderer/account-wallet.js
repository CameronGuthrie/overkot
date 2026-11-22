'use strict';
window.AccountWalletWidget = {
  mount(element, options = {}) {
    return window.InventoryWidgetUI.mount(element, { ...options, id: 'account-wallet', render(body, snapshot, { node, number, tr }) {
      if (!snapshot.available) {
        body.append(node('p', 'inventory-widget-empty', tr('walletUnavailable', 'Wallet balances are unavailable in this inventory.'))); return;
      }
      for (const row of snapshot.rows) {
        const card = node('section', `account-wallet-card account-wallet-${row.kind}`);
        const value = node('strong', 'account-wallet-value', row.value === null ? '—' : number(row.value));
        value.dataset.long = String(value.textContent.length > 7);
        card.append(node('span', 'account-wallet-label', tr('wallet' + row.key, row.name)), value);
        if (row.value === null) card.append(node('span', 'inventory-widget-muted', tr('walletNotReported', 'Not reported')));
        body.append(card);
      }
      body.append(node('p', 'inventory-widget-muted', tr('walletHint', 'Balances and remaining trades are reported by the game. Purchases, trades, and resets appear after the next inventory update.')));
    } });
  },
};
