/* ============================================================
   devices.js — Manajemen Perangkat MikroTik
   ============================================================ */

const API = 'http://localhost:5000'; // Sesuaikan jika backend di server lain

// ── STATE ─────────────────────────────────────────────────────
let devices    = [];   // Array semua perangkat dari database
let editingId  = null; // ID perangkat yang sedang diedit (null = mode tambah)
let syncingIds = new Set(); // Set ID perangkat yang sedang disinkron
let toastTimer = null; // Timer untuk auto-hide toast


// ── HELPERS ───────────────────────────────────────────────────

/**
 * Ambil nilai dari input berdasarkan ID, trim whitespace.
 * @param {string} id - ID elemen input
 * @returns {string}
 */
function val(id) {
  return document.getElementById(id).value.trim();
}

/**
 * Escape karakter HTML untuk mencegah XSS.
 * @param {string} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Kembalikan label dan icon berdasarkan status perangkat.
 * @param {'connected'|'failed'|'pending'|'syncing'} s
 * @returns {{ label: string, icon: string }}
 */
function statusInfo(s) {
  const map = {
    connected: { label: 'Terhubung',       icon: 'ti-wifi'     },
    failed:    { label: 'Gagal Terhubung',  icon: 'ti-wifi-off' },
    pending:   { label: 'Belum Disinkron',  icon: 'ti-clock'    },
    syncing:   { label: 'Menyinkron...',    icon: 'ti-refresh'  },
  };
  return map[s] || map.pending;
}

/**
 * Tampilkan loading spinner di device list.
 */
function showListLoading() {
  document.getElementById('device-list').innerHTML = `
    <div class="empty-state">
      <i class="ti ti-loader spin" style="font-size:32px;"></i>
      <p>Memuat perangkat...</p>
    </div>`;
}


// ── API CALLS ─────────────────────────────────────────────────

/**
 * Ambil semua perangkat dari database via GET /devices.
 * Dipanggil saat halaman pertama kali dibuka.
 */
