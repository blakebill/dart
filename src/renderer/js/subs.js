'use strict';
// Subscriptions tab: profile list, add/edit panel and the raw-content editor
// (transparent textarea over a colorized <pre> mirror).
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, fmtDate, escapeHtml } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  let editingSubId = null;

  function renderSubs() {
    const list = $('#subList');
    list.innerHTML = '';
    if (App.state.subscriptions.length === 0) {
      list.innerHTML = `<p class="hint">${t('subs.empty')}</p>`;
      return;
    }
    for (const sub of App.state.subscriptions) {
      const div = document.createElement('div');
      div.className = 'sub-item';
      let traffic = '';
      if (sub.userInfo) {
        const u = sub.userInfo;
        const used = (u.upload || 0) + (u.download || 0);
        traffic = t('subs.used', fmtBytes(used), fmtBytes(u.total));
        if (u.expire) {
          const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
          traffic += ' · ' + t('subs.expire', new Date(u.expire * 1000).toLocaleDateString(locale));
        }
      }
      const au = parseInt(sub.autoUpdateMinutes || 0, 10);
      const auInfo = au > 0 ? t('subs.autoUpdateInfo', au) : t('subs.autoUpdateNone');
      const isActive = sub.id === App.state.activeSub;
      if (isActive) div.classList.add('active');
      const fmt = { clash: 'Clash', links: 'Links' }[sub.format] || sub.format || '-';
      const viaProxy = sub.updateViaProxy ? ' · ' + t('subs.viaProxyTag') : '';
      // Two meta lines: profile facts on top, traffic quota (when known) below.
      const trafficLine = traffic ? `<div class="sub-meta">${traffic}</div>` : '';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-name">${escapeHtml(sub.name)}${isActive ? ' ✓' : ''}</div>
          <div class="sub-meta">${t('subs.nodes', (sub.nodes || []).length)} · ${fmt} · ${auInfo}${viaProxy} · ${t('subs.updatedAt', fmtDate(sub.updatedAt))}</div>
          ${trafficLine}
        </div>
        <div class="sub-actions">
          <button class="btn ${isActive ? 'success' : ''}" data-act="activate" data-id="${sub.id}" ${isActive ? 'disabled' : ''}>${isActive ? t('subs.enabled') : t('subs.enable')}</button>
          <button class="btn" data-act="update" data-id="${sub.id}">${t('subs.update')}</button>
          <button class="btn" data-act="edit" data-id="${sub.id}">${t('subs.edit')}</button>
          <button class="btn" data-act="editraw" data-id="${sub.id}">${t('subs.editRaw')}</button>
          <button class="btn danger" data-act="remove" data-id="${sub.id}">${t('subs.remove')}</button>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        if (b.dataset.act === 'activate') {
          b.disabled = true;
          await call(api.setActiveSub, { id });
          await App.refresh();
        } else if (b.dataset.act === 'update') {
          b.disabled = true;
          b.textContent = t('subs.updating');
          await call(api.updateSubscription, { id });
          toast(t('toast.subUpdated'));
          await App.refresh();
        } else if (b.dataset.act === 'edit') {
          openSubEdit(id);
        } else if (b.dataset.act === 'editraw') {
          openRawEdit(id);
        } else if (b.dataset.act === 'remove') {
          await call(api.removeSubscription, { id });
          await App.refresh();
        }
      });
    });
  }

  // Open the edit panel populated with a subscription's data.
  function openSubEdit(id) {
    const sub = (App.state.subscriptions || []).find((s) => s.id === id);
    if (!sub) return;
    editingSubId = id;
    $('#editName').value = sub.name || '';
    $('#editUrl').value = sub.url || '';
    $('#editAutoUpdate').value = String(sub.autoUpdateMinutes || 0);
    $('#editViaProxy').checked = !!sub.updateViaProxy;
    $('#subEditPanel').classList.remove('hidden');
    $('#subEditPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Add a subscription.
  $('#subAddBtn').addEventListener('click', async () => {
    const url = $('#subUrl').value.trim();
    if (!url) return toast(t('toast.needUrl'), true);
    const name = $('#subName').value.trim();
    const btn = $('#subAddBtn');
    btn.disabled = true;
    btn.textContent = t('subs.fetching');
    try {
      const sub = await call(api.addSubscription, { name, url });
      toast(t('toast.subAdded', sub.name, sub.nodes.length));
      $('#subUrl').value = '';
      $('#subName').value = '';
      await App.refresh();
    } finally {
      btn.disabled = false;
      btn.textContent = t('subs.addBtn');
    }
  });

  // Subscription edit panel
  $('#editCancel').addEventListener('click', () => {
    editingSubId = null;
    $('#subEditPanel').classList.add('hidden');
  });
  $('#editSave').addEventListener('click', async () => {
    if (!editingSubId) return;
    const btn = $('#editSave');
    btn.disabled = true;
    try {
      await call(api.editSubscription, {
        id: editingSubId,
        name: $('#editName').value.trim(),
        url: $('#editUrl').value.trim(),
        autoUpdateMinutes: parseInt($('#editAutoUpdate').value, 10) || 0,
        updateViaProxy: $('#editViaProxy').checked,
      });
      toast(t('settings.saved'));
      editingSubId = null;
      $('#subEditPanel').classList.add('hidden');
      await App.refresh();
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Raw-content editor highlighting ----------
  // A colorized <pre> mirror sits under the transparent-text textarea. YAML
  // keys/strings/numbers/comments and share-link schemes are tokenized line by
  // line; very large profiles fall back to plain text to keep typing snappy.
  const RAW_HL_LIMIT = 300000;
  function escapeBasic(s) {
    // Only & < > need escaping inside element content; quotes stay intact so
    // the string tokenizer below still sees them.
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hlInlineTokens(esc) {
    return esc.replace(
      /("(?:[^"\\]|\\.)*"|'[^']*')|([A-Za-z0-9_-]+)(:)(?=[ \t]|$|,|})|\b(true|false|null)\b|(?<![\w.-])(-?\d+(?:\.\d+)?)(?![\w.])/g,
      (m, str, key, colon, kw, num) => {
        if (str) return `<span class="json-str">${str}</span>`;
        if (key) return `<span class="json-key">${key}</span>${colon}`;
        if (kw) return `<span class="json-bool">${kw}</span>`;
        if (num) return `<span class="json-num">${num}</span>`;
        return m;
      }
    );
  }
  function highlightSubSource(text) {
    const out = [];
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) {
        out.push(`<span class="yml-comment">${escapeBasic(line)}</span>`);
        continue;
      }
      // Share links: color the scheme, leave the (often base64) payload plain.
      const link = line.match(/^(\s*)([a-z][a-z0-9+]*):\/\/(.*)$/i);
      if (link) {
        out.push(
          escapeBasic(link[1]) +
            `<span class="lnk-scheme">${escapeBasic(link[2])}://</span>` +
            escapeBasic(link[3])
        );
        continue;
      }
      out.push(hlInlineTokens(escapeBasic(line)));
    }
    return out.join('\n');
  }
  function renderRawHighlight() {
    const wrap = $('#rawEditorWrap');
    const ta = $('#rawContent');
    const hl = $('#rawHighlight');
    if (ta.value.length > RAW_HL_LIMIT) {
      wrap.classList.add('plain');
      hl.textContent = '';
      return;
    }
    wrap.classList.remove('plain');
    // Trailing newline keeps the mirror's height in step on the last line.
    hl.innerHTML = highlightSubSource(ta.value) + '\n';
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }
  let rawHlTimer = null;
  $('#rawContent').addEventListener('input', () => {
    clearTimeout(rawHlTimer);
    rawHlTimer = setTimeout(renderRawHighlight, 120);
  });
  $('#rawContent').addEventListener('scroll', () => {
    const ta = $('#rawContent');
    const hl = $('#rawHighlight');
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  });

  // Profile raw-content editor: edit the stored source text (Clash YAML or
  // share links), re-parsed and applied on save.
  let rawEditId = null;
  function closeRawModal() {
    rawEditId = null;
    $('#rawModal').classList.add('hidden');
  }
  async function openRawEdit(id) {
    let r;
    try {
      r = await call(api.getSubRaw, { id });
    } catch (_) {
      return; // toast already shown by call()
    }
    if (!r || !r.raw) {
      // Profiles fetched before raw content was stored: one Update fills it in.
      toast(t('subs.rawEmpty'), true);
      return;
    }
    rawEditId = id;
    const sub = (App.state.subscriptions || []).find((s) => s.id === id);
    $('#rawName').textContent = sub ? sub.name : '';
    $('#rawContent').value = r.raw;
    $('#rawModal').classList.remove('hidden');
    renderRawHighlight();
  }
  $('#rawCancel').addEventListener('click', closeRawModal);
  $('#rawModal').addEventListener('click', (e) => {
    if (e.target.id === 'rawModal') closeRawModal();
  });
  $('#rawSave').addEventListener('click', async () => {
    if (!rawEditId) return;
    const btn = $('#rawSave');
    btn.disabled = true;
    try {
      const r = await call(api.saveSubRaw, { id: rawEditId, content: $('#rawContent').value });
      toast(t('subs.rawSaved', r.nodeCount));
      closeRawModal();
      await App.refresh();
    } finally {
      btn.disabled = false;
    }
  });

  App.renderSubs = renderSubs;
})();
