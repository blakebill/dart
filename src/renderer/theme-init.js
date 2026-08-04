'use strict';
// Runs synchronously in <head> BEFORE the stylesheet, so the very first paint
// already uses the saved theme — no dark→light flash on a light-theme launch.
// themePref is the user choice (dark|light|system); theme is last effective.
// The authoritative value still lives in the main-process store.
(function () {
  try {
    if (new URLSearchParams(window.location.search).get('visual-test') === '1') {
      document.documentElement.dataset.visualTest = 'true';
    }
    const pref = localStorage.getItem('themePref');
    if (pref === 'system') {
      let dark = true;
      try {
        dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (_) { /* ignore */ }
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      return;
    }
    if (pref === 'light' || pref === 'dark') {
      document.documentElement.setAttribute('data-theme', pref);
      return;
    }
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
      return;
    }
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
