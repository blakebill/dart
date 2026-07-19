'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AUTOSTART_TASK = 'Dart-AutoStart';

function createAutoLaunchService(options) {
  const setRunItem = (enable, silent) => options.app.setLoginItemSettings({
    openAtLogin: !!enable,
    openAsHidden: !!silent,
    path: process.execPath,
    args: silent ? ['--hidden'] : [],
  });

  function taskExists() {
    try {
      return spawnSync('schtasks.exe', ['/query', '/tn', AUTOSTART_TASK], {
        windowsHide: true,
        encoding: 'utf-8',
      }).status === 0;
    } catch (_) {
      return false;
    }
  }

  function runSchtasks(args, elevate) {
    if (!elevate) {
      const result = spawnSync('schtasks.exe', args, { windowsHide: true, encoding: 'utf-8' });
      return !result.error && result.status === 0;
    }
    const argList = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
    const command = `$p = Start-Process -FilePath 'schtasks.exe' -ArgumentList @(${argList}) ` +
      `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true, encoding: 'utf-8' }
    );
    return !result.error && result.status === 0;
  }

  function taskXml() {
    const escapeXml = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`;
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Dart Network Control auto-start (elevated for TUN mode)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(process.execPath)}</Command></Exec></Actions>
</Task>`;
  }

  function createTask() {
    const tmp = path.join(os.tmpdir(), `dart-autostart-${process.pid}.xml`);
    try {
      fs.writeFileSync(tmp, '\ufeff' + taskXml(), { encoding: 'utf16le' });
      const ok = runSchtasks(['/create', '/tn', AUTOSTART_TASK, '/xml', tmp, '/f'], !options.isAdmin());
      options.log('[gui] autostart task ' + (ok ? '(re)created' : 'create failed'));
      return ok;
    } catch (error) {
      options.log('[gui] autostart task error: ' + error.message);
      return false;
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  function deleteTask() {
    const removed = runSchtasks(['/delete', '/tn', AUTOSTART_TASK, '/f'], !options.isAdmin());
    options.log('[gui] autostart task ' + (removed ? 'removed' : 'remove failed'));
    return removed;
  }

  function applyWindows(enable, silent, interactive) {
    const wantTask = !!enable && !!options.getSettings().enableTun;
    if (wantTask) {
      if (options.isAdmin()) {
        if (createTask()) setRunItem(false);
        else setRunItem(enable, silent);
        return;
      }
      if ((interactive && createTask()) || taskExists()) {
        setRunItem(false);
        return;
      }
      setRunItem(enable, silent);
      return;
    }
    if (taskExists() && (options.isAdmin() || interactive)) {
      const removed = deleteTask();
      if (!removed && interactive) throw new Error('failed to remove the elevated auto-start task');
    }
    setRunItem(enable, silent);
  }

  function apply(enable, silent, { interactive = false } = {}) {
    if (process.platform === 'linux' && !process.env.APPIMAGE) return;
    if (process.platform === 'win32') {
      applyWindows(enable, silent, interactive);
      return;
    }
    setRunItem(enable, silent);
  }

  return { apply };
}

module.exports = { createAutoLaunchService };
