'use strict';
// Bounded, data-free Renderer continuity across deep-sleep recreation.
(function () {
  const App = window.App;
  const UI_STATE_KEY = 'dart-light-ui-state-v1';
  const RESTORABLE_TABS = new Set([
    'dashboard', 'subs', 'nodes', 'groups', 'rules', 'conns', 'tools', 'logs', 'settings',
  ]);
  const TAB_SCROLL_TARGETS = Object.freeze({
    nodes: ['nodeList'],
    groups: ['ruleGroupList'],
    rules: ['ruleList'],
    conns: ['connList'],
    logs: ['logBox'],
  });
  const FILTER_IDS = Object.freeze([
    'nodeFilter', 'ruleFilter', 'connFilter', 'connNetworkFilter', 'connRouteFilter',
  ]);

  function cleanUiState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const tab = RESTORABLE_TABS.has(source.tab) ? source.tab : 'dashboard';
    const scroll = {};
    for (const candidate of RESTORABLE_TABS) {
      const page = source.scroll && source.scroll[candidate];
      if (!page || typeof page !== 'object') continue;
      const clean = {};
      for (const id of ['mainContent', ...(TAB_SCROLL_TARGETS[candidate] || [])]) {
        const offset = Number(page[id]);
        if (Number.isFinite(offset) && offset >= 0) {
          clean[id] = Math.min(10_000_000, Math.round(offset));
        }
      }
      if (Object.keys(clean).length) scroll[candidate] = clean;
    }
    const filters = {};
    for (const id of FILTER_IDS) {
      const text = source.filters && source.filters[id];
      if (typeof text === 'string' && text) filters[id] = text.slice(0, 256);
    }
    const expanded = Array.isArray(source.expanded)
      ? source.expanded
        .filter((id) => typeof id === 'string' && /^[a-z][\w-]{0,63}$/i.test(id))
        .slice(0, 24)
      : [];
    return {
      version: 1,
      tab,
      scroll,
      filters,
      expanded,
      sidebarCollapsed: source.sidebarCollapsed === true,
    };
  }

  function createLightUiState({ document: doc, storage, getCurrentTab, isVisualTest }) {
    function read() {
      try {
        return cleanUiState(JSON.parse(storage.getItem(UI_STATE_KEY) || 'null'));
      } catch (_) {
        return cleanUiState(null);
      }
    }

    const state = read();
    const pendingScrollRestore = new Set(Object.keys(state.scroll));
    let saveTimer = null;

    function capture() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (isVisualTest() || !RESTORABLE_TABS.has(getCurrentTab())) return;
      const tab = getCurrentTab();
      // A lazy list may still be empty while its saved offset is pending. Do
      // not replace that offset with zero before the first usable render.
      if (!pendingScrollRestore.has(tab)) {
        const page = {};
        for (const id of ['mainContent', ...(TAB_SCROLL_TARGETS[tab] || [])]) {
          const element = doc.getElementById(id);
          if (element) page[id] = Math.max(0, Math.round(element.scrollTop || 0));
        }
        state.scroll[tab] = page;
      }
      state.tab = tab;
      state.filters = {};
      for (const id of FILTER_IDS) {
        const element = doc.getElementById(id);
        if (element && element.value) state.filters[id] = String(element.value).slice(0, 256);
      }
      state.expanded = Array.from(doc.querySelectorAll(
        'details[id][open], [data-ui-restore-expanded][id][aria-expanded="true"]'
      )).map((element) => element.id).filter(Boolean).slice(0, 24);
      try {
        storage.setItem(UI_STATE_KEY, JSON.stringify(cleanUiState(state)));
      } catch (_) {
        /* UI continuity is optional when browser storage is unavailable. */
      }
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        capture();
      }, 250);
    }

    function restoreControls() {
      for (const [id, value] of Object.entries(state.filters)) {
        const element = doc.getElementById(id);
        if (element) element.value = value;
      }
      for (const id of state.expanded) {
        const element = doc.getElementById(id);
        if (!element) continue;
        if (element.tagName === 'DETAILS') element.open = true;
        else if (element.hasAttribute('data-ui-restore-expanded')) {
          element.setAttribute('aria-expanded', 'true');
        }
      }
    }

    function restoreScroll(tab, { final = false, force = false } = {}) {
      if (getCurrentTab() !== tab) return;
      if (!force && !pendingScrollRestore.has(tab)) return;
      const page = { mainContent: 0, ...(state.scroll[tab] || {}) };
      let ready = true;
      for (const [id, offset] of Object.entries(page)) {
        const element = doc.getElementById(id);
        if (!element) continue;
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        if (offset > max && id !== 'mainContent') {
          ready = false;
          element.scrollTop = max;
          continue;
        }
        element.scrollTop = Math.min(offset, max);
      }
      if (ready || final) pendingScrollRestore.delete(tab);
      else pendingScrollRestore.add(tab);
    }

    function setSidebarCollapsed(collapsed) {
      state.sidebarCollapsed = collapsed === true;
      scheduleSave();
    }

    doc.addEventListener('scroll', scheduleSave, true);
    doc.addEventListener('input', (event) => {
      if (FILTER_IDS.includes(event.target && event.target.id)) scheduleSave();
    });
    doc.addEventListener('change', (event) => {
      if (FILTER_IDS.includes(event.target && event.target.id)) scheduleSave();
    });
    doc.addEventListener('toggle', scheduleSave, true);

    return Object.freeze({
      capture,
      scheduleSave,
      restoreControls,
      restoreScroll,
      setSidebarCollapsed,
      get restoredTab() { return state.tab; },
      get sidebarCollapsed() { return state.sidebarCollapsed; },
    });
  }

  App.factories.cleanUiState = cleanUiState;
  App.factories.createLightUiState = createLightUiState;
  App.uiState = createLightUiState({
    document,
    storage: localStorage,
    getCurrentTab: () => App.currentTab,
    isVisualTest: () => !!App.visualTest,
  });
})();
