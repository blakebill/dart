'use strict';

(function () {
  const App = window.App;
  const Dialog = App.Dialog;
  const { $, toast, escapeHtml, fmtBytes, fmtDate, setProgress } = App;
  const api = window.api;
  const { t } = window.i18n;

  Dialog.register('core', async () => {
    let state = await Dialog.call(api.getState);
    let status = state.status || {};
    Dialog.setView('settings.coreManageTitle', `
      <div class="dialog-body">
        <div class="setting-row">
          <label for="dialogCoreType" data-i18n="settings.runningCore">${escapeHtml(t('settings.runningCore'))}</label>
          <select id="dialogCoreType" class="input small">
            <option value="sing-box">sing-box</option>
            <option value="mihomo">mihomo</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <span data-i18n="settings.corePath">${escapeHtml(t('settings.corePath'))}</span>
            <span id="dialogCoreStatus" class="hint" data-dialog-status></span>
          </div>
          <button id="dialogCoreFolder" class="btn" data-i18n="settings.openCoreFolder">${escapeHtml(t('settings.openCoreFolder'))}</button>
        </div>
        <div id="dialogProgress" class="progress dialog-progress hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-i18n-aria-label="settings.downloadProgress"><div class="bar"></div></div>
      </div>
      ${Dialog.footer(`
        <button id="dialogCoreRestart" class="btn" data-i18n="dash.restartCore">${escapeHtml(t('dash.restartCore'))}</button>
        <button id="dialogCoreUpdate" class="btn" data-i18n="settings.updateCore">${escapeHtml(t('settings.updateCore'))}</button>
        <button id="dialogCoreApply" class="btn primary" data-i18n="settings.applyCore">${escapeHtml(t('settings.applyCore'))}</button>
      `)}
    `);
    $('#dialogCoreType').value = (state.settings && state.settings.coreType) || status.coreType || 'sing-box';

    function renderStatus(next) {
      status = { ...status, ...next };
      const coreName = status.coreName || status.coreType || $('#dialogCoreType').value;
      if (!status.coreInstalled) {
        $('#dialogCoreStatus').textContent = `${coreName} · ${t('settings.notInstalled')}`;
        return;
      }
      const version = status.coreVersion ? 'v' + status.coreVersion : t('settings.versionUnknown');
      $('#dialogCoreStatus').textContent = `${coreName} · ${version}${status.corePath ? ' · ' + status.corePath : ''}`;
    }

    async function refreshStatus() {
      renderStatus(await Dialog.call(api.coreStatus));
    }

    async function applySelection() {
      const coreType = $('#dialogCoreType').value;
      const current = (state.settings && state.settings.coreType) || 'sing-box';
      if (coreType === current) return false;
      state.settings = await Dialog.call(api.updateSettings, { coreType });
      await refreshStatus();
      return true;
    }

    renderStatus(status);
    await refreshStatus();

    const removeProgress = api.onDownloadProgress((progress) => {
      setProgress($('#dialogProgress'), progress);
    });
    window.addEventListener('beforeunload', removeProgress, { once: true });

    Dialog.bind('#dialogCoreFolder', 'click', () => Dialog.call(api.openCoreFolder));
    Dialog.bind('#dialogCoreApply', 'click', async () => {
      await Dialog.runBusy($('#dialogCoreApply'), null, async () => {
        await applySelection();
        await Dialog.changed('state');
        await refreshStatus();
        toast(t('settings.coreChanged'));
      });
    });
    Dialog.bind('#dialogCoreRestart', 'click', async () => {
      await Dialog.runBusy($('#dialogCoreRestart'), null, async () => {
        await Dialog.call(api.restartCore);
        await refreshStatus();
        await Dialog.changed('state');
        toast(t('toast.restarted'));
      });
    });
    Dialog.bind('#dialogCoreUpdate', 'click', async () => {
      const progress = $('#dialogProgress');
      progress.classList.remove('hidden');
      setProgress(progress, 0);
      try {
        await Dialog.runBusy($('#dialogCoreUpdate'), 'settings.updatingCore', async () => {
          const coreType = $('#dialogCoreType').value;
          await Dialog.call(api.downloadCore, { version: '', coreType });
          await applySelection();
          await refreshStatus();
          await Dialog.changed('state');
          toast(t('settings.coreDownloaded'));
        });
      } finally {
        setTimeout(() => progress.classList.add('hidden'), 1000);
      }
    });
  });

  Dialog.register('geodata', async () => {
    Dialog.setView('settings.geoManageTitle', `
      <div class="dialog-body dialog-flex">
        <p class="hint" data-i18n="settings.geoHint">${escapeHtml(t('settings.geoHint'))}</p>
        <div id="dialogGeoList" class="rule-list dialog-result"></div>
        <div id="dialogProgress" class="progress dialog-progress hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-i18n-aria-label="settings.downloadProgress"><div class="bar"></div></div>
      </div>
      ${Dialog.footer(`<button id="dialogGeoUpdate" class="btn primary" data-i18n="settings.updateGeo">${escapeHtml(t('settings.updateGeo'))}</button>`)}
    `);

    function render(items) {
      const list = $('#dialogGeoList');
      list.innerHTML = '';
      if (!items || !items.length) {
        list.innerHTML = `<p class="hint">${escapeHtml(t('ruleset.missing'))}</p>`;
        return;
      }
      for (const item of items) {
        let details = '-';
        let label = t('ruleset.missing');
        let statusClass = 'problem';
        if (item.present) {
          details = `${fmtDate(item.updatedAt)} · ${fmtBytes(item.size)}`;
          if (item.valid) {
            label = item.location === 'updated' ? t('ruleset.updated') : t('ruleset.bundled');
            statusClass = 'ready';
          } else {
            label = t('ruleset.invalid');
          }
        }
        const row = document.createElement('div');
        row.className = 'rule-item geodata-item';
        row.innerHTML = `
          <span class="rule-type">${escapeHtml(item.file || item.tag)}</span>
          <span class="rule-payload geodata-details" title="${escapeHtml(details)}">${escapeHtml(details)}</span>
          <span class="rule-proxy geodata-status ${statusClass}">${escapeHtml(label)}</span>`;
        list.appendChild(row);
      }
    }

    async function reload() {
      render(await Dialog.call(api.getRuleSets));
    }

    await reload();
    const removeProgress = api.onDownloadProgress((progress) => {
      setProgress($('#dialogProgress'), progress);
    });
    window.addEventListener('beforeunload', removeProgress, { once: true });
    Dialog.bind('#dialogGeoUpdate', 'click', async () => {
      const progress = $('#dialogProgress');
      progress.classList.remove('hidden');
      setProgress(progress, 0);
      try {
        await Dialog.runBusy($('#dialogGeoUpdate'), 'settings.updatingGeo', async () => {
          await Dialog.call(api.updateGeoData);
          await reload();
          await Dialog.changed('geodata');
          toast(t('settings.geoUpdated'));
        });
      } finally {
        setTimeout(() => progress.classList.add('hidden'), 1000);
      }
    });
  });

  Dialog.register('uwp', async () => {
    let apps = [];
    let loadFailed = false;
    Dialog.setView('uwp.title', `
      <div class="dialog-body dialog-flex">
        <p class="hint" data-i18n="uwp.hint">${escapeHtml(t('uwp.hint'))}</p>
        <div class="row uwp-toolbar dialog-commandbar">
          <label class="sr-only" for="dialogUwpScope" data-i18n="uwp.scopeLabel">${escapeHtml(t('uwp.scopeLabel'))}</label>
          <select id="dialogUwpScope" class="input small">
            <option value="all" data-i18n="uwp.scopeAll">${escapeHtml(t('uwp.scopeAll'))}</option>
            <option value="user" data-i18n="uwp.scopeUser">${escapeHtml(t('uwp.scopeUser'))}</option>
            <option value="system" data-i18n="uwp.scopeSystem">${escapeHtml(t('uwp.scopeSystem'))}</option>
          </select>
          <label class="sr-only" for="dialogUwpFilter" data-i18n="uwp.searchPh">${escapeHtml(t('uwp.searchPh'))}</label>
          <input id="dialogUwpFilter" class="input grow" data-i18n-ph="uwp.searchPh" />
          <button id="dialogUwpReload" class="btn" data-i18n="uwp.reload">${escapeHtml(t('uwp.reload'))}</button>
        </div>
        <div class="row uwp-selection-row">
          <button id="dialogUwpSelectAll" class="btn" data-i18n="uwp.selectAll">${escapeHtml(t('uwp.selectAll'))}</button>
          <button id="dialogUwpInvert" class="btn" data-i18n="uwp.invert">${escapeHtml(t('uwp.invert'))}</button>
          <span id="dialogUwpStatus" class="hint grow" data-dialog-status></span>
        </div>
        <div id="dialogUwpList" class="uwp-list dialog-uwp-list"></div>
      </div>
      ${Dialog.footer(`<button id="dialogUwpApply" class="btn primary" data-i18n="uwp.apply">${escapeHtml(t('uwp.apply'))}</button>`)}
    `);

    function visibleApps() {
      const filter = ($('#dialogUwpFilter').value || '').toLowerCase();
      const scope = $('#dialogUwpScope').value;
      return apps.filter((entry) =>
        entry.name.toLowerCase().includes(filter) &&
        (scope === 'all' || (scope === 'system') === !!entry.system)
      );
    }

    function updateStatus() {
      if (loadFailed) {
        $('#dialogUwpStatus').textContent = t('uwp.loadFailed');
        return;
      }
      const selected = apps.reduce((count, entry) => count + (entry.enabled ? 1 : 0), 0);
      $('#dialogUwpStatus').textContent = apps.length ? t('uwp.selection', selected, apps.length) : '';
    }

    function render() {
      const visible = visibleApps();
      const list = $('#dialogUwpList');
      if (!visible.length) {
        list.innerHTML = `<div class="uwp-empty">${escapeHtml(t(apps.length ? 'uwp.noMatches' : 'uwp.empty'))}</div>`;
        updateStatus();
        return;
      }
      list.innerHTML = visible.map((entry) => `
        <label class="uwp-item">
          <input type="checkbox" data-sid="${escapeHtml(entry.sid)}" ${entry.enabled ? 'checked' : ''}/>
          <span class="uwp-name">${escapeHtml(entry.name)}</span>
        </label>`).join('');
      updateStatus();
    }

    async function load(force = false) {
      $('#dialogUwpStatus').textContent = t('uwp.loading');
      $('#dialogUwpApply').disabled = true;
      try {
        apps = await api.listUwpApps(force);
        loadFailed = false;
      } catch (error) {
        apps = [];
        loadFailed = true;
      } finally {
        $('#dialogUwpApply').disabled = loadFailed;
      }
      render();
    }

    await load();
    Dialog.bind('#dialogUwpReload', 'click', () => load(true));
    Dialog.bind('#dialogUwpFilter', 'input', render);
    Dialog.bind('#dialogUwpScope', 'change', render);
    Dialog.bind('#dialogUwpSelectAll', 'click', () => {
      const visible = visibleApps();
      const allSelected = visible.length > 0 && visible.every((entry) => entry.enabled);
      visible.forEach((entry) => { entry.enabled = !allSelected; });
      render();
    });
    Dialog.bind('#dialogUwpInvert', 'click', () => {
      visibleApps().forEach((entry) => { entry.enabled = !entry.enabled; });
      render();
    });
    Dialog.bind('#dialogUwpList', 'change', (event) => {
      const checkbox = event.target.closest('input[type=checkbox]');
      if (!checkbox) return;
      const entry = apps.find((item) => item.sid === checkbox.dataset.sid);
      if (entry) entry.enabled = checkbox.checked;
      updateStatus();
    });
    Dialog.bind('#dialogUwpApply', 'click', async () => {
      await Dialog.runBusy($('#dialogUwpApply'), 'uwp.applying', async () => {
        const result = await Dialog.call(api.setUwpLoopback, apps.filter((entry) => entry.enabled).map((entry) => entry.sid));
        if (result && result.restarting) {
          $('#dialogUwpStatus').textContent = t('uwp.relaunching');
          return;
        }
        toast(t('uwp.applied'));
        await load(true);
      });
    });
  });
})();
