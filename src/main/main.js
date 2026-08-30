'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage
} = require('electron');

const { Store } = require('./store');
const { Watchdog } = require('./watchdog');
const paths = require('./paths');

let mainWindow = null;
let tray = null;
let store = null;
let watchdog = null;
let quitting = false;

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

// A single instance only: two copies would fight over the same
// emulators, force-stopping Roblox while the other is mid-launch.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'MuMu Reconnect',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    // Closing the window while the watchdog is running would silently
    // stop everyone's games from being watched, so hide instead.
    if (!quitting && store.getGeneral().minimizeToTray && watchdog.running) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage
    .createFromPath(ICON_PATH)
    .resize({ width: 16, height: 16 });

  try {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch (err) {
    return;
  }

  tray.setToolTip('MuMu Reconnect');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );

  tray.on('double-click', showWindow);
}

function wireWatchdog() {
  watchdog.on('log', (entry) => send('watchdog:log', entry));
  watchdog.on('instances', (list) => send('watchdog:instances', list));
  watchdog.on('status', (status) => send('watchdog:status', status));
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    status: watchdog.getStatus(),
    instances: watchdog.snapshot(),
    general: store.getGeneral(),
    logs: watchdog.history(),
    version: app.getVersion()
  }));

  ipcMain.handle('watchdog:start', () => watchdog.start());
  ipcMain.handle('watchdog:stop', () => watchdog.stop());

  ipcMain.handle('instance:save', (event, { key, patch }) => {
    const saved = store.setInstance(key, patch);
    watchdog.emitInstances();
    return saved;
  });

  ipcMain.handle('instance:reconnect', (event, serial) =>
    watchdog.reconnectNow(serial)
  );

  ipcMain.handle('settings:general', (event, patch) => {
    const saved = store.setGeneral(patch);
    watchdog.emitInstances();
    return saved;
  });

  ipcMain.handle('settings:mumuRoot', (event, root) => {
    store.setMuMuRoot(root);
    const status = watchdog.refreshPaths();
    watchdog.emitStatus();
    return status;
  });

  ipcMain.handle('settings:browseRoot', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your MuMuPlayer install folder',
      properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    const chosen = result.filePaths[0];

    if (!paths.isMuMuRoot(chosen)) {
      return { error: 'That folder does not contain MuMuPlayer 12.' };
    }

    store.setMuMuRoot(chosen);
    const status = watchdog.refreshPaths();
    watchdog.emitStatus();

    return status;
  });

  ipcMain.handle('app:openLogs', () => {
    shell.openPath(app.getPath('userData'));
  });

  ipcMain.handle('app:openExternal', (event, url) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  watchdog = new Watchdog(store, app.getPath('userData'));

  wireWatchdog();
  registerIpc();
  createWindow();
  createTray();

  if (store.getGeneral().autoStart) {
    await watchdog.start();
  }
});

app.on('before-quit', () => {
  quitting = true;

  if (watchdog) {
    watchdog.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
