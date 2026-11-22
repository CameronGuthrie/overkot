'use strict';
window.StorageCapacityWidget = {
  mount(element, options = {}) {
    return window.InventoryWidgetUI.mount(element, { ...options, id: 'storage-capacity', render(body, data, { node, number, tr }) {
      if (data.free === null) {
        body.append(node('p', 'inventory-widget-empty', tr('storageUnavailable', 'Equipment storage is unavailable in this inventory.'))); return;
      }
      const summary = node('div', 'storage-capacity-summary');
      summary.append(node('strong', '', data.overCapacity ? tr('storageOverCapacity', '{count} over capacity', { count: number(-data.free) }) : tr('storageFreeSlots', '{count} free slots', { count: number(data.free) })),
        node('span', 'inventory-widget-muted', data.total !== null ? tr('storageOccupied', '{used} / {total} occupied', { used: number(data.used), total: number(data.total) }) : tr('storageTotalUnavailable', 'Total capacity unavailable')));
      body.append(summary);
      if (data.percent !== null) {
        const bar = node('div', 'storage-capacity-bar');
        bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', tr('storageOccupiedLabel', 'Equipment storage occupied'));
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(data.percent)));
        const fill = node('div', 'storage-capacity-fill'); fill.style.width = `${data.percent}%`; bar.append(fill); body.append(bar);
      }
      for (const item of data.rows) {
        const row = node('div', 'storage-capacity-row');
        row.append(node('span', '', tr('storage' + item.key, item.name)), node('strong', '', item.count === null ? '—' : number(item.count))); body.append(row);
      }
      if (data.state === 'partial') body.append(node('p', 'inventory-widget-muted', tr('storagePartial', 'Some equipment records are unavailable. Free slots are reported by the game; the total is withheld until all categories can be counted.')));
      body.append(node('p', 'inventory-widget-muted', tr('storageHint', 'Items marked exempt by the game do not use a slot.')));
    } });
  },
};
