/* ============================================================
   profile_pppoe.js — Manajemen PPPoE Profile MikroTik
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, animNum, toast,
              openModalForm, closeModalForm, togglePwd)

   Endpoint yang dipakai:
   GET    /devices                                → daftar perangkat
   GET    /api/profile/<device_id>               → daftar profile + harga
   POST   /api/profile/<device_id>               → tambah profile
   PUT    /api/profile/<device_id>/<nama>        → edit profile
   DELETE /api/profile/<device_id>/<nama>        → hapus profile
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let profiles  = [];
let editingNama = null;   // nama profile yang sedang diedit


// ── FORMAT HELPERS ─────────────────────────────────────────────

/** Format angka rupiah singkat: 150000 → "150.000" */
function fmtRupiah(angka) {
  if (!angka) return '—';
  return Number(angka).toLocaleString('id-ID');
}

/** Warna card berdasarkan kecepatan download */
function speedColor(rateDown) {
  const num = parseInt(rateDown) || 0;
  if      (num >= 50) return { bg: 'var(--primary-light)', color: 'var(--primary)' };
  else if (num >= 20) return { bg: 'var(--green-bg)',      color: 'var(--green)' };
  else if (num >= 10) return { bg: 'var(--blue-bg)',       color: 'var(--blue)' };
  else                return { bg: 'var(--amber-bg)',      color: 'var(--amber)' };
}

/** Parse nilai angka dari rate-limit string (misal "10M" → 10) */
function parseRateNum(s) {
  return parseInt(s) || 0;
}


// ── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadDevices();
});


// ── LOAD PERANGKAT ─────────────────────────────────────────────
async function loadDevices() {
  try {
    const res  = await fetch(`${API_BASE}/devices`);
    const data = await res.json();
    const sel  = document.getElementById('select-device');
    sel.innerHTML = '<option value="">— Pilih Perangkat —</option>';
    data.forEach(d => {
      sel.appendChild(new Option(`${d.name}  (${d.ip})`, d.id));
    });
    const saved = localStorage.getItem('lastSelectedDevice');
    if (saved && data.some(d => String(d.id) === saved)) {
      sel.value = saved;
      loadProfiles();
    }
  } catch (e) {
    toast('Gagal memuat daftar perangkat', 'danger');
  }
}


