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
    if (App.refreshSelects) App.refreshSelects();
    const sel = $('#setLanguage');
    if (sel) sel.value = lang;
    // Re-render dynamic content that isn't covered by data-i18n.
    App.renderStatus();
    App.renderSubs();
    App.renderNodes();
    App.renderSettings();
    App.renderMode();
    App.renderUsage();
    App.renderCoreStatus(App.state.status);
    if (App.refreshToolsLanguage) App.refreshToolsLanguage();
    if (App.currentTab === 'rules') {
      App.loadRules({ force: false });
      App.loadLocalRules({ force: true });
      App.loadRuleGroups({ force: true });
      App.loadCustomRuleSets({ force: true });
    }
    syncTopbarTitle();
    if (App.renderThemeLabel) App.renderThemeLabel();
  }

  // ---------- Tab switching ----------
  function syncTopbarTitle(button) {
    const active = button || document.querySelector('.nav-item.active');
    const title = $('#topbarTitle');
    if (active && title) title.textContent = active.textContent.trim();
  }

  function showTab(tab) {
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (!btn) return;
    if (!btn.classList.contains('active')) {
      $$('.nav-item').forEach((b) => b.classList.remove('active'));
      $$('.tab').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      syncTopbarTitle(btn);
      const panel = $('#tab-' + tab);
      if (panel) panel.classList.add('active');
    }
    onTabShown(tab);
  }
  App.showTab = showTab;

  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Per-tab activation: load rules on demand, start/stop connection polling.
  let connTimer = null;
  function afterPaint(fn, delay = 0) {
    const run = () => {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
      else fn();
    };
    if (delay) setTimeout(run, delay);
    else run();
  }

  function showRulesTab() {
    afterPaint(() => {
      (App.ensureLocalRulesLoaded || App.loadLocalRules)();
      afterPaint(() => (App.ensureCustomRuleSetsLoaded || App.loadCustomRuleSets)(), 40);
      afterPaint(() => (App.ensureRuleGroupsLoaded || App.loadRuleGroups)(), 80);
      afterPaint(() => (App.ensureRulesLoaded || App.loadRules)(), 120);
    });
  }

  function onTabShown(tab) {
    const previousTab = App.currentTab;
    App.currentTab = tab;
    if (previousTab === 'conns' && tab !== 'conns') App.clearConnections();
    if (connTimer) {
      clearInterval(connTimer);
      connTimer = null;
    }
    if (tab === 'rules') {
      showRulesTab();
    } else if (tab === 'conns') {
      App.loadConnections();
      connTimer = setInterval(App.loadConnections, 2000);
    } else if (tab === 'nodes') {
      App.renderNodes(); // refresh delay results that arrived while hidden
      App.refreshGroupSelections();
    } else if (tab === 'logs') {
      App.flushLogs();
      // Land at the latest line when opening the Logs tab (lines accumulate while hidden).
      const box = $('#logBox');
      if ($('#logAutoScroll').checked) box.scrollTop = box.scrollHeight;
    } else if (tab === 'dashboard') {
      App.trafficChart.draw();
    }
  }

  // While hidden (minimized to tray), stop polling and drawing. The main
  // process keeps the tray tooltip live without waking the renderer each second.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (connTimer) {
        clearInterval(connTimer);
        connTimer = null;
      }
      if (App.currentTab === 'conns') App.clearConnections();
    } else {
      onTabShown(App.currentTab);
      App.trafficChart.draw();
      App.miniChart.draw();
    }
  });

  // ---------- Data refresh ----------
  let prevActiveSub;
  let refreshSequence = 0;
  async function refresh() {
    const sequence = ++refreshSequence;
    const nextState = await api.getState();
    if (sequence !== refreshSequence) return;
    App.state = nextState;
    // Drop stale latency results when the active profile changes.
    if (App.state.activeSub !== prevActiveSub) {
      App.delays.clear();
      prevActiveSub = App.state.activeSub;
      if (App.invalidateRuleCaches) App.invalidateRuleCaches();
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
    App.refreshGroupSelections();
  }

  // ---------- Event streams ----------
  if (api && api.onTraffic) api.onTraffic((s) => {
    App.trafficChart.push(s.up || 0, s.down || 0);
    App.miniChart.push(s.up || 0, s.down || 0);
  });
  if (api && api.onSubsChanged) api.onSubsChanged(() => {
    if (App.invalidateRuleCaches) App.invalidateRuleCaches();
    refresh();
  });
  // Keep the mode buttons in sync when the mode is changed from the tray menu.
  if (api && api.onModeChanged) api.onModeChanged((mode) => {
    if (App.state.settings) App.state.settings.clashMode = mode;
    App.renderMode();
  });

  if (api && api.onStatus) api.onStatus((status) => {
    const previous = App.state.status || {};
    const wasRunning = previous.running;
    const coreChanged = !!(
      previous.coreType && status.coreType && previous.coreType !== status.coreType
    );
    // Status broadcasts are intentionally compact. Preserve the full path and
    // version loaded by app:getState instead of replacing them with undefined.
    App.state.status = coreChanged
      ? { ...previous, ...status, corePath: undefined, coreVersion: undefined }
      : { ...previous, ...status };
    App.renderStatus();
    App.renderCoreStatus(App.state.status);
    App.refreshGroupSelections();
    if (App.state.status.coreInstalled && App.state.status.coreVersion === undefined && App.refreshCoreStatus) {
      App.refreshCoreStatus().catch(() => {});
    }
    if (wasRunning !== status.running && App.invalidateRuleCaches) App.invalidateRuleCaches();
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
  if (!api) {
    if (App.renderThemeLabel) App.renderThemeLabel();
    App.trafficChart.draw();
    App.miniChart.draw();
    return;
  }
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
