/* ============================================================
   pelanggan.js — Manajemen Pelanggan TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML

   ✅ Fungsi dari global.js yang dipakai:
      API_BASE, escHtml, val, animNum, toast,
      togglePwd, parseRxTx, openModalForm, closeModalForm

   ✅ PEMBARUAN — One-Click Provisioning:
      - simpanPelanggan()  → payload lengkap (MikroTik + OLT + HP)
      - openEdit()         → auto-fill No HP & parameter OLT dari cache
      - openDetail()       → tampilkan No HP & Data OLT di detail
      - renderTabel()      → tampilkan kolom No HP dari data (sudah ada di HTML)
      - loadOltOptions()   → load OLT ke cache global (oltCache)

   Endpoint yang dipakai:
   GET    /devices                        → daftar perangkat
   GET    /api/pelanggan/<device_id>      → pelanggan per perangkat (termasuk hp)
   GET    /api/pelanggan/<device_id>/rx-tx → data RX/TX power ONU
   POST   /api/pelanggan                  → tambah pelanggan (provisioning)
   PUT    /api/pelanggan/<id>             → edit pelanggan (update OLT)
   DELETE /api/pelanggan/<id>             → hapus pelanggan
   GET    /olt                            → daftar OLT (untuk form & cache)
   ============================================================ */

'use strict';

/* ── CONFIG ── */
let PER_PAGE = 50;

/* ── STATE ── */
let _allData = [];
let _filteredData = [];
let currentPage = 1;
let _editingId = null;
let selectedDevice = null;

// Cache RX/TX dari endpoint terpisah
let rxTxCache = {};

// ── Sort state ──
let sortCol = null;   // 'rx' saat ini
let sortDir = 'desc'; // 'asc' | 'desc'

// ── BARU: Cache daftar OLT (agar tidak re-fetch setiap buka form) ──
let oltCache = [];   // Array of { id, name, tipe, ip }

// ── Pilihan massal checkbox ──
let _selectedIds = new Set();   // Set berisi id pelanggan yang dicentang


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Kolektor → halaman loket adalah satu-satunya workspace mereka
  const _role = localStorage.getItem('tf_role') || '';
  if (_role === 'kolektor') {
    window.location.replace('/app/frontend/loket/loket.html');
    return;
  }

  // Baca URL param ?status=offline dari dashboard → pre-set filter
  const _urlStatus = new URLSearchParams(window.location.search).get('status');
  if (_urlStatus) {
    const _selStatus = document.getElementById('filter-status');
    if (_selStatus) {
      const _cap = _urlStatus.charAt(0).toUpperCase() + _urlStatus.slice(1).toLowerCase();
      _selStatus.value = _cap;
    }
  }

  loadDevices();
  loadOltCache();  // load OLT ke cache saat halaman dibuka

  // Jika datang dari Maps (kolektor klik Bayar), langsung scroll ke pelanggan tersebut
  const mapsTarget = sessionStorage.getItem('kol_maps_target');
  if (mapsTarget) {
    sessionStorage.removeItem('kol_maps_target');
    // Tunggu data dimuat lalu highlight
    setTimeout(() => {
      const el = document.querySelector('[data-username="' + CSS.escape(mapsTarget) + '"]');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.click(); }
    }, 2000);
  }

  // Jika kembali dari halaman detail dengan intent edit, buka form edit
  const pendingEditId = sessionStorage.getItem('tf_edit_pelanggan_id');
  if (pendingEditId) {
    sessionStorage.removeItem('tf_edit_pelanggan_id');
    // Poll sampai loadPelanggan() selesai mengisi _allData[]
    const _poll = setInterval(() => {
      const p = _allData.find(item => String(item.id) === pendingEditId);
      if (p) { clearInterval(_poll); showFormPelanggan(p); }
    }, 300);
    setTimeout(() => clearInterval(_poll), 10000);
  }
});


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR PERANGKAT
   GET /devices → isi <select id="select-device">
══════════════════════════════════════════════════════════ */
const DEVICES_CACHE_KEY = 'tf_devices_cache';

function _renderDeviceSelect(data) {
  const selHeader = document.getElementById('select-device');
  const prevValue = selHeader.value;
  selHeader.innerHTML = '<option value="">— Pilih Perangkat —</option>';
  data.forEach(d => {
    selHeader.appendChild(new Option(`${d.name}  (${d.ip})`, d.id));
  });

  const savedDevice = localStorage.getItem('lastSelectedDevice');
  if (prevValue && data.some(d => d.id == prevValue)) {
    selHeader.value = prevValue;
  } else if (savedDevice && data.some(d => d.id == savedDevice)) {
    selHeader.value = savedDevice;
  } else if (data.length === 1) {
    selHeader.value = data[0].id;
  } else {
    selectedDevice = null;
  }
}

async function loadDevices() {
  // ── Stale-while-revalidate: tampilkan daftar perangkat dari cache
  // localStorage dulu (instan), lalu refresh di background ──
  let cached = null;
  try {
    const raw = localStorage.getItem(DEVICES_CACHE_KEY);
    cached = raw ? JSON.parse(raw) : null;
  } catch (e) { cached = null; }

  if (cached && cached.length) {
    _renderDeviceSelect(cached);
    loadPelanggan();
  }

  try {
    const res = await fetch(`${API_BASE}/devices`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();

    localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify(data));

    if (!cached || JSON.stringify(cached) !== JSON.stringify(data)) {
      _renderDeviceSelect(data);
      loadPelanggan();
    }
  } catch (err) {
    if (!cached) tampilError('Gagal memuat daftar perangkat. Pastikan server Python berjalan.');
  }
}


