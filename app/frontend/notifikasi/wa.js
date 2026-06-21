/* wa.js — Notifikasi WhatsApp */
'use strict';

const WA_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/wa';
let _cfg = {};

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function _jhdr() { return Object.assign({ 'Content-Type': 'application/json' }, _hdr()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function periodeNow() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function fmtWaktu(s) { if (!s) return '-'; try { return new Date(s.replace(' ', 'T')).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return esc(s); } }

async function loadConfig() {
  try {
    const r = await fetch(`${WA_API}/config`, { credentials: 'include', headers: _hdr() });
    const d = await r.json(); _cfg = d.config || {};
    document.getElementById('tpl-preview').textContent = _cfg.template || '—';
    renderBanner();
  } catch {}
}

function renderBanner() {
  const b = document.getElementById('mode-banner');
  if (_cfg.enabled && _cfg.has_token) {
    b.className = 'mode-banner mode-live'; b.style.display = 'flex';
    b.innerHTML = `<span class="material-symbols-outlined">cloud_done</span>Gateway ${esc(_cfg.provider || '')} aktif — pesan dikirim sungguhan.`;
  } else {
    b.className = 'mode-banner mode-mock'; b.style.display = 'flex';
    b.innerHTML = '<span class="material-symbols-outlined">science</span>Mode mock — gateway belum diaktifkan. Pesan hanya dicatat di log.';
  }
}

async function loadLog() {
  const tb = document.getElementById('wa-tbody');
  tb.innerHTML = '<tr><td colspan="6"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const r = await fetch(`${WA_API}/log?limit=100`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { tb.innerHTML = stateRow('Anda tidak punya akses.'); return; }
    const d = await r.json(); const log = d.log || [];
    const cnt = document.getElementById('wa-count');
    if (!log.length) { tb.innerHTML = stateRow('Belum ada riwayat pengiriman.'); if (cnt) cnt.textContent = '0 log'; return; }
    if (cnt) cnt.textContent = log.length + ' log';
    tb.innerHTML = log.map((x, i) => {
      const cls = x.status === 'terkirim' ? 'w-ok' : (x.status === 'mock' ? 'w-mock' : 'w-fail');
      const label = x.status === 'terkirim' ? 'Terkirim' : (x.status === 'mock' ? 'Mock' : 'Gagal');
      return `<tr>
        <td class="sticky-col-1">${i + 1}</td>
        <td class="sticky-col-2"><div class="wa-mono">${esc(x.tujuan)}</div><div style="font-size:11.5px;color:var(--text-dim)">${esc(x.nama || '')}</div></td>
        <td><div class="wa-msg" title="${esc(x.pesan)}">${esc(x.pesan)}</div></td>
        <td>${esc(x.provider || '-')}</td>
        <td><span class="wa-status ${cls}"><span class="dot"></span>${label}</span></td>
        <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${fmtWaktu(x.created_at)}</td>
      </tr>`;
    }).join('');
  } catch { tb.innerHTML = stateRow('Gagal memuat log.'); }
}
function stateRow(msg) { return `<tr><td colspan="6"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`; }

async function blastReminder() {
  const periode = document.getElementById('wa-periode').value || periodeNow();
  if (!(await tfConfirm(`Kirim pengingat WhatsApp ke semua pelanggan dengan tagihan BELUM LUNAS periode ${periode}?`, { icon: 'campaign' }))) return;
  try {
    const r = await fetch(`${WA_API}/reminder`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ periode }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Selesai' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadLog();
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
}

// Config modal
function openConfig() {
  document.getElementById('cfg-provider').value = _cfg.provider || 'fonnte';
  document.getElementById('cfg-url').value = _cfg.url || '';
  document.getElementById('cfg-token').value = '';
  document.getElementById('cfg-token').placeholder = _cfg.has_token ? '•••••• (tersimpan)' : 'token';
  document.getElementById('cfg-tpl').value = _cfg.template || '';
  document.getElementById('cfg-enabled').checked = !!_cfg.enabled;
  document.getElementById('cfg-auto-enabled').checked = !!_cfg.auto_enabled;
  document.getElementById('cfg-alert-enabled').checked = !!_cfg.alert_enabled;
  document.getElementById('cfg-alert-hp').value = _cfg.alert_hp || '';
  show('cfg');
}
function closeConfig() { hide('cfg'); }
async function saveConfig() {
  const body = {
    provider: document.getElementById('cfg-provider').value,
    url: document.getElementById('cfg-url').value.trim(),
    enabled: document.getElementById('cfg-enabled').checked,
    auto_enabled: document.getElementById('cfg-auto-enabled').checked,
    template: document.getElementById('cfg-tpl').value.trim(),
    alert_enabled: document.getElementById('cfg-alert-enabled').checked,
    alert_hp: document.getElementById('cfg-alert-hp').value.trim(),
  };
  const tk = document.getElementById('cfg-token').value; if (tk) body.token = tk;
  const btn = document.getElementById('cfg-save'); btn.disabled = true;
  try {
    const r = await fetch(`${WA_API}/config`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify(body) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeConfig(); loadConfig(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

// Test modal
function openTest() { show('test'); }
function closeTest() { hide('test'); }
async function sendTest() {
  const to = document.getElementById('test-to').value.trim();
  const message = document.getElementById('test-msg').value.trim();
  if (!to || !message) { toast('Nomor & pesan wajib', 'danger'); return; }
  const btn = document.getElementById('test-send'); btn.disabled = true;
  try {
    const r = await fetch(`${WA_API}/send`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ to, message }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Terkirim' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeTest(); loadLog(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

function show(p) { document.getElementById(p + '-overlay').classList.add('show'); document.getElementById(p + '-modal').classList.add('show'); }
function hide(p) { document.getElementById(p + '-overlay').classList.remove('show'); document.getElementById(p + '-modal').classList.remove('show'); }

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('wa-periode').value = periodeNow();
  loadConfig(); loadLog();
});
