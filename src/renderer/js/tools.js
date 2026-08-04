'use strict';
// Tools page launchers. Secondary interfaces live in an on-demand native
// BrowserWindow so Windows can draw their transient system backdrop.
(function () {
  const App = window.App;
  const { $, call } = App;
  const api = window.api;

  $('#openPanelBtn').addEventListener('click', async () => {
    try {
      await call(api.openClashApi);
    } catch (_) {}
  });

  $('#uwpOpen').addEventListener('click', () => App.openDialog('uwp'));

  document.querySelectorAll('#tab-tools .tool-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const launcher = card.querySelector('button');
      if (launcher && !launcher.disabled) launcher.click();
    });
  });
})();
