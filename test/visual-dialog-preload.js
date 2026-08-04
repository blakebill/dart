'use strict';

const { contextBridge } = require('electron');

const status = Object.freeze({
  coreInstalled: true,
  coreName: 'Mihomo',
  coreVersion: '1.19.29-dart.18',
  corePath: 'C:\\Dart\\runtime\\mihomo.exe',
});

contextBridge.exposeInMainWorld('api', {
  getDialogContext: async () => ({
    type: 'core',
    language: 'en',
    theme: 'light',
    themeEffective: 'light',
    payload: {},
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
});
