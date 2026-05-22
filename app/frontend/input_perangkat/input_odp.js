/* ============================================================
   input_odp.js — Manajemen ODP (Optical Distribution Point)
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, animNum, toast,
              openModalForm, closeModalForm, statusInfo)

   Endpoint (backend belum ada — menggunakan localStorage
   sebagai penyimpanan sementara sampai endpoint /odp dibuat):
   Saat backend endpoint /odp tersedia, ganti _loadLocal()
   dengan fetch(`${API_BASE}/odp`) dan sesuaikan fungsi lainnya.

   Fields ODP:
   - nama        : nama titik ODP (wajib)
   - kode        : kode unik ODP, cth: ODP-BWI-001
   - olt_id      : OLT induk
   - port_olt    : port OLT yang terhubung ke ODP ini
   - kapasitas   : jumlah port total (2, 4, 8, 16)
   - terpakai    : jumlah port yang sudah digunakan
   - lokasi      : alamat / koordinat
   - keterangan  : catatan tambahan
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let odps      = [];
let editingId = null;
const STORE_KEY = 'technofix_odp_data';


// ── STORAGE HELPERS (sementara pakai localStorage) ──────────────
function _saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(odps)); } catch (_) {}
}

function _loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    odps = raw ? JSON.parse(raw) : [];
  } catch (_) {
    odps = [];
  }
}

function _nextId() {
  return odps.length ? Math.max(...odps.map(x => x.id)) + 1 : 1;
}


// ── STATS ──────────────────────────────────────────────────────
function updateStats() {
  const total    = odps.length;
  const terpakai = odps.reduce((s, o) => s + (Number(o.terpakai) || 0), 0);
  const kapasitas = odps.reduce((s, o) => s + (Number(o.kapasitas) || 0), 0);
  const sisa     = kapasitas - terpakai;

  animNum('stat-total', total);
  animNum('stat-aktif', terpakai);
  animNum('stat-sisa',  sisa < 0 ? 0 : sisa);

  const el = document.getElementById('device-count');
  if (el) el.textContent = `${total} titik ODP`;
}


// ── RENDER ──────────────────────────────────────────────────────
function renderOdp() {
  const container = document.getElementById('device-list');
  if (!container) return;

  if (!odps.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--text-dim);">hub</span>
        <p style="font-weight:700;color:var(--text);">Belum ada ODP terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted);">Klik <strong>Tambah ODP</strong> untuk mulai mendaftarkan titik distribusi.</p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = odps.map((o, idx) => {
    const kapasitas = Number(o.kapasitas) || 0;
    const terpakai  = Number(o.terpakai)  || 0;
    const sisa      = kapasitas - terpakai;
    const persen    = kapasitas > 0 ? Math.round((terpakai / kapasitas) * 100) : 0;
    const barColor  = persen >= 90 ? 'var(--red)' : persen >= 70 ? 'var(--amber)' : 'var(--green)';

    return `
      <div class="device-card" id="card-${o.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon" style="background:var(--primary-light);">
          <span class="material-symbols-outlined">hub</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(o.nama)}</span>
            ${o.kode ? `<span class="device-tipe-badge">${escHtml(o.kode)}</span>` : ''}
            <span class="badge ${sisa > 0 ? 'connected' : 'failed'}">
              <span class="badge-dot"></span>
              ${sisa > 0 ? `${sisa} port tersisa` : 'Penuh'}
            </span>
          </div>

          <div class="device-meta">
            ${o.olt_nama ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">settings_input_antenna</span>
              ${escHtml(o.olt_nama)}
            </span>` : ''}
            ${o.port_olt ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">cable</span>
              Port ${escHtml(o.port_olt)}
            </span>` : ''}
            <span class="device-meta-item">
              <span class="material-symbols-outlined">fiber_manual_record</span>
              ${terpakai}/${kapasitas} port
            </span>
            ${o.lokasi ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">location_on</span>
              ${escHtml(o.lokasi)}
            </span>` : ''}
          </div>

          <!-- Progress bar penggunaan port -->
          <div style="margin-top:8px;display:flex;align-items:center;gap:8px;">
            <div style="flex:1;height:5px;background:var(--border);border-radius:99px;overflow:hidden;">
              <div style="width:${persen}%;height:100%;background:${barColor};border-radius:99px;
                   transition:width .4s ease;"></div>
            </div>
            <span style="font-size:11px;font-weight:700;color:${barColor};flex-shrink:0;">${persen}%</span>
          </div>

          ${o.keterangan ? `<p class="device-keterangan">${escHtml(o.keterangan)}</p>` : ''}
        </div>

        <div class="device-actions">
          <button class="btn btn-amber btn-sm" onclick="editOdp(${o.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDeleteOdp(${o.id})" title="Hapus">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── LOAD OLT OPTIONS ─────────────────────────────────────────────
async function loadOltOptions(selectedId) {
  const sel = document.getElementById('f-olt');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Pilih OLT Induk —</option>';
  try {
    const res  = await fetch(`${API_BASE}/olt`);
    if (!res.ok) return;
    const data = await res.json();
    data.forEach(olt => {
      const opt = new Option(`${olt.name} (${olt.ip})`, olt.id);
      if (String(olt.id) === String(selectedId)) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch (_) {}
}


// ── FORM MODAL ───────────────────────────────────────────────────
function showForm(prefill = null) {
  editingId    = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(String(prefill[k] || '')) : '';

  const html = `
    <div class="form-modal" style="width:540px;">

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
            ${isEdit ? 'Edit ODP' : 'Tambah ODP Baru'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit ? 'Perbarui data titik distribusi' : 'Daftarkan Optical Distribution Point baru'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group">
          <label class="form-label">Nama ODP <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="cth: ODP-Jl-Merdeka-01" value="${v('nama')}">
        </div>

        <div class="form-group">
          <label class="form-label">Kode ODP</label>
          <input class="form-input" type="text" id="f-kode"
                 placeholder="cth: ODP-BWI-001" value="${v('kode')}">
        </div>

        <div class="form-group full">
          <label class="form-label">OLT Induk</label>
          <select class="form-input" id="f-olt">
            <option value="">— Pilih OLT Induk —</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Port OLT</label>
          <input class="form-input" type="text" id="f-port-olt"
                 placeholder="cth: 0/1/1" value="${v('port_olt')}">
          <span class="form-hint">Port pada OLT yang terhubung ke ODP ini</span>
        </div>

        <div class="form-group">
          <label class="form-label">Kapasitas Port <span class="req">*</span></label>
          <select class="form-input" id="f-kapasitas">
            <option value="2"  ${v('kapasitas') === '2'  ? 'selected' : ''}>2 port</option>
            <option value="4"  ${v('kapasitas') === '4'  ? 'selected' : ''}>4 port</option>
            <option value="8"  ${!prefill || v('kapasitas') === '8'  ? 'selected' : ''}>8 port</option>
            <option value="16" ${v('kapasitas') === '16' ? 'selected' : ''}>16 port</option>
            <option value="32" ${v('kapasitas') === '32' ? 'selected' : ''}>32 port</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Port Terpakai</label>
          <input class="form-input" type="number" id="f-terpakai"
                 placeholder="0" min="0" value="${v('terpakai') || '0'}">
        </div>

        <div class="form-group full">
          <label class="form-label">Lokasi / Koordinat</label>
          <input class="form-input" type="text" id="f-lokasi"
                 placeholder="cth: Jl. Merdeka No.12, Banyuwangi / -8.2678, 114.3692"
                 value="${v('lokasi')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Keterangan</label>
          <textarea class="form-input" id="f-keterangan" rows="2"
                    placeholder="Catatan tambahan tentang ODP ini...">${prefill ? escHtml(prefill.keterangan || '') : ''}</textarea>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addOdp()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah ODP'}
        </button>
      </div>

    </div>`;

  openModalForm(html);

  requestAnimationFrame(async () => {
    await loadOltOptions(prefill?.olt_id || '');
    document.getElementById('f-nama')?.focus();
  });
}

function cancelForm() {
  editingId = null;
  closeModalForm();
}

function editOdp(id) {
  const o = odps.find(x => x.id === id);
  if (o) showForm(o);
}


// ── CRUD ─────────────────────────────────────────────────────────
function addOdp() {
  const nama      = val('f-nama');
  const kode      = val('f-kode');
  const oltId     = val('f-olt');
  const portOlt   = val('f-port-olt');
  const kapasitas = val('f-kapasitas');
  const terpakai  = val('f-terpakai') || '0';
  const lokasi    = val('f-lokasi');
  const keterangan = val('f-keterangan');

  if (!nama) { toast('Nama ODP wajib diisi', 'warning'); return; }
  if (!kapasitas) { toast('Kapasitas port wajib dipilih', 'warning'); return; }
  if (Number(terpakai) > Number(kapasitas)) {
    toast('Port terpakai tidak bisa melebihi kapasitas', 'warning'); return;
  }

  // Ambil nama OLT dari select
  const oltSel   = document.getElementById('f-olt');
  const oltNama  = oltSel?.options[oltSel.selectedIndex]?.text || '';

  const newOdp = {
    id: _nextId(),
    nama, kode, olt_id: oltId, olt_nama: oltNama,
    port_olt: portOlt, kapasitas: Number(kapasitas),
    terpakai: Number(terpakai), lokasi, keterangan,
    created_at: new Date().toISOString(),
  };

  odps.push(newOdp);
  _saveLocal();
  cancelForm();
  renderOdp();
  toast(`ODP ${nama} berhasil ditambahkan`, 'success');
}

function saveEdit() {
  const o = odps.find(x => x.id === editingId);
  if (!o) return;

  const nama       = val('f-nama');
  const kapasitas  = Number(val('f-kapasitas')) || 0;
  const terpakai   = Number(val('f-terpakai'))  || 0;

  if (!nama) { toast('Nama ODP wajib diisi', 'warning'); return; }
  if (terpakai > kapasitas) { toast('Port terpakai melebihi kapasitas', 'warning'); return; }

  const oltSel  = document.getElementById('f-olt');
  const oltNama = oltSel?.options[oltSel.selectedIndex]?.text || '';

  Object.assign(o, {
    nama, kode: val('f-kode'),
    olt_id: val('f-olt'), olt_nama: oltNama,
    port_olt: val('f-port-olt'), kapasitas,
    terpakai, lokasi: val('f-lokasi'),
    keterangan: val('f-keterangan'),
    updated_at: new Date().toISOString(),
  });

  _saveLocal();
  cancelForm();
  renderOdp();
  toast(`ODP ${nama} berhasil diperbarui`, 'success');
}

function confirmDeleteOdp(id) {
  const o = odps.find(x => x.id === id);
  if (!o) return;

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus ODP?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(o.nama)}</strong>?<br>
        Data ini akan dihapus dari sistem secara permanen.
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDeleteOdp(${id})">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`);
}

function doDeleteOdp(id) {
  odps = odps.filter(x => x.id !== id);
  _saveLocal();
  closeModalForm();
  renderOdp();
  toast('ODP berhasil dihapus', 'danger');
}


// ── SYNC ALL (placeholder — hubungkan ke API saat backend siap) ──
function syncAll() {
  toast('Fitur sinkronisasi ODP ke backend akan segera tersedia', 'info');
}


// ── INIT ─────────────────────────────────────────────────────────
_loadLocal();
renderOdp();