async function loadDevices() {
  showListLoading();
  try {
    const res  = await fetch(`${API}/devices`);
    const data = await res.json();
    devices = data; // Isi state dengan data dari server
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

/**
 * Kirim data perangkat baru ke backend (POST /devices).
 * Backend akan langsung tes koneksi dan simpan ke DB.
 */
async function addDevice() {
  const name = val('f-name');
  const ip   = val('f-ip');
  const port = val('f-port') || '8728';
  const user = val('f-user');
  const pass = val('f-pass');

  if (!name || !ip || !user || !pass) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  // Disable tombol agar tidak dobel submit
  const btn = document.querySelector('.form-actions .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader spin"></i> Menyimpan...';

  try {
    const res  = await fetch(`${API}/devices`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, ip, port, username: user, password: pass })
    });
    const data = await res.json();

    if (res.ok) {
      // Tambahkan perangkat dari response server (sudah ada id & status nyata)
      devices.push(data.device);
      cancelForm();
      renderDevices();
      toast(data.message, data.device.status === 'connected' ? 'success' : 'danger');
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-plus"></i> Tambah Perangkat';
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-plus"></i> Tambah Perangkat';
  }
}

/**
 * Kirim perubahan data perangkat ke backend (PUT /devices/<id>).
 */
async function saveEdit() {
  const name = val('f-name');
  const ip   = val('f-ip');
  const port = val('f-port') || '8728';
  const user = val('f-user');
  const pass = val('f-pass'); // Boleh kosong

  if (!name || !ip || !user) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  const btn = document.querySelector('.form-actions .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader spin"></i> Menyimpan...';

  try {
    const res  = await fetch(`${API}/devices/${editingId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, ip, port, username: user, password: pass })
    });
    const data = await res.json();

    if (res.ok) {
      // Update data di state lokal
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device;
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
 * Hapus perangkat dari database (DELETE /devices/<id>).
 * @param {number} id
 */
async function doDelete(id) {
  closeModal();
  try {
    const res = await fetch(`${API}/devices/${id}`, { method: 'DELETE' });
    if (res.ok) {
      devices = devices.filter(x => x.id !== id);
      renderDevices();
      toast('Perangkat berhasil dihapus.', 'danger');
    } else {
      toast('Gagal menghapus perangkat.', 'danger');
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
  }
}

/**
 * Sinkronisasi satu perangkat — tes koneksi nyata ke MikroTik
 * via POST /devices/<id>/sync, lalu update status di DB.
 * @param {number} id
 */
async function syncDevice(id) {
  if (syncingIds.has(id)) return;

  syncingIds.add(id);
  renderDevices();

  try {
    const res  = await fetch(`${API}/devices/${id}/sync`, { method: 'POST' });
    const data = await res.json();

    const d = devices.find(x => x.id === id);
    if (d) {
      d.status = data.connected ? 'connected' : 'failed';
      toast(data.message, d.status === 'connected' ? 'success' : 'danger');
    }
  } catch (e) {
    const d = devices.find(x => x.id === id);
    if (d) d.status = 'failed';
    toast('Tidak bisa menghubungi server.', 'danger');
  }

  syncingIds.delete(id);
  renderDevices();
}

/**
 * Sinkronisasi semua perangkat sekaligus.
 */
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

  // Jalankan semua sync secara paralel dengan Promise.all
  await Promise.all(pending.map(async d => {
    try {
      const res  = await fetch(`${API}/devices/${d.id}/sync`, { method: 'POST' });
      const data = await res.json();
      d.status = data.connected ? 'connected' : 'failed';
    } catch (e) {
      d.status = 'failed';
    }
    syncingIds.delete(d.id);
    renderDevices();
  }));

  icon.classList.remove('spin');
  const connected = devices.filter(x => x.status === 'connected').length;
  toast(`Sinkronisasi selesai. ${connected}/${devices.length} perangkat terhubung.`, 'info');
}


// ── STATS ─────────────────────────────────────────────────────

/**
 * Perbarui tampilan kartu statistik (terhubung, gagal, total).
 */
function updateStats() {
  document.getElementById('stat-connected').textContent = devices.filter(d => d.status === 'connected').length;
  document.getElementById('stat-failed').textContent    = devices.filter(d => d.status === 'failed').length;
  document.getElementById('stat-total').textContent     = devices.length;
  document.getElementById('device-count').textContent   = `${devices.length} perangkat`;
}


// ── RENDER DEVICES ────────────────────────────────────────────

/**
 * Render ulang seluruh daftar perangkat ke DOM.
 */
function renderDevices() {
  const container = document.getElementById('device-list');

  if (!devices.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-device-desktop-off"></i>
        <p>Belum ada perangkat terdaftar.<br>Klik <strong>Tambah Perangkat</strong> untuk memulai.</p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = devices.map(d => {
    const si         = statusInfo(d.status);
    const isSyncing  = syncingIds.has(d.id);
    const badgeCls   = isSyncing ? 'syncing' : d.status;
    const badgeLabel = isSyncing ? 'Menyinkron...' : si.label;

    return `
      <div class="device-card" id="card-${d.id}">

        <div class="device-icon">
          <i class="ti ti-router"></i>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            <span class="badge ${badgeCls}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${badgeLabel}
            </span>
          </div>
          <div class="device-meta">
            <span class="device-meta-item">
              <i class="ti ti-network"></i>${escHtml(d.ip)}:${escHtml(String(d.port))}
            </span>
            <span class="device-meta-item">
              <i class="ti ti-user"></i>${escHtml(d.username)}
            </span>
            <span class="device-meta-item">
              <i class="ti ti-plug"></i>RouterOS API
            </span>
          </div>
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


// ── FORM ──────────────────────────────────────────────────────

/**
 * Tampilkan form tambah atau edit perangkat.
 * @param {object|null} prefill - Data perangkat untuk mode edit, null untuk mode tambah
 */
function showForm(prefill = null) {
  editingId = prefill ? prefill.id : null;
  const isEdit = !!prefill;

  document.getElementById('add-btn').style.display = 'none';

  document.getElementById('form-container').innerHTML = `
    <div class="form-card">

      <div class="form-card-title">
        <i class="ti ti-${isEdit ? 'edit' : 'plus-circle'}"></i>
        ${isEdit ? 'Edit Perangkat' : 'Tambah Perangkat Baru'}
      </div>

      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label" for="f-name">
            Nama Perangkat <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="Contoh: MikroTik-Kantor-Pusat"
                 value="${prefill ? escHtml(prefill.name) : ''}">
        </div>

        <div class="form-group full">
          <label class="form-label" for="f-ip">
            IP Address &amp; Port API <span class="req">*</span>
          </label>
          <div class="ip-port-row">
            <input class="form-input mono" type="text" id="f-ip"
                   placeholder="192.168.1.1"
                   value="${prefill ? escHtml(prefill.ip) : ''}">
            <input class="form-input mono" type="text" id="f-port"
                   placeholder="8728"
                   value="${prefill ? escHtml(String(prefill.port)) : ''}">
          </div>
          <span class="form-hint">Port default: 8728 (tanpa SSL) / 8729 (SSL)</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="f-user">
            Username MikroTik <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin"
                 value="${prefill ? escHtml(prefill.username) : ''}">
        </div>

        <div class="form-group">
          <label class="form-label" for="f-pass">
            Password MikroTik ${isEdit ? '' : '<span class="req">*</span>'}
          </label>
          <input class="form-input" type="password" id="f-pass"
                 placeholder="${isEdit ? 'Kosongkan jika tidak diubah' : '••••••••'}"
                 autocomplete="new-password">
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <i class="ti ti-x"></i> Batal
        </button>
        <button class="btn btn-primary" onclick="${isEdit ? 'saveEdit()' : 'addDevice()'}">
          <i class="ti ti-${isEdit ? 'check' : 'plus'}"></i>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah Perangkat'}
        </button>
      </div>

    </div>`;

  document.getElementById('f-name').focus();
}

/**
 * Tutup form dan tampilkan kembali tombol Tambah.
 */
function cancelForm() {
  editingId = null;
  document.getElementById('form-container').innerHTML = '';
  document.getElementById('add-btn').style.display = '';
}

/**
 * Tampilkan form edit dengan data perangkat yang dipilih.
 * @param {number} id
 */
function editDevice(id) {
  const d = devices.find(x => x.id === id);
  if (d) showForm(d);
}


// ── DELETE ────────────────────────────────────────────────────

/**
 * Tampilkan modal konfirmasi hapus perangkat.
 * @param {number} id
 */
function confirmDelete(id) {
  const d = devices.find(x => x.id === id);
  if (!d) return;

  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" onclick="closeModal()">
      <div class="modal" onclick="event.stopPropagation()">

        <div class="modal-title">
          <i class="ti ti-alert-triangle" style="color: var(--red-text); font-size: 20px;"></i>
          Hapus Perangkat
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

/**
 * Tutup modal yang sedang tampil.
 */
function closeModal() {
  document.getElementById('modal-container').innerHTML = '';
}


// ── TOAST ─────────────────────────────────────────────────────

/**
 * Tampilkan notifikasi toast.
 * @param {string} msg - Pesan yang ditampilkan
 * @param {'success'|'danger'|'warning'|'info'} type - Jenis notifikasi
 */
function toast(msg, type = 'success') {
  clearTimeout(toastTimer);

  const icons = {
    success: 'ti-check',
    danger:  'ti-alert-circle',
    warning: 'ti-alert-triangle',
    info:    'ti-info-circle',
  };

  const el = document.getElementById('toast');
  el.className = `show ${type}`;
  el.innerHTML = `<i class="ti ${icons[type] || 'ti-check'}" style="font-size: 15px;"></i>${msg}`;

  toastTimer = setTimeout(() => {
    el.classList.replace('show', 'hidden');
  }, 3500);
}


// ── INIT ──────────────────────────────────────────────────────
// Saat halaman dibuka, langsung ambil data dari server
loadDevices();