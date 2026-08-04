'use strict';
// Shared namespace + helpers used by every renderer module. Loaded first;
// each feature module attaches its cross-module functions to window.App and
// the entry point (main.js, loaded last) wires events and boots the app.
(function () {
  const App = (window.App = {});
  const { getLang } = window.i18n;

  // Renderer-wide state, replaced wholesale by refresh() in main.js — always
  // reference it as App.state, never capture the object in a local.
  // New modules consume explicit service, state, event and routing boundaries.
  // App.state remains as a compatibility property while older modules migrate.
  let rendererState = { subscriptions: [], settings: {}, status: {} };
  const stateSubscribers = new Set();
  App.store = Object.freeze({
    getSnapshot: () => rendererState,
    replace(nextState) {
      const previous = rendererState;
      rendererState = nextState && typeof nextState === 'object'
        ? nextState
        : { subscriptions: [], settings: {}, status: {} };
      for (const listener of [...stateSubscribers]) listener(rendererState, previous);
      return rendererState;
    },
    patch(section, patch) {
      const current = rendererState[section];
      return this.replace({
        ...rendererState,
        [section]: current && typeof current === 'object'
          ? { ...current, ...(patch || {}) }
          : patch,
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      stateSubscribers.add(listener);
      return () => stateSubscribers.delete(listener);
    },
  });
  Object.defineProperty(App, 'state', {
    configurable: false,
    enumerable: true,
    get: () => rendererState,
    set: (value) => App.store.replace(value),
  });

  App.createEventBus = function createEventBus() {
    const listeners = new Map();
    return Object.freeze({
      on(type, listener) {
        if (typeof listener !== 'function') return () => {};
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
        return () => listeners.get(type)?.delete(listener);
      },
      emit(type, detail) {
        for (const listener of [...(listeners.get(type) || [])]) listener(detail);
      },
      clear(type) {
        if (type === undefined) listeners.clear();
        else listeners.delete(type);
      },
    });
  };
  App.events = App.createEventBus();
  App.services = Object.freeze({ api: window.api || null });
  App.router = Object.freeze({
    go(tab) {
      if (typeof App.showTab === 'function') App.showTab(tab);
    },
  });
  App.factories = {};
  // Session-only latency results keyed by node name. Profile changes clear this
  // map in main.js; closing the renderer naturally discards it without I/O.
  // Values: number (ms) | 'timeout' | 'testing'.
  App.delays = new Map();
  // The visible tab; nodes.js consults it to skip re-renders while hidden.
  App.currentTab = 'dashboard';

  App.$ = (sel) => document.querySelector(sel);
  App.$$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Classic-script module loader shared by the main renderer and native
  // dialogs. Feature scripts are loaded serially on first use, then retained
  // for the lifetime of that renderer. A failed request is evicted so a later
  // navigation can retry instead of inheriting a rejected promise forever.
  const scriptLoads = new Map();
  App.loadScript = function loadScript(src) {
    if (!/^(?:js|dialog)\/[a-z0-9-]+\.js$/i.test(src)) {
      return Promise.reject(new Error('invalid renderer module'));
    }
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const load = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.rendererModule = src;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('failed to load renderer module: ' + src)), { once: true });
      document.head.appendChild(script);
    }).catch((error) => {
      scriptLoads.delete(src);
      throw error;
    });
    scriptLoads.set(src, load);
    return load;
  };

  App.loadScripts = async function loadScripts(sources) {
    for (const src of sources) await App.loadScript(src);
  };

  function toast(msg, isErr = false) {
    const t0 = App.$('#toast');
    if (!t0) return;
    t0.textContent = msg;
    t0.classList.toggle('err', isErr);
    t0.setAttribute('role', isErr ? 'alert' : 'status');
    t0.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
    t0.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t0.classList.add('hidden'), 3000);
  }
  App.toast = toast;

  App.setProgress = function setProgress(element, ratio) {
    if (!element) return 0;
    const normalized = Math.max(0, Math.min(1, Number(ratio) || 0));
    const percent = Math.round(normalized * 100);
    const bar = element.querySelector('.bar');
    if (bar) bar.style.width = percent + '%';
    element.setAttribute('aria-valuemin', '0');
    element.setAttribute('aria-valuemax', '100');
    element.setAttribute('aria-valuenow', String(percent));
    element.setAttribute('aria-valuetext', percent + '%');
    return percent;
  };

  App.call = async function call(fn, ...args) {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message || String(e), true);
      throw e;
    }
  };

  App.openDialog = function openDialog(type, payload = {}) {
    // Dialog launchers are UI event boundaries. call() already reports the
    // error; consume it here so fire-and-forget click handlers do not create an
    // unhandled rejection in the renderer.
    return App.call(window.api.openDialog, type, payload).catch(() => null);
  };

  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  App.fmtBytes = function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    let i = 0;
    while (n >= 1024 && i < BYTE_UNITS.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(2) + ' ' + BYTE_UNITS[i];
  };

  App.fmtDate = function fmtDate(ts) {
    if (!ts) return '-';
    const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
    return new Date(ts).toLocaleString(locale);
  };

  // app:getState returns compact profile summaries, so hashing the complete
  // list is cheap and automatically covers metadata added in future versions.
  // Omitting fields here used to leave auto-update and proxy labels
  // stale after a metadata-only edit whose updatedAt did not change.
  App.subscriptionStateSignature = function subscriptionStateSignature(subs, activeSub) {
    return JSON.stringify([activeSub || null, Array.isArray(subs) ? subs : []]);
  };

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  App.escapeHtml = function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  };
})();
