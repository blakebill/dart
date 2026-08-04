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
    const summary = $('#subListSummary');
    list.innerHTML = '';
    if (summary) summary.textContent = t('subs.profileCount', App.state.subscriptions.length);
    if (App.state.subscriptions.length === 0) {
      list.innerHTML = `<p class="hint">${t('subs.empty')}</p>`;
      return;
    }
    for (const sub of App.state.subscriptions) {
      const div = document.createElement('div');
      div.className = 'sub-item';
      let traffic = '';
      let usagePercent = null;
      if (sub.userInfo) {
        const u = sub.userInfo;
        const used = (u.upload || 0) + (u.download || 0);
        traffic = t('subs.used', fmtBytes(used), fmtBytes(u.total));
        if (Number.isFinite(u.total) && u.total > 0) {
          usagePercent = Math.max(0, Math.min(100, used / u.total * 100));
        }
        if (u.expire) {
          const locale = getLang() === 'en' ? 'en-US' : 'zh-CN';
          traffic += ' · ' + t('subs.expire', new Date(u.expire * 1000).toLocaleDateString(locale));
        }
      }
      const au = parseInt(sub.autoUpdateMinutes || 0, 10);
      const auInfo = au > 0 ? t('subs.autoUpdateInfo', au) : t('subs.autoUpdateNone');
      const isActive = sub.id === App.state.activeSub;
      if (isActive) div.classList.add('active');
      const id = escapeHtml(sub.id);
      const viaProxy = sub.updateViaProxy ? t('subs.viaProxyTag') : '';
      const actionLabel = (label) => escapeHtml(`${label}: ${sub.name}`);
      const nodeCount = Number.isFinite(sub.nodeCount) ? sub.nodeCount : (sub.nodes || []).length;
      const facts = [
        t('subs.nodes', nodeCount),
        auInfo,
        viaProxy,
      ].filter(Boolean).map((fact) => `<span class="sub-fact">${escapeHtml(fact)}</span>`).join('');
      const trafficLine = traffic ? `
        <div class="sub-usage">
          <div class="sub-usage-copy">${escapeHtml(traffic)}</div>
          ${usagePercent === null ? '' : `<div class="sub-usage-track" aria-hidden="true"><span style="width:${usagePercent.toFixed(2)}%"></span></div>`}
        </div>` : '';
      div.innerHTML = `
        <div class="sub-info">
          <div class="sub-title-line">
            <div class="sub-name">${escapeHtml(sub.name)}</div>
            ${isActive ? `<span class="sub-active-badge">${escapeHtml(t('subs.enabled'))}</span>` : ''}
          </div>
          <div class="sub-facts">${facts}</div>
          <div class="sub-meta">${escapeHtml(t('subs.updatedAt', fmtDate(sub.updatedAt)))}</div>
          ${trafficLine}
        </div>
        <div class="sub-actions">
          <div class="sub-actions-primary">
            <button type="button" class="btn sub-activate-btn ${isActive ? 'success' : ''}" data-act="activate" data-id="${id}" aria-label="${actionLabel(isActive ? t('subs.enabled') : t('subs.enable'))}" ${isActive ? 'disabled' : ''}>${isActive ? t('subs.enabled') : t('subs.enable')}</button>
            <button type="button" class="btn primary-soft" data-act="update" data-id="${id}" aria-label="${actionLabel(t('subs.update'))}">${t('subs.update')}</button>
          </div>
          <div class="sub-actions-secondary">
            <button type="button" class="btn" data-act="edit" data-id="${id}" aria-label="${actionLabel(t('subs.edit'))}">${t('subs.edit')}</button>
            <button type="button" class="btn" data-act="editraw" data-id="${id}" aria-label="${actionLabel(t('subs.editRaw'))}">${t('subs.editRaw')}</button>
            <button type="button" class="btn danger-quiet" data-act="remove" data-id="${id}" aria-label="${actionLabel(t('subs.remove'))}">${t('subs.remove')}</button>
          </div>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const originalText = b.textContent;
        const busy = b.dataset.act === 'activate' || b.dataset.act === 'update' || b.dataset.act === 'remove';
        if (busy) {
          b.disabled = true;
          b.setAttribute('aria-busy', 'true');
        }
        try {
          if (b.dataset.act === 'activate') {
            await call(api.setActiveSub, { id });
            await App.refresh();
          } else if (b.dataset.act === 'update') {
            b.textContent = t('subs.updating');
            await call(api.updateSubscription, { id });
            toast(t('toast.subUpdated'));
            await App.refresh();
          } else if (b.dataset.act === 'edit') {
            openSubEdit(id);
          } else if (b.dataset.act === 'editraw') {
            App.openDialog('raw-profile', { id });
          } else if (b.dataset.act === 'remove') {
            await call(api.removeSubscription, { id });
            await App.refresh();
          }
        } catch (_) {
          // call() already showed the localized error toast.
        } finally {
          if (b.isConnected) {
            b.disabled = false;
            b.removeAttribute('aria-busy');
            b.textContent = originalText;
          }
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

  // Add a config profile.
  $('#subAddBtn').addEventListener('click', async () => {
    const url = $('#subUrl').value.trim();
    if (!url) return toast(t('toast.needUrl'), true);
    const name = $('#subName').value.trim();
    const btn = $('#subAddBtn');
    btn.disabled = true;
    btn.textContent = t('subs.fetching');
    try {
      const sub = await call(api.addSubscription, { name, url });
      toast(t('toast.subAdded', sub.name, sub.nodeCount));
      $('#subUrl').value = '';
      $('#subName').value = '';
      await App.refresh();
    } catch (_) {
      /* call() already showed the error */
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
    } catch (_) {
      /* call() already showed the error */
    } finally {
      btn.disabled = false;
    }
  });

  App.renderSubs = renderSubs;
})();
