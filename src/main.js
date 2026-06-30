cd ~/Downloads/show-dashboard-app
cat > src/main.js << 'EOF'
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let serverProcess = null;
const SERVER_PORT = 3000;

function startServer() {
  try {
    process.env.PORT = SERVER_PORT;
    require('../server.js');
    console.log('[App] Server started on port', SERVER_PORT);
  } catch(e) { console.error('[App] Server error:', e.message); }
}

function waitForServer(callback, attempts = 0) {
  if (attempts > 30) { callback(false); return; }
  http.get(`http://localhost:${SERVER_PORT}/auth/status`, () => callback(true))
    .on('error', () => setTimeout(() => waitForServer(callback, attempts + 1), 300));
}

let displayWin = null, editorWin = null, tray = null;

function createDisplayWindow() {
  displayWin = new BrowserWindow({ width:1920, height:1080, title:'Show Dashboard — Display', backgroundColor:'#0a0a0a', webPreferences:{nodeIntegration:false,contextIsolation:true} });
  displayWin.loadURL(`http://localhost:${SERVER_PORT}/display`);
  displayWin.on('closed', () => { displayWin = null; });
}

function createEditorWindow() {
  editorWin = new BrowserWindow({ width:1400, height:900, title:'Show Dashboard — Editor', backgroundColor:'#0a0a0a', webPreferences:{nodeIntegration:false,contextIsolation:true} });
  editorWin.loadURL(`http://localhost:${SERVER_PORT}/edit`);
  editorWin.on('closed', () => { editorWin = null; });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Show Dashboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'Show Dashboard', enabled:false },
    { type:'separator' },
    { label:'Open Display', click:()=>{ if(displayWin)displayWin.focus(); else createDisplayWindow(); } },
    { label:'Open Editor',  click:()=>{ if(editorWin)editorWin.focus();  else createEditorWindow(); } },
    { type:'separator' },
    { label:'Open in Browser', submenu:[
      { label:'Display', click:()=>shell.openExternal(`http://localhost:${SERVER_PORT}/display`) },
      { label:'Editor',  click:()=>shell.openExternal(`http://localhost:${SERVER_PORT}/edit`) },
    ]},
    { type:'separator' },
    { label:'Check for Updates', click:()=>autoUpdater.checkForUpdates() },
    { type:'separator' },
    { label:'Quit Show Dashboard', click:()=>app.quit() }
  ]));
  tray.on('click', ()=>{ if(editorWin)editorWin.focus(); else createEditorWindow(); });
}

function setupAutoUpdater() {
  autoUpdater.setFeedURL({ provider:'github', owner:'rjeemerick-eng', repo:'show-dashboard' });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 1 * 60 * 1000);

  autoUpdater.on('update-available', (info) => {
    const win = editorWin || displayWin;
    if (win) win.webContents.executeJavaScript(`
      (function(){
        if(document.getElementById('__ub')) return;
        const b=document.createElement('div');
        b.id='__ub';
        b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1f2e;border-bottom:1px solid rgba(55,138,221,0.5);padding:10px 20px;display:flex;align-items:center;gap:10px;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef';
        b.innerHTML='<span style="color:#7eb8f5;font-weight:600">⬆ Update v${info.version} available</span><span style="color:rgba(255,255,255,0.4)">Downloading in background…</span>';
        document.body.prepend(b);
      })()
    `).catch(()=>{});
  });

  autoUpdater.on('update-downloaded', (info) => {
    [editorWin, displayWin].filter(Boolean).forEach(win => {
      win.webContents.executeJavaScript(`
        (function(){
          const old=document.getElementById('__ub'); if(old) old.remove();
          const b=document.createElement('div');
          b.id='__ub';
          b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;background:#0f1923;border-bottom:2px solid rgba(55,138,221,0.7);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;font-family:Inter,system-ui,sans-serif;font-size:13px;color:#e8e9ef;gap:16px';
          b.innerHTML='<div style="display:flex;align-items:center;gap:10px"><span style="font-size:18px">⬆</span><div><div style="font-weight:700;color:#7eb8f5">Update v${info.version} ready</div><div style="font-size:11px;color:rgba(255,255,255,0.4)">App will restart to apply update</div></div></div><div style="display:flex;gap:8px"><button onclick="this.closest(\'#__ub\').remove()" style="padding:6px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:rgba(255,255,255,0.5);cursor:pointer;font-size:12px;font-family:inherit">Skip for now</button><button onclick="fetch(\'/api/install-update\',{method:\'POST\'})" style="padding:6px 16px;border-radius:7px;border:none;background:#378ADD;color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Restart & install</button></div>';
          document.body.prepend(b);
        })()
      `).catch(()=>{});
    });
    if (tray) tray.setContextMenu(Menu.buildFromTemplate([
      { label:`✦ Update v${info.version} ready — click to install`, click:()=>autoUpdater.quitAndInstall() },
      { type:'separator' },
      { label:'Open Editor', click:()=>{ if(editorWin)editorWin.focus(); else createEditorWindow(); } },
      { type:'separator' },
      { label:'Quit', click:()=>app.quit() }
    ]));
  });

  autoUpdater.on('error', (err) => console.error('[Updater]', err.message));
}

app.whenReady().then(() => {
  startServer();
  waitForServer((ready) => {
    if (!ready) { console.error('[App] Server did not start'); return; }
    createEditorWindow();
    createDisplayWindow();
    createTray();
    setupAutoUpdater();
  });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('second-instance', () => { if(editorWin){editorWin.restore();editorWin.focus();} else createEditorWindow(); });
app.on('activate', () => { if(!editorWin) createEditorWindow(); });
EOF
git add src/main.js
git commit -m "1-min update check, install prompt"
git tag v1.0.18
git push && git push origin v1.0.18