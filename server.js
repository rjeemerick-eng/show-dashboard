const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Load local config if present — check home dir first (writable), then app dir
let localConfig = {};
try {
  const os = require('os');
  const homeCfg = require('path').join(os.homedir(), '.show-dashboard-config.js');
  if (require('fs').existsSync(homeCfg)) {
    localConfig = require(homeCfg);
    console.log('[Config] Loaded from home dir');
  } else {
    localConfig = require('./config.js');
  }
} catch(e) {}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
// ─── Persistent data directory ────────────────────────────────────────────────
// Data lives in the user's home folder so it SURVIVES app updates.
// (Files inside the app bundle are wiped every time the app is replaced.)
const os = require('os');
// Overridable for tests so a scratch dir can stand in for real user data
const DATA_DIR = process.env.SHOW_DASH_DATA_DIR || path.join(os.homedir(), '.show-dashboard');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}

const PLAYLIST_FILE = path.join(DATA_DIR, 'playlist.json');
const TAGS_FILE    = path.join(DATA_DIR, 'tags.json');
const PEOPLE_FILE  = path.join(DATA_DIR, 'people.json');
const RULES_FILE   = path.join(DATA_DIR, 'rules.json');

const STATE_FILE = path.join(DATA_DIR, 'state.json');
let _stateSaveTimer = null;
function saveStateNow() {
  _stateSaveTimer = null;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch(e) { console.error('[State] Save error:', e.message); }
}
function saveStateSoon() {
  if (_stateSaveTimer) return;
  _stateSaveTimer = setTimeout(saveStateNow, 500);
}
// Flush a pending debounced save on shutdown so an edit made just before
// quitting isn't lost. Only fires when a save is actually pending — never
// writes default state over a good state.json during a startup crash.
process.on('exit', () => {
  if (_stateSaveTimer) { clearTimeout(_stateSaveTimer); saveStateNow(); }
});

// One-time migration: copy any data saved by older versions (inside the app
// folder) into the home directory, without overwriting newer home-dir data.
['playlist.json','tags.json','people.json','rules.json'].forEach(f => {
  try {
    const oldPath = path.join(__dirname, f);
    const newPath = path.join(DATA_DIR, f);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.copyFileSync(oldPath, newPath);
      console.log('[Data] Migrated', f, 'to', DATA_DIR);
    }
  } catch(e) {}
});

// ─── Playlist (persisted to disk) ────────────────────────────────────────────
let playlist = []; // [{id, name, createdAt, state}]
let activeServiceId = null;

function loadPlaylist() {
  try {
    if (fs.existsSync(PLAYLIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
      playlist = data.playlist || [];
      activeServiceId = data.activeServiceId || null;
      // Restore the active service's state into memory
      if (activeServiceId) {
        const active = playlist.find(s => s.id === activeServiceId);
        if (active && active.state) {
          state = active.state;
          console.log(`[Playlist] Restored active service: "${active.name}"`);
        }
      }
      console.log(`[Playlist] Loaded ${playlist.length} services`);
    }
  } catch(e) { console.error('[Playlist] Load error:', e.message); }
}

function savePlaylist() {
  try {
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify({ playlist, activeServiceId }, null, 2));
  } catch(e) { console.error('[Playlist] Save error:', e.message); }
}

// ─── Name tags ────────────────────────────────────────────────────────────────
// Tags are part of a person's profile in the people library (defaultIemSlot /
// defaultProdPosition / photo). The tag API keeps its old response shape as a
// live view over people so clients and old backups keep working.
// iemSlot/micSlot = index into state.iems/mics (0-based), prodPosition = 'foh' etc.
function tagsView() {
  const t = {};
  people.forEach(p => {
    if (p.defaultIemSlot != null || p.defaultProdPosition) {
      t[p.name] = {
        iemSlot: p.defaultIemSlot ?? null,
        micSlot: p.defaultIemSlot ?? null, // mic mirrors the IEM slot
        prodPosition: p.defaultProdPosition || null,
        photo: p.photo || ''
      };
    }
  });
  return t;
}

// One-time migration: fold legacy tags.json into people profiles. Existing
// people keep their own values; tags only fill gaps or add missing people.
// The file is renamed .migrated afterwards so this never runs twice.
function migrateLegacyTags() {
  try {
    if (!fs.existsSync(TAGS_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    let n = 0;
    Object.entries(legacy).forEach(([name, t]) => {
      const p = people.find(x => x.name === name);
      if (p) {
        if (p.defaultIemSlot == null && t.iemSlot != null) { p.defaultIemSlot = t.iemSlot; n++; }
        if (!p.defaultProdPosition && t.prodPosition) { p.defaultProdPosition = t.prodPosition; n++; }
        if (!p.photo && t.photo) { p.photo = t.photo; n++; }
      } else {
        people.push({ id: 'person_' + Date.now() + '_' + people.length, name, photo: t.photo || '',
          defaultIemSlot: t.iemSlot ?? null, defaultProdPosition: t.prodPosition || null, notes: '' });
        n++;
      }
    });
    if (n) savePeople();
    fs.renameSync(TAGS_FILE, TAGS_FILE + '.migrated');
    console.log(`[Tags] Migrated legacy tags.json into people library (${n} fields)`);
  } catch(e) { console.error('[Tags] Migration error:', e.message); }
}

// ─── People library (persisted) ───────────────────────────────────────────────
// [{id, name, photo, defaultIemSlot, defaultProdPosition, notes}]
let people = [];
function loadPeople() {
  try {
    if (fs.existsSync(PEOPLE_FILE)) {
      people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
      console.log(`[People] Loaded ${people.length} people`);
    }
  } catch(e) { console.error('[People] Load error:', e.message); }
}
function savePeople() {
  try { fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people, null, 2)); }
  catch(e) { console.error('[People] Save error:', e.message); }
}
loadPeople();
migrateLegacyTags();

// ─── Conflict rules (persisted) ───────────────────────────────────────────────
// [{id, name, ifPerson, ifSlotType, ifSlot, thenPerson, thenSlotType, thenSlot}]
// "If [ifPerson] is scheduled on [ifSlotType] [ifSlot], move [thenPerson] to [thenSlotType] [thenSlot]"
let rules = [];
function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      console.log(`[Rules] Loaded ${rules.length} conflict rules`);
    }
  } catch(e) { console.error('[Rules] Load error:', e.message); }
}
function saveRules() {
  try { fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2)); }
  catch(e) { console.error('[Rules] Save error:', e.message); }
}
loadRules();

