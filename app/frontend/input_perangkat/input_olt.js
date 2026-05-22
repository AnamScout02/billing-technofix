/* ============================================================
   input_olt.js — Manajemen Perangkat OLT TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, statusInfo, animNum,
              toast, togglePwd, openModalForm, closeModalForm)

   Perubahan dari versi lama:
   - showForm()      → form muncul sebagai MODAL POPUP di tengah halaman
   - cancelForm()    → menutup modal (closeModalForm)
   - confirmDelete() → modal konfirmasi via openModalForm

   Endpoint:
   GET    /olt              → daftar semua OLT
   POST   /olt              → tambah OLT baru
   PUT    /olt/<id>         → edit OLT
   DELETE /olt/<id>         → hapus OLT
   POST   /olt/<id>/sync    → tes koneksi ulang
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
      <p>Memuat perangkat OLT...</p>
    </div>`;
}


// ── STATS ──────────────────────────────────────────────────────

function updateStats() {
  animNum('stat-total',     devices.length);
  animNum('stat-connected', devices.filter(d => d.status === 'connected').length);
  animNum('stat-failed',    devices.filter(d => d.status === 'failed').length);
  animNum('stat-pending',   devices.filter(d => d.status === 'pending').length);

  const el = document.getElementById('device-count');
  if (el) el.textContent = `${devices.length} perangkat`;
}


// ── API CALLS ──────────────────────────────────────────────────

async function loadDevices() {
  showListLoading();
  try {
    const res  = await fetch(`${API_BASE}/olt`);
    const data = await res.json();
    devices    = Array.isArray(data) ? data : (data.devices || []);
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

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/olt`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, keterangan }),
    });
    const data = await res.json();

    if (res.ok) {
      devices.push(data.device || data);
      cancelForm();
      renderDevices();
      toast(
        data.message || `${name} berhasil ditambahkan`,
        data.device?.status === 'connected' ? 'success' : 'danger'
      );
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah OLT'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah OLT'; }
  }
}

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

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/olt/${editingId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, keterangan }),
    });
    const data = await res.json();

    if (res.ok) {
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device || data;
      cancelForm();
      renderDevices();
      toast('Data perangkat OLT berhasil diperbarui.', 'success');
    } else {
      toast(data.message || 'Gagal memperbarui perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}

async function doDelete(id) {
  closeModalForm();
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

async function syncDevice(id) {
  if (syncingIds.has(id)) return;

  syncingIds.add(id);
  renderDevices();

  try {
    const res  = await fetch(`${API_BASE}/olt/${id}/sync`, { method: 'POST' });
    const data = await res.json();
    const d    = devices.find(x => x.id === id);
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

async function syncAll() {
  const icon    = document.getElementById('sync-all-icon');
  const pending = devices.filter(d => !syncingIds.has(d.id));

  if (!pending.length) { toast('Semua perangkat sedang disinkron.', 'info'); return; }

  if (icon) icon.classList.add('spin');
  pending.forEach(d => syncingIds.add(d.id));
  renderDevices();

  await Promise.all(pending.map(async d => {
    try {
      const res  = await fetch(`${API_BASE}/olt/${d.id}/sync`, { method: 'POST' });
      const data = await res.json();
      d.status   = data.connected ? 'connected' : 'failed';
    } catch (e) { d.status = 'failed'; }
    syncingIds.delete(d.id);
  }));

  if (icon) icon.classList.remove('spin');
  renderDevices();
  toast('Sinkronisasi semua perangkat OLT selesai.', 'success');
}


// ── RENDER ─────────────────────────────────────────────────────

function renderDevices() {
  const container = document.getElementById('device-list');

  if (!devices.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--text-dim);">settings_input_antenna</span>
        <p style="font-weight:600;color:var(--text);">Belum ada perangkat OLT terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted);">Klik <strong>Tambah OLT</strong> untuk memulai.</p>
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
          <span class="material-symbols-outlined">settings_input_antenna</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            ${d.tipe ? `<span class="device-tipe-badge">${escHtml(d.tipe)}</span>` : ''}
            <span class="badge ${escHtml(badgeCls)}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${escHtml(badgeLabel)}
            </span>
          </div>
          <div class="device-meta">
            <span class="device-meta-item">
              <span class="material-symbols-outlined">lan</span>
              ${escHtml(d.ip)}:${escHtml(String(d.port || 23))}
            </span>
            <span class="device-meta-item">
              <span class="material-symbols-outlined">person</span>
              ${escHtml(d.username)}
            </span>
            ${d.snmp ? `<span class="device-meta-item"><span class="material-symbols-outlined">vpn_key</span>${escHtml(d.snmp)}</span>` : ''}
            ${d.lokasi ? `<span class="device-meta-item"><span class="material-symbols-outlined">location_on</span>${escHtml(d.lokasi)}</span>` : ''}
          </div>
          ${d.keterangan ? `<p class="device-keterangan">${escHtml(d.keterangan)}</p>` : ''}
        </div>

        <div class="device-actions">
          <button class="btn btn-blue btn-sm" id="sync-btn-${d.id}"
                  onclick="syncDevice(${d.id})" ${isSyncing ? 'disabled' : ''}>
            <span class="material-symbols-outlined ${isSyncing ? 'spin' : ''}">refresh</span>
            Sinkron
          </button>
          <button class="btn btn-amber btn-sm" onclick="editDevice(${d.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${d.id})" title="Hapus">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── FORM MODAL ─────────────────────────────────────────────────

function showForm(prefill = null) {
  editingId    = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(prefill[k] || '') : '';

  const html = `
    <div class="form-modal" style="width:560px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:20px;">${isEdit ? 'edit' : 'add_circle'}</span>
        </div>
        <div style="flex:1;">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">
            ${isEdit ? 'Edit Perangkat OLT' : 'Tambah Perangkat OLT'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit ? 'Perbarui data OLT yang terdaftar' : 'Daftarkan Optical Line Terminal baru'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group">
          <label class="form-label">Nama OLT <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="cth: OLT-Pusat-01" value="${v('name')}">
        </div>

        <div class="form-group">
          <label class="form-label">Tipe / Merek</label>
          <input class="form-input" type="text" id="f-tipe"
                 placeholder="cth: Huawei MA5800 / ZTE C600" value="${v('tipe')}">
        </div>

        <div class="form-group full">
          <label class="form-label">IP Address &amp; Port <span class="req">*</span></label>
          <div class="ip-port-row">
            <input class="form-input" type="text" id="f-ip"
                   placeholder="192.168.1.100" value="${v('ip')}">
            <input class="form-input port" type="number" id="f-port"
                   placeholder="23" min="1" max="65535"
                   value="${prefill ? escHtml(String(prefill.port || 23)) : '23'}">
          </div>
          <span class="form-hint">Port default: 23 (Telnet) · 22 (SSH) · 161 (SNMP)</span>
        </div>

        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin" value="${v('username')}">
        </div>

        <div class="form-group">
          <label class="form-label">Password ${isEdit ? '' : '<span class="req">*</span>'}</label>
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
          <label class="form-label">SNMP Community String</label>
          <input class="form-input" type="text" id="f-snmp"
                 placeholder="cth: public" value="${v('snmp')}">
        </div>

        <div class="form-group">
          <label class="form-label">Lokasi</label>
          <input class="form-input" type="text" id="f-lokasi"
                 placeholder="cth: Gedung Pusat Lt.2" value="${v('lokasi')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Keterangan</label>
          <textarea class="form-input" id="f-keterangan" rows="2"
                    placeholder="Catatan tambahan tentang perangkat ini...">${prefill ? escHtml(prefill.keterangan || '') : ''}</textarea>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addDevice()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah OLT'}
        </button>
      </div>
    </div>`;

  openModalForm(html);

  requestAnimationFrame(() => {
    const el = document.getElementById('f-name');
    if (el) el.focus();
  });
}

function cancelForm() {
  editingId = null;
  closeModalForm();
}

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
      <div class="hapus-title">Hapus Perangkat OLT?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(d.name)}</strong>?<br>
        Semua konfigurasi dan data ONU yang terpetakan akan dihapus permanen.
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete(${id})">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`;

  openModalForm(html);
}


// ── INIT ───────────────────────────────────────────────────────
loadDevices();