'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

const { state, isDev } = require('./state');
const { startTrafficStream, stopTrafficStream } = require('./traffic');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: 'Dart',
    backgroundColor: (state.store && state.store.getSettings().theme === 'light') ? '#f4f6fa' : '#0d1017',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  state.mainWindow = mainWindow;

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Minimize to tray on close.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Pause the per-second traffic stream while hidden in the tray; resume on show.
  mainWindow.on('hide', () => stopTrafficStream());
  mainWindow.on('show', () => {
    if (state.singbox && state.singbox.isRunning()) startTrafficStream();
  });

  return mainWindow;
}

module.exports = { createWindow };
