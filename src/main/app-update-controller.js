'use strict';

const fs = require('fs');
const path = require('path');

class AppUpdateController {
  constructor(options) {
    this.options = options;
    this.task = null;
    this.controller = null;
    this.quitPending = false;
  }

  register(ipcMain) {
    ipcMain.handle('app:checkUpdate', () => this.options.update.checkUpdate(
      this.options.app.getVersion(),
      this.options.core.currentProxyPort(),
      this.options.sendLog
    ));
    ipcMain.handle('update:download', () => this.download());
  }

  cancel() {
    if (this.controller) this.controller.abort();
  }

  async cancelAndWait() {
    this.cancel();
    if (this.task) await Promise.allSettled([this.task]);
  }

  download() {
    const { app } = this.options;
    if (this.task || this.quitPending || app.isQuitting) {
      return Promise.reject(new Error('app update download already in progress'));
    }
    const controller = new AbortController();
    this.controller = controller;
    const task = this._download(controller).finally(() => {
      if (this.task === task) this.task = null;
      if (this.controller === controller) this.controller = null;
    });
    this.task = task;
    task.catch(() => {});
    return task;
  }

  async _download(controller) {
    const { app, core, fetch, sendLog, sendToMain, shell, update } = this.options;
    const proxyPort = core.currentProxyPort();
    const info = await update.checkUpdate(app.getVersion(), proxyPort, sendLog, { signal: controller.signal });
    if (controller.signal.aborted || app.isQuitting) throw this._aborted();
    if (info.error) throw new Error(info.error);
    if (!info.hasUpdate) throw new Error('already up to date');
    if (!info.assetUrl || !info.assetName) throw new Error('no installer asset on the latest release');
    const assetName = path.basename(info.assetName);
    if (assetName !== info.assetName || /[\\/]/.test(info.assetName)) {
      throw new Error('invalid installer asset name');
    }

    const dest = path.join(app.getPath('temp'), assetName);
    sendLog('[gui] downloading update: ' + info.assetUrl +
      (proxyPort ? ' (via proxy)' : ' (direct - start the core to download via proxy)'));
    try {
      await fetch.downloadWithFallback(info.assetUrl, dest, {
        proxyPort,
        signal: controller.signal,
        log: sendLog,
        onProgress: (progress) => sendToMain('core:downloadProgress', progress),
      });
    } catch (error) {
      try { fs.unlinkSync(dest); } catch (_) {}
      if (error && error.code === 'ABORT_ERR') throw error;
      throw new Error(error.message +
        (proxyPort ? '' : ' - start the core first so the download can go through the proxy'));
    }
    try {
      if (controller.signal.aborted || app.isQuitting) throw this._aborted();
      update.validateInstaller(dest, Number(info.assetSize) || 0);
      await update.verifyInstallerIntegrity(dest, info, proxyPort, sendLog, { signal: controller.signal });
      if (controller.signal.aborted || app.isQuitting) throw this._aborted();
    } catch (error) {
      try { fs.unlinkSync(dest); } catch (_) {}
      throw error;
    }

    const openError = await shell.openPath(dest);
    if (openError) {
      try { fs.unlinkSync(dest); } catch (_) {}
      throw new Error('failed to launch installer: ' + openError);
    }
    sendLog('[gui] installer launched; quitting for the update');
    this.quitPending = true;
    setTimeout(async () => {
      if (app.isQuitting) return;
      app.isQuitting = true;
      try { await core.cleanup(); } catch (_) {}
      app.quit();
    }, 1200);
    return true;
  }

  _aborted() {
    return Object.assign(new Error('app is shutting down'), { code: 'ABORT_ERR' });
  }
}

module.exports = { AppUpdateController };
