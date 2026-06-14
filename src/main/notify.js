'use strict';

const { state } = require('./state');

/**
 * Show a desktop notification, gated by the `notifications` setting (default
 * on). Clicking it brings the window to the front. Best-effort: silently does
 * nothing if the platform has no notification support.
 */
function notify(title, body) {
  try {
    // Required lazily so importing this module doesn't touch electron's exports
    // at load time (keeps the test's electron stub quiet).
    const { Notification } = require('electron');
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
    const s = state.store ? state.store.getSettings() : {};
    if (s.notifications === false) return;
    const n = new Notification({ title: String(title || 'Dart'), body: String(body || '') });
    n.on('click', () => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.show();
        state.mainWindow.focus();
      }
    });
    n.show();
  } catch (_) {
    /* notifications are best-effort */
  }
}

module.exports = { notify };
