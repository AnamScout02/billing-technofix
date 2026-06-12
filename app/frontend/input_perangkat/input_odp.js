/* ============================================================
   input_odp.js — Manajemen ODP (Optical Distribution Point)
   v3.0 — Migrasi penuh dari localStorage ke backend API
   ============================================================
   PERUBAHAN dari v2.x (localStorage):
   ✅ Semua CRUD menggunakan fetch ke /api/odp (odp.py)
   ✅ State: _allData (seragam dengan standar global)
   ✅ Field koordinat + geolocation picker + preview peta mini
   ✅ Warning dependency: cek port_terpakai sebelum hapus
   ✅ credentials: 'include' di semua fetch (session cookie)
   ✅ Pola async/await selaras dengan input_odc.js

   Requires: global.js (API_BASE, escHtml, val, animNum,
             toast, openModalForm, closeModalForm,
             getAuthHeaders)

   Endpoint backend (odp.py):
   GET    /api/odp          → daftar semua ODP
   GET    /api/odp?odc_id=N → filter per ODC
   POST   /api/odp          → tambah ODP
   PUT    /api/odp/<id>     → edit ODP
   DELETE /api/odp/<id>     → hapus ODP

   Skema respons ODP dari backend (odp_to_dict):
     id, nama, lokasi, koordinat, jumlah_port,
     port_terpakai, odc_id, odc_nama, keterangan
   ============================================================ */

'use strict';

// ── STATE ─────────────────────────────────────────────────────
let _allData  = [];   // semua ODP dari backend
let _editingId = null;


// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadOdp();
});


