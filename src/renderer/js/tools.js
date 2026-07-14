'use strict';
// Tools tab modals: bidirectional config conversion and UWP loopback manager.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  // ---------- Conversion ----------
  let convertTarget = 'auto';
  let lastConvertOutput = '';
  let lastConvertInfo = null;
  let convertGeneration = 0;

  function conversionTargetLabel(target) {
    return t(target === 'clash' ? 'convert.targetClash' : 'convert.targetSingbox');
  }

  function conversionSourceLabel(format) {
    if (format === 'clash') return t('convert.targetClash');
    return format === 'singbox' || format === 'sing-box' ? t('convert.targetSingbox') : format;
  }

  function renderConvertLabels() {
    $('#convertTitle').textContent = t('convert.title');
    $('#convertInputHint').textContent = t('convert.inputHint');
    $('#convertOutputTitle').textContent = lastConvertInfo
      ? t(lastConvertInfo.target === 'clash' ? 'convert.outputTitleClash' : 'convert.outputTitleSingbox')
      : t('convert.outputTitle');
    for (const button of document.querySelectorAll('[data-convert-target]')) {
      const active = button.dataset.convertTarget === convertTarget;
      button.classList.toggle('primary', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (lastConvertInfo) {
      $('#convertMeta').textContent = t(
        'convert.meta',
        conversionSourceLabel(lastConvertInfo.format),
        conversionTargetLabel(lastConvertInfo.target),
        lastConvertInfo.nodeCount
      );
    }
  }

  function invalidateConversion() {
    convertGeneration++;
    lastConvertOutput = '';
    lastConvertInfo = null;
    $('#convertOutput').textContent = '';
    $('#convertMeta').textContent = '';
    renderConvertLabels();
  }

  $('#openPanelBtn').addEventListener('click', async () => {
    try {
      await call(api.openClashApi);
    } catch (e) {
      toast(e.message || String(e), true);
    }
  });

  $('#convertOpen').addEventListener('click', () => {
    renderConvertLabels();
    $('#convertModal').classList.remove('hidden');
    $('#convertInput').focus();
  });
  function closeConvertModal() {
    invalidateConversion();
    $('#convertInput').value = '';
    $('#convertModal').classList.add('hidden');
  }
  $('#convertClose').addEventListener('click', closeConvertModal);
  $('#convertModal').addEventListener('click', (e) => {
    if (e.target.id === 'convertModal') closeConvertModal();
  });
  // Minimal JSON syntax highlighter for the conversion preview. The input is
  // JSON.stringify output (well-formed), so one token regex is sufficient:
  // strings (key vs value, by a trailing colon), numbers, booleans, null.
  function highlightJson(json) {
    const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      (m, str, colon, kw) => {
        if (str) return colon ? `<span class="json-key">${str}</span>${colon}` : `<span class="json-str">${str}</span>`;
        if (kw) return `<span class="json-${kw === 'null' ? 'null' : 'bool'}">${kw}</span>`;
        return `<span class="json-num">${m}</span>`;
      }
    );
  }

  async function convertContent(showToast = true) {
    const content = $('#convertInput').value.trim();
    if (!content) return toast(t('toast.needContent'), true);
    const generation = ++convertGeneration;
    const res = await call(api.convertPreview, { content, target: convertTarget });
    if (generation !== convertGeneration) return false;
    lastConvertInfo = {
      target: res.target,
      nodeCount: res.nodeCount,
      format: res.format,
    };
    lastConvertOutput = res.text !== undefined ? String(res.text) : JSON.stringify(res.config, null, 2);
    const out = $('#convertOutput');
    // Highlighting a giant config (thousands of nodes) would stall the renderer;
    // beyond ~1.5MB fall back to plain text.
    if (res.target === 'clash' || lastConvertOutput.length > 1500000) out.textContent = lastConvertOutput;
    else out.innerHTML = highlightJson(lastConvertOutput);
    renderConvertLabels();
    if (showToast) toast(t('convert.done'));
    return true;
  }

  $('#convertBtn').addEventListener('click', () => convertContent());
  $('#convertTarget').addEventListener('click', (event) => {
    const button = event.target.closest('[data-convert-target]');
    if (!button || button.dataset.convertTarget === convertTarget) return;
    convertTarget = button.dataset.convertTarget;
    invalidateConversion();
  });
  $('#convertInput').addEventListener('input', () => {
    if (lastConvertInfo || lastConvertOutput) invalidateConversion();
    else convertGeneration++;
  });
  $('#convertImportBtn').addEventListener('click', async () => {
    const content = $('#convertInput').value.trim();
    if (!content) return toast(t('toast.needContent'), true);
    if (!lastConvertInfo) {
      await convertContent(false);
    }
    if (!lastConvertOutput) return;
    const sub = await call(api.importSubscription, { name: t('convert.importName'), content: lastConvertOutput });
    toast(t('toast.subSaved', sub.nodeCount));
    await App.refresh();
  });
  $('#convertCopyBtn').addEventListener('click', async () => {
    if (!lastConvertOutput) return toast(t('toast.needConvert'), true);
    await navigator.clipboard.writeText(lastConvertOutput);
    toast(t('convert.copied'));
  });
  $('#convertExportBtn').addEventListener('click', async () => {
    const p = await call(api.exportConfig);
    if (p) toast(t('toast.exported', p));
  });

  // ---------- UWP loopback exemption ----------
  let uwpApps = [];
  let uwpLoadGeneration = 0;
  async function openUwpModal() {
    $('#uwpModal').classList.remove('hidden');
    $('#uwpFilter').value = '';
    await loadUwp();
  }
  async function loadUwp() {
    const generation = ++uwpLoadGeneration;
    $('#uwpStatus').textContent = t('uwp.loading');
    let apps;
    try {
      apps = await api.listUwpApps();
    } catch (e) {
      apps = [];
    }
    if (generation !== uwpLoadGeneration || $('#uwpModal').classList.contains('hidden')) return;
    uwpApps = apps;
    renderUwp();
  }
  // Apps matching the current scope + search filter.
  function visibleUwp() {
    const filter = ($('#uwpFilter').value || '').toLowerCase();
    const scope = $('#uwpScope').value;
    return uwpApps.filter(
      (x) =>
        x.name.toLowerCase().includes(filter) &&
        (scope === 'all' || (scope === 'system') === !!x.system)
    );
  }
  function renderUwp() {
    const visible = visibleUwp();
    const list = $('#uwpList');
    if (!visible.length) {
      list.innerHTML = `<div class="uwp-empty">${t(uwpApps.length ? 'uwp.noMatches' : 'uwp.empty')}</div>`;
      updateUwpStatus();
      return;
    }
    let html = '';
    for (const a of visible) {
      html += `<label class="uwp-item"><input type="checkbox" data-sid="${escapeHtml(a.sid)}" ${a.enabled ? 'checked' : ''}/><span class="uwp-name">${escapeHtml(a.name)}</span></label>`;
    }
    list.innerHTML = html;
    updateUwpStatus();
  }
  function updateUwpStatus() {
    const selected = uwpApps.reduce((count, app) => count + (app.enabled ? 1 : 0), 0);
    $('#uwpStatus').textContent = uwpApps.length ? t('uwp.selection', selected, uwpApps.length) : '';
  }

  function closeUwpModal() {
    uwpLoadGeneration++;
    uwpApps = [];
    $('#uwpList').textContent = '';
    $('#uwpStatus').textContent = '';
    $('#uwpModal').classList.add('hidden');
  }

  $('#uwpOpen').addEventListener('click', openUwpModal);
  $('#uwpCancel').addEventListener('click', closeUwpModal);
  $('#uwpModal').addEventListener('click', (e) => {
    if (e.target.id === 'uwpModal') closeUwpModal();
  });
  $('#uwpReload').addEventListener('click', loadUwp);
  $('#uwpFilter').addEventListener('input', renderUwp);
  $('#uwpScope').addEventListener('change', renderUwp);
  // Select-all / invert operate on the currently visible (scoped + filtered) set.
  $('#uwpSelectAll').addEventListener('click', () => {
    const vis = visibleUwp();
    const allOn = vis.every((a) => a.enabled);
    vis.forEach((a) => (a.enabled = !allOn)); // toggle: select all, or clear if already all on
    renderUwp();
  });
  $('#uwpInvert').addEventListener('click', () => {
    visibleUwp().forEach((a) => (a.enabled = !a.enabled));
    renderUwp();
  });
  $('#uwpList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const a = uwpApps.find((x) => x.sid === cb.dataset.sid);
    if (a) {
      a.enabled = cb.checked;
      updateUwpStatus();
    }
  });
  $('#uwpApply').addEventListener('click', async () => {
    const sids = uwpApps.filter((a) => a.enabled).map((a) => a.sid);
    const btn = $('#uwpApply');
    btn.disabled = true;
    btn.textContent = t('uwp.applying');
    try {
      const r = await call(api.setUwpLoopback, sids);
      if (r && r.restarting) {
        $('#uwpStatus').textContent = t('uwp.relaunching');
        toast(t('uwp.relaunching'));
        return;
      }
      toast(t('uwp.applied'));
      await loadUwp();
    } finally {
      btn.disabled = false;
      btn.textContent = t('uwp.apply');
    }
  });

  App.refreshToolsLanguage = () => {
    renderConvertLabels();
    if (!$('#uwpModal').classList.contains('hidden')) renderUwp();
  };
})();
