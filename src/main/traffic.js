'use strict';

const http = require('http');

const { state, sendToMain } = require('./state');

/**
 * Subscribe to the Clash API `/traffic` stream (one JSON line per second with
 * instantaneous up/down byte rates) and forward each sample to the renderer so
 * the dashboard can draw a live traffic graph.
 */

let trafficReq = null;
let trafficRetryTimer = null;
const MAX_TRAFFIC_BUFFER = 64 * 1024;
const TRAFFIC_ACTIVE_RATE = 256;
const TRAFFIC_ACTIVE_WINDOW_MS = 12_000;
const TRAY_TOOLTIP_MIN_INTERVAL_MS = 2_500;
const TRAY_TOOLTIP_MAX_STALE_MS = 10_000;
const TRAY_TOOLTIP_MIN_RATE_DELTA = 1024;
const TRAY_TOOLTIP_RATE_DELTA_RATIO = 0.15;
let lastTrayTooltip = '';
let lastTrayTooltipAt = 0;
let lastTrayRates = { up: 0, down: 0 };
let trafficStreamStartedAt = 0;
let lastTrafficSampleAt = 0;
let lastTrafficActiveAt = 0;
let lastTrafficRate = 0;
let trafficActivityListener = null;

// Human-readable rate for the tray tooltip (e.g. "1.2 MB/s", "840 KB/s").
function fmtRate(n) {
  if (!n || n < 1) return '0 B/s';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i] + '/s';
}

// Show the live throughput on the tray icon's tooltip, so it's visible even
// when the window is hidden in the tray (pairs with silent start).
function normalizeRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function rateChangedMeaningfully(previous, next) {
  if (previous === next) return false;
  if (previous === 0 || next === 0) return true;
  const delta = Math.abs(next - previous);
  return delta >= TRAY_TOOLTIP_MIN_RATE_DELTA &&
    delta / Math.max(previous, next) >= TRAY_TOOLTIP_RATE_DELTA_RATIO;
}

function updateTrayTooltip(up, down, now = Date.now()) {
  if (!state.tray || (state.tray.isDestroyed && state.tray.isDestroyed())) return;
  up = normalizeRate(up);
  down = normalizeRate(down);
  const tooltip = `Dart Network Control\n↑ ${fmtRate(up)}   ↓ ${fmtRate(down)}`;
  if (tooltip === lastTrayTooltip) return;
  const elapsed = Math.max(0, now - lastTrayTooltipAt);
  if (lastTrayTooltip) {
    if (elapsed < TRAY_TOOLTIP_MIN_INTERVAL_MS) return;
    if (
      elapsed < TRAY_TOOLTIP_MAX_STALE_MS &&
      !rateChangedMeaningfully(lastTrayRates.up, up) &&
      !rateChangedMeaningfully(lastTrayRates.down, down)
    ) return;
  }
  try {
    state.tray.setToolTip(tooltip);
    lastTrayTooltip = tooltip;
    lastTrayTooltipAt = now;
    lastTrayRates = { up, down };
  } catch (_) {
    /* tray may be gone during shutdown */
  }
}

function noteTrafficSample(up, down, now = Date.now()) {
  const rate = normalizeRate(up) + normalizeRate(down);
  const wasActive = lastTrafficActiveAt > 0 &&
    now - lastTrafficActiveAt <= TRAFFIC_ACTIVE_WINDOW_MS;
  lastTrafficSampleAt = now;
  lastTrafficRate = rate;
  if (rate >= TRAFFIC_ACTIVE_RATE) {
    lastTrafficActiveAt = now;
    if (!wasActive && trafficActivityListener) {
      try { trafficActivityListener(); } catch (_) { /* advisory */ }
    }
  }
}

function getTrafficActivity(now = Date.now()) {
  const reference = lastTrafficActiveAt || trafficStreamStartedAt || lastTrafficSampleAt || now;
  const idleForMs = Math.max(0, now - reference);
  return {
    active: lastTrafficActiveAt > 0 && idleForMs <= TRAFFIC_ACTIVE_WINDOW_MS,
    idleForMs,
    rate: lastTrafficRate,
    sampleAgeMs: lastTrafficSampleAt > 0 ? Math.max(0, now - lastTrafficSampleAt) : Infinity,
  };
}

function setTrafficActivityListener(listener) {
  trafficActivityListener = typeof listener === 'function' ? listener : null;
}

function startTrafficStream() {
  stopTrafficStream();
  const settings = state.store.getSettings();
  // Runs whenever the core is up (independent of window visibility) so the tray
  // tooltip keeps showing live speed while minimized.
  if (!state.coreManager || !state.coreManager.isRunning()) return;
  trafficStreamStartedAt = Date.now();
  let req;
  let retryScheduled = false;
  const retry = () => {
    if (retryScheduled || trafficReq !== req || !state.coreManager || !state.coreManager.isRunning()) return;
    retryScheduled = true;
    trafficRetryTimer = setTimeout(() => {
      trafficRetryTimer = null;
      if (trafficReq === req) startTrafficStream();
    }, 1000);
    if (trafficRetryTimer.unref) trafficRetryTimer.unref();
  };
  req = http.request(
    {
      host: '127.0.0.1',
      port: settings.clashApiPort,
      path: '/traffic',
      method: 'GET',
      timeout: 15000,
      headers: { Authorization: 'Bearer ' + state.clashApiSecret },
    },
    (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          if (idx > MAX_TRAFFIC_BUFFER) {
            req.destroy(new Error('traffic stream frame too large'));
            return;
          }
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const t = JSON.parse(line);
            const up = t.up || 0;
            const down = t.down || 0;
            noteTrafficSample(up, down);
            updateTrayTooltip(up, down);
            const windowVisible = state.mainWindow &&
              (typeof state.mainWindow.isDestroyed !== 'function' || !state.mainWindow.isDestroyed()) &&
              (typeof state.mainWindow.isVisible !== 'function' || state.mainWindow.isVisible()) &&
              (typeof state.mainWindow.isMinimized !== 'function' || !state.mainWindow.isMinimized());
            if (windowVisible) sendToMain('core:traffic', { up, down });
          } catch (_) {
            /* ignore malformed line */
          }
        }
        if (buf.length > MAX_TRAFFIC_BUFFER) req.destroy(new Error('traffic stream frame too large'));
      });
      res.on('end', retry);
      res.on('aborted', retry);
      res.on('error', retry);
    }
  );
  // Clash API may not be ready immediately after start; retry while running.
  req.on('timeout', () => req.destroy(new Error('traffic stream timed out')));
  req.on('error', retry);
  req.end();
  trafficReq = req;
}

function stopTrafficStream() {
  lastTrayTooltip = '';
  lastTrayTooltipAt = 0;
  lastTrayRates = { up: 0, down: 0 };
  trafficStreamStartedAt = 0;
  lastTrafficSampleAt = 0;
  lastTrafficActiveAt = 0;
  lastTrafficRate = 0;
  if (trafficRetryTimer) {
    clearTimeout(trafficRetryTimer);
    trafficRetryTimer = null;
  }
  if (trafficReq) {
    try { trafficReq.destroy(); } catch (_) {}
    trafficReq = null;
  }
}

module.exports = {
  startTrafficStream,
  stopTrafficStream,
  getTrafficActivity,
  setTrafficActivityListener,
};
