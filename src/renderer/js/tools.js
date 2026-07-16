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

  $('#convertOpen').addEventListener('click', () => App.openDialog('convert'));
  $('#uwpOpen').addEventListener('click', () => App.openDialog('uwp'));
})();
