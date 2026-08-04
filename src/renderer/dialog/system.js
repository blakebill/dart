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
      <div class="dialog-body dialog-flex dialog-core-body">
        <div class="setting-row">
          <span data-i18n="settings.runningCore">${escapeHtml(t('settings.runningCore'))}</span>
          <strong id="dialogCoreName">Mihomo</strong>
        </div>
        <div class="setting-row">
          <label for="dialogCoreSource" data-i18n="settings.downloadSource">${escapeHtml(t('settings.downloadSource'))}</label>
          <select id="dialogCoreSource" class="input small">
            <option value="custom" data-i18n="settings.customCore">${escapeHtml(t('settings.customCore'))}</option>
            <option value="official" data-i18n="settings.officialCore">${escapeHtml(t('settings.officialCore'))}</option>
          </select>
        </div>
        <div class="setting-row dialog-core-path-row">
          <div class="setting-label">
            <span data-i18n="settings.corePath">${escapeHtml(t('settings.corePath'))}</span>
            <span id="dialogCoreStatus" class="hint" data-dialog-status></span>
          </div>
          <button id="dialogCoreFolder" class="btn dialog-core-folder" data-i18n="settings.openCoreFolder">${escapeHtml(t('settings.openCoreFolder'))}</button>
        </div>
        <div id="dialogProgress" class="progress dialog-progress hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-i18n-aria-label="settings.downloadProgress"><div class="bar"></div></div>
        <div class="dialog-feature-status">
          <span><span data-i18n="settings.featureStatus">${escapeHtml(t('settings.featureStatus'))}</span><span aria-hidden="true">:</span></span>
          <span class="dialog-feature-detail"><span data-i18n="settings.smartFeature">${escapeHtml(t('settings.smartFeature'))}</span><span aria-hidden="true">: </span><strong id="dialogSmartSupport"></strong></span>
        </div>
      </div>
      ${Dialog.footer(`
        <button id="dialogCoreRestart" class="btn" data-i18n="dash.restartCore">${escapeHtml(t('dash.restartCore'))}</button>
        <button id="dialogCoreUpdate" class="btn primary" data-i18n="settings.updateCore">${escapeHtml(t('settings.updateCore'))}</button>
      `)}
    `);
    $('#dialogCoreSource').value = status.coreInstalled && !/-dart\.\d+/i.test(status.coreVersion || '')
      ? 'official'
      : 'custom';

    function renderFeatureStatus() {
      const supported = $('#dialogCoreSource').value === 'custom';
      const value = $('#dialogSmartSupport');
      value.textContent = t(supported ? 'settings.supported' : 'settings.unsupported');
      value.classList.toggle('supported', supported);
      value.classList.toggle('unsupported', !supported);
    }

    function renderStatus(next) {
      status = { ...status, ...next };
      const coreName = status.coreName || 'Mihomo';
      $('#dialogCoreName').textContent = coreName;
      if (!status.coreInstalled) {
        $('#dialogCoreStatus').textContent = `${coreName} · ${t('settings.notInstalled')}`;
        $('#dialogCoreStatus').title = $('#dialogCoreStatus').textContent;
        return;
      }
      const version = status.coreVersion ? 'v' + status.coreVersion : t('settings.versionUnknown');
      $('#dialogCoreStatus').textContent = `${coreName} · ${version}${status.corePath ? ' · ' + status.corePath : ''}`;
      $('#dialogCoreStatus').title = $('#dialogCoreStatus').textContent;
    }

    async function refreshStatus() {
      renderStatus(await Dialog.call(api.coreStatus));
    }

    renderStatus(status);
    renderFeatureStatus();
    await refreshStatus();

    const removeProgress = api.onDownloadProgress((progress) => {
      setProgress($('#dialogProgress'), progress);
    });
    window.addEventListener('beforeunload', removeProgress, { once: true });

    Dialog.bind('#dialogCoreFolder', 'click', () => Dialog.call(api.openCoreFolder));
    Dialog.bind('#dialogCoreSource', 'change', renderFeatureStatus);
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
          const source = $('#dialogCoreSource').value;
          await Dialog.call(api.downloadCore, { version: '', coreType: 'mihomo', source });
          await refreshStatus();
          await Dialog.changed('state');
          toast(t('settings.coreDownloaded'));
        });
      } finally {
        setTimeout(() => progress.classList.add('hidden'), 1000);
      }
    });
  });

  Dialog.register('smart-regions', async () => {
    const data = await Dialog.call(api.getNodeRegions);
    const regions = Array.isArray(data && data.regions) ? data.regions : [];
    const saved = new Set(Array.isArray(data && data.selected) ? data.selected : []);
    const defaultAll = saved.size === 0;
    let regionDisplayNames = null;
    try {
      regionDisplayNames = new Intl.DisplayNames(
        [document.documentElement.lang || 'zh-CN'],
        { type: 'region' }
      );
    } catch (_) {
      /* Fall back to ISO codes on older runtimes. */
    }

    Dialog.setView('settings.smartRegionsTitle', `
      <div class="dialog-body dialog-flex">
        <p class="hint" data-i18n="settings.smartRegionsDialogHint">${escapeHtml(t('settings.smartRegionsDialogHint'))}</p>
        <div class="row dialog-selection-row">
          <button id="dialogSmartRegionsAll" class="btn" data-i18n="settings.smartRegionsSelectAll">${escapeHtml(t('settings.smartRegionsSelectAll'))}</button>
          <button id="dialogSmartRegionsClear" class="btn" data-i18n="settings.smartRegionsClear">${escapeHtml(t('settings.smartRegionsClear'))}</button>
          <span id="dialogSmartRegionsStatus" class="hint grow" data-dialog-status></span>
        </div>
        <div id="dialogSmartRegionsList" class="smart-region-list dialog-result"></div>
      </div>
      ${Dialog.footer(`<button id="dialogSmartRegionsApply" class="btn primary" data-i18n="settings.apply">${escapeHtml(t('settings.apply'))}</button>`)}
    `);

    function regionLabel(code) {
      if (code === 'ZZ') return t('settings.smartRegionsOther');
      return regionDisplayNames ? (regionDisplayNames.of(code) || code) : code;
    }

    function checkedCodes() {
      return [...document.querySelectorAll('#dialogSmartRegionsList input[type="checkbox"]:checked')]
        .map((input) => input.value);
    }

    function updateStatus() {
      const count = checkedCodes().length;
      $('#dialogSmartRegionsStatus').textContent = count
        ? t('settings.smartRegionsSelected', count, regions.length)
        : t('settings.smartRegionsNeedOne');
      $('#dialogSmartRegionsApply').disabled = count === 0;
    }

    const list = $('#dialogSmartRegionsList');
    if (!regions.length) {
      list.innerHTML = `<p class="hint">${escapeHtml(t('settings.smartRegionsEmpty'))}</p>`;
    } else {
      list.innerHTML = regions.map((item) => {
        const code = String(item && item.code || '');
        const count = Math.max(0, Number(item && item.count) || 0);
        const checked = defaultAll || saved.has(code);
        return `<label class="smart-region-item">
          <input type="checkbox" value="${escapeHtml(code)}" ${checked ? 'checked' : ''}/>
          <span class="smart-region-name">${escapeHtml(regionLabel(code))}</span>
          <span class="hint">${escapeHtml(t('settings.smartRegionsNodes', count))}</span>
        </label>`;
      }).join('');
    }

    Dialog.bind('#dialogSmartRegionsList', 'change', updateStatus);
    Dialog.bind('#dialogSmartRegionsAll', 'click', () => {
      document.querySelectorAll('#dialogSmartRegionsList input[type="checkbox"]').forEach((input) => {
        input.checked = true;
      });
      updateStatus();
    });
    Dialog.bind('#dialogSmartRegionsClear', 'click', () => {
      document.querySelectorAll('#dialogSmartRegionsList input[type="checkbox"]').forEach((input) => {
        input.checked = false;
      });
      updateStatus();
    });
    Dialog.bind('#dialogSmartRegionsApply', 'click', async () => {
      await Dialog.runBusy($('#dialogSmartRegionsApply'), null, async () => {
        const selected = checkedCodes();
        if (!selected.length) return;
        await Dialog.call(api.updateSettings, {
          // Empty means unrestricted and automatically includes regions added by
          // a later subscription refresh.
          smartRegions: selected.length === regions.length ? [] : selected,
        });
        await Dialog.finish('state', t('settings.smartRegionsSaved'));
      });
    });
    updateStatus();
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
