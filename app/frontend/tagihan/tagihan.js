/* tagihan.js — Halaman Tagihan Bulanan */
'use strict';

const TG_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/tagihan';
let _tagihan = [];
let _tgPage  = 0;
let _TG_PER_PAGE = 50;
let _tgSortKey = null;
let _tgSortAsc = true;
let _selectedTgIds = new Set();

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
    _tgPage  = 0;
    _selectedTgIds.clear();
    _updateTgBulkToolbar();
    const cbAll = document.getElementById('tg-cb-all');
    if (cbAll) cbAll.checked = false;
    renderStats(d.ringkasan || {});
    renderRows();
  } catch { renderError('Gagal memuat tagihan.'); }
}

function renderError(msg) {
  document.getElementById('tg-tbody').innerHTML = `<tr><td colspan="9"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`;
}

function renderStats(s) {
  setT('st-total',   s.total || 0);
  setT('st-lunas',   s.lunas || 0);
  setT('st-belum',   s.belum || 0);
  setT('st-piutang', s.piutang || 0);
  setT('st-nominal', rp(s.nominal_belum || 0));
}
function setT(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function renderRows() {
  const q  = (document.getElementById('tg-search').value || '').toLowerCase().trim();
  const fs = document.getElementById('tg-status').value;
  let list = _tagihan.slice();
  if (q)  list = list.filter(t => (t.nama || '').toLowerCase().includes(q) || (t.username || '').toLowerCase().includes(q));
  if (fs) list = list.filter(t => t.status === fs);
  if (_tgSortKey) {
    list.sort((a, b) => {
      let va = a[_tgSortKey] ?? '';
      let vb = b[_tgSortKey] ?? '';
      if (_tgSortKey === 'nominal') { va = Number(va) || 0; vb = Number(vb) || 0; }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return _tgSortAsc ? cmp : -cmp;
    });
  }

  const tb  = document.getElementById('tg-tbody');
  const cnt = document.getElementById('tg-count');
  const pgWrap = document.getElementById('tg-pagination');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="9"><div class="state-box"><p class="state-title">Belum ada tagihan untuk periode ini.</p></div></td></tr>';
    if (cnt) cnt.textContent = '0 tagihan';
    if (pgWrap) pgWrap.style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(list.length / _TG_PER_PAGE);
  _tgPage = Math.min(_tgPage, totalPages - 1);
  const sliced = list.slice(_tgPage * _TG_PER_PAGE, (_tgPage + 1) * _TG_PER_PAGE);
  const offset  = _tgPage * _TG_PER_PAGE;

  if (cnt) cnt.textContent = list.length > _TG_PER_PAGE
    ? `${list.length} tagihan (tampil ${offset + 1}–${Math.min(offset + _TG_PER_PAGE, list.length)})`
    : list.length + ' tagihan';

  if (pgWrap) {
    if (totalPages > 1) {
      pgWrap.style.display = 'flex';
      pgWrap.innerHTML = _buildPagination(totalPages, _tgPage, 'tgGotoPage');
    } else {
      pgWrap.style.display = 'none';
    }
  }

  tb.innerHTML = sliced.map((t, i) => {
    const lunas   = t.status === 'lunas';
    const piutang = t.status === 'piutang';
    const badge = lunas
      ? '<span class="tg-status tg-lunas"><span class="dot"></span>Lunas</span>'
      : piutang
        ? '<span class="tg-status tg-piutang"><span class="dot"></span>Piutang</span>'
        : '<span class="tg-status tg-belum"><span class="dot"></span>Belum Bayar</span>';
    const isOwnerAdmin = ['owner','admin'].includes(localStorage.getItem('tf_role') || '');
    const btnHapus = isOwnerAdmin
      ? `<button class="btn-hapus-tg" onclick="konfirmasiHapusTagihan(${t.id},'${esc(t.nama || t.username)}','${esc(t.periode)}')" title="Hapus tagihan"><span class="material-symbols-outlined">delete</span></button>`
      : '';
    const btnPiutang = isOwnerAdmin && !lunas && !piutang
      ? `<button class="btn-piutang-tg" onclick="konfirmasiPiutang(${t.id},'${esc(t.nama || t.username)}','${esc(t.periode)}')" title="Setujui piutang — aktifkan internet, bayar nanti"><span class="material-symbols-outlined">handshake</span></button>`
      : '';
    const aksi = lunas
      ? `<span style="font-size:11.5px;color:var(--text-dim)">${esc(fmtTgl(t.paid_at))}${t.metode ? ' · ' + esc(t.metode) : ''}</span>${btnHapus}`
      : piutang
        ? `<button class="btn-bayar" onclick="bayar(${t.id},'${esc(t.username)}',${t.nominal})"><span class="material-symbols-outlined">payments</span>Lunasi</button>${btnHapus}`
        : `<button class="btn-bayar" onclick="bayar(${t.id},'${esc(t.username)}',${t.nominal})"><span class="material-symbols-outlined">payments</span>Bayar</button>${btnPiutang}${btnHapus}`;
    return `<tr>
      <td class="sticky-col-0"><input type="checkbox" class="tg-cb-row" data-id="${t.id}"
        ${_selectedTgIds.has(t.id) ? 'checked' : ''} onchange="toggleTgSelect(${t.id},this.checked)" /></td>
      <td class="sticky-col-1">${offset + i + 1}</td>
      <td class="sticky-col-2"><div class="tg-name">${esc(t.nama || t.username)}</div><div class="tg-user">@${esc(t.username)}</div></td>
      <td><span class="tg-chip">${esc(t.profil || '-')}</span></td>
      <td>${esc(t.periode)}</td>
      <td class="tg-nominal">${rp(t.nominal)}</td>
      <td>${esc(fmtTgl(t.jatuh_tempo))}</td>
      <td>${badge}</td>
      <td>${aksi}</td>
    </tr>`;
  }).join('');
  _injectTgBulkToolbar();
}

function tgGotoPage(p) {
  _tgPage = p;
  renderRows();
  document.getElementById('tg-tbody')?.closest('.table-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterChanged() { _tgPage = 0; renderRows(); }

function sortTagihan(key) {
  if (_tgSortKey === key) {
    _tgSortAsc = !_tgSortAsc;
  } else {
    _tgSortKey = key;
    _tgSortAsc = key === 'jatuh_tempo';
  }
  _tgPage = 0;
  renderRows();
}

// ── Bulk select ──────────────────────────────────────────────
function toggleTgSelect(id, checked) {
  if (checked) _selectedTgIds.add(Number(id));
  else {
    _selectedTgIds.delete(Number(id));
    const cbAll = document.getElementById('tg-cb-all');
    if (cbAll) cbAll.checked = false;
  }
  _updateTgBulkToolbar();
}

function toggleTgSelectAll(checked) {
  document.querySelectorAll('.tg-cb-row').forEach(cb => {
    cb.checked = checked;
    const id = Number(cb.dataset.id);
    if (checked) _selectedTgIds.add(id);
    else _selectedTgIds.delete(id);
  });
  _updateTgBulkToolbar();
}

function clearTgSelection() {
  _selectedTgIds.clear();
  document.querySelectorAll('.tg-cb-row').forEach(cb => cb.checked = false);
  const cbAll = document.getElementById('tg-cb-all');
  if (cbAll) cbAll.checked = false;
  _updateTgBulkToolbar();
}

function _updateTgBulkToolbar() {
  const count   = _selectedTgIds.size;
  const toolbar = document.getElementById('tg-bulk-toolbar');
  if (!toolbar) return;
  toolbar.style.display = count > 0 ? 'flex' : 'none';
  const lbl = document.getElementById('tg-bulk-label');
  if (lbl) lbl.textContent = `${count} dipilih`;
}

function _injectTgBulkToolbar() {
  if (document.getElementById('tg-bulk-toolbar')) return;
  const t = document.createElement('div');
  t.id = 'tg-bulk-toolbar';
  t.style.cssText = 'display:none;position:fixed;bottom:72px;left:50%;transform:translateX(-50%);' +
    'background:var(--text);color:#fff;border-radius:99px;padding:10px 16px;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.3);align-items:center;gap:10px;z-index:200;' +
    'font-size:13px;font-weight:600;white-space:nowrap;';
  t.innerHTML = `
    <span class="material-symbols-outlined" style="font-size:18px">checklist</span>
    <span id="tg-bulk-label">0 dipilih</span>
    <div style="width:1px;height:20px;background:rgba(255,255,255,.25)"></div>
    <button onclick="konfirmasiPiutangMassal()" style="background:var(--purple,#7c3aed);color:#fff;border:none;border-radius:99px;
      padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">handshake</span>Setujui Piutang
    </button>
    <button onclick="konfirmasiHapusMassal()" style="background:var(--red);color:#fff;border:none;border-radius:99px;
      padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">delete</span>Hapus
    </button>
    <button onclick="clearTgSelection()" style="background:rgba(255,255,255,.15);color:#fff;border:none;
      border-radius:99px;padding:6px 10px;cursor:pointer;display:flex;align-items:center;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:16px">close</span>
    </button>`;
  document.body.appendChild(t);
}

function ubahTgPerPage() {
  const s = document.getElementById('tg-per-page');
  if (s) _TG_PER_PAGE = parseInt(s.value) || 50;
  _tgPage = 0;
  renderRows();
}

function _buildPagination(total, current, fnName) {
  let h = `<button class="page-btn" onclick="${fnName}(${current - 1})" ${current === 0 ? 'disabled' : ''}>&laquo;</button>`;
  for (let i = 0; i < total; i++) {
    if (i === 0 || i === total - 1 || (i >= current - 1 && i <= current + 1)) {
      h += `<button class="page-btn ${i === current ? 'active' : ''}" onclick="${fnName}(${i})">${i + 1}</button>`;
    } else if (i === current - 2 || i === current + 2) {
      h += `<button class="page-btn ellipsis" disabled>…</button>`;
    }
  }
  h += `<button class="page-btn" onclick="${fnName}(${current + 1})" ${current >= total - 1 ? 'disabled' : ''}>&raquo;</button>`;
  return h;
}

async function generateTagihan() {
  const periode = document.getElementById('tg-periode').value || periodeNow();
  const jatuhTempoHari = parseInt(document.getElementById('tg-jatuh-tempo-hari').value, 10);
  if (!jatuhTempoHari || jatuhTempoHari < 1 || jatuhTempoHari > 28) {
    toast('Isi tanggal jatuh tempo terlebih dahulu (1–28)', 'warning');
    document.getElementById('tg-jatuh-tempo-hari').focus();
    return;
  }
  if (!confirm(`Buat tagihan untuk semua pelanggan aktif periode ${periode} dengan jatuh tempo tanggal ${jatuhTempoHari}?\n\nTagihan yang sudah ada tidak akan diduplikasi.`)) return;
  const btn = document.getElementById('btn-generate'); btn.disabled = true;
  try {
    const r = await fetch(`${TG_API}/generate`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
      body: JSON.stringify({ periode, jatuh_tempo_hari: jatuhTempoHari }),
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tagihan dibuat' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadTagihan();
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

/* ── Terima pembayaran (modal kustom, ganti prompt() native) ── */
let _bayarTgId = null;
function bayar(id, username, nominal) {
  _bayarTgId = id;
  const elNama = document.getElementById('bayar-tg-nama');
  if (elNama) elNama.textContent = username;
  const elNominal = document.getElementById('bayar-tg-nominal');
  if (elNominal) elNominal.textContent = rp(nominal);
  const elMetode = document.getElementById('bayar-tg-metode');
  if (elMetode) elMetode.value = 'Cash';
  const m = document.getElementById('modal-bayar-tg');
  if (m) m.classList.add('open');
}
function tutupModalBayar() {
  _bayarTgId = null;
  const m = document.getElementById('modal-bayar-tg');
  if (m) m.classList.remove('open');
}
async function eksekusiBayar() {
  if (!_bayarTgId) return;
  const id = _bayarTgId;
  const metode = (document.getElementById('bayar-tg-metode') || {}).value || 'Cash';
  const btn = document.getElementById('btn-bayar-tg-ok');
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
  try {
    const r = await fetch(`${TG_API}/${id}/bayar`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
      body: JSON.stringify({ metode }),
    });
    const d = await r.json();
    toast(r.ok ? (d.message || 'Lunas') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { tutupModalBayar(); loadTagihan(); _openStruk(id); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span>Konfirmasi Lunas'; }
}

/* ── Hapus tagihan ── */
let _hapusTgId = null;
function konfirmasiHapusTagihan(id, nama, periode) {
  _hapusTgId = id;
  const el = document.getElementById('hapus-tg-nama');
  if (el) el.textContent = nama + ' (periode ' + periode + ')';
  const m = document.getElementById('modal-hapus-tg');
  if (m) m.classList.add('open');
}
function tutupModalHapusTg() {
  _hapusTgId = null;
  const m = document.getElementById('modal-hapus-tg');
  if (m) m.classList.remove('open');
}
function konfirmasiHapusMassal() {
  const ids = [..._selectedTgIds];
  if (!ids.length) return;
  _hapusTgId = ids;
  const el = document.getElementById('hapus-tg-nama');
  if (el) el.textContent = `${ids.length} tagihan terpilih`;
  const m = document.getElementById('modal-hapus-tg');
  if (m) m.classList.add('open');
}
async function eksekusiHapusTagihan() {
  if (!_hapusTgId) return;
  const ids = Array.isArray(_hapusTgId) ? _hapusTgId : [_hapusTgId];
  const btn = document.getElementById('btn-hapus-tg-ok');
  if (btn) { btn.disabled = true; btn.textContent = 'Menghapus...'; }
  try {
    if (ids.length === 1) {
      const r = await fetch(`${TG_API}/${ids[0]}`, {
        method: 'DELETE', credentials: 'include', headers: _hdr()
      });
      const d = await r.json();
      toast(r.ok ? (d.message || 'Tagihan dihapus') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
      if (r.ok) { tutupModalHapusTg(); clearTgSelection(); loadTagihan(); }
    } else {
      const results = await Promise.allSettled(ids.map(id =>
        fetch(`${TG_API}/${id}`, { method: 'DELETE', credentials: 'include', headers: _hdr() })
      ));
      const ok = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
      const fail = ids.length - ok;
      toast(fail ? `${ok} tagihan dihapus, ${fail} gagal` : `${ok} tagihan dihapus`, fail ? 'warning' : 'success');
      tutupModalHapusTg(); clearTgSelection(); loadTagihan();
    }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">delete</span>Ya, Hapus'; }
}

/* ── Setujui Piutang ── */
let _piutangTgId = null;
function konfirmasiPiutang(id, nama, periode) {
  _piutangTgId = id;
  const el = document.getElementById('piutang-tg-nama');
  if (el) el.textContent = nama + ' (periode ' + periode + ')';
  const m = document.getElementById('modal-piutang-tg');
  if (m) m.classList.add('open');
}
function tutupModalPiutang() {
  _piutangTgId = null;
  const m = document.getElementById('modal-piutang-tg');
  if (m) m.classList.remove('open');
}
function konfirmasiPiutangMassal() {
  const eligible = _tagihan.filter(t => _selectedTgIds.has(t.id) && t.status !== 'lunas' && t.status !== 'piutang').map(t => t.id);
  if (!eligible.length) { toast('Tidak ada tagihan terpilih yang bisa disetujui piutang (sudah lunas/piutang)', 'warning'); return; }
  const skipped = _selectedTgIds.size - eligible.length;
  if (skipped > 0) toast(`${skipped} tagihan dilewati (sudah lunas/piutang)`, 'warning');
  _piutangTgId = eligible;
  const el = document.getElementById('piutang-tg-nama');
  if (el) el.textContent = `${eligible.length} tagihan terpilih`;
  const m = document.getElementById('modal-piutang-tg');
  if (m) m.classList.add('open');
}
async function eksekusiPiutang() {
  if (!_piutangTgId) return;
  const ids = Array.isArray(_piutangTgId) ? _piutangTgId : [_piutangTgId];
  const btn = document.getElementById('btn-piutang-tg-ok');
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
  try {
    if (ids.length === 1) {
      const r = await fetch(`${TG_API}/${ids[0]}/piutang`, {
        method: 'POST', credentials: 'include', headers: _hdr()
      });
      const d = await r.json();
      toast(r.ok ? (d.message || 'Piutang disetujui') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
      if (r.ok) { tutupModalPiutang(); clearTgSelection(); loadTagihan(); }
    } else {
      const results = await Promise.allSettled(ids.map(id =>
        fetch(`${TG_API}/${id}/piutang`, { method: 'POST', credentials: 'include', headers: _hdr() })
      ));
      const ok = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
      const fail = ids.length - ok;
      toast(fail ? `${ok} piutang disetujui, ${fail} gagal` : `${ok} piutang disetujui`, fail ? 'warning' : 'success');
      tutupModalPiutang(); clearTgSelection(); loadTagihan();
    }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">handshake</span>Ya, Setujui'; }
}

/* ── Struk pembayaran ── */
function _openStruk(tagihanId) {
  const token = localStorage.getItem('tf_token') || '';
  const netId = localStorage.getItem('tf_network_id') || '';
  const url   = `/app/frontend/invoice/struk.html?id=${tagihanId}&token=${encodeURIComponent(token)}&network_id=${encodeURIComponent(netId)}`;
  window.open(url, '_blank', 'width=440,height=700,noopener');
}

/* ── Ekspor PDF (buka halaman cetak laporan di tab baru) ───────── */
function eksporTagihanPdf() {
  const periode = document.getElementById('tg-periode').value || periodeNow();
  const status  = document.getElementById('tg-status').value || '';

  const params = new URLSearchParams();
  params.set('jenis', 'tagihan');
  params.set('periode', periode);
  if (status) params.set('status', status);

  window.open(`/app/frontend/laporan/laporan.html?${params}`, '_blank');
}

/* ── Toggle Isolir Otomatis ── */
function _setAutoIsolirLabel(enabled) {
  const lbl = document.getElementById('auto-isolir-label');
  if (lbl) lbl.textContent = enabled ? 'Aktif' : 'Nonaktif';
}

async function loadAutoIsolirConfig() {
  try {
    const r = await fetch(`${TG_API}/auto-isolir/config`, { credentials: 'include', headers: _hdr() });
    const d = await r.json();
    const chk = document.getElementById('cfg-auto-isolir');
    if (chk) chk.checked = !!d.enabled;
    _setAutoIsolirLabel(!!d.enabled);
  } catch { /* diamkan — biarkan default nonaktif */ }
}

async function toggleAutoIsolir() {
  const chk = document.getElementById('cfg-auto-isolir');
  const enabled = chk.checked;
  chk.disabled = true;
  try {
    const r = await fetch(`${TG_API}/auto-isolir/config`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
      body: JSON.stringify({ enabled }),
    });
    const d = await r.json();
    if (r.ok) {
      _setAutoIsolirLabel(enabled);
      toast(d.message || 'Tersimpan', 'success');
    } else {
      chk.checked = !enabled;
      toast(d.message || 'Gagal menyimpan', 'danger');
    }
  } catch {
    chk.checked = !enabled;
    toast('Tidak bisa menghubungi server', 'danger');
  }
  chk.disabled = false;
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('tg-periode').value = periodeNow();
  loadTagihan();
  loadAutoIsolirConfig();
});
