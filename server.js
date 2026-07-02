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
const DATA_DIR = path.join(os.homedir(), '.show-dashboard');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}

const PLAYLIST_FILE = path.join(DATA_DIR, 'playlist.json');
const TAGS_FILE    = path.join(DATA_DIR, 'tags.json');
const PEOPLE_FILE  = path.join(DATA_DIR, 'people.json');
const RULES_FILE   = path.join(DATA_DIR, 'rules.json');

const STATE_FILE = path.join(DATA_DIR, 'state.json');
let _stateSaveTimer = null;
function saveStateSoon() {
  if (_stateSaveTimer) return;
  _stateSaveTimer = setTimeout(() => {
    _stateSaveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
    catch(e) { console.error('[State] Save error:', e.message); }
  }, 500);
}

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

// ─── Name tags (persisted to disk) ───────────────────────────────────────────
// tags: { "Ruben Mundo": { iemSlot: 2, micSlot: 2, prodPosition: null } }
// iemSlot/micSlot = index into state.iems/mics (0-based), prodPosition = position id like 'foh'
let tags = {};

function loadTags() {
  try {
    if (fs.existsSync(TAGS_FILE)) {
      tags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
      console.log(`[Tags] Loaded ${Object.keys(tags).length} name tags`);
    }
  } catch(e) { console.error('[Tags] Load error:', e.message); }
}
function saveTags() {
  try { fs.writeFileSync(TAGS_FILE, JSON.stringify(tags, null, 2)); }
  catch(e) { console.error('[Tags] Save error:', e.message); }
}
loadTags();

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

    if (msg.type === 'update') {
      // Merge incoming state patch
      state = { ...state, ...msg.payload };
      saveStateSoon();
      // Broadcast to all OTHER clients
      broadcast({ type: 'state', payload: state }, ws);
      console.log(`[~] State updated by ${ip}`);
    }

    if (msg.type === 'wwb_update') {
      // Battery / frequency push from WWB bridge
      const { id, arrayType, bat, freq } = msg.payload;
      const arr = arrayType === 'mic' ? state.mics : state.iems;
      const ch = arr.find(c => c.id === id);
      if (ch) {
        if (bat  !== undefined) ch.bat  = bat;
        if (freq !== undefined) ch.freq = freq;
      }
      broadcast({ type: 'state', payload: state }, ws);
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
  state = { ...state, ...req.body };
  saveStateSoon();
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

// ─── Smart PCO roster endpoint — returns people keyed by position name ────────
app.get('/api/pco-roster', async (req, res) => {
  if (!pcoAccessToken) return res.status(401).json({ error: 'Not connected' });
  const { typeId, planId } = req.query;
  if (!typeId || !planId) return res.status(400).json({ error: 'Missing typeId or planId' });

  const https = require('https');
  function pcoGet(path) {
    return new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.planningcenteronline.com',
        path,
        headers: { 'Authorization': getPCOAuthHeader(), 'User-Agent': 'ShowDashboard/1.0', 'Accept': 'application/json' }
      }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
  }

  try {
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

    res.json({ grouped, total: members.length });
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
  // Also sync to tags
  tags[name] = { iemSlot: defaultIemSlot??null, micSlot: defaultIemSlot??null, prodPosition: defaultProdPosition||null, photo: photo||'' };
  savePeople(); saveTags();
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

// Apply conflict rules to a given state snapshot — returns modified state + changelog
app.post('/api/rules/apply', (req, res) => {
  const { state: s } = req.body;
  if (!s) return res.status(400).json({ error: 'state required' });
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

  res.json({ state: s, changes });
});

// ─── Name tags endpoints ──────────────────────────────────────────────────────

// Get all tags
app.get('/api/tags', (req, res) => res.json(tags));

// Return all tagged people as a staging pool (so PCO pull is optional)
app.get('/api/tags/pool', (req, res) => {
  const pool = Object.entries(tags).map(([name, t]) => ({
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

// Set or update a tag — now stores photo too
app.post('/api/tags', (req, res) => {
  const { name, iemSlot, micSlot, prodPosition, photo } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  tags[name] = { iemSlot, micSlot, prodPosition, photo: photo || tags[name]?.photo || '' };
  saveTags();
  // Upsert into people library so tagged people are permanently saved
  const existing = people.findIndex(p => p.name === name);
  const person = {
    id: existing >= 0 ? people[existing].id : 'person_' + Date.now(),
    name,
    photo: photo || (existing >= 0 ? people[existing].photo : '') || '',
    defaultIemSlot: iemSlot ?? (existing >= 0 ? people[existing].defaultIemSlot : null),
    defaultProdPosition: prodPosition || (existing >= 0 ? people[existing].defaultProdPosition : null),
    notes: existing >= 0 ? people[existing].notes : ''
  };
  if (existing >= 0) people[existing] = person; else people.push(person);
  savePeople();
  console.log(`[Tags] Saved tag + person for "${name}"`);
  res.json({ ok: true });
});

// Delete a tag
app.delete('/api/tags/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  delete tags[name];
  saveTags();
  res.json({ ok: true });
});

// Apply tags to a roster — returns pre-filled assignments based on saved tags
app.post('/api/tags/apply', (req, res) => {
  const { roster } = req.body; // [{name, position, teamName, photo}]
  const iemAssign  = {};
  const prodAssign = {};
  const unmatched  = [];

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
  playlist.push({ id, name, createdAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(state)) });
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
  // Or overwrite with a provided blank state
  if (req.body.blankState) svc.state = req.body.blankState;
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

// App version info
// Export all data as a single JSON bundle
app.get('/api/export', (req, res) => {
  const bundle = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    tags,
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
    if (bundle.tags)     { Object.assign(tags, bundle.tags); saveTags(); }
    if (bundle.people)   { people = bundle.people; savePeople(); }
    if (bundle.rules)    { rules  = bundle.rules;  saveRules(); }
    if (bundle.playlist) { playlist = bundle.playlist; }
    if (bundle.activeServiceId) activeServiceId = bundle.activeServiceId;
    if (bundle.state)    { state = bundle.state; }
    savePlaylist();
    saveStateSoon();
  broadcast({ type: 'state', payload: state });
    console.log('[Import] Data imported successfully');
    res.json({ ok: true, imported: { tags: Object.keys(tags).length, people: people.length, rules: rules.length, services: playlist.length } });
  } catch(e) {
    res.status(500).json({ error: e.message });
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
