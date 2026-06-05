/* tagihan.js — Halaman Tagihan Bulanan */
'use strict';

const TG_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/tagihan';
let _tagihan = [];

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rp(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtTgl(s) { if (!s) return '-'; try { return new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s; } }

function periodeNow() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

async function loadTagihan() {
  const periode = document.getElementById('tg-periode').value || periodeNow();
  try {
    const r = await fetch(`${TG_API}?periode=${periode}`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { renderError('Anda tidak punya akses ke Tagihan.'); return; }
    const d = await r.json();
    _tagihan = d.tagihan || [];
    renderStats(d.ringkasan || {});
    renderRows();
  } catch { renderError('Gagal memuat tagihan.'); }
}

function renderError(msg) {
  document.getElementById('tg-tbody').innerHTML = `<tr><td colspan="8"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`;
}

function renderStats(s) {
  setT('st-total', s.total || 0);
  setT('st-lunas', s.lunas || 0);
  setT('st-belum', s.belum || 0);
  setT('st-nominal', rp(s.nominal_belum || 0));
}
function setT(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function renderRows() {
  const q  = (document.getElementById('tg-search').value || '').toLowerCase().trim();
  const fs = document.getElementById('tg-status').value;
  let list = _tagihan.slice();
  if (q)  list = list.filter(t => (t.nama || '').toLowerCase().includes(q) || (t.username || '').toLowerCase().includes(q));
  if (fs) list = list.filter(t => t.status === fs);

  const tb = document.getElementById('tg-tbody');
  const cnt = document.getElementById('tg-count');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="8"><div class="state-box"><p class="state-title">Belum ada tagihan untuk periode ini. Klik "Buat Tagihan".</p></div></td></tr>';
    if (cnt) cnt.textContent = '0 tagihan';
    return;
  }
  if (cnt) cnt.textContent = list.length + ' tagihan';
  tb.innerHTML = list.map((t, i) => {
    const lunas = t.status === 'lunas';
    const badge = lunas
      ? '<span class="tg-status tg-lunas"><span class="dot"></span>Lunas</span>'
      : '<span class="tg-status tg-belum"><span class="dot"></span>Belum Bayar</span>';
    const aksi = lunas
      ? `<span style="font-size:11.5px;color:var(--text-dim)">${esc(fmtTgl(t.paid_at))}${t.metode ? ' · ' + esc(t.metode) : ''}</span>`
      : `<button class="btn-bayar" onclick="bayar(${t.id},'${esc(t.username)}',${t.nominal})"><span class="material-symbols-outlined">payments</span>Bayar</button>`;
    return `<tr>
      <td class="sticky-col-1">${i + 1}</td>
      <td class="sticky-col-2"><div class="tg-name">${esc(t.nama || t.username)}</div><div class="tg-user">@${esc(t.username)}</div></td>
      <td><span class="tg-chip">${esc(t.profil || '-')}</span></td>
      <td>${esc(t.periode)}</td>
      <td class="tg-nominal">${rp(t.nominal)}</td>
      <td>${esc(fmtTgl(t.jatuh_tempo))}</td>
      <td>${badge}</td>
      <td>${aksi}</td>
    </tr>`;
  }).join('');
}

async function generateTagihan() {
  const periode = document.getElementById('tg-periode').value || periodeNow();
  if (!confirm(`Buat tagihan untuk semua pelanggan aktif periode ${periode}?\n\nTagihan yang sudah ada tidak akan diduplikasi.`)) return;
  const btn = document.getElementById('btn-generate'); btn.disabled = true;
  try {
    const r = await fetch(`${TG_API}/generate`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
      body: JSON.stringify({ periode }),
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tagihan dibuat' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadTagihan();
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

async function bayar(id, username, nominal) {
  const metode = prompt(`Terima pembayaran "${username}" sebesar ${rp(nominal)}.\nMetode pembayaran:`, 'Cash');
  if (metode === null) return;
  const r = await fetch(`${TG_API}/${id}/bayar`, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
    body: JSON.stringify({ metode: metode || 'Cash' }),
  });
  const d = await r.json();
  toast(r.ok ? (d.message || 'Lunas') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
  if (r.ok) loadTagihan();
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('tg-periode').value = periodeNow();
  loadTagihan();
});
