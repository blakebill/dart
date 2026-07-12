'use strict';
// Route, network, config, port, backup and DNS tools. Privileged work stays in
// the main process; this module only validates presence, invokes IPC and renders
// escaped structured results.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml, fmtBytes } = App;
  const api = window.api;
  const { t } = window.i18n;

  let lastRoute = null;
  let lastDiagnostics = null;
  let lastConfigCheck = null;
  let lastPorts = null;
  let selectedBackup = null;
  let lastDns = null;

  function bindModal(modalId, openId, closeId, onOpen) {
    const modal = $(modalId);
    $(openId).addEventListener('click', () => {
      modal.classList.remove('hidden');
      if (onOpen) onOpen();
    });
    $(closeId).addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (event) => {
      if (event.target === modal) modal.classList.add('hidden');
    });
  }

  async function runBusy(button, busyKey, operation) {
    button.disabled = true;
    button.textContent = t(busyKey);
    try {
      return await operation();
    } finally {
      button.disabled = false;
      button.textContent = t(button.dataset.i18n || busyKey);
    }
  }

  function statusBadge(status) {
    const normalized = ['pass', 'warn', 'fail', 'skip', 'missing'].includes(status) ? status : 'skip';
    return `<span class="tool-status ${normalized}">${escapeHtml(t('toolbox.status.' + normalized))}</span>`;
  }

  function resultRow(label, value, status = null) {
    return `<div class="tool-result-row"><span>${escapeHtml(label)}</span><div>${status ? statusBadge(status) : ''}<b>${escapeHtml(value === undefined || value === null || value === '' ? '-' : String(value))}</b></div></div>`;
  }

  function emptyResult(key = 'toolbox.notRun') {
    return `<p class="tool-empty">${escapeHtml(t(key))}</p>`;
  }

  function fmtMs(value) {
    return Number.isFinite(value) ? value + ' ms' : '-';
  }

  // ---------- Route inspector ----------
  function renderRoute() {
    const box = $('#routeResult');
    if (!lastRoute) {
      box.innerHTML = emptyResult();
      return;
    }
    const rule = lastRoute.matchedRule || {};
    const dnsPath = lastRoute.dnsPath || {};
    const source = t('toolbox.routeSource.' + (lastRoute.source || 'generated'));
    let html = resultRow(t('toolbox.routeTarget'), lastRoute.target.host);
    html += resultRow(t('toolbox.routeAddresses'), (lastRoute.addresses || []).join(', ') || t('toolbox.none'));
    html += resultRow(t('toolbox.routeSource'), source);
    html += resultRow(t('toolbox.routeRule'), `${rule.type || '-'}${rule.payload ? ' · ' + rule.payload : ''}`);
    html += resultRow(t('toolbox.routePolicy'), lastRoute.policy);
    html += resultRow(t('toolbox.routeChain'), (lastRoute.chain || []).join(' → '));
    html += resultRow(t('toolbox.routeFinal'), lastRoute.finalOutbound);
    html += resultRow(
      t('toolbox.routeDns'),
      dnsPath.skipped ? t('toolbox.notRequired') : `${dnsPath.resolver || '-'} · ${dnsPath.server || '-'} · ${dnsPath.detour || '-'}`
    );
    html += resultRow(t('toolbox.routeConfidence'), t('toolbox.confidence.' + lastRoute.confidence), lastRoute.confidence === 'exact' ? 'pass' : 'warn');
    if (lastRoute.dnsError) html += `<p class="tool-notice warn">${escapeHtml(lastRoute.dnsError)}</p>`;
    if (lastRoute.unresolvedBeforeMatch && lastRoute.unresolvedBeforeMatch.length) {
      const values = lastRoute.unresolvedBeforeMatch.map((item) => `${item.type}: ${item.payload}`).join('\n');
      html += `<div class="tool-notice warn"><b>${escapeHtml(t('toolbox.routeUnresolved'))}</b><pre>${escapeHtml(values)}</pre></div>`;
    }
    box.innerHTML = html;
  }

  bindModal('#routeModal', '#routeOpen', '#routeClose', () => $('#routeInput').focus());
  $('#routeRun').addEventListener('click', async () => {
    const value = $('#routeInput').value.trim();
    if (!value) return toast(t('toolbox.needTarget'), true);
    await runBusy($('#routeRun'), 'toolbox.inspecting', async () => {
      lastRoute = await call(api.inspectRoute, { value });
      renderRoute();
    });
  });

  // ---------- One-click diagnostics ----------
  function renderDiagnostics() {
    const box = $('#diagResult');
    if (!lastDiagnostics) {
      box.innerHTML = emptyResult();
      return;
    }
    let html = `<div class="tool-summary">${['pass', 'warn', 'fail', 'skip'].map((status) =>
      `<span>${statusBadge(status)} ${Number(lastDiagnostics.summary && lastDiagnostics.summary[status]) || 0}</span>`
    ).join('')}</div>`;
    for (const check of lastDiagnostics.checks || []) {
      const title = t('toolbox.diag.' + check.id);
      html += `<div class="tool-check"><div><b>${escapeHtml(title)}</b><span>${escapeHtml(check.detail || '-')}</span></div>` +
        `<div>${statusBadge(check.status)}${check.durationMs !== null && check.durationMs !== undefined ? `<small>${escapeHtml(fmtMs(check.durationMs))}</small>` : ''}</div></div>`;
    }
    box.innerHTML = html;
  }

  bindModal('#diagModal', '#diagOpen', '#diagClose');
  $('#diagRun').addEventListener('click', async () => {
    await runBusy($('#diagRun'), 'toolbox.running', async () => {
      lastDiagnostics = await call(api.runNetworkDiagnostics);
      renderDiagnostics();
      $('#diagExport').classList.remove('hidden');
    });
  });
  $('#diagExport').addEventListener('click', async () => {
    if (!lastDiagnostics) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = await call(api.saveToolReport, {
      name: 'dart-network-diagnostics-' + stamp,
      format: 'json',
      content: JSON.stringify(lastDiagnostics, null, 2),
    });
    if (file) toast(t('toolbox.exported', file));
  });

  // ---------- Config checker ----------
  function renderConfigCheck() {
    const box = $('#configCheckResult');
    if (!lastConfigCheck) {
      box.innerHTML = emptyResult();
      return;
    }
    let html = `<div class="tool-notice"><b>${escapeHtml(lastConfigCheck.source.name || '-')}</b> · ` +
      `${escapeHtml(lastConfigCheck.source.format || '-')} · ${escapeHtml(t('nodes.count', lastConfigCheck.source.nodes || 0))}</div>`;
    if (lastConfigCheck.source.preview) {
      html += `<details class="tool-preview tool-source-preview"><summary>${escapeHtml(t('toolbox.sourcePreview'))}` +
        `${lastConfigCheck.source.truncated ? ' · ' + escapeHtml(t('toolbox.truncated')) : ''}</summary>` +
        `<pre>${escapeHtml(lastConfigCheck.source.preview)}</pre></details>`;
    }
    for (const result of lastConfigCheck.results || []) {
      const validation = result.validation || {};
      const summary = result.summary;
      html += `<section class="tool-section"><div class="tool-section-head"><h4>${escapeHtml(result.coreType)}</h4>${statusBadge(validation.status)}</div>`;
      if (summary) {
        html += '<div class="tool-metrics">';
        html += resultRow(t('toolbox.configFormat'), `${lastConfigCheck.source.format || '-'} → ${summary.format}`);
        html += resultRow(t('toolbox.configNodes'), `${summary.sourceNodes} → ${summary.generatedNodes}${summary.droppedNodes ? ' (-' + summary.droppedNodes + ')' : ''}`, summary.droppedNodes ? 'warn' : 'pass');
        html += resultRow(t('toolbox.configRules'), `${summary.sourceRules} → ${summary.generatedRules}`);
        html += resultRow(t('toolbox.configTun'), summary.tun ? t('state.on') : t('state.off'));
        html += resultRow(t('toolbox.configDns'), summary.dns ? t('state.on') : t('state.off'));
        html += resultRow(t('toolbox.configSize'), `${fmtBytes(summary.bytes)} · ${summary.lines} ${t('toolbox.lines')}`);
        html += '</div>';
      }
      const location = validation.location || {};
      const where = [location.path, location.line ? t('toolbox.line', location.line) : '', location.column ? t('toolbox.column', location.column) : ''].filter(Boolean).join(' · ');
      html += `<div class="tool-validation ${escapeHtml(validation.status || 'missing')}"><b>${escapeHtml(where || t('toolbox.validationOutput'))}</b><pre>${escapeHtml(validation.message || '-')}</pre></div>`;
      if (result.preview) {
        html += `<details class="tool-preview"><summary>${escapeHtml(t('toolbox.generatedPreview', result.coreType))}${result.truncated ? ' · ' + escapeHtml(t('toolbox.truncated')) : ''}</summary><pre>${escapeHtml(result.preview)}</pre></details>`;
      }
      html += '</section>';
    }
    box.innerHTML = html;
  }

  bindModal('#configCheckModal', '#configCheckOpen', '#configCheckClose');
  $('#configCheckRun').addEventListener('click', async () => {
    await runBusy($('#configCheckRun'), 'toolbox.validating', async () => {
      lastConfigCheck = await call(api.checkAllConfigs);
      renderConfigCheck();
    });
  });

  // ---------- Port inspector ----------
  function renderPorts() {
    const box = $('#portResult');
    if (!lastPorts) {
      box.innerHTML = emptyResult();
      return;
    }
    let html = '';
    for (const item of lastPorts) {
      let status = 'pass';
      if (item.conflict) status = 'fail';
      else if (item.expected && !item.listening) status = 'fail';
      else if (!item.expected && item.listening) status = 'warn';
      const owner = item.owner ? `${item.owner.name || t('toolbox.unknownProcess')}${item.owner.pid ? ' (PID ' + item.owner.pid + ')' : ''}` : '-';
      const state = item.listening ? t('toolbox.listening') : t('toolbox.available');
      html += `<div class="tool-check"><div><b>:${item.port} · ${escapeHtml(t('toolbox.portRole.' + item.role))}</b>` +
        `<span>${escapeHtml(state)} · ${escapeHtml(owner)}</span></div><div>${statusBadge(status)}<small>${escapeHtml(fmtMs(item.durationMs))}</small></div></div>`;
    }
    box.innerHTML = html || emptyResult();
  }

  bindModal('#portModal', '#portOpen', '#portClose', () => $('#portInput').focus());
  $('#portRun').addEventListener('click', async () => {
    const ports = $('#portInput').value.trim();
    if (!ports) return toast(t('toolbox.needPorts'), true);
    await runBusy($('#portRun'), 'toolbox.inspecting', async () => {
      lastPorts = await call(api.inspectPorts, { ports });
      renderPorts();
    });
  });

  // ---------- Backup and restore ----------
  function renderBackup() {
    const box = $('#backupResult');
    if (!selectedBackup) {
      box.innerHTML = emptyResult('toolbox.backupEmpty');
      return;
    }
    const summary = selectedBackup.summary || {};
    let html = resultRow(t('toolbox.backupFile'), selectedBackup.fileName);
    html += resultRow(t('toolbox.backupCreated'), summary.createdAt || '-');
    html += resultRow(t('toolbox.backupVersion'), summary.appVersion || '-');
    html += resultRow(t('toolbox.backupCore'), summary.coreType || '-');
    html += resultRow(t('toolbox.backupConfigs'), summary.configs || 0);
    html += resultRow(t('toolbox.backupNodes'), summary.nodes || 0);
    html += resultRow(t('toolbox.backupRules'), `${summary.localRules || 0} / ${summary.remoteRules || 0}`);
    html += `<p class="tool-notice warn">${escapeHtml(t('toolbox.restoreWarning'))}</p>`;
    box.innerHTML = html;
  }

  bindModal('#backupModal', '#backupOpen', '#backupClose');
  $('#backupExport').addEventListener('click', async () => {
    await runBusy($('#backupExport'), 'toolbox.exporting', async () => {
      const file = await call(api.exportBackup);
      if (file) toast(t('toolbox.backupExported', file));
    });
  });
  $('#backupSelect').addEventListener('click', async () => {
    await runBusy($('#backupSelect'), 'toolbox.reading', async () => {
      selectedBackup = await call(api.selectBackup);
      renderBackup();
      $('#backupRestore').classList.toggle('hidden', !selectedBackup);
    });
  });
  $('#backupRestore').addEventListener('click', async () => {
    if (!selectedBackup) return;
    await runBusy($('#backupRestore'), 'toolbox.restoring', async () => {
      const result = await call(api.restoreBackup, { token: selectedBackup.token });
      selectedBackup = null;
      $('#backupRestore').classList.add('hidden');
      renderBackup();
      await App.refresh();
      toast(result.stoppedCore ? t('toolbox.restoredStopped') : t('toolbox.restored'));
    });
  });

  // ---------- DNS comparison ----------
  function renderDns() {
    const box = $('#dnsResult');
    if (!lastDns) {
      box.innerHTML = emptyResult();
      return;
    }
    let html = `<div class="tool-notice"><b>${escapeHtml(lastDns.host)}</b></div>`;
    const assessment = lastDns.assessment || { status: 'skip', result: 'inconclusive', values: [] };
    const assessmentValues = assessment.result === 'divergent'
      ? (assessment.values || []).map((id) => t('toolbox.dns.' + id)).join(', ')
      : (assessment.values || []).join(', ');
    html += resultRow(
      t('toolbox.dnsAssessment'),
      t('toolbox.dnsAssessment.' + assessment.result, assessmentValues),
      assessment.status
    );
    for (const result of lastDns.results || []) {
      const answers = (result.answers || []).join(', ') || result.error || t('toolbox.none');
      html += `<div class="tool-dns"><div class="tool-section-head"><h4>${escapeHtml(t('toolbox.dns.' + result.id))}</h4>${statusBadge(result.status)}</div>`;
      html += resultRow(t('toolbox.dnsServer'), result.address);
      html += resultRow(t('toolbox.dnsVia'), t('toolbox.via.' + result.via));
      html += resultRow(t('toolbox.dnsAnswers'), answers);
      html += resultRow(t('toolbox.latency'), fmtMs(result.durationMs));
      html += '</div>';
    }
    box.innerHTML = html;
  }

  bindModal('#dnsModal', '#dnsOpen', '#dnsClose', () => $('#dnsInput').focus());
  $('#dnsRun').addEventListener('click', async () => {
    const host = $('#dnsInput').value.trim();
    if (!host) return toast(t('toolbox.needDomain'), true);
    await runBusy($('#dnsRun'), 'toolbox.comparing', async () => {
      lastDns = await call(api.compareDns, { host });
      renderDns();
    });
  });

  for (const [input, button] of [['#routeInput', '#routeRun'], ['#portInput', '#portRun'], ['#dnsInput', '#dnsRun']]) {
    $(input).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $(button).click();
    });
  }

  const refreshExistingToolLanguage = App.refreshToolsLanguage;
  App.refreshToolsLanguage = () => {
    if (refreshExistingToolLanguage) refreshExistingToolLanguage();
    renderRoute();
    renderDiagnostics();
    renderConfigCheck();
    renderPorts();
    renderBackup();
    renderDns();
  };
})();
