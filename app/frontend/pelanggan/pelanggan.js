/* ============================================================
   pelanggan.js — Manajemen Pelanggan TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML

   ✅ Fungsi dari global.js yang dipakai:
      API_BASE, escHtml, val, animNum, toast,
      togglePwd, parseRxTx, openModalForm, closeModalForm

   Endpoint yang dipakai:
   GET    /devices                        → daftar perangkat
   GET    /api/pelanggan/<device_id>      → pelanggan per perangkat
   GET    /api/pelanggan/<device_id>/rx-tx → data RX/TX power ONU
   POST   /api/pelanggan                  → tambah pelanggan
   PUT    /api/pelanggan/<id>             → edit pelanggan
   DELETE /api/pelanggan/<id>             → hapus pelanggan
   GET    /olt                            → daftar OLT (untuk form)
   POST   /api/onu-mapping               → simpan data ONU
   ============================================================ */

'use strict';

/* ── CONFIG ── */
let PER_PAGE = 50;

/* ── STATE ── */
let semuaPelanggan = [];
let filteredData   = [];
let currentPage    = 1;
let editingId      = null;
let hapusTarget    = null;
let selectedDevice = null;
let detailTarget   = null;

// Cache RX/TX dari endpoint terpisah
let rxTxCache = {};


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadDevices();
  loadOltOptions();
});


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR PERANGKAT
   GET /devices → isi <select id="select-device">
