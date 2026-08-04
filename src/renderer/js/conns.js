'use strict';
// Connections tab controller. The controller itself has no dependency on the
// global App namespace; the compatibility adapter at the bottom wires it in.
(function () {
  const VIRTUAL_CONNECTION_ROW_HEIGHT = 62;
  const VIRTUAL_OVERSCAN = 7;
  const CONNECTION_LABELS = Object.freeze({
    direct: 'Direct',
    proxy: 'Proxy',
    reject: 'Reject',
    'reject-drop': 'Reject Drop',
    block: 'Block',
    global: 'Global',
    match: 'Match',
    pass: 'Pass',
  });

  function createConnectionsController(deps) {
    const {
      api,
      elements,
      ui,
      router,
      translate: t,
      formatBytes: fmtBytes,
      escape: escapeHtml,
      invoke,
      notify,
      isActive,
      isHidden,
      nextFrame,
      onLoaded = () => {},
    } = deps;
    let connectionItems = [];
    let connectionsRequest = null;
    let connectionsGeneration = 0;
    let renderQueued = false;
    let pollTimer = null;
    let active = false;
    let viewVisible = false;
    let activationGeneration = 0;

    function usable() {
      return active && isActive() && !isHidden();
    }

    function pollDelay(data) {
      const shown = data && Array.isArray(data.connections) ? data.connections.length : 0;
      return data && data.totalConnections > shown ? 5000 : 3000;
    }

    async function setViewVisible(visible) {
      const next = !!visible;
      if (viewVisible === next) return next;
      if (!api || typeof api.setConnectionsVisible !== 'function') {
        viewVisible = false;
        return false;
      }
      viewVisible = next;
      try {
        const accepted = !!await api.setConnectionsVisible(next);
        if (next && !accepted && viewVisible === next) viewVisible = false;
        return accepted;
      } catch (_) {
        if (next && viewVisible === next) viewVisible = false;
        return false;
      }
    }

    function stopPoll() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }

    function schedulePoll(delay = 3000) {
      stopPoll();
      if (!usable()) return;
      const generation = activationGeneration;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (generation !== activationGeneration || !usable()) return;
        if (!await setViewVisible(true)) {
          if (generation === activationGeneration && usable()) schedulePoll();
          return;
        }
        if (generation !== activationGeneration || !usable()) return;
        const data = await load();
        if (generation !== activationGeneration || !usable()) return;
        if (data && !data.error && !data.paused) onLoaded(data);
        schedulePoll(pollDelay(data));
      }, delay);
    }

    function connectionLabel(value) {
      const text = String(value || '');
      return CONNECTION_LABELS[text.toLowerCase()] || text;
    }

    function connRowInner(connection) {
      const metadata = connection.metadata || {};
      const host = metadata.host || metadata.destinationIP || '';
      const target = host + (metadata.destinationPort ? ':' + metadata.destinationPort : '');
      const chains = Array.isArray(connection.chains)
        ? connection.chains.slice().reverse().map(connectionLabel).join(' → ')
        : '';
      const network = (metadata.network || '').toUpperCase();
      const networkClass = network === 'TCP' ? ' tcp' : network === 'UDP' ? ' udp' : '';
      const networkHtml = network
        ? `<span class="conn-net${networkClass}">${escapeHtml(network)}</span>`
        : '';
      const closeHtml = connection.id
        ? `<button type="button" class="conn-close" data-id="${escapeHtml(connection.id)}" aria-label="${escapeHtml(t('conns.close') + ': ' + target)}" title="${escapeHtml(t('conns.close'))}">×</button>`
        : '';
      return (
        `<div class="conn-main">` +
        `<span class="conn-host">${escapeHtml(target)}</span>` +
        `<span class="conn-sub">${networkHtml}<span class="sub-meta">${escapeHtml(connectionLabel(connection.rule))}</span></span></div>` +
        `<div class="conn-right"><span class="conn-chains">${escapeHtml(chains)}</span>` +
        `<span class="sub-meta conn-traffic">↑ ${fmtBytes(connection.upload || 0)} · ↓ ${fmtBytes(connection.download || 0)}</span></div>${closeHtml}`
      );
    }

    function renderWindow() {
      const list = elements.list;
      if (!connectionItems.length) return;
      list.classList.remove('is-empty');
      const visible = Math.ceil((list.clientHeight || 480) / VIRTUAL_CONNECTION_ROW_HEIGHT);
      const start = Math.max(
        0,
        Math.floor(list.scrollTop / VIRTUAL_CONNECTION_ROW_HEIGHT) - VIRTUAL_OVERSCAN
      );
      const end = Math.min(connectionItems.length, start + visible + VIRTUAL_OVERSCAN * 2);
      let html = start
        ? `<div class="virtual-spacer" style="height:${start * VIRTUAL_CONNECTION_ROW_HEIGHT}px"></div>`
        : '';
      for (let index = start; index < end; index++) {
        const connection = connectionItems[index];
        html += `<div class="conn-item" role="listitem" data-connection-id="${escapeHtml(connection.id || '')}">${connRowInner(connection)}</div>`;
      }
      const after = connectionItems.length - end;
      if (after) {
        html += `<div class="virtual-spacer" style="height:${after * VIRTUAL_CONNECTION_ROW_HEIGHT}px"></div>`;
      }
      list.innerHTML = html;
    }

    function render(data = {}) {
      const allConnections = Array.isArray(data.connections) ? data.connections : [];
      elements.stats.textContent = t(
        'conns.stats',
        Number.isFinite(data.totalConnections) ? data.totalConnections : allConnections.length,
        fmtBytes(data.up),
        fmtBytes(data.down)
      );
      if (!data.running || allConnections.length === 0) {
        connectionItems = [];
        ui.renderEmptyState(elements.list, {
          iconClass: 'connection-empty-icon',
          title: t('conns.empty'),
          actionLabel: t('conns.openDashboard'),
          actionName: 'open-dashboard',
        });
        return;
      }
      elements.list.classList.remove('is-empty');
      connectionItems = allConnections;
      renderWindow();
    }

    async function load() {
      if (!usable()) return null;
      const generation = connectionsGeneration;
      if (connectionsRequest && connectionsRequest.generation === generation) {
        return connectionsRequest.promise;
      }
      if (!api || typeof api.getConnections !== 'function') {
        render({ running: false, connections: [], totalConnections: 0, up: 0, down: 0 });
        return null;
      }
      const token = {};
      const promise = (async () => {
        try {
          const data = await api.getConnections();
          if (generation !== connectionsGeneration || !isActive() || isHidden()) return data;
          // Main can revoke the lease on native hide/minimize before the
          // Renderer observes visibilitychange. Force the next poll to renew.
          if (data && data.paused) viewVisible = false;
          await nextFrame();
          if (generation === connectionsGeneration && isActive() && !isHidden()) render(data);
          return data;
        } catch (_) {
          return null;
        } finally {
          if (connectionsRequest && connectionsRequest.token === token) connectionsRequest = null;
        }
      })();
      connectionsRequest = { token, generation, promise };
      return promise;
    }

    function clear() {
      connectionsGeneration++;
      connectionItems = [];
      elements.list.classList.remove('is-empty');
      elements.list.textContent = '';
      elements.stats.textContent = '';
    }

    async function activate() {
      const generation = ++activationGeneration;
      active = true;
      stopPoll();
      if (!usable()) return null;
      if (!await setViewVisible(true)) {
        if (generation === activationGeneration && usable()) schedulePoll();
        return null;
      }
      await nextFrame();
      if (generation !== activationGeneration || !usable()) return null;
      const data = await load();
      if (generation !== activationGeneration || !usable()) return data;
      if (data && !data.error && !data.paused) onLoaded(data);
      schedulePoll(pollDelay(data));
      return data;
    }

    function deactivate() {
      active = false;
      activationGeneration++;
      stopPoll();
      void setViewVisible(false);
      clear();
    }

    function queueRender() {
      if (renderQueued) return;
      renderQueued = true;
      nextFrame().then(() => {
        renderQueued = false;
        renderWindow();
      });
    }

    elements.list.addEventListener('click', async (event) => {
      if (event.target.closest('[data-ui-action="open-dashboard"]')) {
        router.go('dashboard');
        return;
      }
      const button = event.target.closest('.conn-close');
      if (!button || !button.dataset.id || !api) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await invoke(api.closeConnection, button.dataset.id);
        notify(t('conns.closedOne'));
        load();
      } catch (_) {
        // invoke() already surfaced the error.
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
      }
    });
    elements.list.addEventListener('scroll', queueRender);
    window.addEventListener('resize', () => {
      if (isActive()) queueRender();
    });
    elements.closeAll.addEventListener('click', async () => {
      if (!api) return;
      try {
        await invoke(api.closeAllConnections);
        notify(t('conns.closed'));
        load();
      } catch (_) {
        // invoke() already surfaced the error.
      }
    });

    return Object.freeze({ activate, deactivate, load, clear, render });
  }

  const App = window.App;
  const controller = createConnectionsController({
    api: App.services.api,
    elements: {
      list: App.$('#connList'),
      stats: App.$('#connStats'),
      closeAll: App.$('#connClose'),
    },
    ui: App.ui,
    router: App.router,
    translate: window.i18n.t,
    formatBytes: App.fmtBytes,
    escape: App.escapeHtml,
    invoke: App.call,
    notify: App.toast,
    isActive: () => App.currentTab === 'conns',
    isHidden: () => document.hidden,
    onLoaded: () => App.uiState.restoreScroll('conns', { final: true }),
    nextFrame: () => new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    }),
  });

  App.factories.createConnectionsController = createConnectionsController;
  App.loadConnections = controller.load;
  App.clearConnections = controller.clear;
  App.renderConnections = controller.render;
  App.activateConnections = controller.activate;
  App.deactivateConnections = controller.deactivate;
})();