// ── LOAD ──────────────────────────────────────────────────────
async function loadOdp() {
  showLoading();
  try {
    const res  = await fetch(`${API_BASE}/api/odp`, {
      credentials: 'include',
      headers: getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _allData = Array.isArray(data) ? data : [];
    renderOdp();
  } catch (e) {
    document.getElementById('odp-list').innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--red)">wifi_off</span>
        <p style="font-weight:600;color:var(--text)">Tidak bisa terhubung ke server</p>
        <p style="font-size:12px;color:var(--text-muted)">Pastikan backend Flask sudah berjalan.</p>
      </div>`;
    updateStats();
  }
}

function syncAll() { loadOdp(); }

function showLoading() {
  document.getElementById('odp-list').innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined spin" style="font-size:32px">refresh</span>
      <p>Memuat data ODP...</p>
    </div>`;
}


// ── STATS ─────────────────────────────────────────────────────
function updateStats() {
  const totalPort    = _allData.reduce((s, o) => s + (Number(o.jumlah_port)    || 0), 0);
  const totalTerpakai = _allData.reduce((s, o) => s + (Number(o.port_terpakai) || 0), 0);

  animNum('stat-total',          _allData.length);
  animNum('stat-port-terpakai',  totalTerpakai);
  animNum('stat-port-total',     totalPort);

  const cnt = document.getElementById('odp-count');
  if (cnt) cnt.textContent = `${_allData.length} titik ODP`;
}


// ── RENDER ────────────────────────────────────────────────────
function renderOdp() {
  const container = document.getElementById('odp-list');
  if (!container) return;

  if (!_allData.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:44px;color:var(--text-dim)">hub</span>
        <p style="font-weight:700;color:var(--text)">Belum ada ODP terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted)">
          Klik <strong>Tambah</strong> untuk mendaftarkan titik distribusi baru.
        </p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = _allData.map((o, idx) => {
    const kapasitas   = Number(o.jumlah_port)    || 0;
    const terpakai    = Number(o.port_terpakai)  || 0;
    const sisa        = kapasitas - terpakai;
    const persen      = kapasitas > 0 ? Math.min(100, Math.round((terpakai / kapasitas) * 100)) : 0;
    const barColor    = persen >= 90 ? 'var(--red)' : persen >= 70 ? 'var(--amber)' : 'var(--green)';
    const koordinat   = o.koordinat || '';

    // Status badge: port tersisa / penuh
    const badgeClass  = sisa > 0 ? 'connected' : 'failed';
    const badgeLabel  = sisa > 0 ? `${sisa} port tersisa` : 'Penuh';

    return `
      <div class="device-card" id="card-${o.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon" style="background:var(--amber-bg);color:var(--amber)">
          <span class="material-symbols-outlined">hub</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(o.nama)}</span>
            <span class="badge ${badgeClass}">
              <span class="badge-dot"></span>
              ${badgeLabel}
            </span>
          </div>

          <div class="device-meta">
            ${o.odc_nama ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">account_tree</span>
              ODC: ${escHtml(o.odc_nama)}
            </span>` : ''}
            <span class="device-meta-item">
              <span class="material-symbols-outlined">fiber_manual_record</span>
              ${terpakai}/${kapasitas} port
            </span>
            ${o.lokasi ? `
            <span class="device-meta-item">
              <span class="material-symbols-outlined">place</span>
              ${escHtml(o.lokasi)}
            </span>` : ''}
          </div>

          <!-- Progress bar penggunaan port -->
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
          <button class="btn btn-amber btn-sm" onclick="editOdp(${o.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${o.id})" title="Hapus ODP">
            <span class="material-symbols-outlined">delete</span>
          </button>` : ''}
        </div>

      </div>`;
  }).join('');

  updateStats();
}


// ── FORM MODAL ────────────────────────────────────────────────
async function showForm(prefill = null) {
  _editingId   = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(String(prefill[k] ?? '')) : '';

  // Load opsi ODC, ODP, dan OLT (untuk semua mode relasi)
  let odcOptions    = '<option value="">— Pilih ODC —</option>';
  let odpParentOptions = '<option value="">— Pilih ODP Induk —</option>';
  let oltOptions    = '<option value="">— Pilih OLT —</option>';
  try {
    const [rOdc, rOdp, rOlt] = await Promise.all([
      fetch(`${API_BASE}/api/odc`, { credentials: 'include', headers: getAuthHeaders() }),
      fetch(`${API_BASE}/api/odp`, { credentials: 'include', headers: getAuthHeaders() }),
      fetch(`${API_BASE}/olt`,     { credentials: 'include', headers: getAuthHeaders() }),
    ]);
    if (rOdc.ok) {
      const data = await rOdc.json();
      odcOptions += data.map(o =>
        `<option value="${o.id}" ${prefill?.odc_id == o.id ? 'selected' : ''}>${escHtml(o.nama)} (${o.jumlah_port} port)</option>`
      ).join('');
    }
    if (rOdp.ok) {
      const data = await rOdp.json();
      odpParentOptions += data
        .filter(o => !prefill || o.id != prefill.id)
        .map(o => `<option value="${o.id}" ${prefill?.parent_odp_id == o.id ? 'selected' : ''}>${escHtml(o.nama)} (${o.jumlah_port} port)</option>`)
        .join('');
    }
    if (rOlt.ok) {
      const data = await rOlt.json();
      const list = Array.isArray(data) ? data : (data.devices || []);
      oltOptions += list.map(o =>
        `<option value="${o.id}" ${prefill?.olt_id == o.id ? 'selected' : ''}>${escHtml(o.name)} (${o.ip})</option>`
      ).join('');
    }
  } catch (_) {}

  // Tentukan mode relasi saat edit
  const relasiMode = prefill?.parent_odp_id ? 'odp' : (prefill?.olt_id ? 'olt' : 'odc');

  const html = `
    <div class="form-modal" style="width:560px">

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--amber-bg);color:var(--amber);
             display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined" style="font-size:20px">
            ${isEdit ? 'edit' : 'add_circle'}
          </span>
        </div>
        <div style="flex:1">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text)">
            ${isEdit ? 'Edit ODP' : 'Tambah ODP Baru'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px">
            Optical Distribution Point — titik distribusi ke pelanggan
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label">Nama ODP <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-nama"
                 placeholder="Contoh: ODP-Jl-Merdeka-01" value="${v('nama')}">
        </div>

        <!-- Jumlah Port -->
        <div class="form-group full">
          <label class="form-label">Jumlah Port (Kapasitas) <span class="req">*</span></label>
          <select class="form-input" id="f-jumlah-port">
            ${[2, 4, 8, 12, 16, 24, 32, 48, 64].map(n =>
              `<option value="${n}" ${(prefill?.jumlah_port ?? 8) == n ? 'selected' : ''}>${n} port</option>`
            ).join('')}
          </select>
        </div>

        <!-- Relasi: ODC / ODP cascade / OLT langsung -->
        <div class="form-group full">
          <label class="form-label">Jenis Relasi</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600">
              <input type="radio" name="relasi-mode" value="odc" id="r-odc"
                ${relasiMode === 'odc' ? 'checked' : ''}
                onchange="_odpRelasiToggle('odc')" style="accent-color:var(--primary)">
              Terhubung ke ODC
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600">
              <input type="radio" name="relasi-mode" value="odp" id="r-odp"
                ${relasiMode === 'odp' ? 'checked' : ''}
                onchange="_odpRelasiToggle('odp')" style="accent-color:var(--primary)">
              Cascade ODP
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600">
              <input type="radio" name="relasi-mode" value="olt" id="r-olt"
                ${relasiMode === 'olt' ? 'checked' : ''}
                onchange="_odpRelasiToggle('olt')" style="accent-color:var(--primary)">
              Langsung ke OLT
            </label>
          </div>
        </div>

        <!-- Relasi ke ODC + Port ODC -->
        <div id="relasi-odc-wrap" class="form-group full" style="${relasiMode === 'odc' ? '' : 'display:none'}">
          <label class="form-label">Relasi ke ODC</label>
          <select class="form-input" id="f-odc-id" onchange="_loadPortOdcForOdp()">${odcOptions}</select>
        </div>
        <div id="port-odc-wrap" class="form-group full" style="display:none">
          <label class="form-label">Terhubung ke Port ODC <span style="font-size:10px;color:var(--text-dim)">(port yang belum dipakai ODP lain)</span></label>
          <select class="form-input" id="f-port-odc">
            <option value="">— Pilih Port —</option>
          </select>
        </div>

        <!-- Relasi ke ODP induk (cascade) + Port ODP parent -->
        <div id="relasi-odp-wrap" class="form-group full" style="${relasiMode === 'odp' ? '' : 'display:none'}">
          <label class="form-label">Relasi ke ODP Induk <span style="font-size:10px;color:var(--text-dim)">(cascade splitter)</span></label>
          <select class="form-input" id="f-parent-odp-id" onchange="_loadPortParentOdp()">${odpParentOptions}</select>
        </div>
        <div id="port-parent-odp-wrap" class="form-group full" style="display:none">
          <label class="form-label">Terhubung ke Port ODP Induk <span style="font-size:10px;color:var(--text-dim)">(port yang belum dipakai)</span></label>
          <select class="form-input" id="f-port-parent-odp">
            <option value="">— Pilih Port —</option>
          </select>
        </div>

        <!-- Relasi langsung ke OLT -->
        <div id="relasi-olt-wrap" class="form-group full" style="${relasiMode === 'olt' ? '' : 'display:none'}">
          <label class="form-label">Relasi ke OLT <span style="font-size:10px;color:var(--text-dim)">(tanpa melalui ODC)</span></label>
          <select class="form-input" id="f-olt-id">${oltOptions}</select>
        </div>

        <div class="form-group full">
          <label class="form-label">
            <span class="material-symbols-outlined"
                  style="font-size:13px;vertical-align:middle;color:var(--primary)">location_on</span>
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
                 placeholder="mis. Tiang depan rumah No. 12" value="${v('lokasi')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Keterangan (opsional)</label>
          <textarea class="form-input" id="f-keterangan" rows="3"
                    placeholder="Catatan tambahan tentang ODP ini">${v('keterangan')}</textarea>
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
  requestAnimationFrame(() => {
    document.getElementById('f-nama')?.focus();
    if (isEdit && prefill?.koordinat) previewKoordinat();
    // Load port setelah form terbuka
    if (relasiMode === 'odc' && prefill?.odc_id) {
      _loadPortOdcForOdp().then(() => {
        const portSel = document.getElementById('f-port-odc');
        if (portSel && prefill.port_odc) portSel.value = prefill.port_odc;
      });
    } else if (relasiMode === 'odp' && prefill?.parent_odp_id) {
      _loadPortParentOdp().then(() => {
        const portSel = document.getElementById('f-port-parent-odp');
        if (portSel && prefill.port_parent_odp) portSel.value = prefill.port_parent_odp;
      });
    }
    // mode 'olt': dropdown sudah ter-prefill via selected di HTML
  });
}

function cancelForm() {
  _editingId = null;
  closeModalForm();
}

function editOdp(id) {
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
  if (
    parts.length === 2 &&
    !isNaN(parseFloat(parts[0])) &&
    !isNaN(parseFloat(parts[1]))
  ) {
    iframe.src = `https://maps.google.com/maps?q=${parseFloat(parts[0])},${parseFloat(parts[1])}&z=15&output=embed`;
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
    iframe.src = '';
  }
}


