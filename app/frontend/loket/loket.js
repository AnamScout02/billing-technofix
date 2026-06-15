/* loket.js — Loket / Kasir Terpadu (kolektor + owner/admin) v3 */
'use strict';

const LK_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/loket';
let _tagihan      = [];
let _komisiCfg    = { tipe: 'persen', nilai: 0 };
let _debTimer     = null;
let _selectedLkIds = new Set();
let _bayarQueue   = [];   // ids untuk bulk bayar
let _bayarSingle  = null; // { id, nama, nominal, komisi } untuk bayar satuan
let _lkPage       = 0;
let _LK_PER_PAGE  = 50;
let _lkSortKey    = null;
let _lkSortAsc    = true;

function _hdr()  { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function _jhdr() { return Object.assign({ 'Content-Type': 'application/json' }, _hdr()); }
function esc(s)  { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function rp(n)   { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtTgl(s) { if (!s) return '-'; try { return new Date(s).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' }); } catch { return s; } }
function periodeNow() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function setT(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function stateRow(cols, msg) { return `<tr><td colspan="${cols}"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`; }

const _role    = () => localStorage.getItem('tf_role') || '';
const _isKol   = () => _role() === 'kolektor';
const _kolParam = () => { const el = document.getElementById('lk-filter-kol'); return el ? (el.value || '') : ''; };

// ── Role-aware nav ─────────────────────────────────────────────
function _applyRoleNav() {
  if (!_isKol()) return;
  // Kolektor: sembunyikan seluruh topbar nav — hanya loket yang relevan
  const nav = document.querySelector('.topbar-nav');
  if (nav) nav.style.display = 'none';
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) bottomNav.style.display = 'none';
  // Sembunyikan tombol Atur Komisi (hanya untuk owner/admin)
  const btnKomisi = document.getElementById('btn-atur-komisi');
  if (btnKomisi) btnKomisi.style.display = 'none';
  // Sembunyikan filter kolektor
  const filterRow = document.getElementById('lk-kol-filter-row');
  if (filterRow) filterRow.style.display = 'none';
}

// ── Tabs ───────────────────────────────────────────────────────
function switchTab(t) {
  document.getElementById('tab-loket').classList.toggle('active', t === 'loket');
  document.getElementById('tab-rekap').classList.toggle('active', t === 'rekap');
  document.getElementById('panel-loket').style.display = t === 'loket' ? '' : 'none';
  document.getElementById('panel-rekap').style.display = t === 'rekap' ? '' : 'none';
  if (t === 'rekap') loadRekap();
}

// ── Stat cards ─────────────────────────────────────────────────
async function loadStats() {
  const kol = _kolParam();
  const qs  = kol ? '?kolektor=' + encodeURIComponent(kol) : '';
  try {
    const r = await fetch(`${LK_API}/stats${qs}`, { credentials: 'include', headers: _hdr() });
    const d = await r.json();
    const s = d.stats || {};
    setT('st-total',   s.total_pelanggan  || 0);
    setT('st-lunas',   s.lunas_ini        || 0);
    setT('st-belum',   s.belum_bayar      || 0);
    setT('st-belum-nom', s.belum_bayar > 0 ? rp(s.nominal_belum) : '');
    setT('st-tung',    s.tunggakan        || 0);
    setT('st-tung-nom', s.tunggakan > 0 ? rp(s.nominal_tung) : '');
    setT('st-setor',   s.setoran_hari_ini || 0);
    setT('st-setor-nom', s.setoran_hari_ini > 0 ? rp(s.nominal_setoran) : '');
  } catch { /* abaikan */ }
}

// ── Filter kolektor (owner/admin) ──────────────────────────────
async function loadKolektorList() {
  if (_isKol()) return;
  try {
    const r = await fetch(`${LK_API}/kolektor-list`, { credentials: 'include', headers: _hdr() });
    const d = await r.json();
    const sel = document.getElementById('lk-filter-kol');
    if (!sel) return;
    (d.kolektor || []).forEach(k => {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      sel.appendChild(opt);
    });
  } catch { /* abaikan */ }
}

function onKolFilterChange() { loadStats(); loadTagihan(); }

// ── Komisi banner ──────────────────────────────────────────────
function renderKomisiBanner() {
  const el = document.getElementById('komisi-banner-text');
  if (!el) return;
  el.textContent = _komisiCfg.nilai > 0
    ? (_komisiCfg.tipe === 'flat'
        ? `Komisi kolektor: ${rp(_komisiCfg.nilai)} per tagihan`
        : `Komisi kolektor: ${_komisiCfg.nilai}% dari nominal tagihan`)
    : 'Komisi belum diatur (0). Klik "Atur Komisi" untuk menetapkan.';
}

// ── Tagihan ────────────────────────────────────────────────────
function debLoad() { clearTimeout(_debTimer); _debTimer = setTimeout(loadTagihan, 300); }

async function loadTagihan() {
  const q       = (document.getElementById('lk-search').value || '').trim();
  const periode = document.getElementById('lk-periode').value || '';
  const kol     = _kolParam();
  const tb      = document.getElementById('lk-tbody');
  tb.innerHTML  = stateRow(9, '');
  tb.innerHTML  = '<tr><td colspan="9"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';

  const qs = new URLSearchParams();
  if (q)       qs.set('q', q);
  if (periode) qs.set('periode', periode);
  if (kol)     qs.set('kolektor', kol);

  try {
    const r = await fetch(`${LK_API}/tagihan?${qs}`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { tb.innerHTML = stateRow(9, 'Anda tidak punya akses ke loket.'); return; }
    const d = await r.json();
    _tagihan = d.tagihan || [];
    _lkPage  = 0;
    if (d.komisi_config) { _komisiCfg = d.komisi_config; renderKomisiBanner(); }
    _selectedLkIds.clear();
    _updateLkBulkToolbar();
    const cbAll = document.getElementById('lk-cb-all');
    if (cbAll) cbAll.checked = false;
    renderTagihan();
  } catch { tb.innerHTML = stateRow(9, 'Gagal memuat tagihan.'); }
}

function renderTagihan() {
  const tb     = document.getElementById('lk-tbody');
  const cnt    = document.getElementById('lk-count');
  const pgWrap = document.getElementById('lk-pagination');
  if (!_tagihan.length) {
    tb.innerHTML = stateRow(9, 'Tidak ada tagihan belum lunas.');
    if (cnt) cnt.textContent = '0 tagihan';
    if (pgWrap) pgWrap.style.display = 'none';
    return;
  }
  const pNow = periodeNow();
  const list = _sortedTagihan();
  const ini  = list.filter(t => !t.tunggakan);
  const tung = list.filter(t => t.tunggakan);
  const total = list.length;

  // Paginasi seluruh daftar (ini + tung disatukan)
  const totalPages = Math.ceil(total / _LK_PER_PAGE) || 1;
  _lkPage = Math.min(_lkPage, totalPages - 1);
  const offset = _lkPage * _LK_PER_PAGE;
  const slice  = list.slice(offset, offset + _LK_PER_PAGE);

  if (cnt) cnt.textContent = total + ' tagihan belum lunas' + (tung.length ? ` (${tung.length} tunggakan)` : '')
    + (total > _LK_PER_PAGE ? ` · tampil ${offset + 1}–${Math.min(offset + _LK_PER_PAGE, total)}` : '');

  // Render baris dengan header seksi
  let html = '';
  let prevTung = null;
  slice.forEach((t, i) => {
    const isTung = !!t.tunggakan;
    if (!isTung && prevTung !== false) {
      html += `<tr class="lk-section-hdr"><td colspan="9"><span class="material-symbols-outlined">receipt_long</span> Bulan Ini (${pNow}) — ${ini.length} tagihan</td></tr>`;
    }
    if (isTung && prevTung !== true) {
      html += `<tr class="lk-section-hdr lk-section-tung"><td colspan="9"><span class="material-symbols-outlined">warning</span> Tunggakan Bulan Lalu — ${tung.length} tagihan</td></tr>`;
    }
    prevTung = isTung;
    html += _rowHtml(t, offset + i + 1, isTung);
  });
  tb.innerHTML = html;
  _injectLkBulkToolbar();

  if (pgWrap) {
    if (totalPages > 1) {
      pgWrap.style.display = 'flex';
      pgWrap.innerHTML = _buildPagination(totalPages, _lkPage, 'lkGotoPage');
    } else {
      pgWrap.style.display = 'none';
    }
  }
}

function lkGotoPage(p) {
  _lkPage = p;
  renderTagihan();
  document.getElementById('lk-tbody')?.closest('.table-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function ubahLkPerPage() {
  const s = document.getElementById('lk-per-page');
  if (s) _LK_PER_PAGE = parseInt(s.value) || 50;
  _lkPage = 0;
  renderTagihan();
}

// Urutkan, tapi tetap pertahankan grouping "Bulan Ini" sebelum "Tunggakan"
function _sortedTagihan() {
  let list = _tagihan.slice();
  if (_lkSortKey) {
    list.sort((a, b) => {
      if (!!a.tunggakan !== !!b.tunggakan) return a.tunggakan ? 1 : -1;
      const va = Number(a[_lkSortKey]) || 0;
      const vb = Number(b[_lkSortKey]) || 0;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return _lkSortAsc ? cmp : -cmp;
    });
  }
  return list;
}

function sortLoket(key) {
  if (_lkSortKey === key) {
    _lkSortAsc = !_lkSortAsc;
  } else {
    _lkSortKey = key;
    _lkSortAsc = false; // terbesar dulu
  }
  _lkPage = 0;
  renderTagihan();
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

function _rowHtml(t, no, isTung) {
  return `<tr${isTung ? ' class="lk-row-tung"' : ''}>
    <td class="sticky-col-0"><input type="checkbox" class="lk-cb-row"
      data-id="${t.id}" data-nama="${esc(t.nama)}" data-nominal="${t.nominal}" data-komisi="${t.komisi}"
      onchange="toggleLkSelect(${t.id},this.checked)"
      style="width:15px;height:15px;accent-color:var(--primary);cursor:pointer" /></td>
    <td class="sticky-col-1">${no}</td>
    <td class="sticky-col-2"><div class="lk-name">${esc(t.nama)}${t.isolir ? ' <span class="lk-badge-isolir" title="Koneksi sedang dibatasi krn nunggak">Terisolir</span>' : ''}${t.status === 'piutang' ? ' <span class="lk-badge-piutang" title="Sudah disetujui piutang — internet aktif, tagihan belum dibayar">Piutang</span>' : ''}</div><div class="lk-sub">@${esc(t.username)}</div></td>
    <td><span class="lk-chip">${esc(t.profil || '-')}</span></td>
    <td>${esc(t.periode)}</td>
    <td class="lk-nominal">${rp(t.nominal)}</td>
    <td>${esc(fmtTgl(t.jatuh_tempo))}</td>
    <td class="lk-komisi">${rp(t.komisi)}</td>
    <td><button class="btn-terima" onclick="openBayar(${t.id},'${esc(t.nama)}',${t.nominal},${t.komisi},'${esc(t.username)}')">
      <span class="material-symbols-outlined">point_of_sale</span>Terima</button></td>
  </tr>`;
}

// ── Bulk select ────────────────────────────────────────────────
function toggleLkSelect(id, checked) {
  if (checked) _selectedLkIds.add(Number(id));
  else {
    _selectedLkIds.delete(Number(id));
    const cbAll = document.getElementById('lk-cb-all');
    if (cbAll) cbAll.checked = false;
  }
  _updateLkBulkToolbar();
}

function toggleLkSelectAll(checked) {
  _selectedLkIds.clear();
  document.querySelectorAll('.lk-cb-row').forEach(cb => {
    cb.checked = checked;
    if (checked) _selectedLkIds.add(Number(cb.dataset.id));
  });
  _updateLkBulkToolbar();
}

function _updateLkBulkToolbar() {
  const count   = _selectedLkIds.size;
  const toolbar = document.getElementById('lk-bulk-toolbar');
  if (!toolbar) return;
  toolbar.style.display = count > 0 ? 'flex' : 'none';
  const lbl = document.getElementById('lk-bulk-label');
  if (lbl) {
    const total = [...document.querySelectorAll('.lk-cb-row')]
      .filter(cb => _selectedLkIds.has(Number(cb.dataset.id)))
      .reduce((s, cb) => s + Number(cb.dataset.nominal), 0);
    lbl.textContent = `${count} tagihan · ${rp(total)}`;
  }
}

function _injectLkBulkToolbar() {
  if (document.getElementById('lk-bulk-toolbar')) return;
  const t = document.createElement('div');
  t.id = 'lk-bulk-toolbar';
  t.style.cssText = 'display:none;position:fixed;bottom:72px;left:50%;transform:translateX(-50%);' +
    'background:var(--text);color:#fff;border-radius:99px;padding:10px 16px;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.3);align-items:center;gap:10px;z-index:200;' +
    'font-size:13px;font-weight:600;white-space:nowrap;';
  t.innerHTML = `
    <span class="material-symbols-outlined" style="font-size:18px">checklist</span>
    <span id="lk-bulk-label">0 dipilih</span>
    <div style="width:1px;height:20px;background:rgba(255,255,255,.25)"></div>
    <button onclick="terimaBulk()" style="background:var(--green);color:#fff;border:none;border-radius:99px;
      padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">point_of_sale</span>Terima Terpilih
    </button>
    <button onclick="clearLkSelection()" style="background:rgba(255,255,255,.15);color:#fff;border:none;
      border-radius:99px;padding:6px 10px;cursor:pointer;display:flex;align-items:center;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:16px">close</span>
    </button>`;
  document.body.appendChild(t);
}

function clearLkSelection() {
  _selectedLkIds.clear();
  document.querySelectorAll('.lk-cb-row').forEach(cb => cb.checked = false);
  const cbAll = document.getElementById('lk-cb-all');
  if (cbAll) cbAll.checked = false;
  _updateLkBulkToolbar();
}

// ── Modal Bayar (satuan & bulk) ────────────────────────────────
function openBayar(id, nama, nominal, komisi, username) {
  // Cek apakah pelanggan ini punya lebih dari 1 tagihan di daftar saat ini
  const semuaTagihanPelanggan = username
    ? _tagihan.filter(t => t.username === username)
    : [];

  if (semuaTagihanPelanggan.length > 1) {
    // Tampilkan modal pilih tagihan dulu
    _openPilihTagihan(semuaTagihanPelanggan, nama, username);
    return;
  }

  // Satu tagihan — langsung ke modal bayar
  _bayarSingle = { id, nama, nominal, komisi };
  _bayarQueue  = [];
  document.getElementById('bayar-title').textContent  = 'Terima Pembayaran';
  document.getElementById('bayar-info').innerHTML     =
    `<strong>${esc(nama)}</strong> — ${rp(nominal)}<br><small style="color:var(--text-muted)">Komisi: ${rp(komisi)}</small>`;
  document.getElementById('bayar-metode').value = 'Cash';
  document.getElementById('bayar-overlay').classList.add('show');
  document.getElementById('bayar-modal').classList.add('show');
}

// ── Modal Pilih Tagihan (saat pelanggan punya tunggakan) ────────
function _openPilihTagihan(list, nama, username) {
  let modal = document.getElementById('modal-pilih-tagihan');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-pilih-tagihan';
    modal.className = 'modal-overlay';
    modal.onclick = e => { if (e.target === modal) _closePilihTagihan(); };
    document.body.appendChild(modal);
  }

  const rows = list.map(t => {
    const isPiutang = t.status === 'piutang';
    const label = isPiutang ? 'Piutang' : 'Belum Bayar';
    const labelStyle = isPiutang
      ? 'background:var(--purple-bg,#f3e8ff);color:var(--purple,#7c3aed)'
      : 'background:var(--amber-bg);color:var(--amber)';
    return `<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;
        border:1.5px solid var(--border);border-radius:var(--r-md);cursor:pointer;
        transition:border-color .15s" class="pilih-tg-row">
      <input type="checkbox" class="pilih-tg-cb" value="${t.id}"
        data-nominal="${t.nominal}" data-komisi="${t.komisi || 0}"
        style="width:16px;height:16px;accent-color:var(--primary);cursor:pointer" checked>
      <span style="flex:1;min-width:0">
        <span style="font-size:13px;font-weight:700">${esc(t.periode)}</span>
        <span style="display:block;font-size:11.5px;color:var(--text-dim)">${rp(t.nominal)}</span>
      </span>
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;${labelStyle}">${label}</span>
    </label>`;
  }).join('');

  modal.innerHTML = `<div class="modal-sheet" onclick="event.stopPropagation()" style="max-width:400px">
    <div class="modal-handle"></div>
    <div style="font-size:15px;font-weight:800;font-family:var(--heading);margin-bottom:4px">Pilih Tagihan</div>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px">
      <strong>${esc(nama)}</strong> punya ${list.length} tagihan belum lunas. Pilih yang mau dibayar sekarang:
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto" id="pilih-tg-list">
      ${rows}
    </div>
    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn" onclick="_closePilihTagihan()" style="flex:1">Batal</button>
      <button class="btn btn-primary" onclick="_konfirmasiPilihTagihan('${esc(nama)}')" style="flex:2">
        <span class="material-symbols-outlined">point_of_sale</span>Lanjut Bayar
      </button>
    </div>
  </div>`;
  modal.classList.add('open');

  // border highlight saat checkbox berubah
  modal.querySelectorAll('.pilih-tg-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.pilih-tg-row').style.borderColor = cb.checked ? 'var(--primary)' : 'var(--border)';
    });
    cb.closest('.pilih-tg-row').style.borderColor = 'var(--primary)'; // default semua checked
  });
}

function _closePilihTagihan() {
  const m = document.getElementById('modal-pilih-tagihan');
  if (m) m.classList.remove('open');
}

function _konfirmasiPilihTagihan(nama) {
  const cbs = document.querySelectorAll('.pilih-tg-cb:checked');
  if (!cbs.length) { toast('Pilih minimal 1 tagihan', 'warning'); return; }

  const ids = [...cbs].map(cb => Number(cb.value));
  const totalNominal = [...cbs].reduce((s, cb) => s + Number(cb.dataset.nominal), 0);

  _closePilihTagihan();

  if (ids.length === 1) {
    const t = _tagihan.find(x => x.id === ids[0]);
    if (t) {
      _bayarSingle = { id: t.id, nama: t.nama, nominal: t.nominal, komisi: t.komisi || 0 };
      _bayarQueue  = [];
      document.getElementById('bayar-title').textContent = 'Terima Pembayaran';
      document.getElementById('bayar-info').innerHTML =
        `<strong>${esc(t.nama)}</strong> — ${rp(t.nominal)}<br><small style="color:var(--text-muted)">Komisi: ${rp(t.komisi || 0)}</small>`;
    }
  } else {
    _bayarQueue  = ids;
    _bayarSingle = null;
    document.getElementById('bayar-title').textContent = `Terima ${ids.length} Tagihan`;
    document.getElementById('bayar-info').innerHTML =
      `<strong>${esc(nama)}</strong> — ${ids.length} tagihan<br><strong>Total: ${rp(totalNominal)}</strong>`;
  }

  document.getElementById('bayar-metode').value = 'Cash';
  document.getElementById('bayar-overlay').classList.add('show');
  document.getElementById('bayar-modal').classList.add('show');
}

function terimaBulk() {
  if (!_selectedLkIds.size) return;
  const ids   = [..._selectedLkIds];
  const total = [...document.querySelectorAll('.lk-cb-row')]
    .filter(cb => ids.includes(Number(cb.dataset.id)))
    .reduce((s, cb) => s + Number(cb.dataset.nominal), 0);
  _bayarQueue  = ids;
  _bayarSingle = null;
  document.getElementById('bayar-title').textContent = `Terima ${ids.length} Tagihan`;
  document.getElementById('bayar-info').innerHTML    =
    `<strong>${ids.length} tagihan dipilih</strong><br>Total: <strong>${rp(total)}</strong>`;
  document.getElementById('bayar-metode').value = 'Cash';
  document.getElementById('bayar-overlay').classList.add('show');
  document.getElementById('bayar-modal').classList.add('show');
}

function closeBayar() {
  document.getElementById('bayar-overlay').classList.remove('show');
  document.getElementById('bayar-modal').classList.remove('show');
}

async function submitBayar() {
  const metode = document.getElementById('bayar-metode').value || 'Cash';
  const btn    = document.getElementById('bayar-submit');
  btn.disabled = true;

  if (_bayarSingle) {
    const r = await fetch(`${LK_API}/bayar`, { method:'POST', credentials:'include', headers:_jhdr(),
      body: JSON.stringify({ tagihan_id: _bayarSingle.id, metode }) });
    const d = await r.json();
    toast(r.ok ? (d.message || 'Diterima') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) {
      closeBayar(); loadStats(); loadTagihan();
      _openStruk(_bayarSingle.id);
    }
  } else {
    let ok = 0, fail = 0, lastOkId = null;
    for (const id of _bayarQueue) {
      const r = await fetch(`${LK_API}/bayar`, { method:'POST', credentials:'include', headers:_jhdr(),
        body: JSON.stringify({ tagihan_id: id, metode }) });
      if (r.ok) { ok++; lastOkId = id; } else fail++;
    }
    toast(`${ok} tagihan diterima${fail ? ', ' + fail + ' gagal' : ''}`, fail ? 'warning' : 'success');
    closeBayar();
    clearLkSelection();
    loadStats();
    loadTagihan();
    if (ok === 1 && lastOkId) _openStruk(lastOkId);
  }
  btn.disabled = false;
}

function _openStruk(tagihanId) {
  const token   = localStorage.getItem('tf_token') || '';
  const netId   = localStorage.getItem('tf_network_id') || '';
  const url     = `/app/frontend/invoice/struk.html?id=${tagihanId}&token=${encodeURIComponent(token)}&network_id=${encodeURIComponent(netId)}`;
  window.open(url, '_blank', 'width=440,height=700,noopener');
}

// ── Rekap ──────────────────────────────────────────────────────
async function loadRekap() {
  const periode = document.getElementById('rk-periode').value || periodeNow();
  const tb = document.getElementById('rk-tbody');
  tb.innerHTML = '<tr><td colspan="5"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const r = await fetch(`${LK_API}/rekap?periode=${periode}`, { credentials:'include', headers:_hdr() });
    const d = await r.json();
    const tot = d.total || {};
    setT('rk-jumlah', tot.jumlah || 0);
    setT('rk-total',  rp(tot.total_tagihan || 0));
    setT('rk-komisi', rp(tot.total_komisi  || 0));
    const list = d.rekap || [];
    if (!list.length) { tb.innerHTML = stateRow(5, 'Belum ada setoran pada periode ini.'); return; }
    tb.innerHTML = list.map((x, i) => `<tr>
      <td class="rk-col-num">${i + 1}</td>
      <td class="rk-col-kol"><div class="lk-name">${esc(x.kolektor)}</div></td>
      <td>${x.jumlah}</td>
      <td class="lk-nominal">${rp(x.total_tagihan)}</td>
      <td class="lk-komisi">${rp(x.total_komisi)}</td>
    </tr>`).join('');
  } catch { tb.innerHTML = stateRow(5, 'Gagal memuat rekap.'); }
}

// ── Modal komisi ───────────────────────────────────────────────
function openKomisi() {
  document.getElementById('km-tipe').value  = _komisiCfg.tipe;
  document.getElementById('km-nilai').value = _komisiCfg.nilai;
  kmTipeChange();
  document.getElementById('km-overlay').classList.add('show');
  document.getElementById('km-modal').classList.add('show');
}
function closeKomisi() {
  document.getElementById('km-overlay').classList.remove('show');
  document.getElementById('km-modal').classList.remove('show');
}
function kmTipeChange() {
  document.getElementById('km-nilai-label').textContent =
    document.getElementById('km-tipe').value === 'flat' ? 'Nilai (Rp per tagihan)' : 'Nilai (%)';
}
async function saveKomisi() {
  const tipe  = document.getElementById('km-tipe').value;
  const nilai = parseInt(document.getElementById('km-nilai').value || '0', 10);
  if (isNaN(nilai) || nilai < 0) { toast('Nilai komisi tidak valid', 'danger'); return; }
  if (tipe === 'persen' && nilai > 100) { toast('Persentase maksimal 100', 'danger'); return; }
  const btn = document.getElementById('km-save'); btn.disabled = true;
  try {
    const r = await fetch(`${LK_API}/config`, { method:'POST', credentials:'include', headers:_jhdr(),
      body: JSON.stringify({ tipe, nilai }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { _komisiCfg = { tipe, nilai }; renderKomisiBanner(); closeKomisi(); loadTagihan(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('lk-periode').value = periodeNow();
  document.getElementById('rk-periode').value = periodeNow();
  _applyRoleNav();
  loadKolektorList();
  loadStats();
  loadTagihan();
});