══════════════════════════════════════════════════════════ */
async function loadDevices() {
  try {
    const res  = await fetch(`${API_BASE}/devices`);
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
   2. LOAD PELANGGAN
   GET /api/pelanggan/<device_id>
   + GET /api/pelanggan/<device_id>/rx-tx  ← BARU
══════════════════════════════════════════════════════════ */
async function loadPelanggan() {
  const deviceId = document.getElementById('select-device').value;

  if (!deviceId) {
    localStorage.removeItem('lastSelectedDevice');
    selectedDevice = null;
    rxTxCache      = {};
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
    semuaPelanggan      = Array.isArray(dataPelanggan) ? dataPelanggan : [];

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
              source:   item.source,
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
   GET /api/pelanggan/<device_id>/rx-tx?realtime=1
   ← Dipanggil dari tombol "Refresh RX/TX" jika ada
══════════════════════════════════════════════════════════ */
async function refreshRxTx() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  toast('Mengambil data RX/TX dari OLT secara realtime...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${deviceId}/rx-tx?realtime=1`);
    if (!res.ok) throw new Error('Gagal mengambil data realtime');

    const rxTxList = await res.json();
    rxTxCache      = {};
    rxTxList.forEach(item => {
      if (item.username) {
        rxTxCache[item.username] = {
          rx_power: item.rx_power,
          tx_power: item.tx_power,
          source:   'realtime',
        };
      }
    });

    // Update data
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
  const status  = document.getElementById('filter-status')?.value || '';

  filteredData = semuaPelanggan.filter(p => {
    const matchKeyword =
      !keyword ||
      (p.username   || '').toLowerCase().includes(keyword) ||
      (p.hp         || '').toLowerCase().includes(keyword) ||
      (p.profil     || '').toLowerCase().includes(keyword) ||
      (p.sn         || '').toLowerCase().includes(keyword) ||
      (p.slot_port  || '').toLowerCase().includes(keyword) ||
      (p.vlan       || '').toLowerCase().includes(keyword) ||
      (p.koordinat  || '').toLowerCase().includes(keyword);

    const matchStatus =
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
    const no   = start + i + 1;
    const online       = p.status === 'Online';
    const disconnected = p.status === 'Router Disconnected';

    let badgeClass, badgeLabel;
    if (online)            { badgeClass = 'online';   badgeLabel = 'Online'; }
    else if (disconnected) { badgeClass = 'nonaktif'; badgeLabel = 'Router Off'; }
    else                   { badgeClass = 'nonaktif'; badgeLabel = 'Offline'; }

    /* ── RX/TX Power — gunakan parseRxTx dari global.js ── */
    const rxInfo = parseRxTx(p);  // ← dari global.js, handle semua field name

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
            <button class="btn-tbl edit" onclick="openEdit(${p.id})" title="Edit Pelanggan">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="btn-tbl detail" onclick="openDetail(${p.id})" title="Detail & Aksi">
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
  const total   = semuaPelanggan.length;
  const online  = semuaPelanggan.filter(p => p.status === 'Online').length;
  const offline = total - online;

  animNum('stat-total',    total);
  animNum('stat-aktif',    online);
  animNum('stat-nonaktif', offline);
}


/* ══════════════════════════════════════════════════════════
   7. MODAL FORM TAMBAH / EDIT PELANGGAN
   Menggunakan openModalForm() dari global.js
   → Form muncul sebagai modal popup di tengah halaman
   → Latar page sedikit blur, header & navbar tetap jernih
══════════════════════════════════════════════════════════ */
function showFormPelanggan(prefill) {
  prefill   = prefill || null;
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

          <div class="form-group full">
            <label class="form-label">Perangkat MikroTik <span class="req">*</span></label>
            <select class="form-input" id="f-device">${deviceOptions}</select>
          </div>

          <div class="form-group full">
            <label class="form-label">Perangkat OLT</label>
            <select class="form-input" id="f-olt"><option value="">-- Pilih OLT --</option></select>
          </div>

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

          <div class="form-group">
            <label class="form-label">No HP</label>
            <input class="form-input" id="f-hp" type="text"
              placeholder="cth: 08123456789" value="${v('hp')}">
          </div>

          <div class="form-group">
            <label class="form-label">Serial Number (SN)</label>
            <input class="form-input" id="f-sn" type="text"
              placeholder="cth: HWTC1A2B3C4D" value="${v('sn')}">
          </div>

          <div class="form-group full">
            <label class="form-label">Profil <span class="req">*</span></label>
            <select class="form-input" id="f-profil">
              <option value="">— Pilih Profil —</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Slot/Port:ONU</label>
            <input class="form-input" id="f-slot" type="text"
              placeholder="cth: 0/1/1:3" value="${v('slot_port')}">
          </div>

          <div class="form-group">
            <label class="form-label">VLAN</label>
            <input class="form-input" id="f-vlan" type="text"
              placeholder="cth: 100" value="${v('vlan')}">
          </div>

          <div class="form-group">
            <label class="form-label">Tanggal Pemasangan <span class="req">*</span></label>
            <input class="form-input" id="f-tgl-pasang" type="date" value="${v('tgl_pasang')}">
          </div>

          <div class="form-group">
            <label class="form-label">Tanggal Jatuh Tempo <span class="req">*</span></label>
            <input class="form-input" id="f-tgl-jatuh" type="date" value="${v('tgl_jatuh')}">
          </div>

          <div class="form-group full">
            <label class="form-label">Titik Koordinat</label>
            <input class="form-input" id="f-harga" type="text"
              placeholder="cth: -8.2678707, 114.3692840" value="${v('koordinat')}">
          </div>

        </div>

        <div class="form-actions">
          <button class="btn" onclick="tutupModalPelanggan()">
            <span class="material-symbols-outlined">close</span> Batal
          </button>
          <button class="btn-primary" id="btn-save-pelanggan" onclick="simpanPelanggan()">
            <span class="material-symbols-outlined">${isEdit ? 'check' : 'save'}</span>
            ${isEdit ? 'Simpan Perubahan' : 'Simpan Pelanggan'}
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
══════════════════════════════════════════════════════════ */
function openEdit(id) {
  const p = semuaPelanggan.find(x => x.id === id);
  if (!p) return;
  showFormPelanggan(p);
}


/* ══════════════════════════════════════════════════════════
   9. SIMPAN PELANGGAN (POST / PUT)
══════════════════════════════════════════════════════════ */
async function simpanPelanggan() {
  const deviceId  = document.getElementById('f-device').value;
  const username  = document.getElementById('f-username').value.trim();
  const password  = document.getElementById('f-password').value.trim();
  const hp        = document.getElementById('f-hp').value.trim();
  const profil    = document.getElementById('f-profil').value;
  const slot      = document.getElementById('f-slot').value.trim();
  const vlan      = document.getElementById('f-vlan').value.trim();
  const sn        = document.getElementById('f-sn').value.trim();
  const koordinat = document.getElementById('f-harga').value.trim();
  const tglPasang = document.getElementById('f-tgl-pasang').value;
  const tglJatuh  = document.getElementById('f-tgl-jatuh').value;

  if (!username)             { toast('Username wajib diisi', 'warning'); return; }
  if (!editingId && !password) { toast('Password wajib diisi untuk pelanggan baru', 'warning'); return; }
  if (!deviceId)             { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  const btn = document.getElementById('btn-save-pelanggan');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menyimpan...'; }

  try {
    let url, method, body;

    if (editingId) {
      url    = `${API_BASE}/api/pelanggan/${editingId}`;
      method = 'PUT';
      body   = { username, password, hp, profil, slot_port: slot, vlan, sn, koordinat,
                 tgl_pasang: tglPasang, tgl_jatuh: tglJatuh, device_id: Number(deviceId) };
      if (!password) delete body.password;
    } else {
      url    = `${API_BASE}/api/pelanggan`;
      method = 'POST';
      body   = { device_id: Number(deviceId), username, password, hp, profil,
                 slot_port: slot, vlan, sn, koordinat,
                 tgl_pasang: tglPasang, tgl_jatuh: tglJatuh };
    }

    const res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || data.message || 'Gagal menyimpan');

    tutupModalPelanggan();
    toast(
      editingId
        ? `Data ${username} berhasil diperbarui`
        : `Pelanggan ${username} berhasil ditambahkan`,
      'success'
    );
    await loadPelanggan();

  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span class="material-symbols-outlined">${editingId ? 'check' : 'save'}</span> ` +
        (editingId ? 'Simpan Perubahan' : 'Simpan Pelanggan');
    }
  }
}


/* ══════════════════════════════════════════════════════════
   10. MODAL DETAIL / AKSI PERANGKAT
══════════════════════════════════════════════════════════ */
function openDetail(id) {
  const p = semuaPelanggan.find(x => x.id === id);
  if (!p) return;
  detailTarget = p;

  const rxInfo = parseRxTx(p);  // ← dari global.js

  const html = `
    <div class="modal" style="max-width:520px;width:100%;max-height:90vh;overflow-y:auto;">
      <div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;
           padding:18px 20px 14px;border-bottom:1px solid var(--border);gap:12px;">
        <div>
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);"
               id="detail-username-title">${escHtml(p.username || '—')}</div>
          <div style="font-size:12px;color:var(--text-muted);" id="detail-sn-sub">
            SN: ${escHtml(p.sn || '—')}
            &nbsp;·&nbsp;
            <span class="${rxInfo.rxClass}" title="RX Power">
              RX: ${escHtml(rxInfo.rxFormatted)}
            </span>
          </div>
        </div>
        <button class="psheet-close" onclick="tutupModalDetail()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div style="padding:16px 20px;">

        <!-- Aksi Cepat -->
        <div class="detail-action-group">
          <div class="detail-action-label">Aksi Cepat</div>
          <div class="detail-action-btns">
            <button class="btn-detail-action green" onclick="aksiModem('enable')">
              <span class="material-symbols-outlined">check_circle</span> Enable
            </button>
            <button class="btn-detail-action amber" onclick="aksiModem('disable')">
              <span class="material-symbols-outlined">do_not_disturb_on</span> Disable
            </button>
            <button class="btn-detail-action" onclick="aksiModem('reboot')">
              <span class="material-symbols-outlined">restart_alt</span> Reboot
            </button>
            <button class="btn-detail-action red" onclick="aksiModem('hapus')">
              <span class="material-symbols-outlined">delete</span> Hapus
            </button>
          </div>
        </div>

        <!-- Script CLI OLT -->
        <div class="detail-cli-section">
          <div class="detail-action-label" style="display:flex;justify-content:space-between;">
            Script Provisioning OLT
            <button class="btn-copy-cli" onclick="copyCliScript()">
              <span class="material-symbols-outlined">content_copy</span> Salin
            </button>
          </div>
          <div class="cli-box">
            <pre id="cli-script-content" style="white-space:pre-wrap;margin:0;font-family:var(--sans);font-size:12px;">${escHtml(generateCliScript(p))}</pre>
          </div>
        </div>

      </div>
    </div>`;

  openModalForm(html);  // ← dari global.js
}

function tutupModalDetail() { closeModalForm(); }

function generateCliScript(p) {
  const slotRaw  = p.slot_port || '1/3/6:1';
  const parts    = slotRaw.split(':');
  const gponPath = parts[0] || '1/3/6';
  const onuId    = parts[1] || '1';
  const username = p.username || 'pelanggan';
  const sn       = p.sn       || 'ZTEG00000000';
  const vlan     = p.vlan     || '200';
  const profil   = (p.profil  || 'PAKET1').toUpperCase();
  const password = '12345';

  return `con t\ninterface gpon-olt_${gponPath}\nno onu ${onuId}\nexit\ninterface gpon-olt_${gponPath}\nonu ${onuId} type ALL-ONT sn ${sn} vport-mode gemport\nexit\ninterface gpon-onu_${gponPath}:${onuId}\nname ${username}\nsn-bind enable sn\ntcont 1 profile ${profil}\ngemport 1 tcont 1\nswitchport mode hybrid vport 1\nservice-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}\nexit\npon-onu-mng gpon-onu_${gponPath}:${onuId}\nservice HSI gemport 1 cos 0-7 vlan ${vlan}\nwan-ip 1 mode pppoe username ${username} password ${password} vlan-profile vlan${vlan} host 1\nwan-ip 1 ping-response enable traceroute-response enable\nsecurity-mgmt 212 state enable mode forward protocol web\nend\nwr`;
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
    remote: 'Remote Modem', reboot: 'Reboot Modem',
    enable: 'Enable Modem', disable: 'Disable Modem', hapus: 'Hapus Modem'
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
    const selEl    = document.getElementById('select-device');
    const deviceId = selEl ? selEl.value : '';
    const res  = await fetch(`${API_BASE}/api/pelanggan/${hapusTarget.id}`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device_id: Number(deviceId), username: hapusTarget.username }),
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
function bukaModal(id)  { document.getElementById(id)?.classList.add('open'); }
function tutupModal(id) { document.getElementById(id)?.classList.remove('open'); }
function tutupModalHapus()    { tutupModal('modal-hapus'); }
function closeModalHapus(e)   { if (e.target.id === 'modal-hapus') tutupModalHapus(); }


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
async function loadOltOptions() {
  try {
    const res  = await fetch(`${API_BASE}/olt`);
    if (!res.ok) throw new Error('Gagal ambil data OLT');
    const data = await res.json();
    const sel  = document.getElementById('f-olt');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Pilih OLT --</option>';
    data.forEach(olt => {
      const opt = new Option(olt.name, olt.id);
      sel.appendChild(opt);
    });
  } catch (err) {
    console.warn('OLT Load Error:', err);
  }
}

async function _loadOltIntoForm(selectedVal) {
  const sel = document.getElementById('f-olt');
  if (!sel) return;
  try {
    const res  = await fetch(`${API_BASE}/olt`);
    if (!res.ok) return;
    const data = await res.json();
    sel.innerHTML = '<option value="">-- Pilih OLT --</option>';
    data.forEach(olt => {
      const opt = new Option(olt.name, olt.id);
      if (String(olt.id) === String(selectedVal)) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

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