/* ══════════════════════════════════════════════════════════
   1b. LOAD OLT KE CACHE GLOBAL
   GET /olt → simpan ke oltCache[]
   ← BARU: dipakai untuk auto-fill form edit & generate CLI
══════════════════════════════════════════════════════════ */
async function loadOltCache() {
  try {
    const res = await fetch(`${API_BASE}/olt`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    oltCache = Array.isArray(data) ? data : [];
  } catch (_) {
    oltCache = [];
  }
}


/* ══════════════════════════════════════════════════════════
   2. LOAD PELANGGAN
   GET /api/pelanggan/<device_id>
   + GET /api/pelanggan/<device_id>/rx-tx
══════════════════════════════════════════════════════════ */
async function loadPelanggan() {
  const deviceId = document.getElementById('select-device').value;

  if (!deviceId) {
    localStorage.removeItem('lastSelectedDevice');
    selectedDevice = null;
    rxTxCache = {};
    tampilEmpty();
    return;
  }

  localStorage.setItem('lastSelectedDevice', deviceId);

  const selEl = document.getElementById('select-device');
  selectedDevice = { id: deviceId, name: selEl.options[selEl.selectedIndex].text };

  tampilLoading();
  animasiRefresh(true);

  try {
    // ── Muat data pelanggan dan RX/TX secara paralel ──
    const [resPelanggan, resRxTx] = await Promise.allSettled([
      fetch(`${API_BASE}/api/pelanggan/${deviceId}`, { credentials: 'include', headers: getAuthHeaders() }),
      fetch(`${API_BASE}/api/pelanggan/${deviceId}/rx-tx`, { credentials: 'include', headers: getAuthHeaders() }),
    ]);

    // Data pelanggan (wajib)
    if (resPelanggan.status === 'rejected' || !resPelanggan.value.ok) {
      const errMsg = resPelanggan.reason
        || (await resPelanggan.value.json().catch(() => ({}))).error
        || 'Gagal mengambil data pelanggan';
      throw new Error(errMsg);
    }

    const dataPelanggan = await resPelanggan.value.json();
    _allData = Array.isArray(dataPelanggan) ? dataPelanggan : [];

    // Tandai mode fallback: MikroTik tidak bisa dihubungi (mis. mati lampu).
    // Backend tetap mengirim data terakhir dari DB lokal (status dipaksa Offline).
    if (resPelanggan.value.headers.get('X-Mikrotik-Connected') === '0') {
      toast('Perangkat MikroTik sedang tidak bisa dihubungi — menampilkan data terakhir, status pelanggan dianggap offline.', 'warning');
    }

    // Data RX/TX (opsional — tidak fatal jika gagal)
    rxTxCache = {};
    if (resRxTx.status === 'fulfilled' && resRxTx.value.ok) {
      try {
        const rxTxList = await resRxTx.value.json();
        rxTxList.forEach(item => {
          if (item.username) {
            rxTxCache[item.username] = {
              rx_power: item.rx_power,
              tx_power: item.tx_power,
              source: item.source,
            };
          }
        });
      } catch (_) { /* RX/TX gagal → pakai field bawaan pelanggan */ }
    }

    // Merge RX/TX dari cache ke data pelanggan
    _allData = _allData.map(p => {
      const cached = rxTxCache[p.username];
      if (cached) {
        return {
          ...p,
          rx_power: cached.rx_power ?? p.rx_power,
          tx_power: cached.tx_power ?? p.tx_power,
        };
      }
      return p;
    });

    // Reset pilihan massal setiap data segar di-load
    _selectedIds.clear();
    _updateBulkBar();

    updateStats();
    filterPelanggan();
    updateSyncStatus(true);

  } catch (err) {
    tampilError(err.message);
    updateSyncStatus(false);
  } finally {
    animasiRefresh(false);
  }
}


/* ══════════════════════════════════════════════════════════
   2b. REFRESH RX/TX REALTIME
══════════════════════════════════════════════════════════ */
async function refreshRxTx() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  toast('Mengambil data RX/TX dari OLT secara realtime...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${deviceId}/rx-tx?realtime=1`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Gagal mengambil data realtime');

    const rxTxList = await res.json();
    rxTxCache = {};
    rxTxList.forEach(item => {
      if (item.username) {
        rxTxCache[item.username] = {
          rx_power: item.rx_power,
          tx_power: item.tx_power,
          source: 'realtime',
        };
      }
    });

    _allData = _allData.map(p => {
      const cached = rxTxCache[p.username];
      return cached ? { ...p, rx_power: cached.rx_power, tx_power: cached.tx_power } : p;
    });

    filterPelanggan();
    toast('Data RX/TX berhasil diperbarui', 'success');

  } catch (err) {
    toast(err.message, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   3. FILTER + SEARCH
══════════════════════════════════════════════════════════ */
function filterPelanggan() {
  const keyword = (document.getElementById('input-search')?.value || '').toLowerCase().trim();
  const status = document.getElementById('filter-status')?.value || '';
  const redaman = document.getElementById('filter-redaman')?.value || '';

  _filteredData = _allData.filter(p => {
    const matchKeyword =
      !keyword ||
      (p.username || '').toLowerCase().includes(keyword) ||
      (p.hp || '').toLowerCase().includes(keyword) ||
      (p.profil || '').toLowerCase().includes(keyword) ||
      (p.sn || '').toLowerCase().includes(keyword) ||
      String(p.slot_port || '').toLowerCase().includes(keyword) ||
      String(p.vlan || '').toLowerCase().includes(keyword) ||
      (p.koordinat || '').toLowerCase().includes(keyword);

    const matchStatus =
      !status ||
      (status === 'aktif' && p.status === 'Online') ||
      (status === 'nonaktif' && p.status !== 'Online');

    let matchRedaman = true;
    if (redaman) {
      const rxInfo = parseRxTx(p, p.status === 'Online');
      const rxClass = rxInfo.rxClass;
      if      (redaman === 'bagus')  matchRedaman = rxClass === 'rx-bagus';
      else if (redaman === 'sedang') matchRedaman = rxClass === 'rx-sedang';
      else if (redaman === 'buruk')  matchRedaman = rxClass === 'rx-buruk';
    }

    return matchKeyword && matchStatus && matchRedaman;
  });

  // Terapkan sort jika aktif
  applySort();

  // Update badge jumlah di dropdown filter-redaman
  updateRedamanBadge();

  currentPage = 1;
  renderTabel();
  renderPaginasi();
}

/* ── Sort data berdasarkan RX Signal ── */
function applySort() {
  if (sortCol !== 'rx') return;
  _filteredData.sort((a, b) => {
    const rxA = parseRxTx(a, a.status === 'Online').rx;
    const rxB = parseRxTx(b, b.status === 'Online').rx;
    // null ke belakang selalu
    if (rxA === null && rxB === null) return 0;
    if (rxA === null) return 1;
    if (rxB === null) return -1;
    // desc = terburuk dulu (nilai paling negatif / < -26 ke atas)
    return sortDir === 'desc' ? rxA - rxB : rxB - rxA;
  });
}

/* ── Toggle sort kolom RX ── */
function sortByRx() {
  if (sortCol === 'rx') {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    sortCol = 'rx';
    sortDir = 'desc';
  }
  applySort();
  updateSortIcon();
  renderTabel();
  renderPaginasi();
}

/* ── Update ikon sort di thead ── */
function updateSortIcon() {
  const btn = document.getElementById('sort-rx-btn');
  if (!btn) return;
  if (sortCol !== 'rx') {
    btn.innerHTML = '<span class="material-symbols-outlined sort-icon neutral">unfold_more</span>';
    return;
  }
  btn.innerHTML = sortDir === 'desc'
    ? '<span class="material-symbols-outlined sort-icon active">arrow_downward</span>'
    : '<span class="material-symbols-outlined sort-icon active">arrow_upward</span>';
}

/* ── Update badge jumlah di dropdown filter-redaman ── */
function updateRedamanBadge() {
  let bagus = 0, sedang = 0, buruk = 0;
  _allData.forEach(p => {
    const cls = parseRxTx(p, p.status === 'Online').rxClass;
    if      (cls === 'rx-bagus')  bagus++;
    else if (cls === 'rx-sedang') sedang++;
    else if (cls === 'rx-buruk')  buruk++;
  });

  const sel = document.getElementById('filter-redaman');
  if (!sel) return;
  sel.options[0].text = 'Semua Redaman';
  sel.options[1].text = `🟢 Redaman Bagus (${bagus})`;
  sel.options[2].text = `🟡 Redaman Sedang (${sedang})`;
  sel.options[3].text = `🔴 Redaman Buruk (${buruk})`;
}


/* ══════════════════════════════════════════════════════════
   4. RENDER TABEL
   ← Kolom "No HP" sudah ada di HTML thead.
     Data hp sudah disertakan di response /api/pelanggan (dari onu_mapping.phone).
     Tidak ada perubahan struktur HTML, cukup pastikan p.hp dirender.
══════════════════════════════════════════════════════════ */
/* Format SN: jika 12 hex tanpa pemisah (EPON/MAC) → tambah titik dua, huruf besar */
function formatSn(sn) {
  if (!sn) return '—';
  const clean = sn.replace(/[:\-]/g, '');
  if (/^[0-9a-fA-F]{12}$/.test(clean)) {
    return clean.toUpperCase().match(/.{2}/g).join(':');
  }
  return sn.toUpperCase();
}

function _isEpon(oltId) {
  const olt = oltCache.find(function(o) { return String(o.id) === String(oltId); });
  const tipe = (olt ? olt.tipe : '').toLowerCase();
  return tipe === 'epon' || tipe === 'hsgq';
}

function renderTabel() {
  const tbody = document.getElementById('tbody-pelanggan');
  const tabel = document.getElementById('table-pelanggan');

  sembunyikanSemuaState();

  if (_filteredData.length === 0) {
    tabel.style.display = 'none';
    tampilEmpty();
    return;
  }

  tabel.style.display = 'table';

  const start = (currentPage - 1) * PER_PAGE;
  const slice = _filteredData.slice(start, start + PER_PAGE);

  const _isKol = localStorage.getItem('tf_role') === 'kolektor';

  tbody.innerHTML = slice.map((p, i) => {
    const no = start + i + 1;
    const online = p.status === 'Online';
    const aktif  = p.status === 'Aktif';   // status dari DB (kolektor)
    const disconnected = p.status === 'Router Disconnected';

    let badgeClass, badgeLabel;
    if (online || aktif) { badgeClass = 'online'; badgeLabel = online ? 'Online' : 'Aktif'; }
    else if (disconnected) { badgeClass = 'nonaktif'; badgeLabel = 'Router Off'; }
    else { badgeClass = 'nonaktif'; badgeLabel = p.status === 'Offline' ? 'Offline' : 'Nonaktif'; }

    const rxInfo  = parseRxTx(p, online);
    const namaOlt = _getNamaOlt(p.olt_id);
    const rxBuruk = rxInfo.rxClass === 'rx-buruk';
    const rowStatusCls = online || aktif ? 'row-online' : 'row-offline';
    const rowAttr = ` data-id="${p.id}" data-username="${escHtml(p.username || '')}" class="${rxBuruk ? 'row-rx-buruk ' : ''}${rowStatusCls}"`;
    const rp = n => 'Rp ' + (Number(n)||0).toLocaleString('id-ID');

    // ── Baris KOLEKTOR — lebih sederhana, tambah kolom Tagihan + Bayar ──
    if (_isKol) {
      return `
        <tr${rowAttr}>
          <td class="sticky-col-0 col-cb"><input type="checkbox" class="row-cb" data-id="${p.id}" ${_selectedIds.has(String(p.id)) ? 'checked' : ''}></td>
          <td class="sticky-col-1">${no}</td>
          <td class="sticky-col-2">
            <div style="font-weight:700">${escHtml(p.nama || p.username || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-dim)">@${escHtml(p.username || '—')}</div>
          </td>
          <td><a href="tel:${escHtml(p.hp||'')}" style="color:var(--primary)">${escHtml(p.hp || '—')}</a></td>
          <td><span class="badge-profil">${escHtml(p.profil || '—')}</span></td>
          <td style="font-weight:700;color:var(--primary)">${p.harga ? rp(p.harga) : '—'}</td>
          <td>
            <span class="badge-status ${badgeClass}">
              <span class="badge-dot"></span>${badgeLabel}
            </span>
          </td>
          <td>
            <div class="tbl-actions">
              <button class="btn-tbl detail" onclick="openDetail('${p.id}')" title="Detail Pelanggan">
                <span class="material-symbols-outlined">person</span>
              </button>
              <button class="btn-tbl" style="background:var(--green-bg);color:var(--green);border-color:var(--green-border)"
                onclick="_kolBayarDariPelanggan('${escHtml(p.username||'')}','${escHtml(p.nama||p.username||'')}',${p.harga||0})"
                title="Bayar Tagihan">
                <span class="material-symbols-outlined">payments</span>
              </button>
            </div>
          </td>
        </tr>`;
    }

    // ── Baris NORMAL (owner/admin/teknisi) ──
    return `
      <tr${rowAttr}>
        <td class="sticky-col-0 col-cb"><input type="checkbox" class="row-cb" data-id="${p.id}" ${_selectedIds.has(String(p.id)) ? 'checked' : ''}></td>
        <td class="sticky-col-1">${no}</td>

        <td class="sticky-col-2">
          <span class="tbl-username">${escHtml(p.username || '—')}</span>
        </td>

        <td><span class="tbl-hp">${escHtml(p.hp || '—')}</span></td>

        <td><span class="badge-profil">${escHtml(p.profil || '—')}</span></td>

        <td>${escHtml(p.slot_port || '—')}</td>

        <td>${escHtml(p.vlan || '—')}</td>

        <td>${escHtml(formatSn(p.sn))}</td>

        <td>
          <span class="tbl-rx ${rxInfo.rxClass}" title="TX: ${rxInfo.txFormatted}">
            ${escHtml(rxInfo.rxFormatted)}
          </span>
        </td>

        <td>
          <span class="badge-status ${badgeClass}">
            <span class="badge-dot"></span>
            ${badgeLabel}
          </span>
        </td>

        <td>
          <div class="tbl-actions">
            <button class="btn-tbl edit" onclick="openEdit('${p.id}')" title="Edit Pelanggan">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="btn-tbl detail" onclick="openDetail('${p.id}')" title="Detail & Aksi">
              <span class="material-symbols-outlined">settings_remote</span>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  const deviceCount = document.getElementById('device-count');
  if (deviceCount) deviceCount.textContent = `${_filteredData.length} pelanggan`;

  // Perbarui state "check all" sesuai pilihan yang masih aktif
  _updateCbAll();
}


/* ══════════════════════════════════════════════════════════
   PILIHAN MASSAL — Checkbox & Floating Action Bar
══════════════════════════════════════════════════════════ */

/* Delegasi event checkbox baris — dipasang satu kali setelah DOM siap */
(function _pasangDelegasiCb() {
  document.addEventListener('DOMContentLoaded', function () {
    const tbody = document.getElementById('tbody-pelanggan');
    if (!tbody) return;
    tbody.addEventListener('change', function (e) {
      const cb = e.target;
      if (!cb.classList.contains('row-cb')) return;
      const id = String(cb.dataset.id);
      if (cb.checked) _selectedIds.add(id);
      else _selectedIds.delete(id);
      _updateBulkBar();
      _updateCbAll();
    });
  });
})();

/* Perbarui checkbox "Pilih semua" di thead */
function _updateCbAll() {
  const cbAll = document.getElementById('cb-all');
  if (!cbAll) return;
  // Id dari baris yang saat ini terrender
  const visibleIds = Array.from(
    document.querySelectorAll('#tbody-pelanggan .row-cb')
  ).map(cb => String(cb.dataset.id));

  if (visibleIds.length === 0) {
    cbAll.checked = false;
    cbAll.indeterminate = false;
    return;
  }
  const checkedCount = visibleIds.filter(id => _selectedIds.has(id)).length;
  if (checkedCount === 0) {
    cbAll.checked = false;
    cbAll.indeterminate = false;
  } else if (checkedCount === visibleIds.length) {
    cbAll.checked = true;
    cbAll.indeterminate = false;
  } else {
    cbAll.checked = false;
    cbAll.indeterminate = true;
  }
}

/* Handler untuk checkbox "Pilih semua" di thead */
function _cbAllChange(cbAll) {
  const rowCbs = document.querySelectorAll('#tbody-pelanggan .row-cb');
  rowCbs.forEach(function (cb) {
    cb.checked = cbAll.checked;
    const id = String(cb.dataset.id);
    if (cbAll.checked) _selectedIds.add(id);
    else _selectedIds.delete(id);
  });
  _updateBulkBar();
}

/* Tampilkan/sembunyikan floating action bar */
function _updateBulkBar() {
  const bar = document.getElementById('bulk-action-bar');
  const label = document.getElementById('bulk-count-label');
  if (!bar) return;
  const n = _selectedIds.size;
  if (n > 0) {
    bar.style.display = 'flex';
    if (label) label.textContent = `${n} dipilih`;
  } else {
    bar.style.display = 'none';
  }
}

/* Batalkan semua pilihan */
function _batalPilihan() {
  _selectedIds.clear();
  document.querySelectorAll('#tbody-pelanggan .row-cb').forEach(cb => { cb.checked = false; });
  _updateCbAll();
  _updateBulkBar();
}

/* ── Isolir massal ──
   Kirim POST /api/pelanggan/{id}/isolir untuk tiap id yang dipilih,
   jalankan paralel dengan Promise.allSettled, tampilkan hasil.
*/
async function _isolirMassal() {
  const ids = Array.from(_selectedIds);
  if (ids.length === 0) return;
  toast(`Mengisolir ${ids.length} pelanggan...`, 'info');

  const results = await Promise.allSettled(
    ids.map(id =>
      fetch(`${API_BASE}/api/pelanggan/${id}/isolir`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
      })
    )
  );

  const berhasil = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const gagal    = results.length - berhasil;

  if (gagal === 0) {
    toast(`${berhasil} pelanggan berhasil diisolir`, 'success');
  } else {
    toast(`${berhasil} berhasil, ${gagal} gagal diisolir`, 'warning');
  }

  _batalPilihan();
  loadPelanggan();
}

/* ── Aktifkan massal ──
   Kirim POST /api/pelanggan/{id}/aktif untuk tiap id yang dipilih.
*/
async function _aktifMassal() {
  const ids = Array.from(_selectedIds);
  if (ids.length === 0) return;
  toast(`Mengaktifkan ${ids.length} pelanggan...`, 'info');

  const results = await Promise.allSettled(
    ids.map(id =>
      fetch(`${API_BASE}/api/pelanggan/${id}/enable`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders(),
      })
    )
  );

  const berhasil = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const gagal    = results.length - berhasil;

  if (gagal === 0) {
    toast(`${berhasil} pelanggan berhasil diaktifkan`, 'success');
  } else {
    toast(`${berhasil} berhasil, ${gagal} gagal diaktifkan`, 'warning');
  }

  _batalPilihan();
  loadPelanggan();
}


/* ══════════════════════════════════════════════════════════
   HELPER — Ambil nama OLT dari cache
══════════════════════════════════════════════════════════ */
function _getNamaOlt(oltId) {
  if (!oltId) return '—';
  const found = oltCache.find(o => String(o.id) === String(oltId));
  return found ? found.name : `OLT #${oltId}`;
}


/* ══════════════════════════════════════════════════════════
   5. PAGINASI
══════════════════════════════════════════════════════════ */
function renderPaginasi() {
  const totalPage = Math.ceil(_filteredData.length / PER_PAGE);
  const wrap = document.getElementById('pagination');
  if (!wrap) return;
  if (totalPage <= 1) { wrap.innerHTML = ''; return; }

  let html = `<button class="page-btn" onclick="gantiPage(${currentPage - 1})"
    ${currentPage === 1 ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_left</span>
  </button>`;

  for (let i = 1; i <= totalPage; i++) {
    if (i === 1 || i === totalPage || (i >= currentPage - 1 && i <= currentPage + 1)) {
      html += `<button class="page-btn ${i === currentPage ? 'active' : ''}"
        onclick="gantiPage(${i})">${i}</button>`;
    } else if (i === currentPage - 2 || i === currentPage + 2) {
      html += `<span style="color:var(--text-dim);padding:0 2px">…</span>`;
    }
  }

  html += `<button class="page-btn" onclick="gantiPage(${currentPage + 1})"
    ${currentPage === totalPage ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_right</span>
  </button>`;

  wrap.innerHTML = html;
}

function gantiPage(p) {
  const total = Math.ceil(_filteredData.length / PER_PAGE);
  if (p < 1 || p > total) return;
  currentPage = p;
  renderTabel();
  renderPaginasi();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


/* ══════════════════════════════════════════════════════════
   6. STATS
══════════════════════════════════════════════════════════ */
function updateStats() {
  const total = _allData.length;
  const online = _allData.filter(p => p.status === 'Online').length;
  const offline = total - online;

  animNum('stat-total', total);
  animNum('stat-aktif', online);
  animNum('stat-nonaktif', offline);
}


/* ══════════════════════════════════════════════════════════
   7. MODAL FORM TAMBAH / EDIT PELANGGAN
   ← PEMBARUAN:
     - Form field "No HP" sudah ada → tetap dipertahankan
     - Tambah field: OLT (dropdown), Slot/Port, VLAN, SN sudah ada
     - Tambah checkbox "Re-provisioning OLT" saat mode edit
     - Auto-fill hp & data OLT saat openEdit()
══════════════════════════════════════════════════════════ */
function showFormPelanggan(prefill) {
  prefill = prefill || null;
  _editingId = prefill ? prefill.id : null;
  const isEdit = !!prefill;

  const devSel = document.getElementById('select-device');
  let deviceOptions = '<option value="">— Pilih Perangkat —</option>';
  Array.from(devSel.options).forEach(function (o) {
    if (!o.value) return;
    // Mode edit: ikuti device_id pelanggan. Mode tambah baru: JANGAN ikut
    // filter header — biarkan kosong supaya staff wajib pilih perangkat
    // secara sadar (mencegah secret baru ke-buat di device yang salah).
    const sel = prefill ? (String(prefill.device_id) === o.value ? 'selected' : '') : '';
    deviceOptions += `<option value="${escHtml(o.value)}" ${sel}>${escHtml(o.text)}</option>`;
  });

  // v(key): ambil nilai prefill untuk form — hp fallback ke no_hp untuk data lama
  const v = k => {
    if (!prefill) return '';
    // Field hp: coba hp dulu, fallback ke no_hp (data legacy)
    if (k === 'hp') return escHtml(prefill.hp || prefill.no_hp || '');
    return escHtml(prefill[k] || '');
  };


  const html = `
    <div class="modal" style="max-width:560px;width:100%;max-height:90vh;overflow-y:auto;">
      <div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;
           padding:18px 20px 14px;border-bottom:1px solid var(--border);gap:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="material-symbols-outlined" style="color:var(--primary);font-size:22px;">
            ${isEdit ? 'edit' : 'person_add'}
          </span>
          <span style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">
            ${isEdit ? 'Edit Pelanggan' : 'Tambah Pelanggan Baru'}
          </span>
        </div>
        <button class="psheet-close" onclick="tutupModalPelanggan()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div style="padding:20px;">
        <div class="form-grid">

          <!-- Perangkat MikroTik -->
          <div class="form-group full">
            <label class="form-label">Perangkat MikroTik <span class="req">*</span></label>
            <select class="form-input" id="f-device" onchange="_onDeviceChangeForm()">${deviceOptions}</select>
          </div>

          <!-- Username & Password -->
          <div class="form-group">
            <label class="form-label">Username <span class="req">*</span></label>
            <input class="form-input" id="f-username" type="text"
              placeholder="cth: pelanggan01" autocomplete="off" value="${v('username')}">
          </div>

          <div class="form-group">
            <label class="form-label">Password ${isEdit ? '' : '<span class="req">*</span>'}</label>
            <div class="form-pwd-wrap">
              <input class="form-input" id="f-password" type="password"
                placeholder="${isEdit ? 'Kosongkan jika tidak diubah' : '••••••••'}"
                value="${isEdit && prefill?.password ? escHtml(prefill.password) : ''}"
                autocomplete="new-password">
              <button class="form-pwd-toggle" type="button"
                onclick="togglePwd('f-password','f-pwd-eye')">
                <span class="material-symbols-outlined" id="f-pwd-eye">visibility</span>
              </button>
            </div>
            ${isEdit ? '<span class="form-hint">Password diambil otomatis dari MikroTik. Ubah jika perlu reset.</span>' : ''}
          </div>

          <!-- No HP -->
          <div class="form-group">
            <label class="form-label">No. Telepon / HP</label>
            <input class="form-input" id="f-hp" type="text"
              placeholder="cth: 08123456789" value="${v('hp')}">
          </div>

          <!-- Profil -->
          <div class="form-group">
            <label class="form-label">Profil <span class="req">*</span></label>
            <select class="form-input" id="f-profil">
              <option value="">— Pilih Profil —</option>
            </select>
          </div>

          <!-- Separator OLT -->
          <div class="form-group full" style="margin:4px 0 0;">
            <div style="font-size:11px;font-weight:700;color:var(--text-dim);
                 letter-spacing:.08em;text-transform:uppercase;padding:6px 0 2px;
                 border-top:1px solid var(--border);">
              Data OLT — Provisioning ONU
            </div>
          </div>

          <!-- Pilih OLT -->
          <div class="form-group full">
            <label class="form-label">Perangkat OLT</label>
            <select class="form-input" id="f-olt">
              <option value="">-- Pilih OLT (opsional) --</option>
            </select>
          </div>

          <!-- Titik Koordinat — dipindah ke sini agar bisa suggest ODP terdekat -->
          <div class="form-group full">
            <label class="form-label">
              <span class="material-symbols-outlined"
                    style="font-size:13px;vertical-align:middle;color:var(--primary)">location_on</span>
              Titik Koordinat Rumah Pelanggan
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk Maps &amp; suggest ODP terdekat)</span>
            </label>
            <div class="koordinat-row">
              <input class="form-input" id="f-koordinat" type="text"
                placeholder="cth: -8.267870, 114.369284"
                value="${prefill ? escHtml(prefill.titik_koordinat || prefill.koordinat || '') : ''}"
                oninput="previewKoordinatPelanggan();_suggestOdpTerdekat()">
              <button type="button" class="koordinat-btn" onclick="deteksiLokasiPelanggan()">
                <span class="material-symbols-outlined">my_location</span>
                Deteksi
              </button>
            </div>
            <span class="form-hint">Format: latitude, longitude — gunakan tombol Deteksi untuk isi otomatis</span>
            <div class="koordinat-preview" id="koordinat-preview-pel">
              <iframe id="koordinat-iframe-pel" src="" loading="lazy"></iframe>
            </div>
          </div>

          <!-- ODP — titik distribusi ke pelanggan ini -->
          <div class="form-group full">
            <label class="form-label">
              ODP
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk garis topologi di Maps)</span>
            </label>
            <select class="form-input" id="f-odp" onchange="_loadOdpPortsIntoForm()">
              <option value="">-- Pilih ODP (opsional) --</option>
            </select>
            <div id="odp-suggest-strip" style="display:none;margin-top:6px;font-size:11.5px;color:var(--text-dim)"></div>
          </div>

          <!-- Port ODP -->
          <div class="form-group" id="f-port-odp-wrap" style="display:none">
            <label class="form-label">Port ODP
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(pilih port yang kosong)</span>
            </label>
            <select class="form-input" id="f-port-odp">
              <option value="">-- Pilih Port --</option>
            </select>
          </div>

          <!-- Slot/Port & VLAN -->
          <div class="form-group">
            <label class="form-label">Slot/Port : ONU-ID</label>
            <input class="form-input" id="f-slot" type="text"
              placeholder="cth: 0/1/1:3" value="${v('slot_port')}">
          </div>

          <div class="form-group">
            <label class="form-label">VLAN
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(sesuai interface VLAN di MikroTik)</span>
            </label>
            <select class="form-input" id="f-vlan">
              <option value="">— Pilih VLAN —</option>
            </select>
          </div>

          <!-- Serial Number + Scan SN -->
          <div class="form-group full">
            <label class="form-label">Serial Number (SN) Modem/ONU</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="form-input" id="f-sn" type="text"
                placeholder="cth: ZTEG1A2B3C4D atau HWTC1A2B3C4D" value="${v('sn')}" style="flex:1">
              <button type="button" class="btn btn-sm btn-blue" onclick="_scanSnOlt()" title="Scan SN dari OLT yang dipilih">
                <span class="material-symbols-outlined">wifi_find</span>Scan SN
              </button>
            </div>
            <span class="form-hint">Atau klik "Scan SN" untuk mendeteksi ONU yang belum terdaftar</span>
            <!-- Hasil scan SN -->
            <div id="scan-sn-result" style="display:none;margin-top:8px;border:1px solid var(--border);border-radius:var(--r-md);max-height:200px;overflow-y:auto">
            </div>
          </div>

          <!-- Kolektor -->
          <div class="form-group full">
            <label class="form-label">Kolektor
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(opsional — untuk penugasan tagihan)</span>
            </label>
            <select class="form-input" id="f-kolektor">
              <option value="">— Tidak Ditugaskan —</option>
            </select>
          </div>

          <!-- Pelanggan Prioritas -->
          <div class="form-group full">
            <label class="form-label">Status Khusus</label>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;
                   border:1.5px solid var(--border);border-radius:var(--r-md);background:var(--bg);
                   transition:border-color .15s" id="lbl-prioritas-wrap">
              <input type="checkbox" id="f-is-prioritas" ${prefill && prefill.is_prioritas ? 'checked' : ''}
                style="width:17px;height:17px;accent-color:var(--purple,#7c3aed);cursor:pointer"
                onchange="document.getElementById('lbl-prioritas-wrap').style.borderColor=this.checked?'var(--purple,#7c3aed)':'var(--border)'">
              <span>
                <strong style="font-size:13px">Pelanggan Prioritas</strong>
                <span style="display:block;font-size:11.5px;color:var(--text-dim);font-weight:400">Tidak ditagih & tidak diisolir otomatis (bebas biaya)</span>
              </span>
            </label>
          </div>

          <!-- Catatan Khusus -->
          <div class="form-group full">
            <label class="form-label">Catatan Khusus <span style="font-size:10px;font-weight:400;color:var(--text-dim)">(opsional)</span></label>
            <input class="form-input" id="f-catatan-khusus" type="text"
              placeholder="cth: Keluarga owner, sponsor, dll"
              value="${prefill ? escHtml(prefill.catatan_khusus || '') : ''}">
          </div>

          <!-- Separator Info Tambahan -->
          <div class="form-group full" style="margin:4px 0 0;">
            <div style="font-size:11px;font-weight:700;color:var(--text-dim);
                 letter-spacing:.08em;text-transform:uppercase;padding:6px 0 2px;
                 border-top:1px solid var(--border);">
              Info Tambahan
            </div>
          </div>

          <!-- Tanggal Pemasangan & Jatuh Tempo -->
          <div class="form-group">
            <label class="form-label">Tanggal Pemasangan</label>
            <input class="form-input" id="f-tgl-pasang" type="date" value="${v('tgl_pasang')}">
          </div>

          <div class="form-group">
            <label class="form-label">Tanggal Jatuh Tempo</label>
            <input class="form-input" id="f-tgl-jatuh" type="date" value="${v('tgl_jatuh')}">
          </div>

        </div>

        <div class="form-actions">
          <button class="btn" onclick="tutupModalPelanggan()">
            <span class="material-symbols-outlined">close</span> Batal
          </button>
          <button class="btn-primary" id="btn-save-pelanggan" onclick="_showKonfirmasiSimpan()">
            <span class="material-symbols-outlined">${isEdit ? 'check' : 'bolt'}</span>
            ${isEdit ? 'Simpan Perubahan' : 'Provisioning & Simpan'}
          </button>
        </div>
      </div>
    </div>`;

  openModalForm(html);  // ← dari global.js

  // Load opsi dropdown setelah DOM tersedia
  requestAnimationFrame(() => {
    _loadOltIntoForm(prefill ? prefill.olt_id : '');
    _loadOdpIntoForm(prefill ? prefill.odp_id : '').then(function() {
      // Setelah ODP terisi & port dimuat, pilih port yang sudah tersimpan (mode edit)
      if (prefill && prefill.port_odp) {
        var portSel = document.getElementById('f-port-odp');
        if (portSel) portSel.value = prefill.port_odp;
      }
    });
    _loadProfilIntoForm(prefill ? prefill.profil : '');
    _loadVlanIntoForm(prefill ? prefill.vlan : '');
    _loadKolektorIntoForm(prefill ? (prefill.kolektor || '') : '');
    const u = document.getElementById('f-username');
    if (u) u.focus();
  });
}

function tutupModalPelanggan() {
  _editingId = null;
  closeModalForm(); // ← dari global.js
}

/* ══════════════════════════════════════════════════════════
   8. EDIT PELANGGAN
   Buka form modal dengan data pelanggan yang sudah ter-isi otomatis.
══════════════════════════════════════════════════════════ */

/**
 * Cari pelanggan dari cache, lalu buka form edit (pre-populated).
 * @param {number|string} id - ID pelanggan dari baris tabel
 */
async function openEdit(id) {
  const p = _allData.find(item => String(item.id) === String(id));
  if (!p) {
    toast('Data pelanggan tidak ditemukan.', 'danger');
    return;
  }

  // Buka form dulu dengan data yang ada (response GET pelanggan harusnya sudah include password)
  showFormPelanggan(p);

  // Async: fetch password real dari /credentials untuk update field
  // Berguna kalau password di response GET masih kosong
  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${p.id}/credentials`, {
      credentials: 'include',
      headers:     getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.password) {
        const passEl = document.getElementById('f-password');
        if (passEl && !passEl.value) {
          passEl.value = data.password;
        }
      }
    }
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   9. PROSES SIMPAN / PROVISIONING PELANGGAN (VERSI SENIOR FIX)
══════════════════════════════════════════════════════════ */
function _closeKonfirmasiSimpan(e) {
  if (e && e.target !== document.getElementById('modal-konfirmasi-simpan')) return;
  var el = document.getElementById('modal-konfirmasi-simpan');
  if (el) el.remove();
}

function _showKonfirmasiSimpan() {
  // Validasi dasar sebelum tampilkan modal
  var username = (document.getElementById('f-username')?.value || '').trim();
  var deviceId = document.getElementById('f-device')?.value || '';
  var fIdEl    = document.getElementById('f-id');
  var isModeEdit = !!(fIdEl?.value || (typeof _editingId !== 'undefined' && _editingId));
  var passEl   = document.getElementById('f-pass') || document.getElementById('f-password');
  var password = (passEl?.value || '').trim();

  if (!username) { toast('Username wajib diisi', 'warning'); return; }
  if (!isModeEdit && !password) { toast('Password wajib diisi untuk pelanggan baru', 'warning'); return; }
  if (!deviceId) { toast('Pilih perangkat MikroTik terlebih dahulu', 'warning'); return; }

  var reprovRow = isModeEdit ? `
    <label class="lk-konfirmasi-option">
      <input type="checkbox" id="f-reprovision" class="lk-konfirmasi-chk">
      <div class="lk-konfirmasi-body">
        <span class="material-symbols-outlined">restart_alt</span>
        <div>
          <div class="lk-konfirmasi-title">Re-Provisioning</div>
          <div class="lk-konfirmasi-desc">Kirim ulang perintah provisioning ke OLT</div>
        </div>
      </div>
    </label>` : '';

  var html = `
  <div class="modal-overlay open" id="modal-konfirmasi-simpan"
       style="z-index:200;" onclick="_closeKonfirmasiSimpan(event)">
    <div class="modal-sheet small" onclick="event.stopPropagation()">
      <div class="modal-handle"></div>
      <div class="hapus-icon-wrap" style="background:var(--primary-light)">
        <span class="material-symbols-outlined hapus-icon" style="color:var(--primary)">
          ${isModeEdit ? 'edit' : 'person_add'}
        </span>
      </div>
      <div class="hapus-title">${isModeEdit ? 'Simpan Perubahan' : 'Tambah Pelanggan'}</div>
      <div class="hapus-sub">Pilih sistem yang akan diperbarui:</div>
      <div class="lk-konfirmasi-options">
        <label class="lk-konfirmasi-option lk-konfirmasi-locked">
          <input type="checkbox" id="f-target-billing" checked disabled class="lk-konfirmasi-chk">
          <div class="lk-konfirmasi-body">
            <span class="material-symbols-outlined">receipt_long</span>
            <div>
              <div class="lk-konfirmasi-title">Billing</div>
              <div class="lk-konfirmasi-desc">Data pelanggan di database TechnoFix (selalu aktif)</div>
            </div>
          </div>
        </label>
        <label class="lk-konfirmasi-option">
          <input type="checkbox" id="f-target-mikrotik" checked class="lk-konfirmasi-chk">
          <div class="lk-konfirmasi-body">
            <span class="material-symbols-outlined">router</span>
            <div>
              <div class="lk-konfirmasi-title">MikroTik</div>
              <div class="lk-konfirmasi-desc">Buat/ubah PPP Secret PPPoE di router</div>
            </div>
          </div>
        </label>
        <label class="lk-konfirmasi-option">
          <input type="checkbox" id="f-target-olt" checked class="lk-konfirmasi-chk">
          <div class="lk-konfirmasi-body">
            <span class="material-symbols-outlined">settings_input_antenna</span>
            <div>
              <div class="lk-konfirmasi-title">OLT</div>
              <div class="lk-konfirmasi-desc">Kirim CLI registrasi/sinkronisasi ONU ke perangkat OLT via SSH</div>
            </div>
          </div>
        </label>
        ${reprovRow}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="_closeKonfirmasiSimpan()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-konfirmasi-simpan-ok" onclick="simpanPelanggan()">
          <span class="material-symbols-outlined">${isModeEdit ? 'check' : 'bolt'}</span>
          ${isModeEdit ? 'Ya, Simpan' : 'Ya, Tambahkan'}
        </button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

async function simpanPelanggan() {
  // 1. Ambil penanda mode (add/edit) dan ID
  // Prioritas: f-id hidden input → variabel _editingId global → f-mode
  const fIdEl   = document.getElementById('f-id');
  const fModeEl = document.getElementById('f-mode') || document.getElementsByName('mode')[0];

  // _editingId diset oleh showFormPelanggan() saat mode edit
  const idPelangganLokal = (fIdEl && fIdEl.value) ? fIdEl.value
                         : (typeof _editingId !== 'undefined' && _editingId) ? String(_editingId)
                         : '';
  const isModeEdit = !!idPelangganLokal || (fModeEl && fModeEl.value === 'edit');

  // 2. Ambil seluruh data form dengan proteksi anti-null element
  const deviceId = document.getElementById('f-device') ? document.getElementById('f-device').value : '';
  const username = document.getElementById('f-username') ? document.getElementById('f-username').value.trim() : '';
  
  // Deteksi element password (Mendukung id f-pass atau f-password)
  const passEl = document.getElementById('f-pass') || document.getElementById('f-password');
  const password = passEl ? passEl.value.trim() : '';

  // Field hp — kolom standar di DB; no_hp dikirim juga sebagai alias backward-compat
  const hpEl = document.getElementById('f-hp');
  const hp   = hpEl ? hpEl.value.trim() : '';

  const profil = document.getElementById('f-profil') ? document.getElementById('f-profil').value : '';
  const oltId = document.getElementById('f-olt') ? document.getElementById('f-olt').value : '';

  // Deteksi element slot port (Mendukung f-slot-port atau f-slot)
  const slotEl = document.getElementById('f-slot-port') || document.getElementById('f-slot');
  const slot = slotEl ? slotEl.value.trim() : '';

  const vlan = document.getElementById('f-vlan') ? document.getElementById('f-vlan').value.trim() : '';
  const sn = document.getElementById('f-sn') ? document.getElementById('f-sn').value.trim() : '';
  const tcont = document.getElementById('f-tcont') ? document.getElementById('f-tcont').value.trim() : '';
  
  // Ambil koordinat dari field standar
  const koordinat = (document.getElementById('f-koordinat')?.value || '').trim();

  const tglPasang = document.getElementById('f-tgl-pasang') ? document.getElementById('f-tgl-pasang').value : '';
  const tglJatuh = document.getElementById('f-tgl-jatuh') ? document.getElementById('f-tgl-jatuh').value : '';
  const reProvision = document.getElementById('f-reprovision')?.checked || false;

  // Checklist target operasi (Billing selalu ikut — record utama)
  const targetMikrotik = document.getElementById('f-target-mikrotik')?.checked ?? true;
  const targetOlt      = document.getElementById('f-target-olt')?.checked ?? true;
  const targets = ['billing', targetMikrotik && 'mikrotik', targetOlt && 'olt'].filter(Boolean);

  // ── Jalankan Validasi Sisi Frontend ─────────────────────────
  if (!username) { toast('Username wajib diisi', 'warning'); return; }
  if (!isModeEdit && !password) { toast('Password wajib diisi untuk pelanggan baru', 'warning'); return; }
  if (!deviceId) { toast('Pilih perangkat MikroTik terlebih dahulu', 'warning'); return; }

  // Peringatan provisioning OLT
  if (oltId && !sn) { toast('⚠ SN modem kosong — provisioning OLT akan dilewati', 'warning'); }
  if (oltId && !slot) { toast('⚠ Slot/Port kosong — provisioning OLT akan dilewati', 'warning'); }

  // Animasi loading — pakai tombol di modal konfirmasi jika ada, fallback ke form
  const btn = document.getElementById('btn-konfirmasi-simpan-ok') || document.getElementById('btn-save-pelanggan');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menyimpan...';
  }

  try {
    let url, method, body;

    // Susun isi data payload yang seragam untuk dikirim ke Backend
    body = {
      device_id: Number(deviceId),
      username: username,
      nama: document.getElementById('f-nama') ? document.getElementById('f-nama').value.trim() : username,
      hp: hp,
      no_hp: hp,
      profil: profil,
      olt_id: oltId ? Number(oltId) : null,
      slot_port: slot,
      vlan: vlan,
      sn: sn,
      tcont_profile: tcont,
      koordinat: koordinat,
      titik_koordinat: koordinat,
      tgl_pasang: tglPasang,
      tgl_jatuh: tglJatuh,
      odp_id: document.getElementById('f-odp')?.value || null,
      port_odp: document.getElementById('f-port-odp')?.value ? parseInt(document.getElementById('f-port-odp').value) : null,
      kolektor:       document.getElementById('f-kolektor')?.value || '',
      is_prioritas:   document.getElementById('f-is-prioritas')?.checked ? 1 : 0,
      catatan_khusus: document.getElementById('f-catatan-khusus')?.value?.trim() || '',
      targets: targets,
    };

    if (isModeEdit) {
      // ── 🛠️ SEKARANG AMAN MENGEKSEKUSI MODE EDIT (PUT) ────────────────
      url = `${API_BASE}/api/pelanggan/${idPelangganLokal}`;
      method = 'PUT';
      body.re_provision = reProvision; // Kirim instruksi sinkronisasi ulang OLT
      if (password) body.password = password; // Kirim password jika diubah
    } else {
      // ── ⚡ MODE TAMBAH BARU (POST) ───────────────────────────
      url = `${API_BASE}/api/pelanggan`;
      method = 'POST';
      body.password = password;
    }

    // Eksekusi penembakan data ke API Flask Backend
    const res = await fetch(url, {
      method:      method,
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify(body),
    });

    const data = await res.json();

    // Status 207 berarti data aman tersimpan, namun ada peringatan dari router/OLT
    if (!res.ok && res.status !== 207) {
      throw new Error(data.error || data.message || 'Gagal menyimpan data ke server.');
    }

    // Tutup modal konfirmasi simpan (jika ada)
    var mKonfirmasi = document.getElementById('modal-konfirmasi-simpan');
    if (mKonfirmasi) mKonfirmasi.remove();

    // Tutup modal form pelanggan
    if (typeof tutupModalPelanggan === 'function') {
      tutupModalPelanggan();
    } else if (typeof closeModalForm === 'function') {
      closeModalForm('modal-form');
    }

    // Tampilkan notifikasi hasil status provisioning mikrotik & OLT
    const steps = data.steps || {};
    const warnings = data.warnings || [];

    let toastMsg = isModeEdit
      ? `✅ ${username} berhasil diperbarui`
      : `✅ ${username} berhasil ditambahkan`;

    if (steps.mikrotik) toastMsg += ` · MikroTik: OK`;
    if (steps.olt && steps.olt.includes('berhasil')) toastMsg += ` · OLT: OK`;

    toast(toastMsg, warnings.length > 0 ? 'warning' : 'success');

    if (warnings.length > 0) {
      setTimeout(() => {
        warnings.forEach(w => toast(`⚠ ${w}`, 'warning'));
      }, 800);
    }

    // Tarik ulang isi data tabel agar data HP terbaru langsung muncul tanpa refresh browser
    await loadPelanggan();

  } catch (err) {
    console.error("Crash pada simpanPelanggan:", err);
    toast(err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span class="material-symbols-outlined">${isModeEdit ? 'check' : 'bolt'}</span> ` +
        (isModeEdit ? 'Ya, Simpan' : 'Ya, Tambahkan');
    }
  }
}


/* ══════════════════════════════════════════════════════════
   10. MODAL DETAIL / AKSI PERANGKAT
   ← PEMBARUAN:
     - Tampilkan No. Telepon (hp) di bagian info pelanggan
     - Tampilkan Data OLT: nama OLT, Slot/Port, VLAN, SN
══════════════════════════════════════════════════════════ */
/**
 * Navigasi ke halaman detail pelanggan.
 * Data dikirim via sessionStorage agar halaman detail tidak perlu fetch ulang.
 * @param {number|string} id - ID pelanggan dari baris tabel
 */
function openDetail(id) {
  const p = _allData.find(item => String(item.id) === String(id));
  if (!p) {
    toast('Data pelanggan tidak ditemukan.', 'danger');
    return;
  }

  // Sertakan info OLT dari cache agar halaman detail tidak perlu re-fetch
  const oltObj = oltCache.find(o => String(o.id) === String(p.olt_id));
  const payload = Object.assign({}, p, {
    _oltName: oltObj ? oltObj.name : null,
    _oltTipe: oltObj ? oltObj.tipe : null,
    _oltIp: oltObj ? oltObj.ip : null,
    _oltOnuType: oltObj ? (oltObj.onu_type_keyword || 'ALL') : 'ALL',
  });

  try {
    sessionStorage.setItem('tf_detail_pelanggan', JSON.stringify(payload));
  } catch (_) {
    toast('Gagal menyimpan data sementara.', 'danger');
    return;
  }

  window.location.href = '/app/frontend/pelanggan/detail_pelanggan.html';
}
/* ══════════════════════════════════════════════════════════
   HELPERS — UI States
══════════════════════════════════════════════════════════ */
function sembunyikanSemuaState() {
  ['state-loading', 'state-empty', 'state-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}
function tampilLoading() {
  sembunyikanSemuaState();
  // Skeleton rows di tabel — tabel langsung tampil (header + bentuk baris)
  // alih-alih layar kosong, supaya halaman terasa lebih cepat saat fetch.
  const t = document.getElementById('table-pelanggan');
  const tbody = document.getElementById('tbody-pelanggan');
  if (tbody) {
    const cols = 11;
    let rows = '';
    for (let i = 0; i < 8; i++) {
      let cells = '';
      for (let c = 0; c < cols; c++) cells += '<td><span class="skel skel-row"></span></td>';
      rows += '<tr class="skel-tbody">' + cells + '</tr>';
    }
    tbody.innerHTML = rows;
  }
  if (t) t.style.display = '';
}
function tampilEmpty() {
  sembunyikanSemuaState();
  const t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  const e = document.getElementById('state-empty');
  if (e) e.style.display = 'flex';
}
function tampilError(msg) {
  sembunyikanSemuaState();
  const t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  const e = document.getElementById('state-error');
  if (e) e.style.display = 'flex';
  const m = document.getElementById('error-msg');
  if (m) m.textContent = msg;
}
function updateSyncStatus(ok) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = ok ? 'Terhubung' : 'Gagal Terhubung';
  el.className = 'sync-badge ' + (ok ? 'ok' : 'error');
}
function animasiRefresh(on) {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = on ? 'spin .8s linear infinite' : '';
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Dropdown baris per halaman
══════════════════════════════════════════════════════════ */
function ubahJumlahTampil() {
  const select = document.getElementById('perPageSelect');
  if (select) PER_PAGE = parseInt(select.value) || 50;
  currentPage = 1;
  renderTabel();
  renderPaginasi();
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Isi dropdown OLT & Profil ke form
══════════════════════════════════════════════════════════ */


/**
 * Isi dropdown #f-olt di dalam form modal menggunakan data dari oltCache.
 * Jika oltCache kosong, fetch ulang dari server.
 * @param {string|number} selectedVal - olt_id yang akan dipilih (untuk mode edit)
 */
async function _loadOltIntoForm(selectedVal) {
  const sel = document.getElementById('f-olt');
  if (!sel) return;

  // Pastikan cache tersedia
  if (oltCache.length === 0) {
    await loadOltCache();
  }

  sel.innerHTML = '<option value="">-- Pilih OLT (opsional) --</option>';
  oltCache.forEach(olt => {
    const opt = new Option(
      `${olt.name}${olt.tipe ? ' · ' + olt.tipe : ''} (${olt.ip})`,
      olt.id
    );
    if (String(olt.id) === String(selectedVal)) opt.selected = true;
    sel.appendChild(opt);
  });
}

/* Cache semua ODP (dengan koordinat) setelah pertama kali di-load */
var _odpCache = [];

/**
 * Isi dropdown #f-odp — load daftar ODP dari API.
 * @param {string|number} selectedVal - odp_id yang akan dipilih (mode edit)
 */
async function _loadOdpIntoForm(selectedVal) {
  const sel = document.getElementById('f-odp');
  if (!sel) return;
  try {
    const res  = await fetch(`${API_BASE}/api/odp`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    _odpCache = Array.isArray(data) ? data : [];
    _renderOdpOptions(sel, _odpCache, selectedVal);
    if (selectedVal) await _loadOdpPortsIntoForm();
  } catch (_) {}
}

/** Render opsi ODP ke dalam select, dengan grup "Terdekat" jika ada */
function _renderOdpOptions(sel, list, selectedVal, terdekatIds) {
  sel.innerHTML = '<option value="">-- Pilih ODP (opsional) --</option>';
  if (terdekatIds && terdekatIds.length) {
    const grpDekat = document.createElement('optgroup');
    grpDekat.label = '3 ODP Terdekat';
    terdekatIds.forEach(id => {
      const odp = list.find(o => String(o.id) === String(id));
      if (!odp) return;
      const opt = new Option(
        `${odp.nama} (${odp.jumlah_port} port)${odp.lokasi ? ' — ' + odp.lokasi : ''}`,
        odp.id
      );
      if (String(odp.id) === String(selectedVal)) opt.selected = true;
      grpDekat.appendChild(opt);
    });
    sel.appendChild(grpDekat);

    const grpLain = document.createElement('optgroup');
    grpLain.label = 'Semua ODP';
    list.forEach(odp => {
      if (terdekatIds.includes(String(odp.id))) return;
      const opt = new Option(
        `${odp.nama} (${odp.jumlah_port} port)${odp.lokasi ? ' — ' + odp.lokasi : ''}`,
        odp.id
      );
      if (String(odp.id) === String(selectedVal)) opt.selected = true;
      grpLain.appendChild(opt);
    });
    sel.appendChild(grpLain);
  } else {
    list.forEach(odp => {
      const opt = new Option(
        `${odp.nama} (${odp.jumlah_port} port)${odp.lokasi ? ' — ' + odp.lokasi : ''}`,
        odp.id
      );
      if (String(odp.id) === String(selectedVal)) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}

/** Hitung jarak Haversine (km) antara dua koordinat */
function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/** Dipanggil saat koordinat pelanggan berubah — suggest 3 ODP terdekat */
function _suggestOdpTerdekat() {
  const sel   = document.getElementById('f-odp');
  const strip = document.getElementById('odp-suggest-strip');
  const raw   = (document.getElementById('f-koordinat')?.value || '').trim();
  if (!sel || !_odpCache.length) return;

  const parts = raw.split(',');
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) {
    if (strip) strip.style.display = 'none';
    _renderOdpOptions(sel, _odpCache, sel.value);
    return;
  }

  // Hitung jarak ke tiap ODP yang punya koordinat
  const withDist = _odpCache
    .filter(o => o.koordinat && o.koordinat.includes(','))
    .map(o => {
      const p = o.koordinat.split(',');
      const dist = _haversine(lat, lng, parseFloat(p[0]), parseFloat(p[1]));
      return { ...o, _dist: dist };
    })
    .sort((a, b) => a._dist - b._dist);

  if (!withDist.length) {
    if (strip) strip.style.display = 'none';
    return;
  }

  const top3 = withDist.slice(0, 3);
  const terdekatIds = top3.map(o => String(o.id));
  _renderOdpOptions(sel, _odpCache, sel.value, terdekatIds);

  if (strip) {
    strip.style.display = 'block';
    strip.innerHTML = '<span style="color:var(--primary)">&#128205;</span> Terdekat: '
      + top3.map(o => `<strong>${o.nama}</strong> (${o._dist < 1 ? Math.round(o._dist*1000)+'m' : o._dist.toFixed(1)+'km'})`).join(', ');
  }
}

/**
 * Isi dropdown #f-profil di dalam form modal.
 * Profil diambil langsung dari PPP Profile MikroTik milik perangkat
 * yang dipilih di field #f-device (bukan dari _allData lagi — supaya
 * daftar selalu sesuai dengan profil yang benar-benar ada di router itu).
 * @param {string} selectedVal - profil yang akan dipilih (untuk mode edit)
 */
async function _loadProfilIntoForm(selectedVal) {
  const sel = document.getElementById('f-profil');
  if (!sel) return;

  const deviceId = document.getElementById('f-device') ? document.getElementById('f-device').value : '';
  sel.innerHTML = '<option value="">— Pilih Profil —</option>';
  if (!deviceId) return;

  try {
    const res = await fetch(`${API_BASE}/api/profile/${deviceId}`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const profils = Array.isArray(data) ? data.map(p => p.name).filter(Boolean) : [];
    profils.forEach(p => {
      const opt = new Option(p, p);
      if (p === selectedVal) opt.selected = true;
      sel.appendChild(opt);
    });
    // Profil lama (mode edit) mungkin sudah dihapus dari router — tetap tampilkan agar tidak hilang
    if (selectedVal && !profils.includes(selectedVal)) {
      const opt = new Option(`${selectedVal} (tidak ada di router)`, selectedVal);
      opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (_) {
    /* biarkan dropdown kosong kalau gagal mengambil data router */
  }
}

/**
 * Isi dropdown #f-vlan dari VLAN interface MikroTik milik perangkat
 * yang dipilih di #f-device (sumber: /interface/vlan router tersebut).
 * @param {string} selectedVal - vlan yang akan dipilih (untuk mode edit)
 */
async function _loadVlanIntoForm(selectedVal) {
  const sel = document.getElementById('f-vlan');
  if (!sel) return;

  const deviceId = document.getElementById('f-device') ? document.getElementById('f-device').value : '';
  sel.innerHTML = '<option value="">— Pilih VLAN —</option>';
  if (!deviceId) return;

  try {
    const res = await fetch(`${API_BASE}/api/mikrotik/${deviceId}/vlans`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const vlans = Array.isArray(data) ? [...new Set(data.map(v => v.vlan_id).filter(Boolean))] : [];
    const selectedStr = (selectedVal !== null && selectedVal !== undefined && selectedVal !== '') ? String(selectedVal) : '';
    vlans.forEach(vid => {
      const opt = new Option(vid, vid);
      if (selectedStr && String(vid) === selectedStr) opt.selected = true;
      sel.appendChild(opt);
    });
    // VLAN lama (mode edit) mungkin sudah tidak ada di router — tetap tampilkan agar tidak hilang
    if (selectedStr && !vlans.some(vid => String(vid) === selectedStr)) {
      const opt = new Option(`${selectedStr} (tidak ada di router)`, selectedStr);
      opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (_) {
    /* biarkan dropdown kosong kalau gagal mengambil data router */
  }
}

/**
 * Dipanggil saat user mengganti perangkat MikroTik di form pelanggan —
 * muat ulang saran Profil & VLAN supaya sesuai dengan router yang baru dipilih.
 */
function _onDeviceChangeForm() {
  _loadProfilIntoForm('');
  _loadVlanIntoForm('');
}

async function _loadKolektorIntoForm(selectedVal) {
  const sel = document.getElementById('f-kolektor');
  if (!sel) return;
  try {
    const r = await fetch(`${API_BASE}/api/kolektor-list`, {
      credentials: 'include', headers: (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}
    });
    if (!r.ok) return;
    const list = await r.json();
    sel.innerHTML = '<option value="">— Tidak Ditugaskan —</option>';
    list.forEach(k => {
      const opt = new Option(k.nama || k.username, k.username);
      if (k.username === selectedVal) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

/* ── Load port kosong ODP setelah pilih ODP ── */
async function _loadOdpPortsIntoForm() {
  const odpId = document.getElementById('f-odp')?.value;
  const wrap   = document.getElementById('f-port-odp-wrap');
  const sel    = document.getElementById('f-port-odp');
  if (!odpId || !wrap || !sel) { if (wrap) wrap.style.display = 'none'; return; }

  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  try {
    const r = await fetch(`${base}/api/odp/${odpId}/ports`, { credentials: 'include', headers: hdr });
    if (!r.ok) { wrap.style.display = 'none'; return; }
    const d = await r.json();

    // Update label dengan info tersedia/total
    const labelEl = wrap.querySelector('label .form-label') || wrap.querySelector('.form-label');
    if (labelEl) {
      const info = `(${d.tersedia?.length || 0} kosong dari ${d.total || 0} port)`;
      const small = labelEl.querySelector('span.port-info') || document.createElement('span');
      small.className = 'port-info';
      small.style.cssText = 'font-size:10px;font-weight:400;color:var(--text-dim);margin-left:6px';
      small.textContent = info;
      if (!labelEl.querySelector('span.port-info')) labelEl.appendChild(small);
    }

    sel.innerHTML = '<option value="">-- Pilih Port --</option>';

    // Port tersedia (kosong)
    (d.tersedia || []).forEach(p => {
      sel.appendChild(new Option('Port ' + p + '  ✓ kosong', p));
    });

    // Port terpakai (disabled)
    Object.entries(d.pelanggan_per_port || {}).forEach(([port, user]) => {
      const opt = new Option('Port ' + port + '  — ' + user + '  (terpakai)', port);
      opt.disabled = true;
      opt.style.color = 'var(--text-dim)';
      sel.appendChild(opt);
    });

    wrap.style.display = '';
  } catch(_) { if (wrap) wrap.style.display = 'none'; }
}

/* ── Scan SN unregistered dari OLT ── */
async function _scanSnOlt() {
  const oltId = document.getElementById('f-olt')?.value;
  const resultDiv = document.getElementById('scan-sn-result');
  if (!oltId) { toast('Pilih OLT terlebih dahulu', 'warning'); return; }
  if (!resultDiv) return;

  resultDiv.style.display = '';
  resultDiv.innerHTML = '<div style="padding:12px;font-size:12.5px;color:var(--text-muted)">' +
    '<span class="material-symbols-outlined" style="vertical-align:middle;font-size:16px">sensors</span>' +
    ' Scanning OLT… (bisa 10–30 detik)</div>';

  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};

  /* ── Coba live scan ke OLT ── */
  let liveFailed = false;
  try {
    const r = await fetch(`${base}/olt/${oltId}/scan-sn`, { method: 'POST', credentials: 'include', headers: hdr });
    const d = await r.json();
    if (!r.ok) {
      liveFailed = true;
    } else {
      const list = d.unregistered || [];
      if (!list.length) {
        resultDiv.innerHTML = '<div style="padding:12px;font-size:12.5px;color:var(--green)">Tidak ada ONU baru yang terdeteksi.</div>';
        return;
      }
      resultDiv.innerHTML =
        '<div style="padding:8px 12px;font-size:11.5px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">' +
        list.length + ' ONU belum terdaftar — klik untuk mengisi form</div>' +
        list.map(function(item) {
          return '<div onclick="_pilihSn(\'' + (item.sn||'') + '\',\'' + (item.slot_port||'') + '\')" ' +
            'style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px" ' +
            'onmouseover="this.style.background=\'var(--surface)\'" onmouseout="this.style.background=\'\'">' +
            '<span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">wifi</span>' +
            '<div><div style="font-weight:700;font-size:13px">' + formatSn(item.sn) + '</div>' +
            '<div style="font-size:11.5px;color:var(--text-dim)">Slot/Port: ' + (item.slot_port||'—') + ' \xb7 ' + (item.tipe||'gpon') + '</div></div>' +
            '</div>';
        }).join('');
      return;
    }
  } catch(e) {
    liveFailed = true;
  }

  /* ── Fallback: data cache dari tabel onu_liar (sync background terakhir) ── */
  if (liveFailed) {
    resultDiv.innerHTML =
      '<div style="padding:9px 12px;font-size:12px;color:var(--amber);background:var(--amber-bg);' +
      'border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">' +
      '<span class="material-symbols-outlined" style="font-size:15px;flex-shrink:0">warning</span>' +
      'OLT tidak dapat diakses langsung. Menampilkan data cache dari sinkronisasi terakhir.</div>';
    try {
      const r2 = await fetch(`${base}/olt/${oltId}/unauthorized`, { credentials: 'include', headers: hdr });
      const cached = await r2.json();
      if (!r2.ok || !cached.length) {
        resultDiv.innerHTML +=
          '<div style="padding:12px;font-size:12.5px;color:var(--text-muted)">' +
          'Belum ada data ONU liar tersimpan. Pastikan sync ONU pernah berjalan sukses.</div>';
        return;
      }
      resultDiv.innerHTML +=
        '<div style="padding:8px 12px;font-size:11.5px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">' +
        cached.length + ' ONU liar tersimpan — klik untuk mengisi SN</div>' +
        cached.map(function(item) {
          var dt = (item.detected_at || '').substring(0, 16).replace('T', ' ');
          return '<div onclick="_pilihSn(\'' + (item.sn||'') + '\',\'\')" ' +
            'style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px" ' +
            'onmouseover="this.style.background=\'var(--surface)\'" onmouseout="this.style.background=\'\'">' +
            '<span class="material-symbols-outlined" style="font-size:18px;color:var(--amber)">wifi_off</span>' +
            '<div><div style="font-weight:700;font-size:13px">' + formatSn(item.sn) + '</div>' +
            '<div style="font-size:11.5px;color:var(--text-dim)">Port OLT: ' + (item.port||'—') + ' \xb7 Cache: ' + (dt||'—') + '</div></div>' +
            '</div>';
        }).join('');
    } catch(e2) {
      resultDiv.innerHTML += '<div style="padding:12px;color:var(--red);font-size:12.5px">Gagal memuat cache: ' + e2.message + '</div>';
    }
  }
}

function _pilihSn(sn, slotPort) {
  const snEl   = document.getElementById('f-sn');
  const slotEl = document.getElementById('f-slot');
  if (snEl && sn) snEl.value = sn;
  if (slotEl && slotPort) slotEl.value = slotPort;
  const res = document.getElementById('scan-sn-result');
  if (res) res.style.display = 'none';
  toast('SN dan Slot/Port sudah diisi otomatis', 'success');
}

// Alias untuk kompatibilitas kode lama
async function loadOltOptions() {
  await loadOltCache();
}

/* ══════════════════════════════════════════════════════════
   GEOLOKASI — Form Pelanggan
   Sejajar dengan input_odc.js dan input_odp.js
══════════════════════════════════════════════════════════ */

function deteksiLokasiPelanggan() { geoDetectKoordinat(); }  /* pakai fungsi bersama di global.js */

function previewKoordinatPelanggan() {
  const raw     = (document.getElementById('f-koordinat')?.value || '').trim();
  const preview = document.getElementById('koordinat-preview-pel');
  const iframe  = document.getElementById('koordinat-iframe-pel');
  if (!preview || !iframe) return;

  const parts = raw.split(',').map(s => s.trim());
  if (
    parts.length === 2 &&
    !isNaN(parseFloat(parts[0])) &&
    !isNaN(parseFloat(parts[1]))
  ) {
    iframe.src = `https://maps.google.com/maps?q=${parseFloat(parts[0])},${parseFloat(parts[1])}&z=15&output=embed`;
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
    iframe.src = '';
  }
}





/* ══════════════════════════════════════════════════════════
   EKSPOS FUNGSI KE GLOBAL SCOPE (Wajib agar onclick di HTML aktif)
══════════════════════════════════════════════════════════ */
window.openEdit   = openEdit;
window.openDetail = openDetail;
window.sortByRx   = sortByRx;
window.filterPelanggan          = filterPelanggan;
window.deteksiLokasiPelanggan   = deteksiLokasiPelanggan;
window.previewKoordinatPelanggan = previewKoordinatPelanggan;

// Pilihan massal
window._cbAllChange  = _cbAllChange;
window._batalPilihan = _batalPilihan;
window._isolirMassal = _isolirMassal;
window._aktifMassal  = _aktifMassal;
