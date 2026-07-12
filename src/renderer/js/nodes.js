'use strict';
// Nodes tab: node list rendering, node selection and latency testing.
(function () {
  const App = window.App;
  const { $, toast, escapeHtml } = App;
  const delays = App.delays;
  const api = window.api;
  const { t } = window.i18n;
  const NODE_COLUMNS = 2;
  const VIRTUAL_NODE_ROW_HEIGHT = 78;
  const VIRTUAL_OVERSCAN = 5;
  const AUTO_GROUP = '♻️ Auto';
  const FALLBACK_GROUP = '🛟 Fallback';
  let nodeRows = [];
  let filteredNodeCount = 0;

  let groupNow = { proxy: null, auto: null, fallback: null };
  let groupRefresh = null;
  let currentNodeFrame = 0;

  function currentNodeName() {
    if (!(App.state.status && App.state.status.running)) return '-';
    const selected = groupNow.proxy || App.state.selected || AUTO_GROUP;
    if (selected === AUTO_GROUP) return groupNow.auto || AUTO_GROUP;
    if (selected === FALLBACK_GROUP) return groupNow.fallback || FALLBACK_GROUP;
    return selected === 'direct' ? 'DIRECT' : selected;
  }

  function renderCurrentNode() {
    const el = $('#miniCurrentNode');
    if (el) {
      const name = currentNodeName();
      if (el.textContent !== name) el.textContent = name;
      el.title = name === '-' ? '' : name;
      if (!currentNodeFrame) {
        currentNodeFrame = requestAnimationFrame(() => {
          currentNodeFrame = 0;
          const viewport = el.parentElement;
          const overflow = Math.max(0, el.scrollWidth - viewport.clientWidth);
          el.style.setProperty('--node-offset', -overflow + 'px');
          el.style.setProperty('--node-scroll-duration', Math.max(6, 4 + overflow / 18) + 's');
          el.classList.toggle('scrolling', overflow > 3);
        });
      }
    }
    if (typeof App.renderDashNodeCards === 'function') App.renderDashNodeCards();
  }

  async function refreshGroupSelections() {
    if (groupRefresh) return groupRefresh;
    groupRefresh = (async () => {
      let next = { proxy: null, auto: null, fallback: null };
      if (App.state.status && App.state.status.running) {
        try { next = await api.getGroupSelections(App.currentTab === 'nodes'); } catch (_) {}
      }
      if (!(App.state.status && App.state.status.running)) next = {};
      next = {
        proxy: next && next.proxy || null,
        auto: next && next.auto || null,
        fallback: next && next.fallback || null,
      };
      const changed = next.proxy !== groupNow.proxy || next.auto !== groupNow.auto || next.fallback !== groupNow.fallback;
      groupNow = next;
      renderCurrentNode();
      if (changed && App.currentTab === 'nodes' && !document.hidden) renderNodes();
    })().finally(() => { groupRefresh = null; });
    return groupRefresh;
  }
  // Keep the sidebar current-node label fresh without waking a hidden window.
  setInterval(() => {
    if (!document.hidden && App.state.status && App.state.status.running) refreshGroupSelections();
  }, 5000);
  window.addEventListener('resize', renderCurrentNode);

  // Only the active profile's nodes are used (profiles are not merged), matching
  // the config the core actually runs. Returns the raw array (no copying).
  function activeNodes() {
    const sub = (App.state.subscriptions || []).find((s) => s.id === App.state.activeSub);
    return sub && Array.isArray(sub.nodes) ? sub.nodes : [];
  }

  function delayClass(v) {
    if (v === 'testing') return 'testing';
    if (v === 'timeout' || typeof v !== 'number') return 'bad';
    if (v < 200) return 'good';
    if (v < 500) return 'mid';
    return 'bad';
  }

  function delayText(v) {
    if (v === 'testing') return t('nodes.testing');
    if (v === 'timeout') return t('nodes.timeout');
    if (typeof v === 'number') return v + ' ms';
    return '';
  }

  function isActiveNode(name) {
    const sel = groupNow.proxy || App.state.selected;
    if (!sel) return name === AUTO_GROUP;
    return sel === name;
  }

  function nodeRowHtml(name, type, server, port) {
    const active = isActiveNode(name);
    const d = delays.get(name);
    const delayHtml =
      d !== undefined ? `<span class="node-delay ${delayClass(d)}">${delayText(d)}</span>` : '<span class="node-delay"></span>';
    // The urltest group's current pick: shown on the Auto row ("当前: X") and
    // as a ⚡ marker on that node's own row.
    let tagHtml = type ? `<span class="node-tag">${escapeHtml(String(type))}</span>` : '';
    if (server && groupNow.auto && name === groupNow.auto) tagHtml += '<span class="node-tag">⚡</span>';
    if (server && groupNow.fallback && name === groupNow.fallback) tagHtml += '<span class="node-tag">🛟</span>';
    let metaHtml = server ? `<span class="sub-meta">${escapeHtml(String(server))}:${escapeHtml(String(port))}</span>` : '';
    const selectedNow = name === AUTO_GROUP ? groupNow.auto : name === FALLBACK_GROUP ? groupNow.fallback : null;
    if (!server && selectedNow) {
      metaHtml = `<span class="sub-meta">${t('nodes.autoNow', escapeHtml(selectedNow))}</span>`;
    }
    const testHtml = server ? `<button class="node-test-btn" data-name="${escapeHtml(name)}">${t('nodes.test')}</button>` : '';
    const activeHtml = active ? `<span class="node-active">✓ ${t('nodes.active')}</span>` : '';
    return `<div class="node-item${active ? ' active' : ''}" data-name="${escapeHtml(name)}">
      <div class="node-top">
        <div class="node-identity"><span class="node-name">${escapeHtml(name)}</span>${tagHtml}</div>
        ${activeHtml}
      </div>
      <div class="node-bottom">${metaHtml}${delayHtml}${testHtml}</div>
    </div>`;
  }

  function virtualRange(list, total) {
    const totalRows = Math.ceil(total / NODE_COLUMNS);
    const visibleRows = Math.ceil((list.clientHeight || 480) / VIRTUAL_NODE_ROW_HEIGHT);
    const firstRow = Math.floor(Math.max(0, list.scrollTop - 10) / VIRTUAL_NODE_ROW_HEIGHT);
    const startRow = Math.max(0, firstRow - VIRTUAL_OVERSCAN);
    const endRow = Math.min(totalRows, startRow + visibleRows + VIRTUAL_OVERSCAN * 2);
    return {
      start: startRow * NODE_COLUMNS,
      end: Math.min(total, endRow * NODE_COLUMNS),
      startRow,
      endRow,
      totalRows,
    };
  }

  function renderNodeWindow() {
    const list = $('#nodeList');
    if (!list) return;
    if (!nodeRows.length) {
      list.innerHTML = `<p class="hint">${t('nodes.empty')}</p>`;
      return;
    }
    const { start, end, startRow, endRow, totalRows } = virtualRange(list, nodeRows.length);
    let html = startRow
      ? `<div class="virtual-spacer" style="height:${startRow * VIRTUAL_NODE_ROW_HEIGHT}px"></div>`
      : '';
    html += '<div class="node-grid-window">';
    for (let i = start; i < end; i++) {
      const n = nodeRows[i];
      html += nodeRowHtml(n.name, n.type, n.server, n.port);
    }
    html += '</div>';
    const afterRows = totalRows - endRow;
    if (afterRows) {
      html += `<div class="virtual-spacer" style="height:${afterRows * VIRTUAL_NODE_ROW_HEIGHT}px"></div>`;
    }
    if (!filteredNodeCount) html += `<p class="hint rule-more">${t('nodes.empty')}</p>`;
    list.innerHTML = html;
  }

  // Strategy groups stay first; manual nodes always retain profile order.
  function renderNodes() {
    const list = $('#nodeList');
    if (!list) return;
    const filter = ($('#nodeFilter').value || '').toLowerCase();
    const nodes = activeNodes().filter((n) => n.name.toLowerCase().includes(filter));
    filteredNodeCount = nodes.length;
    nodeRows = [{ name: AUTO_GROUP }, { name: FALLBACK_GROUP }, ...nodes];
    $('#nodeCount').textContent = t('nodes.count', nodes.length);
    renderNodeWindow();
  }
  $('#nodeList').addEventListener('click', (e) => {
    const tb = e.target.closest('.node-test-btn');
    if (tb) {
      e.stopPropagation();
      testOne(tb.dataset.name);
      return;
    }
    const row = e.target.closest('.node-item');
    if (row && row.dataset.name) selectNode(row.dataset.name);
  });

  async function selectNode(name) {
    try {
      await api.selectNode(name);
      App.state.selected = name;
      groupNow.proxy = name;
      renderNodes();
      renderCurrentNode();
      toast(t('toast.nodeSelected', name));
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }

  // Delay results patch the badge of the affected row IN PLACE. Rebuilding the
  // whole list on every result (the old approach) destroyed and recreated all
  // rows, which made the hovered row's highlight flicker for the entire run of
  // a test-all. Updates are still coalesced to one frame; rows hidden by the
  // filter (or a hidden tab) are simply skipped — the full render on tab show /
  // filter change picks their state up from the delays map.
  const dirtyDelays = new Set();
  let delayPatchQueued = false;
  function scheduleDelayUpdate(name) {
    dirtyDelays.add(name);
    if (delayPatchQueued) return;
    delayPatchQueued = true;
    requestAnimationFrame(() => {
      delayPatchQueued = false;
      if (typeof App.renderDashNodeCards === 'function' && !document.hidden) {
        App.renderDashNodeCards();
      }
      if (App.currentTab !== 'nodes' || document.hidden) {
        dirtyDelays.clear(); // renderNodes() on tab show covers these
        return;
      }
      const list = $('#nodeList');
      for (const n of dirtyDelays) {
        const row = list.querySelector(`.node-item[data-name="${CSS.escape(n)}"]`);
        const el = row && row.querySelector('.node-delay');
        if (!el) continue;
        const d = delays.get(n);
        el.className = 'node-delay ' + delayClass(d);
        el.textContent = delayText(d);
      }
      dirtyDelays.clear();
    });
  }

  async function testOne(name) {
    if (!App.state.status || !App.state.status.running) {
      toast(t('nodes.needRunning'), true);
      return;
    }
    if (!name || name === '-' || name === 'DIRECT' || name === 'direct') {
      toast(t('dash.noNode'), true);
      return;
    }
    delays.set(name, 'testing');
    scheduleDelayUpdate(name);
    try {
      const ms = await api.testNodeDelay(name);
      delays.set(name, ms);
    } catch (e) {
      delays.set(name, 'timeout');
    }
    scheduleDelayUpdate(name);
    refreshGroupSelections(); // a fresh delay result may make a group re-pick
  }

  async function testCurrentNodeDelay() {
    await refreshGroupSelections();
    const name = currentNodeName();
    await testOne(name);
  }

  let testAllRunning = false;
  async function testAll() {
    if (testAllRunning) return;
    if (!App.state.status || !App.state.status.running) {
      toast(t('nodes.needRunning'), true);
      return;
    }
    testAllRunning = true;
    const button = $('#testAllBtn');
    button.disabled = true;
    const names = activeNodes().map((n) => n.name);
    // Limited-concurrency pool to avoid hammering the core (and any shared
    // upstream server). User-configurable; clamp to a sane range.
    const concurrency = Math.max(1, Math.min(32, parseInt(App.state.settings.testConcurrency, 10) || 8));
    let idx = 0;
    names.forEach((nm) => {
      delays.set(nm, 'testing');
      scheduleDelayUpdate(nm);
    });
    async function worker() {
      while (idx < names.length) {
        const name = names[idx++];
        try {
          delays.set(name, await api.testNodeDelay(name));
        } catch (e) {
          delays.set(name, 'timeout');
        }
        scheduleDelayUpdate(name);
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
      refreshGroupSelections(); // the full sweep usually changes group picks
    } finally {
      testAllRunning = false;
      button.disabled = false;
    }
  }

  let nodeFilterTimer = null;
  $('#nodeFilter').addEventListener('input', () => {
    clearTimeout(nodeFilterTimer);
    nodeFilterTimer = setTimeout(() => {
      $('#nodeList').scrollTop = 0;
      renderNodes();
    }, 80);
  });
  let nodeScrollQueued = false;
  $('#nodeList').addEventListener('scroll', () => {
    if (nodeScrollQueued) return;
    nodeScrollQueued = true;
    requestAnimationFrame(() => {
      nodeScrollQueued = false;
      renderNodeWindow();
    });
  });
  $('#testAllBtn').addEventListener('click', testAll);

  App.activeNodes = activeNodes;
  App.renderNodes = renderNodes;
  App.currentNodeName = currentNodeName;
  App.renderCurrentNode = renderCurrentNode;
  App.refreshGroupSelections = refreshGroupSelections;
  App.testCurrentNodeDelay = testCurrentNodeDelay;
})();
