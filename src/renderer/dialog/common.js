'use strict';

(function () {
  const App = window.App;
  const { $, call, escapeHtml } = App;
  const api = window.api;
  const { t, applyI18n } = window.i18n;

  const initializers = new Map();

  function register(type, initializer) {
    initializers.set(type, initializer);
  }

  function setView(titleKey, html, options = {}) {
    $('#dialogTitle').textContent = options.title || t(titleKey);
    const content = $('#dialogContent');
    content.className = 'native-dialog-content' + (options.className ? ' ' + options.className : '');
    content.innerHTML = html;
    applyI18n();
    if (App.enhanceSelects) App.enhanceSelects(content);
    content.querySelectorAll('.tool-result, [data-dialog-status]').forEach((region) => {
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
    });
    const dialogWindow = document.querySelector('.native-dialog-window');
    if (dialogWindow) dialogWindow.setAttribute('aria-busy', 'false');
    requestAnimationFrame(() => focusInitial(dialogWindow));
    if (api.dialogViewReady) {
      requestAnimationFrame(() => api.dialogViewReady().catch(() => {}));
    }
    content.querySelectorAll('[data-dialog-close]').forEach((button) => {
      button.addEventListener('click', close);
    });
  }

  function focusableElements(root = document) {
    return Array.from(root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
      'textarea:not([disabled]), [role="combobox"]:not([aria-disabled="true"]), ' +
      'a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && element.offsetParent !== null && !element.closest('[hidden]'));
  }

  function focusInitial(dialogWindow) {
    if (dialogWindow) dialogWindow.focus({ preventScroll: true });
  }

  function footer(buttons = '') {
    return `<footer class="dialog-footer">${buttons}<button class="btn" data-dialog-close data-i18n="tools.close">${escapeHtml(t('tools.close'))}</button></footer>`;
  }

  function close() {
    api.closeDialog().catch(() => {});
  }

  async function changed(scope, message = '') {
    await api.dialogChanged(scope, message);
  }

  async function finish(scope, message = '') {
    await changed(scope, message);
    close();
  }

  function bind(selector, eventName, handler) {
    const element = typeof selector === 'string' ? $(selector) : selector;
    if (!element) return null;
    element.addEventListener(eventName, (event) => {
      Promise.resolve(handler(event)).catch(() => {});
    });
    return element;
  }

  async function runBusy(button, busyKey, operation) {
    const previous = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const dialogWindow = document.querySelector('.native-dialog-window');
    if (dialogWindow) dialogWindow.setAttribute('aria-busy', 'true');
    if (busyKey) button.textContent = t(busyKey);
    try {
      return await operation();
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = previous;
      }
      if (dialogWindow) dialogWindow.setAttribute('aria-busy', 'false');
    }
  }

  function statusBadge(status) {
    const normalized = ['pass', 'warn', 'fail', 'skip', 'missing'].includes(status) ? status : 'skip';
    return `<span class="tool-status ${normalized}">${escapeHtml(t('toolbox.status.' + normalized))}</span>`;
  }

  function resultRow(label, value, status = null) {
    const display = value === undefined || value === null || value === '' ? '-' : String(value);
    return `<div class="tool-result-row"><span>${escapeHtml(label)}</span><div>${status ? statusBadge(status) : ''}<b>${escapeHtml(display)}</b></div></div>`;
  }

  function emptyResult(key = 'toolbox.notRun') {
    return `<p class="tool-empty">${escapeHtml(t(key))}</p>`;
  }

  function showFailure(error) {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    setView('appName', `<div class="dialog-error">${escapeHtml(message)}</div>${footer()}`, { title: 'Dart' });
  }

  App.Dialog = {
    initializers,
    register,
    setView,
    footer,
    close,
    changed,
    finish,
    bind,
    runBusy,
    statusBadge,
    resultRow,
    emptyResult,
    showFailure,
    focusableElements,
    call,
  };
})();
