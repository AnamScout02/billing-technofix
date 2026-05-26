/* ============================================================
   pelanggan.js — Manajemen Pelanggan TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML

   ✅ Fungsi dari global.js yang dipakai:
      API_BASE, escHtml, val, animNum, toast,
      togglePwd, parseRxTx, openModalForm, closeModalForm,
      getAuthHeaders, getSession

   ✅ Fitur lengkap:
      - loadDevices()         → isi dropdown perangkat
      - loadPelanggan()       → fetch & render data pelanggan
      - filterPelanggan()     → filter realtime (search + status)
      - renderTabel()         → render baris tabel dengan event delegation
      - renderPaginasi()      → paginasi halaman
      - updateStats()         → animasi stat cards
      - showFormPelanggan()   → modal form tambah/edit
      - openEdit(id)          → buka form dengan data prefill
      - simpanPelanggan()     → POST/PUT ke API
      - openDetail(id)        → modal detail pelanggan
      - openHapus(id)         → modal konfirmasi hapus
      - konfirmasiHapus()     → DELETE ke API (dipanggil tombol modal-hapus)
      - refreshRxTx()         → refresh sinyal OLT realtime
      - generateCliScript(p)  → generate CLI ZTE/Huawei
      - ubahJumlahTampil()    → ganti jumlah baris per halaman

   Endpoint:
   GET    /devices                          → daftar perangkat
   GET    /api/pelanggan/<device_id>        → list pelanggan
   GET    /api/pelanggan/<device_id>/rx-tx  → data RX/TX
   POST   /api/pelanggan                    → tambah pelanggan
   PUT    /api/pelanggan/<id>               → edit pelanggan
   DELETE /api/pelanggan/<id>              → hapus pelanggan
   GET    /olt                              → daftar OLT
   ============================================================ */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONFIG
───────────────────────────────────────────────────────────── */
let PER_PAGE = 50;

/* ─────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────── */
let semuaPelanggan = [];
let filteredData   = [];
let currentPage    = 1;
let editingId      = null;
let hapusTarget    = null;   // { id, username }
let selectedDevice = null;
let detailTarget   = null;
let rxTxCache      = {};
let oltCache       = [];     // [{ id, name, tipe, ip }]


/* ══════════════════════════════════════════════════════════
   INIT — DOMContentLoaded
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  loadDevices();
  loadOltCache();
  _bindTabelEvents();   // Event delegation untuk tombol aksi tabel
});


/* ══════════════════════════════════════════════════════════
   EVENT DELEGATION — Tombol aksi di tbody tabel
   Menangani: Detail, Edit, Hapus, CLI Script
   Menggunakan data-action dan data-id pada setiap tombol.
══════════════════════════════════════════════════════════ */
function _bindTabelEvents() {
  const tbody = document.getElementById('tbody-pelanggan');
  if (!tbody) return;

  tbody.addEventListener('click', function (e) {
    // Cari tombol terdekat dengan atribut data-action
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const id     = parseInt(btn.getAttribute('data-id'), 10);
    const uname  = btn.getAttribute('data-username') || '';

    switch (action) {
      case 'detail': openDetail(id);             break;
      case 'edit':   openEdit(id);               break;
      case 'hapus':  openHapus(id, uname);       break;
      case 'cli':    _openCliDariTabel(id);      break;
    }
  });
}


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR PERANGKAT
   GET /devices → isi <select id="select-device">
