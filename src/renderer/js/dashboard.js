'use strict';
// Dashboard: status cards, traffic usage, mode/proxy/TUN controls, theme toggle.
(function () {
  const App = window.App;
  const { $, $$, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  function delayClass(v) {
    if (v === 'testing') return 'delay-testing';
    if (v === 'timeout' || (v !== undefined && typeof v !== 'number')) return 'delay-bad';
    if (typeof v !== 'number') return '';
    if (v < 200) return 'delay-good';
    if (v < 500) return 'delay-mid';
    return 'delay-bad';
  }

  function delayText(v) {
    if (v === 'testing') return t('nodes.testing');
    if (v === 'timeout') return t('nodes.timeout');
    if (typeof v === 'number') return v + ' ms';
    return '';
  }

  function setSwitch(el, on, disabled) {
    if (!el) return;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.classList.toggle('is-on', !!on);
    if (disabled !== undefined) el.disabled = !!disabled;
  }

  function setText(el, text, color) {
    if (!el) return;
    el.textContent = text;
    if (color !== undefined) el.style.color = color;
  }

  function renderDashNodeCards() {
    const nodeEl = $('#dashNode');
    const delayEl = $('#dashDelay');
    if (!nodeEl || !delayEl) return;

    const running = !!(App.state.status && App.state.status.running);
    const raw = running && typeof App.currentNodeName === 'function' ? App.currentNodeName() : '';
    const hasNode = !!(running && raw && raw !== '-');
    const name = running ? (hasNode ? raw : t('dash.noNode')) : t('dash.needRunning');
    nodeEl.textContent = name;
    nodeEl.title = name;
    nodeEl.className = 'card-value';

    if (!running || !raw || raw === '-') {
      delayEl.textContent = running ? t('dash.noDelay') : t('dash.needRunning');
      delayEl.className = '';
      return;
    }

    const delayVal = App.delays && App.delays.get(raw);
    if (delayVal === undefined) {
      delayEl.textContent = t('dash.noDelay');
      delayEl.className = '';
      return;
    }
    delayEl.textContent = delayText(delayVal) || t('dash.noDelay');
    delayEl.className = delayClass(delayVal);
  }

  function renderDashboard() {
    const st = App.state.status || {};
    const active = (App.state.subscriptions || []).find((s) => s.id === App.state.activeSub);
    setText($('#dashRunning'), st.running ? t('status.running') : t('status.stopped'),
      st.running ? 'var(--green)' : 'var(--text-dim)');
    setText($('#dashProxy'), st.systemProxy ? t('state.on') : t('state.off'),
      st.systemProxy ? 'var(--green)' : 'var(--text-dim)');
    const coreCard = $('#dashCoreCard');
    const proxyCard = $('#dashProxyCard');
    if (coreCard) coreCard.setAttribute('aria-pressed', String(!!st.running));
    if (proxyCard) proxyCard.setAttribute('aria-pressed', String(!!st.systemProxy));
    renderDashNodeCards();
    if (!st.running) setText($('#dashConnections'), '0');

    const coreHint = $('#coreHint');
    if (coreHint) {
      const missing = !st.coreInstalled;
      coreHint.textContent = missing ? t('dash.coreHint') : '';
      coreHint.hidden = !missing;
    }

    const proxyOn = !!st.systemProxy;
    setSwitch($('#quickProxy'), proxyOn, !st.running && !proxyOn);
    setSwitch($('#quickTun'), !!(App.state.settings && App.state.settings.enableTun));

    const topCore = $('#topCore');
    if (topCore) {
      topCore.textContent = st.coreName || 'Mihomo';
    }
    const topProfile = $('#topProfile');
    if (topProfile) {
      const profileName = active ? active.name : '-';
      topProfile.textContent = profileName;
      topProfile.title = profileName;
    }
    const topDot = $('#topStatusDot');
    if (topDot) topDot.className = 'status-dot ' + (st.running ? 'on' : 'off');
    renderDashboardQuality();
  }

  function renderDashboardQuality() {
    const st = App.state.status || {};
    const delays = App.delays instanceof Map ? App.delays : new Map();
    const currentName = st.running && typeof App.currentNodeName === 'function' ? App.currentNodeName() : '';
    const currentDelay = currentName ? delays.get(currentName) : undefined;
    const values = Array.from(delays.values());
    const measured = values.filter((value) => value !== 'testing').length;
    const healthy = values.filter((value) => Number.isFinite(value) && value > 0).length;
    const mode = (App.state.settings && App.state.settings.clashMode) || 'rule';

    setText($('#qualityLatency'), Number.isFinite(currentDelay) ? `${currentDelay} ms` : '—');
    setText($('#qualityMeasured'), String(measured));
    setText($('#qualityHealthy'), String(healthy));
    setText($('#qualityMode'), t('mode.' + mode));

    let level = 'unknown';
    if (!st.running) level = 'offline';
    else if (Number.isFinite(currentDelay)) {
      if (currentDelay < 200) level = 'good';
      else if (currentDelay < 500) level = 'fair';
      else level = 'poor';
    }
    const badge = $('#qualityBadge');
    if (badge) {
      badge.className = `quality-badge is-${level}`;
      badge.textContent = t('dash.quality' + level[0].toUpperCase() + level.slice(1));
    }
  }

  function renderStatus() {
    const st = App.state.status || {};
    $('#statusDot').className = 'status-dot ' + (st.running ? 'on' : 'off');
    const dot = document.querySelector('.logo-dot');
    if (dot) dot.classList.toggle('running', !!st.running);
    $('#statusText').textContent = st.running ? t('status.running') : t('status.stopped');
    const pb = $('#powerBtn');
    pb.textContent = st.running ? t('power.stop') : t('power.start');
    pb.classList.toggle('running', !!st.running);
    renderDashboard();
  }

  function renderMode() {
    const mode = (App.state.settings && App.state.settings.clashMode) || 'rule';
    $$('.mode-btn').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('primary', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function usageLevel(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 75) return 'warn';
    return '';
  }

  function usageStats(sub) {
    const u = (sub && sub.userInfo) || {};
    const used = (u.upload || 0) + (u.download || 0);
    const total = u.total || 0;
    const pct = total ? Math.min(100, (used / total) * 100) : 0;
    const remain = total > 0 ? Math.max(0, total - used) : null;
    let daysLeft = null;
    if (u.expire) daysLeft = Math.ceil((u.expire * 1000 - Date.now()) / 86400000);
    return { used, total, pct, remain, daysLeft, expire: u.expire || 0 };
  }

  function usageExpireLabel(st, locale) {
    if (st.daysLeft != null) {
      if (st.daysLeft < 0) return t('usage.expired');
      if (st.daysLeft === 0) return t('usage.expiresToday');
      return t('usage.daysLeft', st.daysLeft);
    }
    if (st.expire) return t('subs.expire', new Date(st.expire * 1000).toLocaleDateString(locale));
    return '';
  }

  function renderUsageFeatured(sub, { showBadge, emptyHint, locale }) {
    const name = escapeHtml(sub.name || '');
    const badge = showBadge
      ? `<span class="usage-badge">${escapeHtml(t('usage.current'))}</span>`
      : '';
    if (emptyHint || !sub.userInfo) {
      return `
        <div class="usage-featured usage-featured-empty">
          <div class="usage-featured-title">
            ${badge}
            <span class="usage-name" title="${name}">${name}</span>
          </div>
          <p class="hint">${escapeHtml(emptyHint || t('usage.activeNone'))}</p>
        </div>`;
    }
    const st = usageStats(sub);
    const level = usageLevel(st.pct);
    const pctLabel = st.total ? `${st.pct >= 10 ? st.pct.toFixed(0) : st.pct.toFixed(1)}%` : '—';
    const usedLabel = st.total
      ? `${fmtBytes(st.used)} / ${fmtBytes(st.total)}`
      : `${fmtBytes(st.used)} / ∞`;
    const remainLabel = st.total ? t('usage.remain', fmtBytes(st.remain)) : t('usage.unlimited');
    const expireLabel = usageExpireLabel(st, locale);
    const expireWarn = st.daysLeft != null && st.daysLeft <= 7;
    return `
      <div class="usage-featured${level ? ' is-' + level : ''}">
        <div class="usage-featured-head">
          <div class="usage-featured-title">
            ${badge}
            <span class="usage-name" title="${name}">${name}</span>
          </div>
          <span class="usage-pct">${escapeHtml(pctLabel)}</span>
        </div>
        <div class="usage-bar usage-bar-lg" role="progressbar" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct.toFixed(1)}" aria-valuetext="${escapeHtml(usedLabel)}"><div class="usage-fill" style="width:${st.pct}%"></div></div>
        <div class="usage-featured-meta">
          <span>${escapeHtml(usedLabel)}</span>
          <span>${escapeHtml(remainLabel)}</span>
          ${expireLabel ? `<span class="usage-expire${expireWarn ? ' is-warn' : ''}">${escapeHtml(expireLabel)}</span>` : ''}
        </div>
      </div>`;
  }

  function renderUsageOthers(subs) {
    if (!subs.length) return '';
    const visible = subs.slice(0, 2);
    const hidden = Math.max(0, subs.length - visible.length);
    let html = `<div class="usage-others-label">${escapeHtml(t('usage.others'))}</div><div class="usage-others">`;
    for (const s of visible) {
      const o = usageStats(s);
      const ol = usageLevel(o.pct);
      const meta = o.total
        ? `${fmtBytes(o.used)} / ${fmtBytes(o.total)}`
        : `${fmtBytes(o.used)} / ∞`;
      html += `
        <div class="usage-item${ol ? ' is-' + ol : ''}">
          <div class="usage-top">
            <span class="usage-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
            <span class="sub-meta">${escapeHtml(meta)}</span>
          </div>
          <div class="usage-bar" role="progressbar" aria-label="${escapeHtml(s.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${o.pct.toFixed(1)}" aria-valuetext="${escapeHtml(meta)}"><div class="usage-fill" style="width:${o.pct}%"></div></div>
        </div>`;
    }
    html += '</div>';
    if (hidden) html += `<div class="usage-more">${escapeHtml(t('usage.more', hidden))}</div>`;
    return html;
  }

  function renderUsage() {
    const list = $('#usageList');
    if (!list) return;
    const all = App.state.subscriptions || [];
    const withInfo = all.filter((s) => s.userInfo);
    if (!withInfo.length) {
      list.innerHTML = `<p class="hint">${t('usage.none')}</p>`;
      return;
    }

    const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
    const activeId = App.state.activeSub;
    const activeWithInfo = withInfo.find((s) => s.id === activeId) || null;
    const activeBare = activeId ? all.find((s) => s.id === activeId) : null;

    let html = '';
    let secondary = withInfo;

    if (activeWithInfo) {
      html += renderUsageFeatured(activeWithInfo, { showBadge: true, locale });
      secondary = withInfo.filter((s) => s.id !== activeWithInfo.id);
    } else if (activeBare) {
      html += renderUsageFeatured(activeBare, { showBadge: true, emptyHint: t('usage.activeNone'), locale });
      secondary = withInfo;
    } else {
      html += renderUsageFeatured(withInfo[0], { showBadge: false, locale });
      secondary = withInfo.slice(1);
    }

    html += renderUsageOthers(secondary);
    list.innerHTML = html;
  }

  const dashboardActions = new Map();
  function runDashboardAction(name, action) {
    if (dashboardActions.has(name)) return dashboardActions.get(name);
    const operation = Promise.resolve().then(action).finally(() => dashboardActions.delete(name));
    dashboardActions.set(name, operation);
    return operation;
  }

  function togglePower() {
    return runDashboardAction('power', async () => {
      if (App.state.status && App.state.status.running) {
        await call(api.stopCore);
      } else {
        await call(api.startCore);
        toast(t('toast.started'));
      }
    });
  }

  function toggleSystemProxy() {
    return runDashboardAction('proxy', async () => {
      const proxySw = $('#quickProxy');
      if (proxySw && proxySw.disabled) {
        toast(t('nodes.needRunning'), true);
        return;
      }
      const on = !!(App.state.status && App.state.status.systemProxy);
      await call(api.setSystemProxy, !on);
      toast(!on ? t('toast.proxyOn') : t('toast.proxyOff'));
    });
  }

  function dashboardButtonAction(button, action) {
    if (!button || button.disabled) return;
    const operation = runDashboardAction(button.id, async () => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await action();
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
    operation.catch(() => {});
  }

  function eventLevel(line) {
    if (/\b(ERROR|FATAL|PANIC)\b/i.test(line)) return 'error';
    if (/\b(WARN|WARNING)\b/i.test(line)) return 'warn';
    return 'info';
  }

  function eventText(line) {
    return String(line || '')
      .replace(/^\[gui\]\s*/i, '')
      .replace(/^time=(?:"[^"]+"|\S+)\s+level=(?:"?[a-z]+"?)\s+msg=/i, '')
      .replace(/^[+-]\d{4}\s+/, '')
      .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\s*/i, '')
      .replace(/^"(.*)"$/, '$1')
      .trim();
  }

  function eventTime(line) {
    const matched = String(line || '').match(/(?:\d{4}-\d{2}-\d{2}[ T]|T)(\d{2}:\d{2}:\d{2})/);
    return matched ? matched[1] : '';
  }

  let dashboardEventGeneration = 0;
  let dashboardConnectionGeneration = 0;
  async function loadDashboardConnections() {
    const value = $('#dashConnections');
    if (!value) return null;
    if (!(App.state.status && App.state.status.running)) {
      value.textContent = '0';
      return { running: false, totalConnections: 0 };
    }
    const generation = ++dashboardConnectionGeneration;
    try {
      const data = api && api.getConnectionSummary ? await api.getConnectionSummary() : null;
      if (generation !== dashboardConnectionGeneration || App.currentTab !== 'dashboard') return data;
      const count = data && Number.isFinite(data.totalConnections) ? data.totalConnections : 0;
      value.textContent = String(Math.max(0, count));
      return data;
    } catch (_) {
      if (generation === dashboardConnectionGeneration && App.currentTab === 'dashboard') value.textContent = '—';
      return null;
    }
  }

  async function loadDashboardEvents() {
    const list = $('#dashboardEventList');
    if (!list) return;
    const generation = ++dashboardEventGeneration;
    let entries = [];
    try {
      const snapshot = api && api.getRecentLogs ? await api.getRecentLogs() : null;
      entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
    } catch (_) {
      entries = [];
    }
    if (generation !== dashboardEventGeneration || !list.isConnected) return;
    const important = entries
      .map((entry) => String(entry && typeof entry === 'object' ? entry.line || '' : entry || ''))
      .filter((line) => /^\[gui\]/i.test(line) || /\b(WARN|WARNING|ERROR|FATAL|PANIC)\b/i.test(line))
      .slice(-6)
      .reverse();

    list.textContent = '';
    if (!important.length) {
      const empty = document.createElement('p');
      empty.className = 'dashboard-empty';
      empty.textContent = t('dash.noEvents');
      list.appendChild(empty);
      return;
    }
    for (const line of important) {
      const row = document.createElement('div');
      const level = eventLevel(line);
      row.className = `dashboard-event is-${level}`;
      const dot = document.createElement('span');
      dot.className = 'dashboard-event-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'dashboard-event-text';
      text.textContent = eventText(line);
      text.title = text.textContent;
      const time = document.createElement('time');
      time.className = 'dashboard-event-time';
      time.textContent = eventTime(line);
      row.append(dot, text, time);
      list.appendChild(row);
    }
  }

  $('#powerBtn').addEventListener('click', () => togglePower().catch(() => {}));
  $('#quickProxy').addEventListener('click', () => toggleSystemProxy().catch(() => {}));

  $('#quickTun').addEventListener('click', () => {
    runDashboardAction('tun', async () => {
      const next = !(App.state.settings && App.state.settings.enableTun);
      const r = await call(api.setTun, next);
      if (r && r.restarting) return;
      if (r && r.settings) App.commitSettings(r.settings);
      renderDashboard();
      toast(App.state.settings.enableTun ? t('toast.tunOn') : t('toast.tunOff'));
    }).catch(() => {});
  });

  $('#dashTestAll').addEventListener('click', (event) => {
    dashboardButtonAction(event.currentTarget, async () => {
      await App.ensureTabModules('nodes');
      if (App.testAllNodes) await App.testAllNodes();
      renderDashboardQuality();
      await loadDashboardEvents();
    });
  });

  $('#dashUpdateProfile').addEventListener('click', (event) => {
    dashboardButtonAction(event.currentTarget, async () => {
      const id = App.state.activeSub;
      if (!id) {
        toast(t('dash.noActiveProfile'), true);
        return;
      }
      await call(api.updateSubscription, { id });
      toast(t('toast.subUpdated'));
      if (App.refresh) await App.refresh();
      await loadDashboardEvents();
    });
  });

  $('#dashDiagnostics').addEventListener('click', () => App.openDialog('diagnostics'));
  $('#dashOpenPanel').addEventListener('click', () => {
    call(api.openClashApi).catch(() => {});
  });
  $('#dashViewLogs').addEventListener('click', () => {
    if (App.showTab) App.showTab('logs');
  });

  const THEME_ORDER = ['system', 'light', 'dark'];
  function renderThemeLabel() {
    const span = $('#themeLabel');
    if (span) span.textContent = t('theme.' + (App.themePref || 'system'));
  }
  $('#themeBtn').addEventListener('click', async () => {
    const cur = App.themePref || App.state.settings.theme || 'system';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    App.themePref = next;
    if (App.renderThemeLabel) App.renderThemeLabel();
    App.patchSettings({ theme: next });
    if (!api || !api.updateSettings) {
      App.applyTheme(next);
      return;
    }
    try {
      // Persist first so main can set nativeTheme.themeSource before we resolve
      // 'system' — otherwise matchMedia still reports the previous forced scheme.
      const result = await call(api.updateSettings, { theme: next });
      const effective = result && result.themeEffective;
      const settings = result && typeof result === 'object' ? { ...result } : result;
      if (settings && Object.prototype.hasOwnProperty.call(settings, 'themeEffective')) {
        delete settings.themeEffective;
      }
      App.commitSettings(settings);
      App.applyTheme(next, effective);
    } catch (_) {
      App.applyTheme(cur);
      App.patchSettings({ theme: cur });
    }
  });
  App.renderThemeLabel = renderThemeLabel;

  $$('.mode-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      try {
        await api.setMode(mode);
        App.patchSettings({ clashMode: mode });
        renderMode();
        toast(t('toast.modeChanged', t('mode.' + mode)));
      } catch (e) {
        toast(e.message || String(e), true);
      }
    });
  });

  document.querySelectorAll('[data-dash-action]').forEach((card) => {
    card.addEventListener('click', () => {
      const action = card.dataset.dashAction;
      if (action === 'power') return togglePower().catch(() => {});
      if (action === 'proxy') return toggleSystemProxy().catch(() => {});
      if (action === 'nodes') return App.showTab && App.showTab('nodes');
      if (action === 'connections') return App.showTab && App.showTab('conns');
      if (action === 'testDelay') {
        if (App.testCurrentNodeDelay) return App.testCurrentNodeDelay();
        toast(t('nodes.needRunning'), true);
      }
    });
  });

  App.renderStatus = renderStatus;
  App.renderMode = renderMode;
  App.renderUsage = renderUsage;
  App.renderDashboard = renderDashboard;
  App.renderDashNodeCards = renderDashNodeCards;
  App.renderDashboardQuality = renderDashboardQuality;
  App.loadDashboardConnections = loadDashboardConnections;
  App.loadDashboardEvents = loadDashboardEvents;
})();