// ── LOAD PROFILES ──────────────────────────────────────────────
async function loadProfiles() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) {
    profiles = [];
    renderProfiles();
    return;
  }

  localStorage.setItem('lastSelectedDevice', deviceId);

  const icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = 'spinAnim .7s linear infinite';

  const sync = document.getElementById('sync-status');
  if (sync) sync.innerHTML = '⏳ Mengambil data...';

  try {
    const res  = await fetch(`${API_BASE}/api/profile/${deviceId}`);
    if (!res.ok) throw new Error((await res.json()).error || 'Gagal mengambil data');
    profiles = await res.json();
    renderProfiles();
    updateStats();
    if (sync) sync.innerHTML = '🟢 Terhubung';
  } catch (e) {
    toast(e.message, 'danger');
    if (sync) sync.innerHTML = '🔴 Gagal';
    document.getElementById('profile-list').innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--red);">wifi_off</span>
        <p style="font-weight:700;color:var(--text);">Gagal terhubung ke MikroTik</p>
        <p style="font-size:12px;color:var(--text-muted);">${escHtml(e.message)}</p>
      </div>`;
  } finally {
    if (icon) icon.style.animation = '';
  }
}


// ── STATS ──────────────────────────────────────────────────────
function updateStats() {
  const total      = profiles.length;
  const totalUsers = profiles.reduce((s, p) => s + (p.total_user || 0), 0);
  const hargaList  = profiles.filter(p => p.harga > 0).map(p => p.harga);
  const avgHarga   = hargaList.length
    ? Math.round(hargaList.reduce((a, b) => a + b, 0) / hargaList.length)
    : 0;

  animNum('stat-total', total);
  animNum('stat-users', totalUsers);

  const elAvg = document.getElementById('stat-harga-avg');
  if (elAvg) elAvg.textContent = avgHarga ? `Rp ${fmtRupiah(avgHarga)}` : '—';

  const cnt = document.getElementById('profile-count');
  if (cnt) cnt.textContent = `${total} profile`;
}


// ── RENDER ─────────────────────────────────────────────────────
function renderProfiles() {
  const container = document.getElementById('profile-list');

  if (!profiles.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--text-dim);">speed</span>
        <p style="font-weight:700;color:var(--text);">Belum ada profile</p>
        <p style="font-size:12px;color:var(--text-muted);">
          Klik <strong>Tambah Profile</strong> atau pilih perangkat lain.
        </p>
      </div>`;
    return;
  }

  // Urutkan: terbanyak pengguna dulu, lalu alfabetis
  const sorted = [...profiles].sort((a, b) =>
    (b.total_user - a.total_user) || a.name.localeCompare(b.name)
  );

  container.innerHTML = sorted.map((p, idx) => {
    const sc      = speedColor(p.rate_down);
    const isDown  = p.rate_down !== 'unlimited';
    const isUp    = p.rate_up   !== 'unlimited';
    const downNum = parseRateNum(p.rate_down);
    const upNum   = parseRateNum(p.rate_up);

    return `
      <div class="device-card" style="animation-delay:${idx * 30}ms">

        <!-- Ikon kecepatan -->
        <div class="device-icon" style="background:${sc.bg};color:${sc.color};
             flex-direction:column;gap:0;font-size:11px;font-weight:800;">
          <span class="material-symbols-outlined" style="font-size:20px;color:${sc.color};">
            speed
          </span>
          <span style="font-size:10px;font-weight:800;color:${sc.color};">
            ${isDown ? p.rate_down : '∞'}
          </span>
        </div>

        <!-- Info utama -->
        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(p.name)}</span>
            <!-- Badge jumlah pengguna -->
            ${p.total_user > 0 ? `
            <span class="badge connected">
              <span class="badge-dot"></span>
              ${p.total_user} pengguna
            </span>` : `
            <span class="badge pending">
              <span class="badge-dot"></span>
              Belum dipakai
            </span>`}
          </div>

          <div class="device-meta">
            <!-- Kecepatan -->
            <span class="device-meta-item">
              <span class="material-symbols-outlined">arrow_downward</span>
              <strong>Download:</strong>&nbsp;${escHtml(p.rate_down)}ps
            </span>
            <span class="device-meta-item">
              <span class="material-symbols-outlined">arrow_upward</span>
              <strong>Upload:</strong>&nbsp;${escHtml(p.rate_up)}ps
            </span>
            <!-- Harga -->
            <span class="device-meta-item" style="color:var(--green);font-weight:700;">
              <span class="material-symbols-outlined" style="color:var(--green);">payments</span>
              Rp ${fmtRupiah(p.harga)}
              <span style="font-weight:400;color:var(--text-muted);">/bln</span>
            </span>
          </div>

          ${p.deskripsi ? `
          <p class="device-keterangan">${escHtml(p.deskripsi)}</p>` : ''}

          <!-- Rate-limit raw (info tambahan) -->
          ${p.rate_limit ? `
          <div style="margin-top:6px;">
            <span style="font-size:11px;color:var(--text-dim);">
              Rate-limit MikroTik:
            </span>
            <span style="font-size:11px;font-weight:700;color:var(--text-muted);">
              ${escHtml(p.rate_limit)}
            </span>
          </div>` : ''}
        </div>

        <!-- Aksi -->
        <div class="device-actions">
          <button class="btn btn-amber btn-sm" onclick="editProfile(${JSON.stringify(p).replace(/"/g,'&quot;')})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete('${escHtml(p.name)}')"
                  title="Hapus profile" ${p.total_user > 0 ? 'style="opacity:.5" title="Ada pengguna aktif"' : ''}>
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>

      </div>`;
  }).join('');
}


