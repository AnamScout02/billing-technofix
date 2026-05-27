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
let semuaPelanggan = [];
let filteredData = [];
let currentPage = 1;
let editingId = null;
let hapusTarget = null;
let selectedDevice = null;
let detailTarget = null;

// Cache RX/TX dari endpoint terpisah
let rxTxCache = {};

// ── BARU: Cache daftar OLT (agar tidak re-fetch setiap buka form) ──
let oltCache = [];   // Array of { id, name, tipe, ip }


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadDevices();
  loadOltCache();  // load OLT ke cache saat halaman dibuka

  // Jika kembali dari halaman detail dengan intent edit, buka form edit
  const pendingEditId = sessionStorage.getItem('tf_edit_pelanggan_id');
  if (pendingEditId) {
    sessionStorage.removeItem('tf_edit_pelanggan_id');
    // Poll sampai loadPelanggan() selesai mengisi semuaPelanggan[]
    const _poll = setInterval(() => {
      const p = semuaPelanggan.find(item => String(item.id) === pendingEditId);
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
    const res = await fetch(`${API_BASE}/devices`);
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
    const res = await fetch(`${API_BASE}/olt`);
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
      fetch(`${API_BASE}/api/pelanggan/${deviceId}`),
      fetch(`${API_BASE}/api/pelanggan/${deviceId}/rx-tx`),
    ]);

    // Data pelanggan (wajib)
    if (resPelanggan.status === 'rejected' || !resPelanggan.value.ok) {
      const errMsg = resPelanggan.reason
        || (await resPelanggan.value.json().catch(() => ({}))).error
        || 'Gagal mengambil data pelanggan';
      throw new Error(errMsg);
    }

    const dataPelanggan = await resPelanggan.value.json();
    semuaPelanggan = Array.isArray(dataPelanggan) ? dataPelanggan : [];

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
    semuaPelanggan = semuaPelanggan.map(p => {
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
    const res = await fetch(`${API_BASE}/api/pelanggan/${deviceId}/rx-tx?realtime=1`);
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

    semuaPelanggan = semuaPelanggan.map(p => {
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

  filteredData = semuaPelanggan.filter(p => {
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

    return matchKeyword && matchStatus;
  });

  currentPage = 1;
  renderTabel();
  renderPaginasi();
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

  if (filteredData.length === 0) {
    tabel.style.display = 'none';
    tampilEmpty();
    return;
  }

  tabel.style.display = 'table';

  const start = (currentPage - 1) * PER_PAGE;
  const slice = filteredData.slice(start, start + PER_PAGE);

  tbody.innerHTML = slice.map((p, i) => {
    const no = start + i + 1;
    const online = p.status === 'Online';
    const disconnected = p.status === 'Router Disconnected';

    let badgeClass, badgeLabel;
    if (online) { badgeClass = 'online'; badgeLabel = 'Online'; }
    else if (disconnected) { badgeClass = 'nonaktif'; badgeLabel = 'Router Off'; }
    else { badgeClass = 'nonaktif'; badgeLabel = 'Offline'; }

    /* ── RX/TX Power — gunakan parseRxTx dari global.js ── */
    const rxInfo = parseRxTx(p);

    /* ── Nama OLT dari cache ── */
    const namaOlt = _getNamaOlt(p.olt_id);

    return `
      <tr>
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
  if (deviceCount) deviceCount.textContent = `${filteredData.length} pelanggan`;
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
  const totalPage = Math.ceil(filteredData.length / PER_PAGE);
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
  const total = Math.ceil(filteredData.length / PER_PAGE);
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
  const total = semuaPelanggan.length;
  const online = semuaPelanggan.filter(p => p.status === 'Online').length;
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
  editingId = prefill ? prefill.id : null;
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

  const v = k => prefill ? escHtml(prefill[k] || '') : '';

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
                autocomplete="new-password">
              <button class="form-pwd-toggle" type="button"
                onclick="togglePwd('f-password','f-pwd-eye')">
                <span class="material-symbols-outlined" id="f-pwd-eye">visibility</span>
              </button>
            </div>
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

          <!-- Serial Number -->
          <div class="form-group full">
            <label class="form-label">Serial Number (SN) Modem/ONU</label>
            <input class="form-input" id="f-sn" type="text"
              placeholder="cth: ZTEG1A2B3C4D atau HWTC1A2B3C4D" value="${v('sn')}">
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
            <label class="form-label">Titik Koordinat</label>
            <input class="form-input" id="f-harga" type="text"
              placeholder="cth: -8.2678707, 114.3692840" value="${prefill ? escHtml(prefill.titik_koordinat || prefill.koordinat || '') : ''}">
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
    _loadProfilIntoForm(prefill ? prefill.profil : '');
    const u = document.getElementById('f-username');
    if (u) u.focus();
  });
}

function tutupModalPelanggan() {
  editingId = null;
  closeModalForm(); // ← dari global.js
}

// Alias agar kode lama tetap jalan
function openModalTambah() { showFormPelanggan(null); }
function cancelFormPelanggan() { tutupModalPelanggan(); }


/* ══════════════════════════════════════════════════════════
   8. EDIT PELANGGAN
   Buka form modal dengan data pelanggan yang sudah ter-isi otomatis.
══════════════════════════════════════════════════════════ */

/**
 * Cari pelanggan dari cache, lalu buka form edit (pre-populated).
 * @param {number|string} id - ID pelanggan dari baris tabel
 */
function openEdit(id) {
  const p = semuaPelanggan.find(item => String(item.id) === String(id));
  if (!p) {
    toast('Data pelanggan tidak ditemukan.', 'danger');
    return;
  }
  showFormPelanggan(p);  // prefill = p → semua field form terisi otomatis
}

/* ══════════════════════════════════════════════════════════
   9. PROSES SIMPAN / PROVISIONING PELANGGAN (VERSI SENIOR FIX)
══════════════════════════════════════════════════════════ */
async function simpanPelanggan() {
  // 1. Ambil penanda mode (add/edit) dan ID
  // Prioritas: f-id hidden input → variabel editingId global → f-mode
  const fIdEl   = document.getElementById('f-id');
  const fModeEl = document.getElementById('f-mode') || document.getElementsByName('mode')[0];

  // editingId diset oleh showFormPelanggan() saat mode edit
  const idPelangganLokal = (fIdEl && fIdEl.value) ? fIdEl.value
                         : (typeof editingId !== 'undefined' && editingId) ? String(editingId)
                         : '';
  const isModeEdit = !!idPelangganLokal || (fModeEl && fModeEl.value === 'edit');

  // 2. Ambil seluruh data form dengan proteksi anti-null element
  const deviceId = document.getElementById('f-device') ? document.getElementById('f-device').value : '';
  const username = document.getElementById('f-username') ? document.getElementById('f-username').value.trim() : '';
  
  // Deteksi element password (Mendukung id f-pass atau f-password)
  const passEl = document.getElementById('f-pass') || document.getElementById('f-password');
  const password = passEl ? passEl.value.trim() : '';

  const hpEl = document.getElementById('f-hp') || document.getElementById('f-no-hp');
  const hp = hpEl ? hpEl.value.trim() : '';

  const profil = document.getElementById('f-profil') ? document.getElementById('f-profil').value : '';
  const oltId = document.getElementById('f-olt') ? document.getElementById('f-olt').value : '';

  // Deteksi element slot port (Mendukung f-slot-port atau f-slot)
  const slotEl = document.getElementById('f-slot-port') || document.getElementById('f-slot');
  const slot = slotEl ? slotEl.value.trim() : '';

  const vlan = document.getElementById('f-vlan') ? document.getElementById('f-vlan').value.trim() : '';
  const sn = document.getElementById('f-sn') ? document.getElementById('f-sn').value.trim() : '';
  
  // Fix pencarian Koordinat (Mencari ID f-koordinat, jika tidak ada baru cari alternatif)
  const koordinatEl = document.getElementById('f-koordinat') || document.getElementById('f-titik-koordinat') || document.getElementById('f-harga');
  const koordinat = koordinatEl ? koordinatEl.value.trim() : '';

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
      koordinat: koordinat,
      titik_koordinat: koordinat,
      tgl_pasang: tglPasang,
      tgl_jatuh: tglJatuh
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
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  const p = semuaPelanggan.find(item => String(item.id) === String(id));
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
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: Number(deviceId), username: hapusTarget.username }),
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
    const res = await fetch(`${API_BASE}/olt`);
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
 * Isi dropdown #f-profil di dalam form modal.
 * Profil diambil dari daftar pelanggan yang sudah di-load.
 * @param {string} selectedVal - profil yang akan dipilih (untuk mode edit)
 */
function _loadProfilIntoForm(selectedVal) {
  const sel = document.getElementById('f-profil');
  if (!sel) return;
  let profils = [...new Set(semuaPelanggan.map(p => p.profil).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">— Pilih Profil —</option>';
  profils.forEach(p => {
    const opt = new Option(p, p);
    if (p === selectedVal) opt.selected = true;
    sel.appendChild(opt);
  });
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
    const res = await fetch(`${API_BASE}/api/pelanggan/${Number(deviceId)}/rx-tx`);
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
            rxCell.innerHTML = `<span class="badge badge-sm">${rxFormat} dBm</span>`;
            
            if (typeof getRxTxClass === 'function') {
              rxCell.className = `col-rx ${getRxTxClass(rxFormat)}`;
            }
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

// Pastikan fungsi diekspos ke scope window global
window.loadRxTx = loadRxTx;



/* ══════════════════════════════════════════════════════════
   EKSPOS FUNGSI KE GLOBAL SCOPE (Wajib agar onclick di HTML aktif)
══════════════════════════════════════════════════════════ */
window.openEdit = openEdit;
window.openDetail = openDetail;
