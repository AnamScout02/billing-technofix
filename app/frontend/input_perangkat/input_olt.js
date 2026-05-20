/* ============================================================
   input_olt.js — Manajemen Perangkat OLT TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, statusInfo,
              animNum, toast, closeModal, togglePwd)

   ✅ Fungsi di bawah ini TIDAK didefinisikan di sini karena
      sudah ada di global.js:
      - escHtml, val, statusInfo, animNum
      - toast, closeModal, togglePwd
      - toggleProfileMenu, initBottomNav
      - const API_BASE

   Endpoint:
   GET    /olt              → daftar semua OLT
   POST   /olt              → tambah OLT baru
   PUT    /olt/<id>         → edit OLT
   DELETE /olt/<id>         → hapus OLT
   POST   /olt/<id>/sync    → tes koneksi ulang
   ============================================================ */

// ── STATE ──────────────────────────────────────────────────────
let devices    = [];
let editingId  = null;
let syncingIds = new Set();


// ── HELPERS LOKAL ──────────────────────────────────────────────

/** Tampilkan loading spinner di device list. */
function showListLoading() {
  document.getElementById('device-list').innerHTML = `
    <div class="empty-state">
      <i class="ti ti-loader spin" style="font-size:32px;"></i>
      <p>Memuat perangkat OLT...</p>
    </div>`;
}


// ── STATS ──────────────────────────────────────────────────────

/** Perbarui kartu statistik OLT (total, connected, failed, pending). */
function updateStats() {
  animNum('stat-total',     devices.length);
  animNum('stat-connected', devices.filter(d => d.status === 'connected').length);
  animNum('stat-failed',    devices.filter(d => d.status === 'failed').length);
  animNum('stat-pending',   devices.filter(d => d.status === 'pending').length);

  const countEl = document.getElementById('device-count');
  if (countEl) countEl.textContent = `${devices.length} perangkat`;
}


// ── API CALLS ──────────────────────────────────────────────────

/** Ambil semua OLT dari database via GET /olt. */
async function loadDevices() {
  showListLoading();
  try {
    const res  = await fetch(`${API_BASE}/olt`);
    const data = await res.json();
    devices = Array.isArray(data) ? data : (data.devices || []);
    renderDevices();
  } catch (e) {
    document.getElementById('device-list').innerHTML = `
      <div class="empty-state">
        <i class="ti ti-plug-off"></i>
        <p>Tidak bisa terhubung ke server.<br>Pastikan backend Flask sudah berjalan.</p>
      </div>`;
    updateStats();
  }
}

/** Tambah OLT baru via POST /olt. */
async function addDevice() {
  const name       = val('f-name');
  const tipe       = val('f-tipe');
  const ip         = val('f-ip');
  const port       = val('f-port') || '23';
  const user       = val('f-user');
  const pass       = val('f-pass');
  const snmp       = val('f-snmp');
  const lokasi     = val('f-lokasi');
  const keterangan = val('f-keterangan');

  if (!name || !ip || !user || !pass) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  const btn = document.querySelector('.form-actions .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader spin"></i> Menyimpan...';

  try {
    const res  = await fetch(`${API_BASE}/olt`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, keterangan })
    });
    const data = await res.json();

    if (res.ok) {
      devices.push(data.device || data);
      cancelForm();
      renderDevices();
      toast(data.message || `${name} berhasil ditambahkan`, data.device?.status === 'connected' ? 'success' : 'danger');
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-plus"></i> Tambah OLT';
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-plus"></i> Tambah OLT';
  }
}