// ── FORM MODAL ─────────────────────────────────────────────────
function showForm(prefill = null) {
  editingNama  = prefill ? prefill.name : null;
  const isEdit = !!prefill;

  // Parse nilai rate-limit dari prefill
  let downVal = '', downUnit = 'M', upVal = '', upUnit = 'M';
  if (prefill && prefill.rate_down && prefill.rate_down !== 'unlimited') {
    const m = prefill.rate_down.match(/^(\d+(?:\.\d+)?)(M|K|G)$/i);
    if (m) { downVal = m[1]; downUnit = m[2].toUpperCase(); }
  }
  if (prefill && prefill.rate_up && prefill.rate_up !== 'unlimited') {
    const m = prefill.rate_up.match(/^(\d+(?:\.\d+)?)(M|K|G)$/i);
    if (m) { upVal = m[1]; upUnit = m[2].toUpperCase(); }
  }

  const unitOpts = (sel) => ['M','K','G'].map(u =>
    `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}bps</option>`
  ).join('');

  const html = `
    <div class="form-modal" style="width:520px;">

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:20px;">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1;">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">
            ${isEdit ? 'Edit Profile PPPoE' : 'Tambah Profile PPPoE'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit
              ? `Edit profile <strong>${escHtml(prefill.name)}</strong>`
              : 'Buat paket kecepatan baru di MikroTik'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <!-- Nama profile -->
        <div class="form-group full">
          <label class="form-label">Nama Profile <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="cth: 10Mbps / Paket-Reguler / Home-Basic"
                 value="${isEdit ? escHtml(prefill.name) : ''}">
          <span class="form-hint">Nama ini akan tampil di MikroTik dan di pilihan saat tambah pelanggan</span>
        </div>

        <!-- Kecepatan Download -->
        <div class="form-group">
          <label class="form-label">Kecepatan Download <span class="req">*</span></label>
          <div class="ip-port-row">
            <input class="form-input" type="number" id="f-rate-down"
                   placeholder="cth: 10" min="1" value="${downVal}">
            <select class="form-input port" id="f-unit-down" style="width:80px;">
              ${unitOpts(downUnit)}
            </select>
          </div>
        </div>

        <!-- Kecepatan Upload -->
        <div class="form-group">
          <label class="form-label">Kecepatan Upload <span class="req">*</span></label>
          <div class="ip-port-row">
            <input class="form-input" type="number" id="f-rate-up"
                   placeholder="cth: 10" min="1" value="${upVal}">
            <select class="form-input port" id="f-unit-up" style="width:80px;">
              ${unitOpts(upUnit)}
            </select>
          </div>
          <span class="form-hint">Isi sama jika download = upload (simetris)</span>
        </div>

        <!-- Harga -->
        <div class="form-group">
          <label class="form-label">Harga / Bulan (Rp)</label>
          <input class="form-input" type="number" id="f-harga"
                 placeholder="cth: 150000" min="0"
                 value="${isEdit && prefill.harga ? prefill.harga : ''}">
        </div>

        <!-- Deskripsi -->
        <div class="form-group">
          <label class="form-label">Deskripsi Paket</label>
          <input class="form-input" type="text" id="f-deskripsi"
                 placeholder="cth: Paket Rumahan 10 Mbps"
                 value="${isEdit ? escHtml(prefill.deskripsi || '') : ''}">
        </div>

        <!-- Komentar MikroTik -->
        <div class="form-group full">
          <label class="form-label">Komentar (di MikroTik)</label>
          <input class="form-input" type="text" id="f-comment"
                 placeholder="Opsional — tampil di MikroTik"
                 value="${isEdit ? escHtml(prefill.comment || '') : ''}">
        </div>

        <!-- Preview rate-limit -->
        <div class="form-group full">
          <div style="background:var(--surface);border:1px solid var(--border);
               border-radius:var(--r-md);padding:10px 14px;
               display:flex;align-items:center;gap:10px;">
            <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">
              info
            </span>
            <div>
              <div style="font-size:11px;color:var(--text-dim);">Preview rate-limit MikroTik</div>
              <div style="font-size:13px;font-weight:700;color:var(--text);" id="rate-preview">
                —
              </div>
            </div>
          </div>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addProfile()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah Profile'}
        </button>
      </div>
    </div>`;

  openModalForm(html);

  // Setup live preview rate-limit
  requestAnimationFrame(() => {
    document.getElementById('f-nama')?.focus();
    ['f-rate-down','f-unit-down','f-rate-up','f-unit-up'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updateRatePreview);
    });
    updateRatePreview();
  });
}

