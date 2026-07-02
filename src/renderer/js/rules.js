'use strict';
// Rules tab: the routing rule list (live from the Clash API when running,
// otherwise from the generated config) and user-defined local rules.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  // ---------- Rule list ----------
  // Normalized once on load with a prebuilt lowercase search key, so typing in
  // the filter box only filters — it does not re-map the whole rule list.
  const MAX_RENDERED_RULES = 400;
  let ruleItems = [];
  let ruleSrc = 'config';
  let rulesReady = false;
  let rulesLoading = null;
  let localRulesReady = false;
  let localRulesLoading = null;
  let ruleGroupsReady = false;
  let ruleGroupsLoading = null;
  function normalizeRules(data) {
    const live = data.live && data.live.length ? data.live : null;
    ruleSrc = live ? 'live' : 'config';
    // Live rules are strings/objects from the Clash API; config rules are objects.
    ruleItems = live
      ? live.map((r) => ({ type: r.type || '', payload: String(r.payload || ''), proxy: r.proxy || '' }))
      : (data.rules || []).map((r) => {
          const d = describeRule(r);
          return { type: d.type, payload: String(d.payload), proxy: r.outbound || r.action || '' };
        });
    for (const it of ruleItems) it.key = (it.type + it.payload + it.proxy).toLowerCase();
  }
  function renderRules() {
    const filter = ($('#ruleFilter').value || '').toLowerCase();
    const filtered = filter ? ruleItems.filter((it) => it.key.includes(filter)) : ruleItems;
    const shown = filtered.slice(0, MAX_RENDERED_RULES);
    const limited = shown.length < filtered.length;
    $('#ruleCount').textContent =
      t('rules.count', filtered.length) +
      (limited ? ' · ' + shown.length + '/' + filtered.length : '') +
      ' · ' + t('rules.' + ruleSrc);
    const list = $('#ruleList');
    if (filtered.length === 0) {
      list.innerHTML = `<p class="hint">${t('rules.empty')}</p>`;
      return;
    }
    let html = '';
    for (const it of shown) {
      html += `<div class="rule-item"><span class="rule-type">${escapeHtml(it.type)}</span>` +
        `<span class="rule-payload">${escapeHtml(it.payload)}</span>` +
        `<span class="rule-proxy">${escapeHtml(it.proxy)}</span></div>`;
    }
    if (limited) html += `<p class="hint rule-more">${shown.length}/${filtered.length}</p>`;
    list.innerHTML = html;
  }

  // Describe a sing-box route rule object compactly as { type, payload }.
  function describeRule(r) {
    const join = (v) => [].concat(v).join(', ');
    if (r.protocol) return { type: 'protocol', payload: join(r.protocol) };
    if (r.rule_set) return { type: 'rule_set', payload: join(r.rule_set) };
    if (r.clash_mode) return { type: 'clash_mode', payload: r.clash_mode };
    if (r.ip_is_private) return { type: 'ip_is_private', payload: 'private IP' };
    if (r.domain_suffix) return { type: 'domain', payload: join(r.domain_suffix) };
    if (r.domain) return { type: 'domain', payload: join(r.domain) };
    if (r.domain_keyword) return { type: 'domain', payload: join(r.domain_keyword) };
    if (r.action) return { type: 'action', payload: r.action };
    return { type: 'rule', payload: JSON.stringify(r) };
  }

  async function loadRules(options = {}) {
    if (options.force === false && rulesReady) {
      renderRules();
      return;
    }
    if (rulesLoading) return rulesLoading;
    rulesLoading = (async () => {
      try {
        normalizeRules(await api.getRules());
        rulesReady = true;
        renderRules();
      } catch (e) {
        /* ignore */
      } finally {
        rulesLoading = null;
      }
    })();
    return rulesLoading;
  }

  $('#ruleFilter').addEventListener('input', renderRules);
  $('#ruleRefresh').addEventListener('click', () => loadRules({ force: true }));

  // ---------- Subscription policy-group outbound overrides ----------
  // The subscription's own rules keep their matching, but the user picks where
  // each policy group routes (proxy / direct / reject). Saved as a name->target
  // map in settings; the core restarts to apply.
  async function loadRuleGroups(options = {}) {
    const list = $('#ruleGroupList');
    if (!list) return;
    if (options.force === false && ruleGroupsReady) return;
    if (ruleGroupsLoading) return ruleGroupsLoading;
    ruleGroupsLoading = (async () => {
      let info;
      try {
        info = await api.getRuleGroups();
      } catch (e) {
        return;
      }
      const groups = info.groups || [];
      const overrides = info.overrides || {};
      if (!groups.length) {
        list.innerHTML = `<p class="hint">${t('rulegroups.empty')}</p>`;
        ruleGroupsReady = true;
        return;
      }
      const opts = [
        ['proxy', t('customrs.targetProxy')],
        ['direct', t('customrs.targetDirect')],
        ['reject', t('customrs.targetReject')],
      ];
      list.innerHTML = '';
      for (const g of groups) {
        const cur = overrides[g] || 'proxy';
        const div = document.createElement('div');
        div.className = 'sub-item';
        const sel = opts
          .map(([v, label]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`)
          .join('');
        div.innerHTML = `
          <div class="sub-info">
            <div class="sub-name">${escapeHtml(g)}</div>
          </div>
          <div class="sub-actions">
            <select class="input small" data-group="${escapeHtml(g)}">${sel}</select>
          </div>`;
        list.appendChild(div);
      }
      list.querySelectorAll('select[data-group]').forEach((sel) => {
        sel.addEventListener('change', async () => {
          const next = { ...(info.overrides || {}) };
          const g = sel.dataset.group;
          if (sel.value === 'proxy') delete next[g]; // proxy is the default; keep the map small
          else next[g] = sel.value;
          sel.disabled = true;
          try {
            App.state.settings = await call(api.updateSettings, { ruleOverrides: next });
            info.overrides = next;
            toast(t('settings.saved'));
            if (App.state.status && App.state.status.running) loadRules();
          } finally {
            sel.disabled = false;
          }
        });
      });
      if (App.enhanceSelects) App.enhanceSelects(list); // style these freshly-built selects
      ruleGroupsReady = true;
    })().finally(() => {
      ruleGroupsLoading = null;
    });
    return ruleGroupsLoading;
  }
  $('#ruleGroupRefresh').addEventListener('click', () => loadRuleGroups({ force: true }));

  // ---------- Local rules ----------
  const MATCH_LABELS = {
    domain: 'DOMAIN',
    domain_suffix: 'DOMAIN-SUFFIX',
    domain_keyword: 'DOMAIN-KEYWORD',
    ip_cidr: 'IP-CIDR',
    process_name: 'PROCESS-NAME',
  };
  async function loadLocalRules(options = {}) {
    if (options.force === false && localRulesReady) return;
    if (localRulesLoading) return localRulesLoading;
    localRulesLoading = (async () => {
      try {
        renderLocalRules(await api.listLocalRules());
        localRulesReady = true;
      } catch (e) {
        /* ignore */
      } finally {
        localRulesLoading = null;
      }
    })();
    return localRulesLoading;
  }
  function renderLocalRules(items) {
    const list = $('#lrList');
    if (!list) return;
    list.innerHTML = '';
    if (!items || !items.length) {
      list.innerHTML = `<p class="hint">${t('localrules.empty')}</p>`;
      return;
    }
    const tgt = { proxy: t('customrs.targetProxy'), direct: t('customrs.targetDirect'), reject: t('customrs.targetReject') };
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'sub-item';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-name">${escapeHtml(it.name || MATCH_LABELS[it.matchType] || it.matchType)}${it.enabled ? '' : ' · ⏸'}</div>
          <div class="sub-meta">${MATCH_LABELS[it.matchType] || it.matchType} · ${tgt[it.target] || it.target} · ${t('localrules.count', (it.values || []).length)}</div>
        </div>
        <div class="sub-actions">
          <button class="btn" data-act="toggle" data-id="${it.id}">${it.enabled ? t('customrs.disable') : t('customrs.enable')}</button>
          <button class="btn" data-act="edit" data-id="${it.id}">${t('subs.edit')}</button>
          <button class="btn danger" data-act="remove" data-id="${it.id}">${t('customrs.remove')}</button>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        const items2 = await api.listLocalRules();
        const it = items2.find((x) => x.id === id);
        if (act === 'edit') {
          if (it) openLocalRuleModal(it);
          return;
        }
        b.disabled = true;
        try {
          if (act === 'remove') await call(api.removeLocalRule, { id });
          else if (act === 'toggle') await call(api.editLocalRule, { id, enabled: !(it && it.enabled) });
          await loadLocalRules();
          if (App.state.status && App.state.status.running) loadRules();
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  let editingLrId = null;
  function openLocalRuleModal(lr) {
    editingLrId = lr ? lr.id : null;
    $('#lrModalTitle').textContent = lr ? t('localrules.editTitle') : t('localrules.title');
    $('#lrName').value = lr ? lr.name || '' : '';
    $('#lrType').value = lr ? lr.matchType : 'domain';
    $('#lrTarget').value = lr ? lr.target : 'proxy';
    $('#lrValues').value = lr ? (lr.values || []).join('\n') : '';
    $('#localRuleModal').classList.remove('hidden');
    $('#lrName').focus();
  }
  function closeLocalRuleModal() {
    editingLrId = null;
    $('#localRuleModal').classList.add('hidden');
  }

  $('#lrAdd').addEventListener('click', () => openLocalRuleModal(null));
  $('#lrCancel').addEventListener('click', closeLocalRuleModal);
  $('#localRuleModal').addEventListener('click', (e) => {
    if (e.target.id === 'localRuleModal') closeLocalRuleModal();
  });
  $('#lrSave').addEventListener('click', async () => {
    const values = $('#lrValues').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!values.length) return toast(t('localrules.needValues'), true);
    const payload = {
      name: $('#lrName').value.trim(),
      matchType: $('#lrType').value,
      target: $('#lrTarget').value,
      values,
    };
    const btn = $('#lrSave');
    btn.disabled = true;
    try {
      if (editingLrId) await call(api.editLocalRule, { id: editingLrId, ...payload });
      else await call(api.addLocalRule, payload);
      toast(t('settings.saved'));
      closeLocalRuleModal();
      await loadLocalRules();
      if (App.state.status && App.state.status.running) loadRules();
    } finally {
      btn.disabled = false;
    }
  });

  function invalidateRuleCaches() {
    rulesReady = false;
    localRulesReady = false;
    ruleGroupsReady = false;
  }

  App.loadRules = loadRules;
  App.loadLocalRules = loadLocalRules;
  App.loadRuleGroups = loadRuleGroups;
  App.ensureRulesLoaded = () => loadRules({ force: false });
  App.ensureLocalRulesLoaded = () => loadLocalRules({ force: false });
  App.ensureRuleGroupsLoaded = () => loadRuleGroups({ force: false });
  App.invalidateRuleCaches = invalidateRuleCaches;
})();
