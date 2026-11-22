'use strict';

/** One player panel composes the inventory modules without recreating their controls. */
window.PlayerWidget = {
  mount(element, { api = window.api, language = 'en', onResize = () => {}, initialTab = 'overview' } = {}) {
    const definitions = [
      { id: 'overview', key: 'playerOverview', label: 'Overview' },
      { id: 'equipment', key: 'playerEquipment', label: 'Equipment' },
      { id: 'session', key: 'playerSession', label: 'Session' },
      { id: 'boons', key: 'playerBoons', label: 'Boons' },
    ];
    const nodes = new Map(), children = new Map();
    let active = definitions.some(tab => tab.id === initialTab) ? initialTab : 'overview';
    let destroyed = false, locale = language || 'en';
    const identity = `player-${crypto.randomUUID()}`;
    const node = (tag, className, text) => {
      const result = document.createElement(tag); result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    };
    const root = node('section', 'player-widget');
    const tabs = node('div', 'player-tabs'); tabs.setAttribute('role', 'tablist');
    const stage = node('div', 'player-stage');
    root.append(tabs, stage); element.replaceChildren(root);

    function translations() {
      const all = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
      return { ...all.en, ...all[locale] };
    }
    function resize(id) { if (!destroyed && active === id) onResize(); }
    function mountChild(tab, section, widget, className) {
      const content = node('div', className); section.append(content);
      const handle = widget.mount(content, { api, language: locale, onResize: () => resize(tab) });
      children.get(tab).push(handle);
    }
    function ensureMounted(id) {
      if (children.has(id)) return;
      const { panel } = nodes.get(id);
      children.set(id, []);
      if (id === 'overview') {
        const scroll = node('div', 'player-overview'); panel.append(scroll);
        for (const [key, label, widget, className] of [
          ['wallet', 'Wallet', window.AccountWalletWidget, 'account-wallet-content'],
          ['storage', 'Equipment storage', window.StorageCapacityWidget, 'storage-capacity-content'],
        ]) {
          const section = node('section', `player-overview-section player-${key}`);
          const heading = node('h3', 'player-section-heading', label);
          heading.dataset.playerHeading = key; section.append(heading); scroll.append(section);
          mountChild(id, section, widget, className);
        }
      } else {
        const component = {
          equipment: [window.EquipmentProgressWidget, 'equipment-progress-content'],
          session: [window.SessionGainsWidget, 'session-gains-content'],
          boons: [window.ActiveBoonsWidget, 'active-boons-content'],
        }[id];
        mountChild(id, panel, ...component);
      }
    }
    function select(id, focus = false) {
      if (destroyed || !nodes.has(id)) return;
      active = id;
      for (const [key, { tab, panel }] of nodes) {
        const selected = key === active;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
      }
      root.dataset.tab = id;
      ensureMounted(id);
      labelControls();
      if (focus) nodes.get(id).tab.focus();
      resize(id);
    }
    function labelControls() {
      const t = translations();
      tabs.setAttribute('aria-label', t.playerNavigation || 'Player information');
      for (const definition of definitions) nodes.get(definition.id).tab.textContent = t[definition.key] || definition.label;
      const headings = nodes.get('overview').panel.querySelectorAll('[data-player-heading]');
      for (const heading of headings) heading.textContent = heading.dataset.playerHeading === 'wallet'
        ? t.playerWallet || 'Wallet' : t.playerStorage || 'Equipment storage';
    }
    for (const definition of definitions) {
      const tab = node('button', 'player-tab', definition.label); tab.type = 'button';
      tab.id = `${identity}-${definition.id}-tab`; tab.setAttribute('role', 'tab');
      const panel = node('div', `player-panel player-panel-${definition.id}`);
      panel.id = `${identity}-${definition.id}-panel`; panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
      tab.setAttribute('aria-controls', panel.id);
      tab.addEventListener('click', () => select(definition.id));
      tab.addEventListener('keydown', event => {
        const index = definitions.indexOf(definition);
        const next = event.key === 'ArrowRight' ? definitions[(index + 1) % definitions.length]
          : event.key === 'ArrowLeft' ? definitions[(index + definitions.length - 1) % definitions.length]
            : event.key === 'Home' ? definitions[0] : event.key === 'End' ? definitions.at(-1) : null;
        if (!next) return;
        event.preventDefault(); select(next.id, true);
      });
      nodes.set(definition.id, { tab, panel }); tabs.append(tab); stage.append(panel);
    }
    select(active);
    return {
      setLanguage(value) {
        if (destroyed) return;
        locale = value || 'en';
        for (const handles of children.values()) for (const child of handles) child.setLanguage(locale);
        labelControls(); resize(active);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const handles of children.values()) for (const child of handles) child.destroy();
        children.clear();
      },
    };
  },
};