/** Edit OLT via PUT /olt/<id>. */
async function saveEdit() {
  const name       = val('f-name');
  const tipe       = val('f-tipe');
  const ip         = val('f-ip');
  const port       = val('f-port') || '23';
  const user       = val('f-user');
  const pass       = val('f-pass');
  const snmp       = val('f-snmp');
  const lokasi     = val('f-lokasi');
  const keterangan = val('f-keterangan');

  if (!name || !ip || !user) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  const btn = document.querySelector('.form-actions .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader spin"></i> Menyimpan...';

  try {
    const res  = await fetch(`${API_BASE}/olt/${editingId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, keterangan })
    });
    const data = await res.json();

    if (res.ok) {
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device || data;
      cancelForm();
      renderDevices();
      toast('Data perangkat berhasil diperbarui.', 'success');
    } else {
      toast(data.message || 'Gagal memperbarui perangkat.', 'danger');
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-check"></i> Simpan Perubahan';
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-check"></i> Simpan Perubahan';
  }
}

/**
 * Hapus OLT via DELETE /olt/<id>.
 * @param {number} id
 */
async function doDelete(id) {
  closeModal();
  try {
    const res = await fetch(`${API_BASE}/olt/${id}`, { method: 'DELETE' });
    if (res.ok) {
      devices = devices.filter(x => x.id !== id);
      renderDevices();
      toast('Perangkat OLT berhasil dihapus.', 'danger');
    } else {
      toast('Gagal menghapus perangkat.', 'danger');
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
  }
}

/**
 * Sinkronisasi satu OLT via POST /olt/<id>/sync.
 * @param {number} id
 */
async function syncDevice(id) {
  if (syncingIds.has(id)) return;

  syncingIds.add(id);
  renderDevices();

  try {
    const res  = await fetch(`${API_BASE}/olt/${id}/sync`, { method: 'POST' });
    const data = await res.json();

    const d = devices.find(x => x.id === id);
    if (d) {
      d.status = data.connected ? 'connected' : 'failed';
      toast(
        data.message || (d.status === 'connected' ? `${d.name} terhubung` : `Gagal terhubung ke ${d.name}`),
        d.status === 'connected' ? 'success' : 'danger'
      );
    }
  } catch (e) {
    const d = devices.find(x => x.id === id);
    if (d) d.status = 'failed';
    toast('Tidak bisa menghubungi server.', 'danger');
  }

  syncingIds.delete(id);
  renderDevices();
}

/** Sinkronisasi semua OLT sekaligus. */
async function syncAll() {
  const icon    = document.getElementById('sync-all-icon');
  const pending = devices.filter(d => !syncingIds.has(d.id));

  if (!pending.length) {
    toast('Semua perangkat sedang disinkron.', 'info');
    return;
  }

  icon.classList.add('spin');
  pending.forEach(d => syncingIds.add(d.id));
  renderDevices();

  await Promise.all(pending.map(async d => {
    try {
      const res  = await fetch(`${API_BASE}/olt/${d.id}/sync`, { method: 'POST' });
      const data = await res.json();
      d.status = data.connected ? 'connected' : 'failed';
    } catch (e) {
      d.status = 'failed';
    }
    syncingIds.delete(d.id);
  }));

  icon.classList.remove('spin');
  renderDevices();
  toast('Sinkronisasi semua perangkat selesai.', 'success');
}


// ── RENDER ─────────────────────────────────────────────────────

/** Render ulang seluruh daftar OLT ke DOM. */
function renderDevices() {
  const container = document.getElementById('device-list');

  if (!devices.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-device-desktop-off"></i>
        <p>Belum ada perangkat OLT terdaftar.<br>Klik <strong>Tambah OLT</strong> untuk memulai.</p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = devices.map((d, idx) => {
    const si         = statusInfo(d.status);
    const isSyncing  = syncingIds.has(d.id);
    const badgeCls   = isSyncing ? 'syncing' : d.status;
    const badgeLabel = isSyncing ? 'Menyinkron...' : si.label;
    const statusCls  = d.status === 'connected' ? 'status-connected'
                     : d.status === 'failed'    ? 'status-failed'
                     : 'status-pending';

    return `
      <div class="device-card ${statusCls}" id="card-${d.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon">
          <i class="ti ti-antenna-bars-5"></i>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            ${d.tipe ? `<span class="device-tipe-badge">${escHtml(d.tipe)}</span>` : ''}
            <span class="badge ${badgeCls}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${badgeLabel}
            </span>
          </div>
          <div class="device-meta">
            <span class="device-meta-item">
              <i class="ti ti-network"></i>${escHtml(d.ip)}:${escHtml(String(d.port || 23))}
            </span>
            <span class="device-meta-item">
              <i class="ti ti-user"></i>${escHtml(d.username)}
            </span>
            ${d.snmp ? `
            <span class="device-meta-item">
              <i class="ti ti-key"></i>${escHtml(d.snmp)}
            </span>` : ''}
            ${d.lokasi ? `
            <span class="device-meta-item">
              <i class="ti ti-map-pin"></i>${escHtml(d.lokasi)}
            </span>` : ''}
          </div>
          ${d.keterangan ? `<p class="device-keterangan">${escHtml(d.keterangan)}</p>` : ''}
        </div>

        <div class="device-actions">
          <button class="btn btn-blue btn-sm"
                  id="sync-btn-${d.id}"
                  onclick="syncDevice(${d.id})"
                  ${isSyncing ? 'disabled' : ''}>
            <i class="ti ti-refresh ${isSyncing ? 'spin' : ''}" id="sync-icon-${d.id}"></i>
            Sinkron
          </button>
          <button class="btn btn-amber btn-sm" onclick="editDevice(${d.id})">
            <i class="ti ti-edit"></i> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${d.id})">
            <i class="ti ti-trash"></i>
          </button>
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── FORM ───────────────────────────────────────────────────────

/**
 * Tampilkan form tambah atau edit OLT.
 * @param {object|null} prefill — null = tambah baru
 */
function showForm(prefill = null) {
  editingId = prefill ? prefill.id : null;
  const isEdit = !!prefill;

  document.getElementById('add-btn').style.display = 'none';

  document.getElementById('form-container').innerHTML = `
    <div class="form-card">

      <div class="form-card-title">
        <i class="ti ti-${isEdit ? 'edit' : 'plus-circle'}"></i>
        ${isEdit ? 'Edit Perangkat OLT' : 'Tambah Perangkat OLT'}
      </div>

      <div class="form-grid">

        <div class="form-group">
          <label class="form-label" for="f-name">
            Nama OLT <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="cth: OLT-Pusat-01"
                 value="${prefill ? escHtml(prefill.name) : ''}">
        </div>

        <div class="form-group">
          <label class="form-label" for="f-tipe">Tipe / Merek</label>
          <input class="form-input" type="text" id="f-tipe"
                 placeholder="cth: Huawei MA5800, ZTE C600"
                 value="${prefill ? escHtml(prefill.tipe || '') : ''}">
        </div>

        <div class="form-group full">
          <label class="form-label" for="f-ip">
            IP Address &amp; Port <span class="req">*</span>
          </label>
          <div class="ip-port-row">
            <input class="form-input mono" type="text" id="f-ip"
                   placeholder="192.168.1.100"
                   value="${prefill ? escHtml(prefill.ip) : ''}">
            <input class="form-input mono port" type="number" id="f-port"
                   placeholder="23" min="1" max="65535"
                   value="${prefill ? escHtml(String(prefill.port || 23)) : '23'}">
          </div>
          <span class="form-hint">Port default: 23 (Telnet) · 22 (SSH) · 161 (SNMP)</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="f-user">
            Username <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin"
                 value="${prefill ? escHtml(prefill.username) : ''}">
        </div>

        <div class="form-group">
          <label class="form-label" for="f-pass">
            Password ${isEdit ? '' : '<span class="req">*</span>'}
          </label>
          <div class="form-pwd-wrap">
            <input class="form-input" type="password" id="f-pass"
                   placeholder="${isEdit ? 'Kosongkan jika tidak diubah' : '••••••••'}"
                   autocomplete="new-password">
            <button type="button" class="form-pwd-toggle" onclick="togglePwd('f-pass','pwd-eye')">
              <span class="material-symbols-outlined" id="pwd-eye">visibility</span>
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="f-snmp">SNMP Community String</label>
          <input class="form-input" type="text" id="f-snmp"
                 placeholder="cth: public"
                 value="${prefill ? escHtml(prefill.snmp || '') : ''}">
        </div>

        <div class="form-group">
          <label class="form-label" for="f-lokasi">Lokasi</label>
          <input class="form-input" type="text" id="f-lokasi"
                 placeholder="cth: Gedung Pusat Lt.2"
                 value="${prefill ? escHtml(prefill.lokasi || '') : ''}">
        </div>

        <div class="form-group full">
          <label class="form-label" for="f-keterangan">Keterangan</label>
          <textarea class="form-input" id="f-keterangan" rows="2"
                    placeholder="Catatan tambahan tentang perangkat ini...">${prefill ? escHtml(prefill.keterangan || '') : ''}</textarea>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <i class="ti ti-x"></i> Batal
        </button>
        <button class="btn btn-primary" onclick="${isEdit ? 'saveEdit()' : 'addDevice()'}">
          <i class="ti ti-${isEdit ? 'check' : 'plus'}"></i>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah OLT'}
        </button>
      </div>

    </div>`;

  document.getElementById('f-name').focus();
}

/** Tutup form dan tampilkan kembali tombol Tambah. */
function cancelForm() {
  editingId = null;
  document.getElementById('form-container').innerHTML = '';
  document.getElementById('add-btn').style.display = '';
}

/**
 * Tampilkan form edit dengan data OLT yang dipilih.
 * @param {number} id
 */
function editDevice(id) {
  const d = devices.find(x => x.id === id);
  if (d) showForm(d);
}


// ── DELETE ─────────────────────────────────────────────────────

/**
 * Tampilkan modal konfirmasi hapus OLT.
 * @param {number} id
 */
function confirmDelete(id) {
  const d = devices.find(x => x.id === id);
  if (!d) return;

  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay open" onclick="closeModal()">
      <div class="modal" onclick="event.stopPropagation()">

        <div class="modal-title">
          <i class="ti ti-alert-triangle" style="color: var(--red);"></i>
          Hapus Perangkat OLT
        </div>

        <div class="modal-body">
          Yakin ingin menghapus <strong style="color: var(--text);">${escHtml(d.name)}</strong>?<br>
          Semua konfigurasi perangkat ini akan dihapus secara permanen.
        </div>

        <div class="modal-actions">
          <button class="btn" onclick="closeModal()">Batal</button>
          <button class="btn btn-red" onclick="doDelete(${id})">
            <i class="ti ti-trash"></i> Hapus
          </button>
        </div>

      </div>
    </div>`;
}




// ── INIT ───────────────────────────────────────────────────────
loadDevices();