'use strict';

// Same-origin frame, served only from the app's market protocol. The parent
// preload supplies the limited market API; Node remains disabled in this frame.
window.api = window.parent.api;
window.i18n = window.parent.i18n;
