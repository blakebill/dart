'use strict';
// Dashboard tab + sidebar status: overview cards, quick actions, proxy mode
// switch, traffic usage panel, power button and theme toggle.
(function () {
  const App = window.App;
  const { $, $$, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  function renderDashboard() {
    const st = App.state.status || {};
    $('#dashRunning').textContent = st.running ? t('status.running') : t('status.stopped');
    $('#dashRunning').style.color = st.running ? 'var(--green)' : 'var(--text-dim)';
    $('#dashProxy').textContent = st.systemProxy ? t('state.on') : t('state.off');
    $('#dashSubs').textContent = App.state.subscriptions.length;
    $('#dashNodes').textContent = App.activeNodes().length;
    $('#coreHint').textContent = st.coreInstalled ? '' : t('dash.coreHint');
    // Quick toggles show the action that will happen, based on current state.
    const proxyOn = !!st.systemProxy;
    $('#quickProxy').textContent = proxyOn ? t('dash.proxyOff') : t('dash.proxyOn');
    $('#quickProxy').classList.toggle('stop', proxyOn);
    $('#quickProxy').disabled = !st.running && !proxyOn;
    const tunOn = !!(App.state.settings && App.state.settings.enableTun);
    $('#quickTun').textContent = tunOn ? t('dash.tunOff') : t('dash.tunOn');
    $('#quickTun').classList.toggle('stop', tunOn);
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

  function renderUsage() {
    const list = $('#usageList');
    if (!list) return;
    const subs = (App.state.subscriptions || []).filter((s) => s.userInfo);
    if (!subs.length) {
      list.innerHTML = `<p class="hint">${t('usage.none')}</p>`;
      return;
    }
    const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
    list.innerHTML = '';
    for (const s of subs) {
      const u = s.userInfo;
      const used = (u.upload || 0) + (u.download || 0);
      const total = u.total || 0;
      const pct = total ? Math.min(100, (used / total) * 100) : 0;
      const exp = u.expire ? ' · ' + t('subs.expire', new Date(u.expire * 1000).toLocaleDateString(locale)) : '';
      const div = document.createElement('div');
      div.className = 'usage-item';
      div.innerHTML = `
        <div class="usage-top">
          <span>${escapeHtml(s.name)}</span>
          <span class="sub-meta">${fmtBytes(used)} / ${total ? fmtBytes(total) : '∞'}${exp}</span>
        </div>
        <div class="usage-bar"><div class="usage-fill" style="width:${pct}%"></div></div>`;
      list.appendChild(div);
    }
  }

  async function togglePower() {
    if (App.state.status && App.state.status.running) {
      await call(api.stopCore);
    } else {
      await call(api.startCore);
      toast(t('toast.started'));
    }
  }

  $('#powerBtn').addEventListener('click', togglePower);
  $('#quickRestart').addEventListener('click', async () => {
    const btn = $('#quickRestart');
    btn.disabled = true;
    try {
      await call(api.restartCore);
      toast(t('toast.restarted'));
    } finally {
      btn.disabled = false;
    }
  });
  $('#quickProxy').addEventListener('click', async () => {
    const on = App.state.status && App.state.status.systemProxy;
    await call(api.setSystemProxy, !on);
    toast(!on ? t('toast.proxyOn') : t('toast.proxyOff'));
  });

  // Toggle TUN mode from the dashboard. The main process auto-detects admin rights
  // and prompts to restart elevated when needed; if running it restarts the core.
  $('#quickTun').addEventListener('click', async () => {
    const next = !(App.state.settings && App.state.settings.enableTun);
    const r = await call(api.setTun, next);
    if (r && r.restarting) return; // app is relaunching as administrator
    if (r && r.settings) App.state.settings = r.settings;
    renderDashboard();
    toast(App.state.settings.enableTun ? t('toast.tunOn') : t('toast.tunOff'));
  });
  $('#quickPanel').addEventListener('click', () => api.openClashApi());

  // Theme toggle: cycles dark → light → system, persisted. The button label
  // shows the current mode.
  const THEME_ORDER = ['dark', 'light', 'system'];
  function renderThemeLabel() {
    const span = $('#themeLabel');
    if (span) span.textContent = t('theme.' + (App.themePref || 'dark'));
  }
  $('#themeBtn').addEventListener('click', async () => {
    const cur = App.themePref || App.state.settings.theme || 'dark';
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    App.applyTheme(next);
    App.state.settings = await call(api.updateSettings, { theme: next });
  });
  App.renderThemeLabel = renderThemeLabel;

  // Proxy mode switch (rule / global / direct / block)
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

  App.renderStatus = renderStatus;
  App.renderMode = renderMode;
  App.renderUsage = renderUsage;
})();
