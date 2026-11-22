'use strict';

const FIELDS = [
  { key: 'RegularCredits', name: 'Dracs', kind: 'currency' },
  { key: 'PremiumCredits', name: 'Arcs', kind: 'currency' },
  { key: 'TradesRemaining', name: 'Trades remaining', kind: 'allowance' },
];
function createAccountWalletModel() {
  return { read(inventory) {
    const rows = FIELDS.map(field => ({ ...field,
      value: Number.isSafeInteger(inventory?.[field.key]) && inventory[field.key] >= 0 ? inventory[field.key] : null }));
    return { rows, available: rows.filter(row => row.value !== null).length };
  } };
}
module.exports = { createAccountWalletModel };