// ── COLLECT FORM ──────────────────────────────────────────────
function collectForm() {
  const nama         = val('f-nama');
  const jumlahPort   = parseInt(val('f-jumlah-port'))   || 0;

  if (!nama) {
    toast('Nama ODP wajib diisi', 'warning');
    return null;
  }
  const modeEl  = document.querySelector('input[name="relasi-mode"]:checked');
  const mode    = modeEl ? modeEl.value : 'odc';

  const odc_id          = mode === 'odc' ? (val('f-odc-id')        || null) : null;
  const parent_odp_id   = mode === 'odp' ? (val('f-parent-odp-id') || null) : null;
  const olt_id          = mode === 'olt' ? (val('f-olt-id')         || null) : null;
  const port_odc        = mode === 'odc' ? (val('f-port-odc')       || null) : null;
  const port_parent_odp = mode === 'odp' ? (val('f-port-parent-odp')|| null) : null;

  return {
    nama,
    lokasi:           val('f-lokasi'),
    koordinat:        val('f-koordinat'),
    jumlah_port:      jumlahPort,
    odc_id,
    parent_odp_id,
    olt_id,
    port_odc:         port_odc ? parseInt(port_odc) : null,
    port_parent_odp:  port_parent_odp ? parseInt(port_parent_odp) : null,
    keterangan:       val('f-keterangan'),
  };
}

