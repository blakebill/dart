'use strict';

const { contextBridge } = require('electron');

const localRuleDialog = process.argv.includes('--visual-local-rule-dialog');

const status = Object.freeze({
  coreInstalled: true,
  coreName: 'Mihomo',
  coreVersion: '1.19.29-dart.18',
  corePath: 'C:\\Dart\\runtime\\mihomo.exe',
  kernelSmart: true,
  kernelSmartMode: true,
  kernelSmartDetection: 'probe',
});

contextBridge.exposeInMainWorld('api', {
  getDialogContext: async () => ({
    type: localRuleDialog ? 'local-rule' : 'core',
    language: 'en',
    theme: 'light',
    themeEffective: 'light',
    payload: localRuleDialog ? { id: 'visual-text-rule' } : {},
  }),
  getState: async () => ({ status }),
  coreStatus: async () => status,
  dialogViewReady: async () => true,
  closeDialog: async () => true,
  dialogChanged: async () => true,
  onDownloadProgress: () => () => {},
  openCoreFolder: async () => true,
  restartCore: async () => true,
  downloadCore: async () => true,
  listLocalRules: async () => localRuleDialog ? [{
    id: 'visual-text-rule',
    name: 'ASN routing',
    mode: 'text',
    rules: [
      'DOMAIN-SUFFIX,example.com,PROXY',
      'IP-ASN,13335,DIRECT',
    ],
    enabled: true,
  }] : [],
  listRunningApps: async () => [],
  addLocalRule: async () => true,
  editLocalRule: async () => true,
});