══════════════════════════════════════════════════════════ */
async function loadDevices() {
  try {
    const res  = await fetch(API_BASE + '/devices', { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const sel = document.getElementById('select-device');
    if (!sel) return;

    sel.innerHTML = '<option value="">— Pilih Perangkat —</option>';
    (Array.isArray(data) ? data : []).forEach(function (d) {
      sel.appendChild(new Option((d.name || d.id) + '  (' + (d.ip || '') + ')', d.id));
    });

    // Kembalikan pilihan terakhir
    const saved = localStorage.getItem('lastSelectedDevice');
    if (saved && Array.isArray(data) && data.some(function (d) { return String(d.id) === saved; })) {
      sel.value = saved;
    } else if (Array.isArray(data) && data.length === 1) {
      sel.value = String(data[0].id);
    }

    loadPelanggan();
  } catch (err) {
    console.error('[loadDevices]', err);
    tampilError('Gagal memuat daftar perangkat. Pastikan server Python berjalan.');
  }
}


/* ══════════════════════════════════════════════════════════
   1b. LOAD CACHE OLT
   GET /olt → simpan ke oltCache[]
══════════════════════════════════════════════════════════ */
async function loadOltCache() {
  try {
    const res  = await fetch(API_BASE + '/olt', { headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    oltCache   = Array.isArray(data) ? data : [];
  } catch (_) {
    oltCache = [];
  }
}

// Alias untuk kompatibilitas
async function loadOltOptions() { await loadOltCache(); }


/* ══════════════════════════════════════════════════════════
   2. LOAD PELANGGAN
   GET /api/pelanggan/<device_id>
   + GET /api/pelanggan/<device_id>/rx-tx  (paralel, opsional)
══════════════════════════════════════════════════════════ */
async function loadPelanggan() {
  const selEl    = document.getElementById('select-device');
  const deviceId = selEl ? selEl.value : '';

  if (!deviceId) {
    localStorage.removeItem('lastSelectedDevice');
    selectedDevice = null;
    rxTxCache      = {};
    semuaPelanggan = [];
    filteredData   = [];
    updateStats();
    tampilEmpty();
    return;
  }

  localStorage.setItem('lastSelectedDevice', deviceId);
  selectedDevice = {
    id:   deviceId,
    name: selEl.options[selEl.selectedIndex] ? selEl.options[selEl.selectedIndex].text : deviceId,
  };

  tampilLoading();
  animasiRefresh(true);

  try {
    const [resPelanggan, resRxTx] = await Promise.allSettled([
      fetch(API_BASE + '/api/pelanggan/' + deviceId, { headers: getAuthHeaders() }),
      fetch(API_BASE + '/api/pelanggan/' + deviceId + '/rx-tx', { headers: getAuthHeaders() }),
    ]);

    // Data pelanggan wajib berhasil
    if (resPelanggan.status === 'rejected' || !resPelanggan.value.ok) {
      const errMsg = resPelanggan.reason
        ? resPelanggan.reason.message
        : ('HTTP ' + (resPelanggan.value ? resPelanggan.value.status : '?'));
      throw new Error(errMsg);
    }

    const dataPelanggan = await resPelanggan.value.json();
    semuaPelanggan      = Array.isArray(dataPelanggan) ? dataPelanggan : [];

    // RX/TX opsional
    rxTxCache = {};
    if (resRxTx.status === 'fulfilled' && resRxTx.value.ok) {
      try {
        const rxTxList = await resRxTx.value.json();
        (Array.isArray(rxTxList) ? rxTxList : []).forEach(function (item) {
          if (item.username) {
            rxTxCache[item.username] = {
              rx_power: item.rx_power,
              tx_power: item.tx_power,
              source:   item.source,
            };
          }
        });
      } catch (_) { /* RX/TX gagal — pakai field bawaan */ }
    }

    // Merge RX/TX ke data pelanggan
    semuaPelanggan = semuaPelanggan.map(function (p) {
      var cached = rxTxCache[p.username];
      if (cached) {
        return Object.assign({}, p, {
          rx_power: cached.rx_power !== undefined ? cached.rx_power : p.rx_power,
          tx_power: cached.tx_power !== undefined ? cached.tx_power : p.tx_power,
        });
      }
      return p;
    });

    updateStats();
    filterPelanggan();
    updateSyncStatus(true);

    const srcEl = document.getElementById('rx-tx-source');
    if (srcEl) {
      const hasOlt = semuaPelanggan.some(function (p) { return p.rx_power !== undefined && p.rx_power !== null; });
      srcEl.textContent = hasOlt ? '· Sinyal dari OLT' : '';
    }

  } catch (err) {
    console.error('[loadPelanggan]', err);
    tampilError('Gagal mengambil data pelanggan: ' + err.message);
    updateSyncStatus(false);
  } finally {
    animasiRefresh(false);
  }
}


/* ══════════════════════════════════════════════════════════
   2b. REFRESH RX/TX REALTIME
══════════════════════════════════════════════════════════ */
async function refreshRxTx() {
  const selEl    = document.getElementById('select-device');
  const deviceId = selEl ? selEl.value : '';

  if (!deviceId) {
    toast('Pilih perangkat terlebih dahulu', 'warning');
    return;
  }

  toast('Mengambil data RX/TX dari OLT secara realtime...', 'info');

  try {
    const res = await fetch(
      API_BASE + '/api/pelanggan/' + deviceId + '/rx-tx?realtime=1',
      { headers: getAuthHeaders() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const rxTxList = await res.json();
    rxTxCache      = {};
    (Array.isArray(rxTxList) ? rxTxList : []).forEach(function (item) {
      if (item.username) {
        rxTxCache[item.username] = {
          rx_power: item.rx_power,
          tx_power: item.tx_power,
          source:   'realtime',
        };
      }
    });

    semuaPelanggan = semuaPelanggan.map(function (p) {
      var cached = rxTxCache[p.username];
      return cached
        ? Object.assign({}, p, { rx_power: cached.rx_power, tx_power: cached.tx_power })
        : p;
    });

    filterPelanggan();
    toast('Data RX/TX berhasil diperbarui', 'success');

  } catch (err) {
    toast('Gagal refresh RX/TX: ' + err.message, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   3. FILTER + SEARCH (realtime)
   Dipanggil oleh: oninput pada #input-search
                   onchange pada #filter-status
══════════════════════════════════════════════════════════ */
function filterPelanggan() {
  var searchEl  = document.getElementById('input-search');
  var statusEl  = document.getElementById('filter-status');
  var keyword   = searchEl  ? searchEl.value.toLowerCase().trim()  : '';
  var status    = statusEl  ? statusEl.value                        : '';

  filteredData = semuaPelanggan.filter(function (p) {
    var matchKeyword =
      !keyword ||
      (p.username  || '').toLowerCase().includes(keyword) ||
      (p.hp        || '').toLowerCase().includes(keyword) ||
      (p.profil    || '').toLowerCase().includes(keyword) ||
      (p.sn        || '').toLowerCase().includes(keyword) ||
      (p.slot_port || '').toLowerCase().includes(keyword) ||
      (p.vlan      || '').toLowerCase().includes(keyword) ||
      (p.koordinat || '').toLowerCase().includes(keyword);

    var matchStatus =
      !status ||
      (status === 'aktif'    && p.status === 'Online') ||
      (status === 'nonaktif' && p.status !== 'Online');

    return matchKeyword && matchStatus;
  });

  currentPage = 1;
  renderTabel();
  renderPaginasi();
}


/* ══════════════════════════════════════════════════════════
   4. RENDER TABEL
   Semua tombol aksi pakai data-action + data-id
   agar Event Delegation di _bindTabelEvents() bekerja.
══════════════════════════════════════════════════════════ */
function renderTabel() {
  var tbody = document.getElementById('tbody-pelanggan');
  var tabel = document.getElementById('table-pelanggan');
  if (!tbody || !tabel) return;

  sembunyikanSemuaState();

  if (filteredData.length === 0) {
    tabel.style.display = 'none';
    tampilEmpty();
    return;
  }

  tabel.style.display = '';

  var start = (currentPage - 1) * PER_PAGE;
  var slice = filteredData.slice(start, start + PER_PAGE);

  tbody.innerHTML = slice.map(function (p, i) {
    var no   = start + i + 1;
    var rxInfo = parseRxTx(p);   // dari global.js

    var badgeClass, badgeLabel;
    if (p.status === 'Online') {
      badgeClass = 'online';   badgeLabel = 'Online';
    } else if (p.status === 'Router Disconnected') {
      badgeClass = 'nonaktif'; badgeLabel = 'Router Off';
    } else {
      badgeClass = 'nonaktif'; badgeLabel = 'Offline';
    }

    var safeUsername = escHtml(p.username || '—');
    var safeId       = parseInt(p.id, 10) || 0;

    return [
      '<tr>',
        '<td class="sticky-col-1">' + no + '</td>',

        '<td class="sticky-col-2">',
          '<span class="tbl-username">' + safeUsername + '</span>',
        '</td>',

        '<td><span class="tbl-hp">' + escHtml(p.hp || '—') + '</span></td>',

        '<td><span class="badge-profil">' + escHtml(p.profil || '—') + '</span></td>',

        '<td>' + escHtml(p.slot_port || '—') + '</td>',

        '<td>' + escHtml(p.vlan || '—') + '</td>',

        '<td><span style="font-family:monospace;font-size:11px;">' + escHtml(p.sn || '—') + '</span></td>',

        '<td>',
          '<span class="tbl-rx ' + rxInfo.rxClass + '" title="TX: ' + escHtml(rxInfo.txFormatted) + '">',
            escHtml(rxInfo.rxFormatted),
          '</span>',
        '</td>',

        '<td>',
          '<span class="badge-status ' + badgeClass + '">',
            '<span class="badge-dot"></span>',
            badgeLabel,
          '</span>',
        '</td>',

        '<td>',
          '<div class="tbl-actions">',
            // Tombol Detail
            '<button class="btn-tbl detail" ',
              'data-action="detail" data-id="' + safeId + '" ',
              'title="Detail & Sinyal">',
              '<span class="material-symbols-outlined">settings_remote</span>',
            '</button>',

            // Tombol Edit
            '<button class="btn-tbl edit" ',
              'data-action="edit" data-id="' + safeId + '" ',
              'title="Edit Pelanggan">',
              '<span class="material-symbols-outlined">edit</span>',
            '</button>',

            // Tombol CLI Script
            '<button class="btn-tbl" ',
              'data-action="cli" data-id="' + safeId + '" ',
              'title="Script Provisioning CLI" ',
              'style="color:var(--primary);">',
              '<span class="material-symbols-outlined">terminal</span>',
            '</button>',

            // Tombol Hapus
            '<button class="btn-tbl" ',
              'data-action="hapus" data-id="' + safeId + '" ',
              'data-username="' + escHtml(p.username || '') + '" ',
              'title="Hapus Pelanggan" ',
              'style="color:var(--red);">',
              '<span class="material-symbols-outlined">delete</span>',
            '</button>',
          '</div>',
        '</td>',
      '</tr>',
    ].join('');
  }).join('');

  var deviceCount = document.getElementById('device-count');
  if (deviceCount) deviceCount.textContent = filteredData.length + ' pelanggan';
}


/* ══════════════════════════════════════════════════════════
   HELPER — Ambil nama OLT dari cache
══════════════════════════════════════════════════════════ */
function _getNamaOlt(oltId) {
  if (!oltId && oltId !== 0) return '—';
  var found = oltCache.find(function (o) { return String(o.id) === String(oltId); });
  return found ? escHtml(found.name) : 'OLT #' + oltId;
}


/* ══════════════════════════════════════════════════════════
   5. PAGINASI
══════════════════════════════════════════════════════════ */
function renderPaginasi() {
  var totalPage = Math.ceil(filteredData.length / PER_PAGE);
  var wrap = document.getElementById('pagination');
  if (!wrap) return;
  if (totalPage <= 1) { wrap.innerHTML = ''; return; }

  var html = '<button class="page-btn" onclick="gantiPage(' + (currentPage - 1) + ')" '
    + (currentPage === 1 ? 'disabled' : '') + '>'
    + '<span class="material-symbols-outlined" style="font-size:16px">chevron_left</span>'
    + '</button>';

  for (var i = 1; i <= totalPage; i++) {
    if (i === 1 || i === totalPage || (i >= currentPage - 1 && i <= currentPage + 1)) {
      html += '<button class="page-btn ' + (i === currentPage ? 'active' : '') + '" '
        + 'onclick="gantiPage(' + i + ')">' + i + '</button>';
    } else if (i === currentPage - 2 || i === currentPage + 2) {
      html += '<span style="color:var(--text-dim);padding:0 2px">…</span>';
    }
  }

  html += '<button class="page-btn" onclick="gantiPage(' + (currentPage + 1) + ')" '
    + (currentPage === totalPage ? 'disabled' : '') + '>'
    + '<span class="material-symbols-outlined" style="font-size:16px">chevron_right</span>'
    + '</button>';

  wrap.innerHTML = html;
}

function gantiPage(p) {
  var total = Math.ceil(filteredData.length / PER_PAGE);
  if (p < 1 || p > total) return;
  currentPage = p;
  renderTabel();
  renderPaginasi();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


/* ══════════════════════════════════════════════════════════
   6. STAT CARDS
══════════════════════════════════════════════════════════ */
function updateStats() {
  var total   = semuaPelanggan.length;
  var online  = semuaPelanggan.filter(function (p) { return p.status === 'Online'; }).length;
  var offline = total - online;

  animNum('stat-total',    total);    // dari global.js
  animNum('stat-aktif',    online);
  animNum('stat-nonaktif', offline);
}


/* ══════════════════════════════════════════════════════════
   7. MODAL FORM TAMBAH / EDIT PELANGGAN
   showFormPelanggan(prefill)
     prefill = null  → mode tambah
     prefill = obj   → mode edit (auto-fill semua field)
══════════════════════════════════════════════════════════ */
function showFormPelanggan(prefill) {
  prefill   = prefill || null;
  editingId = prefill ? prefill.id : null;
  var isEdit = !!prefill;

  // Bangun option list perangkat
  var devSel = document.getElementById('select-device');
  var deviceOptions = '<option value="">— Pilih Perangkat —</option>';
  if (devSel) {
    Array.from(devSel.options).forEach(function (o) {
      if (!o.value) return;
      var sel = '';
      if (prefill) {
        sel = String(prefill.device_id) === o.value ? 'selected' : '';
      } else {
        sel = devSel.value === o.value ? 'selected' : '';
      }
      deviceOptions += '<option value="' + escHtml(o.value) + '" ' + sel + '>'
        + escHtml(o.text) + '</option>';
    });
  }

  // Helper escape value dari prefill
  function v(k) { return prefill ? escHtml(prefill[k] || '') : ''; }

  // Baris re-provisioning (hanya mode edit)
  var reProvisionRow = isEdit
    ? '<div class="form-group full" style="margin-top:4px;">'
        + '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;'
        + 'font-size:13px;color:var(--text-muted);">'
        + '<input type="checkbox" id="f-reprovision" style="width:16px;height:16px;accent-color:var(--primary);">'
        + ' Kirim ulang perintah provisioning ke OLT (re-provisioning)'
        + '</label>'
        + '</div>'
    : '';

  var html = [
    '<div class="modal" style="max-width:560px;width:100%;max-height:90vh;overflow-y:auto;">',

      '<div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;',
           'padding:18px 20px 14px;border-bottom:1px solid var(--border);gap:12px;">',
        '<div style="display:flex;align-items:center;gap:10px;">',
          '<span class="material-symbols-outlined" style="color:var(--primary);font-size:22px;">',
            isEdit ? 'edit' : 'person_add',
          '</span>',
          '<span style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">',
            isEdit ? 'Edit Pelanggan' : 'Tambah Pelanggan Baru',
          '</span>',
        '</div>',
        '<button class="psheet-close" onclick="tutupModalPelanggan()" title="Tutup">',
          '<span class="material-symbols-outlined">close</span>',
        '</button>',
      '</div>',

      '<div style="padding:20px;">',
        '<div class="form-grid">',

          // Perangkat MikroTik
          '<div class="form-group full">',
            '<label class="form-label">Perangkat MikroTik <span class="req">*</span></label>',
            '<select class="form-input" id="f-device">' + deviceOptions + '</select>',
          '</div>',

          // Username
          '<div class="form-group">',
            '<label class="form-label">Username <span class="req">*</span></label>',
            '<input class="form-input" id="f-username" type="text" ',
              'placeholder="cth: pelanggan01" autocomplete="off" value="' + v('username') + '">',
          '</div>',

          // Password
          '<div class="form-group">',
            '<label class="form-label">Password '
              + (isEdit ? '' : '<span class="req">*</span>')
              + '</label>',
            '<div class="form-pwd-wrap">',
              '<input class="form-input" id="f-password" type="password" ',
                'placeholder="' + (isEdit ? 'Kosongkan jika tidak diubah' : '••••••••') + '" ',
                'autocomplete="new-password">',
              '<button class="form-pwd-toggle" type="button" ',
                'onclick="togglePwd(\'f-password\',\'f-pwd-eye\')">',
                '<span class="material-symbols-outlined" id="f-pwd-eye">visibility</span>',
              '</button>',
            '</div>',
          '</div>',

          // No HP
          '<div class="form-group">',
            '<label class="form-label">No. Telepon / HP</label>',
            '<input class="form-input" id="f-hp" type="text" ',
              'placeholder="cth: 08123456789" value="' + v('hp') + '">',
          '</div>',

          // Profil
          '<div class="form-group">',
            '<label class="form-label">Profil <span class="req">*</span></label>',
            '<select class="form-input" id="f-profil">',
              '<option value="">— Pilih Profil —</option>',
            '</select>',
          '</div>',

          // Separator OLT
          '<div class="form-group full" style="margin:4px 0 0;">',
            '<div style="font-size:11px;font-weight:700;color:var(--text-dim);',
                 'letter-spacing:.08em;text-transform:uppercase;padding:6px 0 2px;',
                 'border-top:1px solid var(--border);">',
              'Data OLT — Provisioning ONU',
            '</div>',
          '</div>',

          // Pilih OLT
          '<div class="form-group full">',
            '<label class="form-label">Perangkat OLT</label>',
            '<select class="form-input" id="f-olt">',
              '<option value="">-- Pilih OLT (opsional) --</option>',
            '</select>',
          '</div>',

          // Slot/Port
          '<div class="form-group">',
            '<label class="form-label">Slot/Port : ONU-ID</label>',
            '<input class="form-input" id="f-slot" type="text" ',
              'placeholder="cth: 0/1/1:3" value="' + v('slot_port') + '">',
          '</div>',

          // VLAN
          '<div class="form-group">',
            '<label class="form-label">VLAN</label>',
            '<input class="form-input" id="f-vlan" type="text" ',
              'placeholder="cth: 100" value="' + v('vlan') + '">',
          '</div>',

          // Serial Number
          '<div class="form-group full">',
            '<label class="form-label">Serial Number (SN) Modem/ONU</label>',
            '<input class="form-input" id="f-sn" type="text" ',
              'placeholder="cth: ZTEG1A2B3C4D atau HWTC1A2B3C4D" value="' + v('sn') + '">',
          '</div>',

          reProvisionRow,

          // Separator Info Tambahan
          '<div class="form-group full" style="margin:4px 0 0;">',
            '<div style="font-size:11px;font-weight:700;color:var(--text-dim);',
                 'letter-spacing:.08em;text-transform:uppercase;padding:6px 0 2px;',
                 'border-top:1px solid var(--border);">',
              'Info Tambahan',
            '</div>',
          '</div>',

          // Tanggal Pemasangan
          '<div class="form-group">',
            '<label class="form-label">Tanggal Pemasangan</label>',
            '<input class="form-input" id="f-tgl-pasang" type="date" value="' + v('tgl_pasang') + '">',
          '</div>',

          // Tanggal Jatuh Tempo
          '<div class="form-group">',
            '<label class="form-label">Tanggal Jatuh Tempo</label>',
            '<input class="form-input" id="f-tgl-jatuh" type="date" value="' + v('tgl_jatuh') + '">',
          '</div>',

          // Koordinat
          '<div class="form-group full">',
            '<label class="form-label">Titik Koordinat</label>',
            '<input class="form-input" id="f-harga" type="text" ',
              'placeholder="cth: -8.2678707, 114.3692840" value="' + v('koordinat') + '">',
          '</div>',

        '</div>',

        '<div class="form-actions">',
          '<button class="btn" onclick="tutupModalPelanggan()">',
            '<span class="material-symbols-outlined">close</span> Batal',
          '</button>',
          '<button class="btn-primary" id="btn-save-pelanggan" onclick="simpanPelanggan()">',
            '<span class="material-symbols-outlined">' + (isEdit ? 'check' : 'bolt') + '</span> ',
            isEdit ? 'Simpan Perubahan' : 'Provisioning & Simpan',
          '</button>',
        '</div>',
      '</div>',
    '</div>',
  ].join('');

  openModalForm(html);   // dari global.js

  // Load dropdown setelah DOM tersedia
  requestAnimationFrame(function () {
    _loadOltIntoForm(prefill ? prefill.olt_id : '');
    _loadProfilIntoForm(prefill ? prefill.profil : '');
    var uEl = document.getElementById('f-username');
    if (uEl) uEl.focus();
  });
}

function tutupModalPelanggan() {
  editingId = null;
  closeModalForm();   // dari global.js
}

// Alias untuk kompatibilitas dengan onclick di HTML
function openModalTambah()     { showFormPelanggan(null); }
function cancelFormPelanggan() { tutupModalPelanggan(); }


/* ══════════════════════════════════════════════════════════
   8. OPEN EDIT — buka form dengan data prefill
══════════════════════════════════════════════════════════ */
function openEdit(id) {
  var p = semuaPelanggan.find(function (x) { return x.id === id; });
  if (!p) {
    toast('Data pelanggan tidak ditemukan', 'warning');
    return;
  }

  // Pastikan device_id tersedia untuk prefill dropdown
  if (!p.device_id) {
    var selEl = document.getElementById('select-device');
    p = Object.assign({}, p, { device_id: selEl ? selEl.value : '' });
  }

  showFormPelanggan(p);
}


/* ══════════════════════════════════════════════════════════
   9. SIMPAN PELANGGAN — POST (tambah) / PUT (edit)
   One-Click Provisioning: payload lengkap MikroTik + OLT + HP
══════════════════════════════════════════════════════════ */
async function simpanPelanggan() {
  var deviceIdEl    = document.getElementById('f-device');
  var usernameEl    = document.getElementById('f-username');
  var passwordEl    = document.getElementById('f-password');
  var hpEl          = document.getElementById('f-hp');
  var profilEl      = document.getElementById('f-profil');
  var oltIdEl       = document.getElementById('f-olt');
  var slotEl        = document.getElementById('f-slot');
  var vlanEl        = document.getElementById('f-vlan');
  var snEl          = document.getElementById('f-sn');
  var koordinatEl   = document.getElementById('f-harga');
  var tglPasangEl   = document.getElementById('f-tgl-pasang');
  var tglJatuhEl    = document.getElementById('f-tgl-jatuh');
  var reProvisionEl = document.getElementById('f-reprovision');

  var deviceId    = deviceIdEl    ? deviceIdEl.value.trim()    : '';
  var username    = usernameEl    ? usernameEl.value.trim()    : '';
  var password    = passwordEl    ? passwordEl.value.trim()    : '';
  var hp          = hpEl          ? hpEl.value.trim()          : '';
  var profil      = profilEl      ? profilEl.value             : '';
  var oltId       = oltIdEl       ? oltIdEl.value              : '';
  var slot        = slotEl        ? slotEl.value.trim()        : '';
  var vlan        = vlanEl        ? vlanEl.value.trim()        : '';
  var sn          = snEl          ? snEl.value.trim()          : '';
  var koordinat   = koordinatEl   ? koordinatEl.value.trim()   : '';
  var tglPasang   = tglPasangEl   ? tglPasangEl.value          : '';
  var tglJatuh    = tglJatuhEl    ? tglJatuhEl.value           : '';
  var reProvision = reProvisionEl ? reProvisionEl.checked      : false;

  // ── Validasi ──
  if (!username) {
    toast('Username wajib diisi', 'warning');
    return;
  }
  if (!editingId && !password) {
    toast('Password wajib diisi untuk pelanggan baru', 'warning');
    return;
  }
  if (!deviceId) {
    toast('Pilih perangkat MikroTik terlebih dahulu', 'warning');
    return;
  }
  if (oltId && !sn) {
    toast('⚠ SN modem kosong — provisioning OLT akan dilewati', 'warning');
  }
  if (oltId && !slot) {
    toast('⚠ Slot/Port kosong — provisioning OLT akan dilewati', 'warning');
  }

  var btn = document.getElementById('btn-save-pelanggan');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menyimpan & Provisioning...';
  }

  try {
    var url, method, body;

    if (editingId) {
      // ── Mode Edit ──
      url    = API_BASE + '/api/pelanggan/' + editingId;
      method = 'PUT';
      body   = {
        device_id:    Number(deviceId),
        username:     username,
        hp:           hp,
        profil:       profil,
        olt_id:       oltId ? Number(oltId) : null,
        slot_port:    slot,
        vlan:         vlan,
        sn:           sn,
        koordinat:    koordinat,
        tgl_pasang:   tglPasang,
        tgl_jatuh:    tglJatuh,
        re_provision: reProvision,
      };
      if (password) body.password = password;

    } else {
      // ── Mode Tambah ──
      url    = API_BASE + '/api/pelanggan';
      method = 'POST';
      body   = {
        device_id:  Number(deviceId),
        username:   username,
        password:   password,
        hp:         hp,
        profil:     profil,
        olt_id:     oltId ? Number(oltId) : null,
        slot_port:  slot,
        vlan:       vlan,
        sn:         sn,
        koordinat:  koordinat,
        tgl_pasang: tglPasang,
        tgl_jatuh:  tglJatuh,
      };
    }

    var res  = await fetch(url, {
      method:  method,
      headers: getAuthHeaders(),
      body:    JSON.stringify(body),
    });
    var data = await res.json();

    // 207 = sebagian sukses (ada warnings)
    if (!res.ok && res.status !== 207) {
      throw new Error(data.error || data.message || 'Gagal menyimpan data pelanggan');
    }

    tutupModalPelanggan();

    // Susun pesan toast dari respons backend
    var steps    = data.steps    || {};
    var warnings = data.warnings || [];
    var toastMsg = editingId
      ? ('✅ ' + username + ' berhasil diperbarui')
      : ('✅ ' + username + ' berhasil ditambahkan');

    if (steps.mikrotik)                            toastMsg += ' · MikroTik: OK';
    if (steps.olt && steps.olt.includes('berhasil')) toastMsg += ' · OLT: OK';

    toast(toastMsg, warnings.length > 0 ? 'warning' : 'success');

    if (warnings.length > 0) {
      setTimeout(function () {
        warnings.forEach(function (w) { toast('⚠ ' + w, 'warning'); });
      }, 800);
    }

    await loadPelanggan();

  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">'
        + (editingId ? 'check' : 'bolt') + '</span> '
        + (editingId ? 'Simpan Perubahan' : 'Provisioning & Simpan');
    }
  }
}


/* ══════════════════════════════════════════════════════════
   10. MODAL DETAIL PELANGGAN
══════════════════════════════════════════════════════════ */
function openDetail(id) {
  var p = semuaPelanggan.find(function (x) { return x.id === id; });
  if (!p) {
    toast('Data pelanggan tidak ditemukan', 'warning');
    return;
  }
  detailTarget = p;

  var rxInfo  = parseRxTx(p);   // dari global.js
  var namaOlt = _getNamaOlt(p.olt_id);

  var hpHtml = p.hp
    ? '<a href="tel:' + escHtml(p.hp) + '" style="color:var(--primary);text-decoration:none;">'
        + escHtml(p.hp) + '</a>'
    : '—';

  var html = [
    '<div class="modal" style="max-width:520px;width:100%;max-height:90vh;overflow-y:auto;">',

      '<div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;',
           'padding:18px 20px 14px;border-bottom:1px solid var(--border);gap:12px;">',
        '<div>',
          '<div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">'
            + escHtml(p.username || '—') + '</div>',
          '<div style="font-size:12px;color:var(--text-muted);">',
            'SN: ' + escHtml(p.sn || '—') + ' &nbsp;·&nbsp; ',
            '<span class="' + rxInfo.rxClass + '" title="RX Power">',
              'RX: ' + escHtml(rxInfo.rxFormatted),
            '</span>',
          '</div>',
        '</div>',
        '<button class="psheet-close" onclick="tutupModalDetail()" title="Tutup">',
          '<span class="material-symbols-outlined">close</span>',
        '</button>',
      '</div>',

      '<div style="padding:16px 20px;">',

        // Info Pelanggan
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;',
             'padding:14px;background:var(--surface-2);border-radius:10px;margin-bottom:14px;">',

          '<div>',
            '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;',
                 'letter-spacing:.07em;font-weight:700;">Profil</div>',
            '<div style="font-size:13px;color:var(--text);font-weight:600;margin-top:2px;">'
              + escHtml(p.profil || '—') + '</div>',
          '</div>',

          '<div>',
            '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;',
                 'letter-spacing:.07em;font-weight:700;">Status</div>',
            '<div style="margin-top:4px;">',
              '<span class="badge-status ' + (p.status === 'Online' ? 'online' : 'nonaktif')
                + '" style="font-size:11px;">',
                '<span class="badge-dot"></span>',
                escHtml(p.status || 'Offline'),
              '</span>',
            '</div>',
          '</div>',

          '<div>',
            '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;',
                 'letter-spacing:.07em;font-weight:700;">No. Telepon</div>',
            '<div style="font-size:13px;color:var(--text);font-weight:600;margin-top:2px;">'
              + hpHtml + '</div>',
          '</div>',

          '<div>',
            '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;',
                 'letter-spacing:.07em;font-weight:700;">TX Power</div>',
            '<div style="font-size:13px;color:var(--text);font-weight:600;margin-top:2px;">'
              + escHtml(rxInfo.txFormatted) + '</div>',
          '</div>',

        '</div>',

        // Data OLT
        '<div style="padding:14px;background:var(--surface-2);border-radius:10px;margin-bottom:14px;">',
          '<div style="font-size:10px;font-weight:700;color:var(--text-dim);',
               'text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px;">',
            'Data OLT &amp; ONU',
          '</div>',
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;">',

            '<div>',
              '<div style="font-size:10px;color:var(--text-dim);font-weight:600;">OLT</div>',
              '<div style="font-size:13px;color:var(--text);font-weight:600;margin-top:2px;">'
                + namaOlt + '</div>',
            '</div>',

            '<div>',
              '<div style="font-size:10px;color:var(--text-dim);font-weight:600;">Slot / Port : ONU</div>',
              '<div style="font-size:13px;color:var(--text);font-family:monospace;margin-top:2px;">'
                + escHtml(p.slot_port || '—') + '</div>',
            '</div>',

            '<div>',
              '<div style="font-size:10px;color:var(--text-dim);font-weight:600;">VLAN</div>',
              '<div style="font-size:13px;color:var(--text);font-family:monospace;margin-top:2px;">'
                + escHtml(p.vlan || '—') + '</div>',
            '</div>',

            '<div>',
              '<div style="font-size:10px;color:var(--text-dim);font-weight:600;">Serial Number</div>',
              '<div style="font-size:12px;color:var(--text);font-family:monospace;margin-top:2px;word-break:break-all;">'
                + escHtml(p.sn || '—') + '</div>',
            '</div>',

          '</div>',
        '</div>',

        // Aksi Cepat
        '<div class="detail-action-group">',
          '<div class="detail-action-label">Aksi Cepat</div>',
          '<div class="detail-action-btns">',
            '<button class="btn-detail-action green" onclick="aksiModem(\'enable\')">',
              '<span class="material-symbols-outlined">check_circle</span> Enable',
            '</button>',
            '<button class="btn-detail-action amber" onclick="aksiModem(\'disable\')">',
              '<span class="material-symbols-outlined">do_not_disturb_on</span> Disable',
            '</button>',
            '<button class="btn-detail-action" onclick="aksiModem(\'reboot\')">',
              '<span class="material-symbols-outlined">restart_alt</span> Reboot',
            '</button>',
            '<button class="btn-detail-action red" onclick="aksiModem(\'hapus\')">',
              '<span class="material-symbols-outlined">delete</span> Hapus',
            '</button>',
          '</div>',
        '</div>',

        // Script CLI
        '<div class="detail-cli-section">',
          '<div class="detail-action-label" style="display:flex;justify-content:space-between;">',
            'Script Provisioning OLT',
            '<button class="btn-copy-cli" onclick="copyCliScript()">',
              '<span class="material-symbols-outlined">content_copy</span> Salin',
            '</button>',
          '</div>',
          '<div class="cli-box">',
            '<pre id="cli-script-content" style="white-space:pre-wrap;margin:0;',
                 'font-family:var(--sans);font-size:12px;">'
              + escHtml(generateCliScript(p)) + '</pre>',
          '</div>',
        '</div>',

      '</div>',
    '</div>',
  ].join('');

  openModalForm(html);   // dari global.js
}

function tutupModalDetail() {
  detailTarget = null;
  closeModalForm();   // dari global.js
}

// Buka CLI script langsung dari tombol di tabel (tanpa membuka detail)
function _openCliDariTabel(id) {
  var p = semuaPelanggan.find(function (x) { return x.id === id; });
  if (!p) {
    toast('Data pelanggan tidak ditemukan', 'warning');
    return;
  }
  detailTarget = p;

  var script = generateCliScript(p);
  var html = [
    '<div class="modal" style="max-width:520px;width:100%;max-height:90vh;overflow-y:auto;">',
      '<div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;',
           'padding:18px 20px 14px;border-bottom:1px solid var(--border);">',
        '<div style="font-family:var(--heading);font-size:15px;font-weight:800;color:var(--text);">',
          'Script CLI — ' + escHtml(p.username || '—'),
        '</div>',
        '<button class="psheet-close" onclick="closeModalForm()" title="Tutup">',
          '<span class="material-symbols-outlined">close</span>',
        '</button>',
      '</div>',
      '<div style="padding:16px 20px;">',
        '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">',
          '<button class="btn-copy-cli" onclick="copyCliScript()">',
            '<span class="material-symbols-outlined">content_copy</span> Salin Script',
          '</button>',
        '</div>',
        '<div class="cli-box">',
          '<pre id="cli-script-content" style="white-space:pre-wrap;margin:0;',
               'font-family:monospace;font-size:12px;">'
            + escHtml(script) + '</pre>',
        '</div>',
      '</div>',
    '</div>',
  ].join('');

  openModalForm(html);
}


/* ══════════════════════════════════════════════════════════
   11. HAPUS PELANGGAN
   openHapus(id, username) → buka modal konfirmasi
   konfirmasiHapus()       → dipanggil tombol "Ya, Hapus"
                             di modal-hapus (HTML statis)
══════════════════════════════════════════════════════════ */
function openHapus(id, username) {
  hapusTarget = { id: id, username: username };
  var el = document.getElementById('hapus-username');
  if (el) el.textContent = username;
  bukaModal('modal-hapus');
}

async function konfirmasiHapus() {
  if (!hapusTarget) return;

  var btnHapus = document.querySelector('#modal-hapus .btn-hapus');
  if (btnHapus) {
    btnHapus.disabled = true;
    btnHapus.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menghapus...';
  }

  try {
    var selEl    = document.getElementById('select-device');
    var deviceId = selEl ? selEl.value : '';

    var res  = await fetch(API_BASE + '/api/pelanggan/' + hapusTarget.id, {
      method:  'DELETE',
      headers: getAuthHeaders(),
      body:    JSON.stringify({
        device_id: deviceId ? Number(deviceId) : undefined,
        username:  hapusTarget.username,
      }),
    });
    var data = await res.json();

    if (!res.ok) throw new Error(data.error || data.message || 'Gagal menghapus pelanggan');

    tutupModalHapus();
    toast(hapusTarget.username + ' berhasil dihapus', 'success');
    hapusTarget = null;
    await loadPelanggan();

  } catch (err) {
    toast('Gagal menghapus: ' + err.message, 'danger');
  } finally {
    if (btnHapus) {
      btnHapus.disabled = false;
      btnHapus.innerHTML = '<span class="material-symbols-outlined">delete</span>Ya, Hapus';
    }
  }
}


/* ══════════════════════════════════════════════════════════
   12. GENERATE CLI SCRIPT
   Deteksi tipe OLT dari oltCache: ZTE vs Huawei
══════════════════════════════════════════════════════════ */
function generateCliScript(p) {
  var slotRaw  = p.slot_port || '1/3/6:1';
  var parts    = slotRaw.split(':');
  var gponPath = parts[0] || '1/3/6';
  var onuId    = parts[1] || '1';
  var username = p.username || 'pelanggan';
  var sn       = p.sn       || 'ZTEG00000000';
  var vlan     = p.vlan     || '200';
  var profil   = (p.profil  || 'PAKET1').toUpperCase();
  var password = '••••••';

  var olt  = oltCache.find(function (o) { return String(o.id) === String(p.olt_id); });
  var tipe = olt ? (olt.tipe || '').toLowerCase() : '';

  if (tipe.includes('huawei')) {
    // ── Script Huawei MA5600 / MA5800 ──
    return [
      'enable',
      'config',
      'interface gpon 0/' + gponPath,
      'ont add ' + onuId + ' sn-auth ' + sn + ' omci ont-lineprofile-id 10 ont-srvprofile-id 10 desc ' + username,
      'quit',
      'service-port vlan ' + vlan + ' gpon 0/' + gponPath + ' ont ' + onuId + ' gemport 1 multi-service user-vlan ' + vlan + ' tag-transform translate',
      'quit',
      'save',
    ].join('\n');
  }

  // ── Script ZTE C300 / C600 (default) ──
  return [
    'con t',
    'interface gpon-olt_' + gponPath,
    'no onu ' + onuId,
    'onu ' + onuId + ' type ALL-ONT sn ' + sn + ' vport-mode gemport',
    'exit',
    'interface gpon-onu_' + gponPath + ':' + onuId,
    'name ' + username,
    'sn-bind enable sn',
    'tcont 1 profile ' + profil,
    'gemport 1 tcont 1',
    'switchport mode hybrid vport 1',
    'service-port 1 vport 1 user-vlan ' + vlan + ' vlan ' + vlan,
    'exit',
    'pon-onu-mng gpon-onu_' + gponPath + ':' + onuId,
    'service HSI gemport 1 cos 0-7 vlan ' + vlan,
    'wan-ip 1 mode pppoe username ' + username + ' password ' + password + ' vlan-profile vlan' + vlan + ' host 1',
    'wan-ip 1 ping-response enable traceroute-response enable',
    'security-mgmt 212 state enable mode forward protocol web',
    'end',
    'wr',
  ].join('\n');
}

function copyCliScript() {
  var el = document.getElementById('cli-script-content');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent)
    .then(function ()  { toast('Script disalin ke clipboard', 'success'); })
    .catch(function () { toast('Gagal menyalin script', 'danger'); });
}

function aksiModem(aksi) {
  if (!detailTarget) return;
  var label = {
    remote:  'Remote Modem',
    reboot:  'Reboot Modem',
    enable:  'Enable Modem',
    disable: 'Disable Modem',
    hapus:   'Hapus Modem',
  }[aksi] || aksi;
  toast(label + ': ' + detailTarget.username, 'info');
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Dropdown OLT & Profil ke dalam form modal
══════════════════════════════════════════════════════════ */

/**
 * Isi dropdown #f-olt dari oltCache.
 * @param {string|number} selectedVal — olt_id yang akan dipilih (mode edit)
 */
async function _loadOltIntoForm(selectedVal) {
  var sel = document.getElementById('f-olt');
  if (!sel) return;

  if (oltCache.length === 0) await loadOltCache();

  sel.innerHTML = '<option value="">-- Pilih OLT (opsional) --</option>';
  oltCache.forEach(function (olt) {
    var label = escHtml(olt.name)
      + (olt.tipe ? ' · ' + escHtml(olt.tipe) : '')
      + ' (' + escHtml(olt.ip || '') + ')';
    var opt = new Option(label, olt.id);
    if (String(olt.id) === String(selectedVal)) opt.selected = true;
    sel.appendChild(opt);
  });
}

/**
 * Isi dropdown #f-profil dari daftar profil unik di semuaPelanggan.
 * @param {string} selectedVal — profil yang akan dipilih (mode edit)
 */
function _loadProfilIntoForm(selectedVal) {
  var sel = document.getElementById('f-profil');
  if (!sel) return;

  var profils = [];
  semuaPelanggan.forEach(function (p) {
    if (p.profil && profils.indexOf(p.profil) === -1) profils.push(p.profil);
  });
  profils.sort();

  sel.innerHTML = '<option value="">— Pilih Profil —</option>';
  profils.forEach(function (p) {
    var opt = new Option(p, p);
    if (p === selectedVal) opt.selected = true;
    sel.appendChild(opt);
  });
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Modal static (hapus)
══════════════════════════════════════════════════════════ */
function bukaModal(id)  {
  var el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function tutupModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
function tutupModalHapus() { tutupModal('modal-hapus'); }
function closeModalHapus(e) {
  if (e && e.target && e.target.id === 'modal-hapus') tutupModalHapus();
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Baris per halaman
══════════════════════════════════════════════════════════ */
function ubahJumlahTampil() {
  var sel = document.getElementById('perPageSelect');
  if (sel) PER_PAGE = parseInt(sel.value, 10) || 50;
  currentPage = 1;
  renderTabel();
  renderPaginasi();
}


/* ══════════════════════════════════════════════════════════
   HELPERS — UI States
══════════════════════════════════════════════════════════ */
function sembunyikanSemuaState() {
  ['state-loading', 'state-empty', 'state-error'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var tabel = document.getElementById('table-pelanggan');
  if (tabel) tabel.style.display = '';
}

function tampilLoading() {
  sembunyikanSemuaState();
  var t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  var l = document.getElementById('state-loading');
  if (l) l.style.display = 'flex';
}

function tampilEmpty() {
  sembunyikanSemuaState();
  var t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  var e = document.getElementById('state-empty');
  if (e) e.style.display = 'flex';
  var dc = document.getElementById('device-count');
  if (dc) dc.textContent = '0 pelanggan';
}

function tampilError(msg) {
  sembunyikanSemuaState();
  var t = document.getElementById('table-pelanggan');
  if (t) t.style.display = 'none';
  var e = document.getElementById('state-error');
  if (e) e.style.display = 'flex';
  var m = document.getElementById('error-msg');
  if (m) m.textContent = msg || 'Terjadi kesalahan. Coba lagi.';
}

function updateSyncStatus(ok) {
  var el = document.getElementById('sync-status');
  if (!el) return;
  el.innerHTML  = ok ? '🟢 Terhubung' : '🔴 Gagal Terhubung';
  el.className  = 'sync-status ' + (ok ? 'ok' : 'err');
}

function animasiRefresh(on) {
  var icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = on ? 'spin .8s linear infinite' : '';
}