// ── Toggle relasi ODC / ODP cascade / OLT langsung ──────────
function _odpRelasiToggle(mode) {
  const odcWrap    = document.getElementById('relasi-odc-wrap');
  const portOdcW   = document.getElementById('port-odc-wrap');
  const odpWrap    = document.getElementById('relasi-odp-wrap');
  const portOdpW   = document.getElementById('port-parent-odp-wrap');
  const oltWrap    = document.getElementById('relasi-olt-wrap');

  // Sembunyikan semua dulu
  [odcWrap, portOdcW, odpWrap, portOdpW, oltWrap].forEach(el => { if (el) el.style.display = 'none'; });

  if (mode === 'odc') {
    if (odcWrap) odcWrap.style.display = '';
    _loadPortOdcForOdp();
  } else if (mode === 'odp') {
    if (odpWrap) odpWrap.style.display = '';
    _loadPortParentOdp();
  } else if (mode === 'olt') {
    if (oltWrap) oltWrap.style.display = '';
  }
}

async function _loadPortOdcForOdp() {
  const odcId = val('f-odc-id');
  const wrap  = document.getElementById('port-odc-wrap');
  const sel   = document.getElementById('f-port-odc');
  if (!odcId || !wrap || !sel) { if(wrap) wrap.style.display='none'; return; }
  try {
    const r = await fetch(`${API_BASE}/api/odc/${odcId}/ports`, { credentials:'include', headers:getAuthHeaders() });
    const d = await r.json();
    sel.innerHTML = '<option value="">— Pilih Port —</option>';
    (d.tersedia||[]).forEach(p => sel.appendChild(new Option('Port ' + p + ' (kosong)', p)));
    Object.entries(d.odp_per_port||{}).forEach(([port, name]) => {
      const o = new Option('Port ' + port + ' — ' + name + ' (terpakai)', port);
      o.disabled = true; o.style.color='var(--text-dim)'; sel.appendChild(o);
    });
    wrap.style.display = '';
  } catch(_) { if(wrap) wrap.style.display='none'; }
}

