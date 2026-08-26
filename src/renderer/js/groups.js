'use strict';
// Policy Groups tab: source-policy overrides and live outbound selections.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  let groupsReady = false;
  let groupsLoading = null;
  let groupLoadGeneration = 0;
  let groupInfo = null;
  let expandedGroup = '';
  let mutationPending = false;

  function pickOptionLabel(value) {
    if (value === '🚀 Proxy') return t('rulegroups.followProxy');
    if (value === 'direct' || value === 'DIRECT') return 'DIRECT';
    if (value === 'reject' || value === 'REJECT') return 'REJECT';
    return value;
  }

  function targetLabels() {
    return {
      source: t('rulegroups.targetSource'),
      proxy: t('customrs.targetProxy'),
      direct: t('customrs.targetDirect'),
      reject: t('customrs.targetReject'),
    };
  }

  function normalizedPick(value) {
    if (/^direct$/i.test(value || '')) return 'direct';
    if (/^reject(?:-drop)?$/i.test(value || '')) return 'reject';
    return value;
  }

  function samePick(left, right) {
    return normalizedPick(left) === normalizedPick(right);
  }

  function availablePicks(info, groupName, pickValue) {
    const source = (info.picksByGroup && info.picksByGroup[groupName]) || info.pickOptions || [];
    const available = Array.isArray(source) ? source : [];
    return available.some((value) => samePick(value, pickValue)) ? available : [pickValue, ...available];
  }

  function policyGroupCardHtml(info, groupName, context = {}) {
    const labels = context.labels || targetLabels();
    const overrides = info.overrides || {};
    const selections = info.selections || {};
    const defaults = info.defaults || {};
    const sourceTargets = context.sourceTargets || new Set(info.sourceTargets || []);
    const selectableTargets = context.selectableTargets || new Set(info.selectableTargets || []);
    const hasSourceTarget = sourceTargets.has(groupName);
    const selectable = selectableTargets.has(groupName);
    const modes = hasSourceTarget ? ['source', 'proxy', 'direct', 'reject'] : ['proxy', 'direct', 'reject'];
    const current = overrides[groupName] || (hasSourceTarget ? 'source' : 'proxy');
    const pickValue = selections[groupName] || defaults[groupName] || '🚀 Proxy';
    const expanded = selectable && current === 'source' && expandedGroup === groupName;
    const modeButtons = modes.map((mode) => `
      <button type="button" class="btn compact rule-group-mode${mode === current ? ' primary' : ''}"
        data-action="set-mode" data-group="${escapeHtml(groupName)}" data-mode="${mode}"
        aria-pressed="${mode === current}">${escapeHtml(labels[mode])}</button>`).join('');
    let outbound = '';
    if (selectable && current === 'source') {
      const picks = availablePicks(info, groupName, pickValue);
      const search = picks.length > 8
        ? `<input class="input rule-group-search" data-role="pick-filter" data-group="${escapeHtml(groupName)}"
            aria-label="${escapeHtml(t('rulegroups.searchOutbound'))}" placeholder="${escapeHtml(t('rulegroups.searchOutbound'))}" autocomplete="off" />`
        : '';
      const choices = expanded ? picks.map((value) => `
        <button type="button" class="btn compact rule-group-choice${samePick(value, pickValue) ? ' primary' : ''}"
          data-action="set-pick" data-group="${escapeHtml(groupName)}" data-value="${escapeHtml(value)}"
          data-search-key="${escapeHtml(String(value).toLocaleLowerCase())}" aria-pressed="${samePick(value, pickValue)}"
          title="${escapeHtml(value)}"><span>${escapeHtml(pickOptionLabel(value))}</span></button>`).join('') : '';
      outbound = `
        <button type="button" class="rule-group-outbound" data-action="toggle-picker"
          data-group="${escapeHtml(groupName)}" aria-expanded="${expanded}">
          <span class="rule-group-outbound-label">${escapeHtml(t('rulegroups.currentOutbound'))}</span>
          <strong title="${escapeHtml(pickValue)}">${escapeHtml(pickOptionLabel(pickValue))}</strong>
          <span class="rule-group-outbound-action">${escapeHtml(t(expanded ? 'rulegroups.collapseOutbound' : 'rulegroups.changeOutbound'))}<span class="rule-group-chevron" aria-hidden="true"></span></span>
        </button>
        ${expanded ? `<div class="rule-group-picker">${search}<div class="rule-group-choices" role="group" aria-label="${escapeHtml(t('rulegroups.pickOutbound'))}">${choices}</div></div>` : ''}`;
    }
    return `
      <article class="sub-item rule-group-item${expanded ? ' is-expanded' : ''}" data-group-card="${escapeHtml(groupName)}">
        <strong class="sub-name rule-group-name" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</strong>
        <div class="rule-group-actions" role="group" aria-label="${escapeHtml(groupName + ': ' + t('localrules.target'))}">${modeButtons}</div>
        ${outbound}
      </article>`;
  }

  function renderPolicyGroups(info, { preserveScroll = false } = {}) {
    const list = $('#ruleGroupList');
    if (!list) return;
    const scrollTop = preserveScroll ? list.scrollTop : 0;
    const groups = info.groups || [];
    if (!groups.length) {
      list.innerHTML = `<p class="hint">${t('rulegroups.empty')}</p>`;
      return;
    }

    const labels = targetLabels();
    const context = {
      labels,
      sourceTargets: new Set(info.sourceTargets || []),
      selectableTargets: new Set(info.selectableTargets || []),
    };
    list.innerHTML = groups.map((groupName) => policyGroupCardHtml(info, groupName, context)).join('');
    if (preserveScroll) list.scrollTop = scrollTop;
  }

  function patchPolicyGroupCard(info, groupName) {
    const list = $('#ruleGroupList');
    if (!list) return;
    const current = [...list.querySelectorAll('[data-group-card]')]
      .find((card) => card.dataset.groupCard === groupName);
    if (!current) {
      renderPolicyGroups(info, { preserveScroll: true });
      return;
    }
    const template = document.createElement('template');
    template.innerHTML = policyGroupCardHtml(info, groupName).trim();
    const replacement = template.content.firstElementChild;
    if (replacement) current.replaceWith(replacement);
  }

  function refreshPolicyGroupLabels() {
    if (groupInfo) renderPolicyGroups(groupInfo, { preserveScroll: true });
    else {
      const empty = $('#ruleGroupList .hint');
      if (empty) empty.textContent = t('rulegroups.empty');
    }
  }

  async function loadPolicyGroups(options = {}) {
    const list = $('#ruleGroupList');
    if (!list) return;
    if (options.force === false && groupsReady) return;
    if (groupsLoading) return groupsLoading;
    const generation = groupLoadGeneration;
    const request = (async () => {
      let info;
      try {
        info = await api.getRuleGroups();
      } catch (_) {
        return;
      }
      if (generation !== groupLoadGeneration) return;
      groupInfo = info;
      if (!(info.groups || []).includes(expandedGroup)) expandedGroup = '';
      renderPolicyGroups(info, { preserveScroll: !!options.preserveScroll });
      groupsReady = true;
    })().finally(() => {
      if (groupsLoading === request) groupsLoading = null;
    });
    groupsLoading = request;
    return request;
  }

  function setGroupsBusy(busy) {
    const list = $('#ruleGroupList');
    if (!list) return;
    list.setAttribute('aria-busy', String(busy));
    // mutationPending already serializes actions. Keep controls visually
    // stable while the core applies a change instead of dimming every card.
    list.querySelectorAll('button, input').forEach((control) => {
      if (busy) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    });
  }

  async function reconcilePolicyGroups(info, generation) {
    if (generation === groupLoadGeneration && groupInfo === info) {
      groupsReady = true;
      return;
    }
    // A profile/config refresh can still invalidate this page while a mutation
    // is pending. Reload authoritative state instead of publishing stale data.
    if (App.currentTab === 'groups' && !document.hidden) {
      await loadPolicyGroups({ force: true, preserveScroll: true });
    }
  }

  async function reloadPolicyGroupsAfterFailure() {
    invalidatePolicyGroupCache();
    if (App.currentTab === 'groups' && !document.hidden) {
      await loadPolicyGroups({ force: true, preserveScroll: true });
    }
  }

  async function setGroupMode(button) {
    if (!groupInfo || mutationPending) return;
    const info = groupInfo;
    const generation = groupLoadGeneration;
    const groupName = button.dataset.group;
    const mode = button.dataset.mode;
    const hasSourceTarget = (info.sourceTargets || []).includes(groupName);
    const current = (info.overrides || {})[groupName] || (hasSourceTarget ? 'source' : 'proxy');
    if (mode === current) return;
    const previousOverrides = info.overrides || {};
    const next = { ...(info.overrides || {}) };
    next[groupName] = mode;
    mutationPending = true;
    info.overrides = next;
    if (mode !== 'source') expandedGroup = '';
    patchPolicyGroupCard(info, groupName);
    setGroupsBusy(true);
    try {
      App.commitSettings(await call(api.updateSettings, { ruleOverrides: next }));
      if (App.invalidateRuleCaches) App.invalidateRuleCaches();
      await reconcilePolicyGroups(info, generation);
      toast(t('settings.saved'));
    } catch (_) {
      if (groupInfo === info) {
        info.overrides = previousOverrides;
        patchPolicyGroupCard(info, groupName);
      }
      await reloadPolicyGroupsAfterFailure();
    } finally {
      mutationPending = false;
      setGroupsBusy(false);
    }
  }

  async function setGroupPick(button) {
    if (!groupInfo || mutationPending) return;
    const info = groupInfo;
    const generation = groupLoadGeneration;
    const groupName = button.dataset.group;
    const value = button.dataset.value;
    const previousSelections = info.selections || {};
    mutationPending = true;
    info.selections = { ...previousSelections, [groupName]: value };
    expandedGroup = '';
    patchPolicyGroupCard(info, groupName);
    setGroupsBusy(true);
    try {
      const result = await call(api.setRuleGroupOutbound, groupName, value);
      if (result && result.settings) App.commitSettings(result.settings);
      if (result && result.applied === false && App.state.status && App.state.status.running) {
        await call(api.restartCore);
      }
      await reconcilePolicyGroups(info, generation);
      toast(t('settings.saved'));
    } catch (_) {
      if (groupInfo === info) {
        info.selections = previousSelections;
        patchPolicyGroupCard(info, groupName);
      }
      await reloadPolicyGroupsAfterFailure();
    } finally {
      mutationPending = false;
      setGroupsBusy(false);
    }
  }

  $('#ruleGroupList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled || mutationPending) return;
    if (button.dataset.action === 'toggle-picker') {
      expandedGroup = expandedGroup === button.dataset.group ? '' : button.dataset.group;
      renderPolicyGroups(groupInfo, { preserveScroll: true });
    } else if (button.dataset.action === 'set-mode') {
      setGroupMode(button);
    } else if (button.dataset.action === 'set-pick') {
      setGroupPick(button);
    }
  });

  $('#ruleGroupList').addEventListener('input', (event) => {
    const input = event.target.closest('input[data-role="pick-filter"]');
    if (!input) return;
    const query = input.value.trim().toLocaleLowerCase();
    const picker = input.closest('.rule-group-picker');
    picker.querySelectorAll('.rule-group-choice').forEach((button) => {
      button.hidden = !!query && !button.dataset.searchKey.includes(query);
    });
  });

  function invalidatePolicyGroupCache() {
    groupLoadGeneration++;
    groupsLoading = null;
    groupsReady = false;
  }

  function releasePolicyGroupCache() {
    invalidatePolicyGroupCache();
    groupInfo = null;
    expandedGroup = '';
    const list = $('#ruleGroupList');
    if (list) list.textContent = '';
  }

  $('#ruleGroupRefresh').addEventListener('click', () => {
    expandedGroup = '';
    loadPolicyGroups({ force: true });
  });
  App.loadPolicyGroups = loadPolicyGroups;
  App.ensurePolicyGroupsLoaded = () => loadPolicyGroups({ force: false });
  App.refreshPolicyGroupLabels = refreshPolicyGroupLabels;
  App.invalidatePolicyGroupCache = invalidatePolicyGroupCache;
  App.releasePolicyGroupCache = releasePolicyGroupCache;
  App.registerRendererModule('groups');
})();
