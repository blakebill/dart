'use strict';

const http = require('http');

const { state } = require('./state');

/**
 * Subscribe to the Clash API `/traffic` stream (one JSON line per second with
 * instantaneous up/down byte rates) and forward each sample to the renderer so
 * the dashboard can draw a live traffic graph.
 */

let trafficReq = null;

function startTrafficStream() {
  stopTrafficStream();
  const settings = state.store.getSettings();
  if (!settings.enableClashApi) return;
  // No window to display it: the stream restarts on window 'show'.
  if (!state.mainWindow || state.mainWindow.isDestroyed() || !state.mainWindow.isVisible()) return;
  const req = http.request(
    {
      host: '127.0.0.1',
      port: settings.clashApiPort,
      path: '/traffic',
      method: 'GET',
      headers: { Authorization: 'Bearer ' + state.clashApiSecret },
    },
    (res) => {
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const t = JSON.parse(line);
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              state.mainWindow.webContents.send('singbox:traffic', { up: t.up || 0, down: t.down || 0 });
            }
          } catch (_) {
            /* ignore malformed line */
          }
        }
      });
      res.on('end', () => {
        // The core may have stopped; retry while it is still running.
        if (trafficReq === req && state.singbox && state.singbox.isRunning()) {
          setTimeout(() => { if (trafficReq === req) startTrafficStream(); }, 1000);
        }
      });
    }
  );
  req.on('error', () => {
    // Clash API may not be ready immediately after start; retry while running.
    if (trafficReq === req && state.singbox && state.singbox.isRunning()) {
      setTimeout(() => { if (trafficReq === req) startTrafficStream(); }, 1000);
    }
  });
  req.end();
  trafficReq = req;
}

function stopTrafficStream() {
  if (trafficReq) {
    try { trafficReq.destroy(); } catch (_) {}
    trafficReq = null;
  }
}

module.exports = { startTrafficStream, stopTrafficStream };
