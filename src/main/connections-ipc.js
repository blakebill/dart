'use strict';

const {
  MAX_IPC_CONNECTIONS,
  recentConnections,
  reqBoolean,
} = require('./ipc-validation');

function pausedSnapshot(state) {
  return {
    running: state.coreManager.isRunning(),
    paused: true,
    connections: [],
    totalConnections: 0,
    up: 0,
    down: 0,
  };
}

function boundedCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, number)
    : 0;
}

function boundedText(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function connectionRows(data) {
  const source = Array.isArray(data && data.connections) ? data.connections : [];
  const sortKey = (value) => {
    const connection = value && typeof value === 'object' ? value : {};
    const id = typeof connection.id === 'string' && connection.id.length <= 1024
      ? connection.id
      : '';
    return boundedText(connection.start, 128) + '\0' + id;
  };
  const connections = recentConnections(source, MAX_IPC_CONNECTIONS, sortKey).map((value) => {
    const connection = value && typeof value === 'object' ? value : {};
    const metadata = connection.metadata || {};
    return {
      id: typeof connection.id === 'string' && connection.id.length <= 1024
        ? connection.id
        : '',
      start: boundedText(connection.start, 128),
      upload: boundedCounter(connection.upload),
      download: boundedCounter(connection.download),
      rule: boundedText(connection.rule),
      chains: Array.isArray(connection.chains)
        ? connection.chains.slice(0, 16).map((item) => boundedText(item))
        : [],
      metadata: {
        host: boundedText(metadata.host, 1024),
        destinationIP: boundedText(metadata.destinationIP, 128),
        destinationPort: boundedText(String(metadata.destinationPort || ''), 32),
        network: boundedText(metadata.network, 32),
      },
    };
  });
  return {
    running: true,
    connections,
    totalConnections: source.length,
    up: boundedCounter(data && data.uploadTotal),
    down: boundedCounter(data && data.downloadTotal),
  };
}

function windowCanReceiveDetails(win, contents) {
  try {
    if (!win || !contents) return false;
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
    if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
    if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/** Own the detailed-connection visibility lease and its IPC surface. */
function registerConnectionsIpc({ ipcMain, state, core, requireMainWindow }) {
  const views = new WeakMap();
  const observedWindows = new WeakSet();

  function updateView(contents, visible) {
    const previous = views.get(contents) || { visible: false, revision: 0 };
    // Every declaration is a new lease generation, even when the boolean is
    // unchanged. This invalidates old requests if a prior release IPC was lost.
    const next = { visible, revision: previous.revision + 1 };
    views.set(contents, next);
    return next;
  }

  function observeWindow(win, contents) {
    if (!win || observedWindows.has(win) || typeof win.on !== 'function') return;
    observedWindows.add(win);
    const invalidate = () => updateView(contents, false);
    win.on('hide', invalidate);
    win.on('minimize', invalidate);
    win.on('closed', invalidate);
  }

  function startLease(event) {
    const win = requireMainWindow(event);
    const view = views.get(event.sender);
    return view && view.visible && windowCanReceiveDetails(win, event.sender)
      ? { contents: event.sender, revision: view.revision }
      : null;
  }

  function leaseIsCurrent(event, lease) {
    if (!lease || lease.contents !== event.sender) return false;
    try {
      const win = requireMainWindow(event);
      const view = views.get(event.sender);
      return !!(
        view && view.visible && view.revision === lease.revision &&
        windowCanReceiveDetails(win, event.sender)
      );
    } catch (_) {
      return false;
    }
  }

  ipcMain.handle('connections:setVisible', (event, payload = {}) => {
    const visible = payload && payload.visible;
    reqBoolean(visible, 'visible');
    const win = requireMainWindow(event);
    observeWindow(win, event.sender);
    const accepted = visible && windowCanReceiveDetails(win, event.sender);
    updateView(event.sender, accepted);
    return accepted;
  });

  ipcMain.handle('connections:summary', async (event) => {
    const win = requireMainWindow(event);
    if (!windowCanReceiveDetails(win, event.sender)) {
      return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
    }
    if (!state.coreManager.isRunning()) return { running: false, totalConnections: 0 };
    try {
      const data = await core.clashApi('GET', '/connections');
      try {
        if (!windowCanReceiveDetails(requireMainWindow(event), event.sender)) {
          return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
        }
      } catch (_) {
        return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
      }
      return {
        running: true,
        totalConnections: Array.isArray(data.connections) ? data.connections.length : 0,
      };
    } catch (error) {
      try {
        if (!windowCanReceiveDetails(requireMainWindow(event), event.sender)) {
          return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
        }
      } catch (_) {
        return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
      }
      return {
        running: state.coreManager.isRunning(),
        totalConnections: 0,
        error: String(error && error.message || error || 'Clash API unavailable'),
      };
    }
  });

  ipcMain.handle('connections:get', async (event) => {
    const lease = startLease(event);
    if (!lease) return pausedSnapshot(state);
    if (!state.coreManager.isRunning()) {
      return { running: false, connections: [], up: 0, down: 0 };
    }
    try {
      const data = await core.clashApi('GET', '/connections');
      // A page switch can overtake the API response. Never clone stale rows
      // back into a Renderer that has already released the feature.
      if (!leaseIsCurrent(event, lease)) return pausedSnapshot(state);
      return connectionRows(data);
    } catch (error) {
      if (!leaseIsCurrent(event, lease)) return pausedSnapshot(state);
      return {
        running: state.coreManager.isRunning(),
        connections: [],
        up: 0,
        down: 0,
        error: String(error && error.message || error || 'Clash API unavailable'),
      };
    }
  });

  ipcMain.handle('connections:close', async (event, payload = {}) => {
    requireMainWindow(event);
    const id = payload && payload.id;
    if (
      typeof id !== 'string' || !id.trim() || id.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(id)
    ) throw new Error('invalid connection id');
    if (state.coreManager.isRunning()) {
      await core.clashApi('DELETE', '/connections/' + encodeURIComponent(id));
    }
    return true;
  });

  ipcMain.handle('connections:closeAll', async (event) => {
    requireMainWindow(event);
    if (state.coreManager.isRunning()) await core.clashApi('DELETE', '/connections');
    return true;
  });
}

module.exports = { connectionRows, registerConnectionsIpc };
