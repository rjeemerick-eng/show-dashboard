const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

const SERVER_PORT = 3000;

function startServer() {
  try {
    process.env.PORT = SERVER_PORT;
    require('../server.js');
    console.log('[App] Server started on port', SERVER_PORT);
  } catch(e) { console.error('[App] Server error:', e.message); }
}

function waitForServer(callback, attempts) {
  attempts = attempts || 0;
  if (attempts > 30) { callback(false); return; }
  http.get('http://localhost:' + SERVER_PORT + '/auth/status', function() {
    callback(true);
  }).on('error', function() {
    setTimeout(function() { waitForServer(callback, attempts + 1); }, 300);
  });
}

var displayWin = null;
var editorWin  = null;
var tray       = null;

function createDisplayWindow() {
  displayWin = new BrowserWindow({
    width: 1920, height: 1080,
    title: 'Show Dashboard — Display',
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  displayWin.loadURL('http://localhost:' + SERVER_PORT + '/display');
  displayWin.on('closed', function() { displayWin = null; });
}

function createEditorWindow() {
  editorWin = new BrowserWindow({
    width: 1400, height: 900,
    title: 'Show Dashboard — Editor',
    backgroundColor: '#0a0a0a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  editorWin.loadURL('http://localhost:' + SERVER_PORT + '/edit');
  editorWin.on('closed', function() { editorWin = null; });
}

function createTray() {
  var icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Show Dashboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Dashboard', enabled: false },
    { type: 'separator' },
    { label: 'Open Display', click: function() { if(displayWin) displayWin.focus(); else createDisplayWindow(); } },
    { label: 'Open Editor',  click: function() { if(editorWin)  editorWin.focus();  else createEditorWindow(); } },
    { type: 'separator' },
    { label: 'Open in Browser', submenu: [
      { label: 'Display', click: function() { shell.openExternal('http://localhost:' + SERVER_PORT + '/display'); } },
      { label: 'Editor',  click: function() { shell.openExternal('http://localhost:' + SERVER_PORT + '/edit'); } }
    ]},
    { type: 'separator' },
    { label: 'Check for Updates', click: function() { autoUpdater.checkForUpdates(); } },
    { type: 'separator' },
    { label: 'Quit', click: function() { app.quit(); } }
  ]));
  tray.on('click', function() { if(editorWin) editorWin.focus(); else createEditorWindow(); });
}

function inject(code) {
  var wins = [editorWin, displayWin].filter(Boolean);
  wins.forEach(function(win) {
    win.webContents.executeJavaScript(code).catch(function() {});
  });
}

function setupAutoUpdater() {
  autoUpdater.logger = require('electron-log');
  autoUpdater.logger.transports.file.level = 'info';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'rjeemerick-eng',
    repo: 'show-dashboard'
  });

  autoUpdater.checkForUpdates();
  setInterval(function() { autoUpdater.checkForUpdates(); }, 60 * 1000);
  setInterval(function() {
    if (global.triggerUpdateCheck) {
      global.triggerUpdateCheck = false;
      autoUpdater.checkForUpdates();
    }
  }, 2000);

  autoUpdater.on('checking-for-update', function() {
    console.log('[Updater] Checking for update...');
  });

  autoUpdater.on('update-available', function(info) {
    console.log('[Updater] Update available:', info.version);
    inject(
      '(function(){' +
      'var b=document.getElementById("__ub");' +
      'if(!b){b=document.createElement("div");b.id="__ub";document.body.prepend(b);}' +
      'b.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1f2e;border-bottom:1px solid rgba(55,138,221,0.5);padding:10px 20px;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef";' +
      'b.innerHTML="<div style=\'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px\'><span style=\'color:#7eb8f5;font-weight:600\'>Update v' + info.version + ' available — downloading</span><span id=\'__ub-pct\' style=\'color:rgba(255,255,255,0.5);font-size:11px\'>0%</span></div><div style=\'height:4px;background:rgba(255,255,255,0.1);border-radius:2px\'><div id=\'__ub-bar\' style=\'height:100%;width:0%;background:#378ADD;border-radius:2px;transition:width 0.5s\'></div></div>";' +
      '})()'
    );
  });

  autoUpdater.on('download-progress', function(progress) {
    var pct = Math.round(progress.percent);
    console.log('[Updater] Download progress:', pct + '%');
    inject(
      '(function(){' +
      'var bar=document.getElementById("__ub-bar");' +
      'var pctEl=document.getElementById("__ub-pct");' +
      'if(bar) bar.style.width="' + pct + '%";' +
      'if(pctEl) pctEl.textContent="' + pct + '%";' +
      '})()'
    );
  });

  autoUpdater.on('update-downloaded', function(info) {
    console.log('[Updater] Update downloaded:', info.version);
    inject(
      '(function(){' +
      'var old=document.getElementById("__ub");if(old)old.remove();' +
      'var b=document.createElement("div");b.id="__ub";' +
      'b.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99999;background:#0f1923;border-bottom:2px solid rgba(55,138,221,0.7);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef;gap:16px";' +
      'b.innerHTML="<div style=\'display:flex;align-items:center;gap:10px\'><span style=\'font-size:18px\'>⬆</span><div><div style=\'font-weight:700;color:#7eb8f5\'>Update v' + info.version + ' ready</div><div style=\'font-size:11px;color:rgba(255,255,255,0.4)\'>App will restart to apply</div></div></div><div style=\'display:flex;gap:8px\'><button onclick=\'this.parentNode.parentNode.remove()\' style=\'padding:6px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:rgba(255,255,255,0.5);cursor:pointer;font-size:12px\'>Skip</button><button onclick=\'fetch(String.fromCharCode(47,97,112,105,47,105,110,115,116,97,108,108,45,117,112,100,97,116,101),{method:\"POST\"})\' style=\'padding:6px 16px;border-radius:7px;border:none;background:#378ADD;color:#fff;cursor:pointer;font-size:12px;font-weight:600\'>Restart and install</button></div>";' +
      'document.body.prepend(b);' +
      '})()'
    );
    if (tray) {
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Update v' + info.version + ' ready — click to install', click: function() { autoUpdater.quitAndInstall(); } },
        { type: 'separator' },
        { label: 'Open Editor', click: function() { if(editorWin) editorWin.focus(); else createEditorWindow(); } },
        { type: 'separator' },
        { label: 'Quit', click: function() { app.quit(); } }
      ]));
    }
  });

  autoUpdater.on('update-not-available', function() {
    console.log('[Updater] Up to date');
  });

  autoUpdater.on('error', function(err) {
    console.error('[Updater] Error:', err.message);
  });
}

app.whenReady().then(function() {
  startServer();
  waitForServer(function(ready) {
    if (!ready) { console.error('[App] Server did not start'); return; }
    createEditorWindow();
    createDisplayWindow();
    createTray();
    setupAutoUpdater();
  });
});

app.on('window-all-closed', function(e) { e.preventDefault(); });
app.on('second-instance', function() { if(editorWin){ editorWin.restore(); editorWin.focus(); } else createEditorWindow(); });
app.on('activate', function() { if(!editorWin) createEditorWindow(); });
