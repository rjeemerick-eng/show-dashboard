const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');
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

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Check on launch, then every 5 minutes
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 1 * 60 * 1000);

  // Poll for manual check requests from the browser UI
  setInterval(() => {
    if (global.triggerUpdateCheck) {
      global.triggerUpdateCheck = false;
      console.log('[Updater] Manual check triggered');
      autoUpdater.checkForUpdates();
    }
  }, 2000);

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    const win = editorWin || displayWin;
    if (win) win.webContents.executeJavaScript(`
      (function(){
        if(document.getElementById('__ub')) return;
        const b=document.createElement('div');
        b.id='__ub';
        b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1f2e;border-bottom:1px solid rgba(55,138,221,0.5);padding:10px 20px;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef';
        b.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="color:#7eb8f5;font-weight:600">⬆ Update v${info.version} — downloading</span><span id="__ub-pct" style="color:rgba(255,255,255,0.5);font-size:11px">0%</span></div><div style="height:3px;background:rgba(255,255,255,0.1);border-radius:2px"><div id="__ub-bar" style="height:100%;width:0%;background:#378ADD;border-radius:2px;transition:width 0.3s"></div></div>';
        document.body.prepend(b);
      })()
    `).catch(()=>{});
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    const win = editorWin || displayWin;
    if (win) win.webContents.executeJavaScript(`
      (function(){
        const bar=document.getElementById('__ub-bar');
        const pctEl=document.getElementById('__ub-pct');
        if(bar) bar.style.width='${pct}%';
        if(pctEl) pctEl.textContent='${pct}%';
      })()
    `).catch(()=>{});
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    // Show install prompt in all windows
    [editorWin, displayWin].filter(Boolean).forEach(win => {
      win.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('__update-banner');
          if (existing) existing.remove();
          const banner = document.createElement('div');
          banner.id = '__update-banner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0f1923;border-bottom:2px solid rgba(55,138,221,0.7);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef;gap:16px';
          banner.innerHTML = \`
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:16px">⬆</span>
              <div>
                <div style="font-weight:700;color:#7eb8f5">Update v${info.version} ready to install</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:1px">The app will restart to apply the update.</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button onclick="this.closest('#__update-banner').remove()" style="padding:6px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:rgba(255,255,255,0.5);cursor:pointer;font-size:12px;font-family:inherit">Skip for now</button>
              <button onclick="window.__installUpdate && window.__installUpdate()" style="padding:6px 16px;border-radius:7px;border:none;background:#378ADD;color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Restart & install</button>
            </div>
          \`;
          document.body.prepend(banner);
          window.__installUpdate = () => { banner.innerHTML = '<div style=\"padding:0 20px;color:#7eb8f5\">Restarting…</div>'; fetch('/api/install-update', {method:\'POST\'}); };
        })()
      `).catch(() => {});
    });

    // tray menu update
    if (tray) {
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `✦ Update v${info.version} ready — Restart & install`, click: () => autoUpdater.quitAndInstall() },
        { type: 'separator' },
        { label: 'Open Editor', click: () => { if(editorWin)editorWin.focus(); else createEditorWindow(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ]));
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] Up to date');
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────app.whenReady().then(() => {
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
