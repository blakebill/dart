'use strict';

const {
  reqBoolean,
} = require('./ipc-validation');
const {
  ConnectionSnapshotService,
  boundedCounter,
  projectConnectionRows,
} = require('./connection-snapshot-service');

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

function connectionRows(data) {
  const source = Array.isArray(data && data.connections) ? data.connections : [];
  return {
    running: true,
    connections: projectConnectionRows(source),
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
  const snapshots = core.connectionSnapshots instanceof ConnectionSnapshotService
    ? core.connectionSnapshots
    : new ConnectionSnapshotService({ load: () => core.clashApi('GET', '/connections') });
  const views = new WeakMap();
  const observedWindows = new WeakSet();

  function updateView(contents, visible) {
    const previous = views.get(contents) || { visible: false, revision: 0 };
    // Every declaration is a new lease generation, even when the boolean is
    // unchanged. This invalidates old requests if a prior release IPC was lost.
    const next = { visible, revision: previous.revision + 1 };
    views.set(contents, next);
    if (previous.visible !== visible) snapshots.invalidate();
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
      const data = await snapshots.summary();
      try {
        if (!windowCanReceiveDetails(requireMainWindow(event), event.sender)) {
          return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
        }
      } catch (_) {
        return { running: state.coreManager.isRunning(), paused: true, totalConnections: 0 };
      }
      return {
        running: true,
        totalConnections: data.totalConnections,
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
      const data = await snapshots.rendererRows();
      // A page switch can overtake the API response. Never clone stale rows
      // back into a Renderer that has already released the feature.
      if (!leaseIsCurrent(event, lease)) return pausedSnapshot(state);
      return { running: true, ...data };
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
      try {
        await core.clashApi('DELETE', '/connections/' + encodeURIComponent(id));
      } finally {
        snapshots.invalidate();
      }
    }
    return true;
  });

  ipcMain.handle('connections:closeMany', async (event, payload = {}) => {
    requireMainWindow(event);
    const input = payload && payload.ids;
    if (!Array.isArray(input) || input.length < 1 || input.length > 300) {
      throw new Error('invalid connection ids');
    }
    const ids = [...new Set(input)];
    for (const id of ids) {
      if (
        typeof id !== 'string' || !id.trim() || id.length > 1024 ||
        /[\u0000-\u001f\u007f]/.test(id)
      ) throw new Error('invalid connection id');
    }
    if (!state.coreManager.isRunning()) return { closed: 0 };

    let closed = 0;
    const failures = [];
    try {
      // Keep the local API responsive when a filter matches many rows.
      for (let offset = 0; offset < ids.length; offset += 8) {
        const results = await Promise.allSettled(ids.slice(offset, offset + 8).map((id) => (
          core.clashApi('DELETE', '/connections/' + encodeURIComponent(id))
        )));
        for (const result of results) {
          if (result.status === 'fulfilled') closed += 1;
          else failures.push(result.reason);
        }
      }
    } finally {
      snapshots.invalidate();
    }
    if (failures.length) {
      const error = failures[0];
      throw new Error(`failed to close ${failures.length} connection(s): ${error && error.message || error}`);
    }
    return { closed };
  });

  ipcMain.handle('connections:closeAll', async (event) => {
    requireMainWindow(event);
    if (state.coreManager.isRunning()) {
      try {
        await core.clashApi('DELETE', '/connections');
      } finally {
        snapshots.invalidate();
      }
    }
    return true;
  });
}

module.exports = { connectionRows, registerConnectionsIpc };
