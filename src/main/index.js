'use strict';

/**
 * index.js — Electron entry point.
 * Registers the app:// scheme, creates the frameless window, wires IPC,
 * enforces single instance.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { PATHS } = require('../shared/constants');
const { ensureDir } = require('./storage');
const ipc = require('./ipc-handlers');
const settingsMod = require('./settings');
const appProtocol = require('./protocol');
const { log, attachWindow } = require('./logger');

const isDev = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const ASSETS_DIR = path.join(ROOT, 'assets', 'mosslauncher-complete');
const START_URL = `${appProtocol.SCHEME}://${appProtocol.HOST}/index.html`;

let mainWindow = null;

appProtocol.registerScheme();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#101612',
    title: 'MossLauncher',
    icon: path.join(ASSETS_DIR, 'branding', 'app-icon@4x.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadURL(START_URL);
  attachWindow(win);

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    log.info('window', 'ready');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    appProtocol.handle(RENDERER_DIR, ASSETS_DIR);
    log.info('app', `starting electron ${process.versions.electron}, node ${process.versions.node}`);

    ensureDir(PATHS.userData);
    ensureDir(PATHS.logsDir);
    ensureDir(PATHS.cacheDir);
    ensureDir(PATHS.runtimesDir);
    ensureDir(settingsMod.getSettings().gameDir || PATHS.defaultGameDir);

    mainWindow = createWindow();
    ipc.register(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      mainWindow = createWindow();
      ipc.register(mainWindow);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { createWindow, START_URL };