/* loket.js — Loket / Kasir + Komisi */
'use strict';

const LK_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/loket';
let _tagihan = [];
let _komisiCfg = { tipe: 'persen', nilai: 0 };
let _debTimer = null;

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function _jhdr() { return Object.assign({ 'Content-Type': 'application/json' }, _hdr()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rp(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtTgl(s) { if (!s) return '-'; try { return new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s; } }
function periodeNow() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

// ── Tabs ───────────────────────────────────────────────────────
function switchTab(t) {
  document.getElementById('tab-loket').classList.toggle('active', t === 'loket');
  document.getElementById('tab-rekap').classList.toggle('active', t === 'rekap');
  document.getElementById('panel-loket').style.display = t === 'loket' ? '' : 'none';
  document.getElementById('panel-rekap').style.display = t === 'rekap' ? '' : 'none';
  if (t === 'rekap') loadRekap();
}

// ── Komisi banner ──────────────────────────────────────────────
function renderKomisiBanner() {
  const txt = _komisiCfg.tipe === 'flat'
    ? `Komisi kolektor: ${rp(_komisiCfg.nilai)} per tagihan`
    : `Komisi kolektor: ${_komisiCfg.nilai}% dari nominal tagihan`;
  document.getElementById('komisi-banner-text').textContent =
    _komisiCfg.nilai > 0 ? txt : 'Komisi belum diatur (0). Klik "Atur Komisi" untuk menetapkan.';
}

// ── Tagihan belum lunas ────────────────────────────────────────
function debLoad() { clearTimeout(_debTimer); _debTimer = setTimeout(loadTagihan, 300); }

async function loadTagihan() {
  const q = (document.getElementById('lk-search').value || '').trim();
  const periode = document.getElementById('lk-periode').value || '';
  const tb = document.getElementById('lk-tbody');
  tb.innerHTML = '<tr><td colspan="8"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const qs = new URLSearchParams(); if (q) qs.set('q', q); if (periode) qs.set('periode', periode);
    const r = await fetch(`${LK_API}/tagihan?${qs}`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { tb.innerHTML = stateRow(8, 'Anda tidak punya akses ke loket.'); return; }
    const d = await r.json();
    _tagihan = d.tagihan || [];
    if (d.komisi_config) { _komisiCfg = d.komisi_config; renderKomisiBanner(); }
    renderTagihan();
  } catch { tb.innerHTML = stateRow(8, 'Gagal memuat tagihan.'); }
}

function stateRow(cols, msg) { return `<tr><td colspan="${cols}"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`; }

function renderTagihan() {
  const tb = document.getElementById('lk-tbody');
  const cnt = document.getElementById('lk-count');
  if (!_tagihan.length) { tb.innerHTML = stateRow(8, 'Tidak ada tagihan belum lunas. 🎉'); if (cnt) cnt.textContent = '0 tagihan'; return; }
  if (cnt) cnt.textContent = _tagihan.length + ' tagihan belum lunas';
  tb.innerHTML = _tagihan.map((t, i) => `<tr>
    <td class="sticky-col-1">${i + 1}</td>
    <td class="sticky-col-2"><div class="lk-name">${esc(t.nama)}</div><div class="lk-sub">@${esc(t.username)}</div></td>
    <td><span class="lk-chip">${esc(t.profil || '-')}</span></td>
    <td>${esc(t.periode)}</td>
    <td class="lk-nominal">${rp(t.nominal)}</td>
    <td>${esc(fmtTgl(t.jatuh_tempo))}</td>
    <td class="lk-komisi">${rp(t.komisi)}</td>
    <td><button class="btn-terima" onclick="terima(${t.id},'${esc(t.nama)}',${t.nominal},${t.komisi})"><span class="material-symbols-outlined">point_of_sale</span>Terima</button></td>
  </tr>`).join('');
}

async function terima(id, nama, nominal, komisi) {
  const metode = prompt(`Terima pembayaran "${nama}" sebesar ${rp(nominal)}\nKomisi kolektor: ${rp(komisi)}\n\nMetode pembayaran:`, 'Cash');
  if (metode === null) return;
  const r = await fetch(`${LK_API}/bayar`, { method: 'POST', credentials: 'include', headers: _jhdr(),
    body: JSON.stringify({ tagihan_id: id, metode: metode || 'Cash' }) });
  const d = await r.json();
  toast(r.ok ? (d.message || 'Diterima') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
  if (r.ok) loadTagihan();
}

// ── Rekap komisi ───────────────────────────────────────────────
async function loadRekap() {
  const periode = document.getElementById('rk-periode').value || periodeNow();
  const tb = document.getElementById('rk-tbody');
  tb.innerHTML = '<tr><td colspan="5"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const r = await fetch(`${LK_API}/rekap?periode=${periode}`, { credentials: 'include', headers: _hdr() });
    const d = await r.json();
    const tot = d.total || {};
    setT('rk-jumlah', tot.jumlah || 0); setT('rk-total', rp(tot.total_tagihan || 0)); setT('rk-komisi', rp(tot.total_komisi || 0));
    const list = d.rekap || [];
    if (!list.length) { tb.innerHTML = stateRow(5, 'Belum ada setoran pada periode ini.'); return; }
    tb.innerHTML = list.map((x, i) => `<tr>
      <td class="sticky-col-1">${i + 1}</td>
      <td class="sticky-col-2"><div class="lk-name">${esc(x.kolektor)}</div></td>
      <td>${x.jumlah}</td>
      <td class="lk-nominal">${rp(x.total_tagihan)}</td>
      <td class="lk-komisi">${rp(x.total_komisi)}</td>
    </tr>`).join('');
  } catch { tb.innerHTML = stateRow(5, 'Gagal memuat rekap.'); }
}
function setT(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

// ── Modal komisi ───────────────────────────────────────────────
function openKomisi() {
  document.getElementById('km-tipe').value = _komisiCfg.tipe;
  document.getElementById('km-nilai').value = _komisiCfg.nilai;
  kmTipeChange();
  document.getElementById('km-overlay').classList.add('show');
  document.getElementById('km-modal').classList.add('show');
}
function closeKomisi() { document.getElementById('km-overlay').classList.remove('show'); document.getElementById('km-modal').classList.remove('show'); }
function kmTipeChange() {
  document.getElementById('km-nilai-label').textContent =
    document.getElementById('km-tipe').value === 'flat' ? 'Nilai (Rp per tagihan)' : 'Nilai (%)';
}
async function saveKomisi() {
  const tipe = document.getElementById('km-tipe').value;
  const nilai = parseInt(document.getElementById('km-nilai').value || '0', 10);
  if (isNaN(nilai) || nilai < 0) { toast('Nilai komisi tidak valid', 'danger'); return; }
  if (tipe === 'persen' && nilai > 100) { toast('Persentase maksimal 100', 'danger'); return; }
  const btn = document.getElementById('km-save'); btn.disabled = true;
  try {
    const r = await fetch(`${LK_API}/config`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ tipe, nilai }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { _komisiCfg = { tipe, nilai }; renderKomisiBanner(); closeKomisi(); loadTagihan(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

// ── Init ───────────────────────────────────────────────────────
function loadAll() { loadTagihan(); if (document.getElementById('panel-rekap').style.display !== 'none') loadRekap(); }

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('lk-periode').value = periodeNow();
  document.getElementById('rk-periode').value = periodeNow();
  loadTagihan();
});
