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

  $('#diagnosticBundleExport').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = window.i18n.t('toolbox.bundleCollecting');
    try {
      const file = await call(api.exportDiagnosticBundle);
      if (file) App.toast(window.i18n.t('toolbox.bundleExported', file));
    } catch (_) {
      /* call() already displayed the failure */
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = previous;
      }
    }
  });

  document.querySelectorAll('#tab-tools .tool-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const launcher = card.querySelector('button');
      if (launcher && !launcher.disabled) launcher.click();
    });
  });
  App.registerRendererModule('tools');
})();