// ─── Default state ────────────────────────────────────────────────────────────
let state = {
  serviceName: 'Sunday service',
  mics: [
    { id: 'm1', ch: 1, role: 'Drums',  name: '',      type: 'Lavalier',  freq: '614.125', status: 'na', bat: null, photo: '' },
    { id: 'm2', ch: 2, role: 'Bass',   name: '',    type: 'Belt pack', freq: '614.800', status: 'na', bat: null, photo: '' },
    { id: 'm3', ch: 3, role: 'Gtr 1',  name: '',     type: 'Belt pack', freq: '615.475', status: 'na', bat: null, photo: '' },
    { id: 'm4', ch: 4, role: 'Gtr 2',  name: '',    type: 'Belt pack', freq: '616.150', status: 'na', bat: null, photo: '' },
    { id: 'm5', ch: 5, role: 'Keys 1', name: '',    type: 'Belt pack', freq: '616.825', status: 'na', bat: null, photo: '' },
    { id: 'm6', ch: 6, role: 'Keys 2', name: '',    type: 'Belt pack', freq: '617.500', status: 'na', bat: null, photo: '' },
    { id: 'm7', ch: 7, role: 'Vox 1',  name: '',          type: 'Handheld',  freq: '618.175', status: 'na',     bat: null, photo: '' },
    { id: 'm8', ch: 8, role: 'Vox 2',  name: '',    type: 'Handheld',  freq: '618.850', status: 'na', bat: null, photo: '' },
    { id: 'm9', ch: 9, role: 'Vox 3',  name: '',   type: 'Handheld',  freq: '619.525', status: 'na', bat: null, photo: '' },
    { id: 'm10',ch:10, role: 'Vox 4',  name: '', type: 'Handheld',  freq: '620.200', status: 'na', bat: null, photo: '' },
    { id: 'm11',ch:11, role: 'Vox 5',  name: '', type: 'Handheld',  freq: '620.875', status: 'na', bat: null, photo: '' },
    { id: 'm12',ch:12, role: 'Vox 6',  name: '',          type: 'Handheld',  freq: '',        status: 'na',     bat: null, photo: '' },
  ],
  iems: [
    { id: 'i1', ch: 1, role: 'Drums',  name: '',      mix: '', freq: '566.000', status: 'na', bat: null, photo: '' },
    { id: 'i2', ch: 2, role: 'Bass',   name: '',    mix: '',  freq: '566.600', status: 'na', bat: null, photo: '' },
    { id: 'i3', ch: 3, role: 'Gtr 1',  name: '',     mix: '',  freq: '567.200', status: 'na', bat: null, photo: '' },
    { id: 'i4', ch: 4, role: 'Gtr 2',  name: '',    mix: '',  freq: '567.800', status: 'na', bat: null, photo: '' },
    { id: 'i5', ch: 5, role: 'Keys 1', name: '',    mix: '',  freq: '568.400', status: 'na', bat: null, photo: '' },
    { id: 'i6', ch: 6, role: 'Keys 2', name: '',    mix: '',  freq: '569.000', status: 'na', bat: null, photo: '' },
    { id: 'i7', ch: 7, role: 'Vox 1',  name: '',          mix: '',          freq: '',        status: 'na',     bat: null, photo: '' },
    { id: 'i8', ch: 8, role: 'Vox 2',  name: '',    mix: '',   freq: '569.600', status: 'na', bat: null, photo: '' },
    { id: 'i9', ch: 9, role: 'Vox 3',  name: '',   mix: '',   freq: '570.200', status: 'na', bat: null, photo: '' },
    { id: 'i10',ch:10, role: 'Vox 4',  name: '', mix: '',   freq: '570.800', status: 'na', bat: null, photo: '' },
    { id: 'i11',ch:11, role: 'Vox 5',  name: '', mix: '',   freq: '571.400', status: 'na', bat: null, photo: '' },
    { id: 'i12',ch:12, role: 'Vox 6',  name: '',          mix: '',          freq: '',        status: 'na',     bat: null, photo: '' },
    { id: 'i13',ch:13, role: 'Vox 7',  name: '',          mix: '',          freq: '',        status: 'na',     bat: null, photo: '' },
    { id: 'i14',ch:14, role: 'Vox 8',  name: '',          mix: '',          freq: '',        status: 'na',     bat: null, photo: '' },
  ],
  prod: [
    { id: 'p1', position: 'cg',    role: 'CG operator', name: '', note: '',  status: 'active', photo: '' },
    { id: 'p2',  position: 'cam', role: 'Camera 1', name: '', note: '',  status: 'active', photo: '' },
    { id: 'p3',  position: 'cam', role: 'Camera 2', name: '', note: '',   status: 'active', photo: '' },
    { id: 'p12', position: 'cam', role: 'Camera 3', name: '', note: '',             status: 'na',     photo: '' },
    { id: 'p13', position: 'cam', role: 'Camera 4', name: '', note: '',             status: 'na',     photo: '' },
    { id: 'p14', position: 'cam', role: 'Camera 5', name: '', note: '',             status: 'na',     photo: '' },
    { id: 'p15', position: 'cam', role: 'Camera 6', name: '', note: '',             status: 'na',     photo: '' },
    { id: 'p4', position: 'foh',   role: 'FOH',         name: '', note: '',      status: 'active', photo: '' },
    { id: 'p5', position: 'mon',   role: 'Monitors',    name: '', note: '',     status: 'na', photo: '' },
    { id: 'p6', position: 'light', role: 'Lighting',    name: '', note: '',     status: 'active', photo: '' },
    { id: 'p7', position: 'stage', role: 'Stage hand',  name: '', note: '', status: 'active', photo: '' },
    { id: 'p8', position: 'stage', role: 'Stage hand',  name: '', note: '', status: 'active', photo: '' },
    { id: 'p9',  position: 'dir',    role: 'Producer',       name: '', note: '', status: 'active', photo: '' },
    { id: 'p10', position: 'dir',    role: 'Video director', name: '', note: '', status: 'active', photo: '' },
    { id: 'p11', position: 'stream', role: 'Shader',         name: '', note: '', status: 'active', photo: '' },
  ]
};

// Restore active service state from playlist (must be after state declaration)
loadPlaylist();
// Restore last live board state (survives restarts). Takes precedence over
// the active playlist snapshot because it includes unsaved live changes.
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && saved.iems && saved.prod) {
      state = saved;
      console.log('[State] Restored last live state from disk');
    }
  }
} catch(e) { console.error('[State] Restore error:', e.message); }

// A state patch must be a plain object — spreading a string/array/null into
// state would scatter numeric keys through it and corrupt the board.
// If the slot arrays are present they must actually be arrays.
function isStatePatch(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const k of ['iems', 'mics', 'prod', 'ros', 'roster']) {
    if (k in p && p[k] !== null && !Array.isArray(p[k])) return false;
  }
  return true;
}

// ─── Connected clients tracking ───────────────────────────────────────────────
const clients = new Set();

