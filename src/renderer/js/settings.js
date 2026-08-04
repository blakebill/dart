'use strict';
// Settings tab: general/DNS settings, core management and GeoData actions.
(function () {
  const App = window.App;
  const { $, toast, call } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  function changedSettingsPatch(candidate) {
    const current = App.state.settings || {};
    return Object.fromEntries(
      Object.entries(candidate).filter(([key, value]) => current[key] !== value)
    );
  }

  function settingsCandidate() {
    return {
      mixedPort: parseInt($('#setMixedPort').value, 10),
      clashApiPort: parseInt($('#setClashPort').value, 10),
      logLevel: $('#setLogLevel').value,
      autoSetSystemProxy: $('#setAutoProxy').checked,
      autoLaunch: $('#setAutoLaunch').checked,
      silentStart: $('#setSilentStart').checked,
      notifications: $('#setNotifications').checked,
      enableIpv6: $('#setIpv6').checked,
      useBuiltinRules: $('#setBuiltinRules').checked,
      testUrl: $('#setTestUrl').value.trim(),
      language: $('#setLanguage').value,
      smartMode: $('#setSmartMode').value,
      enableDnsOverride: $('#setDnsOverride').checked,
      dnsRemote: $('#setDnsRemote').value.trim(),
      dnsLocal: $('#setDnsLocal').value.trim(),
      dnsStrategy: $('#setDnsStrategy').value,
    };
  }

  function updateDirtyState() {
    const dirty = Object.keys(changedSettingsPatch(settingsCandidate())).length > 0;
    const bar = $('.settings-savebar');
    const label = $('#settingsDirtyState');
    const button = $('#saveAllSettings');
    if (bar) bar.classList.toggle('is-dirty', dirty);
    if (label) label.textContent = t(dirty ? 'settings.unsaved' : 'settings.allSaved');
    if (button) button.disabled = !dirty;
    return dirty;
  }

  async function persistChangedSettings(candidate, button) {
    const patch = changedSettingsPatch(candidate);
    if (!Object.keys(patch).length) {
      toast(t('settings.saved'));
      return null;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      App.commitSettings(await call(api.updateSettings, patch));
      toast(t('settings.saved'));
      return patch;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  function setFieldValue(el, value, isCheckbox) {
    if (!el) return false;
    if (isCheckbox) {
      const next = !!value;
      if (el.checked === next) return false;
      el.checked = next;
      return true;
    }
    const next = value === undefined || value === null ? '' : String(value);
    if (el.value === next) return false;
    el.value = next;
    return true;
  }

  function syncDnsOverrideControls(enabled) {
    for (const selector of ['#setDnsRemote', '#setDnsLocal', '#setDnsStrategy']) {
      const control = $(selector);
      if (control) control.disabled = !enabled;
    }
  }

  function renderSettings() {
    const s = App.state.settings || {};
    let changed = false;
    changed = setFieldValue($('#setMixedPort'), s.mixedPort) || changed;
    changed = setFieldValue($('#setClashPort'), s.clashApiPort) || changed;
    changed = setFieldValue($('#setLogLevel'), s.logLevel) || changed;
    changed = setFieldValue($('#setAutoProxy'), !!s.autoSetSystemProxy, true) || changed;
    changed = setFieldValue($('#setAutoLaunch'), !!s.autoLaunch, true) || changed;
    changed = setFieldValue($('#setSilentStart'), !!s.silentStart, true) || changed;
    changed = setFieldValue($('#setNotifications'), s.notifications !== false, true) || changed;
    changed = setFieldValue($('#setIpv6'), !!s.enableIpv6, true) || changed;
    changed = setFieldValue($('#setBuiltinRules'), !!s.useBuiltinRules, true) || changed;
    changed = setFieldValue($('#setTestUrl'), s.testUrl || '') || changed;
    changed = setFieldValue($('#setSmartMode'), s.smartMode || 'balanced') || changed;
    changed = setFieldValue($('#setLanguage'), s.language || 'zh') || changed;
    changed = setFieldValue($('#setDnsOverride'), !!s.enableDnsOverride, true) || changed;
    changed = setFieldValue($('#setDnsRemote'), s.dnsRemote || '') || changed;
    changed = setFieldValue($('#setDnsLocal'), s.dnsLocal || '') || changed;
    changed = setFieldValue($('#setDnsStrategy'), s.dnsStrategy || 'prefer_ipv4') || changed;
    syncDnsOverrideControls(!!s.enableDnsOverride);
    const smartRegions = Array.isArray(s.smartRegions) ? s.smartRegions : [];
    const smartRegionsSummary = $('#smartRegionsSummary');
    if (smartRegionsSummary) {
      smartRegionsSummary.textContent = smartRegions.length
        ? t('settings.smartRegionsCount', smartRegions.length)
        : t('settings.smartRegionsAll');
    }
    // Enhanced selects only need a refresh when an underlying value actually moved.
    if (changed && App.refreshSelects && App.currentTab === 'settings') App.refreshSelects();
    updateDirtyState();
  }

  // Pure render of the core-status label from a status object.
  function renderCoreStatus(st) {
    const el = $('#coreStatus');
    if (!el || !st) return;
    const coreName = st.coreName || 'Mihomo';
    if (st.coreInstalled) {
      const ver = st.coreVersion
        ? 'v' + st.coreVersion
        : st.coreVersion === undefined
          ? t('settings.detecting')
          : t('settings.versionUnknown');
      el.textContent = t('settings.currentCoreValue', coreName, ver);
      el.title = st.corePath || ''; // full path on hover
    } else {
      el.textContent = t('settings.currentCoreValue', coreName, t('settings.notInstalled'));
      el.title = '';
    }
    el.style.color = st.coreInstalled ? 'var(--green)' : 'var(--red)';
  }
  // Re-fetch core status over IPC (used after a core download).
  let coreStatusRequest = null;
  async function refreshCoreStatus() {
    if (!api || !api.coreStatus) return App.state.status;
    const expectedCore = (App.state.settings && App.state.settings.coreType) ||
      (App.state.status && App.state.status.coreType);
    if (coreStatusRequest && coreStatusRequest.coreType === expectedCore) return coreStatusRequest.promise;
    const request = (async () => {
      const st = await api.coreStatus();
      const currentCore = (App.state.settings && App.state.settings.coreType) ||
        (App.state.status && App.state.status.coreType);
      if ((expectedCore && currentCore !== expectedCore) || (st.coreType && expectedCore && st.coreType !== expectedCore)) {
        return App.state.status;
      }
      App.state.status = { ...App.state.status, ...st };
      renderCoreStatus(App.state.status);
      return App.state.status;
    })().finally(() => {
      if (coreStatusRequest && coreStatusRequest.promise === request) coreStatusRequest = null;
    });
    coreStatusRequest = { coreType: expectedCore, promise: request };
    return request;
  }

  $('#setLanguage').addEventListener('change', async (e) => {
    const lang = e.target.value;
    const previous = getLang();
    App.setLanguage(lang);
    App.patchSettings({ language: lang });
    if (!api || !api.updateSettings) return;
    try {
      App.commitSettings(await call(api.updateSettings, { language: lang }));
    } catch (_) {
      App.setLanguage(previous);
      App.patchSettings({ language: previous });
    } finally {
      updateDirtyState();
    }
  });

  $('#setDnsOverride').addEventListener('change', (event) => {
    syncDnsOverrideControls(event.currentTarget.checked);
    if (App.refreshSelects) App.refreshSelects();
  });

  $('#tab-settings').addEventListener('input', updateDirtyState);
  $('#tab-settings').addEventListener('change', updateDirtyState);

  $('#saveAllSettings').addEventListener('click', async (event) => {
    try {
      const patch = await persistChangedSettings(settingsCandidate(), event.currentTarget);
      if (patch && 'useBuiltinRules' in patch && App.invalidateRuleCaches) App.invalidateRuleCaches();
    } catch (_) {
    } finally {
      updateDirtyState();
    }
  });
  $('#checkConfigBtn').addEventListener('click', async () => {
    try {
      await call(api.checkConfig);
      toast(t('settings.checkOk'));
    } catch (_) {}
  });

  $('#coreManageBtn').addEventListener('click', () => App.openDialog('core'));
  $('#geoManageBtn').addEventListener('click', () => App.openDialog('geodata'));
  $('#smartRegionsBtn').addEventListener('click', () => App.openDialog('smart-regions'));

  // Open the project homepage.
  $('#homepageBtn').addEventListener('click', () => {
    call(api.openExternal, 'https://github.com/blakebill/dart').catch(() => {});
  });

  App.renderSettings = renderSettings;
  App.renderCoreStatus = renderCoreStatus;
  App.refreshCoreStatus = refreshCoreStatus;
})();
