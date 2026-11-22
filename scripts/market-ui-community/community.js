'use strict';
window.overkotMarket.getState().then(state => {
  if (state?.websiteAvailable) {
    document.getElementById('status').textContent = 'Browse and trade on the Market website.';
    document.getElementById('website').hidden = false;
  }
});
document.getElementById('website').addEventListener('click', () => window.overkotMarket.openWebsite());
document.getElementById('close').addEventListener('click', () => window.overkotMarket.close());
