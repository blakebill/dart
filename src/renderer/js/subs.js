'use strict';
// Subscriptions tab: profile list, add/edit panel and the raw-content editor
// (transparent textarea over a colorized <pre> mirror).
(function () {
  const App = window.App;
  const { $, toast, call, fmtBytes, fmtDate, escapeHtml } = App;
  const api = window.api;
  const { t, getLang } = window.i18n;

  let editingSubId = null;
  let openActionMenu = null;
  let openActionTrigger = null;

  function actionMenuItems(menu) {
    return menu ? [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')] : [];
  }

  function closeActionMenu(restoreFocus = false) {
    const trigger = openActionTrigger;
    if (openActionMenu) openActionMenu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    openActionMenu = null;
    openActionTrigger = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
  }

  function showActionMenu(trigger, focusLast = false) {
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!menu) return;
    closeActionMenu(false);
    openActionMenu = menu;
    openActionTrigger = trigger;
    menu.classList.remove('opens-up');
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8 && triggerRect.top > menuRect.height + 8) {
      menu.classList.add('opens-up');
    }
    const items = actionMenuItems(menu);
    const target = focusLast ? items[items.length - 1] : items[0];
    if (target) target.focus();
  }

  document.addEventListener('mousedown', (event) => {
    if (!openActionMenu) return;
    if (openActionMenu.contains(event.target) || openActionTrigger.contains(event.target)) return;
    closeActionMenu(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openActionMenu) {
      event.preventDefault();
      closeActionMenu(true);
    }
  });

  function renderSubs() {
    const list = $('#subList');
    const summary = $('#subListSummary');
    closeActionMenu(false);
    list.innerHTML = '';
    if (summary) summary.textContent = t('subs.profileCount', App.state.subscriptions.length);
    if (App.state.subscriptions.length === 0) {
      list.innerHTML = `<p class="hint">${t('subs.empty')}</p>`;
      return;
    }
    for (const [index, sub] of App.state.subscriptions.entries()) {
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
      const menuId = `sub-actions-${index}`;
      const viaProxy = sub.updateViaProxy ? t('subs.viaProxyTag') : '';
      const actionLabel = (label) => escapeHtml(`${label}: ${sub.name}`);
      const nodeCount = Number.isFinite(sub.nodeCount) ? sub.nodeCount : (sub.nodes || []).length;
      const facts = [
        t('subs.nodes', nodeCount),
        Number(sub.providerCount) > 0 ? t('subs.providers', sub.providerCount) : '',
        auInfo,
        viaProxy,
      ].filter(Boolean).map((fact) => `<span class="sub-fact">${escapeHtml(fact)}</span>`).join('');
      const trafficLine = traffic ? `
        <div class="sub-usage">
          <div class="sub-usage-copy">${escapeHtml(traffic)}</div>
          ${usagePercent === null ? '' : `<div class="sub-usage-track" aria-hidden="true"><span style="width:${usagePercent.toFixed(2)}%"></span></div>`}
        </div>` : '';
      const updateAction = sub.url
        ? `<button type="button" class="btn primary-soft" data-act="update" data-id="${id}" aria-label="${actionLabel(t('subs.update'))}">${t('subs.update')}</button>`
        : '';
      const rollbackAction = sub.canRollback
        ? `<button type="button" class="sub-menu-item" role="menuitem" data-act="rollback" data-id="${id}">${t('subs.rollback')}</button>`
        : '';
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
            ${updateAction}
            <div class="sub-overflow">
              <button type="button" class="btn sub-more-btn" data-menu-toggle aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" aria-label="${actionLabel(t('subs.moreActions'))}" title="${escapeHtml(t('subs.moreActions'))}"><span aria-hidden="true">⋯</span></button>
              <div id="${menuId}" class="sub-overflow-menu" role="menu" aria-label="${actionLabel(t('subs.moreActions'))}" hidden>
                <button type="button" class="sub-menu-item" role="menuitem" data-act="edit" data-id="${id}">${t('subs.edit')}</button>
                <button type="button" class="sub-menu-item" role="menuitem" data-act="editraw" data-id="${id}">${t('subs.editRaw')}</button>
                ${rollbackAction}
                <button type="button" class="sub-menu-item is-danger" role="menuitem" data-act="remove" data-id="${id}">${t('subs.remove')}</button>
              </div>
            </div>
          </div>
        </div>`;
      list.appendChild(div);
    }
    list.querySelectorAll('[data-menu-toggle]').forEach((trigger) => {
      trigger.addEventListener('click', () => {
        if (openActionTrigger === trigger) closeActionMenu(true);
        else showActionMenu(trigger);
      });
      trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        showActionMenu(trigger, event.key === 'ArrowUp');
      });
    });
    list.querySelectorAll('.sub-overflow-menu').forEach((menu) => {
      menu.addEventListener('keydown', (event) => {
        const items = actionMenuItems(menu);
        if (!items.length) return;
        if (event.key === 'Tab') {
          closeActionMenu(false);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = Math.max(0, items.indexOf(document.activeElement));
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = (current + 1) % items.length;
        else next = (current - 1 + items.length) % items.length;
        items[next].focus();
      });
    });
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        closeActionMenu(false);
        const id = b.dataset.id;
        const originalText = b.textContent;
        const busy = ['activate', 'update', 'rollback', 'remove'].includes(b.dataset.act);
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
            const result = await call(api.updateSubscription, { id });
            if (result && result.cancelled) return;
            toast(t('toast.subUpdated'));
            await App.refresh();
          } else if (b.dataset.act === 'rollback') {
            const result = await call(api.rollbackSubscription, { id });
            if (result && result.cancelled) return;
            toast(t('toast.subRolledBack'));
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
  App.registerRendererModule('subs');
})();