function broadcast(data, senderWs = null) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  clients.add(ws);
  const ip = req.socket.remoteAddress;
  console.log(`[+] Client connected: ${ip} (${clients.size} total)`);

  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'state', payload: state }));
  ws.send(JSON.stringify({ type: 'playlist', payload: { playlist: playlist.map(s=>({id:s.id,name:s.name,createdAt:s.createdAt,active:s.id===activeServiceId})), activeServiceId } }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // A throw here would take down the whole server — never trust client input
    try {
      if (msg.type === 'update' && isStatePatch(msg.payload)) {
        // Merge incoming state patch (last writer wins across editors)
        state = { ...state, ...msg.payload };
        saveStateSoon();
        // Broadcast to all OTHER clients
        broadcast({ type: 'state', payload: state }, ws);
        console.log(`[~] State updated by ${ip}`);
      }

      if (msg.type === 'wwb_update' && msg.payload) {
        // Battery / frequency push from WWB bridge
        const { id, arrayType, bat, freq } = msg.payload;
        const arr = arrayType === 'mic' ? state.mics : state.iems;
        const ch = arr.find(c => c.id === id);
        if (ch) {
          if (bat  !== undefined) ch.bat  = bat;
          if (freq !== undefined) ch.freq = freq;
          saveStateSoon();
        }
        broadcast({ type: 'state', payload: state }, ws);
      }
    } catch (e) {
      console.error(`[WS] Bad message from ${ip}:`, e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[-] Client disconnected (${clients.size} remaining)`);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve display page
app.get('/display', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'display.html')));

// Serve editor page
app.get('/edit', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'editor.html')));

// REST state endpoint (fallback for non-WS clients)
app.get('/api/state', (req, res) => res.json(state));
app.post('/api/state', (req, res) => {
  if (!isStatePatch(req.body)) return res.status(400).json({ error: 'state patch must be an object' });
  state = { ...state, ...req.body };
  saveStateSoon();
  broadcast({ type: 'state', payload: state });
  res.json({ ok: true });
});

// ─── Planning Center OAuth ────────────────────────────────────────────────────
const PCO_CLIENT_ID     = process.env.PCO_CLIENT_ID     || localConfig.PCO_CLIENT_ID     || '';
const PCO_CLIENT_SECRET = process.env.PCO_CLIENT_SECRET || localConfig.PCO_CLIENT_SECRET || '';
const PCO_REDIRECT_URI  = process.env.PCO_REDIRECT_URI  || localConfig.PCO_REDIRECT_URI  || 'http://localhost:3000/auth/callback';
const PCO_USE_PAT       = localConfig.PCO_USE_PAT || false;
const PCO_SCOPES        = 'services';

let pcoAccessToken  = null;
let pcoRefreshToken = null;
let pcoTokenExpiry  = null;

// If PAT is configured, mark as pre-authenticated
if (PCO_USE_PAT && PCO_CLIENT_ID && PCO_CLIENT_SECRET) {
  pcoAccessToken = '__PAT__'; // sentinel value
  console.log('[PCO] Personal Access Token mode — pre-authenticated');
}

function getPCOAuthHeader() {
  const id  = localConfig.PCO_CLIENT_ID     || PCO_CLIENT_ID;
  const sec = localConfig.PCO_CLIENT_SECRET || PCO_CLIENT_SECRET;
  if (id && sec) {
    return 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
  }
  return `Bearer ${pcoAccessToken}`;
}

// Step 1 — redirect user to PCO login
app.get('/auth/login', (req, res) => {
  if (!PCO_CLIENT_ID) return res.send('Set PCO_CLIENT_ID in your environment or config.js');
  const url = `https://api.planningcenteronline.com/oauth/authorize`
    + `?client_id=${PCO_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(PCO_REDIRECT_URI)}`
    + `&response_type=code`
    + `&scope=${PCO_SCOPES}`;
  res.redirect(url);
});

// Step 2 — PCO redirects back with ?code=...
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`PCO auth error: ${error || 'no code'}`);
  try {
    const https = require('https');
    const body  = JSON.stringify({
      grant_type:    'authorization_code',
      code,
      client_id:     PCO_CLIENT_ID,
      client_secret: PCO_CLIENT_SECRET,
      redirect_uri:  PCO_REDIRECT_URI,
    });
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'api.planningcenteronline.com',
        path: '/oauth/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(JSON.parse(d)));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });
    if (result.access_token) {
      pcoAccessToken  = result.access_token;
      pcoRefreshToken = result.refresh_token;
      pcoTokenExpiry  = Date.now() + (result.expires_in * 1000);
      console.log('[PCO] OAuth success — token stored');
      // Broadcast auth status to editor
      broadcast({ type: 'pco_auth', payload: { connected: true } });
      res.send('<script>window.close();opener.postMessage("pco_auth_done","*")</script>Connected! You can close this window.');
    } else {
      console.error('[PCO] Token error:', result);
      res.send('Auth failed: ' + JSON.stringify(result));
    }
  } catch (e) {
    res.send('Auth error: ' + e.message);
  }
});

// Auth status endpoint
app.get('/auth/status', (req, res) => {
  const id  = localConfig.PCO_CLIENT_ID  || PCO_CLIENT_ID;
  const sec = localConfig.PCO_CLIENT_SECRET || PCO_CLIENT_SECRET;
  const connected = !!(pcoAccessToken || (id && sec));
  res.json({ connected, pat: !!(localConfig.PCO_USE_PAT || PCO_USE_PAT), expiry: pcoTokenExpiry });
});

// Save PCO credentials at runtime (entered via UI)
app.post('/auth/credentials', (req, res) => {
  const { appId, token } = req.body;
  if (!appId || !token) return res.status(400).json({ error: 'Missing appId or token' });
  localConfig.PCO_CLIENT_ID     = appId.trim();
  localConfig.PCO_CLIENT_SECRET = token.trim();
  localConfig.PCO_USE_PAT       = true;
  pcoAccessToken = '__PAT__';

  // Save to writable location — works both in dev and inside packaged Electron (.asar is read-only)
  const os = require('os');
  const savePaths = [
    require('path').join(os.homedir(), '.show-dashboard-config.js'),
    require('path').join(__dirname, 'config.js'),
  ];
  const configContent = `module.exports = {\n  PCO_CLIENT_ID:     '${appId.trim()}',\n  PCO_CLIENT_SECRET: '${token.trim()}',\n  PCO_REDIRECT_URI:  'http://localhost:3000/auth/callback',\n  PCO_USE_PAT: true,\n};\n`;
  for (const p of savePaths) {
    try { require('fs').writeFileSync(p, configContent); console.log('[PCO] Saved to:', p); break; }
    catch(e) { console.warn('[PCO] Could not save to:', p); }
  }
  broadcast({ type: 'pco_auth', payload: { connected: true } });
  res.json({ ok: true });
});

// Disconnect PCO
app.post('/auth/disconnect', (req, res) => {
  pcoAccessToken = null;
  localConfig.PCO_CLIENT_ID = '';
  localConfig.PCO_CLIENT_SECRET = '';
  const configPath = require('path').join(__dirname, 'config.js');
  require('fs').writeFileSync(configPath, `module.exports = {\n  PCO_CLIENT_ID: '',\n  PCO_CLIENT_SECRET: '',\n  PCO_REDIRECT_URI: 'http://localhost:3000/auth/callback',\n  PCO_USE_PAT: false,\n};\n`);
  broadcast({ type: 'pco_auth', payload: { connected: false } });
  res.json({ ok: true });
});

// Token refresh helper
async function refreshPCOToken() {
  if (!pcoRefreshToken) return false;
  const https = require('https');
  const body  = JSON.stringify({
    grant_type:    'refresh_token',
    refresh_token: pcoRefreshToken,
    client_id:     PCO_CLIENT_ID,
    client_secret: PCO_CLIENT_SECRET,
  });
  const result = await new Promise((resolve, reject) => {
    const req2 = https.request({
      hostname: 'api.planningcenteronline.com',
      path: '/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(JSON.parse(d))); });
    req2.on('error', reject); req2.write(body); req2.end();
  });
  if (result.access_token) {
    pcoAccessToken  = result.access_token;
    pcoRefreshToken = result.refresh_token || pcoRefreshToken;
    pcoTokenExpiry  = Date.now() + (result.expires_in * 1000);
    return true;
  }
  return false;
}

// ─── Shared PCO GET helper (also used by the weekly auto-pull) ─────────────────
function pcoGet(pcoPath) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.planningcenteronline.com',
      path: pcoPath,
      headers: { 'Authorization': getPCOAuthHeader(), 'User-Agent': 'ShowDashboard/1.0', 'Accept': 'application/json' }
    }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('PCO returned non-JSON (' + r.statusCode + ')')); } });
    }).on('error', reject);
  });
}

// Fetch a plan's team members grouped by team, with photos
async function fetchPCORosterGrouped(typeId, planId) {
    // Fetch team members including team + person for photos
    const tmRes = await pcoGet(`/services/v2/service_types/${typeId}/plans/${planId}/team_members?per_page=100&include=team,person`);
    const members  = tmRes.data     || [];
    const included = tmRes.included || [];

    // Build team and photo lookups from included
    const teams = {};
    const personPhotos = {};
    included.forEach(item => {
      if (item.type === 'Team') {
        teams[item.id] = item.attributes.name;
      }
      if (item.type === 'Person') {
        const url = item.attributes.photo_thumbnail_url || item.attributes.avatar || '';
        // Skip default silhouette avatars
        if (url && !url.includes('silhouette') && !url.includes('default-')) {
          personPhotos[item.id] = url;
        }
      }
    });

    // Group by team, include photo
    const grouped = {};
    members.forEach(m => {
      const status   = m.attributes.status;
      if (status === 'D') return; // skip declined
      const name     = m.attributes.name;
      const teamId   = m.relationships?.team?.data?.id;
      const personId = m.relationships?.person?.data?.id;
      const teamName = teamId ? (teams[teamId] || 'Other') : 'Other';
      const position = m.attributes.team_position_name || teamName;
      const photo    = personId ? (personPhotos[personId] || '') : '';
      if (!grouped[teamName]) grouped[teamName] = [];
      grouped[teamName].push({ name, position, status, teamName, photo });
    });

    return { grouped, total: members.length };
}

