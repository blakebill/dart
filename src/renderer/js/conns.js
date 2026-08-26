'use strict';
// Connections tab controller. The controller itself has no dependency on the
// global App namespace; the compatibility adapter at the bottom wires it in.
(function () {
  const VIRTUAL_CONNECTION_ROW_HEIGHT = 58;
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

  function routeCategory(connection) {
    const chains = Array.isArray(connection && connection.chains) ? connection.chains : [];
    const tokens = [connection && connection.rule, ...chains]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    if (tokens.some((value) => /^(?:reject(?:-drop)?|block)$/.test(value))) return 'reject';
    if (tokens.some((value) => value === 'direct')) return 'direct';
    return 'proxy';
  }

  function connectionSearchText(connection) {
    const metadata = connection && connection.metadata || {};
    const chains = Array.isArray(connection && connection.chains) ? connection.chains : [];
    const host = metadata.host || metadata.destinationIP || '';
    return [
      metadata.host,
      metadata.destinationIP,
      metadata.destinationPort,
      host && metadata.destinationPort ? `${host}:${metadata.destinationPort}` : '',
      metadata.network,
      connection && connection.rule,
      chains.slice().reverse().join(' → '),
      ...chains,
    ].map((value) => String(value || '').toLocaleLowerCase()).join('\n');
  }

  function filterConnections(connections, filters = {}) {
    const query = String(filters.query || '').trim().toLocaleLowerCase();
    const network = String(filters.network || '').trim().toLowerCase();
    const route = String(filters.route || '').trim().toLowerCase();
    return (Array.isArray(connections) ? connections : []).filter((connection) => {
      const metadata = connection && connection.metadata || {};
      if (network && String(metadata.network || '').toLowerCase() !== network) return false;
      if (route && routeCategory(connection) !== route) return false;
      return !query || connectionSearchText(connection).includes(query);
    });
  }

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
    let allConnectionItems = [];
    let connectionItems = [];
    let lastSnapshot = null;
    let connectionsRequest = null;
    let connectionsGeneration = 0;
    let renderQueued = false;
    let pollTimer = null;
    let filterTimer = null;
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

    function stopFilter() {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = null;
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

    function currentFilters() {
      return {
        query: elements.search ? elements.search.value : '',
        network: elements.network ? elements.network.value : '',
        route: elements.route ? elements.route.value : '',
      };
    }

    function filtersActive(filters = currentFilters()) {
      return !!(String(filters.query || '').trim() || filters.network || filters.route);
    }

    function updateFilterControls(filters, count) {
      const enabled = filtersActive(filters);
      if (elements.reset) elements.reset.classList.toggle('hidden', !enabled);
      if (elements.closeFiltered) {
        elements.closeFiltered.classList.toggle('hidden', !enabled);
        elements.closeFiltered.disabled = !enabled || count < 1;
      }
    }

    function renderStats(data, filters) {
      const total = Number.isFinite(data.totalConnections)
        ? data.totalConnections
        : allConnectionItems.length;
      if (filtersActive(filters)) {
        elements.stats.textContent = t(
          'conns.filteredStats',
          connectionItems.length,
          allConnectionItems.length,
          total,
          fmtBytes(data.up),
          fmtBytes(data.down)
        );
      } else if (total > allConnectionItems.length) {
        elements.stats.textContent = t(
          'conns.limitedStats',
          allConnectionItems.length,
          total,
          fmtBytes(data.up),
          fmtBytes(data.down)
        );
      } else {
        elements.stats.textContent = t(
          'conns.stats',
          total,
          fmtBytes(data.up),
          fmtBytes(data.down)
        );
      }
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
      const targetHtml = target
        ? `<button type="button" class="conn-host conn-filter-link" data-conn-filter="${escapeHtml(target)}" title="${escapeHtml(t('conns.filterByTarget'))}">${escapeHtml(target)}</button>`
        : '<span class="conn-host">—</span>';
      const chainsHtml = chains
        ? `<button type="button" class="conn-chains conn-filter-link" data-conn-filter="${escapeHtml(chains)}" title="${escapeHtml(t('conns.filterByNode'))}">${escapeHtml(chains)}</button>`
        : '<span class="conn-chains"></span>';
      const closeHtml = connection.id
        ? `<button type="button" class="conn-close" data-id="${escapeHtml(connection.id)}" aria-label="${escapeHtml(t('conns.close') + ': ' + target)}" title="${escapeHtml(t('conns.close'))}">×</button>`
        : '';
      return (
        `<div class="conn-main">` +
        targetHtml +
        `<span class="conn-sub">${networkHtml}<span class="sub-meta">${escapeHtml(connectionLabel(connection.rule))}</span></span></div>` +
        `<div class="conn-right">${chainsHtml}` +
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
      if (data.error) {
        lastSnapshot = null;
        allConnectionItems = [];
        connectionItems = [];
        updateFilterControls(currentFilters(), 0);
        elements.stats.textContent = '—';
        ui.renderEmptyState(elements.list, {
          iconClass: 'connection-empty-icon',
          title: t('conns.loadFailed'),
          actionLabel: t('conns.retry'),
          actionName: 'retry-connections',
        });
        return;
      }
      lastSnapshot = data;
      allConnectionItems = allConnections;
      if (!data.running || allConnections.length === 0) {
        connectionItems = [];
        updateFilterControls(currentFilters(), 0);
        renderStats(data, currentFilters());
        ui.renderEmptyState(elements.list, {
          iconClass: 'connection-empty-icon',
          title: t('conns.empty'),
          actionLabel: t('conns.openDashboard'),
          actionName: 'open-dashboard',
        });
        return;
      }
      applyFilters();
    }

    function applyFilters({ resetScroll = false } = {}) {
      const filters = currentFilters();
      if (!lastSnapshot) {
        updateFilterControls(filters, 0);
        return;
      }
      connectionItems = filterConnections(allConnectionItems, filters);
      updateFilterControls(filters, connectionItems.length);
      renderStats(lastSnapshot, filters);
      if (resetScroll) elements.list.scrollTop = 0;
      if (!connectionItems.length && filtersActive(filters) && allConnectionItems.length) {
        ui.renderEmptyState(elements.list, {
          iconClass: 'connection-empty-icon',
          title: t('conns.filteredEmpty'),
          actionLabel: t('conns.resetFilters'),
          actionName: 'reset-connection-filters',
        });
        return;
      }
      elements.list.classList.remove('is-empty');
      renderWindow();
    }

    function resetFilters() {
      if (elements.search) elements.search.value = '';
      if (elements.network) elements.network.value = '';
      if (elements.route) elements.route.value = '';
      applyFilters({ resetScroll: true });
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
      stopFilter();
      connectionsGeneration++;
      lastSnapshot = null;
      allConnectionItems = [];
      connectionItems = [];
      updateFilterControls(currentFilters(), 0);
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
      if (event.target.closest('[data-ui-action="retry-connections"]')) {
        load();
        return;
      }
      if (event.target.closest('[data-ui-action="open-dashboard"]')) {
        router.go('dashboard');
        return;
      }
      if (event.target.closest('[data-ui-action="reset-connection-filters"]')) {
        resetFilters();
        return;
      }
      const filterLink = event.target.closest('.conn-filter-link');
      if (filterLink && filterLink.dataset.connFilter && elements.search) {
        elements.search.value = filterLink.dataset.connFilter;
        applyFilters({ resetScroll: true });
        elements.search.focus();
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
    if (elements.search) {
      elements.search.addEventListener('input', () => {
        stopFilter();
        filterTimer = setTimeout(() => {
          filterTimer = null;
          applyFilters({ resetScroll: true });
        }, 80);
      });
    }
    for (const control of [elements.network, elements.route]) {
      if (control) control.addEventListener('change', () => applyFilters({ resetScroll: true }));
    }
    if (elements.reset) elements.reset.addEventListener('click', resetFilters);
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
    if (elements.closeFiltered) elements.closeFiltered.addEventListener('click', async () => {
      if (!api || !filtersActive()) return;
      const ids = [...new Set(connectionItems.map((connection) => connection.id).filter(Boolean))];
      if (!ids.length) return;
      elements.closeFiltered.disabled = true;
      try {
        let result;
        if (typeof api.closeConnections === 'function') {
          result = await invoke(api.closeConnections, ids);
        } else if (typeof api.closeConnection === 'function') {
          await Promise.all(ids.map((id) => invoke(api.closeConnection, id)));
          result = { closed: ids.length };
        }
        notify(t('conns.closedFiltered', result && Number.isFinite(result.closed) ? result.closed : ids.length));
        load();
      } catch (_) {
        // invoke() already surfaced the error.
      } finally {
        updateFilterControls(currentFilters(), connectionItems.length);
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
      search: App.$('#connFilter'),
      network: App.$('#connNetworkFilter'),
      route: App.$('#connRouteFilter'),
      reset: App.$('#connResetFilters'),
      closeFiltered: App.$('#connCloseFiltered'),
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
  App.factories.filterConnections = filterConnections;
  App.loadConnections = controller.load;
  App.clearConnections = controller.clear;
  App.renderConnections = controller.render;
  App.activateConnections = controller.activate;
  App.deactivateConnections = controller.deactivate;
  App.registerRendererModule('conns');
})();
