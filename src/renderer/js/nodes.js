'use strict';
// Nodes tab: node list rendering, node selection and latency testing.
(function () {
  const App = window.App;
  const { $, toast, escapeHtml } = App;
  const delays = App.delays;
  const api = window.api;
  const { t } = window.i18n;

  // The node the ♻️ Auto (urltest) group currently routes through, or null.
  let autoNow = null;
  async function refreshAutoNow() {
    let now = null;
    if (App.state.status && App.state.status.running) {
      try {
        now = await api.getAutoSelected();
      } catch (_) {
        /* keep null */
      }
    }
    if (now !== autoNow) {
      autoNow = now;
      if (App.currentTab === 'nodes' && !document.hidden) renderNodes();
    }
  }
  // urltest re-picks on its own schedule; keep the label fresh while visible.
  setInterval(() => {
    if (App.currentTab === 'nodes' && !document.hidden) refreshAutoNow();
  }, 5000);

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
    const sel = App.state.selected;
    if (!sel) return name === '♻️ Auto';
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
    if (server && autoNow && name === autoNow) tagHtml += '<span class="node-tag">⚡</span>';
    let metaHtml = server ? `<span class="sub-meta">${escapeHtml(String(server))}:${escapeHtml(String(port))}</span>` : '';
    if (!server && autoNow && name === '♻️ Auto') {
      metaHtml = `<span class="sub-meta">${t('nodes.autoNow', escapeHtml(autoNow))}</span>`;
    }
    const testHtml = server ? `<button class="node-test-btn" data-name="${escapeHtml(name)}">${t('nodes.test')}</button>` : '';
    const activeHtml = active ? `<span class="node-active">✓ ${t('nodes.active')}</span>` : '';
    return `<div class="node-item${active ? ' active' : ''}" data-name="${escapeHtml(name)}">
      <div><span class="node-name">${escapeHtml(name)}</span>${tagHtml}</div>
      <div class="node-right">${metaHtml}${delayHtml}${activeHtml}${testHtml}</div></div>`;
  }

  // Build the whole list as one HTML string (cheaper than per-row createElement);
  // clicks are handled by a single delegated listener attached once at startup.
  function renderNodes() {
    const list = $('#nodeList');
    if (!list) return;
    const filter = ($('#nodeFilter').value || '').toLowerCase();
    const nodes = activeNodes().filter((n) => n.name.toLowerCase().includes(filter));
    $('#nodeCount').textContent = t('nodes.count', nodes.length);
    // Always offer the automatic (urltest) selection at the top.
    let html = nodeRowHtml('♻️ Auto');
    if (nodes.length === 0) {
      list.innerHTML = html + `<p class="hint">${t('nodes.empty')}</p>`;
      return;
    }
    for (const n of nodes) html += nodeRowHtml(n.name, n.type, n.server, n.port);
    list.innerHTML = html;
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
      renderNodes();
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
    delays.set(name, 'testing');
    scheduleDelayUpdate(name);
    try {
      const ms = await api.testNodeDelay(name);
      delays.set(name, ms);
    } catch (e) {
      delays.set(name, 'timeout');
    }
    scheduleDelayUpdate(name);
    refreshAutoNow(); // a fresh delay result may make urltest re-pick
  }

  async function testAll() {
    if (!App.state.status || !App.state.status.running) {
      toast(t('nodes.needRunning'), true);
      return;
    }
    const names = activeNodes().map((n) => n.name);
    // Limited-concurrency pool to avoid hammering the core.
    const concurrency = 8;
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
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
    refreshAutoNow(); // the full sweep usually changes urltest's pick
  }

  $('#nodeFilter').addEventListener('input', renderNodes);
  $('#testAllBtn').addEventListener('click', testAll);

  App.activeNodes = activeNodes;
  App.renderNodes = renderNodes;
  App.refreshAutoNow = refreshAutoNow;
})();