// ─── Smart PCO roster endpoint — returns people keyed by position name ────────
app.get('/api/pco-roster', async (req, res) => {
  if (!pcoAccessToken) return res.status(401).json({ error: 'Not connected' });
  const { typeId, planId } = req.query;
  if (!typeId || !planId) return res.status(400).json({ error: 'Missing typeId or planId' });
  try {
    res.json(await fetchPCORosterGrouped(typeId, planId));
  } catch(e) {
    console.error('[PCO roster]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Planning Center proxy (avoids browser CORS block) ────────────────────────
app.get('/api/pco/*', async (req, res) => {
  // Refresh OAuth token if expiring soon (not needed for PAT mode)
  if (!PCO_USE_PAT && pcoAccessToken && pcoTokenExpiry && Date.now() > pcoTokenExpiry - 60000) {
    await refreshPCOToken();
  }
  if (!pcoAccessToken) return res.status(401).json({ error: 'Not authenticated with Planning Center. Click Login in the editor.' });

  const pcoPath = req.params[0];
  const qs = new URLSearchParams(req.query);
  const qsStr = qs.toString() ? '?' + qs.toString() : '';
  const fullPath = '/' + pcoPath + qsStr;
  console.log(`[PCO] GET https://api.planningcenteronline.com${fullPath}`);

  try {
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.planningcenteronline.com',
        path: fullPath,
        headers: {
          'Authorization': getPCOAuthHeader(),
          'User-Agent': 'ShowDashboard/1.0',
          'Accept': 'application/json'
        }
      }, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          console.log(`[PCO] Response: ${r.statusCode}`);
          if (r.statusCode !== 200) console.log(`[PCO] Body: ${data.slice(0, 300)}`);
          resolve({ status: r.statusCode, body: data });
        });
      }).on('error', reject);
    });
    res.status(result.status).set('Content-Type', 'application/json').send(result.body);
  } catch (e) {
    console.error('[PCO] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── People library endpoints ─────────────────────────────────────────────────
app.get('/api/people', (req, res) => res.json(people));

app.post('/api/people', (req, res) => {
  const { name, photo, defaultIemSlot, defaultProdPosition, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = people.findIndex(p => p.name === name);
  const person = { id: existing >= 0 ? people[existing].id : 'person_' + Date.now(), name, photo: photo||'', defaultIemSlot: defaultIemSlot??null, defaultProdPosition: defaultProdPosition||null, notes: notes||'' };
  if (existing >= 0) people[existing] = person;
  else people.push(person);
  savePeople();
  console.log(`[People] Saved: "${name}"`);
  res.json({ ok: true, person });
});

app.delete('/api/people/:id', (req, res) => {
  people = people.filter(p => p.id !== req.params.id);
  savePeople();
  res.json({ ok: true });
});

// ─── Conflict rules endpoints ─────────────────────────────────────────────────
app.get('/api/rules', (req, res) => res.json(rules));

app.post('/api/rules', (req, res) => {
  const rule = { id: 'rule_' + Date.now(), ...req.body };
  rules.push(rule);
  saveRules();
  res.json({ ok: true, rule });
});

app.delete('/api/rules/:id', (req, res) => {
  rules = rules.filter(r => r.id !== req.params.id);
  saveRules();
  res.json({ ok: true });
});

// Apply conflict rules to a state snapshot in place — returns the changelog
// (used by the REST endpoint and by the weekly auto-pull)
function applyRulesTo(s) {
  const changes = [];

  rules.forEach(rule => {
    // Check if the trigger person is scheduled
    const allSlots = [...s.iems, ...s.mics, ...s.prod];
    const triggerScheduled = allSlots.some(slot => slot.name === rule.ifPerson);
    if (!triggerScheduled) return;

    // Find where thenPerson currently is
    const getArr = (type) => type === 'iem' ? s.iems : type === 'mic' ? s.mics : s.prod;
    const thenArr = getArr(rule.thenSlotType);
    const currentSlot = thenArr.findIndex(slot => slot.name === rule.thenPerson);
    if (currentSlot === -1) return; // thenPerson not scheduled, skip

    // Find the target slot
    const targetIdx = rule.thenSlot; // 0-based index
    if (targetIdx === undefined || targetIdx === currentSlot) return;

    // Swap: move thenPerson to targetIdx, whoever is there goes to currentSlot
    const displaced = thenArr[targetIdx]?.name || '';
    const movedPerson = thenArr[currentSlot].name;

    thenArr[currentSlot].name = displaced;
    thenArr[targetIdx].name = movedPerson;

    // Fix photos
    const movedPhoto = thenArr[targetIdx].photo;
    const displacedPhoto = thenArr[currentSlot].photo;
    thenArr[targetIdx].photo = displacedPhoto || movedPhoto;
    thenArr[currentSlot].photo = '';

    changes.push(`Rule fired: "${rule.ifPerson}" scheduled → moved "${rule.thenPerson}" to ${rule.thenSlotType.toUpperCase()} ${targetIdx + 1}${displaced ? `, displaced "${displaced}"` : ''}`);
  });

  return changes;
}

// Apply conflict rules to a given state snapshot — returns modified state + changelog
app.post('/api/rules/apply', (req, res) => {
  const { state: s } = req.body;
  if (!s) return res.status(400).json({ error: 'state required' });
  const changes = applyRulesTo(s);
  res.json({ state: s, changes });
});

// ─── Name tags endpoints ──────────────────────────────────────────────────────

// Get all tags (derived live from people profiles)
app.get('/api/tags', (req, res) => res.json(tagsView()));

// Return all tagged people as a staging pool (so PCO pull is optional)
app.get('/api/tags/pool', (req, res) => {
  const pool = Object.entries(tagsView()).map(([name, t]) => ({
    name,
    photo: t.photo || '',
    position: t.prodPosition || '',
    teamName: '',
    iemSlot: t.iemSlot,
    prodPosition: t.prodPosition,
    fromTag: true
  }));
  res.json(pool);
});

// Set or update a tag — writes straight to the person's profile
app.post('/api/tags', (req, res) => {
  const { name, iemSlot, prodPosition, photo } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = people.findIndex(p => p.name === name);
  const prev = existing >= 0 ? people[existing] : null;
  const person = {
    id: prev ? prev.id : 'person_' + Date.now(),
    name,
    photo: photo || (prev ? prev.photo : '') || '',
    defaultIemSlot: iemSlot ?? null,
    defaultProdPosition: prodPosition || null,
    notes: prev ? prev.notes : ''
  };
  if (existing >= 0) people[existing] = person; else people.push(person);
  savePeople();
  console.log(`[Tags] Saved defaults on profile for "${name}"`);
  res.json({ ok: true });
});

// Delete a tag — clears the person's default slots but keeps their profile
app.delete('/api/tags/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const p = people.find(x => x.name === name);
  if (p) { p.defaultIemSlot = null; p.defaultProdPosition = null; savePeople(); }
  res.json({ ok: true });
});

// Apply tags to a roster — returns pre-filled assignments based on saved tags
app.post('/api/tags/apply', (req, res) => {
  const { roster } = req.body; // [{name, position, teamName, photo}]
  const iemAssign  = {};
  const prodAssign = {};
  const unmatched  = [];
  const tags = tagsView();

  roster.forEach(person => {
    const tag = tags[person.name];
    if (tag) {
      if (tag.iemSlot  !== undefined && tag.iemSlot  !== null) iemAssign[tag.iemSlot]   = person.name;
      if (tag.micSlot  !== undefined && tag.micSlot  !== null) iemAssign[tag.micSlot]   = person.name; // micSlot mirrors iem
      if (tag.prodPosition) {
        // find first prod slot of this position
        prodAssign[`pos:${tag.prodPosition}`] = person.name;
      }
    } else {
      unmatched.push(person.name);
    }
  });

  res.json({ iemAssign, prodAssign, unmatched });
});

// ─── Playlist endpoints ───────────────────────────────────────────────────────

// Get full playlist
app.get('/api/playlist', (req, res) => {
  res.json({
    playlist: playlist.map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, active: s.id === activeServiceId })),
    activeServiceId
  });
});

