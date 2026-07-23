'use strict';

(function () {
  const App = window.App;
  const Dialog = App.Dialog;
  const { $ } = App;
  const api = window.api;
  const { setLang, applyI18n, t } = window.i18n;

  const DIALOG_MODULES = Object.freeze({
    'local-rule': 'dialog/editors.js',
    'remote-rule': 'dialog/editors.js',
    'raw-profile': 'dialog/editors.js',
    convert: 'dialog/editors.js',
    core: 'dialog/system.js',
    geodata: 'dialog/system.js',
    uwp: 'dialog/system.js',
    route: 'dialog/toolbox.js',
    diagnostics: 'dialog/toolbox.js',
    'config-check': 'dialog/toolbox.js',
    ports: 'dialog/toolbox.js',
    backup: 'dialog/toolbox.js',
    dns: 'dialog/toolbox.js',
  });

  function applyTheme(preference, forcedEffective) {
    let theme = preference;
    if (forcedEffective === 'light' || forcedEffective === 'dark') {
      theme = forcedEffective;
    } else if (theme === 'system') {
      try {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (_) {
        theme = 'light';
      }
    }
    theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('themePref', ['dark', 'light', 'system'].includes(preference) ? preference : 'system');
      localStorage.setItem('theme', theme);
    } catch (_) {}
  }

  $('#dialogCloseTop').addEventListener('click', Dialog.close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      Dialog.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialogWindow = document.querySelector('.native-dialog-window');
    const focusable = Dialog.focusableElements(dialogWindow);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialogWindow.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  let initialization = null;
  async function initialize(context) {
    if (initialization) return initialization;
    const module = context && DIALOG_MODULES[context.type];
    if (!module) throw new Error('Unsupported dialog');
    initialization = (async () => {
      setLang(context.language === 'en' ? 'en' : 'zh');
      applyTheme(context.theme || 'system', context.themeEffective);
      applyI18n();
      document.documentElement.lang = context.language === 'en' ? 'en' : 'zh-CN';
      document.title = t('appName');
      $('#dialogCloseTop').setAttribute('aria-label', t('window.close'));
      $('#dialogCloseTop').title = t('window.close');
      await App.loadScript(module);
      const initializer = Dialog.initializers.get(context.type);
      if (!initializer) throw new Error('Unsupported dialog');
      await initializer(context.payload || {});
    })();
    try {
      await initialization;
    } catch (error) {
      initialization = null;
      throw error;
    }
  }

  if (api.onDialogContext) {
    api.onDialogContext((context) => initialize(context).catch(Dialog.showFailure));
  }
  (async () => {
    const context = await api.getDialogContext();
    if (context) await initialize(context);
  })().catch(Dialog.showFailure);
})();
