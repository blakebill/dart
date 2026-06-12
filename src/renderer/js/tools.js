'use strict';
// Tools tab modals: Clash → sing-box conversion preview and the UWP loopback
// exemption manager.
(function () {
  const App = window.App;
  const { $, toast, call, escapeHtml } = App;
  const api = window.api;
  const { t } = window.i18n;

  // ---------- Conversion ----------
  $('#convertOpen').addEventListener('click', () => {
    $('#convertModal').classList.remove('hidden');
    $('#convertInput').focus();
  });
  $('#convertClose').addEventListener('click', () => $('#convertModal').classList.add('hidden'));
  $('#convertModal').addEventListener('click', (e) => {
    if (e.target.id === 'convertModal') $('#convertModal').classList.add('hidden');
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

  let lastConvertOutput = '';
  $('#convertBtn').addEventListener('click', async () => {
    const content = $('#convertInput').value.trim();
    if (!content) return toast(t('toast.needContent'), true);
    const res = await call(api.convertPreview, { content });
    lastConvertOutput = JSON.stringify(res.config, null, 2);
    const out = $('#convertOutput');
    // Highlighting a giant config (thousands of nodes) would stall the renderer;
    // beyond ~1.5MB fall back to plain text.
    if (lastConvertOutput.length > 1500000) out.textContent = lastConvertOutput;
    else out.innerHTML = highlightJson(lastConvertOutput);
    $('#convertMeta').textContent = t('convert.meta', res.nodeCount, res.format);
    toast(t('convert.done'));
  });
  $('#convertImportBtn').addEventListener('click', async () => {
    const content = $('#convertInput').value.trim();
    if (!content) return toast(t('toast.needContent'), true);
    const sub = await call(api.importSubscription, { name: t('convert.importName'), content });
    toast(t('toast.subSaved', sub.nodes.length));
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
  async function openUwpModal() {
    $('#uwpModal').classList.remove('hidden');
    $('#uwpFilter').value = '';
    await loadUwp();
    try {
      const admin = await api.isAdmin();
      $('#uwpRestartAdmin').classList.toggle('hidden', admin);
      $('#uwpApply').disabled = !admin;
      if (!admin) $('#uwpStatus').textContent = t('uwp.needAdmin');
    } catch (_) {}
  }
  async function loadUwp() {
    $('#uwpStatus').textContent = t('uwp.loading');
    try {
      uwpApps = await api.listUwpApps();
    } catch (e) {
      uwpApps = [];
    }
    renderUwp();
    $('#uwpStatus').textContent = uwpApps.length ? '' : t('uwp.empty');
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
    let html = '';
    for (const a of visibleUwp()) {
      html += `<label class="uwp-item"><input type="checkbox" data-sid="${escapeHtml(a.sid)}" ${a.enabled ? 'checked' : ''}/><span class="uwp-name">${escapeHtml(a.name)}</span></label>`;
    }
    $('#uwpList').innerHTML = html;
  }

  $('#uwpOpen').addEventListener('click', openUwpModal);
  $('#uwpCancel').addEventListener('click', () => $('#uwpModal').classList.add('hidden'));
  $('#uwpModal').addEventListener('click', (e) => {
    if (e.target.id === 'uwpModal') $('#uwpModal').classList.add('hidden');
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
    if (a) a.enabled = cb.checked;
  });
  $('#uwpApply').addEventListener('click', async () => {
    const sids = uwpApps.filter((a) => a.enabled).map((a) => a.sid);
    const btn = $('#uwpApply');
    btn.disabled = true;
    btn.textContent = t('uwp.applying');
    try {
      await call(api.setUwpLoopback, sids);
      toast(t('uwp.applied'));
      await loadUwp();
    } finally {
      btn.disabled = false;
      btn.textContent = t('uwp.apply');
    }
  });
  $('#uwpRestartAdmin').addEventListener('click', async () => {
    try {
      const r = await api.relaunchElevated();
      if (r && r.ok === false) toast(r.error || 'relaunch failed', true);
    } catch (e) {
      toast(e.message || String(e), true);
    }
  });
})();