// Save current state as a new service
app.post('/api/playlist', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'svc_' + Date.now();
  // Snapshot the caller's state when provided (the editor sends its freshly
  // built board on PCO load, before any WS push lands) — else current state
  const src = isStatePatch(req.body.state) ? req.body.state : state;
  const snap = JSON.parse(JSON.stringify(src));
  snap.serviceName = name; // board title must match the service's playlist name
  playlist.push({ id, name, createdAt: new Date().toISOString(), state: snap });
  savePlaylist();
  broadcast({ type: 'playlist', payload: { playlist: playlist.map(s=>({id:s.id,name:s.name,createdAt:s.createdAt,active:s.id===activeServiceId})), activeServiceId } });
  res.json({ id, name });
});

// Update a service name
app.patch('/api/playlist/:id', (req, res) => {
  const svc = playlist.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) svc.name = req.body.name;
  // Optionally overwrite state with current
  if (req.body.saveCurrentState) svc.state = JSON.parse(JSON.stringify(state));
  // Or overwrite with a provided state (blank service, or editor re-load)
  if (req.body.blankState && isStatePatch(req.body.blankState)) svc.state = req.body.blankState;
  // Keep the snapshot's board title in sync with the playlist name
  if (svc.state) svc.state.serviceName = svc.name;
  savePlaylist();
  res.json({ ok: true });
});

// Delete a service
app.delete('/api/playlist/:id', (req, res) => {
  playlist = playlist.filter(s => s.id !== req.params.id);
  if (activeServiceId === req.params.id) activeServiceId = null;
  savePlaylist();
  broadcast({ type: 'playlist', payload: { playlist: playlist.map(s=>({id:s.id,name:s.name,createdAt:s.createdAt,active:s.id===activeServiceId})), activeServiceId } });
  res.json({ ok: true });
});

// Go live with a service (switches the active display state)
app.post('/api/playlist/:id/go-live', (req, res) => {
  const svc = playlist.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  state = JSON.parse(JSON.stringify(svc.state));
  state.serviceName = svc.name; // guarantee the live board title matches, even for old snapshots
  activeServiceId = svc.id;
  savePlaylist();
  saveStateSoon();
  broadcast({ type: 'state', payload: state });
  broadcast({ type: 'playlist', payload: { playlist: playlist.map(s=>({id:s.id,name:s.name,createdAt:s.createdAt,active:s.id===activeServiceId})), activeServiceId } });
  broadcast({ type: 'went_live', payload: { id: svc.id, name: svc.name } });
  console.log(`[Playlist] Now live: "${svc.name}"`);
  res.json({ ok: true, name: svc.name });
});

// Preview a service without going live (sends only to requesting client — editor uses REST)
app.get('/api/playlist/:id/preview', (req, res) => {
  const svc = playlist.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  res.json(svc.state);
});

// ─── Automatic weekly PCO pull ────────────────────────────────────────────────
// On a schedule (or the "Run now" button), pull the next upcoming plan for the
// configured service type, build the board exactly like a manual editor load
// (tags first, then auto-classification, then conflict rules), save it as a
// playlist entry named after the plan date, and optionally go live with it.
const AUTOPULL_FILE = path.join(DATA_DIR, 'autopull.json');
let autoPull = { enabled: false, typeId: '', typeName: '', day: 4, time: '09:00', goLive: true, lastRun: 0, lastResult: '' };
function loadAutoPull() {
  try { if (fs.existsSync(AUTOPULL_FILE)) autoPull = { ...autoPull, ...JSON.parse(fs.readFileSync(AUTOPULL_FILE, 'utf8')) }; }
  catch(e) { console.error('[AutoPull] Load error:', e.message); }
}
function saveAutoPull() {
  try { fs.writeFileSync(AUTOPULL_FILE, JSON.stringify(autoPull, null, 2)); } catch(e) {}
}
loadAutoPull();

// Classification — mirrors the editor's manual-load logic
const AP_POS_MAP = [
  {keys:['drum','perc'],type:'iem'},
  {keys:['bass'],type:'iem'},
  {keys:['guitar','gtr','electric'],type:'iem'},
  {keys:['keys','keyboard','piano'],type:'iem'},
  {keys:['vox','vocal','soprano','alto','tenor','lead','co-worship','worship leader'],type:'iem'},
  {keys:['cg','graphics','propresenter','media'],prod:'cg'},
  {keys:['camera','cam','video operator'],prod:'cam'},
  {keys:['foh','front of house','audio: foh','house'],prod:'foh'},
  {keys:['monitor','iem engineer','audio: monitor'],prod:'mon'},
  {keys:['light','lighting'],prod:'light'},
  {keys:['stage','stage hand'],prod:'stage'},
  {keys:['director','music director','worship pastor','producer'],prod:'dir'},
  {keys:['stream','shader','broadcast','online'],prod:'stream'},
];
const AP_IEM_HINTS = [
  {person:/drum|perc/, slot:/drum/},
  {person:/bass/, slot:/bass/},
  {person:/guitar|gtr|electric|acoustic/, slot:/gtr|guitar/},
  {person:/keys|keyboard|piano/, slot:/key/},
  {person:/vox|vocal|soprano|alto|tenor|singer|worship/, slot:/vox/},
];
function apClassify(person) {
  const team = (person.teamName || '').toLowerCase();
  if (/vocal|vox|singer|band/.test(team)) return { type: 'iem' };
  const pos = (person.position || person.teamName || '').toLowerCase();
  for (const rule of AP_POS_MAP) {
    if (rule.keys.some(k => pos.includes(k))) return rule.prod ? { type: 'prod', sub: rule.prod } : { type: 'iem' };
  }
  return { type: 'iem' };
}
function apPlaceIem(st, person) {
  if (!person.name) return;
  if ([...st.iems, ...st.mics, ...st.prod].some(c => c.name === person.name)) return;
  const key = ((person.position || '') + ' ' + (person.teamName || '')).toLowerCase();
  const hint = AP_IEM_HINTS.find(h => h.person.test(key));
  if (!hint) return;
  const idx = st.iems.findIndex(c => !c.name && hint.slot.test((c.role || '').toLowerCase()));
  if (idx === -1) return;
  const iem = st.iems[idx], mic = st.mics[idx];
  iem.name = person.name; iem.status = 'active'; if (person.photo) iem.photo = person.photo;
  if (mic && !mic.name) { mic.name = person.name; mic.status = 'active'; if (person.photo) mic.photo = person.photo; }
}

