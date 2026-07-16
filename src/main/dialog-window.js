'use strict';

const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { BrowserWindow, nativeTheme } = require('electron');

const { state, sendToMain } = require('./state');

const isWin = process.platform === 'win32';
const windowsBuild = isWin ? Number(os.release().split('.')[2]) || 0 : 0;
const supportsSystemMaterial = isWin && windowsBuild >= 22621;

const DIALOG_SPECS = Object.freeze({
  'local-rule': { width: 580, height: 610 },
  'remote-rule': { width: 680, height: 600 },
  'raw-profile': { width: 920, height: 700 },
  convert: { width: 920, height: 700 },
  core: { width: 700, height: 500 },
  geodata: { width: 720, height: 560 },
  uwp: { width: 780, height: 650 },
  route: { width: 760, height: 620 },
  diagnostics: { width: 900, height: 700 },
  'config-check': { width: 900, height: 700 },
  ports: { width: 740, height: 600 },
  backup: { width: 720, height: 600 },
  dns: { width: 760, height: 640 },
});

const ID_DIALOGS = new Set(['local-rule', 'remote-rule', 'raw-profile']);
const REQUIRED_ID_DIALOGS = new Set(['remote-rule', 'raw-profile']);
const CHANGE_SCOPES = new Set(['state', 'subscriptions', 'rules', 'geodata', 'all']);
const DIALOG_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'dialog.html')).href;
const PREWARM_TTL_MS = 8_000;

let dialogWindow = null;
let dialogContext = null;
let dialogSpec = null;
let dialogLoadPromise = null;
let parentCleanup = null;
let prewarmTimer = null;
let showFallbackTimer = null;
let showRequested = false;

function cleanPayload(type, payload) {
  const clean = {};
  if (ID_DIALOGS.has(type) && payload && payload.id !== undefined && payload.id !== null) {
    if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 160) {
      throw new Error('invalid dialog id');
    }
    clean.id = payload.id;
  }
  if (REQUIRED_ID_DIALOGS.has(type) && !clean.id) throw new Error('dialog id is required');
  return clean;
}

function rendererTheme() {
  const settings = state.store ? state.store.getSettings() : {};
  const theme = settings.theme || 'dark';
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme !== 'light';
  return { theme, dark, language: settings.language || 'zh' };
}

function dialogBounds(parent, spec) {
  const bounds = parent.getBounds();
  const width = Math.min(spec.width, Math.max(520, bounds.width - 64));
  const height = Math.min(spec.height, Math.max(420, bounds.height - 64));
  return {
    width,
    height,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
  };
}

function applyDialogMaterial(win, dark) {
  if (!win || win.isDestroyed()) return;
  try {
    if (supportsSystemMaterial) {
      win.setBackgroundMaterial('mica');
      win.setBackgroundColor('#00000000');
    } else {
      win.setBackgroundColor(dark ? '#202024' : '#f3f3f5');
    }
  } catch (_) {
    /* Windows before 11 22H2 and older Electron builds use the solid fallback. */
  }
}

function removeParentListeners() {
  if (parentCleanup) parentCleanup();
  parentCleanup = null;
}

function clearTimer(name) {
  const timer = name === 'prewarm' ? prewarmTimer : showFallbackTimer;
  if (timer) clearTimeout(timer);
  if (name === 'prewarm') prewarmTimer = null;
  else showFallbackTimer = null;
}

function closeDialog() {
  clearTimer('prewarm');
  clearTimer('show');
  const win = dialogWindow;
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
}

function createDialogWindow(parent, spec, appearance) {
  const bounds = dialogBounds(parent, spec);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 420,
    parent,
    modal: true,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    hasShadow: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: supportsSystemMaterial ? '#00000000' : appearance.dark ? '#202024' : '#f3f3f5',
    ...(supportsSystemMaterial ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  dialogWindow = win;
  dialogSpec = spec;

  const recenter = () => {
    if (!win.isDestroyed() && !parent.isDestroyed()) {
      win.setBounds(dialogBounds(parent, dialogSpec || spec), false);
    }
  };
  const hideWithParent = () => closeDialog();
  parent.on('move', recenter);
  parent.on('resize', recenter);
  parent.on('hide', hideWithParent);
  parentCleanup = () => {
    if (parent.isDestroyed()) return;
    parent.removeListener('move', recenter);
    parent.removeListener('resize', recenter);
    parent.removeListener('hide', hideWithParent);
  };

  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    applyDialogMaterial(win, appearance.dark);
  });
  win.on('closed', () => {
    if (dialogWindow !== win) return;
    dialogWindow = null;
    dialogContext = null;
    dialogSpec = null;
    dialogLoadPromise = null;
    showRequested = false;
    clearTimer('prewarm');
    clearTimer('show');
    removeParentListeners();
  });

  const loadPromise = win.loadURL(DIALOG_URL).then(() => {
    if (win.isDestroyed()) return;
    win.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl !== DIALOG_URL) event.preventDefault();
    });
  }).catch((error) => {
    if (!win.isDestroyed()) win.close();
    throw error;
  });
  dialogLoadPromise = loadPromise;
  return { win, loadPromise };
}

