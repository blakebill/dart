'use strict';
// Entry point (loaded last): tab switching, the global refresh cycle, event
// streams from the main process, and startup.
(function () {
  const App = window.App;
  const { $, $$ } = App;
  const api = window.api;
  const { setLang, getLang, applyI18n } = window.i18n;

  const TAB_MODULES = Object.freeze({
    subs: ['js/subs.js'],
    nodes: ['js/nodes.js'],
    rules: ['js/rules.js', 'js/rulesets.js'],
    conns: ['js/conns.js'],
    logs: ['js/logs.js'],
    settings: ['js/settings.js'],
    tools: ['js/tools.js', 'js/toolbox.js'],
  });
  const loadedTabs = new Set(['dashboard']);
  let localSettingsRevision = 0;

  App.commitSettings = function commitSettings(settings) {
    localSettingsRevision++;
    const clean = { ...(settings || {}) };
    // Ephemeral field from settings:update when theme changes — not a store key.
    delete clean.themeEffective;
    App.state.settings = clean;
    return App.state.settings;
  };
  App.patchSettings = function patchSettings(patch) {
    return App.commitSettings({ ...(App.state.settings || {}), ...(patch || {}) });
  };

  async function ensureTabModules(tab) {
    if (loadedTabs.has(tab) || !TAB_MODULES[tab]) return;
    await App.loadScripts(TAB_MODULES[tab]);
    loadedTabs.add(tab);
  }
  App.ensureTabModules = ensureTabModules;

  // ---------- Language ----------
  function setLanguage(lang) {
    setLang(lang);
    // Keep the renderer state ahead of the async settings write. Otherwise
    // renderSettings() briefly reads the previous language and resets the
    // enhanced select label even though the rest of the UI has translated.
    if (App.state && App.state.settings) App.state.settings.language = lang;
    applyI18n();
    // Re-render dynamic content that isn't covered by data-i18n.
    App.renderStatus();
    if (App.renderSubs) App.renderSubs();
    if (App.renderNodes) App.renderNodes();
    if (App.renderSettings) App.renderSettings();
    // Policy-group controls are generated dynamically and may remain mounted
    // while another tab is active, so data-i18n cannot update their options.
    if (App.refreshRuleGroupLabels) App.refreshRuleGroupLabels();
    App.renderMode();
    App.renderUsage();
    if (App.renderCoreStatus) App.renderCoreStatus(App.state.status);
    if (App.currentTab === 'rules' && App.loadRules) {
      App.loadRules({ force: false });
      App.loadLocalRules({ force: true });
      App.loadRuleGroups({ force: true });
      App.loadCustomRuleSets({ force: true });
    }
    syncTopbarTitle();
    if (App.renderThemeLabel) App.renderThemeLabel();
    const sel = $('#setLanguage');
    if (sel) sel.value = lang;
    // Refresh after every dynamic render so labels mirror the final option
    // text and selected value, including controls rebuilt during translation.
    if (App.refreshSelects) App.refreshSelects();
  }

  // ---------- Tab switching ----------
  const nav = document.querySelector('.nav');
  const navIndicator = $('#navIndicator');
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  let navIndicatorFrame = 0;
  let navIndicatorAnimation = null;
  let navIndicatorY = 0;

  function currentNavIndicatorY() {
    const playState = navIndicatorAnimation && navIndicatorAnimation.playState;
    if (playState !== 'running' && playState !== 'pending') return navIndicatorY;
    try {
      const indicatorRect = navIndicator.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      return indicatorRect.top - navRect.top + (indicatorRect.height - navIndicator.offsetHeight) / 2;
    } catch (_) {
      return navIndicatorY;
    }
  }

  function cancelNavIndicatorAnimation() {
    if (navIndicatorAnimation && navIndicatorAnimation.playState !== 'idle') {
      navIndicatorAnimation.cancel();
    }
    if (navIndicator) navIndicator.style.transformOrigin = '50% 50%';
  }

  function moveNavIndicator(targetY, immediate) {
    const fromY = currentNavIndicatorY();
    cancelNavIndicatorAnimation();

    const delta = targetY - fromY;
    navIndicatorY = targetY;
    navIndicator.style.transform = `translateY(${targetY}px) scaleY(1)`;
    const canAnimate = nav.classList.contains('indicator-ready') &&
      !immediate && !(reducedMotion && reducedMotion.matches) && Math.abs(delta) >= 1;
    if (!canAnimate) {
      navIndicator.style.transformOrigin = '50% 50%';
      if (!nav.classList.contains('indicator-ready')) {
        requestAnimationFrame(() => nav.classList.add('indicator-ready'));
      }
      return;
    }

    const distance = Math.abs(delta);
    const stretch = Math.min(2.35, 1.25 + distance / 90);
    const middleY = fromY + delta * 0.35;
    navIndicator.style.transformOrigin = delta > 0 ? '50% 0%' : '50% 100%';
    const keyframes = [
      { transform: `translateY(${fromY}px) scaleY(1)`, offset: 0 },
      { transform: `translateY(${middleY}px) scaleY(${stretch})`, offset: 0.42 },
      { transform: `translateY(${targetY}px) scaleY(1)`, offset: 1 },
    ];
    const timing = {
      duration: Math.min(320, 220 + distance * 0.35),
      easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    };
    // Reuse one WAAPI object and cancel it while idle so no finished effects accumulate.
    if (!navIndicatorAnimation) {
      navIndicatorAnimation = navIndicator.animate(keyframes, timing);
      navIndicatorAnimation.onfinish = cancelNavIndicatorAnimation;
    } else {
      navIndicatorAnimation.effect.setKeyframes(keyframes);
      navIndicatorAnimation.effect.updateTiming(timing);
      navIndicatorAnimation.play();
    }
  }

  function syncNavIndicator(button, immediate = false) {
    if (!nav || !navIndicator || !button) return;
    if (navIndicatorFrame) cancelAnimationFrame(navIndicatorFrame);
    const update = () => {
      navIndicatorFrame = 0;
      const y = button.offsetTop + (button.offsetHeight - navIndicator.offsetHeight) / 2;
      moveNavIndicator(Math.round(y), immediate);
    };
    if (immediate) update();
    else navIndicatorFrame = requestAnimationFrame(update);
  }

  /** Page title in the topbar: plain label only (no nav emoji). */
  function pageTitleFromNav(button) {
    const raw = (button && button.textContent || '').trim();
    // Drop leading pictographs / emoji presentation selectors used on nav items.
    return raw
      .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
      .replace(/\s+/g, ' ')
      .trim() || raw;
  }

  function syncTopbarTitle(button) {
    const active = button || document.querySelector('.nav-item.active');
    const title = $('#topbarTitle');
    if (active && title) title.textContent = pageTitleFromNav(active);
  }

  function showTab(tab) {
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    const panel = $('#tab-' + tab);
    if (!btn || !panel) return;
    const previousPanel = document.querySelector('.tab.active');
    const shouldMoveFocus = previousPanel && previousPanel !== panel && previousPanel.contains(document.activeElement);
    $$('.nav-item').forEach((button) => {
      const active = button === btn;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('.tab').forEach((element) => {
      const active = element === panel;
      element.classList.toggle('active', active);
      element.hidden = !active;
    });
    syncTopbarTitle(btn);
    syncNavIndicator(btn);
    if (shouldMoveFocus) requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    onTabShown(tab).catch((error) => App.toast(error.message || String(error), true));
  }
  App.showTab = showTab;

  const navButtons = $$('.nav-item');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  nav.addEventListener('keydown', (event) => {
    const current = event.target.closest('.nav-item');
    if (!current) return;
    const index = navButtons.indexOf(current);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % navButtons.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + navButtons.length) % navButtons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = navButtons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    navButtons[next].focus();
    showTab(navButtons[next].dataset.tab);
  });
  syncNavIndicator(document.querySelector('.nav-item.active'), true);
  window.addEventListener('resize', () => {
    syncNavIndicator(document.querySelector('.nav-item.active'), true);
  });

  // Per-tab activation: load rules on demand, start/stop connection polling.
  let connTimer = null;
  function connectionPollDelay(data) {
    const shown = data && Array.isArray(data.connections) ? data.connections.length : 0;
    return data && data.totalConnections > shown ? 5000 : 3000;
  }
  function scheduleConnectionPoll(delay = 3000) {
    if (connTimer) clearTimeout(connTimer);
    connTimer = setTimeout(async () => {
      connTimer = null;
      if (document.hidden || App.currentTab !== 'conns') return;
      const data = await App.loadConnections();
      if (document.hidden || App.currentTab !== 'conns') return;
      scheduleConnectionPoll(connectionPollDelay(data));
    }, delay);
  }
  function afterPaint(fn, delay = 0) {
    const run = () => {
      if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
      else fn();
    };
    if (delay) setTimeout(run, delay);
    else run();
  }

  function showRulesTab() {
    const tasks = [
      ['ensureLocalRulesLoaded', 'loadLocalRules', 0],
      ['ensureCustomRuleSetsLoaded', 'loadCustomRuleSets', 40],
      ['ensureRuleGroupsLoaded', 'loadRuleGroups', 80],
      ['ensureRulesLoaded', 'loadRules', 120],
    ];
    for (const [preferred, fallback, delay] of tasks) {
      afterPaint(() => {
        if (!document.hidden && App.currentTab === 'rules') (App[preferred] || App[fallback])();
      }, delay);
    }
  }

  let tabActivationSequence = 0;
  async function onTabShown(tab) {
    const sequence = ++tabActivationSequence;
    const previousTab = App.currentTab;
    App.currentTab = tab;
    if (previousTab === 'logs' && tab !== 'logs' && App.setLogStreaming) {
      App.setLogStreaming(false);
    }
    if (previousTab === 'conns' && tab !== 'conns' && App.clearConnections) App.clearConnections();
    // Keep the small session-only latency cache and let an explicit sweep finish
    // while releasing the heavier node list whenever the user changes pages.
    if (previousTab === 'nodes' && tab !== 'nodes' && App.releaseNodes) {
      App.releaseNodes({ cancelTests: false });
    }
    if (connTimer) {
      clearTimeout(connTimer);
      connTimer = null;
    }
    await ensureTabModules(tab);
    if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== tab) return;
    if (tab === 'rules') {
      showRulesTab();
    } else if (tab === 'conns') {
      // Defer Clash API + list paint so the tab switch stays responsive.
      afterPaint(() => {
        if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== 'conns') return;
        App.loadConnections().then((data) => {
          if (!document.hidden && App.currentTab === 'conns') {
            scheduleConnectionPoll(connectionPollDelay(data));
          }
        });
      });
    } else if (tab === 'nodes') {
      App.loadNodes();
      App.refreshGroupSelections();
    } else if (tab === 'logs') {
      // Main retains a bounded history, so stream chatty core output only while
      // it can actually be consumed. Re-entry snapshots the missed sequence.
      if (App.setLogStreaming) App.setLogStreaming(true);
      // History may be large; flush after paint in rAF-sized chunks (logs.js).
      afterPaint(() => {
        if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== 'logs') return;
        if (App.flushLogs) App.flushLogs();
      });
    } else if (tab === 'subs') {
      App.renderSubs();
    } else if (tab === 'settings') {
      App.renderSettings();
      App.renderCoreStatus(App.state.status);
      if (App.refreshSelects) App.refreshSelects();
    } else if (tab === 'tools') {
      // AppContainer enumeration is cached in the main process and remains the
      // expensive part of the UWP tool's first open.
      afterPaint(() => {
        if (document.hidden || App.currentTab !== 'tools') return;
        if (api.warmUwpApps) api.warmUwpApps().catch(() => {});
      });
    } else if (tab === 'dashboard') {
      App.trafficChart.draw();
    }
  }

  // Prewarm the lightweight dialog shell only when the pointer or keyboard is
  // actually approaching a dialog launcher. This keeps idle Tools visits from
  // holding a second renderer while preserving a fast click path.
  const DIALOG_LAUNCHER_SELECTOR = [
    'button[id$="Open"]',
    '#coreManageBtn',
    '#smartRegionsBtn',
    '#smartRegionScope',
    '#geoManageBtn',
    '#lrAdd',
    '#subList button[data-act="editraw"]',
    '#lrList button[data-act="edit"]',
    '#crsList button[data-act="edit"]',
  ].join(',');
  let lastDialogWarm = 0;
  function warmDialogNearLauncher(event) {
    const launcher = event.target.closest && event.target.closest(DIALOG_LAUNCHER_SELECTOR);
    if (!launcher || !api.prepareDialog) return;
    const now = Date.now();
    if (now - lastDialogWarm < 1500) return;
    lastDialogWarm = now;
    api.prepareDialog().catch(() => {});
  }
  document.addEventListener('pointerover', warmDialogNearLauncher);
  document.addEventListener('focusin', warmDialogNearLauncher);
  document.addEventListener('pointerdown', warmDialogNearLauncher, true);

  // While hidden (minimized to tray), stop polling and drawing. The main
  // process keeps the tray tooltip live without waking the renderer each second.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelNavIndicatorAnimation();
      tabActivationSequence++;
      if (App.setLogStreaming) App.setLogStreaming(false);
      if (connTimer) {
        clearTimeout(connTimer);
        connTimer = null;
      }
      if (App.currentTab === 'conns' && App.clearConnections) App.clearConnections();
      if (App.releaseNodes) App.releaseNodes();
      if (App.releaseRuleCache) App.releaseRuleCache();
    } else {
      onTabShown(App.currentTab).catch((error) => App.toast(error.message || String(error), true));
      App.trafficChart.draw();
      App.miniChart.draw();
    }
  });
  window.addEventListener('pagehide', () => {
    if (App.setLogStreaming) App.setLogStreaming(false);
  });

  // ---------- Data refresh ----------
  let prevActiveSub;
  let prevActiveRevision;
  let prevRuleConfigRevision;
  let prevSettingsSignature = '';
  let prevSubsSignature = '';
  let prevStatusSignature = '';
  let prevSelected = undefined;
  let refreshSequence = 0;
  let statusEventRevision = 0;

  function settingsSignature(settings) {
    // Settings objects are small; a stable JSON form is cheaper than rebuilding
    // the whole settings form on every refresh when nothing changed.
    try { return JSON.stringify(settings || null); } catch (_) { return String(Date.now()); }
  }

  function statusSignature(status) {
    const st = status || {};
    return [
      st.running ? 1 : 0,
      st.systemProxy ? 1 : 0,
      st.coreInstalled ? 1 : 0,
      st.coreType || '',
      st.coreName || '',
      st.coreVersion === undefined ? '?' : (st.coreVersion || ''),
      st.corePath || '',
    ].join('\0');
  }

  async function refresh() {
    const sequence = ++refreshSequence;
    const statusRevisionAtStart = statusEventRevision;
    const settingsRevisionAtStart = localSettingsRevision;
    const previousTheme = App.state.settings && App.state.settings.theme;
    const previousCoreType = App.state.settings && App.state.settings.coreType;
    const nextState = await api.getState();
    if (sequence !== refreshSequence) return;
    // A compact status event can overtake this slower full snapshot. Preserve
    // that newer runtime truth instead of repainting a stopped/running core
    // with the stale snapshot that was already in flight.
    if (statusRevisionAtStart !== statusEventRevision) {
      const liveStatus = App.state.status || {};
      const coreChanged = liveStatus.coreType && nextState.status &&
        liveStatus.coreType !== nextState.status.coreType;
      nextState.status = coreChanged
        ? { ...(nextState.status || {}), ...liveStatus, corePath: undefined, coreVersion: undefined }
        : { ...(nextState.status || {}), ...liveStatus };
    }
    if (settingsRevisionAtStart !== localSettingsRevision) {
      nextState.settings = App.state.settings;
    }
    App.state = nextState;
    const activeSummary = (App.state.subscriptions || []).find((sub) => sub.id === App.state.activeSub);
    const activeRevision = activeSummary
      ? `${activeSummary.id}\0${activeSummary.updatedAt || 0}\0${activeSummary.nodeCount || 0}`
      : String(App.state.activeSub || '');
    const ruleConfigRevision = JSON.stringify([
      App.state.settings && App.state.settings.coreType,
      !!(App.state.settings && App.state.settings.useBuiltinRules),
      (App.state.settings && App.state.settings.ruleOverrides) || {},
    ]);
    const nextSettingsSignature = settingsSignature(App.state.settings);
    const nextSubsSignature = App.subscriptionStateSignature(App.state.subscriptions, App.state.activeSub);
    const nextStatusSignature = statusSignature(App.state.status);
    const settingsChanged = nextSettingsSignature !== prevSettingsSignature;
    const subsChanged = nextSubsSignature !== prevSubsSignature;
    const statusChanged = nextStatusSignature !== prevStatusSignature;
    const subscriptionTargetChanged = previousCoreType !==
      (App.state.settings && App.state.settings.coreType);
    const selectedChanged = App.state.selected !== prevSelected;
    const activeChanged = App.state.activeSub !== prevActiveSub || activeRevision !== prevActiveRevision;
    // A same-id refresh may still replace every node/rule in the profile.
    // Drop data tied to its old contents as well as on explicit profile switches.
    if (activeChanged) {
      App.delays.clear();
      prevActiveSub = App.state.activeSub;
      prevActiveRevision = activeRevision;
      if (App.releaseNodes) App.releaseNodes();
    }
    if (activeChanged || ruleConfigRevision !== prevRuleConfigRevision) {
      if (App.invalidateRuleCaches) App.invalidateRuleCaches();
    }
    prevRuleConfigRevision = ruleConfigRevision;
    prevSettingsSignature = nextSettingsSignature;
    prevSubsSignature = nextSubsSignature;
    prevStatusSignature = nextStatusSignature;
    prevSelected = App.state.selected;
    // setLanguage re-renders everything below; only invoke it on an actual change.
    const lang = App.state.settings && App.state.settings.language;
    const languageChanged = !!(lang && lang !== getLang());
    if (languageChanged) setLanguage(lang);
    const theme = App.state.settings && App.state.settings.theme;
    if (theme !== previousTheme || languageChanged) {
      if (theme === 'system' && api && api.resolveTheme) {
        api.resolveTheme()
          .then((resolved) => App.applyTheme(theme, resolved && resolved.effective))
          .catch(() => App.applyTheme(theme));
      } else {
        App.applyTheme(theme);
      }
    }
    // Cheap status chrome always tracks runtime truth; heavier panels only repaint
    // when their backing snapshot actually changed (or language rebuilt the UI).
    if (statusChanged || languageChanged) App.renderStatus();
    else if (subsChanged && App.renderDashboard) App.renderDashboard();
    if ((subsChanged || languageChanged || subscriptionTargetChanged) && App.renderSubs) App.renderSubs();
    if (App.currentTab === 'nodes' && App.loadNodes && (activeChanged || languageChanged || selectedChanged)) {
      App.loadNodes();
    } else if (App.currentTab === 'nodes' && settingsChanged && App.renderNodes) {
      App.renderNodes();
    }
    if ((settingsChanged || languageChanged) && App.renderSettings) App.renderSettings();
    if (settingsChanged || languageChanged || statusChanged) App.renderMode();
    if (subsChanged || languageChanged) App.renderUsage();
    // getState already carries the core path/version, so no extra IPC is needed.
    if ((statusChanged || languageChanged) && App.renderCoreStatus) App.renderCoreStatus(App.state.status);
    if (selectedChanged || statusChanged || languageChanged || activeChanged) {
      if (App.refreshGroupSelections) {
        App.refreshGroupSelections();
      } else if (App.state.status && App.state.status.running) {
        // The current-node readout is visible outside the Nodes page. Load its
        // controller after first paint only when a running core makes it useful.
        afterPaint(() => {
          if (document.hidden || !(App.state.status && App.state.status.running)) return;
          ensureTabModules('nodes')
            .then(() => App.refreshGroupSelections())
            .catch(() => {});
        });
      }
    }
  }

  function refreshSafely() {
    return refresh().catch((error) => {
      if (!document.hidden) App.toast(error.message || String(error), true);
    });
  }

  // ---------- Event streams ----------
  if (api && api.onTraffic) api.onTraffic((s) => {
    App.trafficChart.push(s.up || 0, s.down || 0);
    App.miniChart.push(s.up || 0, s.down || 0);
  });
  if (api && api.onSubsChanged) api.onSubsChanged(() => {
    if (App.releaseNodes) App.releaseNodes();
    if (App.invalidateRuleCaches) App.invalidateRuleCaches();
    refreshSafely();
  });
  // Keep the mode buttons in sync when the mode is changed from the tray menu.
  if (api && api.onModeChanged) api.onModeChanged((mode) => {
    App.patchSettings({ clashMode: mode });
    App.renderMode();
  });
  if (api && api.onDialogChanged) api.onDialogChanged((change) => {
    Promise.resolve().then(async () => {
      const scope = change && change.scope;
      if (scope === 'rules' || scope === 'all') {
        if (App.invalidateRuleCaches) App.invalidateRuleCaches();
      }
      if (scope === 'subscriptions' || scope === 'all') {
        if (App.releaseNodes) App.releaseNodes();
      }
      if (scope !== 'geodata') await refresh();
      if ((scope === 'rules' || scope === 'all') && App.currentTab === 'rules') showRulesTab();
      if (change && change.message) App.toast(change.message);
    }).catch((error) => App.toast(error.message || String(error), true));
  });

  if (api && api.onStatus) api.onStatus((status) => {
    statusEventRevision++;
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
    if (App.renderCoreStatus) App.renderCoreStatus(App.state.status);
    if (App.refreshGroupSelections) {
      App.refreshGroupSelections();
    } else if (App.state.status.running) {
      ensureTabModules('nodes')
        .then(() => App.refreshGroupSelections())
        .catch(() => {});
    }
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
  syncTopbarTitle();
  App.refreshPalette();
  if (!api) {
    if (App.renderThemeLabel) App.renderThemeLabel();
    App.trafficChart.draw();
    App.miniChart.draw();
    return;
  }
  refreshSafely();
  App.trafficChart.draw();
  App.miniChart.draw();
  App.initVersion();
  // Connections has no eager data subscription, so parsing it while idle is
  // cheap. Logs stays lazy to avoid retaining history when that tab is unused.
  const warmConnectionTab = () => {
    ensureTabModules('conns').catch(() => {});
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(warmConnectionTab, { timeout: 4000 });
  } else {
    setTimeout(warmConnectionTab, 1500);
  }
  // Silent update check at most once a day (the manual button always runs).
  try {
    const last = parseInt(localStorage.getItem('lastUpdateCheck') || '0', 10);
    if (Date.now() - last > 86400000) {
      App.runUpdateCheck(true).then((success) => {
        if (success) localStorage.setItem('lastUpdateCheck', String(Date.now()));
      }).catch(() => {});
    }
  } catch (_) {
    App.runUpdateCheck(true);
  }
})();
