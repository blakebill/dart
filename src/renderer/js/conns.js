'use strict';
// Connections tab: live connection list with incremental row updates.
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;
  const VIRTUAL_CONNECTION_ROW_HEIGHT = 62;
  const VIRTUAL_OVERSCAN = 7;
  let connectionItems = [];
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

  function connectionLabel(value) {
    const text = String(value || '');
    return CONNECTION_LABELS[text.toLowerCase()] || text;
  }

  let connectionsRequest = null;
  let connectionsGeneration = 0;
  async function loadConnections() {
    const generation = connectionsGeneration;
    if (connectionsRequest && connectionsRequest.generation === generation) {
      return connectionsRequest.promise;
    }
    const token = {};
    const promise = (async () => {
      try {
        const data = await api.getConnections();
        if (generation !== connectionsGeneration) return data;
        if (App.currentTab !== 'conns' || document.hidden) return data;
        // Let the tab chrome paint before building the virtual list.
        await new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
          else setTimeout(resolve, 0);
        });
        if (
          generation === connectionsGeneration &&
          App.currentTab === 'conns' &&
          !document.hidden
        ) renderConnections(data);
        return data;
      } catch (e) {
        /* ignore */
        return null;
      } finally {
        if (connectionsRequest && connectionsRequest.token === token) connectionsRequest = null;
      }
    })();
    connectionsRequest = { token, generation, promise };
    return promise;
  }
  function connRowInner(c) {
    const m = c.metadata || {};
    const host = m.host || m.destinationIP || '';
    const target = host + (m.destinationPort ? ':' + m.destinationPort : '');
    const chains = Array.isArray(c.chains)
      ? c.chains.slice().reverse().map(connectionLabel).join(' → ')
      : '';
    const net = (m.network || '').toUpperCase();
    const netCls = net === 'TCP' ? ' tcp' : net === 'UDP' ? ' udp' : '';
    const netHtml = net ? `<span class="conn-net${netCls}">${escapeHtml(net)}</span>` : '';
    const closeHtml = c.id
      ? `<button type="button" class="conn-close" data-id="${escapeHtml(c.id)}" aria-label="${escapeHtml(t('conns.close') + ': ' + target)}" title="${escapeHtml(t('conns.close'))}">✕</button>`
      : '';
    return (
      `<div class="conn-main">` +
      `<span class="conn-host">${escapeHtml(target)}</span>` +
      `<span class="conn-sub">${netHtml}<span class="sub-meta">${escapeHtml(connectionLabel(c.rule))}</span></span></div>` +
      `<div class="conn-right"><span class="conn-chains">${escapeHtml(chains)}</span>` +
      `<span class="sub-meta conn-traffic">↑ ${fmtBytes(c.upload || 0)} ↓ ${fmtBytes(c.download || 0)}</span></div>${closeHtml}`
    );
  }

  function renderConnectionWindow() {
    const list = $('#connList');
    if (!connectionItems.length) return;
    const visible = Math.ceil((list.clientHeight || 480) / VIRTUAL_CONNECTION_ROW_HEIGHT);
    const start = Math.max(0, Math.floor(list.scrollTop / VIRTUAL_CONNECTION_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    const end = Math.min(connectionItems.length, start + visible + VIRTUAL_OVERSCAN * 2);
    let html = start ? `<div class="virtual-spacer" style="height:${start * VIRTUAL_CONNECTION_ROW_HEIGHT}px"></div>` : '';
    for (let i = start; i < end; i++) {
      const c = connectionItems[i];
      html += `<div class="conn-item" role="listitem" data-connection-id="${escapeHtml(c.id || '')}">${connRowInner(c)}</div>`;
    }
    const after = connectionItems.length - end;
    if (after) html += `<div class="virtual-spacer" style="height:${after * VIRTUAL_CONNECTION_ROW_HEIGHT}px"></div>`;
    list.innerHTML = html;
  }

  function renderConnections(data) {
    const allConnections = Array.isArray(data.connections) ? data.connections : [];
    $('#connStats').textContent = t(
      'conns.stats',
      Number.isFinite(data.totalConnections) ? data.totalConnections : allConnections.length,
      fmtBytes(data.up),
      fmtBytes(data.down)
    );
    const list = $('#connList');
    if (!data.running || allConnections.length === 0) {
      connectionItems = [];
      list.classList.add('is-empty');
      list.innerHTML = `<p class="hint conn-empty-state">${t('conns.empty')}</p>`;
      return;
    }
    list.classList.remove('is-empty');
    connectionItems = allConnections;
    renderConnectionWindow();
  }

  function clearConnections() {
    connectionsGeneration++;
    connectionItems = [];
    const list = $('#connList');
    list.classList.remove('is-empty');
    list.textContent = '';
    $('#connStats').textContent = '';
  }
  // Per-connection close: rows come and go with every poll, so use one
  // delegated listener instead of binding each ✕ button.
  $('#connList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.conn-close');
    if (!btn || !btn.dataset.id) return;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await call(api.closeConnection, btn.dataset.id);
      toast(t('conns.closedOne'));
      loadConnections();
    } catch (_) {
      /* toast already shown by call() */
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
  });

  let connRenderQueued = false;
  function queueConnectionRender() {
    if (connRenderQueued) return;
    connRenderQueued = true;
    requestAnimationFrame(() => {
      connRenderQueued = false;
      renderConnectionWindow();
    });
  }
  $('#connList').addEventListener('scroll', queueConnectionRender);
  window.addEventListener('resize', () => {
    if (App.currentTab === 'conns') queueConnectionRender();
  });

  $('#connClose').addEventListener('click', async () => {
    try {
      await call(api.closeAllConnections);
      toast(t('conns.closed'));
      loadConnections();
    } catch (_) {}
  });

  App.loadConnections = loadConnections;
  App.clearConnections = clearConnections;
})();
