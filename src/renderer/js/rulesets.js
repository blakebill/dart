'use strict';
// Remote rules on the Rules tab, plus GeoData status management in Settings.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  const geoManageBtn = $('#geoManageBtn');
  if (geoManageBtn) geoManageBtn.addEventListener('click', () => App.openDialog('geodata'));

  // ---------- Remote rules ----------
  let customRuleSetsReady = false;
  let customRuleSetsLoading = null;
  let customRuleSetsGeneration = 0;
  async function loadCustomRuleSets(options = {}) {
    if (options.force === false && customRuleSetsReady) return;
    if (customRuleSetsLoading) return customRuleSetsLoading;
    const generation = customRuleSetsGeneration;
    const request = (async () => {
      try {
        const items = await api.listCustomRuleSets();
        if (generation !== customRuleSetsGeneration) return;
        renderCustomRuleSets(items);
        customRuleSetsReady = true;
      } catch (e) {
        /* ignore */
      }
    })().finally(() => {
      if (customRuleSetsLoading === request) customRuleSetsLoading = null;
    });
    customRuleSetsLoading = request;
    return request;
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
      const formatLabel = escapeHtml(fmt[it.format] || it.format || '');
      const targetLabel = escapeHtml(tgt[it.target] || it.target || '');
      const id = escapeHtml(it.id);
      const itemName = it.name || it.url || t('customrs.title');
      const actionLabel = (label) => escapeHtml(`${label}: ${itemName}`);
      const div = document.createElement('div');
      div.className = 'sub-item';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-name">${escapeHtml(itemName)}${it.enabled ? '' : ' · ⏸'}</div>
          <div class="sub-meta">${formatLabel} · ${targetLabel} · ${cnt}${auInfo}${it.error ? ' · ⚠ ' + escapeHtml(it.error) : ''}</div>
        </div>
        <div class="sub-actions">
          <button type="button" class="btn" data-act="toggle" data-id="${id}" aria-label="${actionLabel(it.enabled ? t('customrs.disable') : t('customrs.enable'))}">${it.enabled ? t('customrs.disable') : t('customrs.enable')}</button>
          <button type="button" class="btn" data-act="edit" data-id="${id}" aria-label="${actionLabel(t('subs.edit'))}">${t('subs.edit')}</button>
          <button type="button" class="btn" data-act="refresh" data-id="${id}" aria-label="${actionLabel(t('customrs.refresh'))}">${t('customrs.refresh')}</button>
          <button type="button" class="btn danger" data-act="remove" data-id="${id}" aria-label="${actionLabel(t('customrs.remove'))}">${t('customrs.remove')}</button>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        try {
          if (act === 'edit') {
            const it = (await call(api.listCustomRuleSets)).find((x) => x.id === id);
            if (it) await App.openDialog('remote-rule', { id });
            return;
          }
          if (act === 'remove') await call(api.removeCustomRuleSet, { id });
          else if (act === 'refresh') await call(api.refreshCustomRuleSet, { id });
          else if (act === 'toggle') {
            const it = (await call(api.listCustomRuleSets)).find((x) => x.id === id);
            await call(api.editCustomRuleSet, { id, enabled: !(it && it.enabled) });
          }
          if (App.invalidateRuleCaches) App.invalidateRuleCaches();
          await Promise.all([loadCustomRuleSets({ force: true }), App.loadRules({ force: true })]);
        } catch (_) {
          /* call() already showed the error */
        } finally {
          b.disabled = false;
          b.removeAttribute('aria-busy');
        }
      });
    });
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
      if (App.invalidateRuleCaches) App.invalidateRuleCaches();
      await Promise.all([loadCustomRuleSets({ force: true }), App.loadRules({ force: true })]);
    } catch (_) {
      /* call() already showed the error */
    } finally {
      btn.disabled = false;
      btn.textContent = t('customrs.add');
    }
  });

  App.loadCustomRuleSets = loadCustomRuleSets;
  App.ensureCustomRuleSetsLoaded = () => loadCustomRuleSets({ force: false });
  const invalidateRuleCaches = App.invalidateRuleCaches;
  App.invalidateRuleCaches = () => {
    customRuleSetsGeneration++;
    customRuleSetsLoading = null;
    customRuleSetsReady = false;
    if (invalidateRuleCaches) invalidateRuleCaches();
  };
  const releaseRuleCache = App.releaseRuleCache;
  App.releaseRuleCache = () => {
    customRuleSetsGeneration++;
    customRuleSetsLoading = null;
    customRuleSetsReady = false;
    $('#crsList').textContent = '';
    if (releaseRuleCache) releaseRuleCache();
  };
})();
