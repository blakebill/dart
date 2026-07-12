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
    const name = running ? (raw && raw !== '-' ? raw : t('dash.noNode')) : t('dash.needRunning');
    nodeEl.textContent = name;
    nodeEl.title = name;

    if (!running || !raw || raw === '-') {
      delayEl.textContent = running ? t('dash.noDelay') : t('dash.needRunning');
      delayEl.className = 'card-value';
      return;
    }

    const delayVal = App.delays && App.delays.get(raw);
    if (delayVal === undefined) {
      delayEl.textContent = t('dash.noDelay');
      delayEl.className = 'card-value';
      return;
    }
    delayEl.textContent = delayText(delayVal) || t('dash.noDelay');
    delayEl.className = 'card-value ' + delayClass(delayVal);
  }

  function renderDashboard() {
    const st = App.state.status || {};
    const active = (App.state.subscriptions || []).find((s) => s.id === App.state.activeSub);
    setText($('#dashRunning'), st.running ? t('status.running') : t('status.stopped'),
      st.running ? 'var(--green)' : 'var(--text-dim)');
    setText($('#dashProxy'), st.systemProxy ? t('state.on') : t('state.off'),
      st.systemProxy ? 'var(--green)' : 'var(--text-dim)');
    renderDashNodeCards();

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
      topCore.textContent = st.coreName || st.coreType || (App.state.settings && App.state.settings.coreType) || 'sing-box';
    }
    const topProfile = $('#topProfile');
    if (topProfile) {
      const profileName = active ? active.name : '-';
      topProfile.textContent = profileName;
      topProfile.title = profileName;
    }
    const topDot = $('#topStatusDot');
    if (topDot) topDot.className = 'status-dot ' + (st.running ? 'on' : 'off');
  }

  function renderStatus() {
    const st = App.state.status || {};
    $('#statusDot').className = 'status-dot ' + (st.running ? 'on' : 'off');
    // Top-left logo dot "breathes" while the core runs: a slow glow swell, not
    // a hard on/off blink.
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
    $$('.mode-btn').forEach((b) => b.classList.toggle('primary', b.dataset.mode === mode));
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
        <div class="usage-bar usage-bar-lg"><div class="usage-fill" style="width:${st.pct}%"></div></div>
        <div class="usage-featured-meta">
          <span>${escapeHtml(usedLabel)}</span>
          <span>${escapeHtml(remainLabel)}</span>
          ${expireLabel ? `<span class="usage-expire${expireWarn ? ' is-warn' : ''}">${escapeHtml(expireLabel)}</span>` : ''}
        </div>
      </div>`;
  }

  function renderUsageOthers(subs) {
    if (!subs.length) return '';
    let html = `<div class="usage-others-label">${escapeHtml(t('usage.others'))}</div><div class="usage-others">`;
    for (const s of subs) {
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
          <div class="usage-bar"><div class="usage-fill" style="width:${o.pct}%"></div></div>
        </div>`;
    }
    return html + '</div>';
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

  async function togglePower() {
    if (App.state.status && App.state.status.running) {
      await call(api.stopCore);
    } else {
      await call(api.startCore);
      toast(t('toast.started'));
    }
  }

  async function toggleSystemProxy() {
    const proxySw = $('#quickProxy');
    if (proxySw && proxySw.disabled) {
      toast(t('nodes.needRunning'), true);
      return;
    }
    const on = !!(App.state.status && App.state.status.systemProxy);
    await call(api.setSystemProxy, !on);
    toast(!on ? t('toast.proxyOn') : t('toast.proxyOff'));
  }

  $('#powerBtn').addEventListener('click', togglePower);
  $('#quickProxy').addEventListener('click', toggleSystemProxy);

  $('#quickTun').addEventListener('click', async () => {
    const next = !(App.state.settings && App.state.settings.enableTun);
    const r = await call(api.setTun, next);
    if (r && r.restarting) return;
    if (r && r.settings) App.state.settings = r.settings;
    renderDashboard();
    toast(App.state.settings.enableTun ? t('toast.tunOn') : t('toast.tunOff'));
  });

  const THEME_ORDER = ['dark', 'light', 'system'];
  function renderThemeLabel() {
    const span = $('#themeLabel');
    if (span) span.textContent = t('theme.' + (App.themePref || 'dark'));
  }
  $('#themeBtn').addEventListener('click', async () => {
    const cur = App.themePref || App.state.settings.theme || 'dark';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    App.applyTheme(next);
    if (!api || !api.updateSettings) return;
    App.state.settings = await call(api.updateSettings, { theme: next });
  });
  App.renderThemeLabel = renderThemeLabel;

  $$('.mode-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      try {
        await api.setMode(mode);
        App.state.settings.clashMode = mode;
        renderMode();
        toast(t('toast.modeChanged', t('mode.' + mode)));
      } catch (e) {
        toast(e.message || String(e), true);
      }
    });
  });

  document.querySelectorAll('[data-dash-action]').forEach((card) => {
    card.addEventListener('click', async () => {
      const action = card.dataset.dashAction;
      if (action === 'power') return togglePower();
      if (action === 'proxy') return toggleSystemProxy();
      if (action === 'nodes') return App.showTab && App.showTab('nodes');
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
})();