async function _loadPortParentOdp() {
  const odpId = val('f-parent-odp-id');
  const wrap  = document.getElementById('port-parent-odp-wrap');
  const sel   = document.getElementById('f-port-parent-odp');
  if (!odpId || !wrap || !sel) { if(wrap) wrap.style.display='none'; return; }
  try {
    const r = await fetch(`${API_BASE}/api/odp/${odpId}/child-ports`, { credentials:'include', headers:getAuthHeaders() });
    const d = await r.json();
    sel.innerHTML = '<option value="">— Pilih Port —</option>';
    (d.tersedia||[]).forEach(p => sel.appendChild(new Option('Port ' + p + ' (kosong)', p)));
    Object.entries(d.terhubung_per_port||{}).forEach(([port, name]) => {
      const o = new Option('Port ' + port + ' — ' + name + ' (terpakai)', port);
      o.disabled = true; o.style.color='var(--text-dim)'; sel.appendChild(o);
    });
    wrap.style.display = '';
  } catch(_) { if(wrap) wrap.style.display='none'; }
}


// ── CRUD — ADD ────────────────────────────────────────────────
async function addOdp() {
  const payload = collectForm();
  if (!payload) return;

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/api/odp`, {
      method:      'POST',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      cancelForm();
      toast(`ODP ${payload.nama} berhasil ditambahkan`, 'success');
      loadOdp();
    } else {
      toast(data.error || 'Gagal menyimpan ODP', 'danger');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah ODP';
      }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah ODP';
    }
  }
}


// ── CRUD — EDIT ───────────────────────────────────────────────
async function saveEdit() {
  const payload = collectForm();
  if (!payload) return;

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/api/odp/${_editingId}`, {
      method:      'PUT',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      cancelForm();
      toast('ODP berhasil diperbarui', 'success');
      loadOdp();
    } else {
      toast(data.error || 'Gagal memperbarui ODP', 'danger');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan';
      }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server', 'danger');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan';
    }
  }
}


// ── CRUD — DELETE (dengan dependency check) ───────────────────
function confirmDelete(id) {
  const o = _allData.find(x => x.id === id);
  if (!o) return;

  const terpakai    = Number(o.port_terpakai) || 0;
  const isOccupied  = terpakai > 0;

  // Warning: ODP masih memiliki pelanggan (port terpakai > 0)
  const warnOnu = isOccupied
    ? `<div style="background:var(--red-bg);border:1px solid var(--red-border);
           border-radius:var(--r-md);padding:10px 14px;margin-top:12px;
           font-size:12px;color:var(--red);display:flex;align-items:center;gap:8px">
         <span class="material-symbols-outlined" style="font-size:16px;flex-shrink:0">warning</span>
         <span><strong>Perhatian:</strong> ODP ini masih memiliki
           <strong>${terpakai} port terpakai</strong> (kemungkinan ada pelanggan aktif).
           Pastikan semua pelanggan sudah dipindahkan sebelum menghapus.</span>
       </div>` : '';

  openModalForm(`
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus ODP?</div>
      <div class="hapus-sub">
        Yakin hapus <strong>${escHtml(o.nama)}</strong>?<br>
        Data ODP ini akan dihapus secara permanen.
      </div>
      ${warnOnu}
      <div class="modal-actions" style="margin-top:20px">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete(${id})">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`);
}

async function doDelete(id) {
  closeModalForm();
  try {
    const res = await fetch(`${API_BASE}/api/odp/${id}`, {
      method:      'DELETE',
      credentials: 'include',
      headers:     getAuthHeaders(),
    });
    if (res.ok) {
      toast('ODP berhasil dihapus', 'danger');
      loadOdp();
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || 'Gagal menghapus ODP', 'danger');
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server', 'danger');
  }
}