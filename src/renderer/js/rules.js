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
  const VIRTUAL_RULE_ROW_HEIGHT = 44;
  const VIRTUAL_OVERSCAN = 8;
  let ruleItems = [];
  let visibleRuleItems = [];
  let ruleSrc = 'config';
  let rulesReady = false;
  let rulesLoading = null;
  let ruleLoadGeneration = 0;
  let ruleFilterTimer = null;
  let localRulesReady = false;
  let localRulesLoading = null;
  let ruleManagerView = 'local';

  function setRuleManagerView(view, { focus = false } = {}) {
    if (view !== 'local' && view !== 'remote') return;
    ruleManagerView = view;
    $('#localRuleManager').hidden = view !== 'local';
    $('#remoteRuleManager').hidden = view !== 'remote';
    $('#ruleManagerTabs').querySelectorAll('[data-rule-manager-view]').forEach((button) => {
      const selected = button.dataset.ruleManagerView === view;
      button.classList.toggle('primary', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    if (App.refreshSelects) {
      App.refreshSelects(view === 'remote' ? $('#remoteRuleManager') : $('#localRuleManager'));
    }
  }

  $('#ruleManagerTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-rule-manager-view]');
    if (button) setRuleManagerView(button.dataset.ruleManagerView);
  });
  $('#ruleManagerTabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...$('#ruleManagerTabs').querySelectorAll('[data-rule-manager-view]')];
    const current = Math.max(0, tabs.indexOf(event.target.closest('[data-rule-manager-view]')));
    const index = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    setRuleManagerView(tabs[index].dataset.ruleManagerView, { focus: true });
  });
  setRuleManagerView(ruleManagerView);
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
  function renderRuleWindow() {
    const list = $('#ruleList');
    if (!visibleRuleItems.length) {
      list.classList.add('is-empty');
      list.innerHTML = `<p class="hint">${t('rules.empty')}</p>`;
      return;
    }
    list.classList.remove('is-empty');
    const visible = Math.ceil((list.clientHeight || 480) / VIRTUAL_RULE_ROW_HEIGHT);
    const start = Math.max(0, Math.floor(list.scrollTop / VIRTUAL_RULE_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    const end = Math.min(visibleRuleItems.length, start + visible + VIRTUAL_OVERSCAN * 2);
    let html = start ? `<div class="virtual-spacer" style="height:${start * VIRTUAL_RULE_ROW_HEIGHT}px"></div>` : '';
    for (let i = start; i < end; i++) {
      const it = visibleRuleItems[i];
      html += `<div class="rule-item"><span class="rule-type">${escapeHtml(it.type)}</span>` +
        `<span class="rule-payload">${escapeHtml(it.payload)}</span>` +
        `<span class="rule-proxy">${escapeHtml(it.proxy)}</span></div>`;
    }
    const after = visibleRuleItems.length - end;
    if (after) html += `<div class="virtual-spacer" style="height:${after * VIRTUAL_RULE_ROW_HEIGHT}px"></div>`;
    list.innerHTML = html;
  }

  function renderRules() {
    const filter = ($('#ruleFilter').value || '').toLowerCase();
    visibleRuleItems = filter ? ruleItems.filter((it) => it.key.includes(filter)) : ruleItems;
    $('#ruleCount').textContent = t('rules.count', visibleRuleItems.length) + ' · ' + t('rules.' + ruleSrc);
    renderRuleWindow();
  }

  // Describe a generated rule compactly as { type, payload }.
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
    const generation = ruleLoadGeneration;
    const request = (async () => {
      try {
        const data = await api.getRules();
        if (generation !== ruleLoadGeneration) return;
        normalizeRules(data);
        rulesReady = true;
        renderRules();
      } catch (e) {
        /* ignore */
      }
    })().finally(() => {
      if (rulesLoading === request) rulesLoading = null;
    });
    rulesLoading = request;
    return request;
  }

  $('#ruleFilter').addEventListener('input', () => {
    clearTimeout(ruleFilterTimer);
    ruleFilterTimer = setTimeout(() => {
      ruleFilterTimer = null;
      $('#ruleList').scrollTop = 0;
      renderRules();
    }, 80);
  });
  let ruleScrollQueued = false;
  $('#ruleList').addEventListener('scroll', () => {
    if (ruleScrollQueued) return;
    ruleScrollQueued = true;
    requestAnimationFrame(() => {
      ruleScrollQueued = false;
      renderRuleWindow();
    });
  });
  $('#ruleRefresh').addEventListener('click', () => loadRules({ force: true }));

  // ---------- Local rules ----------
  const MATCH_LABELS = {
    domain: 'DOMAIN',
    domain_suffix: 'DOMAIN-SUFFIX',
    domain_keyword: 'DOMAIN-KEYWORD',
    ip_cidr: 'IP-CIDR',
    ip_asn: 'IP-ASN',
    process_name: 'PROCESS-NAME',
  };
  async function loadLocalRules(options = {}) {
    if (options.force === false && localRulesReady) return;
    if (localRulesLoading) return localRulesLoading;
    const generation = ruleLoadGeneration;
    const request = (async () => {
      try {
        const items = await api.listLocalRules();
        if (generation !== ruleLoadGeneration) return;
        renderLocalRules(items);
        localRulesReady = true;
      } catch (e) {
        /* ignore */
      }
    })().finally(() => {
      if (localRulesLoading === request) localRulesLoading = null;
    });
    localRulesLoading = request;
    return request;
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
      const textMode = it.mode === 'text';
      const matchLabel = escapeHtml(textMode ? t('localrules.textType') : (MATCH_LABELS[it.matchType] || it.matchType || ''));
      const targetLabel = escapeHtml(textMode ? t('localrules.inlineTargets') : (tgt[it.target] || it.target || ''));
      const count = textMode ? (it.rules || []).length : (it.values || []).length;
      const id = escapeHtml(it.id);
      const itemName = it.name || (textMode ? t('localrules.textType') : (MATCH_LABELS[it.matchType] || it.matchType || ''));
      const actionLabel = (label) => escapeHtml(`${label}: ${itemName}`);
      const div = document.createElement('div');
      div.className = 'sub-item';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-name">${escapeHtml(itemName)}${it.enabled ? '' : ' · ⏸'}</div>
          <div class="sub-meta">${matchLabel} · ${targetLabel} · ${t('localrules.count', count)}</div>
        </div>
        <div class="sub-actions">
          <button type="button" class="btn" data-act="toggle" data-id="${id}" aria-label="${actionLabel(it.enabled ? t('customrs.disable') : t('customrs.enable'))}">${it.enabled ? t('customrs.disable') : t('customrs.enable')}</button>
          <button type="button" class="btn" data-act="edit" data-id="${id}" aria-label="${actionLabel(t('subs.edit'))}">${t('subs.edit')}</button>
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
          const items2 = await call(api.listLocalRules);
          const it = items2.find((x) => x.id === id);
          if (act === 'edit') {
            if (it) await App.openDialog('local-rule', { id });
            return;
          }
          if (act === 'remove') await call(api.removeLocalRule, { id });
          else if (act === 'toggle') await call(api.editLocalRule, { id, enabled: !(it && it.enabled) });
          invalidateRuleCaches();
          await Promise.all([loadLocalRules({ force: true }), loadRules({ force: true })]);
        } catch (_) {
          /* call() already showed the error */
        } finally {
          b.disabled = false;
          b.removeAttribute('aria-busy');
        }
      });
    });
  }

  $('#lrAdd').addEventListener('click', () => App.openDialog('local-rule'));

  function invalidateRuleCaches() {
    if (ruleFilterTimer) clearTimeout(ruleFilterTimer);
    ruleFilterTimer = null;
    ruleLoadGeneration++;
    rulesLoading = null;
    localRulesLoading = null;
    rulesReady = false;
    localRulesReady = false;
  }

  function releaseRuleCache() {
    invalidateRuleCaches();
    ruleItems = [];
    visibleRuleItems = [];
    $('#ruleList').classList.remove('is-empty');
    $('#ruleList').textContent = '';
    $('#ruleCount').textContent = '';
    $('#lrList').textContent = '';
  }

  App.loadRules = loadRules;
  App.loadLocalRules = loadLocalRules;
  App.ensureRulesLoaded = () => loadRules({ force: false });
  App.ensureLocalRulesLoaded = () => loadLocalRules({ force: false });
  App.invalidateRuleCaches = invalidateRuleCaches;
  App.releaseRuleCache = releaseRuleCache;
  App.registerRendererModule('rules');
})();
