/* ============================================================
   input_mikrotik.js — Manajemen Perangkat MikroTik
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, statusInfo, animNum,
              toast, closeModal, togglePwd,
              openModalForm, closeModalForm)

   Perubahan dari versi lama:
   - showForm()      → form muncul sebagai MODAL POPUP di tengah halaman
                       (via openModalForm dari global.js, backdrop blur)
   - cancelForm()    → menutup modal (closeModalForm)
   - confirmDelete() → modal konfirmasi via openModalForm
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let devices    = [];
let editingId  = null;
let syncingIds = new Set();


// ── HELPERS ────────────────────────────────────────────────────

function showListLoading() {
  document.getElementById('device-list').innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined spin" style="font-size:32px;">refresh</span>
      <p>Memuat perangkat...</p>
    </div>`;
}


// ── STATS ──────────────────────────────────────────────────────

function updateStats() {
  animNum('stat-connected', devices.filter(d => d.status === 'connected').length);
  animNum('stat-failed',    devices.filter(d => d.status === 'failed').length);
  animNum('stat-total',     devices.length);
  const el = document.getElementById('device-count');
  if (el) el.textContent = `${devices.length} perangkat`;
}


// ── API CALLS ──────────────────────────────────────────────────

/** Ambil semua perangkat dari database via GET /devices. */
async function loadDevices() {
  showListLoading();
  try {
    const res  = await fetch(`${API_BASE}/devices`);
    const data = await res.json();
    devices = Array.isArray(data) ? data : [];
    renderDevices();
  } catch (e) {
    document.getElementById('device-list').innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--red);">wifi_off</span>
        <p style="font-weight:600;color:var(--text);">Tidak bisa terhubung ke server</p>
        <p style="font-size:12px;color:var(--text-muted);">Pastikan backend Flask sudah berjalan.</p>
      </div>`;
    updateStats();
  }
}

/** Tambah perangkat baru via POST /devices. */
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

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/devices`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, ip, port, username: user, password: pass }),
    });
    const data = await res.json();

    if (res.ok) {
      devices.push(data.device);
      cancelForm();
      renderDevices();
      toast(data.message, data.device.status === 'connected' ? 'success' : 'danger');
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Perangkat'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Perangkat'; }
  }
}

