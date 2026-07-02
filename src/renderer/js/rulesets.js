'use strict';
// Remote rules on the Rules tab, plus GeoData version management in Settings.
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  // ---------- GeoData status ----------
  async function loadGeoDataStatus() {
    if (!api) return;
    try {
      renderGeoDataStatus(await api.getRuleSets());
    } catch (e) {
      /* ignore */
    }
  }
  function renderGeoDataStatus(items) {
    const list = $('#geoDataList');
    if (!list) return;
    list.innerHTML = '';
    if (!items || !items.length) {
      list.innerHTML = `<p class="hint">${t('ruleset.missing')}</p>`;
      return;
    }
    for (const it of items || []) {
      let version;
      let status;
      if (!it.present) {
        version = t('settings.versionUnknown');
        status = t('ruleset.missing');
      } else if (!it.valid) {
        version = t('settings.versionUnknown');
        status = t('ruleset.invalid');
      }
      else {
        version = visibleVersion(it.version);
        status = (it.location === 'updated' ? t('ruleset.updated') : t('ruleset.bundled')) + ' · ' + fmtBytes(it.size);
      }
      const div = document.createElement('div');
      div.className = 'rule-item';
      div.innerHTML = `
        <span class="rule-type">${escapeHtml(it.file || it.tag)}</span>
        <span class="rule-payload">${escapeHtml(version)}</span>
        <span class="rule-proxy">${escapeHtml(status)}</span>`;
      list.appendChild(div);
    }
  }

  function visibleVersion(version) {
    const value = String(version || '').trim();
    if (!value || value.toLowerCase() === 'latest') return t('settings.versionUnknown');
    return value;
  }

  async function updateGeoData(btn) {
    const prog = $('#downloadProgress');
    btn.disabled = true;
    btn.textContent = t('settings.updatingGeo');
    if (prog) prog.classList.remove('hidden');
    try {
      await call(api.updateGeoData);
      toast(t('settings.geoUpdated'));
      await loadGeoDataStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = t('settings.updateGeo');
      if (prog) setTimeout(() => prog.classList.add('hidden'), 1500);
    }
  }

  const geoManageBtn = $('#geoManageBtn');
  if (geoManageBtn) {
    geoManageBtn.addEventListener('click', async () => {
      $('#geoModal').classList.remove('hidden');
      await loadGeoDataStatus();
    });
  }
  const geoDataCloseBtn = $('#geoDataCloseBtn');
  if (geoDataCloseBtn) geoDataCloseBtn.addEventListener('click', () => $('#geoModal').classList.add('hidden'));
  const geoModal = $('#geoModal');
  if (geoModal) {
    geoModal.addEventListener('click', (e) => {
      if (e.target.id === 'geoModal') geoModal.classList.add('hidden');
    });
  }
  const geoDataUpdateBtn = $('#geoDataUpdateBtn');
  if (geoDataUpdateBtn) geoDataUpdateBtn.addEventListener('click', () => updateGeoData(geoDataUpdateBtn));

  // ---------- Remote rules ----------
  let customRuleSetsReady = false;
  let customRuleSetsLoading = null;
  async function loadCustomRuleSets(options = {}) {
    if (options.force === false && customRuleSetsReady) return;
    if (customRuleSetsLoading) return customRuleSetsLoading;
    customRuleSetsLoading = (async () => {
      try {
        renderCustomRuleSets(await api.listCustomRuleSets());
        customRuleSetsReady = true;
      } catch (e) {
        /* ignore */
      } finally {
        customRuleSetsLoading = null;
      }
    })();
    return customRuleSetsLoading;
  }
  function renderCustomRuleSets(items) {
    const list = $('#crsList');
    if (!list) return;
    list.innerHTML = '';
    if (!items || !items.length) {
      list.innerHTML = `<p class="hint">${t('customrs.empty')}</p>`;
      return;
    }
    const tgt = { proxy: t('customrs.targetProxy'), direct: t('customrs.targetDirect'), reject: t('customrs.targetReject') };
    const fmt = { clash: 'Clash', 'sing-box': 'sing-box' };
    for (const it of items) {
      const cnt = it.kind === 'ruleset' ? t('customrs.srs') : t('customrs.rules', it.count || 0);
      const au = parseInt(it.autoUpdateMinutes || 0, 10);
      const auInfo = au > 0 ? ' · ' + t('subs.autoUpdateInfo', au) : '';
      const div = document.createElement('div');
      div.className = 'sub-item';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-name">${escapeHtml(it.name)}${it.enabled ? '' : ' · ⏸'}</div>
          <div class="sub-meta">${fmt[it.format] || it.format} · ${tgt[it.target] || it.target} · ${cnt}${auInfo}${it.error ? ' · ⚠ ' + escapeHtml(it.error) : ''}</div>
        </div>
        <div class="sub-actions">
          <button class="btn" data-act="toggle" data-id="${it.id}">${it.enabled ? t('customrs.disable') : t('customrs.enable')}</button>
          <button class="btn" data-act="edit" data-id="${it.id}">${t('subs.edit')}</button>
          <button class="btn" data-act="refresh" data-id="${it.id}">${t('customrs.refresh')}</button>
          <button class="btn danger" data-act="remove" data-id="${it.id}">${t('customrs.remove')}</button>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        if (act === 'edit') {
          const it = (await api.listCustomRuleSets()).find((x) => x.id === id);
          if (it) openCrsModal(it);
          return;
        }
        b.disabled = true;
        try {
          if (act === 'remove') await call(api.removeCustomRuleSet, { id });
          else if (act === 'refresh') await call(api.refreshCustomRuleSet, { id });
          else if (act === 'toggle') {
            const it = (await api.listCustomRuleSets()).find((x) => x.id === id);
            await call(api.editCustomRuleSet, { id, enabled: !(it && it.enabled) });
          }
          await loadCustomRuleSets();
          if (App.state.status && App.state.status.running) App.loadRules();
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  // Custom rule-set editor modal.
  let editingCrsId = null;
  function openCrsModal(it) {
    editingCrsId = it.id;
    $('#crsEditName').value = it.name || '';
    $('#crsEditUrl').value = it.url || '';
    $('#crsEditTarget').value = it.target;
    $('#crsEditAutoUpdate').value = String(it.autoUpdateMinutes || 0);
    $('#crsEditEnabled').checked = it.enabled !== false;
    $('#crsModal').classList.remove('hidden');
  }
  function closeCrsModal() {
    editingCrsId = null;
    $('#crsModal').classList.add('hidden');
  }
  function resetCrsForm() {
    $('#crsName').value = '';
    $('#crsUrl').value = '';
  }

  // Add a custom remote rule-set (editing happens in the modal).
  $('#crsAdd').addEventListener('click', async () => {
    const url = $('#crsUrl').value.trim();
    if (!url) return toast(t('toast.needUrl'), true);
    const btn = $('#crsAdd');
    btn.disabled = true;
    btn.textContent = t('subs.fetching');
    try {
      await call(api.addCustomRuleSet, {
        name: $('#crsName').value.trim(),
        url,
        target: $('#crsTarget').value,
      });
      toast(t('customrs.added'));
      resetCrsForm();
      await loadCustomRuleSets();
      if (App.state.status && App.state.status.running) App.loadRules();
    } finally {
      btn.disabled = false;
      btn.textContent = t('customrs.add');
    }
  });

  // Custom rule-set editor modal: save / refresh now / cancel.
  $('#crsEditCancel').addEventListener('click', closeCrsModal);
  $('#crsModal').addEventListener('click', (e) => {
    if (e.target.id === 'crsModal') closeCrsModal();
  });
  $('#crsEditSave').addEventListener('click', async () => {
    if (!editingCrsId) return;
    const url = $('#crsEditUrl').value.trim();
    if (!url) return toast(t('toast.needUrl'), true);
    const btn = $('#crsEditSave');
    btn.disabled = true;
    try {
      await call(api.editCustomRuleSet, {
        id: editingCrsId,
        name: $('#crsEditName').value.trim(),
        url,
        target: $('#crsEditTarget').value,
        autoUpdateMinutes: parseInt($('#crsEditAutoUpdate').value, 10) || 0,
        enabled: $('#crsEditEnabled').checked,
      });
      toast(t('settings.saved'));
      closeCrsModal();
      await loadCustomRuleSets();
      if (App.state.status && App.state.status.running) App.loadRules();
    } finally {
      btn.disabled = false;
    }
  });
  $('#crsEditRefresh').addEventListener('click', async () => {
    if (!editingCrsId) return;
    const btn = $('#crsEditRefresh');
    btn.disabled = true;
    btn.textContent = t('subs.fetching');
    try {
      await call(api.refreshCustomRuleSet, { id: editingCrsId });
      toast(t('customrs.added'));
      await loadCustomRuleSets();
      if (App.state.status && App.state.status.running) App.loadRules();
    } finally {
      btn.disabled = false;
      btn.textContent = t('customrs.refresh');
    }
  });

  App.loadGeoDataStatus = loadGeoDataStatus;
  App.loadRuleSets = loadGeoDataStatus;
  App.loadCustomRuleSets = loadCustomRuleSets;
  App.ensureCustomRuleSetsLoaded = () => loadCustomRuleSets({ force: false });
  const invalidateRuleCaches = App.invalidateRuleCaches;
  App.invalidateRuleCaches = () => {
    customRuleSetsReady = false;
    if (invalidateRuleCaches) invalidateRuleCaches();
  };
})();