function scheduleShowFallback(win) {
  clearTimer('show');
  showFallbackTimer = setTimeout(() => {
    showFallbackTimer = null;
    if (
      dialogWindow === win &&
      showRequested &&
      !win.isDestroyed() &&
      !win.isVisible()
    ) {
      win.show();
    }
  }, 350);
  if (showFallbackTimer.unref) showFallbackTimer.unref();
}

async function prepareDialog() {
  const parent = state.mainWindow;
  if (!parent || parent.isDestroyed()) return false;
  if (dialogWindow && !dialogWindow.isDestroyed()) return !showRequested;

  removeParentListeners();
  dialogContext = null;
  showRequested = false;
  const appearance = rendererTheme();
  const { win, loadPromise } = createDialogWindow(parent, DIALOG_SPECS.diagnostics, appearance);
  clearTimer('prewarm');
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    if (dialogWindow === win && !showRequested && !win.isDestroyed()) win.close();
  }, PREWARM_TTL_MS);
  if (prewarmTimer.unref) prewarmTimer.unref();
  await loadPromise;
  return true;
}

async function openDialog(type, payload) {
  const spec = DIALOG_SPECS[type];
  if (!spec) throw new Error('unsupported dialog');
  const parent = state.mainWindow;
  if (!parent || parent.isDestroyed()) throw new Error('main window unavailable');

  const appearance = rendererTheme();
  const nextContext = {
    type,
    payload: cleanPayload(type, payload),
    language: appearance.language,
    theme: appearance.theme,
  };
  const prepared = !!(
    dialogWindow &&
    !dialogWindow.isDestroyed() &&
    !dialogContext &&
    !showRequested
  );

  let win;
  let loadPromise;
  if (prepared) {
    win = dialogWindow;
    loadPromise = dialogLoadPromise;
    dialogSpec = spec;
    win.setBounds(dialogBounds(parent, spec), false);
  } else {
    if (dialogWindow && !dialogWindow.isDestroyed()) closeDialog();
    removeParentListeners();
    ({ win, loadPromise } = createDialogWindow(parent, spec, appearance));
  }

  clearTimer('prewarm');
  dialogContext = nextContext;
  showRequested = true;
  applyDialogMaterial(win, appearance.dark);
  await loadPromise;
  if (win.isDestroyed() || dialogWindow !== win) throw new Error('dialog window unavailable');
  if (prepared) win.webContents.send('dialog:context', getDialogContext({ sender: win.webContents }));
  scheduleShowFallback(win);
  return true;
}

function requireDialogSender(event) {
  if (
    !dialogWindow ||
    dialogWindow.isDestroyed() ||
    !event ||
    event.sender !== dialogWindow.webContents
  ) {
    throw new Error('invalid dialog window');
  }
  return dialogWindow;
}

function getDialogContext(event) {
  requireDialogSender(event);
  return dialogContext ? { ...dialogContext, payload: { ...dialogContext.payload } } : null;
}

function viewReady(event) {
  const win = requireDialogSender(event);
  if (!showRequested || !dialogContext) return false;
  clearTimer('show');
  applyDialogMaterial(win, rendererTheme().dark);
  if (!win.isVisible()) win.show();
  return true;
}

function notifyChanged(event, change) {
  requireDialogSender(event);
  const scope = change && change.scope;
  if (!CHANGE_SCOPES.has(scope)) throw new Error('invalid dialog change scope');
  const message = typeof change.message === 'string' ? change.message.slice(0, 500) : '';
  sendToMain('dialog:changed', { scope, message });
  return true;
}

function ownerWindow(event) {
  const win = event && BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : state.mainWindow;
}

function sendToDialog(channel, payload) {
  if (
    !dialogWindow ||
    dialogWindow.isDestroyed() ||
    !dialogWindow.webContents ||
    (typeof dialogWindow.webContents.isDestroyed === 'function' && dialogWindow.webContents.isDestroyed())
  ) return false;
  try {
    dialogWindow.webContents.send(channel, payload);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  DIALOG_SPECS,
  prepareDialog,
  openDialog,
  closeDialog,
  getDialogContext,
  viewReady,
  notifyChanged,
  ownerWindow,
  requireDialogSender,
  sendToDialog,
};
