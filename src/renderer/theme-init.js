'use strict';
// Runs synchronously in <head> BEFORE the stylesheet, so the very first paint
// already uses the saved theme — no dark→light flash on a light-theme launch.
// The theme is mirrored to localStorage by the renderer whenever it changes;
// the authoritative value still lives in the main-process store.
(function () {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* localStorage unavailable: fall back to the CSS default (dark) */
  }
})();