// Build a week's board state from a roster, using the current layout as template
function buildWeekState(planName, roster, ros) {
  const st = JSON.parse(JSON.stringify(state));
  st.serviceName = planName;
  st.iems.forEach(c => { c.name = ''; c.photo = ''; });
  st.mics.forEach(c => { c.name = ''; c.photo = ''; });
  st.prod.forEach(p => { p.name = ''; p.photo = ''; });
  if (ros) st.ros = ros;
  st.roster = roster.map(p => ({ name: p.name, photo: p.photo || '', position: p.position || '', teamName: p.teamName || '' }));
  const tags = tagsView();
  // Saved tags claim their slots first
  roster.forEach(person => {
    const tag = tags[person.name];
    if (!tag) return;
    if (tag.iemSlot != null) {
      const iem = st.iems[tag.iemSlot], mic = st.mics[tag.iemSlot];
      if (iem && !iem.name) { iem.name = person.name; iem.status = 'active'; if (person.photo) iem.photo = person.photo; }
      if (mic && !mic.name) { mic.name = person.name; mic.status = 'active'; if (person.photo) mic.photo = person.photo; }
    }
    if (tag.prodPosition) {
      const idx = st.prod.findIndex(p => p.position === tag.prodPosition && !p.name);
      if (idx !== -1) { st.prod[idx].name = person.name; st.prod[idx].status = 'active'; if (person.photo) st.prod[idx].photo = person.photo; }
    }
  });
  // Untagged people are auto-classified and placed
  roster.filter(p => !tags[p.name]).forEach(person => {
    const cls = apClassify(person);
    if (cls.type === 'prod') {
      const idx = st.prod.findIndex(p => p.position === cls.sub && !p.name);
      if (idx !== -1) { st.prod[idx].name = person.name; st.prod[idx].status = 'active'; if (person.photo) st.prod[idx].photo = person.photo; }
    } else {
      apPlaceIem(st, person);
    }
  });
  applyRulesTo(st);
  return st;
}

function playlistSummary() {
  return { playlist: playlist.map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, active: s.id === activeServiceId })), activeServiceId };
}

async function runAutoPull(trigger) {
  const fail = (msg) => {
    autoPull.lastResult = 'Error ' + new Date().toLocaleString() + ' — ' + msg;
    saveAutoPull();
    console.error('[AutoPull]', msg);
    return { error: msg };
  };
  if (!pcoAccessToken) return fail('Not connected to Planning Center');
  if (!autoPull.typeId) return fail('No service type configured');
  try {
    const plans = await pcoGet(`/services/v2/service_types/${autoPull.typeId}/plans?filter=future&per_page=1&order=sort_date`);
    const plan = plans.data && plans.data[0];
    if (!plan) return fail('No upcoming plan found');
    const planName = String(plan.attributes.dates || plan.attributes.title || plan.id).replace(/,\s*\d{4}\s*$/, '').trim();
    const { grouped } = await fetchPCORosterGrouped(autoPull.typeId, plan.id);
    const roster = [];
    Object.values(grouped).forEach(members => members.forEach(m => roster.push(m)));
    let ros = null;
    try {
      const items = await pcoGet(`/services/v2/service_types/${autoPull.typeId}/plans/${plan.id}/items?per_page=100`);
      if (items && items.data) ros = items.data.map(it => ({ type: (it.attributes.item_type || 'item').toLowerCase(), title: it.attributes.title || '', length: it.attributes.length || 0 }));
    } catch(e) { /* run of show is optional */ }
    const st = buildWeekState(planName, roster, ros);
    // Upsert the playlist entry by name — re-pulls update, never duplicate
    let svc = playlist.find(s => s.name === planName);
    if (svc) svc.state = st;
    else { svc = { id: 'svc_' + Date.now(), name: planName, createdAt: new Date().toISOString(), state: st }; playlist.push(svc); }
    if (autoPull.goLive) {
      state = JSON.parse(JSON.stringify(svc.state));
      state.serviceName = svc.name;
      activeServiceId = svc.id;
      saveStateSoon();
      broadcast({ type: 'state', payload: state });
      broadcast({ type: 'went_live', payload: { id: svc.id, name: svc.name } });
    }
    savePlaylist();
    broadcast({ type: 'playlist', payload: playlistSummary() });
    autoPull.lastRun = Date.now();
    autoPull.lastResult = `OK ${new Date().toLocaleString()} — "${planName}", ${roster.length} people (${trigger})`;
    saveAutoPull();
    console.log('[AutoPull]', autoPull.lastResult);
    return { ok: true, name: planName, people: roster.length, live: !!autoPull.goLive };
  } catch(e) {
    return fail(e.message);
  }
}

// Most recent scheduled occurrence (day-of-week + time, local) at or before `now`
function lastScheduledTime(now) {
  const [h, m] = String(autoPull.time || '09:00').split(':').map(n => parseInt(n) || 0);
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  const diff = (t.getDay() - (autoPull.day ?? 4) + 7) % 7;
  t.setDate(t.getDate() - diff);
  if (t.getTime() > now) t.setDate(t.getDate() - 7);
  return t.getTime();
}

// Fire when the weekly time passes. Also catches up after sleep/relaunch: if
// the last successful run is older than the most recent scheduled time it is
// still due, retrying every 30 minutes until it succeeds.
let _apLastAttempt = 0;
setInterval(() => {
  if (!autoPull.enabled) return;
  const due = lastScheduledTime(Date.now());
  if ((autoPull.lastRun || 0) >= due) return;
  if (Date.now() - _apLastAttempt < 30 * 60 * 1000) return;
  _apLastAttempt = Date.now();
  runAutoPull('scheduled');
}, 60 * 1000);

app.get('/api/autopull', (req, res) => {
  res.json({ ...autoPull, nextRun: autoPull.enabled ? lastScheduledTime(Date.now()) + 7 * 24 * 3600 * 1000 : null });
});
app.post('/api/autopull', (req, res) => {
  const b = req.body || {};
  autoPull = {
    ...autoPull,
    enabled: !!b.enabled,
    typeId: String(b.typeId || ''),
    typeName: String(b.typeName || ''),
    day: Math.min(6, Math.max(0, parseInt(b.day) || 0)),
    time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '09:00',
    goLive: b.goLive !== false
  };
  saveAutoPull();
  console.log(`[AutoPull] Schedule saved: ${autoPull.enabled ? 'on' : 'off'}, day ${autoPull.day} at ${autoPull.time}`);
  res.json({ ok: true });
});
app.post('/api/autopull/run', async (req, res) => res.json(await runAutoPull('manual')));

// App version info
// Export all data as a single JSON bundle
app.get('/api/export', (req, res) => {
  const bundle = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    tags: tagsView(), // derived; kept in the bundle so old installs can import it
    people,
    rules,
    playlist,
    activeServiceId,
    state
  };
  res.setHeader('Content-Disposition', 'attachment; filename="show-dashboard-backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(bundle);
});

