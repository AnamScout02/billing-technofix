/* onu.js — Monitoring ONU (GenieACS / TR-069) */
'use strict';

const GA_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/genieacs';
let _onus = [];
let _wifiTarget = null;

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function _jhdr() { return Object.assign({ 'Content-Type': 'application/json' }, _hdr()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtInform(s) {
  if (!s) return '<span class="onu-sub">—</span>';
  try {
    const d = new Date(s), mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'baru saja';
    if (mins < 60) return mins + ' mnt lalu';
    if (mins < 1440) return Math.floor(mins / 60) + ' jam lalu';
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
  } catch { return esc(s); }
}
function rxClass(v) { const n = parseFloat(v); if (isNaN(n)) return ''; if (n >= -25) return 'rx-good'; if (n >= -28) return 'rx-warn'; return 'rx-bad'; }

// ── LIST ───────────────────────────────────────────────────────
async function loadDevices() {
  const tb = document.getElementById('onu-tbody');
  tb.innerHTML = '<tr><td colspan="8"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const r = await fetch(`${GA_API}/devices`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { tb.innerHTML = stateRow('Anda tidak punya akses ke perangkat.'); return; }
    const d = await r.json();
    _onus = d.devices || [];
    renderBanner(d.meta || {});
    renderStats();
    renderRows();
  } catch { tb.innerHTML = stateRow('Gagal memuat data ONU.'); }
}

function stateRow(msg) { return `<tr><td colspan="8"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`; }

function renderBanner(meta) {
  const b = document.getElementById('mode-banner');
  if (meta.mode === 'live') {
    b.className = 'mode-banner mode-live'; b.style.display = 'flex';
    b.innerHTML = '<span class="material-symbols-outlined">cloud_done</span>Terhubung ke GenieACS (live).';
  } else {
    b.className = 'mode-banner mode-mock'; b.style.display = 'flex';
    b.innerHTML = `<span class="material-symbols-outlined">science</span>${esc(meta.note || 'Mode contoh (mock) — aktifkan koneksi GenieACS untuk data live.')}`;
  }
}

function renderStats() {
  const on = _onus.filter(o => o.online).length;
  setT('st-total', _onus.length); setT('st-online', on); setT('st-offline', _onus.length - on);
}
function setT(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function renderRows() {
  const q = (document.getElementById('onu-search').value || '').toLowerCase().trim();
  const fs = document.getElementById('onu-status').value;
  let list = _onus.slice();
  if (q) list = list.filter(o => [o.serial, o.ssid, o.manufacturer, o.product, o.ip].join(' ').toLowerCase().includes(q));
  if (fs === 'online') list = list.filter(o => o.online);
  if (fs === 'offline') list = list.filter(o => !o.online);

  const tb = document.getElementById('onu-tbody');
  const cnt = document.getElementById('onu-count');
  if (!list.length) { tb.innerHTML = stateRow('Tidak ada ONU yang cocok.'); if (cnt) cnt.textContent = '0 ONU'; return; }
  if (cnt) cnt.textContent = list.length + ' ONU';
  tb.innerHTML = list.map((o, i) => {
    const status = o.online
      ? '<span class="onu-status s-on"><span class="dot"></span>Online</span>'
      : '<span class="onu-status s-off"><span class="dot"></span>Offline</span>';
    const rx = o.rx_power ? `<span class="${rxClass(o.rx_power)}">${esc(o.rx_power)} dBm</span>` : '<span class="onu-sub">—</span>';
    const id = encodeURIComponent(o.id);
    return `<tr>
      <td class="sticky-col-1">${i + 1}</td>
      <td class="sticky-col-2"><div class="onu-name">${esc(o.serial || o.id)}</div><div class="onu-sub">${esc(o.manufacturer || '')} ${esc(o.product || '')}</div></td>
      <td>${o.ssid ? esc(o.ssid) : '<span class="onu-sub">—</span>'}</td>
      <td>${rx}</td>
      <td class="onu-mono">${o.ip ? esc(o.ip) : '<span class="onu-sub">—</span>'}</td>
      <td>${fmtInform(o.last_inform)}</td>
      <td>${status}</td>
      <td><div class="row-actions">
        <button class="icon-act" title="Ubah WiFi" onclick="openWifi('${id}','${esc(o.serial || o.id)}','${esc(o.ssid || '')}')"><span class="material-symbols-outlined">wifi</span></button>
        <button class="icon-act danger" title="Reboot" onclick="rebootDevice('${id}','${esc(o.serial || o.id)}')"><span class="material-symbols-outlined">restart_alt</span></button>
      </div></td>
    </tr>`;
  }).join('');
}

// ── CONFIG MODAL ───────────────────────────────────────────────
async function openConfig() {
  show('cfg');
  try {
    const r = await fetch(`${GA_API}/config`, { credentials: 'include', headers: _hdr() });
    const d = await r.json(); const c = d.config || {};
    document.getElementById('cfg-url').value = c.url || '';
    document.getElementById('cfg-user').value = c.username || '';
    document.getElementById('cfg-pass').value = '';
    document.getElementById('cfg-pass').placeholder = c.has_password ? '•••••• (tersimpan)' : 'Kosongkan jika tanpa auth';
    document.getElementById('cfg-enabled').checked = !!c.enabled;
  } catch { toast('Gagal memuat konfigurasi', 'danger'); }
}
function closeConfig() { hide('cfg'); }

async function saveConfig() {
  const body = {
    url: document.getElementById('cfg-url').value.trim(),
    username: document.getElementById('cfg-user').value.trim(),
    enabled: document.getElementById('cfg-enabled').checked,
  };
  const pass = document.getElementById('cfg-pass').value;
  if (pass) body.password = pass;
  const btn = document.getElementById('cfg-save'); btn.disabled = true;
  try {
    const r = await fetch(`${GA_API}/config`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify(body) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeConfig(); loadDevices(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

// ── WIFI MODAL ─────────────────────────────────────────────────
function openWifi(id, label, ssid) {
  _wifiTarget = id;
  document.getElementById('wifi-target').textContent = 'Perangkat: ' + label;
  document.getElementById('wifi-ssid').value = ssid || '';
  document.getElementById('wifi-pass').value = '';
  show('wifi');
}
function closeWifi() { hide('wifi'); _wifiTarget = null; }

async function submitWifi() {
  if (!_wifiTarget) return;
  const ssid = document.getElementById('wifi-ssid').value.trim();
  const pass = document.getElementById('wifi-pass').value.trim();
  if (!ssid && !pass) { toast('Isi SSID atau password', 'danger'); return; }
  if (pass && pass.length < 8) { toast('Password WiFi minimal 8 karakter', 'danger'); return; }
  const btn = document.getElementById('wifi-save'); btn.disabled = true;
  try {
    const r = await fetch(`${GA_API}/devices/${_wifiTarget}/wifi`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ ssid, password: pass }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Terkirim' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeWifi(); setTimeout(loadDevices, 800); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

// ── REBOOT ─────────────────────────────────────────────────────
async function rebootDevice(id, label) {
  if (!confirm(`Reboot ONU "${label}"? Koneksi pelanggan akan terputus sesaat.`)) return;
  try {
    const r = await fetch(`${GA_API}/devices/${id}/reboot`, { method: 'POST', credentials: 'include', headers: _jhdr() });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Reboot terkirim' : 'Gagal'), r.ok ? 'success' : 'danger');
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
}

// ── helpers modal ──────────────────────────────────────────────
function show(p) { document.getElementById(p + '-overlay').classList.add('show'); document.getElementById(p + '-modal').classList.add('show'); }
function hide(p) { document.getElementById(p + '-overlay').classList.remove('show'); document.getElementById(p + '-modal').classList.remove('show'); }

document.addEventListener('DOMContentLoaded', loadDevices);
