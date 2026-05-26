/* ============================================================
   input_odc.js — Manajemen ODC (Optical Distribution Cabinet)
   Requires: global.js (API_BASE, escHtml, val, animNum, toast,
             openModalForm, closeModalForm)

   Posisi di topologi jaringan fiber:
   OLT  →  ODC  →  ODP  →  Pelanggan

   Perbedaan ODC vs ODP:
   - ODC kapasitas lebih besar (8–64 port ke ODP)
   - ODC punya rasio splitter (1:8, 1:16, 1:32, 1:64)
   - ODC upstream ke OLT, downstream ke ODP
   - ODP upstream ke ODC, downstream ke pelanggan

   Fields ODC:
   - nama        : nama kabinet ODC (wajib)
   - kode        : kode unik, cth: ODC-BWI-001
   - olt_id      : OLT induk upstream
   - port_olt    : port OLT yang terhubung ke ODC
   - rasio_split : rasio splitter (8, 16, 32, 64)
   - kapasitas   : jumlah port downstream ke ODP (8, 16, 32, 64)
   - terpakai    : jumlah port ke ODP yang terpakai
   - odp_count   : jumlah ODP aktif terhubung ke ODC ini
   - lokasi      : alamat / koordinat
   - keterangan  : catatan tambahan
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let odcs      = [];
let editingId = null;
const STORE_KEY = 'technofix_odc_data';


// ── STORAGE HELPERS ─────────────────────────────────────────────
function _saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(odcs)); } catch (_) {}
}

function _loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    odcs = raw ? JSON.parse(raw) : [];
  } catch (_) { odcs = []; }
}

function _nextId() {
  return odcs.length ? Math.max(...odcs.map(x => x.id)) + 1 : 1;
}


// ── STATS ──────────────────────────────────────────────────────
function updateStats() {
  const total      = odcs.length;
  const terpakai   = odcs.reduce((s, o) => s + (Number(o.terpakai)  || 0), 0);
  const kapasitas  = odcs.reduce((s, o) => s + (Number(o.kapasitas) || 0), 0);
  const sisa       = Math.max(0, kapasitas - terpakai);
  const totalOdp   = odcs.reduce((s, o) => s + (Number(o.odp_count) || 0), 0);

  animNum('stat-total', total);
  animNum('stat-aktif', terpakai);
  animNum('stat-sisa',  sisa);
  animNum('stat-odp',   totalOdp);

  const el = document.getElementById('device-count');
  if (el) el.textContent = `${total} kabinet ODC`;
}


// ── RENDER LIST ─────────────────────────────────────────────────
function renderOdc() {
  const container = document.getElementById('device-list');
  if (!container) return;

  if (!odcs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--text-dim);">account_tree</span>
        <p style="font-weight:700;color:var(--text);">Belum ada ODC terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted);">
          Klik <strong>Tambah ODC</strong> untuk mulai mendaftarkan kabinet distribusi.
        </p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = odcs.map((o, idx) => {
    const kapasitas = Number(o.kapasitas) || 0;
    const terpakai  = Number(o.terpakai)  || 0;
    const sisa      = kapasitas - terpakai;
    const persen    = kapasitas > 0 ? Math.round((terpakai / kapasitas) * 100) : 0;
    const barColor  = persen >= 90 ? 'var(--red)' : persen >= 70 ? 'var(--amber)' : 'var(--green)';

    return `
      <div class="device-card" id="card-${o.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon" style="background:var(--primary-light);color:var(--primary);">
          <span class="material-symbols-outlined">account_tree</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(o.nama)}</span>
            ${o.kode ? `<span class="device-tipe-badge">${escHtml(o.kode)}</span>` : ''}
            ${o.rasio_split ? `<span class="device-tipe-badge">1:${escHtml(String(o.rasio_split))}</span>` : ''}
            <span class="badge ${sisa > 0 ? 'connected' : 'failed'}">
              <span class="badge-dot"></span>
              ${sisa > 0 ? `${sisa} port tersedia` : 'Port penuh'}
            </span>
          </div>

          <div class="device-meta">
            ${o.olt_nama ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">settings_input_antenna</span>
              OLT: ${escHtml(o.olt_nama)}
            </span>` : ''}
            ${o.port_olt ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">cable</span>
              Port OLT: ${escHtml(o.port_olt)}
            </span>` : ''}
            <span class="device-meta-item">
              <span class="material-symbols-outlined">lan</span>
              ${terpakai}/${kapasitas} port ke ODP
            </span>
            ${o.odp_count ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">hub</span>
              ${escHtml(String(o.odp_count))} ODP terhubung
            </span>` : ''}
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
          <button class="btn btn-amber btn-sm" onclick="editOdc(${o.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDeleteOdc(${o.id})" title="Hapus ODC">
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
    <div class="form-modal" style="width:560px;">

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
            ${isEdit ? 'Edit ODC' : 'Tambah ODC Baru'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit
              ? 'Perbarui data Optical Distribution Cabinet'
              : 'Daftarkan kabinet distribusi fiber baru ke sistem'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group">
          <label class="form-label">Nama ODC <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="cth: ODC-Jl-Merdeka-01" value="${v('nama')}">
        </div>

        <div class="form-group">
          <label class="form-label">Kode ODC</label>
          <input class="form-input" type="text" id="f-kode"
                 placeholder="cth: ODC-BWI-001" value="${v('kode')}">
        </div>

        <div class="form-group full">
          <label class="form-label">OLT Induk (Upstream)</label>
          <select class="form-input" id="f-olt">
            <option value="">— Pilih OLT Induk —</option>
          </select>
          <span class="form-hint">OLT yang menjadi sumber sinyal untuk ODC ini</span>
        </div>

        <div class="form-group">
          <label class="form-label">Port OLT</label>
          <input class="form-input" type="text" id="f-port-olt"
                 placeholder="cth: 0/1/1" value="${v('port_olt')}">
          <span class="form-hint">Port pada OLT yang terhubung ke ODC ini</span>
        </div>

        <div class="form-group">
          <label class="form-label">Rasio Splitter</label>
          <select class="form-input" id="f-rasio">
            <option value=""  ${!v('rasio_split')         ? 'selected' : ''}>— Pilih rasio —</option>
            <option value="8" ${v('rasio_split') === '8'  ? 'selected' : ''}>1 : 8</option>
            <option value="16"${v('rasio_split') === '16' ? 'selected' : ''}>1 : 16</option>
            <option value="32"${v('rasio_split') === '32' ? 'selected' : ''}>1 : 32</option>
            <option value="64"${v('rasio_split') === '64' ? 'selected' : ''}>1 : 64</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Kapasitas Port ke ODP <span class="req">*</span></label>
          <select class="form-input" id="f-kapasitas">
            <option value="8"  ${!prefill || v('kapasitas') === '8'  ? 'selected' : ''}>8 port</option>
            <option value="16" ${v('kapasitas') === '16' ? 'selected' : ''}>16 port</option>
            <option value="32" ${v('kapasitas') === '32' ? 'selected' : ''}>32 port</option>
            <option value="64" ${v('kapasitas') === '64' ? 'selected' : ''}>64 port</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Port Terpakai (ke ODP)</label>
          <input class="form-input" type="number" id="f-terpakai"
                 placeholder="0" min="0" value="${v('terpakai') || '0'}">
        </div>

        <div class="form-group">
          <label class="form-label">Jumlah ODP Terhubung</label>
          <input class="form-input" type="number" id="f-odp-count"
                 placeholder="0" min="0" value="${v('odp_count') || '0'}">
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
                    placeholder="Catatan tambahan tentang ODC ini...">${prefill ? escHtml(prefill.keterangan || '') : ''}</textarea>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addOdc()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah ODC'}
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

function editOdc(id) {
  const o = odcs.find(x => x.id === id);
  if (o) showForm(o);
}


// ── CRUD ─────────────────────────────────────────────────────────
function addOdc() {
  const nama       = val('f-nama');
  const kode       = val('f-kode');
  const oltId      = val('f-olt');
  const portOlt    = val('f-port-olt');
  const rasio      = val('f-rasio');
  const kapasitas  = val('f-kapasitas');
  const terpakai   = val('f-terpakai')   || '0';
  const odpCount   = val('f-odp-count')  || '0';
  const lokasi     = val('f-lokasi');
  const keterangan = val('f-keterangan');

  if (!nama)      { toast('Nama ODC wajib diisi', 'warning'); return; }
  if (!kapasitas) { toast('Kapasitas port wajib dipilih', 'warning'); return; }
  if (Number(terpakai) > Number(kapasitas)) {
    toast('Port terpakai tidak boleh melebihi kapasitas', 'warning'); return;
  }

  const oltSel  = document.getElementById('f-olt');
  const oltNama = oltSel?.options[oltSel.selectedIndex]?.text || '';

  odcs.push({
    id: _nextId(),
    nama, kode,
    olt_id: oltId, olt_nama: oltNama,
    port_olt: portOlt,
    rasio_split: rasio,
    kapasitas: Number(kapasitas),
    terpakai:  Number(terpakai),
    odp_count: Number(odpCount),
    lokasi, keterangan,
    created_at: new Date().toISOString(),
  });

  _saveLocal();
  cancelForm();
  renderOdc();
  toast(`ODC "${nama}" berhasil ditambahkan`, 'success');
}

function saveEdit() {
  const o = odcs.find(x => x.id === editingId);
  if (!o) return;

  const nama      = val('f-nama');
  const kapasitas = Number(val('f-kapasitas')) || 0;
  const terpakai  = Number(val('f-terpakai'))  || 0;

  if (!nama) { toast('Nama ODC wajib diisi', 'warning'); return; }
  if (terpakai > kapasitas) {
    toast('Port terpakai tidak boleh melebihi kapasitas', 'warning'); return;
  }

  const oltSel  = document.getElementById('f-olt');
  const oltNama = oltSel?.options[oltSel.selectedIndex]?.text || '';

  Object.assign(o, {
    nama, kode: val('f-kode'),
    olt_id: val('f-olt'), olt_nama: oltNama,
    port_olt: val('f-port-olt'),
    rasio_split: val('f-rasio'),
    kapasitas, terpakai,
    odp_count: Number(val('f-odp-count')) || 0,
    lokasi: val('f-lokasi'),
    keterangan: val('f-keterangan'),
    updated_at: new Date().toISOString(),
  });

  _saveLocal();
  cancelForm();
  renderOdc();
  toast(`ODC "${nama}" berhasil diperbarui`, 'success');
}

function confirmDeleteOdc(id) {
  const o = odcs.find(x => x.id === id);
  if (!o) return;

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus ODC?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(o.nama)}</strong>?<br>
        Semua ODP yang upstream ke ODC ini perlu dikonfigurasi ulang.
        Data ini tidak dapat dikembalikan.
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDeleteOdc(${id})">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`);
}

function doDeleteOdc(id) {
  const o = odcs.find(x => x.id === id);
  odcs = odcs.filter(x => x.id !== id);
  _saveLocal();
  closeModalForm();
  renderOdc();
  toast(`ODC "${o?.nama || ''}" berhasil dihapus`, 'danger');
}


// ── SYNC ─────────────────────────────────────────────────────────
function syncAll() {
  toast('Sinkronisasi ODC ke backend akan segera tersedia', 'info');
}


// ── INIT ─────────────────────────────────────────────────────────
_loadLocal();
renderOdc();