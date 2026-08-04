'use strict';

(function () {
  const App = window.App;
  const Dialog = App.Dialog;
  const { $, toast, escapeHtml, fmtBytes } = App;
  const api = window.api;
  const { t } = window.i18n;
  const { statusBadge, resultRow, emptyResult } = Dialog;

  function fmtMs(value) {
    return Number.isFinite(value) ? value + ' ms' : '-';
  }

  function toolView(titleKey, hintKey, body, footerButtons = '') {
    Dialog.setView(titleKey, `
      <div class="dialog-body dialog-tool-body">
        <p class="hint" data-i18n="${hintKey}">${escapeHtml(t(hintKey))}</p>
        ${body}
      </div>
      ${Dialog.footer(footerButtons)}
    `);
  }

  Dialog.register('route', async () => {
    let result = null;
    toolView('toolbox.routeTitle', 'toolbox.routeHint', `
      <div class="form-row dialog-commandbar">
        <label class="sr-only" for="routeInput" data-i18n="toolbox.routePlaceholder">${escapeHtml(t('toolbox.routePlaceholder'))}</label>
        <input id="routeInput" class="input grow" value="www.google.com" data-i18n-ph="toolbox.routePlaceholder" />
        <button id="routeRun" class="btn primary" data-i18n="toolbox.inspect">${escapeHtml(t('toolbox.inspect'))}</button>
      </div>
      <div id="routeResult" class="tool-result">${emptyResult()}</div>
    `);

    function render() {
      if (!result) return;
      const rule = result.matchedRule || {};
      const dnsPath = result.dnsPath || {};
      const source = t('toolbox.routeSource.' + (result.source || 'generated'));
      let html = resultRow(t('toolbox.routeTarget'), result.target.host);
      html += resultRow(t('toolbox.routeAddresses'), (result.addresses || []).join(', ') || t('toolbox.none'));
      html += resultRow(t('toolbox.routeSource'), source);
      html += resultRow(t('toolbox.routeRule'), `${rule.type || '-'}${rule.payload ? ' · ' + rule.payload : ''}`);
      html += resultRow(t('toolbox.routePolicy'), result.policy);
      html += resultRow(t('toolbox.routeChain'), (result.chain || []).join(' → '));
      html += resultRow(t('toolbox.routeFinal'), result.finalOutbound);
      html += resultRow(
        t('toolbox.routeDns'),
        dnsPath.skipped ? t('toolbox.notRequired') : `${dnsPath.resolver || '-'} · ${dnsPath.server || '-'} · ${dnsPath.detour || '-'}`
      );
      html += resultRow(
        t('toolbox.routeConfidence'),
        t('toolbox.confidence.' + result.confidence),
        result.confidence === 'exact' ? 'pass' : 'warn'
      );
      if (result.dnsError) html += `<p class="tool-notice warn">${escapeHtml(result.dnsError)}</p>`;
      if (result.unresolvedBeforeMatch && result.unresolvedBeforeMatch.length) {
        const values = result.unresolvedBeforeMatch.map((item) => `${item.type}: ${item.payload}`).join('\n');
        html += `<div class="tool-notice warn"><b>${escapeHtml(t('toolbox.routeUnresolved'))}</b><pre>${escapeHtml(values)}</pre></div>`;
      }
      $('#routeResult').innerHTML = html;
    }

    Dialog.bind('#routeRun', 'click', async () => {
      const value = $('#routeInput').value.trim();
      if (!value) return toast(t('toolbox.needTarget'), true);
      await Dialog.runBusy($('#routeRun'), 'toolbox.inspecting', async () => {
        result = await Dialog.call(api.inspectRoute, { value });
        render();
      });
    });
    Dialog.bind('#routeInput', 'keydown', (event) => {
      if (event.key === 'Enter') $('#routeRun').click();
    });
    $('#routeInput').focus();
  });

  Dialog.register('diagnostics', async () => {
    let result = null;
    toolView('toolbox.diagTitle', 'toolbox.diagHint', `
      <div class="row tool-actions dialog-commandbar">
        <button id="diagRun" class="btn primary" data-i18n="toolbox.runDiagnostics">${escapeHtml(t('toolbox.runDiagnostics'))}</button>
        <button id="diagExport" class="btn hidden" data-i18n="toolbox.exportReport">${escapeHtml(t('toolbox.exportReport'))}</button>
      </div>
      <div id="diagResult" class="tool-result">${emptyResult()}</div>
    `);

    function render() {
      if (!result) return;
      let html = `<div class="tool-summary">${['pass', 'warn', 'fail', 'skip'].map((status) =>
        `<span>${statusBadge(status)} ${Number(result.summary && result.summary[status]) || 0}</span>`
      ).join('')}</div>`;
      for (const check of result.checks || []) {
        const title = t('toolbox.diag.' + check.id);
        html += `<div class="tool-check"><div><b>${escapeHtml(title)}</b><span>${escapeHtml(check.detail || '-')}</span></div>` +
          `<div>${statusBadge(check.status)}${check.durationMs !== null && check.durationMs !== undefined ? `<small>${escapeHtml(fmtMs(check.durationMs))}</small>` : ''}</div></div>`;
      }
      $('#diagResult').innerHTML = html;
    }

    Dialog.bind('#diagRun', 'click', async () => {
      await Dialog.runBusy($('#diagRun'), 'toolbox.running', async () => {
        result = await Dialog.call(api.runNetworkDiagnostics);
        render();
        $('#diagExport').classList.remove('hidden');
      });
    });
    Dialog.bind('#diagExport', 'click', async () => {
      if (!result) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = await Dialog.call(api.saveToolReport, {
        name: 'dart-network-diagnostics-' + stamp,
        format: 'json',
        content: JSON.stringify(result, null, 2),
      });
      if (file) toast(t('toolbox.exported', file));
    });
  });

  Dialog.register('config-check', async () => {
    let result = null;
    toolView('toolbox.configTitle', 'toolbox.configHint', `
      <div class="row tool-actions dialog-commandbar">
        <button id="configCheckRun" class="btn primary" data-i18n="toolbox.validateMihomo">${escapeHtml(t('toolbox.validateMihomo'))}</button>
      </div>
      <div id="configCheckResult" class="tool-result">${emptyResult()}</div>
    `);

    function render() {
      if (!result) return;
      let html = `<div class="tool-notice"><b>${escapeHtml(result.source.name || '-')}</b> · ` +
        `${escapeHtml(result.source.format || '-')} · ${escapeHtml(t('nodes.count', result.source.nodes || 0))}</div>`;
      if (result.source.preview) {
        html += `<details class="tool-preview tool-source-preview"><summary>${escapeHtml(t('toolbox.sourcePreview'))}` +
          `${result.source.truncated ? ' · ' + escapeHtml(t('toolbox.truncated')) : ''}</summary>` +
          `<pre>${escapeHtml(result.source.preview)}</pre></details>`;
      }
      const item = result.result || {};
      const validation = item.validation || {};
      const summary = item.summary;
      html += `<section class="tool-section"><div class="tool-section-head"><h4>Mihomo</h4>${statusBadge(validation.status)}</div>`;
      if (summary) {
        html += '<div class="tool-metrics">';
        html += resultRow(t('toolbox.configFormat'), `${result.source.format || '-'} → ${summary.format}`);
        html += resultRow(t('toolbox.configNodes'), `${summary.sourceNodes} → ${summary.generatedNodes}${summary.droppedNodes ? ' (-' + summary.droppedNodes + ')' : ''}`, summary.droppedNodes ? 'warn' : 'pass');
        html += resultRow(t('toolbox.configRules'), `${summary.sourceRules} → ${summary.generatedRules}`);
        html += resultRow(t('toolbox.configTun'), summary.tun ? t('state.on') : t('state.off'));
        html += resultRow(t('toolbox.configDns'), summary.dns ? t('state.on') : t('state.off'));
        html += resultRow(t('toolbox.configSize'), `${fmtBytes(summary.bytes)} · ${summary.lines} ${t('toolbox.lines')}`);
        html += '</div>';
      }
      const location = validation.location || {};
      const where = [
        location.path,
        location.line ? t('toolbox.line', location.line) : '',
        location.column ? t('toolbox.column', location.column) : '',
      ].filter(Boolean).join(' · ');
      html += `<div class="tool-validation ${escapeHtml(validation.status || 'missing')}"><b>${escapeHtml(where || t('toolbox.validationOutput'))}</b><pre>${escapeHtml(validation.message || '-')}</pre></div>`;
      if (item.preview) {
        html += `<details class="tool-preview"><summary>${escapeHtml(t('toolbox.generatedPreview', 'Mihomo'))}${item.truncated ? ' · ' + escapeHtml(t('toolbox.truncated')) : ''}</summary><pre>${escapeHtml(item.preview)}</pre></details>`;
      }
      html += '</section>';
      $('#configCheckResult').innerHTML = html;
    }

    Dialog.bind('#configCheckRun', 'click', async () => {
      await Dialog.runBusy($('#configCheckRun'), 'toolbox.validating', async () => {
        result = await Dialog.call(api.checkMihomoConfig);
        render();
      });
    });
  });

  Dialog.register('ports', async () => {
    let result = null;
    toolView('toolbox.portTitle', 'toolbox.portHint', `
      <div class="form-row dialog-commandbar">
        <label class="sr-only" for="portInput" data-i18n="toolbox.portPlaceholder">${escapeHtml(t('toolbox.portPlaceholder'))}</label>
        <input id="portInput" class="input grow" value="7890, 9090" data-i18n-ph="toolbox.portPlaceholder" />
        <button id="portRun" class="btn primary" data-i18n="toolbox.inspect">${escapeHtml(t('toolbox.inspect'))}</button>
      </div>
      <div id="portResult" class="tool-result">${emptyResult()}</div>
    `);

    function render() {
      let html = '';
      for (const item of result || []) {
        let status = 'pass';
        if (item.conflict) status = 'fail';
        else if (item.expected && !item.listening) status = 'fail';
        else if (!item.expected && item.listening) status = 'warn';
        const owner = item.owner
          ? `${item.owner.name || t('toolbox.unknownProcess')}${item.owner.pid ? ' (PID ' + item.owner.pid + ')' : ''}`
          : '-';
        const listening = item.listening ? t('toolbox.listening') : t('toolbox.available');
        html += `<div class="tool-check"><div><b>:${item.port} · ${escapeHtml(t('toolbox.portRole.' + item.role))}</b>` +
          `<span>${escapeHtml(listening)} · ${escapeHtml(owner)}</span></div><div>${statusBadge(status)}<small>${escapeHtml(fmtMs(item.durationMs))}</small></div></div>`;
      }
      $('#portResult').innerHTML = html || emptyResult();
    }

    Dialog.bind('#portRun', 'click', async () => {
      const ports = $('#portInput').value.trim();
      if (!ports) return toast(t('toolbox.needPorts'), true);
      await Dialog.runBusy($('#portRun'), 'toolbox.inspecting', async () => {
        result = await Dialog.call(api.inspectPorts, { ports });
        render();
      });
    });
    Dialog.bind('#portInput', 'keydown', (event) => {
      if (event.key === 'Enter') $('#portRun').click();
    });
    $('#portInput').focus();
  });

  Dialog.register('backup', async () => {
    let selected = null;
    toolView('toolbox.backupTitle', 'toolbox.backupHint', `
      <div class="row tool-actions dialog-commandbar">
        <button id="backupExport" class="btn primary" data-i18n="toolbox.exportBackup">${escapeHtml(t('toolbox.exportBackup'))}</button>
        <button id="backupSelect" class="btn" data-i18n="toolbox.selectBackup">${escapeHtml(t('toolbox.selectBackup'))}</button>
      </div>
      <div id="backupResult" class="tool-result">${emptyResult('toolbox.backupEmpty')}</div>
    `, `<button id="backupRestore" class="btn danger hidden" data-i18n="toolbox.restoreBackup">${escapeHtml(t('toolbox.restoreBackup'))}</button>`);

    function render() {
      if (!selected) {
        $('#backupResult').innerHTML = emptyResult('toolbox.backupEmpty');
        return;
      }
      const summary = selected.summary || {};
      let html = resultRow(t('toolbox.backupFile'), selected.fileName);
      html += resultRow(t('toolbox.backupCreated'), summary.createdAt || '-');
      html += resultRow(t('toolbox.backupVersion'), summary.appVersion || '-');
      html += resultRow(t('toolbox.backupCore'), summary.coreType || '-');
      html += resultRow(t('toolbox.backupConfigs'), summary.configs || 0);
      html += resultRow(t('toolbox.backupNodes'), summary.nodes || 0);
      html += resultRow(t('toolbox.backupRules'), `${summary.localRules || 0} / ${summary.remoteRules || 0}`);
      html += `<p class="tool-notice warn">${escapeHtml(t('toolbox.restoreWarning'))}</p>`;
      $('#backupResult').innerHTML = html;
    }

    Dialog.bind('#backupExport', 'click', async () => {
      await Dialog.runBusy($('#backupExport'), 'toolbox.exporting', async () => {
        const file = await Dialog.call(api.exportBackup);
        if (file) toast(t('toolbox.backupExported', file));
      });
    });
    Dialog.bind('#backupSelect', 'click', async () => {
      await Dialog.runBusy($('#backupSelect'), 'toolbox.reading', async () => {
        selected = await Dialog.call(api.selectBackup);
        render();
        $('#backupRestore').classList.toggle('hidden', !selected);
      });
    });
    Dialog.bind('#backupRestore', 'click', async () => {
      if (!selected) return;
      await Dialog.runBusy($('#backupRestore'), 'toolbox.restoring', async () => {
        const result = await Dialog.call(api.restoreBackup, { token: selected.token });
        const message = result.stoppedCore ? t('toolbox.restoredStopped') : t('toolbox.restored');
        await Dialog.finish('all', message);
      });
    });
  });

  Dialog.register('dns', async () => {
    let result = null;
    toolView('toolbox.dnsTitle', 'toolbox.dnsHint', `
      <div class="form-row dialog-commandbar">
        <label class="sr-only" for="dnsInput" data-i18n="toolbox.dnsPlaceholder">${escapeHtml(t('toolbox.dnsPlaceholder'))}</label>
        <input id="dnsInput" class="input grow" value="www.google.com" data-i18n-ph="toolbox.dnsPlaceholder" />
        <button id="dnsRun" class="btn primary" data-i18n="toolbox.compare">${escapeHtml(t('toolbox.compare'))}</button>
      </div>
      <div id="dnsResult" class="tool-result">${emptyResult()}</div>
    `);

    function render() {
      if (!result) return;
      let html = `<div class="tool-notice"><b>${escapeHtml(result.host)}</b></div>`;
      const assessment = result.assessment || { status: 'skip', result: 'inconclusive', values: [] };
      const values = assessment.result === 'divergent'
        ? (assessment.values || []).map((id) => t('toolbox.dns.' + id)).join(', ')
        : (assessment.values || []).join(', ');
      html += resultRow(
        t('toolbox.dnsAssessment'),
        t('toolbox.dnsAssessment.' + assessment.result, values),
        assessment.status
      );
      for (const item of result.results || []) {
        const answers = (item.answers || []).join(', ') || item.error || t('toolbox.none');
        html += `<div class="tool-dns"><div class="tool-section-head"><h4>${escapeHtml(t('toolbox.dns.' + item.id))}</h4>${statusBadge(item.status)}</div>`;
        html += resultRow(t('toolbox.dnsServer'), item.address);
        html += resultRow(t('toolbox.dnsVia'), t('toolbox.via.' + item.via));
        html += resultRow(t('toolbox.dnsAnswers'), answers);
        html += resultRow(t('toolbox.latency'), fmtMs(item.durationMs));
        html += '</div>';
      }
      $('#dnsResult').innerHTML = html;
    }

    Dialog.bind('#dnsRun', 'click', async () => {
      const host = $('#dnsInput').value.trim();
      if (!host) return toast(t('toolbox.needDomain'), true);
      await Dialog.runBusy($('#dnsRun'), 'toolbox.comparing', async () => {
        result = await Dialog.call(api.compareDns, { host });
        render();
      });
    });
    Dialog.bind('#dnsInput', 'keydown', (event) => {
      if (event.key === 'Enter') $('#dnsRun').click();
    });
    $('#dnsInput').focus();
  });
})();
