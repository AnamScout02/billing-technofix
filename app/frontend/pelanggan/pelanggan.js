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
      - generateCliScript()→ menggunakan data OLT terpilih

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
let hapusTarget = null;
let selectedDevice = null;
let detailTarget = null;

// Cache RX/TX dari endpoint terpisah
let rxTxCache = {};

// ── Sort state ──
let sortCol = null;   // 'rx' saat ini
let sortDir = 'desc'; // 'asc' | 'desc'

// ── BARU: Cache daftar OLT (agar tidak re-fetch setiap buka form) ──
let oltCache = [];   // Array of { id, name, tipe, ip }


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Kolektor: sembunyikan tombol tambah, ganti header tabel
  const _role = localStorage.getItem('tf_role') || '';
  if (_role === 'kolektor') {
    const btn = document.getElementById('btn-tambah-pelanggan');
    if (btn) btn.style.display = 'none';
    // Ganti header tabel ke versi kolektor
    const thead = document.querySelector('#table-pelanggan thead tr');
    if (thead) {
      thead.innerHTML =
        '<th class="sticky-col-1">#</th>' +
        '<th class="sticky-col-2">Pelanggan</th>' +
        '<th>No. HP</th>' +
        '<th>Profil</th>' +
        '<th>Tagihan</th>' +
        '<th>Status</th>' +
        '<th>Aksi</th>';
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
async function loadDevices() {
  try {
    const res = await fetch(`${API_BASE}/devices`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();

    const selHeader = document.getElementById('select-device');
    selHeader.innerHTML = '<option value="">— Pilih Perangkat —</option>';
    data.forEach(d => {
      selHeader.appendChild(new Option(`${d.name}  (${d.ip})`, d.id));
    });

    const savedDevice = localStorage.getItem('lastSelectedDevice');
    if (savedDevice && data.some(d => d.id == savedDevice)) {
      selHeader.value = savedDevice;
    } else if (data.length === 1) {
      selHeader.value = data[0].id;
    } else {
      selectedDevice = null;
    }

    loadPelanggan();
  } catch (err) {
    tampilError('Gagal memuat daftar perangkat. Pastikan server Python berjalan.');
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
      (p.slot_port || '').toLowerCase().includes(keyword) ||
      (p.vlan || '').toLowerCase().includes(keyword) ||
      (p.koordinat || '').toLowerCase().includes(keyword);

    const matchStatus =
      !status ||
      (status === 'aktif' && p.status === 'Online') ||
      (status === 'nonaktif' && p.status !== 'Online');

    let matchRedaman = true;
    if (redaman) {
      const rxInfo = parseRxTx(p);
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
    const rxA = parseRxTx(a).rx;
    const rxB = parseRxTx(b).rx;
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
    const cls = parseRxTx(p).rxClass;
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

    const rxInfo  = parseRxTx(p);
    const namaOlt = _getNamaOlt(p.olt_id);
    const rxBuruk = rxInfo.rxClass === 'rx-buruk';
    const rowAttr = ` data-id="${p.id}" data-username="${escHtml(p.username || '')}"${rxBuruk ? ' class="row-rx-buruk"' : ''}`;
    const rp = n => 'Rp ' + (Number(n)||0).toLocaleString('id-ID');

    // ── Baris KOLEKTOR — lebih sederhana, tambah kolom Tagihan + Bayar ──
    if (_isKol) {
      return `
        <tr${rowAttr}>
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
        <td class="sticky-col-0">
          <input type="checkbox" class="cb-row"
            data-id="${p.id}"
            onchange="toggleSelect(${p.id}, this.checked)"
            style="width:15px;height:15px;accent-color:var(--primary);cursor:pointer"
            ${_selectedIds.has(p.id) ? 'checked' : ''}>
        </td>
        <td class="sticky-col-1">${no}</td>

        <td class="sticky-col-2">
          <span class="tbl-username">${escHtml(p.username || '—')}</span>
        </td>

        <td><span class="tbl-hp">${escHtml(p.hp || '—')}</span></td>

        <td><span class="badge-profil">${escHtml(p.profil || '—')}</span></td>

        <td>${escHtml(p.slot_port || '—')}</td>

        <td>${escHtml(p.vlan || '—')}</td>

        <td>${escHtml(p.sn || '—')}</td>

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

  // Inject toolbar bulk setelah render selesai
  _injectBulkToolbar();
  _updateBulkToolbar();
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
    const sel = prefill
      ? (String(prefill.device_id) === o.value ? 'selected' : '')
      : (devSel.value === o.value ? 'selected' : '');
    deviceOptions += `<option value="${escHtml(o.value)}" ${sel}>${escHtml(o.text)}</option>`;
  });

  // v(key): ambil nilai prefill untuk form — hp fallback ke no_hp untuk data lama
  const v = k => {
    if (!prefill) return '';
    // Field hp: coba hp dulu, fallback ke no_hp (data legacy)
    if (k === 'hp') return escHtml(prefill.hp || prefill.no_hp || '');
    return escHtml(prefill[k] || '');
  };

  // Checkbox re-provisioning (hanya mode edit & ada data OLT)
  const reProvisionRow = isEdit ? `
    <div class="form-group full" style="margin-top:4px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;
             font-size:13px;color:var(--text-muted);">
        <input type="checkbox" id="f-reprovision" style="width:16px;height:16px;accent-color:var(--primary);">
        Kirim ulang perintah provisioning ke OLT (re-provisioning)
      </label>
    </div>` : '';

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
            <select class="form-input" id="f-device">${deviceOptions}</select>
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

          <!-- ODP — titik distribusi ke pelanggan ini -->
          <div class="form-group full">
            <label class="form-label">
              ODP
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk garis topologi di Maps)</span>
            </label>
            <select class="form-input" id="f-odp" onchange="_loadOdpPortsIntoForm()">
              <option value="">-- Pilih ODP (opsional) --</option>
            </select>
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
            <label class="form-label">VLAN</label>
            <input class="form-input" id="f-vlan" type="text"
              placeholder="cth: 100" value="${v('vlan')}">
          </div>

          <!-- Serial Number + Scan OLT -->
          <div class="form-group full">
            <label class="form-label">Serial Number (SN) Modem/ONU</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="form-input" id="f-sn" type="text"
                placeholder="cth: ZTEG1A2B3C4D atau HWTC1A2B3C4D" value="${v('sn')}" style="flex:1">
              <button type="button" class="btn btn-sm btn-blue" onclick="_scanSnOlt()" title="Scan SN dari OLT yang dipilih">
                <span class="material-symbols-outlined">wifi_find</span>Scan OLT
              </button>
            </div>
            <span class="form-hint">Atau klik "Scan OLT" untuk mendeteksi ONU yang belum terdaftar</span>
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

          ${reProvisionRow}

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

          <!-- Titik Koordinat -->
          <div class="form-group full">
            <label class="form-label">
              <span class="material-symbols-outlined"
                    style="font-size:13px;vertical-align:middle;color:var(--primary)">location_on</span>
              Titik Koordinat Rumah Pelanggan
              <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk Maps)</span>
            </label>
            <div class="koordinat-row">
              <input class="form-input" id="f-koordinat" type="text"
                placeholder="cth: -8.267870, 114.369284"
                value="${prefill ? escHtml(prefill.titik_koordinat || prefill.koordinat || '') : ''}"
                oninput="previewKoordinatPelanggan()">
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

        </div>

        <div class="form-actions">
          <button class="btn" onclick="tutupModalPelanggan()">
            <span class="material-symbols-outlined">close</span> Batal
          </button>
          <button class="btn-primary" id="btn-save-pelanggan" onclick="simpanPelanggan()">
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
    _loadKolektorIntoForm(prefill ? (prefill.kolektor || '') : '');
    const u = document.getElementById('f-username');
    if (u) u.focus();
  });
}

function tutupModalPelanggan() {
  _editingId = null;
  closeModalForm(); // ← dari global.js
}

// Alias agar kode lama tetap jalan
function openModalTambah() { showFormPelanggan(null); }

/* ── Bayar tagihan kolektor dari halaman Pelanggan ─────── */
async function _kolBayarDariPelanggan(username, nama, harga) {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  const rp   = n => 'Rp ' + (Number(n)||0).toLocaleString('id-ID');

  try {
    // Ambil semua tagihan belum bayar untuk username ini
    const r = await fetch(`${base}/api/tagihan/pelanggan/${encodeURIComponent(username)}`,
      { credentials: 'include', headers: hdr });
    const d = await r.json();
    const belum = (d.tagihan || []).filter(t => t.status === 'belum_bayar');

    if (!belum.length) {
      toast('Tidak ada tagihan yang perlu dibayar untuk ' + nama, 'info');
      return;
    }

    if (belum.length === 1) {
      // Langsung bayar
      const metode = prompt(`Bayar tagihan "${nama}" — ${belum[0].periode}\nNominal: ${rp(belum[0].nominal)}\n\nMetode:`, 'Cash');
      if (!metode) return;
      const rb = await fetch(`${base}/api/tagihan/bayar-multi`, {
        method: 'POST', credentials: 'include',
        headers: Object.assign({'Content-Type':'application/json'}, hdr),
        body: JSON.stringify({ tagihan_ids: [belum[0].id], metode })
      });
      const db = await rb.json();
      toast(db.message || (rb.ok ? 'Lunas' : 'Gagal'), rb.ok ? 'success' : 'danger');
      if (rb.ok) { await loadPelanggan(); _kolKirimStrukWA(username, nama, db.total); }
      return;
    }

    // Multi-bulan — tampilkan pilihan
    const list = belum.map((t, i) =>
      `${i+1}. ${t.periode} — ${rp(t.nominal)} (jatuh tempo ${t.jatuh_tempo||'-'})`
    ).join('\n');
    const metode = prompt(`${nama} punya ${belum.length} tagihan belum lunas:\n\n${list}\n\nKetik metode pembayaran (semua akan dibayar):`, 'Cash');
    if (!metode) return;
    const ids = belum.map(t => t.id);
    const rb = await fetch(`${base}/api/tagihan/bayar-multi`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({'Content-Type':'application/json'}, hdr),
      body: JSON.stringify({ tagihan_ids: ids, metode })
    });
    const db = await rb.json();
    toast(db.message || (rb.ok ? 'Lunas' : 'Gagal'), rb.ok ? 'success' : 'danger');
    if (rb.ok) { await loadPelanggan(); _kolKirimStrukWA(username, nama, db.total); }

  } catch(e) {
    toast('Tidak bisa menghubungi server', 'danger');
  }
}

function _kolKirimStrukWA(username, nama, total) {
  const p = _allData.find(x => x.username === username);
  const hp = p ? ((p.hp||'').replace(/\D/g,'')) : '';
  if (!hp) return;
  const wa = '62' + (hp.startsWith('0') ? hp.slice(1) : hp);
  const kol = localStorage.getItem('tf_username') || 'Kolektor';
  const isp = localStorage.getItem('tf_isp_name') || 'TechnoFix';
  const tgl = new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'});
  const rp  = n => 'Rp ' + (Number(n)||0).toLocaleString('id-ID');
  const pesan = encodeURIComponent(
    'Bukti Pembayaran - ' + isp + '\n' +
    '----------------------------\n' +
    'Pelanggan : ' + nama + '\n' +
    'Tanggal   : ' + tgl + '\n' +
    'Total     : ' + rp(total) + '\n' +
    'Kolektor  : ' + kol + '\n' +
    '----------------------------\n' +
    'Terima kasih!'
  );
  if (confirm('Kirim struk via WhatsApp ke ' + nama + '?')) {
    window.open('https://wa.me/' + wa + '?text=' + pesan, '_blank');
  }
}
function cancelFormPelanggan() { tutupModalPelanggan(); }


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

  // ── Jalankan Validasi Sisi Frontend ─────────────────────────
  if (!username) { toast('Username wajib diisi', 'warning'); return; }
  if (!isModeEdit && !password) { toast('Password wajib diisi untuk pelanggan baru', 'warning'); return; }
  if (!deviceId) { toast('Pilih perangkat MikroTik terlebih dahulu', 'warning'); return; }

  // Peringatan provisioning OLT
  if (oltId && !sn) { toast('⚠ SN modem kosong — provisioning OLT akan dilewati', 'warning'); }
  if (oltId && !slot) { toast('⚠ Slot/Port kosong — provisioning OLT akan dilewati', 'warning'); }

  // Animasi loading tombol simpan
  const btn = document.getElementById('btn-save-pelanggan');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menyimpan & Provisioning...';
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
      kolektor: document.getElementById('f-kolektor')?.value || '',
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

    // Tutup modal form pelanggan (Mendukung fungsi tutup bawaan sistem Anda)
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
    // Kembalikan status tombol simpan ke sediakala
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span class="material-symbols-outlined">${isModeEdit ? 'check' : 'bolt'}</span> ` +
        (isModeEdit ? 'Simpan Perubahan' : 'Provisioning & Simpan');
    }
  }
}


/* ══════════════════════════════════════════════════════════
   10. MODAL DETAIL / AKSI PERANGKAT
   ← PEMBARUAN:
     - Tampilkan No. Telepon (hp) di bagian info pelanggan
     - Tampilkan Data OLT: nama OLT, Slot/Port, VLAN, SN
     - generateCliScript() menggunakan data OLT dari objek pelanggan
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
  });

  try {
    sessionStorage.setItem('tf_detail_pelanggan', JSON.stringify(payload));
  } catch (_) {
    toast('Gagal menyimpan data sementara.', 'danger');
    return;
  }

  window.location.href = '/app/frontend/pelanggan/detail_pelanggan.html';
}
function tutupModalDetail() { closeModalForm(); }


/* ══════════════════════════════════════════════════════════
   GENERATE CLI SCRIPT
   ← PEMBARUAN: deteksi tipe OLT dari oltCache untuk
     generate CLI ZTE vs Huawei yang tepat
══════════════════════════════════════════════════════════ */
function generateCliScript(p) {
  const slotRaw = p.slot_port || '1/3/6:1';
  const parts = slotRaw.split(':');
  const gponPath = parts[0] || '1/3/6';
  const onuId = parts[1] || '1';
  const username = p.username || 'pelanggan';
  const sn = p.sn || 'ZTEG00000000';
  const vlan = p.vlan || '200';
  const profil = (p.profil || 'PAKET1').toUpperCase();
  const password = '••••••';   // Password tidak ditampilkan di script

  // Deteksi tipe OLT dari cache
  const olt = oltCache.find(o => String(o.id) === String(p.olt_id));
  const tipe = (olt?.tipe || '').toLowerCase();

  if (tipe.includes('huawei')) {
    // ── Script Huawei MA5600 / MA5800 ──
    return [
      'enable',
      'config',
      `interface gpon 0/${gponPath}`,
      `ont add ${onuId} sn-auth ${sn} omci ont-lineprofile-id 10 ont-srvprofile-id 10 desc ${username}`,
      'quit',
      `service-port vlan ${vlan} gpon 0/${gponPath} ont ${onuId} gemport 1 multi-service user-vlan ${vlan} tag-transform translate`,
      'quit',
      'save',
    ].join('\n');
  }

  // ── Script ZTE C300 / C600 (default) ──
  return [
    'con t',
    `interface gpon-olt_${gponPath}`,
    `no onu ${onuId}`,
    `onu ${onuId} type ALL-ONT sn ${sn} vport-mode gemport`,
    'exit',
    `interface gpon-onu_${gponPath}:${onuId}`,
    `name ${username}`,
    'sn-bind enable sn',
    `tcont 1 profile ${profil}`,
    'gemport 1 tcont 1',
    'switchport mode hybrid vport 1',
    `service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`,
    'exit',
    `pon-onu-mng gpon-onu_${gponPath}:${onuId}`,
    `service HSI gemport 1 cos 0-7 vlan ${vlan}`,
    `wan-ip 1 mode pppoe username ${username} password ${password} vlan-profile vlan${vlan} host 1`,
    'wan-ip 1 ping-response enable traceroute-response enable',
    'security-mgmt 212 state enable mode forward protocol web',
    'end',
    'wr',
  ].join('\n');
}

function copyCliScript() {
  const el = document.getElementById('cli-script-content');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent)
    .then(() => toast('Script disalin ke clipboard', 'success'))
    .catch(() => toast('Gagal menyalin script', 'danger'));
}

function aksiModem(aksi) {
  if (!detailTarget) return;
  const label = {
    remote: 'Remote Modem',
    reboot: 'Reboot Modem',
    enable: 'Enable Modem',
    disable: 'Disable Modem',
    hapus: 'Hapus Modem'
  }[aksi] || aksi;
  toast(`${label}: ${detailTarget.username}`, 'info');
}


/* ══════════════════════════════════════════════════════════
   11. HAPUS PELANGGAN
══════════════════════════════════════════════════════════ */
function openHapus(id, username) {
  hapusTarget = { id, username };
  const el = document.getElementById('hapus-username');
  if (el) el.textContent = username;
  bukaModal('modal-hapus');
}

async function konfirmasiHapus() {
  if (!hapusTarget) return;

  try {
    const selEl = document.getElementById('select-device');
    const deviceId = selEl ? selEl.value : '';
    const res = await fetch(`${API_BASE}/api/pelanggan/${hapusTarget.id}`, {
      method:      'DELETE',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify({ device_id: Number(deviceId), username: hapusTarget.username }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message);

    tutupModalHapus();
    toast(`${hapusTarget.username} berhasil dihapus`, 'danger');
    hapusTarget = null;
    await loadPelanggan();
  } catch (err) {
    toast(err.message, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Modal
══════════════════════════════════════════════════════════ */
function bukaModal(id) { document.getElementById(id)?.classList.add('open'); }
function tutupModal(id) { document.getElementById(id)?.classList.remove('open'); }
function tutupModalHapus() { tutupModal('modal-hapus'); }
function closeModalHapus(e) { if (e.target.id === 'modal-hapus') tutupModalHapus(); }


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
  const t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  const l = document.getElementById('state-loading');
  if (l) l.style.display = 'flex';
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
  el.innerHTML = ok ? '🟢 Terhubung' : '🔴 Gagal Terhubung';
  el.className = 'sync-status ' + (ok ? 'ok' : 'err');
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
 * Load daftar OLT ke oltCache (dipanggil sekali saat DOMContentLoaded).
 * Fungsi ini menggantikan loadOltOptions() yang lama agar tidak bergantung
 * pada elemen DOM yang mungkin belum ada.
 */
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
    sel.innerHTML = '<option value="">-- Pilih ODP (opsional) --</option>';
    (Array.isArray(data) ? data : []).forEach(odp => {
      const opt = new Option(
        `${odp.nama} (${odp.jumlah_port} port)${odp.lokasi ? ' — ' + odp.lokasi : ''}`,
        odp.id
      );
      if (String(odp.id) === String(selectedVal)) opt.selected = true;
      sel.appendChild(opt);
    });
    // Setelah dropdown terisi & nilai dipilih, muat port yang tersedia
    // (programmatic set tidak trigger onchange, jadi panggil manual)
    if (selectedVal) {
      await _loadOdpPortsIntoForm();
    }
  } catch (_) {}
}

/**
 * Isi dropdown #f-profil di dalam form modal.
 * Profil diambil dari daftar pelanggan yang sudah di-load.
 * @param {string} selectedVal - profil yang akan dipilih (untuk mode edit)
 */
function _loadProfilIntoForm(selectedVal) {
  const profils = [...new Set(_allData.map(p => p.profil).filter(Boolean))].sort();

  const sel = document.getElementById('f-profil');
  if (sel) {
    sel.innerHTML = '<option value="">— Pilih Profil —</option>';
    profils.forEach(p => {
      const opt = new Option(p, p);
      if (p === selectedVal) opt.selected = true;
      sel.appendChild(opt);
    });
  }

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
  resultDiv.innerHTML = '<div style="padding:12px;font-size:12.5px;color:var(--text-muted)"><span class="material-symbols-outlined" style="vertical-align:middle;font-size:16px">sensors</span> Scanning OLT… (bisa 10–30 detik)</div>';

  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  try {
    const r = await fetch(`${base}/olt/${oltId}/scan-sn`, { method: 'POST', credentials: 'include', headers: hdr });
    const d = await r.json();
    if (!r.ok) { resultDiv.innerHTML = '<div style="padding:12px;color:var(--red);font-size:12.5px">' + (d.error || 'Gagal scan') + '</div>'; return; }

    const list = d.unregistered || [];
    if (!list.length) {
      resultDiv.innerHTML = '<div style="padding:12px;font-size:12.5px;color:var(--green)">Tidak ada ONU baru yang terdeteksi.</div>';
      return;
    }
    resultDiv.innerHTML = '<div style="padding:8px 12px;font-size:11.5px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">' +
      list.length + ' ONU belum terdaftar — klik untuk mengisi form</div>' +
      list.map(item =>
        '<div onclick="_pilihSn(\'' + (item.sn||'') + '\',\'' + (item.slot_port||'') + '\')" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px" onmouseover="this.style.background=\'var(--surface)\'" onmouseout="this.style.background=\'\'">' +
        '<span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">wifi</span>' +
        '<div><div style="font-weight:700;font-size:13px">' + (item.sn||'—') + '</div>' +
        '<div style="font-size:11.5px;color:var(--text-dim)">Slot/Port: ' + (item.slot_port||'—') + ' · ' + (item.tipe||'gpon') + '</div></div>' +
        '</div>'
      ).join('');
  } catch(e) {
    resultDiv.innerHTML = '<div style="padding:12px;color:var(--red);font-size:12.5px">Error: ' + e.message + '</div>';
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
   11. LOAD RX/TX SIGNAL - SINKRONISASI COCOK DENGAN ARRAY API
══════════════════════════════════════════════════════════ */
async function loadRxTx() {
  const selectDeviceEl = document.getElementById('select-device');
  if (!selectDeviceEl) return;

  const deviceId = selectDeviceEl.value;
  if (!deviceId || deviceId === "" || deviceId === "0") return;

  const syncStatus = document.getElementById('sync-status');
  if (syncStatus) syncStatus.innerHTML = '🔄 Mengambil sinyal OLT...';

  try {
    // Tembak endpoint API bawaan api.py kamu
    const res = await fetch(`${API_BASE}/api/pelanggan/${Number(deviceId)}/rx-tx`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Gagal memuat sinyal dari server.');

    // ... potongan kode di dalam loadRxTx() setelah fetch ...
    const listSinyal = await res.json();
    
    listSinyal.forEach(onu => {
      const username = onu.username;
      if (!username) return;

      // Cari baris tabel berdasarkan data-username pppoe
      const row = document.querySelector(`tr[data-username="${username}"]`);
      if (row) {
        const rxCell = row.querySelector('.col-rx');
        if (rxCell) {
          // FIX UTAMA: Sesuaikan key dengan isi api.py ('rx_power', bukan 'rx')
          const rxNilai = onu.rx_power; 
          
          if (rxNilai && rxNilai !== '-' && rxNilai !== 'None' && rxNilai !== 'null') {
            const rxFormat = typeof parseRxTx === 'function' ? parseRxTx(rxNilai) : rxNilai;
            const rxClass = typeof getRxTxClass === 'function' ? getRxTxClass(parseFloat(String(rxNilai).replace(/dBm/i,'').trim())) : 'rx-none';
            rxCell.innerHTML = `<span class="tbl-rx ${rxClass}">${rxFormat} dBm</span>`;
          } else {
            // Jika data di DB lokal masih None/- artinya OLT Sync belum meng-update baris ini
            rxCell.innerHTML = `<span class="text-muted" title="Belum sinkron OLT">—</span>`;
          }
        }
      }
    });

    if (syncStatus) syncStatus.innerHTML = '✅ Sinyal OLT Ter-sinkronisasi';

  } catch (err) {
    console.error("Gagal memuat sinyal RX/TX:", err);
    if (syncStatus) syncStatus.innerHTML = `⚠ Sinyal gagal dimuat`;
  }
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

// Pastikan fungsi diekspos ke scope window global
window.loadRxTx = loadRxTx;


/* ══════════════════════════════════════════════════════════
   FITUR BULK — Isolir & Aktifkan Massal
   ============================================================
   Alur:
   1. User cari pelanggan via search box
   2. Klik checkbox per baris atau "Pilih Semua"
   3. Klik tombol "Isolir Terpilih" atau "Aktifkan Terpilih"
   4. Modal konfirmasi tampil dengan daftar pelanggan terpilih
   5. Kirim ke /api/pelanggan/bulk-isolir atau bulk-aktifkan
   ============================================================ */

let _selectedIds = new Set();   // ID pelanggan yang dipilih

/* _attachCheckboxes sudah tidak diperlukan — checkbox di-render langsung di template tabel */

function toggleSelect(id, checked) {
  if (checked) {
    _selectedIds.add(Number(id));
  } else {
    _selectedIds.delete(Number(id));
    const cbAll = document.getElementById('cb-select-all');
    if (cbAll) cbAll.checked = false;
  }
  _updateBulkToolbar();
}

function toggleSelectAll(checked) {
  _selectedIds.clear();
  if (checked) {
    document.querySelectorAll('.cb-row').forEach(cb => {
      _selectedIds.add(Number(cb.dataset.id));
      cb.checked = true;
    });
  } else {
    document.querySelectorAll('.cb-row').forEach(cb => cb.checked = false);
  }
  _updateBulkToolbar();
}

function _updateBulkToolbar() {
  const count   = _selectedIds.size;
  const toolbar = document.getElementById('bulk-toolbar');
  const label   = document.getElementById('bulk-count-label');

  if (!toolbar) return;
  toolbar.style.display = count > 0 ? 'flex' : 'none';
  if (label) label.textContent = `${count} pelanggan dipilih`;
}

/* Tampilkan toolbar bulk — dipanggil dari renderTable */
function _injectBulkToolbar() {
  if (document.getElementById('bulk-toolbar')) return;

  const container = document.querySelector('.page') || document.body;
  const toolbar   = document.createElement('div');
  toolbar.id      = 'bulk-toolbar';
  toolbar.style.cssText = `
    display:none; position:fixed; bottom:72px; left:50%;
    transform:translateX(-50%);
    background:var(--text); color:#fff;
    border-radius:99px; padding:10px 16px;
    box-shadow:0 4px 20px rgba(0,0,0,.3);
    align-items:center; gap:10px; z-index:200;
    font-size:13px; font-weight:600;
    animation:fadeUp .2s ease;
  `;
  toolbar.innerHTML = `
    <span class="material-symbols-outlined" style="font-size:18px">checklist</span>
    <span id="bulk-count-label">0 dipilih</span>
    <div style="width:1px;height:20px;background:rgba(255,255,255,.25)"></div>
    <button onclick="openBulkModal('isolir')"
            style="background:var(--red);color:#fff;border:none;border-radius:99px;
                   padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;
                   display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">block</span>
      Isolir Terpilih
    </button>
    <button onclick="openBulkModal('aktifkan')"
            style="background:var(--green);color:#fff;border:none;border-radius:99px;
                   padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;
                   display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">check_circle</span>
      Aktifkan Terpilih
    </button>
    <button onclick="clearSelection()"
            style="background:rgba(255,255,255,.15);color:#fff;border:none;
                   border-radius:99px;padding:6px 10px;cursor:pointer;
                   display:flex;align-items:center;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:16px">close</span>
    </button>
  `;
  container.appendChild(toolbar);
}

function clearSelection() {
  _selectedIds.clear();
  document.querySelectorAll('.cb-row').forEach(cb => cb.checked = false);
  const cbAll = document.getElementById('cb-select-all');
  if (cbAll) cbAll.checked = false;
  _updateBulkToolbar();
}

function openBulkModal(aksi) {
  if (_selectedIds.size === 0) return;

  const ids      = [..._selectedIds];
  const selected = _allData.filter(p => ids.includes(p.id));
  const isIsolir = aksi === 'isolir';

  const listHtml = selected.map(p => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;
         border-bottom:1px solid var(--border);">
      <span class="material-symbols-outlined"
            style="font-size:14px;color:${isIsolir ? 'var(--red)' : 'var(--green)'}">
        ${isIsolir ? 'block' : 'check_circle'}
      </span>
      <span style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(p.username)}</span>
      <span style="font-size:11px;color:var(--text-dim);margin-left:auto">
        ${escHtml(p.profil || '—')}
      </span>
    </div>`).join('');

  openModalForm(`
    <div class="modal" style="max-width:440px;width:100%">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:${isIsolir ? 'var(--red-bg)' : 'var(--green-bg)'};
             color:${isIsolir ? 'var(--red)' : 'var(--green)'};
             display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined" style="font-size:20px">
            ${isIsolir ? 'block' : 'check_circle'}
          </span>
        </div>
        <div>
          <div style="font-family:var(--heading);font-size:15px;font-weight:800;color:var(--text)">
            ${isIsolir ? 'Isolir Massal' : 'Aktifkan Massal'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px">
            ${ids.length} pelanggan akan ${isIsolir ? 'diisolir' : 'diaktifkan'}
          </div>
        </div>
        <button class="psheet-close" style="margin-left:auto" onclick="closeModalForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div style="max-height:220px;overflow-y:auto;margin-bottom:16px;
           border:1px solid var(--border);border-radius:var(--r-md);padding:0 12px">
        ${listHtml}
      </div>

      ${isIsolir ? `
        <div style="background:var(--red-bg);border:1px solid var(--red-border);
             border-radius:var(--r-md);padding:10px 12px;font-size:12px;color:var(--red);
             margin-bottom:16px">
          ⚠ Profil semua pelanggan terpilih akan diubah ke <strong>Isolir</strong>
          dan session aktif akan diputus.
        </div>` : `
        <div style="background:var(--green-bg);border:1px solid var(--green-border);
             border-radius:var(--r-md);padding:10px 12px;font-size:12px;color:var(--green);
             margin-bottom:16px">
          ✅ Profil akan dikembalikan ke profil sebelum isolir.
          Pelanggan tanpa riwayat profil tidak akan diproses.
        </div>`}

      <div class="modal-actions">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn ${isIsolir ? 'btn-red' : 'btn-green'}"
                id="btn-bulk-confirm"
                onclick="eksekusiBulk('${aksi}')">
          <span class="material-symbols-outlined">
            ${isIsolir ? 'block' : 'check_circle'}
          </span>
          ${isIsolir ? 'Ya, Isolir Sekarang' : 'Ya, Aktifkan Sekarang'}
        </button>
      </div>
    </div>`);
}

async function eksekusiBulk(aksi) {
  const deviceId = document.getElementById('filter-device')?.value
                || _allData[0]?.device_id;
  if (!deviceId) {
    toast('Pilih perangkat MikroTik terlebih dahulu', 'warning');
    return;
  }

  const ids = [..._selectedIds];
  const btn = document.getElementById('btn-bulk-confirm');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Memproses...';
  }

  const endpoint = aksi === 'isolir'
    ? `${API_BASE}/api/pelanggan/bulk-isolir`
    : `${API_BASE}/api/pelanggan/bulk-aktifkan`;

  try {
    const res  = await fetch(endpoint, {
      method:      'POST',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify({ ids, device_id: Number(deviceId) }),
    });
    const data = await res.json();

    closeModalForm();
    clearSelection();

    const isIsolir  = aksi === 'isolir';
    const okCount   = (data.results || []).filter(r => r.status === 'ok').length;
    const errCount  = (data.results || []).filter(r => r.status === 'error').length;
    const toastType = errCount > 0 ? 'warning' : (isIsolir ? 'danger' : 'success');
    toast(data.message || `${okCount} berhasil, ${errCount} gagal`, toastType);

    // Reload tabel
    await loadPelanggan();

  } catch (e) {
    toast('Gagal menghubungi server', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = aksi === 'isolir' ? 'Ya, Isolir Sekarang' : 'Ya, Aktifkan Sekarang';
    }
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
window.toggleSelect    = toggleSelect;
window.toggleSelectAll = toggleSelectAll;
window.clearSelection  = clearSelection;
window.openBulkModal   = openBulkModal;
window.eksekusiBulk    = eksekusiBulk;