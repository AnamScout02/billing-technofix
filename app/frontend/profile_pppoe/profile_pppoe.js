/* ============================================================
   profile_pppoe.js — Manajemen PPPoE Profile MikroTik
   Requires: global.js (API_BASE, escHtml, val, animNum,
             toast, openModalForm, closeModalForm, togglePwd)

   Alur auto-select device:
   1. Baca ?device_id=<id> dari URL (dikirim oleh input_mikrotik.js)
   2. Fallback ke localStorage 'lastSelectedDevice'
   3. Hapus URL param setelah dibaca (history.replaceState)
   4. Set <select> → loadProfiles() otomatis
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let profiles    = [];      // data lengkap dari backend
let filtered    = [];      // setelah filter/search
let editingNama = null;
let deviceList  = [];


// ── FORMAT HELPERS ─────────────────────────────────────────────

function fmtRupiah(n) {
  if (!n && n !== 0) return '—';
  if (n === 0) return '—';
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

function speedColor(rateDown) {
  const n = parseInt(rateDown) || 0;
  if      (n >= 100) return { bg: 'var(--primary-light)', color: 'var(--primary)' };
  else if (n >= 50)  return { bg: 'var(--green-bg)',      color: 'var(--green)' };
  else if (n >= 20)  return { bg: 'var(--blue-bg)',       color: 'var(--blue)' };
  else               return { bg: 'var(--amber-bg)',      color: 'var(--amber)' };
}

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

function selectedDeviceName() {
  const sel = document.getElementById('select-device');
  if (!sel || !sel.value) return '';
  const opt = sel.querySelector(`option[value="${sel.value}"]`);
  return opt ? opt.textContent.trim() : '';
}


// ── INIT ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadDevices();
});


// ── LOAD PERANGKAT ─────────────────────────────────────────────

async function loadDevices() {
  try {
    const res  = await fetch(`${API_BASE}/devices`, {
      credentials: 'include',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    deviceList = Array.isArray(data) ? data : [];

    const sel = document.getElementById('select-device');
    sel.innerHTML = '<option value="">Pilih Perangkat</option>';
    deviceList.forEach(d => {
      const opt = new Option(
        `${d.name}  (${d.ip})${d.status !== 'connected' ? ' — Offline' : ''}`,
        d.id
      );
      if (d.status !== 'connected') opt.style.color = 'var(--text-dim)';
      sel.appendChild(opt);
    });

    // Prioritas: URL param → localStorage → auto-select jika hanya 1 perangkat
    const urlId    = getParam('device_id');
    const savedId  = localStorage.getItem('lastSelectedDevice');
    const targetId = urlId || savedId;

    if (targetId && deviceList.some(d => String(d.id) === String(targetId))) {
      sel.value = String(targetId);
      if (urlId) {
        const url = new URL(window.location.href);
        url.searchParams.delete('device_id');
        window.history.replaceState({}, '', url.toString());
      }
    } else if (deviceList.length === 1) {
      // Sama seperti pelanggan.js: auto-select jika hanya satu perangkat
      sel.value = String(deviceList[0].id);
    }

    updateBreadcrumb();

    // Muat profil jika ada perangkat terpilih
    if (sel.value) {
      loadProfiles();
    }

  } catch (e) {
    toast('Gagal memuat daftar perangkat', 'danger');
  }
}

function updateBreadcrumb() {
  const name = selectedDeviceName();
  const el   = document.getElementById('device-breadcrumb');
  if (!el) return;
  el.textContent = name
    ? `Perangkat aktif: ${name}`
    : 'Kelola paket kecepatan internet dan harga langsung dari MikroTik';
}

function onDeviceChange() {
  updateBreadcrumb();
  loadProfiles();
}


// ── LOAD PROFILES ──────────────────────────────────────────────

async function loadProfiles() {
  const deviceId = document.getElementById('select-device').value;

  if (!deviceId) {
    profiles = [];
    filtered = [];
    showState('empty');
    updateStats();
    return;
  }

  localStorage.setItem('lastSelectedDevice', deviceId);

  // Tampilkan loading — baris spinner di dalam tabel
  const tbodyLoading = document.getElementById('tbody-profile');
  if (tbodyLoading) {
    tbodyLoading.innerHTML = '<tr><td colspan="10"><div class="state-box"><div class="spinner"></div><p class="state-title">Mengambil data dari MikroTik...</p></div></td></tr>';
  }
  showState('loading');
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = 'spinAnim .7s linear infinite';

  setSyncStatus('loading');

  try {
    const res = await fetch(`${API_BASE}/api/profile/${deviceId}`, {
      credentials: 'include',
      headers: getAuthHeaders()
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    profiles = await res.json();
    filtered = [...profiles];
    renderTable();
    updateStats();
    setSyncStatus('ok');
    showState('table');

  } catch (e) {
    profiles = [];
    filtered = [];
    document.getElementById('error-msg').textContent = e.message;
    showState('error');
    setSyncStatus('error');
    toast(e.message, 'danger');

  } finally {
    if (icon) icon.style.animation = '';
  }
}


// ── STATE MANAGEMENT ───────────────────────────────────────────

function showState(state) {
  // state: 'loading' | 'empty' | 'error' | 'table'
  // 'loading' & 'table' sama-sama menampilkan tabel — saat loading, tbody
  // berisi baris spinner (lihat loadProfiles), lalu diisi data oleh renderTable().
  document.getElementById('state-empty').style.display   = state === 'empty'   ? 'flex' : 'none';
  document.getElementById('state-error').style.display   = state === 'error'   ? 'flex' : 'none';
  document.getElementById('table-scroll').style.display  = (state === 'table' || state === 'loading') ? 'block' : 'none';
  document.getElementById('table-footer').style.display  = state === 'table'   ? 'flex' : 'none';
}

function setSyncStatus(state) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  if (state === 'loading') {
    el.textContent = 'Memuat...';
    el.className = 'sync-badge syncing';
  } else if (state === 'ok') {
    el.textContent = 'Terhubung';
    el.className = 'sync-badge ok';
  } else if (state === 'error') {
    el.textContent = 'Gagal';
    el.className = 'sync-badge error';
  } else {
    el.textContent = '';
    el.className = 'sync-badge';
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
  if (elAvg) elAvg.textContent = avgHarga ? fmtRupiah(avgHarga) : '—';
}


// ── FILTER / SEARCH ────────────────────────────────────────────

function filterProfiles() {
  const q        = (document.getElementById('input-search')?.value || '').toLowerCase();
  const fPengg   = document.getElementById('filter-pengguna')?.value || '';

  filtered = profiles.filter(p => {
    const matchQ = !q
      || p.name.toLowerCase().includes(q)
      || (p.rate_down || '').toLowerCase().includes(q)
      || (p.rate_up   || '').toLowerCase().includes(q)
      || (p.deskripsi || '').toLowerCase().includes(q);

    const matchP = !fPengg
      || (fPengg === 'aktif'  && p.total_user > 0)
      || (fPengg === 'kosong' && p.total_user === 0);

    return matchQ && matchP;
  });

  renderTable();
}


// ── RENDER TABLE ───────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById('tbody-profile');
  const cnt   = document.getElementById('profile-count');
  const ftCnt = document.getElementById('footer-count');
  const ftDev = document.getElementById('footer-device');

  // Urutkan: pengguna terbanyak dulu, lalu alfabet
  const sorted = [...filtered].sort((a, b) =>
    (b.total_user - a.total_user) || a.name.localeCompare(b.name)
  );

  if (cnt)   cnt.textContent   = `${sorted.length} profile`;
  if (ftCnt) ftCnt.textContent = `${sorted.length} dari ${profiles.length} profile`;
  if (ftDev) ftDev.textContent = selectedDeviceName();

  if (!sorted.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:32px;color:var(--text-dim)">
          <span class="material-symbols-outlined" style="font-size:32px;display:block;margin-bottom:8px">search_off</span>
          Tidak ada profile yang cocok
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((p, idx) => {
    const sc       = speedColor(p.rate_down);
    const isUnlim  = p.rate_down === 'unlimited';
    const hasUser  = p.total_user > 0;
    const pJson    = escHtml(JSON.stringify(p));
    const deviceId = document.getElementById('select-device').value;

    return `
      <tr>
        <td class="sticky-col-0" style="color:var(--text-dim);font-size:11px">${idx + 1}</td>

        <td class="sticky-col-1">
          <span class="badge-profil">${escHtml(p.name)}</span>
          ${p.comment ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">${escHtml(p.comment)}</div>` : ''}
        </td>

        <td>
          <span class="speed-badge"
                style="background:${sc.bg};color:${sc.color}">
            <span class="material-symbols-outlined" style="font-size:12px">arrow_downward</span>
            ${escHtml(p.rate_down)}${isUnlim ? '' : 'ps'}
          </span>
        </td>

        <td>
          <span class="speed-badge"
                style="background:${sc.bg};color:${sc.color}">
            <span class="material-symbols-outlined" style="font-size:12px">arrow_upward</span>
            ${escHtml(p.rate_up)}${p.rate_up === 'unlimited' ? '' : 'ps'}
          </span>
        </td>

        <td style="font-size:11px;color:var(--text-muted);font-family:var(--sans);font-weight:600">
          ${p.rate_limit ? escHtml(p.rate_limit) : '—'}
        </td>

        <td style="text-align:center">
          ${hasUser
            ? `<span class="badge connected"><span class="badge-dot"></span>${p.total_user}</span>`
            : `<span class="badge pending"><span class="badge-dot"></span>0</span>`}
        </td>

        <!-- Harga — inline editable -->
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <input type="number"
                   class="inline-input"
                   data-perm="perangkat_manage"
                   id="harga-${escHtml(p.name)}"
                   value="${p.harga || ''}"
                   placeholder="0"
                   min="0"
                   style="width:110px"
                   onchange="saveLocalData('${escHtml(p.name)}', ${deviceId})"
                   title="Ketik harga lalu tekan Enter atau klik di luar">
          </div>
          ${p.harga > 0
            ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">${fmtRupiah(p.harga)}/bln</div>`
            : ''}
        </td>

        <!-- Catatan Bandwidth -->
        <td class="col-catatan">
          <input type="text"
                 class="inline-input"
                 data-perm="perangkat_manage"
                 id="bwnote-${escHtml(p.name)}"
                 value="${escHtml(p.bandwidth_note || '')}"
                 placeholder="Catatan teknis..."
                 style="min-width:130px"
                 onchange="saveLocalData('${escHtml(p.name)}', ${deviceId})">
        </td>

        <!-- Deskripsi -->
        <td class="col-note">
          <input type="text"
                 class="inline-input"
                 data-perm="perangkat_manage"
                 id="desk-${escHtml(p.name)}"
                 value="${escHtml(p.deskripsi || '')}"
                 placeholder="Keterangan..."
                 style="min-width:120px"
                 onchange="saveLocalData('${escHtml(p.name)}', ${deviceId})">
        </td>

        <!-- Aksi -->
        <td class="td-actions">
          <div style="display:flex;gap:4px">
            <button class="btn-tbl edit" data-perm="perangkat_manage" onclick='editProfile(${pJson})' title="Edit di MikroTik">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="btn-tbl hapus" data-perm="perangkat_manage" onclick="confirmDelete('${escHtml(p.name)}')" title="Hapus">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  if (typeof applyUIPermissions === 'function') applyUIPermissions();
}


// ── INLINE SAVE — harga & catatan lokal ────────────────────────

async function saveLocalData(nama, deviceId) {
  const harga         = parseInt(document.getElementById(`harga-${nama}`)?.value)   || 0;
  const bandwidthNote = document.getElementById(`bwnote-${nama}`)?.value || '';
  const deskripsi     = document.getElementById(`desk-${nama}`)?.value   || '';

  try {
    const res = await fetch(`${API_BASE}/api/profile/${deviceId}/${encodeURIComponent(nama)}/local`, {
      method:      'PATCH',
      credentials: 'include',
      headers:     { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body:        JSON.stringify({ harga, bandwidth_note: bandwidthNote, deskripsi }),
    });

    if (!res.ok) throw new Error('Gagal menyimpan');

    // Update cache lokal tanpa reload penuh
    const p = profiles.find(x => x.name === nama);
    if (p) { p.harga = harga; p.bandwidth_note = bandwidthNote; p.deskripsi = deskripsi; }

    toast(`Data lokal "${nama}" tersimpan`, 'success');

  } catch (e) {
    toast('Gagal menyimpan data lokal: ' + e.message, 'danger');
  }
}


// ── FORM MODAL — Tambah / Edit Profile ─────────────────────────

function showForm(prefill = null) {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  editingNama  = prefill ? prefill.name : null;
  const isEdit = !!prefill;

  function parseRate(raw) {
    if (!raw || raw === 'unlimited') return { num: '', unit: 'M' };
    const m = String(raw).match(/^(\d+(?:\.\d+)?)(k|M|G)?$/i);
    return m ? { num: m[1], unit: (m[2] || 'M').toUpperCase() } : { num: raw, unit: 'M' };
  }

  const rd = parseRate(prefill?.rate_down);
  const ru = parseRate(prefill?.rate_up);
  const unitOpts = (sel) => ['k','M','G'].map(u =>
    `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}bps</option>`
  ).join('');

  const html = `
    <div class="form-modal">

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined" style="font-size:20px">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);letter-spacing:-.02em">
            ${isEdit ? `Edit Profile: ${escHtml(editingNama)}` : 'Tambah PPPoE Profile'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px">
            ${isEdit ? 'Perbarui di MikroTik &amp; database lokal secara bersamaan' : 'Ditulis langsung ke MikroTik — gagal konek = tidak ada data tersimpan'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label">Nama Profile <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="Contoh: Paket-10MB, GAMER-50M"
                 value="${isEdit ? escHtml(prefill.name) : ''}">
          <span class="form-hint">Nama ini langsung menjadi PPP Profile di MikroTik</span>
        </div>

        <div class="form-group">
          <label class="form-label">Download <span class="req">*</span></label>
          <div style="display:flex;gap:6px">
            <input class="form-input" type="number" id="f-rate-down"
                   placeholder="10" min="1" style="flex:1"
                   value="${rd.num}">
            <select class="form-input" id="f-unit-down" style="width:80px">${unitOpts(rd.unit)}</select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Upload <span class="req">*</span></label>
          <div style="display:flex;gap:6px">
            <input class="form-input" type="number" id="f-rate-up"
                   placeholder="5" min="1" style="flex:1"
                   value="${ru.num}">
            <select class="form-input" id="f-unit-up" style="width:80px">${unitOpts(ru.unit)}</select>
          </div>
        </div>

        <!-- Preview rate-limit -->
        <div class="form-group full">
          <div style="background:var(--surface);border:1px solid var(--border);
               border-radius:var(--r-md);padding:10px 14px;display:flex;align-items:center;gap:10px">
            <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px">cable</span>
            <div>
              <div style="font-size:11px;color:var(--text-dim)">Preview rate-limit MikroTik</div>
              <div style="font-size:13px;font-weight:700;color:var(--text)" id="rate-preview">—</div>
            </div>
          </div>
        </div>

        <!-- Separator -->
        <div class="form-group full" style="margin-top:4px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
               color:var(--text-dim);padding-bottom:8px;border-bottom:1px solid var(--border)">
            ✏ Data Lokal (tersimpan di database sistem)
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Harga Jual (Rp/bulan)</label>
          <input class="form-input" type="number" id="f-harga"
                 placeholder="150000" min="0"
                 value="${isEdit ? (prefill.harga || 0) : ''}">
        </div>

        <div class="form-group">
          <label class="form-label">Catatan Bandwidth</label>
          <input class="form-input" type="text" id="f-bandwidth-note"
                 placeholder="Garansi 5Mbps, burst 10Mbps..."
                 value="${isEdit ? escHtml(prefill.bandwidth_note || '') : ''}">
          <span class="form-hint">Tidak dikirim ke MikroTik</span>
        </div>

        <div class="form-group full">
          <label class="form-label">Deskripsi Internal</label>
          <input class="form-input" type="text" id="f-deskripsi"
                 placeholder="Cocok untuk 3-4 device, paket gaming..."
                 value="${isEdit ? escHtml(prefill.deskripsi || '') : ''}">
        </div>

        <div class="form-group full">
          <label class="form-label">Comment MikroTik</label>
          <input class="form-input" type="text" id="f-comment"
                 placeholder="Tampil di Winbox (opsional)"
                 value="${isEdit ? escHtml(prefill.comment || '') : ''}">
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

function cancelForm() { editingNama = null; closeModalForm(); }

function editProfile(p) {
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { return; } }
  showForm(p);
}


// ── API — Tambah Profile (Atomic) ──────────────────────────────

async function addProfile() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { toast('Pilih perangkat terlebih dahulu', 'warning'); return; }

  const nama  = val('f-nama');
  const down  = val('f-rate-down');
  const ud    = val('f-unit-down') || 'M';
  const up    = val('f-rate-up');
  const uu    = val('f-unit-up') || 'M';

  if (!nama) { toast('Nama profile wajib diisi', 'warning'); return; }
  if (!down) { toast('Kecepatan download wajib diisi', 'warning'); return; }
  if (!up)   { toast('Kecepatan upload wajib diisi', 'warning'); return; }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan ke MikroTik...'; }

  try {
    const res  = await fetch(`${API_BASE}/api/profile/${deviceId}`, {
      method:      'POST',
      credentials: 'include',
      headers:     { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:           nama,
        rate_down:      down,
        rate_unit_d:    ud,
        rate_up:        up,
        rate_unit_u:    uu,
        harga:          Number(val('f-harga')) || 0,
        bandwidth_note: val('f-bandwidth-note'),
        deskripsi:      val('f-deskripsi'),
        comment:        val('f-comment'),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(res.status === 502
        ? `Koneksi MikroTik gagal — tidak ada data tersimpan. ${data.error}`
        : (data.error || 'Gagal menyimpan'));
    }
    cancelForm();
    if (data.warning) {
      toast(data.warning, 'warning');
    } else {
      toast(data.message || `Profile ${nama} berhasil ditambahkan`, 'success');
    }
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah Profile'; }
  }
}


// ── API — Edit Profile (Atomic) ────────────────────────────────

async function saveEdit() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId || !editingNama) return;

  const nama = val('f-nama');
  const down = val('f-rate-down');
  const ud   = val('f-unit-down') || 'M';
  const up   = val('f-rate-up');
  const uu   = val('f-unit-up') || 'M';

  if (!nama) { toast('Nama profile wajib diisi', 'warning'); return; }
  if (!down) { toast('Kecepatan download wajib diisi', 'warning'); return; }
  if (!up)   { toast('Kecepatan upload wajib diisi', 'warning'); return; }

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(
      `${API_BASE}/api/profile/${deviceId}/${encodeURIComponent(editingNama)}`, {
      method:      'PUT',
      credentials: 'include',
      headers:     { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:           nama,
        rate_down:      down,
        rate_unit_d:    ud,
        rate_up:        up,
        rate_unit_u:    uu,
        harga:          Number(val('f-harga')) || 0,
        bandwidth_note: val('f-bandwidth-note'),
        deskripsi:      val('f-deskripsi'),
        comment:        val('f-comment'),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(res.status === 502
        ? `Koneksi MikroTik gagal — perubahan dibatalkan. ${data.error}`
        : (data.error || 'Gagal menyimpan'));
    }
    cancelForm();
    toast(data.message || `Profile ${nama} berhasil diperbarui`, 'success');
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}


// ── API — Hapus Profile ────────────────────────────────────────

function confirmDelete(nama) {
  const p = profiles.find(x => x.name === nama);
  const warn = p?.total_user > 0
    ? `<div style="background:var(--amber-bg);border:1px solid var(--amber-border);
         border-radius:var(--r-md);padding:10px 14px;margin-top:12px;font-size:12px;color:var(--amber)">
         <strong>⚠ Perhatian:</strong> Profile ini sedang digunakan oleh
         <strong>${p.total_user} pelanggan</strong>. Hapus akan gagal jika ada pelanggan aktif.
       </div>` : '';

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus Profile?</div>
      <div class="hapus-sub">
        Yakin hapus profile <strong>${escHtml(nama)}</strong> dari MikroTik?<br>
        Tindakan ini tidak dapat dibatalkan.
      </div>
      ${warn}
      <div class="modal-actions" style="margin-top:20px">
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
      { method: 'DELETE', credentials: 'include', headers: getAuthHeaders() }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal menghapus');
    toast(data.message || `Profile ${nama} dihapus`, 'danger');
    loadProfiles();
  } catch (e) {
    toast(e.message, 'danger');
  }
}