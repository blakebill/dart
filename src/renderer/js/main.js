'use strict';
// Entry point (loaded last): tab switching, the global refresh cycle, event
// streams from the main process, and startup.
(function () {
  const App = window.App;
  const { $, $$ } = App;
  const api = window.api;
  const { setLang, getLang, applyI18n } = window.i18n;

  // ---------- Language ----------
  function setLanguage(lang) {
    setLang(lang);
    applyI18n();
    const sel = $('#setLanguage');
    if (sel) sel.value = lang;
    // Re-render dynamic content that isn't covered by data-i18n.
    App.renderStatus();
    App.renderSubs();
    App.renderNodes();
    App.renderCoreStatus(App.state.status);
    if (App.renderThemeLabel) App.renderThemeLabel();
  }

  // ---------- Tab switching ----------
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.remove('active'));
      $$('.tab').forEach((tab) => tab.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('#tab-' + tab).classList.add('active');
      onTabShown(tab);
    });
  });

  // Per-tab activation: load rules on demand, start/stop connection polling.
  let connTimer = null;
  function onTabShown(tab) {
    App.currentTab = tab;
    if (connTimer) {
      clearInterval(connTimer);
      connTimer = null;
    }
    if (tab === 'rules') {
      App.loadRules();
      App.loadLocalRules();
    } else if (tab === 'ruleset') {
      App.loadRuleSets();
      App.loadCustomRuleSets();
    } else if (tab === 'conns') {
      App.loadConnections();
      connTimer = setInterval(App.loadConnections, 2000);
    } else if (tab === 'nodes') {
      App.renderNodes(); // refresh delay results that arrived while hidden
      App.refreshAutoNow();
    } else if (tab === 'logs') {
      // Land at the latest line when opening the Logs tab (lines accumulate while hidden).
      const box = $('#logBox');
      if ($('#logAutoScroll').checked) box.scrollTop = box.scrollHeight;
    } else if (tab === 'dashboard') {
      App.trafficChart.draw();
    }
  }

  // While hidden (minimized to tray), stop polling and drawing; the traffic
  // history still accumulates, so the charts catch up when shown again. We also
  // ask V8 for a collection (window.gc is exposed by the main process's
  // --expose-gc flag) so the heap promptly returns memory to the OS rather than
  // waiting for the next allocation to trip a GC, which can be many minutes
  // while the window is in the tray.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (connTimer) {
        clearInterval(connTimer);
        connTimer = null;
      }
      try { if (window.gc) window.gc(); } catch (_) { /* gc unavailable */ }
    } else {
      onTabShown(App.currentTab);
      App.trafficChart.draw();
      App.miniChart.draw();
    }
  });

  // ---------- Data refresh ----------
  let prevActiveSub;
  async function refresh() {
    App.state = await api.getState();
    // Drop stale latency results when the active profile changes.
    if (App.state.activeSub !== prevActiveSub) {
      App.delays.clear();
      prevActiveSub = App.state.activeSub;
    }
    // setLanguage re-renders everything below; only invoke it on an actual change.
    const lang = App.state.settings && App.state.settings.language;
    if (lang && lang !== getLang()) setLanguage(lang);
    App.applyTheme(App.state.settings && App.state.settings.theme);
    App.renderStatus();
    App.renderSubs();
    App.renderNodes();
    App.renderSettings();
    App.renderMode();
    App.renderUsage();
    // getState already carries the core path/version, so no extra IPC is needed.
    App.renderCoreStatus(App.state.status);
  }

  // ---------- Event streams ----------
  api.onTraffic((s) => {
    App.trafficChart.push(s.up || 0, s.down || 0);
    App.miniChart.push(s.up || 0, s.down || 0);
  });
  api.onSubsChanged(() => refresh());
  // Keep the mode buttons in sync when the mode is changed from the tray menu.
  api.onModeChanged((mode) => {
    if (App.state.settings) App.state.settings.clashMode = mode;
    App.renderMode();
  });

  api.onStatus((status) => {
    const wasRunning = App.state.status && App.state.status.running;
    App.state.status = status;
    App.renderStatus();
    // Clear the traffic graphs once the core stops.
    if (wasRunning && !status.running) {
      App.trafficChart.reset();
      App.miniChart.reset();
    }
  });

  App.refresh = refresh;
  App.setLanguage = setLanguage;

  // ---------- Startup ----------
  applyI18n();
  App.refreshPalette();
  refresh();
  App.trafficChart.draw();
  App.miniChart.draw();
  App.initVersion();
  // Silent update check at most once a day (the manual button always runs).
  try {
    const last = parseInt(localStorage.getItem('lastUpdateCheck') || '0', 10);
    if (Date.now() - last > 86400000) {
      localStorage.setItem('lastUpdateCheck', String(Date.now()));
      App.runUpdateCheck(true);
    }
  } catch (_) {
    App.runUpdateCheck(true);
  }
})();
