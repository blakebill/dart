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
    changed = setFieldValue($('#setDnsRemote'), s.dnsRemote || '') || changed;
    changed = setFieldValue($('#setDnsLocal'), s.dnsLocal || '') || changed;
    changed = setFieldValue($('#setDnsStrategy'), s.dnsStrategy || 'prefer_ipv4') || changed;
    changed = setFieldValue($('#setCoreType'), s.coreType || 'sing-box') || changed;
    // Enhanced selects only need a refresh when an underlying value actually moved.
    if (changed && App.refreshSelects && App.currentTab === 'settings') App.refreshSelects();
  }

  // Pure render of the core-status label from a status object.
  function renderCoreStatus(st) {
    const el = $('#coreStatus');
    if (!el || !st) return;
    const coreName = st.coreName || st.coreType || (App.state.settings && App.state.settings.coreType) || 'sing-box';
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
    }
  });
  $('#saveSettings').addEventListener('click', async (event) => {
    const candidate = {
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
    };
    try {
      const patch = await persistChangedSettings(candidate, event.currentTarget);
      if (patch && 'useBuiltinRules' in patch && App.invalidateRuleCaches) App.invalidateRuleCaches();
    } catch (_) {}
  });
  $('#checkConfigBtn').addEventListener('click', async () => {
    try {
      await call(api.checkConfig);
      toast(t('settings.checkOk'));
    } catch (_) {}
  });

  $('#saveFeatures').addEventListener('click', async (event) => {
    try {
      await persistChangedSettings(
        { smartMode: $('#setSmartMode').value },
        event.currentTarget
      );
    } catch (_) {}
  });

  // Save DNS settings.
  $('#saveDns').addEventListener('click', async (event) => {
    const candidate = {
      dnsRemote: $('#setDnsRemote').value.trim(),
      dnsLocal: $('#setDnsLocal').value.trim(),
      dnsStrategy: $('#setDnsStrategy').value,
    };
    try {
      await persistChangedSettings(candidate, event.currentTarget);
    } catch (_) {}
  });

  $('#coreManageBtn').addEventListener('click', () => App.openDialog('core'));

  // Open the project homepage.
  $('#homepageBtn').addEventListener('click', () => {
    call(api.openExternal, 'https://github.com/blakebill/dart').catch(() => {});
  });

  App.renderSettings = renderSettings;
  App.renderCoreStatus = renderCoreStatus;
  App.refreshCoreStatus = refreshCoreStatus;
})();
