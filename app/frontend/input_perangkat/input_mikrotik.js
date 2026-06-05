/* ============================================================
   input_mikrotik.js — Manajemen Perangkat MikroTik
   v2.1 — Card redesign + titik koordinat untuk Maps
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let devices    = [];
let editingId  = null;
let syncingIds = new Set();
const profileCountCache = new Map();


// ── HELPERS ────────────────────────────────────────────────────

function _hdr(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (typeof getAuthHeaders === 'function') Object.assign(h, getAuthHeaders());
  return h;
}
function _get(url) { return fetch(url, { credentials: 'include', headers: _hdr() }); }
function _post(url, body) { return fetch(url, { method: 'POST', credentials: 'include', headers: _hdr(), body: JSON.stringify(body) }); }
function _put(url, body)  { return fetch(url, { method: 'PUT',  credentials: 'include', headers: _hdr(), body: JSON.stringify(body) }); }
function _del(url)        { return fetch(url, { method: 'DELETE', credentials: 'include', headers: _hdr() }); }

function showListLoading() {
  document.getElementById('device-list').innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined spin" style="font-size:32px;">refresh</span>
      <p>Memuat perangkat...</p>
    </div>`;
}

function profilePageUrl(deviceId) {
  return `/app/frontend/profile_pppoe/profile_pppoe.html?device_id=${deviceId}`;
}

function mapsUrl(koordinat) {
  if (!koordinat) return '#';
  const parts = koordinat.split(',').map(s => s.trim());
  if (parts.length === 2) {
    return `https://www.google.com/maps?q=${parts[0]},${parts[1]}`;
  }
  return `https://www.google.com/maps/search/${encodeURIComponent(koordinat)}`;
}


// ── STATS ──────────────────────────────────────────────────────

function updateStats() {
  animNum('stat-connected', devices.filter(d => d.status === 'connected').length);
  animNum('stat-failed',    devices.filter(d => d.status === 'failed').length);
  animNum('stat-total',     devices.length);
  const el = document.getElementById('device-count');
  if (el) el.textContent = `${devices.length} perangkat`;
}


// ── PROFILE COUNT BADGE ────────────────────────────────────────

async function fetchProfileCount(deviceId) {
  const cached = profileCountCache.get(deviceId);
  if (cached && (cached.loading || cached.count !== null)) return;

  profileCountCache.set(deviceId, { count: null, loading: true, error: false });
  updateProfileBadge(deviceId);

  try {
    const res  = await _get(`${API_BASE}/devices/${deviceId}/profile-count`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    profileCountCache.set(deviceId, { count: data.count ?? 0, loading: false, error: false });
  } catch (_) {
    profileCountCache.set(deviceId, { count: null, loading: false, error: true });
  }
  updateProfileBadge(deviceId);
}

function updateProfileBadge(deviceId) {
  const el = document.getElementById(`profile-badge-${deviceId}`);
  if (!el) return;
  el.innerHTML = buildProfileBadgeInner(deviceId);
}

function buildProfileBadgeInner(deviceId) {
  const state = profileCountCache.get(deviceId);

  if (!state || state.loading) {
    return `<span class="material-symbols-outlined spin" style="font-size:12px;color:var(--text-dim)">refresh</span>
            <span style="font-size:11px;color:var(--text-dim)">Memuat...</span>`;
  }
  if (state.error || state.count === null) {
    return `<span style="font-size:11px;color:var(--text-dim)">—</span>`;
  }

  const count  = state.count;
  const hasData = count > 0;

  return `
    <button class="profile-count-badge"
      onclick="goToProfiles(event, ${deviceId})"
      title="Lihat ${count} PPPoE Profile"
      style="
        display:inline-flex;align-items:center;gap:4px;
        background:${hasData ? 'var(--primary-light)' : 'var(--surface)'};
        color:${hasData ? 'var(--primary)' : 'var(--text-dim)'};
        border:1px solid ${hasData ? 'rgba(0,64,161,.2)' : 'var(--border)'};
        border-radius:99px;padding:3px 9px;cursor:pointer;
        font-size:11px;font-weight:700;font-family:var(--heading);
        transition:background .15s,box-shadow .15s;white-space:nowrap;
      ">
      <span class="material-symbols-outlined" style="font-size:12px">speed</span>
      ${count} Profile
      <span class="material-symbols-outlined" style="font-size:11px;opacity:.6">arrow_forward</span>
    </button>`;
}

function goToProfiles(e, deviceId) {
  e.stopPropagation();
  window.location.href = profilePageUrl(deviceId);
}

function invalidateProfileCount(deviceId) {
  profileCountCache.delete(deviceId);
}


// ── API CALLS ──────────────────────────────────────────────────

async function loadDevices() {
  showListLoading();
  try {
    const res  = await _get(`${API_BASE}/devices`);
    const data = await res.json();
    devices = Array.isArray(data) ? data : [];
    renderDevices();
    devices
      .filter(d => d.status === 'connected')
      .forEach(d => fetchProfileCount(d.id));
  } catch (e) {
    document.getElementById('device-list').innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--red)">wifi_off</span>
        <p style="font-weight:600;color:var(--text)">Tidak bisa terhubung ke server</p>
        <p style="font-size:12px;color:var(--text-muted)">Pastikan backend Flask sudah berjalan.</p>
      </div>`;
    updateStats();
  }
}

async function addDevice() {
  const name      = val('f-name');
  const ip        = val('f-ip');
  const port      = val('f-port') || '8728';
  const user      = val('f-user');
  const pass      = val('f-pass');
  const koordinat = val('f-koordinat');

  if (!name || !ip || !user || !pass) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning'); return;
  }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await _post(`${API_BASE}/devices`,
      { name, ip, port, username: user, password: pass, koordinat });
    const data = await res.json();

    if (res.ok) {
      devices.push(data.device);
      cancelForm();
      renderDevices();
      toast(data.message, data.device.status === 'connected' ? 'success' : 'danger');
      if (data.device.status === 'connected') fetchProfileCount(data.device.id);
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Perangkat'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Perangkat'; }
  }
}

async function saveEdit() {
  const name      = val('f-name');
  const ip        = val('f-ip');
  const port      = val('f-port') || '8728';
  const user      = val('f-user');
  const pass      = val('f-pass');
  const koordinat = val('f-koordinat');

  if (!name || !ip || !user) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning'); return;
  }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await _put(`${API_BASE}/devices/${editingId}`,
      { name, ip, port, username: user, password: pass, koordinat });
    const data = await res.json();

    if (res.ok) {
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device;
      invalidateProfileCount(editingId);
      cancelForm();
      renderDevices();
      toast('Data perangkat berhasil diperbarui.', 'success');
    } else {
      toast(data.message || 'Gagal memperbarui.', 'danger');
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
    const res = await _del(`${API_BASE}/devices/${id}`);
    if (res.ok) {
      devices = devices.filter(x => x.id !== id);
      profileCountCache.delete(id);
      renderDevices();
      toast('Perangkat berhasil dihapus.', 'danger');
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
    const res  = await _post(`${API_BASE}/devices/${id}/sync`, {});
    const data = await res.json();
    const d    = devices.find(x => x.id === id);
    if (d) {
      d.status = data.connected ? 'connected' : 'failed';
      toast(data.message, d.status === 'connected' ? 'success' : 'danger');
      if (d.status === 'connected') invalidateProfileCount(id);
    }
  } catch (e) {
    const d = devices.find(x => x.id === id);
    if (d) d.status = 'failed';
    toast('Tidak bisa menghubungi server.', 'danger');
  }

  syncingIds.delete(id);
  renderDevices();
  const updated = devices.find(x => x.id === id);
  if (updated?.status === 'connected') fetchProfileCount(id);
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
      const res  = await _post(`${API_BASE}/devices/${d.id}/sync`, {});
      const data = await res.json();
      d.status   = data.connected ? 'connected' : 'failed';
    } catch (e) { d.status = 'failed'; }
    syncingIds.delete(d.id);
    renderDevices();
    if (d.status === 'connected') { invalidateProfileCount(d.id); fetchProfileCount(d.id); }
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
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--text-dim)">devices</span>
        <p style="font-weight:600;color:var(--text)">Belum ada perangkat terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted)">Klik <strong>Tambah Perangkat</strong> untuk memulai.</p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = devices.map(d => {
    const si        = statusInfo(d.status);
    const isSyncing = syncingIds.has(d.id);
    const badgeCls  = isSyncing ? 'syncing' : d.status;
    const badgeLbl  = isSyncing ? 'Menyinkron...' : si.label;
    const showBadge = true; // selalu tampilkan badge profil (muat otomatis jika connected)
    const koordinat = d.koordinat || '';

    return `
      <div class="device-card status-${d.status}" id="card-${d.id}">

        <!-- Ikon -->
        <div class="device-icon">
          <span class="material-symbols-outlined">router</span>
        </div>

        <!-- Info -->
        <div class="device-info">

          <!-- Baris 1: nama + status badge -->
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            <span class="badge ${escHtml(badgeCls)}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${escHtml(badgeLbl)}
            </span>
          </div>

          <!-- Baris 2: meta IP, user, koordinat -->
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
            ${koordinat ? `
            <a href="${escHtml(mapsUrl(koordinat))}" target="_blank"
               class="koordinat-badge" title="Buka di Google Maps">
              <span class="material-symbols-outlined">location_on</span>
              ${escHtml(koordinat)}
            </a>` : ''}
          </div>

          <!-- Baris 3: badge profile count -->
          <div class="device-profile-row">
            ${showBadge ? `
            <span id="profile-badge-${d.id}"
                  style="display:inline-flex;align-items:center;gap:5px">
              ${buildProfileBadgeInner(d.id)}
            </span>` : ''}
          </div>

        </div>

        <!-- Action buttons -->
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
    <div class="form-modal">

      <!-- Header form -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined" style="font-size:20px">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;
               color:var(--text);letter-spacing:-.02em">
            ${isEdit ? 'Edit Perangkat MikroTik' : 'Tambah Perangkat MikroTik'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px">
            ${isEdit ? 'Perbarui data koneksi RouterOS API' : 'Daftarkan MikroTik baru ke sistem billing'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <!-- Nama -->
        <div class="form-group full">
          <label class="form-label">Nama Perangkat <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="Contoh: MikroTik-Kantor-Pusat"
                 value="${v('name')}">
        </div>

        <!-- IP + Port -->
        <div class="form-group full">
          <label class="form-label">IP Address &amp; Port API <span class="req">*</span></label>
          <div class="ip-port-row">
            <input class="form-input" type="text" id="f-ip"
                   placeholder="192.168.1.1" value="${v('ip')}">
            <input class="form-input port" type="text" id="f-port"
                   placeholder="8728"
                   value="${prefill ? escHtml(String(prefill.port || 8728)) : ''}">
          </div>
          <span class="form-hint">Port default: 8728 (tanpa SSL) · 8729 (SSL)</span>
        </div>

        <!-- Username -->
        <div class="form-group full">
          <label class="form-label">Username MikroTik <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin" value="${v('username')}">
        </div>

        <!-- Password -->
        <div class="form-group full">
          <label class="form-label">
            Password ${isEdit ? '' : '<span class="req">*</span>'}
          </label>
          <div class="form-pwd-wrap">
            <input class="form-input" type="password" id="f-pass"
                   placeholder="${isEdit ? 'Kosongkan jika tidak diubah' : '••••••••'}"
                   autocomplete="new-password">
            <button type="button" class="form-pwd-toggle"
                    onclick="togglePwd('f-pass','pwd-eye')">
              <span class="material-symbols-outlined" id="pwd-eye">visibility</span>
            </button>
          </div>
        </div>

        <!-- ✅ TITIK KOORDINAT — untuk integrasi Maps -->
        <div class="form-group full">
          <label class="form-label">
            <span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle;color:var(--primary)">location_on</span>
            Titik Koordinat
            <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk halaman Maps)</span>
          </label>
          <div class="koordinat-row">
            <input class="form-input" type="text" id="f-koordinat"
                   placeholder="-6.200000, 106.816666"
                   value="${v('koordinat')}"
                   oninput="previewKoordinat()">
            <button type="button" class="koordinat-btn" onclick="deteksiLokasi()">
              <span class="material-symbols-outlined">my_location</span>
              Deteksi
            </button>
          </div>
          <span class="form-hint">
            Format: latitude, longitude — contoh: -6.200000, 106.816666 &nbsp;|&nbsp;
            <a href="https://maps.google.com" target="_blank"
               style="color:var(--primary);font-size:11px">Cari di Google Maps</a>
          </span>
          <!-- Preview peta mini -->
          <div class="koordinat-preview" id="koordinat-preview">
            <iframe id="koordinat-iframe" src="" loading="lazy"></iframe>
          </div>
        </div>


      </div>

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

  openModalForm(html);
  requestAnimationFrame(() => {
    document.getElementById('f-name')?.focus();
    // Jika edit dan ada koordinat, tampilkan preview
    if (isEdit && prefill?.koordinat) previewKoordinat();
  });
}

/** Deteksi lokasi perangkat via GPS browser */
function deteksiLokasi() { geoDetectKoordinat(); }  /* pakai fungsi bersama di global.js */

/** Tampilkan preview peta mini dari koordinat yang diinput */
function previewKoordinat() {
  const raw     = (document.getElementById('f-koordinat')?.value || '').trim();
  const preview = document.getElementById('koordinat-preview');
  const iframe  = document.getElementById('koordinat-iframe');
  if (!preview || !iframe) return;

  const parts = raw.split(',').map(s => s.trim());
  if (parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    iframe.src = `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`;
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
    iframe.src = '';
  }
}

function cancelForm() { editingId = null; closeModalForm(); }

function editDevice(id) {
  const d = devices.find(x => x.id === id);
  if (d) showForm(d);
}


// ── DELETE MODAL ───────────────────────────────────────────────

function confirmDelete(id) {
  const d = devices.find(x => x.id === id);
  if (!d) return;

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus Perangkat?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(d.name)}</strong>?<br>
        Semua konfigurasi perangkat ini akan dihapus secara permanen.
      </div>
      <div class="modal-actions" style="margin-top:20px">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete(${id})">
          <span class="material-symbols-outlined">delete</span> Hapus
        </button>
      </div>
    </div>`);
}


// ── INIT ───────────────────────────────────────────────────────
loadDevices();