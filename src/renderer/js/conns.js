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

  let connectionsLoading = false;
  async function loadConnections() {
    if (connectionsLoading) return;
    connectionsLoading = true;
    try {
      const data = await api.getConnections();
      if (App.currentTab === 'conns' && !document.hidden) renderConnections(data);
    } catch (e) {
      /* ignore */
    } finally {
      connectionsLoading = false;
    }
  }
  function connRowInner(c) {
    const m = c.metadata || {};
    const host = m.host || m.destinationIP || '';
    const target = host + (m.destinationPort ? ':' + m.destinationPort : '');
    const chains = Array.isArray(c.chains) ? c.chains.slice().reverse().join(' → ') : '';
    const net = (m.network || '').toUpperCase();
    const netCls = net === 'TCP' ? ' tcp' : net === 'UDP' ? ' udp' : '';
    const netHtml = net ? `<span class="conn-net${netCls}">${escapeHtml(net)}</span>` : '';
    const closeHtml = c.id
      ? `<button class="conn-close" data-id="${escapeHtml(c.id)}" title="${t('conns.close')}">✕</button>`
      : '';
    return (
      `<div class="conn-main">` +
      `<span class="conn-host">${escapeHtml(target)}</span>` +
      `<span class="conn-sub">${netHtml}<span class="sub-meta">${escapeHtml(c.rule || '')}</span></span></div>` +
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
      html += `<div class="conn-item" data-connection-id="${escapeHtml(c.id || '')}">${connRowInner(c)}</div>`;
    }
    const after = connectionItems.length - end;
    if (after) html += `<div class="virtual-spacer" style="height:${after * VIRTUAL_CONNECTION_ROW_HEIGHT}px"></div>`;
    list.innerHTML = html;
  }

  function renderConnections(data) {
    const allConnections = data.connections || [];
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
    connectionItems = allConnections
      .slice()
      .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
    renderConnectionWindow();
  }

  function clearConnections() {
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
    try {
      await call(api.closeConnection, btn.dataset.id);
      toast(t('conns.closedOne'));
      loadConnections();
    } catch (_) {
      /* toast already shown by call() */
    }
  });

  let connScrollQueued = false;
  $('#connList').addEventListener('scroll', () => {
    if (connScrollQueued) return;
    connScrollQueued = true;
    requestAnimationFrame(() => {
      connScrollQueued = false;
      renderConnectionWindow();
    });
  });

  $('#connClose').addEventListener('click', async () => {
    await call(api.closeAllConnections);
    toast(t('conns.closed'));
    loadConnections();
  });

  App.loadConnections = loadConnections;
  App.clearConnections = clearConnections;
})();
