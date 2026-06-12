'use strict';
// Rule-sets tab: bundled geo rule-set status and user-added custom rule-sets
// (remote lists converted to sing-box rules) with their editor modal.
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, escapeHtml } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  // ---------- Bundled rule-sets ----------
  async function loadRuleSets() {
    try {
      renderRuleSets(await api.getRuleSets());
    } catch (e) {
      /* ignore */
    }
  }
  function renderRuleSets(items) {
    const list = $('#rulesetList');
    if (!list) return;
    list.innerHTML = '';
    for (const it of items || []) {
      let status;
      if (!it.present) status = t('ruleset.missing');
      else if (!it.valid) status = t('ruleset.invalid');
      else {
        // Show the upstream release tag when known, else the last-update date.
        const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
        const ver = it.version
          ? ' · ' + it.version
          : it.updatedAt
            ? ' · ' + new Date(it.updatedAt).toLocaleDateString(locale)
            : '';
        status = (it.location === 'updated' ? t('ruleset.updated') : t('ruleset.bundled')) + ver + ' · ' + fmtBytes(it.size);
      }
      const div = document.createElement('div');
      div.className = 'rule-item';
      div.innerHTML = `
        <span class="rule-type">${escapeHtml(it.tag)}</span>
        <span class="rule-payload"><a href="#" class="ext-link" data-url="${escapeHtml(it.url)}">${escapeHtml(it.url)}</a></span>
        <span class="rule-proxy">${status}</span>`;
      list.appendChild(div);
    }
    list.querySelectorAll('a.ext-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternal(a.dataset.url);
      });
    });
  }

  // Rule-set page: update all
  $('#rulesetUpdate').addEventListener('click', async () => {
    const btn = $('#rulesetUpdate');
    btn.disabled = true;
    btn.textContent = t('settings.updatingGeo');
    try {
      await call(api.updateGeoData);
      toast(t('settings.geoUpdated'));
      await loadRuleSets();
    } finally {
      btn.disabled = false;
      btn.textContent = t('ruleset.updateAll');
    }
  });

  // ---------- Custom rule-sets ----------
  async function loadCustomRuleSets() {
    try {
      renderCustomRuleSets(await api.listCustomRuleSets());
    } catch (e) {
      /* ignore */
    }
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
    const fmt = { clash: 'Clash', surge: 'Surge', loon: 'Loon', quantumultx: 'QuantumultX', 'sing-box': 'sing-box' };
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
    $('#crsEditFormat').value = it.format;
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
        format: $('#crsFormat').value,
        target: $('#crsTarget').value,
      });
      toast(t('customrs.added'));
      resetCrsForm();
      await loadCustomRuleSets();
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
        format: $('#crsEditFormat').value,
        target: $('#crsEditTarget').value,
        autoUpdateMinutes: parseInt($('#crsEditAutoUpdate').value, 10) || 0,
        enabled: $('#crsEditEnabled').checked,
      });
      toast(t('settings.saved'));
      closeCrsModal();
      await loadCustomRuleSets();
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
    } finally {
      btn.disabled = false;
      btn.textContent = t('customrs.refresh');
    }
  });

  App.loadRuleSets = loadRuleSets;
  App.loadCustomRuleSets = loadCustomRuleSets;
})();
