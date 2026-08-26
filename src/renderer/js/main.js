'use strict';
// Entry point (loaded last): tab switching, the global refresh cycle, event
// streams from the main process, and startup.
(function () {
  const App = window.App;
  const { $, $$ } = App;
  const api = window.api;
  const uiState = App.uiState;
  const { setLang, getLang, applyI18n, t } = window.i18n;

  const TAB_MODULES = Object.freeze({
    subs: ['js/subs.js'],
    nodes: ['js/nodes.js'],
    groups: ['js/groups.js'],
    rules: ['js/rules.js', 'js/rulesets.js'],
    conns: ['js/conns.js'],
    logs: ['js/logs.js'],
    settings: ['js/settings.js'],
    tools: ['js/tools.js', 'js/toolbox.js'],
  });
  const TAB_REGISTRATIONS = Object.freeze({
    subs: ['subs'],
    nodes: ['nodes'],
    groups: ['groups'],
    rules: ['rules', 'rulesets'],
    conns: ['conns'],
    logs: ['logs'],
    settings: ['settings'],
    tools: ['tools', 'toolbox'],
  });
  const loadedTabs = new Set(['dashboard']);
  const SILENT_UPDATE_START_DELAY_MS = 30_000;
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
    const missing = (TAB_REGISTRATIONS[tab] || []).filter((name) => !App.hasRendererModule(name));
    if (missing.length) {
      App.invalidateRendererScripts(TAB_MODULES[tab]);
      throw new Error(`renderer module ${tab} did not initialize: ${missing.join(', ')}`);
    }
    loadedTabs.add(tab);
  }
  App.ensureTabModules = ensureTabModules;

  // ---------- Language ----------
  function setLanguage(lang, options = {}) {
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
    if (App.renderSettings) App.renderSettings({ preserveDraft: options.preserveSettingsDraft === true });
    if (App.renderLogEmptyState) App.renderLogEmptyState();
    // Policy-group controls are generated dynamically, so data-i18n cannot
    // update their option labels while the page is mounted.
    if (App.refreshPolicyGroupLabels) App.refreshPolicyGroupLabels();
    App.renderMode();
    App.renderUsage();
    if (App.renderCoreStatus) App.renderCoreStatus(App.state.status);
    if (App.currentTab === 'rules' && App.loadRules) {
      App.loadRules({ force: false });
      App.loadLocalRules({ force: true });
      App.loadCustomRuleSets({ force: true });
    }
    if (App.currentTab === 'groups' && App.loadPolicyGroups) {
      App.loadPolicyGroups({ force: true });
    }
    syncTopbarTitle();
    if (App.renderThemeLabel) App.renderThemeLabel();
    const sel = $('#setLanguage');
    if (sel) sel.value = lang;
    // Refresh after every dynamic render so labels mirror the final option
    // text and selected value, including controls rebuilt during translation.
    if (App.refreshSelects) App.refreshSelects();
    if (App.applySidebarState) App.applySidebarState();
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

  function showTab(tab, options = {}) {
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    const panel = $('#tab-' + tab);
    if (!btn || !panel) return;
    if (options.capture !== false) uiState.capture();
    const previousPanel = document.querySelector('.tab.active');
    if (
      options.activate !== false && App.currentTab === tab &&
      previousPanel === panel && (loadedTabs.has(tab) || !TAB_MODULES[tab])
    ) {
      syncTopbarTitle(btn);
      syncNavIndicator(btn, options.immediate === true);
      uiState.scheduleSave();
      return;
    }
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
    syncNavIndicator(btn, options.immediate === true);
    if (shouldMoveFocus) requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    if (options.activate === false) {
      App.currentTab = tab;
      return;
    }
    onTabShown(tab).catch((error) => App.toast(error.message || String(error), true));
    uiState.scheduleSave();
  }
  App.showTab = showTab;

  const navButtons = $$('.nav-item');

  function applySidebarState(collapsed = uiState.sidebarCollapsed, persist = false) {
    const compact = collapsed === true;
    const root = document.querySelector('.app');
    const toggle = $('#sidebarToggle');
    if (!root || !toggle) return;
    root.classList.toggle('sidebar-collapsed', compact);
    toggle.setAttribute('aria-expanded', String(!compact));
    const label = t(compact ? 'nav.expandSidebar' : 'nav.collapseSidebar');
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    navButtons.forEach((button) => {
      button.title = compact ? button.textContent.trim() : '';
    });
    if (persist) uiState.setSidebarCollapsed(compact);
    requestAnimationFrame(() => syncNavIndicator(document.querySelector('.nav-item.active'), true));
  }
  App.applySidebarState = () => applySidebarState(uiState.sidebarCollapsed, false);
  App.setSidebarCollapsed = (collapsed, options = {}) => {
    applySidebarState(collapsed, options.persist !== false);
  };
  const sidebarToggle = $('#sidebarToggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      App.setSidebarCollapsed(!document.querySelector('.app').classList.contains('sidebar-collapsed'));
    });
  }
  applySidebarState(uiState.sidebarCollapsed, false);

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

  // Per-tab activation: load expensive feature data only on demand.
  let dashboardStatsTimer = null;
  function stopDashboardStats() {
    if (!dashboardStatsTimer) return;
    clearTimeout(dashboardStatsTimer);
    dashboardStatsTimer = null;
  }
  function scheduleDashboardStats(delay = 5000) {
    stopDashboardStats();
    if (document.hidden || App.currentTab !== 'dashboard' ||
        !(App.state.status && App.state.status.running)) return;
    dashboardStatsTimer = setTimeout(async () => {
      dashboardStatsTimer = null;
      if (document.hidden || App.currentTab !== 'dashboard') return;
      if (App.loadDashboardConnections) await App.loadDashboardConnections();
      scheduleDashboardStats();
    }, delay);
  }
  function startDashboardStats() {
    stopDashboardStats();
    if (document.hidden || App.currentTab !== 'dashboard') return;
    Promise.resolve(App.loadDashboardConnections && App.loadDashboardConnections())
      .finally(() => scheduleDashboardStats());
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
      ['ensureRulesLoaded', 'loadRules', 80],
    ];
    for (const [preferred, fallback, delay] of tasks) {
      afterPaint(() => {
        if (!document.hidden && App.currentTab === 'rules') {
          Promise.resolve((App[preferred] || App[fallback])())
            .finally(() => uiState.restoreScroll('rules', { final: preferred === 'ensureRulesLoaded' }));
        }
      }, delay);
    }
  }

  function showGroupsTab() {
    afterPaint(() => {
      if (document.hidden || App.currentTab !== 'groups') return;
      Promise.resolve((App.ensurePolicyGroupsLoaded || App.loadPolicyGroups)())
        .finally(() => uiState.restoreScroll('groups', { final: true }));
    });
  }

  let tabActivationSequence = 0;
  async function onTabShown(tab) {
    const sequence = ++tabActivationSequence;
    const previousTab = App.currentTab;
    App.currentTab = tab;
    if (previousTab === 'logs' && tab !== 'logs' && App.setLogStreaming) {
      App.setLogStreaming(false);
    }
    if (previousTab === 'conns' && tab !== 'conns' && App.deactivateConnections) {
      App.deactivateConnections();
    }
    // Keep the small session-only latency cache and let an explicit sweep finish
    // while releasing the heavier node list whenever the user changes pages.
    if (previousTab === 'nodes' && tab !== 'nodes' && App.releaseNodes) {
      App.releaseNodes({ cancelTests: false });
    }
    if (previousTab === 'groups' && tab !== 'groups' && App.releasePolicyGroupCache) {
      App.releasePolicyGroupCache();
    }
    if (previousTab === 'rules' && tab !== 'rules' && App.releaseRuleCache) {
      // Routing configs can contain tens of thousands of normalized search
      // rows. Reload on demand instead of retaining them behind another page.
      App.releaseRuleCache();
    }
    stopDashboardStats();
    await ensureTabModules(tab);
    if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== tab) return;
    if (tab === 'rules') {
      showRulesTab();
    } else if (tab === 'groups') {
      showGroupsTab();
    } else if (tab === 'conns') {
      // The controller owns its visibility lease, polling and data release.
      afterPaint(() => {
        if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== 'conns') return;
        Promise.resolve(App.activateConnections())
          .catch((error) => App.toast(error.message || String(error), true));
      });
    } else if (tab === 'nodes') {
      Promise.resolve(App.loadNodes())
        .finally(() => uiState.restoreScroll('nodes', { final: true }));
      App.refreshGroupSelections();
    } else if (tab === 'logs') {
      // Main retains a bounded history, so stream chatty core output only while
      // it can actually be consumed. Re-entry snapshots the missed sequence.
      const historyReady = Promise.resolve(
        App.setLogStreaming ? App.setLogStreaming(true) : true
      );
      // History may be large; flush after paint in rAF-sized chunks (logs.js).
      afterPaint(() => {
        if (sequence !== tabActivationSequence || document.hidden || App.currentTab !== 'logs') return;
        if (App.flushLogs) App.flushLogs();
        historyReady
          .then(() => {
            if (
              sequence !== tabActivationSequence || document.hidden ||
              App.currentTab !== 'logs'
            ) return false;
            return App.waitForLogDrain ? App.waitForLogDrain() : true;
          })
          .then(() => {
            if (
              sequence === tabActivationSequence && !document.hidden &&
              App.currentTab === 'logs'
            ) uiState.restoreScroll('logs', { final: true });
          })
          .catch(() => {});
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
      App.renderDashboard();
      App.trafficChart.draw();
      startDashboardStats();
      if (App.loadDashboardEvents) App.loadDashboardEvents();
    }
    afterPaint(() => uiState.restoreScroll(tab, { force: true }));
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
  let rendererSuspended = false;
  function suspendRenderer() {
    if (rendererSuspended) return;
    uiState.capture();
    rendererSuspended = true;
    cancelNavIndicatorAnimation();
    tabActivationSequence++;
    if (App.setLogStreaming) App.setLogStreaming(false);
    if (App.deactivateConnections) App.deactivateConnections();
    stopDashboardStats();
    if (App.releaseNodes) App.releaseNodes();
    if (App.releaseRuleCache) App.releaseRuleCache();
    if (App.releasePolicyGroupCache) App.releasePolicyGroupCache();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      suspendRenderer();
    } else {
      rendererSuspended = false;
      onTabShown(App.currentTab).catch((error) => App.toast(error.message || String(error), true));
      if (App.currentTab !== 'dashboard') App.trafficChart.draw();
      App.miniChart.draw();
    }
  });
  window.addEventListener('pagehide', suspendRenderer);

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
      (App.state.settings && App.state.settings.ruleGroupSelections) || {},
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
    const ruleDataChanged = activeChanged || ruleConfigRevision !== prevRuleConfigRevision;
    // A same-id refresh may still replace every node/rule in the profile.
    // Drop data tied to its old contents as well as on explicit profile switches.
    if (activeChanged) {
      App.delays.clear();
      prevActiveSub = App.state.activeSub;
      prevActiveRevision = activeRevision;
      if (App.releaseNodes) App.releaseNodes();
    }
    if (ruleDataChanged) {
      if (App.invalidateRuleCaches) App.invalidateRuleCaches();
      if (App.invalidatePolicyGroupCache) App.invalidatePolicyGroupCache();
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
    if (statusChanged && App.currentTab === 'dashboard') startDashboardStats();
    return {
      activeChanged,
      rulesChanged: ruleDataChanged,
    };
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
    refreshSafely().then((change) => {
      if (change && change.rulesChanged && App.currentTab === 'rules') showRulesTab();
      if (change && change.rulesChanged && App.currentTab === 'groups') showGroupsTab();
    });
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
        if (App.invalidatePolicyGroupCache) App.invalidatePolicyGroupCache();
      }
      if (scope === 'subscriptions' || scope === 'all') {
        if (App.releaseNodes) App.releaseNodes();
      }
      if (scope !== 'geodata') await refresh();
      if ((scope === 'rules' || scope === 'all') && App.currentTab === 'rules') showRulesTab();
      if ((scope === 'rules' || scope === 'all') && App.currentTab === 'groups') showGroupsTab();
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
    // Core stop/start does not change the profile-derived policy-group model.
    // Keeping it avoids a full list rebuild during settings-triggered restarts.
    // Clear the traffic graphs once the core stops.
    if (wasRunning && !status.running) {
      App.trafficChart.reset();
      App.miniChart.reset();
    }
    if (App.currentTab === 'dashboard' && wasRunning !== status.running) startDashboardStats();
  });

  App.refresh = refresh;
  App.setLanguage = setLanguage;

  // ---------- Startup ----------
  applyI18n();
  syncTopbarTitle();
  App.refreshPalette();
  if (App.visualTest) {
    App.visualTest.boot({ ensureTabModules, showTab, setLanguage })
      .catch((error) => {
        window.__visualTestError = error && (error.stack || error.message) || String(error);
      });
    return;
  }
  if (!api) {
    if (App.renderThemeLabel) App.renderThemeLabel();
    App.trafficChart.draw();
    App.miniChart.draw();
    return;
  }
  uiState.restoreControls();
  refreshSafely().then(() => {
    const restoredTab = uiState.restoredTab;
    if (restoredTab !== App.currentTab) showTab(restoredTab, { capture: false });
    else uiState.restoreScroll(restoredTab, { final: true });
  });
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
  // A daily update lookup is not part of the login/startup critical path.
  // Delay it until the renderer and auto-resumed core have settled so GitHub
  // DNS/TLS work cannot compete with the first useful proxy connection.
  setTimeout(() => {
    try {
      const last = parseInt(localStorage.getItem('lastUpdateCheck') || '0', 10);
      if (Date.now() - last <= 86400000) return;
      App.runUpdateCheck(true).then((success) => {
        if (success) localStorage.setItem('lastUpdateCheck', String(Date.now()));
      }).catch(() => {});
    } catch (_) {
      App.runUpdateCheck(true).catch(() => {});
    }
  }, SILENT_UPDATE_START_DELAY_MS);
})();
