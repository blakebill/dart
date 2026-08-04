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
          <label for="lrName" data-i18n="localrules.name">${escapeHtml(t('localrules.name'))}</label>
          <input id="lrName" class="input" />
        </div>
        <div class="setting-row">
          <label for="lrType" data-i18n="localrules.type">${escapeHtml(t('localrules.type'))}</label>
          <select id="lrType" class="input small">
            <option value="domain">DOMAIN</option>
            <option value="domain_suffix">DOMAIN-SUFFIX</option>
            <option value="domain_keyword">DOMAIN-KEYWORD</option>
            <option value="ip_cidr">IP-CIDR</option>
            <option value="process_name">PROCESS-NAME</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="lrTarget" data-i18n="localrules.target">${escapeHtml(t('localrules.target'))}</label>
          <select id="lrTarget" class="input small">
            <option value="proxy" data-i18n="customrs.targetProxy">${escapeHtml(t('customrs.targetProxy'))}</option>
            <option value="direct" data-i18n="customrs.targetDirect">${escapeHtml(t('customrs.targetDirect'))}</option>
            <option value="reject" data-i18n="customrs.targetReject">${escapeHtml(t('customrs.targetReject'))}</option>
          </select>
        </div>
        <label class="modal-label" for="lrValues" data-i18n="localrules.values">${escapeHtml(t('localrules.values'))}</label>
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
          <label for="crsEditName" data-i18n="customrs.namePh">${escapeHtml(t('customrs.namePh'))}</label>
          <input id="crsEditName" class="input" />
        </div>
        <div class="setting-row">
          <label for="crsEditUrl" data-i18n="customrs.urlPh">${escapeHtml(t('customrs.urlPh'))}</label>
          <input id="crsEditUrl" class="input grow" />
        </div>
        <div class="setting-row">
          <label for="crsEditTarget" data-i18n="localrules.target">${escapeHtml(t('localrules.target'))}</label>
          <select id="crsEditTarget" class="input small">
            <option value="proxy" data-i18n="customrs.targetProxy">${escapeHtml(t('customrs.targetProxy'))}</option>
            <option value="direct" data-i18n="customrs.targetDirect">${escapeHtml(t('customrs.targetDirect'))}</option>
            <option value="reject" data-i18n="customrs.targetReject">${escapeHtml(t('customrs.targetReject'))}</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="crsEditAutoUpdate" data-i18n="subs.autoUpdate">${escapeHtml(t('subs.autoUpdate'))}</label>
          <select id="crsEditAutoUpdate" class="input small">
            <option value="0" data-i18n="subs.autoUpdateOff">${escapeHtml(t('subs.autoUpdateOff'))}</option>
            <option value="60">1 h</option><option value="360">6 h</option>
            <option value="720">12 h</option><option value="1440">24 h</option>
            <option value="4320">3 d</option><option value="10080">7 d</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="crsEditEnabled" data-i18n="customrs.enabledLabel">${escapeHtml(t('customrs.enabledLabel'))}</label>
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
          <textarea id="rawContent" class="textarea raw-editor" spellcheck="false" data-i18n-aria-label="subs.rawTitle"></textarea>
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

})();
