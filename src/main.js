const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');

// ── Keep single instance ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ── Start the embedded server ──────────────────────────────────────────────────
let serverProcess = null;
const SERVER_PORT = 3000;

function startServer() {
  // Run server.js in the same process using require
  try {
    process.env.PORT = SERVER_PORT;
    require('../server.js');
    console.log('[App] Dashboard server started on port', SERVER_PORT);
  } catch(e) {
    console.error('[App] Server start error:', e.message);
  }
}

// Wait for server to be ready
function waitForServer(callback, attempts = 0) {
  if (attempts > 30) { callback(false); return; }
  http.get(`http://localhost:${SERVER_PORT}/auth/status`, () => {
    callback(true);
  }).on('error', () => {
    setTimeout(() => waitForServer(callback, attempts + 1), 300);
  });
}

// ── Windows ────────────────────────────────────────────────────────────────────
let displayWin = null;
let editorWin  = null;
let tray       = null;

function createDisplayWindow() {
  displayWin = new BrowserWindow({
    width: 1920, height: 1080,
    title: 'Show Dashboard — Display',
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  displayWin.loadURL(`http://localhost:${SERVER_PORT}/display`);
  displayWin.on('closed', () => { displayWin = null; });
}

function createEditorWindow() {
  editorWin = new BrowserWindow({
    width: 1400, height: 900,
    title: 'Show Dashboard — Editor',
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  editorWin.loadURL(`http://localhost:${SERVER_PORT}/edit`);
  editorWin.on('closed', () => { editorWin = null; });
}

function createTray() {
  // Use a simple template image (shown in menu bar)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  function buildMenu() {
    return Menu.buildFromTemplate([
      { label: 'Show Dashboard', enabled: false },
      { type: 'separator' },
      {
        label: 'Open Display',
        click: () => {
          if (displayWin) displayWin.focus();
          else createDisplayWindow();
        }
      },
      {
        label: 'Open Editor',
        click: () => {
          if (editorWin) editorWin.focus();
          else createEditorWindow();
        }
      },
      { type: 'separator' },
      {
        label: 'Open in Browser',
        submenu: [
          { label: 'Display', click: () => shell.openExternal(`http://localhost:${SERVER_PORT}/display`) },
          { label: 'Editor',  click: () => shell.openExternal(`http://localhost:${SERVER_PORT}/edit`) },
        ]
      },
      { type: 'separator' },
      { label: 'Check for Updates', click: () => autoUpdater.checkForUpdates() },
      { type: 'separator' },
      { label: 'Quit Show Dashboard', click: () => app.quit() }
    ]);
  }

  tray.setToolTip('Show Dashboard');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (editorWin) editorWin.focus();
    else createEditorWindow();
  });
}

// ── Auto updater ───────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'rjeemerick-eng',
    repo: 'show-dashboard',
  });

  autoUpdater.checkForUpdatesAndNotify();

  // Check every 30 minutes
  setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);

  autoUpdater.on('update-available', () => {
    console.log('[Updater] Update available — downloading…');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    // Show notification via tray
    if (tray) {
      tray.setContextMenu(Menu.buildFromTemplate([
        {
          label: `✦ Update to v${info.version} ready — click to restart`,
          click: () => autoUpdater.quitAndInstall()
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ]));
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Start embedded server
  startServer();

  // Wait for server then open windows
  waitForServer((ready) => {
    if (!ready) {
      console.error('[App] Server did not start in time');
      return;
    }
    createEditorWindow();
    createDisplayWindow();
    createTray();
    setupAutoUpdater();
  });
});

app.on('window-all-closed', (e) => {
  // Keep app running in tray even with no windows
  e.preventDefault();
});

app.on('second-instance', () => {
  if (editorWin) { editorWin.restore(); editorWin.focus(); }
  else createEditorWindow();
});

app.on('activate', () => {
  if (!editorWin) createEditorWindow();
});
