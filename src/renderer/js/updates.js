'use strict';
// Small always-on version/update controller. Keeping this separate lets the
// rest of the Settings tab load only when the user opens it.
(function () {
  const App = window.App;
  const { $, toast } = App;
  const api = window.api;
  const { t } = window.i18n;

  let latestUpdateUrl = null;
  let updateRequest = null;

  function requestUpdate() {
    if (updateRequest) return updateRequest;
    updateRequest = api.checkUpdate().finally(() => { updateRequest = null; });
    return updateRequest;
  }

  async function initVersion() {
    try {
      const version = await api.getVersion();
      if ($('#appVersion')) $('#appVersion').textContent = 'v' + version;
      if ($('#aboutVersion')) $('#aboutVersion').textContent = 'v' + version;
    } catch (_) {}
  }

  async function runUpdateCheck(silent) {
    const status = $('#updateStatus');
    const download = $('#downloadUpdateBtn');
    if (status && !silent) status.textContent = t('about.checking');
    try {
      const result = await requestUpdate();
      if (result.error) {
        if (status && !silent) status.textContent = t('about.checkFailed', result.error);
        return false;
      }
      const badge = $('#versionNew');
      if (result.hasUpdate) {
        latestUpdateUrl = result.url;
        if (status) status.textContent = t('about.newVersion', 'v' + result.latest, 'v' + result.current);
        if (download) download.classList.remove('hidden');
        if (badge) badge.classList.remove('hidden');
        if (silent) {
          const message = t('about.newVersion', 'v' + result.latest, 'v' + result.current);
          toast(message);
          api.notify(t('notify.updateTitle'), message).catch(() => {});
        }
      } else {
        latestUpdateUrl = null;
        if (badge) badge.classList.add('hidden');
        if (download) download.classList.add('hidden');
        if (status && !silent) status.textContent = t('about.upToDate');
      }
      return true;
    } catch (error) {
      if (status && !silent) status.textContent = t('about.checkFailed', error.message || String(error));
      return false;
    }
  }

  $('#checkUpdateBtn').addEventListener('click', () => runUpdateCheck(false));
  if (api && api.onDownloadProgress) api.onDownloadProgress((progress) => {
    $('#downloadProgress .bar').style.width = Math.round(progress * 100) + '%';
  });
  $('#downloadUpdateBtn').addEventListener('click', async () => {
    const button = $('#downloadUpdateBtn');
    const progress = $('#downloadProgress');
    button.disabled = true;
    button.textContent = t('about.downloading');
    progress.classList.remove('hidden');
    try {
      await api.downloadUpdate();
      toast(t('about.installing'));
    } catch (error) {
      toast(t('about.fallbackPage', error.message || String(error)), true);
      if (latestUpdateUrl) api.openExternal(latestUpdateUrl).catch(() => {});
    } finally {
      button.disabled = false;
      button.textContent = t('about.download');
      setTimeout(() => progress.classList.add('hidden'), 1500);
    }
  });

  App.initVersion = initVersion;
  App.runUpdateCheck = runUpdateCheck;
})();
