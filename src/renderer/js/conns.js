'use strict';
// Connections tab: live connection list with incremental row updates.
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;
  const MAX_RENDERED_CONNECTIONS = 500;

  let connectionsLoading = false;
  async function loadConnections() {
    if (connectionsLoading) return;
    connectionsLoading = true;
    try {
      const data = await api.getConnections();
      renderConnections(data);
    } catch (e) {
      /* ignore */
    } finally {
      connectionsLoading = false;
    }
  }
  // Incremental rendering keyed by connection id: rows are created once,
  // only the traffic counters mutate, and rows keep a stable position (new
  // connections enter at the top). Rebuilding the whole list every poll made
  // rows jump around (the Clash API does not return a stable order) and broke
  // text selection.
  const connRows = new Map(); // key -> { el, trafEl, up, down }
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
      `<span class="sub-meta conn-traffic"></span></div>${closeHtml}`
    );
  }
  function renderConnections(data) {
    const allConnections = data.connections || [];
    $('#connStats').textContent = t('conns.stats', allConnections.length, fmtBytes(data.up), fmtBytes(data.down));
    const list = $('#connList');
    if (!data.running || allConnections.length === 0) {
      connRows.clear();
      list.innerHTML = `<p class="hint">${t('conns.empty')}</p>`;
      return;
    }
    if (!connRows.size) list.innerHTML = ''; // leaving the empty-hint state
    // Oldest first, prepending each NEW row: newest connections end up on top
    // while existing rows never move.
    const conns = allConnections
      .slice()
      .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')))
      .slice(-MAX_RENDERED_CONNECTIONS);
    const seen = new Set();
    for (const c of conns) {
      const m = c.metadata || {};
      const key = c.id || (m.host || m.destinationIP || '') + ':' + (m.destinationPort || '') + '@' + (c.start || '');
      seen.add(key);
      let row = connRows.get(key);
      if (!row) {
        const el = document.createElement('div');
        el.className = 'conn-item';
        el.innerHTML = connRowInner(c);
        list.prepend(el);
        row = { el, trafEl: el.querySelector('.conn-traffic'), up: -1, down: -1 };
        connRows.set(key, row);
      }
      const up = c.upload || 0;
      const down = c.download || 0;
      if (up !== row.up || down !== row.down) {
        row.trafEl.textContent = `↑ ${fmtBytes(up)} ↓ ${fmtBytes(down)}`;
        row.up = up;
        row.down = down;
      }
    }
    for (const [key, row] of connRows) {
      if (!seen.has(key)) {
        row.el.remove();
        connRows.delete(key);
      }
    }
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

  $('#connClose').addEventListener('click', async () => {
    await call(api.closeAllConnections);
    toast(t('conns.closed'));
    loadConnections();
  });

  App.loadConnections = loadConnections;
})();
