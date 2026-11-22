/* Retry mounted artwork when its data source becomes available again. */
(function () {
  'use strict';
  function bind(document, api) {
    const pending = new WeakMap();
    function retry(image) {
      // A failed lazy image can be hidden behind a fallback. Hidden elements
      // never intersect the viewport, so explicitly start its replacement load.
      if (image.hidden) image.loading = 'eager';
      image.src = image.src;
    }
    function retryGroup(prefix) {
      for (const image of document.querySelectorAll(`img[src^="${prefix}"]`)) {
        if (!image.complete) pending.set(image, image.src);
        else if (!image.naturalWidth) {
          pending.delete(image);
          retry(image);
        }
      }
    }
    function loaded(event) { pending.delete(event.target); }
    function failed(event) {
      const image = event.target;
      const source = pending.get(image);
      if (!source) return;
      pending.delete(image);
      // The previous request can report its signed-out error after sign-in.
      // Let its fallback render, then retry that request once if still mounted.
      queueMicrotask(() => {
        if (image.isConnected && image.src === source && image.complete && !image.naturalWidth) retry(image);
      });
    }
    document.addEventListener('load', loaded, true);
    document.addEventListener('error', failed, true);
    const stopArtwork = api?.onGameArtworkAvailable?.(() => retryGroup('overkot-game-data://images/'));
    const stopTempers = api?.onMapTilesUpdated?.(info => {
      if (info?.requiresSignIn !== true) retryGroup('overkot-map-tiles://data/temper-icons/');
    });
    return () => {
      stopArtwork?.();
      stopTempers?.();
      document.removeEventListener('load', loaded, true);
      document.removeEventListener('error', failed, true);
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { bind };
  else window.addEventListener('pagehide', bind(document, window.api), { once: true });
})();
