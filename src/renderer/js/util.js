'use strict';
// Shared namespace + helpers used by every renderer module. Loaded first;
// each feature module attaches its cross-module functions to window.App and
// the entry point (main.js, loaded last) wires events and boots the app.
(function () {
  const App = (window.App = {});
  const { getLang } = window.i18n;

  // Renderer-wide state, replaced wholesale by refresh() in main.js — always
  // reference it as App.state, never capture the object in a local.
  App.state = { subscriptions: [], settings: {}, status: {} };
  // Latency results keyed by node name: number (ms) | 'timeout' | 'testing'
  App.delays = new Map();
  // The visible tab; nodes.js consults it to skip re-renders while hidden.
  App.currentTab = 'dashboard';

  App.$ = (sel) => document.querySelector(sel);
  App.$$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, isErr = false) {
    const t0 = App.$('#toast');
    t0.textContent = msg;
    t0.classList.toggle('err', isErr);
    t0.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t0.classList.add('hidden'), 3000);
  }
  App.toast = toast;

  App.call = async function call(fn, ...args) {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message || String(e), true);
      throw e;
    }
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

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  App.escapeHtml = function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  };
})();
