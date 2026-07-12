'use strict';
// Custom controls for the frameless desktop window. Privileged window access
// stays in the main process; this module only forwards deliberate button taps.
(function () {
  const api = window.api;
  const minimize = document.querySelector('#windowMinimize');
  const maximize = document.querySelector('#windowMaximize');
  const close = document.querySelector('#windowClose');

  function setMaximized(maximized) {
    if (maximize) maximize.classList.toggle('is-maximized', !!maximized);
  }

  if (!api || !minimize || !maximize || !close) return;
  minimize.addEventListener('click', () => api.minimizeWindow().catch(() => {}));
  maximize.addEventListener('click', async () => {
    try { setMaximized(await api.toggleMaximizeWindow()); } catch (_) {}
  });
  close.addEventListener('click', () => api.closeWindow().catch(() => {}));
  api.isWindowMaximized().then(setMaximized).catch(() => {});
  if (api.onWindowMaximized) api.onWindowMaximized(setMaximized);
})();
