'use strict';
// Diagnostic tool launchers. Rendering and tool-local state are released with
// the native dialog window when it closes.
(function () {
  const App = window.App;
  const launchers = [
    ['#routeOpen', 'route'],
    ['#diagOpen', 'diagnostics'],
    ['#configCheckOpen', 'config-check'],
    ['#portOpen', 'ports'],
    ['#backupOpen', 'backup'],
    ['#dnsOpen', 'dns'],
  ];
  for (const [selector, type] of launchers) {
    document.querySelector(selector).addEventListener('click', () => App.openDialog(type));
  }
  App.registerRendererModule('toolbox');
})();
