/* ============================================================
   input_odc.js — Manajemen ODC (Optical Distribution Cabinet)
   v2.0 — Migrasi dari localStorage ke backend API
   Requires: global.js (API_BASE, escHtml, val, animNum,
             toast, openModalForm, closeModalForm)

   Endpoint backend (odc.py):
   GET    /api/odc          → daftar semua ODC
   POST   /api/odc          → tambah ODC
   PUT    /api/odc/<id>     → edit ODC
   DELETE /api/odc/<id>     → hapus ODC
   ============================================================ */

'use strict';

let _allData      = [];
let _editingId = null;


// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadOdc();
});


// ── LOAD ─────────────────────────────────────────────────────
async function loadOdc() {
  showLoading();
  try {
    const res  = await fetch(`${API_BASE}/api/odc`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    _allData = Array.isArray(data) ? data : [];
    renderOdc();
  } catch (e) {
    document.getElementById('odc-list').innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--red)">wifi_off</span>
        <p style="font-weight:600;color:var(--text)">Tidak bisa terhubung ke server</p>
        <p style="font-size:12px;color:var(--text-muted)">Pastikan backend Flask sudah berjalan.</p>
      </div>`;
    updateStats();
  }
}

function syncAll() { loadOdc(); }

function showLoading() {
  document.getElementById('odc-list').innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined spin" style="font-size:32px">refresh</span>
      <p>Memuat data ODC...</p>
    </div>`;
}


// ── STATS ─────────────────────────────────────────────────────
function updateStats() {
  const totalPort   = _allData.reduce((s, o) => s + (Number(o.jumlah_port) || 0), 0);
  const totalOdp    = _allData.reduce((s, o) => s + (Number(o.jumlah_odp)  || 0), 0);

  animNum('stat-total',     _allData.length);
  animNum('stat-port-total', totalPort);
  animNum('stat-odp-total',  totalOdp);

  const cnt = document.getElementById('odc-count');
  if (cnt) cnt.textContent = `${_allData.length} Perangkat ODC`;
}


// ── RENDER ────────────────────────────────────────────────────
function renderOdc() {
  const container = document.getElementById('odc-list');
  if (!container) return;

  if (!_allData.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--text-dim)">account_tree</span>
        <p style="font-weight:700;color:var(--text)">Belum ada ODC terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted)">
          Klik <strong>Tambah</strong> untuk mulai mendaftarkan kabinet distribusi.
        </p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = _allData.map((o, idx) => {
    const kapasitas = Number(o.jumlah_port) || 0;
    const odp       = Number(o.jumlah_odp)  || 0;
    const persen    = kapasitas > 0 ? Math.min(100, Math.round((odp / kapasitas) * 100)) : 0;
    const barColor  = persen >= 90 ? 'var(--red)' : persen >= 70 ? 'var(--amber)' : 'var(--green)';
    const sisa      = kapasitas - odp;
    const koordinat = o.koordinat || '';

    return `
      <div class="device-card" id="card-${o.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon" style="background:var(--blue-bg);color:var(--blue)">
          <span class="material-symbols-outlined">account_tree</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(o.nama)}</span>
            ${o.tipe_kabel ? `<span class="device-tipe-badge">${escHtml(o.tipe_kabel)}</span>` : ''}
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
            <span class="device-meta-item">
              <span class="material-symbols-outlined">hub</span>
              ${odp}/${kapasitas} port → ${odp} ODP
            </span>
            ${o.lokasi ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">place</span>
              ${escHtml(o.lokasi)}
            </span>` : ''}
          </div>

          <!-- Progress bar -->
          <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:5px;background:var(--border);border-radius:99px;overflow:hidden">
              <div style="width:${persen}%;height:100%;background:${barColor};border-radius:99px;transition:width .4s"></div>
            </div>
            <span style="font-size:11px;font-weight:700;color:${barColor};flex-shrink:0">${persen}%</span>
          </div>

          ${koordinat ? `
          <div class="device-profile-row" style="margin-top:6px">
            <a href="https://www.google.com/maps?q=${encodeURIComponent(koordinat)}"
               target="_blank" class="koordinat-badge">
              <span class="material-symbols-outlined">location_on</span>
              ${escHtml(koordinat)}
            </a>
          </div>` : ''}

          ${o.keterangan ? `<p class="device-keterangan">${escHtml(o.keterangan)}</p>` : ''}
        </div>

        <div class="device-actions">
          ${(typeof hasPerm === 'function' ? hasPerm('perangkat_manage') : true) ? `
          <button class="btn btn-amber btn-sm" onclick="editOdc(${o.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${o.id})" title="Hapus ODC">
            <span class="material-symbols-outlined">delete</span>
          </button>` : ''}
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── FORM MODAL ────────────────────────────────────────────────
async function showForm(prefill = null) {
  _editingId    = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(String(prefill[k] || '')) : '';

  // Load opsi OLT
  let oltOptions = '<option value="">Tidak terhubung</option>';
  try {
    const res  = await fetch(`${API_BASE}/olt`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    oltOptions += data.map(o =>
      `<option value="${o.id}" ${prefill?.olt_id == o.id ? 'selected' : ''}>
        ${escHtml(o.name)} (${escHtml(o.ip)})
      </option>`
    ).join('');
  } catch (_) {}

  const html = `
    <div class="form-modal" style="width:560px">

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--blue-bg);color:var(--blue);
             display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined" style="font-size:20px">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text)">
            ${isEdit ? 'Edit ODC' : 'Tambah ODC'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px">
            Optical Distribution Cabinet
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label">Nama ODC <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="Contoh: ODC-Pusat-01" value="${v('nama')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Jumlah Port (Kapasitas) <span class="req">*</span></label>
          <select class="form-input" id="f-jumlah-port">
            ${[4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 144, 288].map(n =>
              `<option value="${n}" ${(prefill?.jumlah_port ?? 8) == n ? 'selected' : ''}>${n} port</option>`
            ).join('')}
          </select>
        </div>

        <div class="form-group full">
          <label class="form-label">Relasi ke OLT</label>
          <select class="form-input" id="f-olt-id">${oltOptions}</select>
        </div>

        <div class="form-group full">
          <label class="form-label">
            <span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle;color:var(--primary)">location_on</span>
            Titik Koordinat
            <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:4px">(untuk Maps)</span>
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
          <span class="form-hint">Format: latitude, longitude</span>
          <div class="koordinat-preview" id="koordinat-preview">
            <iframe id="koordinat-iframe" src="" loading="lazy"></iframe>
          </div>
        </div>

        <div class="form-group full">
          <label class="form-label">Lokasi (alamat singkat, opsional)</label>
          <input class="form-input" type="text" id="f-lokasi"
                 placeholder="mis. Tiang depan Ruko Blok A No. 3" value="${v('lokasi')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Keterangan (opsional)</label>
          <textarea class="form-input" id="f-keterangan" rows="3"
                    placeholder="Catatan tambahan tentang ODC ini">${v('keterangan')}</textarea>
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
  requestAnimationFrame(() => {
    document.getElementById('f-nama')?.focus();
    if (isEdit && prefill?.koordinat) previewKoordinat();
  });
}

function cancelForm() { _editingId = null; closeModalForm(); }

function editOdc(id) {
  const o = _allData.find(x => x.id === id);
  if (o) showForm(o);
}


// ── KOORDINAT HELPERS ─────────────────────────────────────────
function deteksiLokasi() { geoDetectKoordinat(); }  /* pakai fungsi bersama di global.js */

function previewKoordinat() {
  const raw     = (document.getElementById('f-koordinat')?.value || '').trim();
  const preview = document.getElementById('koordinat-preview');
  const iframe  = document.getElementById('koordinat-iframe');
  if (!preview || !iframe) return;
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
    iframe.src = `https://maps.google.com/maps?q=${parseFloat(parts[0])},${parseFloat(parts[1])}&z=15&output=embed`;
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
    iframe.src = '';
  }
}


// ── API CALLS ─────────────────────────────────────────────────
async function addOdc() {
  const payload = collectForm();
  if (!payload) return;

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/api/odc`, {
      method: 'POST', credentials: 'include', headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      cancelForm();
      toast(`ODC ${payload.nama} berhasil ditambahkan`, 'success');
      loadOdc();
    } else {
      toast(data.error || 'Gagal menyimpan ODC', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah ODC'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah ODC'; }
  }
}

async function saveEdit() {
  const payload = collectForm();
  if (!payload) return;

  const btn = document.getElementById('btn-submit-form');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/api/odc/${_editingId}`, {
      method: 'PUT', credentials: 'include', headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      cancelForm();
      toast('ODC berhasil diperbarui', 'success');
      loadOdc();
    } else {
      toast(data.error || 'Gagal memperbarui', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}

function collectForm() {
  const nama = val('f-nama');
  if (!nama) { toast('Nama ODC wajib diisi', 'warning'); return null; }
  return {
    nama,
    lokasi:      val('f-lokasi'),
    jumlah_port: parseInt(val('f-jumlah-port')) || 0,
    olt_id:      val('f-olt-id') || null,
    koordinat:   val('f-koordinat'),
    keterangan:  val('f-keterangan'),
  };
}

function confirmDelete(id) {
  const o = _allData.find(x => x.id === id);
  if (!o) return;

  const hasOdp    = Number(o.jumlah_odp) > 0;

  // Jika masih ada ODP → blok hapus sepenuhnya, bukan hanya warning
  const warnBlock = hasOdp
    ? `<div style="background:var(--red-bg);border:1px solid var(--red-border);
           border-radius:var(--r-md);padding:12px 14px;margin-top:12px;
           font-size:12px;color:var(--red);display:flex;align-items:flex-start;gap:8px">
         <span class="material-symbols-outlined" style="font-size:16px;flex-shrink:0;margin-top:1px">error</span>
         <span>
           <strong>Tidak bisa dihapus.</strong><br>
           ODC ini masih memiliki <strong>${o.jumlah_odp} ODP</strong> yang terhubung.
           Hapus atau pindahkan semua ODP terlebih dahulu sebelum menghapus ODC ini.
         </span>
       </div>` : '';

  // Tombol hapus hanya aktif jika tidak ada ODP
  const btnHapus = hasOdp
    ? `<button class="btn btn-red" disabled style="opacity:.45;cursor:not-allowed">
         <span class="material-symbols-outlined">delete</span> Tidak Bisa Dihapus
       </button>`
    : `<button class="btn btn-red" onclick="doDelete(${id})">
         <span class="material-symbols-outlined">delete</span> Ya, Hapus
       </button>`;

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon"
              style="color:${hasOdp ? 'var(--red)' : ''}">
          ${hasOdp ? 'block' : 'delete'}
        </span>
      </div>
      <div class="hapus-title">${hasOdp ? 'Hapus Ditolak' : 'Hapus ODC?'}</div>
      <div class="hapus-sub">
        ${hasOdp
          ? `ODC <strong>${escHtml(o.nama)}</strong> tidak bisa dihapus karena masih memiliki dependency.`
          : `Yakin hapus <strong>${escHtml(o.nama)}</strong>?<br>Data ODC ini akan dihapus permanen.`
        }
      </div>
      ${warnBlock}
      <div class="modal-actions" style="margin-top:20px">
        <button class="btn" onclick="closeModalForm()">
          ${hasOdp ? 'Tutup' : 'Batal'}
        </button>
        ${btnHapus}
      </div>
    </div>`);
}

async function doDelete(id) {
  closeModalForm();
  try {
    const res = await fetch(`${API_BASE}/api/odc/${id}`, { method: 'DELETE', credentials: 'include', headers: getAuthHeaders() });
    if (res.ok) { loadOdc(); toast('ODC berhasil dihapus', 'danger'); }
    else toast('Gagal menghapus ODC', 'danger');
  } catch (e) { toast('Tidak bisa menghubungi server', 'danger'); }
}

// ── INIT ──────────────────────────────────────────────────────
// (dipanggil via DOMContentLoaded di atas — jangan panggil ulang di sini)