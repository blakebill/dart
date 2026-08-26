'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeProcessRows } = require('../src/main/app-routing');
const { BackupController } = require('../src/main/backup-controller');
const {
  buildDiagnosticBundle,
  collectSecrets,
  redactText,
  safeSettings,
} = require('../src/main/diagnostic-bundle');
const {
  ProfileHistory,
  profileFileKey,
  profileUpdateSummary,
  runProfileMutationTransaction,
} = require('../src/main/profile-history');
const {
  parseSubscriptionContentAsync,
  shouldUseParserWorker,
} = require('../src/main/subscription-parser-service');
const { parseSubscriptionContent } = require('../src/main/subscription');
const { Store } = require('../src/main/store');
const toolbox = require('../src/main/toolbox');

let passed = 0;
async function test(name, operation) {
  try {
    await operation();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.error('  ✗ ' + name + '\n    ' + error.message);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('features:');

  await test('running application rows are bounded, deduplicated and path-safe', async () => {
    assert.deepStrictEqual(normalizeProcessRows([
      { Name: 'Browser', Path: 'C:\\Apps\\Browser.exe' },
      { name: 'browser', executable: 'browser.exe' },
      { name: 'Editor' },
      { name: 'bad\u0000name' },
    ]), [
      { name: 'Browser', executable: 'Browser.exe' },
      { name: 'Editor', executable: 'Editor.exe' },
    ]);
  });

  await test('diagnostic redaction removes credentials, profile URLs and UUIDs', async () => {
    const profile = {
      password: 'secret-pass',
      node: { uuid: '21b8de23-2698-4c2b-b9d8-99fc4c294f8a' },
      clashProxyProviders: {
        airport: {
          header: { Authorization: ['Bearer provider-header-secret'] },
          'age-secret-key': 'AGE-SECRET-KEY-TEST',
        },
      },
    };
    const secrets = [...collectSecrets(profile)];
    const sourceUrl = 'https://airport.example/sub?token=abc';
    const redacted = redactText(
      `password=secret-pass ${sourceUrl} trojan://user:pass@example.com:443 ${profile.node.uuid} ` +
        'Bearer provider-header-secret AGE-SECRET-KEY-TEST',
      { secrets, subscriptionUrls: [sourceUrl] }
    );
    assert.ok(!redacted.includes('secret-pass'));
    assert.ok(!redacted.includes('token=abc'));
    assert.ok(!redacted.includes(profile.node.uuid));
    assert.ok(!redacted.includes('user:pass'));
    assert.ok(!redacted.includes('provider-header-secret'));
    assert.ok(!redacted.includes('AGE-SECRET-KEY-TEST'));
    assert.ok(redacted.includes('<redacted>'));
    assert.deepStrictEqual(safeSettings({ mixedPort: 7890, password: 'x', enableTun: true }).password, undefined);
  });

  await test('diagnostic bundle redacts inactive profiles and controller credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-diagnostics-'));
    const profiles = [
      { id: 'active', name: 'https://name.example/?token=name-secret', format: 'clash', configHash: 'a', nodes: [{ password: 'active-secret' }] },
      { id: 'inactive', name: 'Other', format: 'clash', configHash: 'b', nodes: [{ password: 'inactive-secret' }] },
    ];
    const summaries = [
      { id: 'active', url: 'https://sub.example/a?token=url-secret' },
      { id: 'inactive', url: '' },
    ];
    const state = {
      clashApiSecret: 'controller-secret',
      systemProxyOn: false,
      store: {
        listSubscriptions: () => summaries,
        getSubscriptions: () => profiles,
        getSubscription: (id) => profiles.find((profile) => profile.id === id) || null,
        getSettings: () => ({ language: 'en', theme: 'system' }),
      },
      coreManager: {
        isCoreInstalled: () => false,
        isRunning: () => false,
      },
    };
    const bundle = await buildDiagnosticBundle({
      appVersion: 'test',
      core: { getActiveSubId: () => 'active' },
      getRecentLogs: () => ({ entries: [{ sequence: 1, line: `inactive-secret controller-secret ${profiles[0].name}` }] }),
      state,
      toolbox: {
        networkDiagnostics: async () => ({ note: 'active-secret' }),
        checkMihomoConfig: async () => ({ result: { output: 'url-secret' } }),
      },
      toolContext: {},
      userData: dir,
    });
    const serialized = JSON.stringify(bundle);
    for (const secret of ['active-secret', 'inactive-secret', 'controller-secret', 'name-secret', 'url-secret']) {
      assert.ok(!serialized.includes(secret), `diagnostic bundle leaked ${secret}`);
    }
    assert.strictEqual(bundle.privacy.credentialsRemoved, true);
    assert.strictEqual(bundle.privacy.logsOmittedForSafety, false);
  });

  await test('diagnostic redaction refreshes when a profile changes during collection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-diagnostics-race-'));
    let profile = {
      id: 'active',
      format: 'clash',
      configHash: 'before',
      nodes: [{ password: 'before-secret' }],
    };
    const state = {
      store: {
        listSubscriptions: () => [{ id: 'active', url: '' }],
        getSubscription: () => profile,
        getSettings: () => ({}),
      },
      coreManager: {
        isCoreInstalled: () => false,
        isRunning: () => false,
      },
    };
    const bundle = await buildDiagnosticBundle({
      appVersion: 'test',
      core: { getActiveSubId: () => 'active' },
      getRecentLogs: () => ({ entries: [{ sequence: 1, line: 'after-secret' }] }),
      state,
      toolbox: {
        networkDiagnostics: async () => {
          profile = { ...profile, configHash: 'after', nodes: [{ password: 'after-secret' }] };
          return {};
        },
        checkMihomoConfig: async () => ({}),
      },
      toolContext: {},
      userData: dir,
    });
    assert.strictEqual(bundle.privacy.changedDuringCollection, true);
    assert.ok(!JSON.stringify(bundle).includes('after-secret'));
  });

  await test('profile history stores one bounded private previous version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-profile-history-'));
    const history = new ProfileHistory({ getDirectory: () => dir, maxBytes: 1024 * 1024 });
    const profile = {
      id: 'profile-a',
      name: 'Before',
      nodes: [{ name: 'A', type: 'ss', password: 'private' }],
      raw: 'proxies: []',
    };
    assert.strictEqual(await history.save(profile), true);
    const loaded = await history.load('profile-a');
    assert.strictEqual(loaded.profile.name, 'Before');
    assert.strictEqual(loaded.profile.nodes[0].password, 'private');
    const file = path.join(dir, 'profile-history', profileFileKey('profile-a'));
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  });

  await test('profile history availability cache expires and failed finalization remains managed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-profile-history-cache-'));
    let now = Date.now();
    const history = new ProfileHistory({
      getDirectory: () => dir,
      now: () => now,
      maxAgeMs: 60_000,
      availabilityCacheTtlMs: 10,
    });
    const profile = (name) => ({ id: 'profile-a', name, nodes: [{ name }] });
    await history.save(profile('first'));
    assert.strictEqual(history.has('profile-a'), true);
    now += 61_000;
    assert.strictEqual(history.has('profile-a'), false, 'cached availability outlived history expiry');

    now = Date.now();
    await history.save(profile('older'));
    const transaction = await history.stage(profile('new rollback'));
    assert.strictEqual(await history.commit(transaction), true);
    const previousFile = transaction.previousFile;
    const unlink = fs.promises.unlink;
    let injected = false;
    fs.promises.unlink = async (file) => {
      if (!injected && file === previousFile) {
        injected = true;
        const error = new Error('simulated cleanup failure');
        error.code = 'EACCES';
        throw error;
      }
      return unlink.call(fs.promises, file);
    };
    try {
      assert.strictEqual(await history.finalize(transaction), false);
    } finally {
      fs.promises.unlink = unlink;
    }
    assert.strictEqual(history.stages.has(transaction), true);
    assert.strictEqual(fs.existsSync(previousFile), true);
    await history.prune();
    assert.strictEqual(history.stages.has(transaction), false);
    assert.strictEqual(fs.existsSync(previousFile), false);
  });

  await test('profile history transactions preserve the older target across injected failures', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-profile-history-tx-'));
    const history = new ProfileHistory({ getDirectory: () => dir, maxBytes: 1024 * 1024 });
    const profile = (name) => ({ id: 'profile-a', name, nodes: [{ name }] });
    assert.strictEqual(await history.save(profile('older rollback')), true);

    let applied = false;
    const realStage = history.stage.bind(history);
    history.stage = async () => false;
    await assert.rejects(runProfileMutationTransaction({
      history,
      previous: profile('current'),
      apply: async () => { applied = true; },
      rollback: async () => {},
    }), /could not be preserved/);
    history.stage = realStage;
    assert.strictEqual(applied, false, 'a failed history stage still committed Store work');

    let state = 'current';
    await assert.rejects(runProfileMutationTransaction({
      history,
      previous: profile('current'),
      apply: async () => { throw new Error('simulated Store failure'); },
      rollback: async () => { state = 'current'; },
    }), /simulated Store failure/);
    assert.strictEqual((await history.load('profile-a')).profile.name, 'older rollback');

    await assert.rejects(runProfileMutationTransaction({
      history,
      previous: profile('current'),
      apply: async () => { state = 'updated'; },
      verify: async () => { throw new Error('simulated restart failure'); },
      rollback: async () => { state = 'current'; },
    }), /simulated restart failure/);
    assert.strictEqual(state, 'current');
    assert.strictEqual((await history.load('profile-a')).profile.name, 'older rollback');

    const realCommit = history.commit.bind(history);
    history.commit = async () => false;
    await assert.rejects(runProfileMutationTransaction({
      history,
      previous: profile('current'),
      apply: async () => { state = 'updated'; },
      rollback: async () => { state = 'current'; },
    }), /could not be committed/);
    history.commit = realCommit;
    assert.strictEqual(state, 'current');
    assert.strictEqual((await history.load('profile-a')).profile.name, 'older rollback');
  });

  await test('profile history retention is reversible until backup restore finalizes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-profile-retain-'));
    const history = new ProfileHistory({ getDirectory: () => dir });
    await history.save({ id: 'keep', nodes: [{ name: 'keep-old' }] });
    await history.save({ id: 'remove', nodes: [{ name: 'remove-old' }] });
    const retention = await history.stageRetention(new Set(['keep']));
    assert.strictEqual(history.has('keep'), true);
    assert.strictEqual(history.has('remove'), false);
    assert.strictEqual(await history.discardRetention(retention), true);
    assert.strictEqual(history.has('remove'), true);
    const committed = await history.stageRetention(new Set(['keep']));
    assert.strictEqual(await history.finalizeRetention(committed), true);
    assert.strictEqual(history.has('keep'), true);
    assert.strictEqual(history.has('remove'), false);
  });

  await test('backup restore keeps only same-id pre-restore profiles as rollback targets', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-backup-target-'));
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-backup-source-'));
    const targetStore = new Store(targetDir);
    const sourceStore = new Store(sourceDir);
    const profile = (id, name) => ({ id, name, nodes: [{ name: `${name} node` }], raw: `raw:${name}` });
    targetStore.upsertSubscription(profile('same', 'current'));
    targetStore.upsertSubscription(profile('removed', 'removed current'));
    targetStore.set('activeSub', 'same');
    sourceStore.upsertSubscription(profile('same', 'restored'));
    sourceStore.upsertSubscription(profile('new-only', 'restored new'));
    sourceStore.set('activeSub', 'same');

    const history = new ProfileHistory({ getDirectory: () => targetDir });
    await history.save(profile('same', 'older rollback'));
    await history.save(profile('removed', 'stale removed'));
    await history.save(profile('new-only', 'stale new'));

    const backupFile = path.join(sourceDir, 'backup.json');
    fs.writeFileSync(backupFile, JSON.stringify(toolbox.buildBackup(sourceStore, 'test')), 'utf-8');
    let reschedules = 0;
    const state = {
      store: targetStore,
      coreManager: {
        isCoreDownloadInProgress: () => false,
        isRunning: () => false,
        setCoreType: () => {},
      },
    };
    const core = {
      queueCustomRuleMutation: (operation) => operation(),
      queueConfigMutation: (operation) => operation(),
      cancelAllRemoteUpdates: () => {},
      applyAutoLaunch: () => {},
      rescheduleAutoUpdate: () => { reschedules += 1; },
      stopCore: async () => {},
      startCore: async () => {},
    };
    const controller = new BackupController({
      app: { getVersion: () => 'test' },
      core,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [backupFile] }) },
      dialogWindows: { ownerWindow: () => null },
      sendStatus: () => {},
      sendToMain: () => {},
      state,
      toolbox,
      validateSettingsPatch: () => {},
      profileHistory: history,
    });
    const selection = await controller.select({});
    await controller.restore(selection.token);
    assert.strictEqual(targetStore.getSubscription('same').name, 'restored');
    assert.strictEqual((await history.load('same')).profile.name, 'current');
    assert.strictEqual(history.has('removed'), false);
    assert.strictEqual(history.has('new-only'), false);
    assert.ok(reschedules >= 2, 'successful restore did not settle the auto-update schedule');
  });

  await test('backup Store failure preserves the older history and reschedules recovery', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-backup-failure-'));
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-backup-failure-source-'));
    const targetStore = new Store(targetDir);
    const sourceStore = new Store(sourceDir);
    const profile = (name) => ({ id: 'same', name, nodes: [{ name }] });
    targetStore.upsertSubscription(profile('current'));
    targetStore.set('activeSub', 'same');
    sourceStore.upsertSubscription(profile('restored'));
    sourceStore.set('activeSub', 'same');
    const history = new ProfileHistory({ getDirectory: () => targetDir });
    await history.save(profile('older rollback'));
    const backupFile = path.join(sourceDir, 'backup.json');
    fs.writeFileSync(backupFile, JSON.stringify(toolbox.buildBackup(sourceStore, 'test')), 'utf-8');

    let replaceCalls = 0;
    let reschedules = 0;
    const replaceSnapshot = targetStore.replaceSnapshot.bind(targetStore);
    targetStore.replaceSnapshot = (snapshot) => {
      replaceCalls += 1;
      if (replaceCalls === 1) throw new Error('simulated backup Store failure');
      return replaceSnapshot(snapshot);
    };
    const state = {
      store: targetStore,
      coreManager: {
        isCoreDownloadInProgress: () => false,
        isRunning: () => false,
        setCoreType: () => {},
      },
    };
    const core = {
      queueCustomRuleMutation: (operation) => operation(),
      queueConfigMutation: (operation) => operation(),
      cancelAllRemoteUpdates: () => {},
      applyAutoLaunch: () => {},
      rescheduleAutoUpdate: () => { reschedules += 1; },
      stopCore: async () => {},
      startCore: async () => {},
    };
    const controller = new BackupController({
      app: { getVersion: () => 'test' },
      core,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [backupFile] }) },
      dialogWindows: { ownerWindow: () => null },
      sendStatus: () => {},
      sendToMain: () => {},
      state,
      toolbox,
      validateSettingsPatch: () => {},
      profileHistory: history,
    });
    const selection = await controller.select({});
    await assert.rejects(controller.restore(selection.token), /simulated backup Store failure/);
    assert.strictEqual(targetStore.getSubscription('same').name, 'current');
    assert.strictEqual((await history.load('same')).profile.name, 'older rollback');
    assert.ok(reschedules >= 1, 'failed restore did not settle the auto-update schedule');
  });

  await test('profile update summary reports understandable changes', async () => {
    const summary = profileUpdateSummary(
      { nodes: [{ name: 'A', server: 'a' }, { name: 'B', server: 'b' }], policyGroups: [], clashRules: ['MATCH,DIRECT'] },
      { nodes: [{ name: 'A', server: 'changed' }, { name: 'C', server: 'c' }], policyGroups: [{ name: 'g' }], clashRules: [] }
    );
    assert.deepStrictEqual(summary.nodes, { before: 2, after: 2, added: 1, removed: 1, changed: 1 });
    assert.strictEqual(summary.groups.after, 1);
    assert.strictEqual(summary.rules.before, 1);
    assert.strictEqual(summary.configChanged, true);
  });

  await test('large YAML parsing runs through a cancellable worker', async () => {
    const yaml = 'proxies:\n' + Array.from({ length: 3500 }, (_, index) => [
      `  - name: node-${index}`,
      '    type: ss',
      '    server: example.com',
      '    port: 443',
      '    cipher: aes-128-gcm',
      '    password: password',
    ].join('\n')).join('\n');
    assert.strictEqual(shouldUseParserWorker(yaml), true);
    const result = await parseSubscriptionContentAsync(yaml, parseSubscriptionContent);
    assert.strictEqual(result.nodes.length, 3500);
    assert.strictEqual(result.format, 'clash');
  });

  await test('large JSON Mihomo profiles also leave the main process', async () => {
    const json = JSON.stringify({
      proxies: Array.from({ length: 3500 }, (_, index) => ({
        name: `json-${index}`,
        type: 'ss',
        server: 'example.com',
        port: 443,
        cipher: 'aes-128-gcm',
        password: 'password',
      })),
    });
    assert.strictEqual(shouldUseParserWorker(json), true);
    const result = await parseSubscriptionContentAsync(json, parseSubscriptionContent);
    assert.strictEqual(result.nodes.length, 3500);
    assert.strictEqual(result.format, 'clash');
  });

  console.log(`${passed} feature tests passed`);
  if (process.exitCode) process.exit(process.exitCode);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
