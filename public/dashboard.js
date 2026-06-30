// ─── Shared constants ─────────────────────────────────────────────────────────
const COLORS = ['#378ADD','#1D9E75','#D85A30','#7F77DD','#BA7517','#D4537E','#639922','#E24B4A','#0F6E56','#534AB7','#993C1D','#854F0B'];
const PROD_POSITIONS = [
  { id: 'cg',     label: 'CG',         color: '#7F77DD' },
  { id: 'cam',    label: 'Camera',     color: '#1D9E75' },
  { id: 'foh',    label: 'FOH',        color: '#D85A30' },
  { id: 'mon',    label: 'Monitors',   color: '#378ADD' },
  { id: 'light',  label: 'Lighting',   color: '#BA7517' },
  { id: 'stage',  label: 'Stage hand', color: '#888780' },
  { id: 'dir',    label: 'Director',   color: '#D4537E' },
  { id: 'stream', label: 'Streaming',  color: '#639922' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function initials(n) {
  if (!n || !n.trim()) return '?';
  const p = n.trim().split(' ');
  return p.length > 1 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : p[0].slice(0, 2).toUpperCase();
}
function colorFor(n) {
  let h = 0;
  for (const c of (n || '?')) h = c.charCodeAt(0) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}
function posInfo(pid) {
  return PROD_POSITIONS.find(p => p.id === pid) || { label: 'Crew', color: '#888780' };
}
function batHTML(b) {
  if (b === null || b === undefined) return '';
  const cls = b > 60 ? 'bat-high' : b > 30 ? 'bat-mid' : 'bat-low';
  return `<span class="bat-inline"><span class="bat-box"><span class="bat-fill ${cls}" style="width:${b}%"></span></span>${b}%</span>`;
}

// ─── Card builders ────────────────────────────────────────────────────────────
function buildMicCard(ch, opts = {}) {
  const { draggable = false, editable = false } = opts;
  const isActive = ch.status === 'active';
  const color = colorFor(ch.name || ch.role);
  const init = initials(ch.name || ch.role);
  const dotCls = !isActive ? 'dot-na' : (ch.bat !== null && ch.bat < 30) ? 'dot-warn' : 'dot-active';

  const div = document.createElement('div');
  div.className = `person-card ${isActive ? 'active-card' : 'na-card'}${draggable ? ' drag-mode' : ''}`;
  div.id = 'card-' + ch.id;
  if (draggable) div.setAttribute('draggable', 'true');

  div.innerHTML = `
    ${draggable ? '<div class="drag-handle" aria-hidden="true"><i class="ti ti-grip-vertical"></i></div>' : ''}
    <div class="card-photo">
      ${ch.photo ? `<img src="${ch.photo}" alt="${ch.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
      <div class="card-avatar" style="background:${color};${ch.photo ? 'display:none' : 'display:flex'}">${init}</div>
      <div class="card-ch-badge">Mic ${ch.ch}</div>
      <div class="card-status-dot ${dotCls}"></div>
    </div>
    <div class="card-info">
      <div class="card-role">${ch.role}</div>
      <div class="card-name">${ch.name || 'Unassigned'}</div>
      ${ch.freq ? `<div class="card-meta"><i class="ti ti-wave-sine" aria-hidden="true"></i>${ch.freq} MHz</div>` : ''}
      <div class="card-meta"><i class="ti ti-device-speaker" aria-hidden="true"></i>${ch.type || '—'}</div>
      ${(ch.bat !== null && ch.bat !== undefined) ? `<div style="margin-top:4px">${batHTML(ch.bat)}</div>` : ''}
    </div>`;
  return div;
}

function buildIemCard(ch, opts = {}) {
  const { draggable = false } = opts;
  const isActive = ch.status === 'active';
  const color = colorFor(ch.name || ch.role);
  const init = initials(ch.name || ch.role);
  const dotCls = !isActive ? 'dot-na' : (ch.bat !== null && ch.bat < 30) ? 'dot-warn' : 'dot-active';

  const div = document.createElement('div');
  div.className = `person-card ${isActive ? 'active-card' : 'na-card'}${draggable ? ' drag-mode' : ''}`;
  div.id = 'card-' + ch.id;
  if (draggable) div.setAttribute('draggable', 'true');

  div.innerHTML = `
    ${draggable ? '<div class="drag-handle" aria-hidden="true"><i class="ti ti-grip-vertical"></i></div>' : ''}
    <div class="card-photo">
      ${ch.photo ? `<img src="${ch.photo}" alt="${ch.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
      <div class="card-avatar" style="background:${color};${ch.photo ? 'display:none' : 'display:flex'}">${init}</div>
      <div class="card-ch-badge">IEM ${ch.ch}</div>
      <div class="card-status-dot ${dotCls}"></div>
    </div>
    <div class="card-info">
      <div class="card-role">${ch.role}</div>
      <div class="card-name">${ch.name || 'Unassigned'}</div>
      ${ch.freq ? `<div class="card-meta"><i class="ti ti-wave-sine" aria-hidden="true"></i>${ch.freq} MHz</div>` : ''}
      <div class="card-meta"><i class="ti ti-headphones" aria-hidden="true"></i>${ch.mix || '—'}</div>
      ${(ch.bat !== null && ch.bat !== undefined) ? `<div style="margin-top:4px">${batHTML(ch.bat)}</div>` : ''}
    </div>`;
  return div;
}

function buildProdCard(p, opts = {}) {
  const { draggable = false } = opts;
  const isActive = p.status === 'active';
  const pos = posInfo(p.position);
  const color = p.name ? colorFor(p.name) : pos.color;
  const init = initials(p.name || p.role);

  const div = document.createElement('div');
  div.className = `prod-card ${isActive ? 'active-card' : 'na-card'}${draggable ? ' drag-mode' : ''}`;
  div.id = 'card-' + p.id;
  if (draggable) div.setAttribute('draggable', 'true');

  div.innerHTML = `
    ${draggable ? '<div class="drag-handle" aria-hidden="true"><i class="ti ti-grip-vertical"></i></div>' : ''}
    <div class="prod-photo">
      ${p.photo ? `<img src="${p.photo}" alt="${p.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
      <div class="prod-avatar" style="background:${color};${p.photo ? 'display:none' : 'display:flex'}">${init}</div>
      <div class="prod-pos-badge" style="background:${pos.color}">${pos.label}</div>
      <div class="card-status-dot ${isActive ? 'dot-active' : 'dot-na'}" style="display:${draggable ? 'none' : 'block'}"></div>
    </div>
    <div class="prod-info">
      <div class="prod-role">${p.role}</div>
      <div class="prod-name">${p.name || 'Unassigned'}</div>
      ${p.note ? `<div class="prod-note"><i class="ti ti-notes" aria-hidden="true"></i>${p.note}</div>` : ''}
    </div>`;
  return div;
}

// ─── WebSocket sync ───────────────────────────────────────────────────────────
class DashboardSync {
  constructor({ onState, readOnly = false }) {
    this.onState = onState;
    this.readOnly = readOnly;
    this.ws = null;
    this.reconnectDelay = 1500;
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);

    this.ws.onopen = () => {
      console.log('WS connected');
      this._setStatus('connected');
      this.reconnectDelay = 1500;
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') this.onState(msg.payload);
    };
    this.ws.onclose = () => {
      this._setStatus('disconnected');
      setTimeout(() => this._connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
    };
    this.ws.onerror = () => this._setStatus('error');
  }

  push(statePatch) {
    if (this.readOnly || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'update', payload: statePatch }));
  }

  _setStatus(s) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    el.dataset.status = s;
    el.title = s === 'connected' ? 'Live — connected to server' : 'Reconnecting…';
  }
}