/** Edit perangkat via PUT /devices/<id>. */
async function saveEdit() {
  const name = val('f-name');
  const ip   = val('f-ip');
  const port = val('f-port') || '8728';
  const user = val('f-user');
  const pass = val('f-pass');

  if (!name || !ip || !user) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/devices/${editingId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, ip, port, username: user, password: pass }),
    });
    const data = await res.json();

    if (res.ok) {
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device;
      cancelForm();
      renderDevices();
      toast('Data perangkat berhasil diperbarui.', 'success');
    } else {
      toast(data.message || 'Gagal memperbarui perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}

/** Hapus perangkat via DELETE /devices/<id>. */
async function doDelete(id) {
  closeModalForm();   // tutup modal konfirmasi
  try {
    const res = await fetch(`${API_BASE}/devices/${id}`, { method: 'DELETE' });
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

/** Sinkronisasi satu perangkat via POST /devices/<id>/sync. */
async function syncDevice(id) {
  if (syncingIds.has(id)) return;

  syncingIds.add(id);
  renderDevices();

  try {
    const res  = await fetch(`${API_BASE}/devices/${id}/sync`, { method: 'POST' });
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

/** Sinkronisasi semua perangkat sekaligus. */
async function syncAll() {
  const icon    = document.getElementById('sync-all-icon');
  const pending = devices.filter(d => !syncingIds.has(d.id));

  if (!pending.length) {
    toast('Semua perangkat sedang disinkron.', 'info');
    return;
  }

  if (icon) icon.classList.add('spin');
  pending.forEach(d => syncingIds.add(d.id));
  renderDevices();

  await Promise.all(pending.map(async d => {
    try {
      const res  = await fetch(`${API_BASE}/devices/${d.id}/sync`, { method: 'POST' });
      const data = await res.json();
      d.status   = data.connected ? 'connected' : 'failed';
    } catch (e) {
      d.status = 'failed';
    }
    syncingIds.delete(d.id);
    renderDevices();
  }));

  if (icon) icon.classList.remove('spin');
  const connected = devices.filter(x => x.status === 'connected').length;
  toast(`Sinkronisasi selesai. ${connected}/${devices.length} perangkat terhubung.`, 'info');
}


// ── RENDER ─────────────────────────────────────────────────────

function renderDevices() {
  const container = document.getElementById('device-list');

  if (!devices.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--text-dim);">devices</span>
        <p style="font-weight:600;color:var(--text);">Belum ada perangkat terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted);">Klik <strong>Tambah Perangkat</strong> untuk memulai.</p>
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
      <div class="device-card status-${d.status}" id="card-${d.id}">

        <div class="device-icon">
          <span class="material-symbols-outlined">router</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            <span class="badge ${escHtml(badgeCls)}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${escHtml(badgeLabel)}
            </span>
          </div>
          <div class="device-meta">
            <span class="device-meta-item">
              <span class="material-symbols-outlined">lan</span>
              ${escHtml(d.ip)}:${escHtml(String(d.port))}
            </span>
            <span class="device-meta-item">
              <span class="material-symbols-outlined">person</span>
              ${escHtml(d.username)}
            </span>
            <span class="device-meta-item">
              <span class="material-symbols-outlined">api</span>
              RouterOS API
            </span>
          </div>
        </div>

        <div class="device-actions">
          <button class="btn btn-blue btn-sm"
                  id="sync-btn-${d.id}"
                  onclick="syncDevice(${d.id})"
                  ${isSyncing ? 'disabled' : ''}>
            <span class="material-symbols-outlined ${isSyncing ? 'spin' : ''}">refresh</span>
            Sinkron
          </button>
          <button class="btn btn-amber btn-sm" onclick="editDevice(${d.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${d.id})" title="Hapus perangkat">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── FORM MODAL ─────────────────────────────────────────────────
// Form tambah/edit muncul sebagai MODAL POPUP di tengah halaman.
// Latar page blur, header & navbar tetap jernih (z-index CSS).

function showForm(prefill = null) {
  editingId    = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(prefill[k] || '') : '';

  const html = `
    <div class="form-modal">

      <!-- Header modal -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:20px;">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1;">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;
               color:var(--text);letter-spacing:-.02em;">
            ${isEdit ? 'Edit Perangkat MikroTik' : 'Tambah Perangkat MikroTik'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit ? 'Perbarui data koneksi RouterOS API' : 'Daftarkan MikroTik baru ke sistem billing'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <!-- Fields -->
      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label" for="f-name">
            Nama Perangkat <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="Contoh: MikroTik-Kantor-Pusat"
                 value="${v('name')}">
        </div>

        <div class="form-group full">
          <label class="form-label">
            IP Address &amp; Port API <span class="req">*</span>
          </label>
          <div class="ip-port-row">
            <input class="form-input" type="text" id="f-ip"
                   placeholder="192.168.1.1"
                   value="${v('ip')}">
            <input class="form-input port" type="text" id="f-port"
                   placeholder="8728"
                   value="${prefill ? escHtml(String(prefill.port || 8728)) : ''}">
          </div>
          <span class="form-hint">Port default: 8728 (tanpa SSL) · 8729 (SSL)</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="f-user">
            Username MikroTik <span class="req">*</span>
          </label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin"
                 value="${v('username')}">
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

      </div>

      <!-- Actions -->
      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addDevice()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah Perangkat'}
        </button>
      </div>

    </div>`;

  openModalForm(html);  // ← dari global.js

  requestAnimationFrame(() => {
    const el = document.getElementById('f-name');
    if (el) el.focus();
  });
}

/** Tutup modal form. */
function cancelForm() {
  editingId = null;
  closeModalForm();   // ← dari global.js
}

/** Tampilkan form edit dengan data perangkat yang dipilih. */
function editDevice(id) {
  const d = devices.find(x => x.id === id);
  if (d) showForm(d);
}


// ── DELETE MODAL ───────────────────────────────────────────────

function confirmDelete(id) {
  const d = devices.find(x => x.id === id);
  if (!d) return;

  const html = `
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus Perangkat?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(d.name)}</strong>?<br>
        Semua konfigurasi perangkat ini akan dihapus secara permanen.
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete(${id})">
          <span class="material-symbols-outlined">delete</span> Hapus
        </button>
      </div>
    </div>`;

  openModalForm(html);  // ← dari global.js
}


// ── INIT ───────────────────────────────────────────────────────
loadDevices();