// Import data bundle
app.post('/api/import', (req, res) => {
  const bundle = req.body;
  if (!bundle || !bundle.version) return res.status(400).json({ error: 'Invalid bundle' });
  try {
    if (bundle.people)   { people = bundle.people; savePeople(); }
    if (bundle.tags) {
      // Old backups carry a separate tags map — fold it into people profiles
      // the same way the boot migration does (existing profile values win).
      Object.entries(bundle.tags).forEach(([name, t]) => {
        const p = people.find(x => x.name === name);
        if (p) {
          if (p.defaultIemSlot == null && t.iemSlot != null) p.defaultIemSlot = t.iemSlot;
          if (!p.defaultProdPosition && t.prodPosition) p.defaultProdPosition = t.prodPosition;
          if (!p.photo && t.photo) p.photo = t.photo;
        } else {
          people.push({ id: 'person_' + Date.now() + '_' + people.length, name, photo: t.photo || '',
            defaultIemSlot: t.iemSlot ?? null, defaultProdPosition: t.prodPosition || null, notes: '' });
        }
      });
      savePeople();
    }
    if (bundle.rules)    { rules  = bundle.rules;  saveRules(); }
    if (bundle.playlist) { playlist = bundle.playlist; }
    if (bundle.activeServiceId) activeServiceId = bundle.activeServiceId;
    if (bundle.state)    { state = bundle.state; }
    savePlaylist();
    saveStateSoon();
  broadcast({ type: 'state', payload: state });
    console.log('[Import] Data imported successfully');
    res.json({ ok: true, imported: { tags: Object.keys(tagsView()).length, people: people.length, rules: rules.length, services: playlist.length } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Shure live battery polling (Command Strings, TCP port 2202) ─────────────
// Works with ULX-D, QLX-D, and Axient Digital receivers. PSM1000 has no
// return channel, so IEM pack batteries are not network-readable (WWB can't either).
const net = require('net');
const SHURE_FILE = path.join(DATA_DIR, 'shure-devices.json');
let shureDevices = []; // [{id, ip, port, type, channels:[{ch, slotType:'iem'|'mic', slotIndex}]}]
let shureStatus = {};  // id -> {ok, lastSeen, error}

function loadShureDevices() {
  try {
    if (fs.existsSync(SHURE_FILE)) shureDevices = JSON.parse(fs.readFileSync(SHURE_FILE,'utf8'));
    // Re-derive kind from the stored model — classification rules improve
    // over time and saved devices must pick that up (e.g. SBRC docks)
    shureDevices.forEach(d => {
      if (d.model) { const k = shureModelInfo(d.model).kind; if (k !== 'unknown') d.kind = k; }
    });
  }
  catch(e) { console.error('[Shure] Load error:', e.message); }
}
function saveShureDevices() {
  try { fs.writeFileSync(SHURE_FILE, JSON.stringify(shureDevices, null, 2)); } catch(e) {}
}
loadShureDevices();

// What a Shure model actually is and how many stage channels it offers.
// Used as a fallback/label — the observed replies (which channels answer)
// are the primary source of truth for channel count.
function shureModelInfo(model) {
  const m = String(model || '').toUpperCase();
  if (!m) return { kind: 'unknown', channels: null };
  if (/^SB|CHARG/.test(m)) return { kind: 'dock', channels: 0 };      // SBC / SBRC chargers — nothing to map
  if (/P10T|PSM/.test(m))  return { kind: 'iem-tx', channels: 2 };    // IEM transmitter — names only, no battery
  if (/4Q|AD4Q/.test(m))   return { kind: 'receiver', channels: 4 };
  if (/4D|AD4D/.test(m))   return { kind: 'receiver', channels: 2 };
  if (/ULXD4|QLXD4|SLXD4/.test(m)) return { kind: 'receiver', channels: 1 };
  return { kind: 'receiver', channels: null };
}

// ─── Shure live link ──────────────────────────────────────────────────────────
// One persistent TCP connection per receiver. Devices push < REP ... > the
// moment a value changes, and we re-ask for battery every 2s over the open
// socket as a safety net — so battery appears/disappears on the board within
// a couple of seconds instead of the old connect-poll-disconnect 5s cycle.
const shureConns = {}; // dev.id -> connection handle

let _shureBroadcastTimer = null;
function shureStateChanged() {
  saveStateSoon();
  if (_shureBroadcastTimer) return;
  _shureBroadcastTimer = setTimeout(() => {
    _shureBroadcastTimer = null;
    broadcast({ type: 'state', payload: state });
  }, 150); // coalesce bursts of REPs into one broadcast
}

function applyShureRep(dev, chNum, data) {
  const st = shureStatus[dev.id];
  if (st) { st.channels[chNum] = { ...(st.channels[chNum] || {}), ...data }; st.lastSeen = Date.now(); st.ok = true; st.error = null; }
  const map = (dev.channels || []).find(c => c.ch === chNum);
  if (!map) return;
  const arr = map.slotType === 'mic' ? state.mics : state.iems;
  const slot = arr && arr[map.slotIndex];
  if (!slot) return;
  let changed = false;
  if (data.bars !== undefined) {
    const bat = (data.bars === 255) ? null : Math.round(data.bars * 20);
    if (slot.bat !== bat) { slot.bat = bat; changed = true; }
  }
  if (data.chanName !== undefined && slot.wwbName !== data.chanName) { slot.wwbName = data.chanName; changed = true; }
  if (data.freq !== undefined && slot.freq !== data.freq) { slot.freq = data.freq; changed = true; }
  if (changed) shureStateChanged();
}

function handleShureFrame(dev, conn, f) {
  let m;
  if ((m = f.match(/< REP (\d) (?:TX_)?BATT_BARS (\d+) >/))) { conn.seen.add(m[1]); applyShureRep(dev, parseInt(m[1]), { bars: parseInt(m[2]) }); return; }
  if ((m = f.match(/< REP (\d) CHAN_NAME \{(.*?)\} >/)))     { conn.seen.add(m[1]); applyShureRep(dev, parseInt(m[1]), { chanName: m[2].trim() }); return; }
  if ((m = f.match(/< REP (\d) FREQUENCY (\d+) >/)))         { conn.seen.add(m[1]); applyShureRep(dev, parseInt(m[1]), { freq: (parseInt(m[2]) / 1000).toFixed(3) }); return; }
  if ((m = f.match(/< REP DEVICE_ID \{(.*?)\} >/))) {
    const id = m[1].trim();
    if (dev.deviceId !== id) { dev.deviceId = id; saveShureDevices(); }
    if (shureStatus[dev.id]) shureStatus[dev.id].deviceId = id;
    return;
  }
  if ((m = f.match(/< REP MODEL \{(.*?)\} >/))) {
    const model = m[1].trim();
    const k = shureModelInfo(model).kind;
    if (dev.model !== model || (k !== 'unknown' && dev.kind !== k)) {
      dev.model = model;
      if (k !== 'unknown') dev.kind = k;
      saveShureDevices();
      if (shureStatus[dev.id]) { shureStatus[dev.id].model = model; shureStatus[dev.id].kind = dev.kind; }
      if (dev.kind === 'dock') {
        console.log(`[Shure] ${dev.ip} identified as charging dock (${model}) — closing link`);
        disconnectShure(dev.id);
        shureStatus[dev.id] = { ok: true, lastSeen: Date.now(), error: null, channels: {}, model, deviceId: dev.deviceId || null, kind: 'dock', chCount: 0 };
      }
    }
  }
}

function connectShure(dev) {
  if (!dev.ip) return;
  if (dev.kind === 'dock') {
    shureStatus[dev.id] = { ok: true, lastSeen: Date.now(), error: null, channels: {}, model: dev.model || null, deviceId: dev.deviceId || null, kind: 'dock', chCount: 0 };
    return;
  }
  const conn = { sock: null, buf: '', seen: new Set(), pollTimer: null, reconnectTimer: null, closed: false, dead: false };
  shureConns[dev.id] = conn;
  shureStatus[dev.id] = { ...(shureStatus[dev.id] || {}), ok: false, error: null, channels: (shureStatus[dev.id] || {}).channels || {}, model: dev.model || null, deviceId: dev.deviceId || null, kind: dev.kind || 'receiver', chCount: dev.chCount || null };
  const sock = new net.Socket();
  conn.sock = sock;
  sock.setTimeout(6000); // queries flow every 2s — 3 silent rounds means the link is gone

  const queryAll = () => {
    const n = (dev.chCount >= 1 && dev.chCount <= 4) ? dev.chCount : 4;
    // IEM transmitters (P10T) have no pack telemetry — only names & frequency
    const wantBatt = dev.kind !== 'iem-tx';
    let q = '';
    for (let ch = 1; ch <= n; ch++) {
      // Both battery dialects — ULX-D/QLX-D answer BATT_BARS, Axient TX_BATT_BARS
      if (wantBatt) q += `< GET ${ch} BATT_BARS >< GET ${ch} TX_BATT_BARS >`;
      q += `< GET ${ch} CHAN_NAME >< GET ${ch} FREQUENCY >`;
    }
    try { sock.write(q); } catch(e) {}
  };

  const teardown = (err) => {
    if (conn.dead) return;
    conn.dead = true;
    if (conn.pollTimer) { clearInterval(conn.pollTimer); conn.pollTimer = null; }
    try { sock.destroy(); } catch(e) {}
    if (shureStatus[dev.id]) { shureStatus[dev.id].ok = false; shureStatus[dev.id].error = err || 'disconnected'; }
    // A dead link means we no longer know the battery — clear it off the board
    let cleared = false;
    (dev.channels || []).forEach(c => {
      const arr = c.slotType === 'mic' ? state.mics : state.iems;
      const slot = arr && arr[c.slotIndex];
      if (slot && slot.bat != null) { slot.bat = null; cleared = true; }
    });
    if (cleared) shureStateChanged();
    if (!conn.closed) conn.reconnectTimer = setTimeout(() => connectShure(dev), 3000);
  };

  sock.on('connect', () => {
    conn.buf = '';
    conn.seen.clear();
    sock.write('< GET MODEL >< GET DEVICE_ID >');
    queryAll();
    conn.pollTimer = setInterval(queryAll, 2000);
    // After the first full round, remember how many channels actually exist
    setTimeout(() => {
      if (conn.dead) return;
      const n = conn.seen.size;
      if (n >= 1 && n <= 4 && dev.chCount !== n) { dev.chCount = n; saveShureDevices(); if (shureStatus[dev.id]) shureStatus[dev.id].chCount = n; }
    }, 3000);
  });
  sock.on('data', d => {
    conn.buf += d.toString();
    // Consume complete < ... > frames, keep any partial tail for the next chunk
    const frameRe = /<[^>]*>/g;
    let m, lastEnd = 0;
    const frames = [];
    while ((m = frameRe.exec(conn.buf)) !== null) { frames.push(m[0]); lastEnd = frameRe.lastIndex; }
    conn.buf = conn.buf.slice(lastEnd);
    if (conn.buf.length > 4096) conn.buf = ''; // garbage guard
    frames.forEach(f => handleShureFrame(dev, conn, f));
  });
  sock.on('error', e => teardown(e.code || e.message));
  sock.on('timeout', () => teardown('timeout'));
  sock.on('close', () => teardown());
  sock.connect(dev.port || 2202, dev.ip);
}

function disconnectShure(id) {
  const conn = shureConns[id];
  if (!conn) return;
  conn.closed = true;
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  if (conn.pollTimer) clearInterval(conn.pollTimer);
  try { conn.sock.destroy(); } catch(e) {}
  conn.dead = true;
  delete shureConns[id];
}

function reconnectAllShure() {
  Object.keys(shureConns).forEach(disconnectShure);
  shureDevices.forEach(connectShure);
}

// Open links to all saved devices on boot
reconnectAllShure();

app.get('/api/shure-devices', (req, res) => res.json(shureDevices));
app.post('/api/shure-devices', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'array required' });
  shureDevices = req.body.map((d,i) => ({ id: d.id || 'shure_'+Date.now()+'_'+i, ip: d.ip, port: d.port||2202, type: d.type||'ulxd', channels: d.channels||[], model: d.model||null, deviceId: d.deviceId||null, kind: d.kind||null, chCount: d.chCount||null }));
  saveShureDevices();
  shureStatus = {};
  reconnectAllShure();
  res.json({ ok: true, count: shureDevices.length });
});
app.get('/api/shure-status', (req, res) => res.json(shureStatus));

// ─── Shure network discovery ──────────────────────────────────────────────────
// Probe one host: does anything on TCP 2202 answer Shure Command Strings?
// Identified devices report DEVICE_ID / MODEL / channel names.
function probeShure(ip, port = 2202, timeout = 500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = '';
    let settled = false;
    let replyTimer = null;
    const done = (found) => {
      if (settled) return;
      settled = true;
      if (replyTimer) clearTimeout(replyTimer);
      sock.destroy();
      resolve(found);
    };
    const parse = () => {
      if (!buf.includes('< REP')) return null;
      const dev = { ip, channels: {} };
      const id = buf.match(/< REP DEVICE_ID \{(.*?)\} >/);
      if (id) dev.deviceId = id[1].trim();
      const model = buf.match(/< REP MODEL \{(.*?)\} >/);
      if (model) dev.model = model[1].trim();
      const rn = /< REP (\d) CHAN_NAME \{(.*?)\} >/g;
      let m; while ((m = rn.exec(buf)) !== null) dev.channels[m[1]] = m[2].trim();
      return dev;
    };
    sock.setTimeout(timeout);
    sock.on('connect', () => {
      sock.write('< GET DEVICE_ID >< GET MODEL >< GET 1 CHAN_NAME >< GET 2 CHAN_NAME >< GET 3 CHAN_NAME >< GET 4 CHAN_NAME >');
      replyTimer = setTimeout(() => done(parse()), 400); // collect replies briefly
    });
    sock.on('data', d => { buf += d.toString(); });
    sock.on('timeout', () => done(parse()));
    sock.on('error', () => done(null));
    sock.connect(port, ip);
  });
}

