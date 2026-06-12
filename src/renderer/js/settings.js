'use strict';
// Settings tab: general/DNS settings, core management, geodata updates and
// the About section (version display + in-app update check/download).
(function () {
  const App = window.App;
  const { $, toast, call } = App;
  const api = window.api;
  const { t } = window.i18n;

  function renderSettings() {
    const s = App.state.settings;
    $('#setMixedPort').value = s.mixedPort;
    $('#setClashPort').value = s.clashApiPort;
    $('#setLogLevel').value = s.logLevel;
    $('#setAutoProxy').checked = !!s.autoSetSystemProxy;
    $('#setClashApi').checked = !!s.enableClashApi;
    $('#setAutoLaunch').checked = !!s.autoLaunch;
    $('#setHwAccel').checked = !!s.hardwareAcceleration;
    $('#setIpv6').checked = !!s.enableIpv6;
    $('#setLanguage').value = s.language || 'zh';
    $('#setDnsRemote').value = s.dnsRemote || '';
    $('#setDnsLocal').value = s.dnsLocal || '';
    $('#setDnsStrategy').value = s.dnsStrategy || 'prefer_ipv4';
  }

  // Pure render of the core-status label from a status object.
  function renderCoreStatus(st) {
    const el = $('#coreStatus');
    if (!el || !st) return;
    if (st.coreInstalled) {
      const ver = st.coreVersion ? 'v' + st.coreVersion : t('settings.versionUnknown');
      el.textContent = t('settings.installed', ver);
      el.title = st.corePath || ''; // full path on hover
    } else {
      el.textContent = t('settings.notInstalled');
      el.title = '';
    }
    el.style.color = st.coreInstalled ? 'var(--green)' : 'var(--red)';
  }
  // Re-fetch core status over IPC (used after a core download).
  async function refreshCoreStatus() {
    const st = await api.coreStatus();
    App.state.status = { ...App.state.status, ...st };
    renderCoreStatus(st);
  }

  $('#setLanguage').addEventListener('change', async (e) => {
    const lang = e.target.value;
    App.setLanguage(lang);
    App.state.settings = await call(api.updateSettings, { language: lang });
  });
  $('#saveSettings').addEventListener('click', async () => {
    const patch = {
      mixedPort: parseInt($('#setMixedPort').value, 10),
      clashApiPort: parseInt($('#setClashPort').value, 10),
      logLevel: $('#setLogLevel').value,
      autoSetSystemProxy: $('#setAutoProxy').checked,
      enableClashApi: $('#setClashApi').checked,
      autoLaunch: $('#setAutoLaunch').checked,
      hardwareAcceleration: $('#setHwAccel').checked,
      enableIpv6: $('#setIpv6').checked,
      language: $('#setLanguage').value,
    };
    const hwChanged = !!App.state.settings.hardwareAcceleration !== patch.hardwareAcceleration;
    App.state.settings = await call(api.updateSettings, patch);
    toast(hwChanged ? t('settings.savedRestart') : t('settings.saved'));
  });
  $('#checkConfigBtn').addEventListener('click', async () => {
    await call(api.checkConfig);
    toast(t('settings.checkOk'));
  });

  // Save DNS settings.
  $('#saveDns').addEventListener('click', async () => {
    const patch = {
      dnsRemote: $('#setDnsRemote').value.trim(),
      dnsLocal: $('#setDnsLocal').value.trim(),
      dnsStrategy: $('#setDnsStrategy').value,
    };
    App.state.settings = await call(api.updateSettings, patch);
    toast(t('settings.saved'));
  });

  // Manage core: open the folder that holds the core binary.
  $('#coreManageBtn').addEventListener('click', () => call(api.openCoreFolder));

  // Update core: always fetch the latest release.
  $('#coreUpdateBtn').addEventListener('click', async () => {
    const btn = $('#coreUpdateBtn');
    const prog = $('#downloadProgress');
    btn.disabled = true;
    btn.textContent = t('settings.updatingCore');
    prog.classList.remove('hidden');
    try {
      // Always fetch the latest core (empty version = latest).
      await call(api.downloadCore, { version: '' });
      toast(t('settings.coreDownloaded'));
      await refreshCoreStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.updateCore');
      setTimeout(() => prog.classList.add('hidden'), 1500);
    }
  });

  // Update geodata (geoip/geosite rule-sets)
  $('#geoUpdateBtn').addEventListener('click', async () => {
    const btn = $('#geoUpdateBtn');
    const prog = $('#downloadProgress');
    btn.disabled = true;
    btn.textContent = t('settings.updatingGeo');
    prog.classList.remove('hidden');
    try {
      await call(api.updateGeoData);
      toast(t('settings.geoUpdated'));
      App.loadRuleSets();
    } finally {
      btn.disabled = false;
      btn.textContent = t('subs.update');
      setTimeout(() => prog.classList.add('hidden'), 1500);
    }
  });

  api.onDownloadProgress((p) => {
    $('#downloadProgress .bar').style.width = Math.round(p * 100) + '%';
  });

  // Open the project homepage.
  $('#homepageBtn').addEventListener('click', () => api.openExternal('https://github.com/blakebill/dart'));

  // ---------- Version / updates ----------
  let latestUpdateUrl = null;
  async function initVersion() {
    try {
      const v = await api.getVersion();
      if ($('#appVersion')) $('#appVersion').textContent = 'v' + v;
      if ($('#aboutVersion')) $('#aboutVersion').textContent = 'v' + v;
    } catch (_) {}
  }
  async function runUpdateCheck(silent) {
    const status = $('#updateStatus');
    const dl = $('#downloadUpdateBtn');
    if (status && !silent) status.textContent = t('about.checking');
    try {
      const r = await api.checkUpdate();
      if (r.error) {
        if (status && !silent) status.textContent = t('about.checkFailed', r.error);
        return;
      }
      const badge = $('#versionNew');
      if (r.hasUpdate) {
        latestUpdateUrl = r.url;
        if (status) status.textContent = t('about.newVersion', 'v' + r.latest, 'v' + r.current);
        if (dl) dl.classList.remove('hidden');
        if (badge) badge.classList.remove('hidden'); // NEW marker by the logo version
        if (silent) toast(t('about.newVersion', 'v' + r.latest, 'v' + r.current));
      } else {
        if (badge) badge.classList.add('hidden');
        if (status && !silent) status.textContent = t('about.upToDate');
      }
    } catch (e) {
      if (status && !silent) status.textContent = t('about.checkFailed', e.message || String(e));
    }
  }
  $('#checkUpdateBtn').addEventListener('click', () => runUpdateCheck(false));
  // Download the installer in-app (through the proxy when running) and launch
  // it; the app quits by itself so the installer can replace its files. If the
  // automatic download fails, fall back to opening the release page.
  $('#downloadUpdateBtn').addEventListener('click', async () => {
    const btn = $('#downloadUpdateBtn');
    const prog = $('#downloadProgress');
    btn.disabled = true;
    btn.textContent = t('about.downloading');
    prog.classList.remove('hidden');
    try {
      await api.downloadUpdate();
      toast(t('about.installing'));
    } catch (e) {
      toast(t('about.fallbackPage', e.message || String(e)), true);
      if (latestUpdateUrl) api.openExternal(latestUpdateUrl);
    } finally {
      btn.disabled = false;
      btn.textContent = t('about.download');
      setTimeout(() => prog.classList.add('hidden'), 1500);
    }
  });

  App.renderSettings = renderSettings;
  App.renderCoreStatus = renderCoreStatus;
  App.initVersion = initVersion;
  App.runUpdateCheck = runUpdateCheck;
})();