function updateRatePreview() {
  const down = val('f-rate-down');
  const ud   = val('f-unit-down') || 'M';
  const up   = val('f-rate-up');
  const uu   = val('f-unit-up') || 'M';
  const el   = document.getElementById('rate-preview');
  if (!el) return;
  if (down && up) {
    el.textContent = `${down}${ud}/${up}${uu}`;
    el.style.color = 'var(--primary)';
  } else {
    el.textContent = '— (isi kecepatan download & upload)';
    el.style.color = 'var(--text-dim)';
  }
}

function cancelForm() {
  editingNama = null;
  closeModalForm();
}

function editProfile(p) {
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { return; } }
  showForm(p);
}


// ── API CALLS ──────────────────────────────────────────────────
async function addProfile() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  const nama  = val('f-nama');
  const down  = val('f-rate-down');
  const ud    = val('f-unit-down') || 'M';
  const up    = val('f-rate-up');
  const uu    = val('f-unit-up') || 'M';
  const harga = val('f-harga');

  if (!nama)  { toast('Nama profile wajib diisi', 'warning'); return; }
  if (!down)  { toast('Kecepatan download wajib diisi', 'warning'); return; }
  if (!up)    { toast('Kecepatan upload wajib diisi', 'warning'); return; }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/api/profile/${deviceId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        nama,
        rate_down:   down,
        rate_unit_d: ud,
        rate_up:     up,
        rate_unit_u: uu,
        harga:       Number(harga) || 0,
        deskripsi:   val('f-deskripsi'),
        comment:     val('f-comment'),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
    cancelForm();
    toast(data.message || `Profile ${nama} berhasil ditambahkan`, 'success');
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Profile'; }
  }
}

async function saveEdit() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId || !editingNama) return;

  const nama  = val('f-nama');
  const down  = val('f-rate-down');
  const ud    = val('f-unit-down') || 'M';
  const up    = val('f-rate-up');
  const uu    = val('f-unit-up') || 'M';
  const harga = val('f-harga');

  if (!nama) { toast('Nama profile wajib diisi', 'warning'); return; }
  if (!down) { toast('Kecepatan download wajib diisi', 'warning'); return; }
  if (!up)   { toast('Kecepatan upload wajib diisi', 'warning'); return; }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(
      `${API_BASE}/api/profile/${deviceId}/${encodeURIComponent(editingNama)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        nama,
        rate_down:   down,
        rate_unit_d: ud,
        rate_up:     up,
        rate_unit_u: uu,
        harga:       Number(harga) || 0,
        deskripsi:   val('f-deskripsi'),
        comment:     val('f-comment'),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
    cancelForm();
    toast(data.message || `Profile ${nama} berhasil diperbarui`, 'success');
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}

function confirmDelete(nama) {
  const p = profiles.find(x => x.name === nama);
  const userWarn = p?.total_user > 0
    ? `<div style="background:var(--amber-bg);border:1px solid var(--amber-border);
         border-radius:var(--r-md);padding:10px 14px;margin-top:12px;font-size:12px;color:var(--amber);">
         <strong>⚠ Perhatian:</strong> Profile ini sedang digunakan oleh
         <strong>${p.total_user} pelanggan</strong>.
         Hapus akan gagal jika ada pelanggan aktif menggunakannya.
       </div>` : '';

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus Profile?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus profile <strong>${escHtml(nama)}</strong> dari MikroTik?
        Tindakan ini tidak dapat dibatalkan.
      </div>
      ${userWarn}
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete('${escHtml(nama)}')">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`);
}

async function doDelete(nama) {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) return;
  closeModalForm();
  try {
    const res  = await fetch(
      `${API_BASE}/api/profile/${deviceId}/${encodeURIComponent(nama)}`,
      { method: 'DELETE' }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus');
    toast(data.message || `Profile ${nama} dihapus`, 'danger');
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
  }
}