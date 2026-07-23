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
  const NODE_TEST_CONCURRENCY = 8;
  const AUTO_GROUP = '♻️ Auto';
  const SMART_GROUP = '🧠 Smart';
  const FALLBACK_GROUP = '🛟 Fallback';
  let nodeRows = [];
  let filteredNodeCount = 0;
  let nodeItems = [];
  let loadedNodeSub;
  let nodeLoad = null;
  let nodeLoadGeneration = 0;
  let testAllRun = null;
  const delayRequests = new Map();
  /** @type {Map<string, {grade:string,level:string,label?:string,score?:number|null}>} */
  const qualities = new Map();
  let qualityRefresh = null;

  let groupNow = { proxy: null, auto: null, smart: null, fallback: null, override: null, overrideGroup: null };
  let groupRefresh = null;
  let groupPollTimer = null;
  let currentNodeFrame = 0;
  let nodeWindowFrame = 0;
  let contextMenuEl = null;
  let contextMenuName = null;
  let contextMenuInvoker = null;

  function scheduleGroupPoll() {
    if (groupPollTimer) {
      clearTimeout(groupPollTimer);
      groupPollTimer = null;
    }
    if (document.hidden || !(App.state.status && App.state.status.running)) return;
    groupPollTimer = setTimeout(() => {
      groupPollTimer = null;
      refreshGroupSelections();
    }, 5000);
  }

  function currentNodeName() {
    if (!(App.state.status && App.state.status.running)) return '-';
    const selected = groupNow.proxy || App.state.selected || AUTO_GROUP;
    if (selected === AUTO_GROUP) return groupNow.auto || AUTO_GROUP;
    if (selected === SMART_GROUP) return groupNow.smart || SMART_GROUP;
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
    const profileId = App.state.activeSub || null;
    if (groupRefresh && groupRefresh.profileId === profileId) return groupRefresh.promise;
    const token = {};
    const promise = (async () => {
      let next = { proxy: null, auto: null, smart: null, fallback: null, override: null, overrideGroup: null };
      try {
        if (App.state.status && App.state.status.running) {
          next = await api.getGroupSelections(App.currentTab === 'nodes');
        } else if (api.getNodeOverride) {
          const ov = await api.getNodeOverride();
          next.override = ov && ov.override || null;
          next.overrideGroup = ov && ov.group || null;
        }
      } catch (_) {}
      if ((App.state.activeSub || null) !== profileId) return;
      next = {
        proxy: next && next.proxy || null,
        auto: next && next.auto || null,
        smart: next && next.smart || null,
        fallback: next && next.fallback || null,
        override: next && next.override || null,
        overrideGroup: next && next.overrideGroup || null,
      };
      const changed = next.proxy !== groupNow.proxy || next.auto !== groupNow.auto ||
        next.smart !== groupNow.smart || next.fallback !== groupNow.fallback ||
        next.override !== groupNow.override || next.overrideGroup !== groupNow.overrideGroup;
      groupNow = next;
      renderCurrentNode();
      if (changed && App.currentTab === 'nodes' && !document.hidden) renderNodes();
      // Pull Smart history often enough that background probes paint delay + labels
      // without requiring a manual "test" click.
      if (App.currentTab === 'nodes' && App.state.status && App.state.status.running) {
        refreshQualities();
      }
    })().finally(() => {
      if (groupRefresh && groupRefresh.token === token) {
        groupRefresh = null;
        scheduleGroupPoll();
      }
    });
    groupRefresh = { token, profileId, promise };
    return promise;
  }
  document.addEventListener('visibilitychange', scheduleGroupPoll);
  scheduleGroupPoll();
  window.addEventListener('resize', () => {
    renderCurrentNode();
    if (App.currentTab !== 'nodes' || nodeWindowFrame) return;
    nodeWindowFrame = requestAnimationFrame(() => {
      nodeWindowFrame = 0;
      renderNodeWindow();
    });
  });

  // Node details are loaded only while this tab is in use. Keeping them out of
  // the global state avoids cloning every node through app:getState.
  function activeNodes() {
    return loadedNodeSub === App.state.activeSub ? nodeItems : [];
  }

  function releaseNodes({ cancelTests = true } = {}) {
    hideNodeContextMenu();
    qualities.clear();
    if (cancelTests) {
      for (const name of delayRequests.keys()) {
        if (delays.get(name) === 'testing') delays.delete(name);
      }
      delayRequests.clear();
      if (testAllRun) testAllRun.cancelled = true;
      testAllRun = null;
      const testAllButton = $('#testAllBtn');
      if (testAllButton) testAllButton.disabled = false;
    }
    nodeLoadGeneration++;
    nodeLoad = null;
    nodeItems = [];
    loadedNodeSub = undefined;
    nodeRows = [];
    filteredNodeCount = 0;
    const list = $('#nodeList');
    if (list) list.textContent = '';
    const count = $('#nodeCount');
    if (count) count.textContent = '';
  }

  async function loadNodes(options = {}) {
    const activeSub = App.state.activeSub || null;
    if (!options.force && loadedNodeSub === activeSub) {
      renderNodes();
      refreshQualities();
      return nodeItems;
    }
    if (!activeSub) {
      nodeItems = [];
      loadedNodeSub = null;
      renderNodes();
      return nodeItems;
    }
    if (nodeLoad) return nodeLoad;

    const generation = ++nodeLoadGeneration;
    const request = (async () => {
      const result = await api.getNodes();
      if (generation !== nodeLoadGeneration || (result.activeSub || null) !== (App.state.activeSub || null)) return [];
      nodeItems = Array.isArray(result.nodes) ? result.nodes : [];
      loadedNodeSub = result.activeSub || null;
      renderNodes();
      refreshQualities();
      return nodeItems;
    })().catch(() => {
      if (generation === nodeLoadGeneration) releaseNodes();
      return [];
    }).finally(() => {
      if (nodeLoad === request) nodeLoad = null;
    });
    nodeLoad = request;
    return request;
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

  /**
   * Stability from Smart history only — never derived from the latest delay,
   * so the label does not just mirror the latency color.
   * Returns null when there is nothing useful to show (hide the label).
   *
   * kind: probing | good | mid | bad | unavailable
   */
  function qualityDisplay(name) {
    const smart = qualities.get(name);
    if (!smart || !smart.level || smart.level === 'unknown') return null;
    const samples = Math.max(0, Number(smart.samples) || 0);
    const level = smart.level;
    if (level === 'unavailable' || smart.failed) {
      return {
        kind: 'unavailable',
        label: t('nodes.quality.unavailable'),
        title: t('nodes.quality.hint.unavailable'),
        samples,
        showSamples: false,
      };
    }
    if (level === 'probing' || (samples > 0 && samples < 5 && level !== 'good' && level !== 'mid' && level !== 'bad')) {
      return {
        kind: 'probing',
        label: t('nodes.quality.probing'),
        title: t('nodes.quality.hint.probing', samples),
        samples,
        showSamples: samples > 0,
      };
    }
    if (level === 'good' || level === 'mid' || level === 'bad') {
      const label = level === 'good'
        ? t('nodes.quality.good')
        : level === 'mid'
          ? t('nodes.quality.ok')
          : t('nodes.quality.weak');
      const title = level === 'good'
        ? t('nodes.quality.hint.good', samples)
        : level === 'mid'
          ? t('nodes.quality.hint.ok', samples)
          : t('nodes.quality.hint.weak', samples);
      return { kind: level, label, title, samples, showSamples: samples > 0 };
    }
    return null;
  }

  function qualityHtmlFor(name) {
    const info = qualityDisplay(name);
    if (!info) return '';
    const meta = info.showSamples
      ? `<span class="node-quality-n">·${escapeHtml(String(info.samples))}</span>`
      : '';
    return `<span class="node-quality ${escapeHtml(info.kind)}" title="${escapeHtml(info.title)}" aria-label="${escapeHtml(info.title)}">${escapeHtml(info.label)}${meta}</span>`;
  }

  /** Apply background Smart EWMA into the delay map so UI is not "label without ms". */
  function syncDelayFromQuality(name, value) {
    if (!name || !value || delays.get(name) === 'testing') return false;
    if (Number.isFinite(value.ewma)) {
      const ms = Math.round(Number(value.ewma));
      if (delays.get(name) !== ms) {
        delays.set(name, ms);
        return true;
      }
      return false;
    }
    // Never succeeded and currently failing — same as a timed-out probe.
    if ((value.level === 'unavailable' || value.failed) && delays.get(name) === undefined) {
      delays.set(name, 'timeout');
      return true;
    }
    return false;
  }

  function patchNodeQuality(row, name) {
    const info = qualityDisplay(name);
    let qEl = row.querySelector('.node-quality');
    if (!info) {
      if (qEl) qEl.remove();
      return;
    }
    if (!qEl) {
      qEl = document.createElement('span');
      const delayEl = row.querySelector('.node-delay');
      const bottom = row.querySelector('.node-bottom');
      if (delayEl) delayEl.before(qEl);
      else if (bottom) bottom.appendChild(qEl);
      else return;
    }
    qEl.className = 'node-quality ' + info.kind;
    qEl.title = info.title;
    qEl.setAttribute('aria-label', info.title);
    qEl.textContent = '';
    qEl.appendChild(document.createTextNode(info.label));
    if (info.showSamples) {
      const n = document.createElement('span');
      n.className = 'node-quality-n';
      n.textContent = '·' + String(info.samples);
      qEl.appendChild(n);
    }
  }

  async function refreshQualities() {
    if (!api || !api.getNodeQualities) return;
    const profileId = App.state.activeSub || null;
    if (qualityRefresh && qualityRefresh.profileId === profileId) return qualityRefresh.promise;
    const token = {};
    const promise = (async () => {
      try {
        const map = await api.getNodeQualities();
        if (App.state.activeSub !== profileId) return;
        let qualityChanged = false;
        let delayChanged = false;
        const next = new Map();
        if (map && typeof map === 'object') {
          for (const [name, value] of Object.entries(map)) {
            if (!name || !value) continue;
            next.set(name, value);
            const prev = qualities.get(name);
            if (!prev
              || prev.level !== value.level
              || prev.samples !== value.samples
              || prev.failed !== value.failed
              || prev.ewma !== value.ewma) {
              qualityChanged = true;
            }
            if (syncDelayFromQuality(name, value)) delayChanged = true;
          }
        }
        if (next.size !== qualities.size) qualityChanged = true;
        qualities.clear();
        for (const [name, value] of next) qualities.set(name, value);
        if (delayChanged && typeof App.renderDashNodeCards === 'function' && !document.hidden) {
          App.renderDashNodeCards();
        }
        if ((qualityChanged || delayChanged) && App.currentTab === 'nodes' && !document.hidden) {
          renderNodeWindow();
        }
      } catch (_) {
        /* quality is advisory */
      } finally {
        if (qualityRefresh && qualityRefresh.token === token) qualityRefresh = null;
      }
    })();
    qualityRefresh = { token, profileId, promise };
    return promise;
  }

  function isActiveNode(name) {
    const sel = groupNow.proxy || App.state.selected;
    if (!sel) return name === AUTO_GROUP;
    return sel === name;
  }

  function protocolLabel(type, variant, security) {
    const key = String(type || '').toLowerCase();
    if (key === 'ss' && variant === '2022') return 'Shadowsocks 2022';
    if (key === 'vless' && variant === 'vision') return 'VLESS Vision';
    if (key === 'http' && security === 'TLS') return 'HTTPS';
    const labels = {
      ss: 'Shadowsocks',
      vmess: 'VMess',
      vless: 'VLESS',
      trojan: 'Trojan',
      hysteria: 'Hysteria',
      hysteria2: 'Hysteria2',
      tuic: 'TUIC',
      anytls: 'AnyTLS',
      socks: 'SOCKS5',
      socks5: 'SOCKS5',
      http: 'HTTP',
      https: 'HTTPS',
    };
    return labels[key] || (key ? key[0].toUpperCase() + key.slice(1) : '');
  }

  function cipherLabel(cipher, variant) {
    const value = String(cipher || '').trim();
    if (!value) return '';
    const concise = variant === '2022'
      ? value.replace(/^2022-blake3-/i, '')
      : value;
    return concise.toUpperCase();
  }

  function transportLabel(transport) {
    const labels = {
      ws: 'WebSocket',
      grpc: 'gRPC',
      http: 'HTTP/2',
      h2: 'HTTP/2',
      quic: 'QUIC',
    };
    const key = String(transport || '').toLowerCase();
    return labels[key] || (key ? key.toUpperCase() : '');
  }

  function pluginLabel(plugin) {
    const labels = {
      obfs: 'Simple Obfs',
      'simple-obfs': 'Simple Obfs',
      'obfs-local': 'Simple Obfs',
      'v2ray-plugin': 'V2Ray Plugin',
    };
    const key = String(plugin || '').toLowerCase();
    return labels[key] || '';
  }

  function nodeRowHtml(name, type, security, isNode, variant, cipher, transport, plugin) {
    const active = isActiveNode(name);
    const d = delays.get(name);
    const delayHtml =
      d !== undefined ? `<span class="node-delay ${delayClass(d)}">${delayText(d)}</span>` : '<span class="node-delay"></span>';
    // The automatic group's current pick: shown on the Auto row ("当前: X")
    // and as a marker on that node's own row.
    let tagHtml = '';
    if (isNode && groupNow.auto && name === groupNow.auto) tagHtml += '<span class="node-tag">⚡</span>';
    if (isNode && groupNow.smart && name === groupNow.smart) tagHtml += '<span class="node-tag">🧠</span>';
    if (isNode && groupNow.fallback && name === groupNow.fallback) tagHtml += '<span class="node-tag">🛟</span>';
    const isOverride = !!(isNode && groupNow.override && name === groupNow.override);
    if (isOverride) {
      const groupLabel = groupNow.overrideGroup === AUTO_GROUP
        ? t('nodes.override.tagAuto')
        : groupNow.overrideGroup === SMART_GROUP
          ? t('nodes.override.tagSmart')
          : t('nodes.override.tag');
      tagHtml += `<span class="node-tag node-tag-override" title="${escapeHtml(t('nodes.override.hint'))}">${escapeHtml(groupLabel)}</span>`;
    }
    const protocol = protocolLabel(type, variant, security);
    const details = isNode
      ? [
          protocol,
          cipherLabel(cipher, variant),
          protocol === 'HTTPS' ? '' : security,
          transportLabel(transport),
          pluginLabel(plugin),
        ].filter(Boolean).join(' · ')
      : '';
    let metaHtml = details ? `<span class="sub-meta">${escapeHtml(details)}</span>` : '';
    const selectedNow = name === AUTO_GROUP
      ? groupNow.auto
      : name === SMART_GROUP
        ? groupNow.smart
        : name === FALLBACK_GROUP ? groupNow.fallback : null;
    if (!isNode && selectedNow) {
      metaHtml = `<span class="sub-meta">${t('nodes.autoNow', escapeHtml(selectedNow))}</span>`;
    }
    const safeName = escapeHtml(name);
    // Stability short label + sample count (not a second latency traffic light).
    const qualityHtml = isNode ? qualityHtmlFor(name) : '';
    const testHtml = isNode
      ? `<button type="button" class="node-test-btn" data-name="${safeName}" aria-label="${escapeHtml(t('nodes.test') + ': ' + name)}">${t('nodes.test')}</button>`
      : '';
    const activeHtml = active ? `<span class="node-active">✓ ${t('nodes.active')}</span>` : '';
    return `<div class="node-item${active ? ' active' : ''}${isNode ? ' has-test' : ''}${isOverride ? ' is-override' : ''}" role="listitem" data-name="${safeName}" data-node="${isNode ? '1' : '0'}">
      <button type="button" class="node-select-btn" data-select-name="${safeName}" aria-pressed="${String(active)}">
      <span class="node-top">
        <span class="node-identity"><span class="node-name">${safeName}</span>${tagHtml}</span>
        ${activeHtml}
      </span>
      <span class="node-bottom">${metaHtml}${qualityHtml}${delayHtml}</span>
      </button>
      ${testHtml}
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
      html += nodeRowHtml(
        n.name,
        n.type,
        n.security,
        !!n.isNode,
        n.variant,
        n.cipher,
        n.transport,
        n.plugin
      );
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
    if (loadedNodeSub !== (App.state.activeSub || null)) {
      nodeRows = [];
      filteredNodeCount = 0;
      list.textContent = '';
      $('#nodeCount').textContent = '';
      return;
    }
    const filter = ($('#nodeFilter').value || '').toLowerCase();
    const nodes = activeNodes().filter((n) => String(n && n.name || '').toLowerCase().includes(filter));
    filteredNodeCount = nodes.length;
    nodeRows = App.state.activeSub
      ? [{ name: AUTO_GROUP }, { name: SMART_GROUP }, { name: FALLBACK_GROUP }, ...nodes]
      : [];
    $('#nodeCount').textContent = t('nodes.count', nodes.length);
    renderNodeWindow();
  }
  $('#nodeList').addEventListener('click', (e) => {
    hideNodeContextMenu();
    const tb = e.target.closest('.node-test-btn');
    if (tb) {
      e.stopPropagation();
      testOne(tb.dataset.name);
      return;
    }
    const selectButton = e.target.closest('.node-select-btn');
    if (selectButton && selectButton.dataset.selectName) {
      selectNode(selectButton.dataset.selectName, document.activeElement === selectButton);
    }
  });

  function ensureContextMenu() {
    if (contextMenuEl) return contextMenuEl;
    contextMenuEl = document.createElement('div');
    contextMenuEl.id = 'nodeContextMenu';
    contextMenuEl.className = 'node-context-menu hidden';
    contextMenuEl.setAttribute('role', 'menu');
    document.body.appendChild(contextMenuEl);
    contextMenuEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-override-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.overrideAct;
      const name = contextMenuName;
      hideNodeContextMenu();
      if (act === 'set' && name) setNodeOverride(name);
      else if (act === 'clear') clearNodeOverride();
    });
    contextMenuEl.addEventListener('keydown', (e) => {
      const items = [...contextMenuEl.querySelectorAll('.node-context-item')];
      const index = items.indexOf(document.activeElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'Escape') {
        e.preventDefault();
        hideNodeContextMenu(true);
        return;
      }
      if (next >= 0) {
        e.preventDefault();
        items[next].focus();
      }
    });
    return contextMenuEl;
  }

  function hideNodeContextMenu(restoreFocus = false) {
    if (!contextMenuEl) return;
    const invoker = contextMenuInvoker;
    contextMenuEl.classList.add('hidden');
    contextMenuEl.innerHTML = '';
    contextMenuName = null;
    contextMenuInvoker = null;
    if (restoreFocus && invoker && invoker.isConnected) invoker.focus({ preventScroll: true });
  }

  function showNodeContextMenu(clientX, clientY, name, isServerNode, invoker) {
    if (!isServerNode || !api.setNodeOverride) return;
    const menu = ensureContextMenu();
    contextMenuName = name;
    contextMenuInvoker = invoker || null;
    const override = groupNow.override;
    let html = `<button type="button" class="node-context-item" role="menuitem" data-override-act="set">${escapeHtml(t('nodes.override.menu'))}</button>`;
    if (override) {
      html += `<button type="button" class="node-context-item" role="menuitem" data-override-act="clear">${escapeHtml(t('nodes.override.clearMenu'))}</button>`;
    }
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    const anchor = invoker && invoker.getBoundingClientRect ? invoker.getBoundingClientRect() : null;
    const x = clientX > 0 ? clientX : (anchor ? anchor.left + 24 : pad);
    const y = clientY > 0 ? clientY : (anchor ? anchor.top + 24 : pad);
    const left = Math.min(x, window.innerWidth - rect.width - pad);
    const top = Math.min(y, window.innerHeight - rect.height - pad);
    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';
    const first = menu.querySelector('.node-context-item');
    if (first) first.focus({ preventScroll: true });
  }

  $('#nodeList').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.node-item');
    if (!item || item.dataset.node !== '1') {
      hideNodeContextMenu();
      return;
    }
    e.preventDefault();
    const name = item.dataset.name;
    if (!name) return;
    showNodeContextMenu(e.clientX, e.clientY, name, true, item.querySelector('.node-select-btn'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNodeContextMenu(true);
  });
  document.addEventListener('pointerdown', (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) hideNodeContextMenu();
  }, true);
  window.addEventListener('blur', hideNodeContextMenu);
  window.addEventListener('resize', hideNodeContextMenu);

  async function setNodeOverride(name) {
    const profileId = App.state.activeSub || null;
    try {
      const result = await api.setNodeOverride(name);
      if ((App.state.activeSub || null) !== profileId) return;
      groupNow.override = result && result.override || name;
      groupNow.overrideGroup = result && result.group || null;
      toast(t('toast.nodeOverride', name));
      if (App.currentTab === 'nodes' && !document.hidden) renderNodes();
      refreshGroupSelections();
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }

  async function clearNodeOverride() {
    const profileId = App.state.activeSub || null;
    try {
      await api.clearNodeOverride();
      if ((App.state.activeSub || null) !== profileId) return;
      groupNow.override = null;
      groupNow.overrideGroup = null;
      toast(t('toast.nodeOverrideCleared'));
      if (App.currentTab === 'nodes' && !document.hidden) renderNodes();
      refreshGroupSelections();
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }

  async function selectNode(name, restoreFocus = false) {
    try {
      await api.selectNode(name);
      App.state.selected = name;
      groupNow.proxy = name;
      renderNodes();
      renderCurrentNode();
      if (restoreFocus) {
        requestAnimationFrame(() => {
          const button = Array.from(document.querySelectorAll('.node-select-btn'))
            .find((candidate) => candidate.dataset.selectName === name);
          if (button) button.focus({ preventScroll: true });
        });
      }
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
        if (!row) continue;
        const el = row.querySelector('.node-delay');
        if (el) {
          const d = delays.get(n);
          el.className = 'node-delay' + (d !== undefined ? ' ' + delayClass(d) : '');
          el.textContent = delayText(d);
        }
        patchNodeQuality(row, n);
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
    const token = {};
    delayRequests.set(name, token);
    delays.set(name, 'testing');
    scheduleDelayUpdate(name);
    try {
      // Manual clicks always force a real probe (background Auto/Smart still cache).
      const ms = await api.testNodeDelay(name, { force: true });
      if (delayRequests.get(name) === token) delays.set(name, ms);
    } catch (e) {
      if (delayRequests.get(name) === token) delays.set(name, 'timeout');
    }
    if (delayRequests.get(name) === token) {
      delayRequests.delete(name);
      scheduleDelayUpdate(name);
      refreshQualities();
      refreshGroupSelections(); // a fresh delay result may make a group re-pick
    }
  }

  async function testCurrentNodeDelay() {
    await refreshGroupSelections();
    const name = currentNodeName();
    await testOne(name);
  }

  async function testAll() {
    if (testAllRun) return;
    if (!App.state.status || !App.state.status.running) {
      toast(t('nodes.needRunning'), true);
      return;
    }
    const run = { cancelled: false, inFlight: new Set() };
    testAllRun = run;
    const button = $('#testAllBtn');
    button.disabled = true;
    await loadNodes();
    if (run.cancelled) return;
    const names = activeNodes().map((n) => n && n.name).filter(Boolean);
    // Bounded pool avoids hammering the core and shared upstream endpoints.
    const concurrency = Math.min(NODE_TEST_CONCURRENCY, Math.max(1, names.length));
    let idx = 0;
    let bestName = null;
    let bestDelay = Infinity;
    async function worker() {
      while (!run.cancelled && idx < names.length) {
        const name = names[idx++];
        const token = {};
        delayRequests.set(name, token);
        run.inFlight.add(name);
        delays.set(name, 'testing');
        scheduleDelayUpdate(name);
        try {
          const result = await api.testNodeDelay(name, { force: true });
          if (!run.cancelled && delayRequests.get(name) === token) {
            delays.set(name, result);
            if (result < bestDelay) {
              bestDelay = result;
              bestName = name;
            }
          }
        } catch (e) {
          if (!run.cancelled && delayRequests.get(name) === token) delays.set(name, 'timeout');
        } finally {
          run.inFlight.delete(name);
        }
        if (!run.cancelled && delayRequests.get(name) === token) {
          delayRequests.delete(name);
          scheduleDelayUpdate(name);
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
      if (!run.cancelled && bestName && api.applyAutoCandidate) {
        try { await api.applyAutoCandidate(bestName); } catch (e) {
          toast(e.message || String(e), true);
        }
      }
      if (!run.cancelled) {
        await refreshQualities();
        await refreshGroupSelections();
      }
    } finally {
      if (testAllRun === run) {
        testAllRun = null;
        button.disabled = false;
      }
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

  App.loadNodes = loadNodes;
  App.releaseNodes = releaseNodes;
  App.renderNodes = renderNodes;
  App.currentNodeName = currentNodeName;
  App.renderCurrentNode = renderCurrentNode;
  App.refreshGroupSelections = refreshGroupSelections;
  App.testCurrentNodeDelay = testCurrentNodeDelay;
})();
