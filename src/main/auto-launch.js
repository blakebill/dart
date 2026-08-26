'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const AUTOSTART_TASK = 'Dart-AutoStart';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&');
}

function taskXmlMatches(xml, executable, silent = false, elevated = false) {
  const source = String(xml || '');
  if (!source || /<Enabled>\s*false\s*<\/Enabled>/i.test(source)) return false;
  const command = source.match(/<Command>\s*([\s\S]*?)\s*<\/Command>/i);
  if (!command) return false;
  const decodedCommand = decodeXml(command[1]).trim();
  const unquotedCommand = decodedCommand.startsWith('"') && decodedCommand.endsWith('"')
    ? decodedCommand.slice(1, -1)
    : decodedCommand;
  const actualPath = path.normalize(unquotedCommand);
  const expectedPath = path.normalize(String(executable || ''));
  if (actualPath.toLowerCase() !== expectedPath.toLowerCase()) return false;
  const args = source.match(/<Arguments>\s*([\s\S]*?)\s*<\/Arguments>/i);
  const actualArgs = args ? decodeXml(args[1]).trim() : '';
  if (actualArgs !== (silent ? '--hidden' : '')) return false;
  const runLevel = source.match(/<RunLevel>\s*([^<]+?)\s*<\/RunLevel>/i);
  return !!runLevel && runLevel[1].trim().toLowerCase() ===
    (elevated ? 'highestavailable' : 'leastprivilege');
}

function buildTaskXml(executable, user, silent = false, elevated = false) {
  const argumentsXml = silent ? '<Arguments>--hidden</Arguments>' : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Dart Network Control auto-start</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>${elevated ? 'HighestAvailable' : 'LeastPrivilege'}</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(executable)}</Command>${argumentsXml}</Exec></Actions>
</Task>`;
}

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
        timeout: 5000,
      }).status === 0;
    } catch (_) {
      return false;
    }
  }

  function taskMatches(silent, elevated) {
    try {
      const result = spawnSync('schtasks.exe', ['/query', '/tn', AUTOSTART_TASK, '/xml'], {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 5000,
      });
      return !result.error && result.status === 0 &&
        taskXmlMatches(result.stdout, process.execPath, silent, elevated);
    } catch (_) {
      return false;
    }
  }

  function execSchtasksAsync(args) {
    return new Promise((resolve) => {
      execFile('schtasks.exe', args, {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 15000,
      }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') }));
    });
  }

  async function runSchtasksAsync(args) {
    return (await execSchtasksAsync(args)).ok;
  }

  async function taskMatchesAsync(silent, elevated) {
    const result = await execSchtasksAsync(['/query', '/tn', AUTOSTART_TASK, '/xml']);
    return result.ok && taskXmlMatches(result.stdout, process.execPath, silent, elevated);
  }

  function runSchtasks(args, elevate) {
    if (!elevate) {
      const result = spawnSync('schtasks.exe', args, {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 15000,
      });
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

  function taskXml(silent, elevated = false) {
    const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`;
    return buildTaskXml(process.execPath, user, silent, elevated);
  }

  function createTask(silent, elevated = false) {
    const tmp = path.join(os.tmpdir(), `dart-autostart-${process.pid}.xml`);
    try {
      fs.writeFileSync(tmp, '\ufeff' + taskXml(silent, elevated), { encoding: 'utf16le' });
      const ok = runSchtasks(
        ['/create', '/tn', AUTOSTART_TASK, '/xml', tmp, '/f'],
        elevated && !options.isAdmin()
      );
      options.log('[gui] autostart task ' + (ok ? '(re)created' : 'create failed'));
      return ok;
    } catch (error) {
      options.log('[gui] autostart task error: ' + error.message);
      return false;
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async function createTaskAsync(silent, elevated = false) {
    const tmp = path.join(os.tmpdir(), `dart-autostart-${process.pid}-async.xml`);
    try {
      await fs.promises.writeFile(tmp, '\ufeff' + taskXml(silent, elevated), { encoding: 'utf16le' });
      const ok = await runSchtasksAsync(['/create', '/tn', AUTOSTART_TASK, '/xml', tmp, '/f']);
      options.log('[gui] autostart task ' + (ok ? '(re)created asynchronously' : 'async create failed'));
      return ok;
    } catch (error) {
      options.log('[gui] autostart task async error: ' + error.message);
      return false;
    } finally {
      try { await fs.promises.unlink(tmp); } catch (_) {}
    }
  }

  function deleteTask(elevate = !options.isAdmin()) {
    const removed = runSchtasks(['/delete', '/tn', AUTOSTART_TASK, '/f'], elevate);
    options.log('[gui] autostart task ' + (removed ? 'removed' : 'remove failed'));
    return removed;
  }

  function applyWindows(enable, silent, interactive) {
    const elevated = !!options.getSettings().enableTun;
    if (enable) {
      const existing = !interactive && taskMatches(silent, elevated);
      const canCreate = !elevated || options.isAdmin() || interactive;
      if (existing || (canCreate && createTask(silent, elevated))) {
        setRunItem(false);
        return;
      }
      setRunItem(enable, silent);
      return;
    }
    if (taskExists()) {
      // User-owned tasks can often be removed without elevation. Always try
      // that silent path so a stale elevated task cannot keep launching Dart
      // after auto-start/TUN has been disabled. An explicit settings action may
      // fall back to UAC when Windows requires it.
      let removed = deleteTask(false);
      if (!removed && !options.isAdmin() && interactive) removed = deleteTask(true);
      if (!removed && interactive) throw new Error('failed to remove the elevated auto-start task');
    }
    setRunItem(enable, silent);
  }

  async function reconcileWindows(enable, silent) {
    const elevated = !!options.getSettings().enableTun;
    const matches = await taskMatchesAsync(silent, elevated);
    if (enable) {
      const created = !matches && (!elevated || options.isAdmin())
        ? await createTaskAsync(silent, elevated)
        : false;
      if (matches || created) {
        setRunItem(false);
        return;
      }
      // A missing elevated task requires an explicit UAC action. Keep the Run
      // fallback working without interrupting login with a prompt.
      setRunItem(true, silent);
      return;
    }
    // Query existence separately on the disable path: a malformed/disabled
    // task must still be removed instead of being ignored as a mismatch.
    if (await runSchtasksAsync(['/query', '/tn', AUTOSTART_TASK])) {
      const removed = await runSchtasksAsync(['/delete', '/tn', AUTOSTART_TASK, '/f']);
      options.log('[gui] autostart task ' + (removed ? 'removed asynchronously' : 'async remove failed'));
    }
    setRunItem(false, silent);
  }

  function apply(enable, silent, { interactive = false } = {}) {
    if (process.platform === 'linux' && !process.env.APPIMAGE) return;
    if (process.platform === 'win32') {
      applyWindows(enable, silent, interactive);
      return;
    }
    setRunItem(enable, silent);
  }

  function reconcile(enable, silent) {
    if (process.platform === 'linux' && !process.env.APPIMAGE) return Promise.resolve();
    if (process.platform === 'win32') return reconcileWindows(enable, silent);
    setRunItem(enable, silent);
    return Promise.resolve();
  }

  return { apply, reconcile };
}

module.exports = { buildTaskXml, createAutoLaunchService, taskXmlMatches };