function localSubnets() {
  const nets = os.networkInterfaces();
  const subnets = new Set();
  Object.values(nets).forEach(list => (list || []).forEach(n => {
    if (n.family === 'IPv4' && !n.internal) subnets.add(n.address.split('.').slice(0, 3).join('.'));
  }));
  return [...subnets];
}

// Sweep the local /24 subnet(s) for Shure receivers. ~48 probes in flight at
// a time; a full /24 takes a few seconds.
let _shureScanRunning = false;
app.post('/api/shure-scan', async (req, res) => {
  if (_shureScanRunning) return res.status(409).json({ error: 'A scan is already running' });
  _shureScanRunning = true;
  try {
    const subnets = localSubnets();
    const ips = [];
    subnets.forEach(s => { for (let i = 1; i <= 254; i++) ips.push(s + '.' + i); });
    const found = [];
    const BATCH = 48;
    for (let i = 0; i < ips.length; i += BATCH) {
      const results = await Promise.all(ips.slice(i, i + BATCH).map(ip => probeShure(ip)));
      results.forEach(r => {
        if (!r) return;
        // Classify by model (deviceId as fallback — docks are often named
        // "CHARGER"); channel count prefers what actually answered
        const info = shureModelInfo(r.model || r.deviceId);
        r.kind = info.kind === 'unknown' ? 'receiver' : info.kind;
        r.chCount = r.kind === 'dock' ? 0 : (Object.keys(r.channels || {}).length || info.channels || null);
        found.push(r);
      });
    }
    console.log(`[Shure] Scan complete: ${found.length} device(s) across ${subnets.map(s => s + '.x').join(', ')}`);
    res.json({ found, scanned: ips.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    _shureScanRunning = false;
  }
});

// Connection info for remote access (stable .local hostname + LAN IPs)
app.get('/api/connect-info', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach(list => (list||[]).forEach(n => {
    if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }));
  let host = os.hostname();
  if (!host.endsWith('.local')) host = host.replace(/\.local$/,'') + '.local';
  res.json({ hostname: host, ips, port: PORT });
});

app.get('/api/version', (req, res) => {
  try {
    const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
    res.json({ version: pkg.version });
  } catch(e) { res.json({ version: 'unknown' }); }
});

// Trigger update check from browser
app.post('/api/check-update', (req, res) => {
  res.json({ checking: true });
  // Set a global flag that main.js polls
  global.triggerUpdateCheck = true;
  console.log('[Update] Manual check triggered from UI');
});

// Trigger OTA install from browser button
app.post('/api/install-update', (req, res) => {
  res.json({ ok: true });
  global.triggerInstall = true;
  console.log('[Update] Install triggered from UI');
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n🎛  Show Dashboard running!\n');
  console.log(`   Display (backstage screen):  http://${localIP}:${PORT}/display`);
  console.log(`   Editor  (your laptop / FOH): http://${localIP}:${PORT}/edit`);
  console.log(`\n   Also available on this machine: http://localhost:${PORT}/display\n`);
});
