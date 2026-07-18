'use strict';

(function () {
  const App = window.App;
  const Dialog = App.Dialog;
  const { $, toast, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  Dialog.register('local-rule', async ({ id } = {}) => {
    const item = id ? (await Dialog.call(api.listLocalRules)).find((entry) => entry.id === id) : null;
    if (id && !item) throw new Error('Local rule not found');
    const titleKey = item ? 'localrules.editTitle' : 'localrules.title';
    Dialog.setView(titleKey, `
      <div class="dialog-body">
        <div class="setting-row">
          <label data-i18n="localrules.name">${escapeHtml(t('localrules.name'))}</label>
          <input id="lrName" class="input" />
        </div>
        <div class="setting-row">
          <label data-i18n="localrules.type">${escapeHtml(t('localrules.type'))}</label>
          <select id="lrType" class="input small">
            <option value="domain">DOMAIN</option>
            <option value="domain_suffix">DOMAIN-SUFFIX</option>
            <option value="domain_keyword">DOMAIN-KEYWORD</option>
            <option value="ip_cidr">IP-CIDR</option>
            <option value="process_name">PROCESS-NAME</option>
          </select>
        </div>
        <div class="setting-row">
          <label data-i18n="localrules.target">${escapeHtml(t('localrules.target'))}</label>
          <select id="lrTarget" class="input small">
            <option value="proxy" data-i18n="customrs.targetProxy">${escapeHtml(t('customrs.targetProxy'))}</option>
            <option value="direct" data-i18n="customrs.targetDirect">${escapeHtml(t('customrs.targetDirect'))}</option>
            <option value="reject" data-i18n="customrs.targetReject">${escapeHtml(t('customrs.targetReject'))}</option>
          </select>
        </div>
        <label class="modal-label" data-i18n="localrules.values">${escapeHtml(t('localrules.values'))}</label>
        <textarea id="lrValues" class="textarea" data-i18n-ph="localrules.valuesPh"></textarea>
      </div>
      ${Dialog.footer(`<button id="lrSave" class="btn primary" data-i18n="localrules.save">${escapeHtml(t('localrules.save'))}</button>`)}
    `);
    $('#lrName').value = item ? item.name || '' : '';
    $('#lrType').value = item ? item.matchType : 'domain';
    $('#lrTarget').value = item ? item.target : 'proxy';
    $('#lrValues').value = item ? (item.values || []).join('\n') : '';
    $('#lrName').focus();

    Dialog.bind('#lrSave', 'click', async () => {
      const values = $('#lrValues').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!values.length) return toast(t('localrules.needValues'), true);
      const payload = {
        name: $('#lrName').value.trim(),
        matchType: $('#lrType').value,
        target: $('#lrTarget').value,
        values,
      };
      await Dialog.runBusy($('#lrSave'), null, async () => {
        if (item) await Dialog.call(api.editLocalRule, { id: item.id, ...payload });
        else await Dialog.call(api.addLocalRule, payload);
        await Dialog.finish('rules', t('settings.saved'));
      });
    });
  });

  Dialog.register('remote-rule', async ({ id }) => {
    const item = (await Dialog.call(api.listCustomRuleSets)).find((entry) => entry.id === id);
    if (!item) throw new Error('Remote rule not found');
    Dialog.setView('customrs.editTitle', `
      <div class="dialog-body">
        <div class="setting-row">
          <label data-i18n="customrs.namePh">${escapeHtml(t('customrs.namePh'))}</label>
          <input id="crsEditName" class="input" />
        </div>
        <div class="setting-row">
          <label data-i18n="customrs.urlPh">${escapeHtml(t('customrs.urlPh'))}</label>
          <input id="crsEditUrl" class="input grow" />
        </div>
        <div class="setting-row">
          <label data-i18n="localrules.target">${escapeHtml(t('localrules.target'))}</label>
          <select id="crsEditTarget" class="input small">
            <option value="proxy" data-i18n="customrs.targetProxy">${escapeHtml(t('customrs.targetProxy'))}</option>
            <option value="direct" data-i18n="customrs.targetDirect">${escapeHtml(t('customrs.targetDirect'))}</option>
            <option value="reject" data-i18n="customrs.targetReject">${escapeHtml(t('customrs.targetReject'))}</option>
          </select>
        </div>
        <div class="setting-row">
          <label data-i18n="subs.autoUpdate">${escapeHtml(t('subs.autoUpdate'))}</label>
          <select id="crsEditAutoUpdate" class="input small">
            <option value="0" data-i18n="subs.autoUpdateOff">${escapeHtml(t('subs.autoUpdateOff'))}</option>
            <option value="60">1 h</option><option value="360">6 h</option>
            <option value="720">12 h</option><option value="1440">24 h</option>
            <option value="4320">3 d</option><option value="10080">7 d</option>
          </select>
        </div>
        <div class="setting-row">
          <label data-i18n="customrs.enabledLabel">${escapeHtml(t('customrs.enabledLabel'))}</label>
          <input id="crsEditEnabled" type="checkbox" />
        </div>
      </div>
      ${Dialog.footer(`
        <button id="crsEditRefresh" class="btn" data-i18n="customrs.refresh">${escapeHtml(t('customrs.refresh'))}</button>
        <button id="crsEditSave" class="btn primary" data-i18n="subs.editSave">${escapeHtml(t('subs.editSave'))}</button>
      `)}
    `);
    $('#crsEditName').value = item.name || '';
    $('#crsEditUrl').value = item.url || '';
    $('#crsEditTarget').value = item.target || 'proxy';
    $('#crsEditAutoUpdate').value = String(item.autoUpdateMinutes || 0);
    $('#crsEditEnabled').checked = item.enabled !== false;

    Dialog.bind('#crsEditSave', 'click', async () => {
      const url = $('#crsEditUrl').value.trim();
      if (!url) return toast(t('toast.needUrl'), true);
      await Dialog.runBusy($('#crsEditSave'), null, async () => {
        await Dialog.call(api.editCustomRuleSet, {
          id,
          name: $('#crsEditName').value.trim(),
          url,
          target: $('#crsEditTarget').value,
          autoUpdateMinutes: parseInt($('#crsEditAutoUpdate').value, 10) || 0,
          enabled: $('#crsEditEnabled').checked,
        });
        await Dialog.finish('rules', t('settings.saved'));
      });
    });
    Dialog.bind('#crsEditRefresh', 'click', async () => {
      await Dialog.runBusy($('#crsEditRefresh'), 'subs.fetching', async () => {
        await Dialog.call(api.refreshCustomRuleSet, { id });
        await Dialog.changed('rules');
        toast(t('customrs.added'));
      });
    });
  });

  const RAW_HIGHLIGHT_LIMIT = 300000;
  const RAW_FORMAT_LIMIT = 4 * 1024 * 1024;

  function formatProfileForEditing(value) {
    const text = typeof value === 'string' ? value : '';
    if (text.length > RAW_FORMAT_LIMIT) return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return text;
    }
  }

  function escapeBasic(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightInline(value) {
    return value.replace(
      /("(?:[^"\\]|\\.)*"|'[^']*')|([A-Za-z0-9_-]+)(:)(?=[ \t]|$|,|})|\b(true|false|null)\b|(?<![\w.-])(-?\d+(?:\.\d+)?)(?![\w.])/g,
      (match, string, key, colon, keyword, number) => {
        if (string) return `<span class="json-str">${string}</span>`;
        if (key) return `<span class="json-key">${key}</span>${colon}`;
        if (keyword) return `<span class="json-bool">${keyword}</span>`;
        if (number) return `<span class="json-num">${number}</span>`;
        return match;
      }
    );
  }

  function highlightProfile(text) {
    return text.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return `<span class="yml-comment">${escapeBasic(line)}</span>`;
      const link = line.match(/^(\s*)([a-z][a-z0-9+]*):\/\/(.*)$/i);
      if (link) {
        return escapeBasic(link[1]) + `<span class="lnk-scheme">${escapeBasic(link[2])}://</span>` + escapeBasic(link[3]);
      }
      return highlightInline(escapeBasic(line));
    }).join('\n');
  }

  Dialog.register('raw-profile', async ({ id }) => {
    const [raw, state] = await Promise.all([Dialog.call(api.getSubRaw, { id }), Dialog.call(api.getState)]);
    if (!raw || !raw.raw) throw new Error(t('subs.rawEmpty'));
    const profile = (state.subscriptions || []).find((entry) => entry.id === id);
    const title = profile && profile.name ? `${t('subs.rawTitle')} · ${profile.name}` : t('subs.rawTitle');
    Dialog.setView('subs.rawTitle', `
      <div class="dialog-body dialog-flex">
        <p class="hint" data-i18n="subs.rawHint">${escapeHtml(t('subs.rawHint'))}</p>
        <div id="rawEditorWrap" class="editor-wrap dialog-editor-wrap">
          <pre id="rawHighlight" class="editor-highlight" aria-hidden="true"></pre>
          <textarea id="rawContent" class="textarea raw-editor" spellcheck="false"></textarea>
        </div>
      </div>
      ${Dialog.footer(`<button id="rawSave" class="btn primary" data-i18n="subs.editSave">${escapeHtml(t('subs.editSave'))}</button>`)}
    `, { title });
    const input = $('#rawContent');
    const highlight = $('#rawHighlight');
    const wrap = $('#rawEditorWrap');
    input.value = formatProfileForEditing(raw.raw);

    let renderTimer = null;
    function renderHighlight() {
      if (input.value.length > RAW_HIGHLIGHT_LIMIT) {
        wrap.classList.add('plain');
        highlight.textContent = '';
      } else {
        wrap.classList.remove('plain');
        highlight.innerHTML = highlightProfile(input.value) + '\n';
        highlight.scrollTop = input.scrollTop;
        highlight.scrollLeft = input.scrollLeft;
      }
    }
    renderHighlight();
    Dialog.bind(input, 'input', () => {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(renderHighlight, 120);
    });
    Dialog.bind(input, 'scroll', () => {
      highlight.scrollTop = input.scrollTop;
      highlight.scrollLeft = input.scrollLeft;
    });
    Dialog.bind('#rawSave', 'click', async () => {
      await Dialog.runBusy($('#rawSave'), null, async () => {
        const result = await Dialog.call(api.saveSubRaw, { id, content: input.value });
        await Dialog.finish('subscriptions', t('subs.rawSaved', result.nodeCount));
      });
    });
  });

  function highlightJson(json) {
    const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      (match, string, colon, keyword) => {
        if (string) return colon ? `<span class="json-key">${string}</span>${colon}` : `<span class="json-str">${string}</span>`;
        if (keyword) return `<span class="json-${keyword === 'null' ? 'null' : 'bool'}">${keyword}</span>`;
        return `<span class="json-num">${match}</span>`;
      }
    );
  }

  Dialog.register('convert', async () => {
    let target = 'auto';
    let output = '';
    let info = null;
    let generation = 0;
    Dialog.setView('convert.title', `
      <div class="dialog-body dialog-flex">
        <p class="hint" data-i18n="convert.inputHint">${escapeHtml(t('convert.inputHint'))}</p>
        <div class="row convert-target-row">
          <span class="modal-label" data-i18n="convert.targetLabel">${escapeHtml(t('convert.targetLabel'))}</span>
          <div id="convertTarget" class="mode-switch convert-target" role="group">
            <button class="btn primary" data-convert-target="auto" data-i18n="convert.targetAuto">${escapeHtml(t('convert.targetAuto'))}</button>
            <button class="btn" data-convert-target="sing-box" data-i18n="convert.targetSingbox">${escapeHtml(t('convert.targetSingbox'))}</button>
            <button class="btn" data-convert-target="clash" data-i18n="convert.targetClash">${escapeHtml(t('convert.targetClash'))}</button>
          </div>
        </div>
        <textarea id="convertInput" class="textarea dialog-convert-input" data-i18n-ph="convert.inputPh"></textarea>
        <div class="row convert-actions dialog-commandbar">
          <button id="convertBtn" class="btn primary" data-i18n="convert.preview">${escapeHtml(t('convert.preview'))}</button>
          <button id="convertImportBtn" class="btn" data-i18n="convert.import">${escapeHtml(t('convert.import'))}</button>
          <button id="convertCopyBtn" class="btn" data-i18n="convert.copy">${escapeHtml(t('convert.copy'))}</button>
          <button id="convertExportBtn" class="btn" data-i18n="convert.export">${escapeHtml(t('convert.export'))}</button>
        </div>
        <div class="row convert-output-head">
          <span class="modal-label"><span id="convertOutputTitle">${escapeHtml(t('convert.outputTitle'))}</span> <span id="convertMeta" class="hint"></span></span>
        </div>
        <pre id="convertOutput" class="code dialog-convert-output"></pre>
      </div>
      ${Dialog.footer()}
    `);

    function sourceLabel(format) {
      if (format === 'clash') return t('convert.targetClash');
      return format === 'singbox' || format === 'sing-box' ? t('convert.targetSingbox') : format;
    }
    function targetLabel(value) {
      return t(value === 'clash' ? 'convert.targetClash' : 'convert.targetSingbox');
    }
    function renderLabels() {
      $('#convertOutputTitle').textContent = info
        ? t(info.target === 'clash' ? 'convert.outputTitleClash' : 'convert.outputTitleSingbox')
        : t('convert.outputTitle');
      document.querySelectorAll('[data-convert-target]').forEach((button) => {
        const active = button.dataset.convertTarget === target;
        button.classList.toggle('primary', active);
        button.setAttribute('aria-pressed', String(active));
      });
      $('#convertMeta').textContent = info
        ? t('convert.meta', sourceLabel(info.format), targetLabel(info.target), info.nodeCount)
        : '';
    }
    function invalidate() {
      generation++;
      output = '';
      info = null;
      $('#convertOutput').textContent = '';
      renderLabels();
    }
    async function convert(showToast = true) {
      const content = $('#convertInput').value.trim();
      if (!content) {
        toast(t('toast.needContent'), true);
        return false;
      }
      const request = ++generation;
      const result = await Dialog.call(api.convertPreview, { content, target });
      if (request !== generation) return false;
      info = { target: result.target, nodeCount: result.nodeCount, format: result.format };
      output = result.text !== undefined ? String(result.text) : JSON.stringify(result.config, null, 2);
      const box = $('#convertOutput');
      if (result.target === 'clash' || output.length > 1500000) box.textContent = output;
      else box.innerHTML = highlightJson(output);
      renderLabels();
      if (showToast) toast(t('convert.done'));
      return true;
    }

    Dialog.bind('#convertBtn', 'click', () => Dialog.runBusy($('#convertBtn'), null, () => convert()));
    Dialog.bind('#convertTarget', 'click', (event) => {
      const button = event.target.closest('[data-convert-target]');
      if (!button || button.dataset.convertTarget === target) return;
      target = button.dataset.convertTarget;
      invalidate();
    });
    Dialog.bind('#convertInput', 'input', invalidate);
    Dialog.bind('#convertImportBtn', 'click', async () => {
      await Dialog.runBusy($('#convertImportBtn'), null, async () => {
        if (!info && !(await convert(false))) return;
        if (!output) return;
        const profile = await Dialog.call(api.importSubscription, { name: t('convert.importName'), content: output });
        await Dialog.changed('subscriptions');
        toast(t('toast.subSaved', profile.nodeCount));
      });
    });
    Dialog.bind('#convertCopyBtn', 'click', async () => {
      if (!output) return toast(t('toast.needConvert'), true);
      await navigator.clipboard.writeText(output);
      toast(t('convert.copied'));
    });
    Dialog.bind('#convertExportBtn', 'click', async () => {
      const file = await Dialog.call(api.exportConfig);
      if (file) toast(t('toast.exported', file));
    });
    $('#convertInput').focus();
  });
})();
