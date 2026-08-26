'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { uniqueSibling, replaceFileSync } = require('./file-utils');
const { getSharedProfileHistory } = require('./profile-history');

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const BACKUP_SELECTION_TTL_MS = 10 * 60 * 1000;

async function writeAtomicText(file, text) {
  const tmp = uniqueSibling(file, 'tmp');
  try {
    await fs.promises.writeFile(tmp, text, 'utf-8');
    replaceFileSync(tmp, file);
  } finally {
    try { await fs.promises.unlink(tmp); } catch (_) {}
  }
}

async function readBackupDocument(file, toolbox) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) {
    throw new Error('backup is not a file or exceeds 64 MB');
  }
  const text = await fs.promises.readFile(file, 'utf-8');
  const document = JSON.parse(text);
  return {
    document,
    normalized: toolbox.validateBackupDocument(document),
    digest: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

class BackupController {
  constructor(deps) {
    this.app = deps.app;
    this.core = deps.core;
    this.dialog = deps.dialog;
    this.dialogWindows = deps.dialogWindows;
    this.sendStatus = deps.sendStatus;
    this.sendToMain = deps.sendToMain;
    this.state = deps.state;
    this.toolbox = deps.toolbox;
    this.validateSettingsPatch = deps.validateSettingsPatch;
    this.profileHistory = deps.profileHistory || getSharedProfileHistory({
      getDirectory: () => this.state.store && this.state.store.dir,
    });
    this.pending = null;
  }

  register(ipcMain) {
    ipcMain.handle('tools:backupExport', (event) => this.export(event));
    ipcMain.handle('tools:backupSelect', (event) => this.select(event));
    ipcMain.handle('tools:backupRestore', (_event, payload = {}) => this.restore(payload.token));
  }

  async export(event) {
    const backup = this.toolbox.buildBackup(this.state.store, this.app.getVersion());
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const result = await this.dialog.showSaveDialog(this.dialogWindows.ownerWindow(event), {
      title: 'Export Dart backup',
      defaultPath: `Dart-backup-${stamp}.json`,
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeAtomicText(result.filePath, JSON.stringify(backup, null, 2));
    return result.filePath;
  }

  async select(event) {
    const result = await this.dialog.showOpenDialog(this.dialogWindows.ownerWindow(event), {
      title: 'Select Dart backup',
      properties: ['openFile'],
      filters: [{ name: 'Dart backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const { document, normalized, digest } = await readBackupDocument(file, this.toolbox);
    const token = crypto.randomUUID();
    this.pending = { token, file, digest, expiresAt: Date.now() + BACKUP_SELECTION_TTL_MS };
    return {
      token,
      fileName: path.basename(file),
      summary: this.toolbox.backupSummary(document, normalized),
    };
  }

  async restore(token) {
    if (typeof token !== 'string' || !token) throw new Error('invalid backup token');
    if (!this.pending || this.pending.token !== token || this.pending.expiresAt < Date.now()) {
      this.pending = null;
      throw new Error('backup selection expired; select the file again');
    }
    if (this.state.coreManager.isCoreDownloadInProgress()) {
      throw new Error('wait for the core update to finish before restoring a backup');
    }
    const selected = this.pending;
    const loaded = await readBackupDocument(selected.file, this.toolbox);
    if (loaded.digest !== selected.digest) {
      this.pending = null;
      throw new Error('backup file changed after selection; select it again');
    }

    const restored = loaded.normalized;
    const currentSettings = this.state.store.getSettings();
    const knownSettings = new Set(Object.keys(currentSettings));
    restored.settings = Object.fromEntries(
      Object.entries(restored.settings).filter(([key]) => knownSettings.has(key))
    );
    this.validateSettingsPatch(restored.settings, currentSettings);

    return this.core.queueCustomRuleMutation(() => this.core.queueConfigMutation(async () => {
      const before = this.toolbox.validateBackupDocument(
        this.toolbox.buildBackup(this.state.store, this.app.getVersion())
      );
      const wasRunning = this.state.coreManager.isRunning();
      const restoredIds = new Set(restored.subscriptions.map((profile) => profile.id));
      const rollbackProfiles = before.subscriptions.filter((profile) => restoredIds.has(profile.id));
      const keepHistoryIds = new Set(rollbackProfiles.map((profile) => profile.id));
      const historyStages = [];
      let retention = null;
      let storeAttempted = false;
      this.core.cancelAllRemoteUpdates();
      const activate = (data) => {
        this.state.store.replaceSnapshot(data);
        const settings = this.state.store.getSettings();
        this.state.coreManager.setCoreType(settings.coreType);
        this.core.applyAutoLaunch(settings.autoLaunch, settings.silentStart);
        this.core.rescheduleAutoUpdate();
      };
      try {
        // Stage every same-id pre-restore profile before stopping the core or
        // touching Store. One failed stage aborts the restore with the previous
        // snapshot and all older rollback targets intact.
        for (const profile of rollbackProfiles) {
          const stage = await this.profileHistory.stage(profile);
          if (!stage) throw new Error('the current profile versions could not be preserved');
          historyStages.push(stage);
        }
        if (wasRunning) await this.core.stopCore(true);
        storeAttempted = true;
        activate(restored);
        this.core.cancelAllRemoteUpdates();

        for (const stage of historyStages) {
          if (!await this.profileHistory.commit(stage)) {
            throw new Error('the current profile versions could not be committed');
          }
        }
        // Only profiles that existed both before and after restore have a
        // meaningful one-step rollback target. This also removes stale history
        // belonging to profiles absent from the restored snapshot.
        retention = await this.profileHistory.stageRetention(keepHistoryIds);
        if (!retention) throw new Error('profile history could not be reconciled after restore');
      } catch (error) {
        this.core.cancelAllRemoteUpdates();
        this.pending = null;
        let recoveryError = null;
        if (retention && !await this.profileHistory.discardRetention(retention)) {
          recoveryError = new Error('removed profile history could not be restored');
        }
        for (const stage of historyStages.slice().reverse()) {
          if (!await this.profileHistory.discard(stage) && !recoveryError) {
            recoveryError = new Error('the previous profile history could not be restored');
          }
        }
        try {
          if (storeAttempted) activate(before);
          if (wasRunning && !this.state.coreManager.isRunning()) await this.core.startCore();
        } catch (restoreError) {
          if (!recoveryError) recoveryError = restoreError;
        }
        try { this.core.rescheduleAutoUpdate(); } catch (_) {}
        if (recoveryError) error.recoveryError = recoveryError;
        throw error;
      }

      for (const stage of historyStages) await this.profileHistory.finalize(stage);
      await this.profileHistory.finalizeRetention(retention);
      this.core.rescheduleAutoUpdate();

      this.pending = null;
      this.sendToMain('subs:changed');
      this.sendStatus();
      return {
        restored: true,
        stoppedCore: wasRunning,
        summary: this.toolbox.backupSummary({
          appVersion: this.app.getVersion(),
          createdAt: new Date().toISOString(),
        }, restored),
      };
    }));
  }
}

module.exports = { BackupController, readBackupDocument };
