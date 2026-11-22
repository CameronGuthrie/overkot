# Player

**Player** combines account and equipment information into a single optional
widget. Its four tabs keep the dock compact:

- **Overview** shows your wallet, remaining trades, and equipment storage.
- **Equipment** searches owned and historically recorded weapon and Pact XP.
- **Session** compares resource and currency holdings against a resettable live
  baseline, including spending, crafting, and trades.
- **Boons** shows account boon countdowns and an optional ended-boon list.

Each tab loads when first opened, then stays mounted. Switching tabs preserves
search fields, filters, scroll positions, and session tracking. Arrow keys move
between tabs; Home and End select the first and last tab. Saved inventory and
unavailable data retain their existing labels.

The inventory calculations remain separate modules. Combining their views does
not add game requests or change inventory. Closing Player disposes all of its
listeners and countdown timers.

Run `node --test test/playerWidget.test.js` for composition, lazy loading,
keyboard navigation, retained controls, language updates, and cleanup.
