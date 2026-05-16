/* ============================================================
   pelanggan.js — Manajemen Pelanggan TechnoFix
   Disesuaikan dengan input.py (SQLite + routeros_api)

   Endpoint yang dipakai dari input.py:
   GET    /devices                     → daftar perangkat
   GET    /api/pelanggan/<device_id>   → pelanggan per perangkat
   POST   /api/pelanggan               → tambah pelanggan
   PUT    /api/pelanggan/<id>          → edit pelanggan
   DELETE /api/pelanggan/<id>          → hapus pelanggan
   POST   /devices/<id>/sync           → tes koneksi perangkat
   ============================================================ */

'use strict';

/* ── CONFIG ── */
const API_BASE = 'http://localhost:5000';
let PER_PAGE = 50;

/* ── STATE ── */
let semuaPelanggan = [];  // data dari API (sudah include status online/offline)
let filteredData = [];  // setelah filter/search
let currentPage = 1;
let editingId = null; // null = tambah baru, number = id pelanggan di DB
let hapusTarget = null; // { id, username }
let selectedDevice = null; // device object yang dipilih


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadDevices();
  loadOltOptions();  // Tambahkan baris ini!
});


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR PERANGKAT
   GET /devices  →  isi <select id="select-device">
══════════════════════════════════════════════════════════ */
async function loadDevices() {
  try {
    const res = await fetch(`${API_BASE}/devices`);
    const data = await res.json();  // array of devices

    const selHeader = document.getElementById('select-device');
    const selForm = document.getElementById('f-device');
   

    // Kosongkan dulu
    selHeader.innerHTML = '<option value="">— Pilih Perangkat —</option>';
    selForm.innerHTML = '<option value="">— Pilih Perangkat —</option>';

    data.forEach(d => {
      selHeader.appendChild(new Option(`${d.name}  (${d.ip})`, d.id));
      selForm.appendChild(new Option(`${d.name}  (${d.ip})`, d.id));
    });

    // Auto-select perangkat pertama jika ada
    
      selectedDevice = null ;
      loadPelanggan();
    

  } catch (err) {
    tampilError('Gagal memuat daftar perangkat. Pastikan server Python berjalan.');
  }
}


/* ══════════════════════════════════════════════════════════
   2. LOAD PELANGGAN DARI MIKROTIK + DB LOKAL
   GET /api/pelanggan/<device_id>
   Response: array of pelanggan { id, device_id, username,
     password, hp, profil, slot_port_onu, vlan, sn,
     status, ip_address }
══════════════════════════════════════════════════════════ */
async function loadPelanggan() {
  const deviceId = document.getElementById('select-device').value;
  if (!deviceId) { tampilEmpty(); return; }

  // Simpan info device yang dipilih
  const selEl = document.getElementById('select-device');
  selectedDevice = { id: deviceId, name: selEl.options[selEl.selectedIndex].text };

  tampilLoading();
  animasiRefresh(true);

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${deviceId}`);
    const data = await res.json();

    console.log('Response API:', data);

    if (!res.ok) {
      throw new Error(data.error || data.message || 'Gagal mengambil data');
    }

    semuaPelanggan = Array.isArray(data) ? data : [];
    updateStats();
    updateFilterProfil();
    filterPelanggan();
    updateSyncStatus(true);

  } catch (err) {
    tampilError(err.message);
    updateSyncStatus(false);
  } finally {
    animasiRefresh(false);
  }
}


/* ══════════════════════════════════════════════════════════
   3. FILTER + SEARCH
══════════════════════════════════════════════════════════ */
function filterPelanggan() {
  const keyword = document.getElementById('input-search').value.toLowerCase().trim();
  const status = document.getElementById('filter-status').value;
  const profil = document.getElementById('filter-profil').value;

  filteredData = semuaPelanggan.filter(p => {
    const matchKeyword =
      !keyword ||
      (p.username || '').toLowerCase().includes(keyword) ||
      (p.hp || '').toLowerCase().includes(keyword) ||
      (p.profil || '').toLowerCase().includes(keyword) ||
      (p.sn || '').toLowerCase().includes(keyword);

    const matchStatus =
      !status ||
      (status === 'aktif' && p.status === 'Online') ||
      (status === 'nonaktif' && p.status !== 'Online');

    const matchProfil = !profil || p.profil === profil;

    return matchKeyword && matchStatus && matchProfil;
  });

  currentPage = 1;
  renderTabel();
  renderPaginasi();
}


/* ══════════════════════════════════════════════════════════
   4. RENDER TABEL
══════════════════════════════════════════════════════════ */
function renderTabel() {
  const tbody = document.getElementById('tbody-pelanggan');
  const tabel = document.getElementById('table-pelanggan');

  sembunyikanSemuaState();

  if (filteredData.length === 0) {
    tabel.style.display = 'none';
    tampilEmpty();
    return;
  }

  tabel.style.display = 'table';

  const start = (currentPage - 1) * PER_PAGE;
  const slice = filteredData.slice(start, start + PER_PAGE);

  tbody.innerHTML = slice.map((p, i) => {
    const no = start + i + 1;
    const username = String(p.username || '?');
    const inisial = username.substring(0, 2).toUpperCase();
    const online = p.status === 'Online';
    const disconnected = p.status === 'Router Disconnected';

    let badgeClass, badgeLabel;
    if (online) { badgeClass = 'online'; badgeLabel = 'Online'; }
    else if (disconnected) { badgeClass = 'nonaktif'; badgeLabel = 'Router Off'; }
    else { badgeClass = 'nonaktif'; badgeLabel = 'Offline'; }

    return `
      <tr>
        <td style="color:var(--text-dim);font-size:12px;padding-left:18px;width:40px">${no}</td>

        <td>
          <div class="td-user">
            <div class="user-avatar">${escHtml(inisial)}</div>
            <div>
              <div class="user-name">${escHtml(String(p.username || '—'))}</div>
            </div>
          </div>
        </td>

        <td>
          <div class="user-name" style="font-size:12px">${escHtml(p.hp || '—')}</div>
        </td>

        <td><span class="badge-profil">${escHtml(p.profil || '—')}</span></td>

        <td>
          <div class="user-meta">${escHtml(p.slot_port || '—')}</div>
        </td>

        <td>
          <div class="mono-text">${escHtml(p.vlan || '—')}</div>
        </td>

        <td>

          <div class="mono-text">
            ${escHtml(p.sn || '—')}
          </div>

        </td>

        <td>
          <span class="badge-status ${badgeClass}">
            <span class="badge-dot"></span>
            ${badgeLabel}
          </span>
        </td>

        <td>
          <div class="td-actions">
            <button class="btn-tbl edit" onclick="openEdit(${p.id})" title="Edit">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="btn-tbl hapus" onclick="openHapus(${p.id}, '${escHtml(p.username)}')" title="Hapus">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  const deviceCount = document.getElementById('device-count');
  if (deviceCount) {
    deviceCount.textContent = `${filteredData.length} pelanggan`;
  }
}


/* ══════════════════════════════════════════════════════════
   5. PAGINASI
══════════════════════════════════════════════════════════ */
function renderPaginasi() {
  const totalPage = Math.ceil(filteredData.length / PER_PAGE);
  const wrap = document.getElementById('pagination');
  if (totalPage <= 1) { wrap.innerHTML = ''; return; }

  let html = `<button class="page-btn" onclick="gantiPage(${currentPage - 1})"
    ${currentPage === 1 ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_left</span>
  </button>`;

  for (let i = 1; i <= totalPage; i++) {
    if (i === 1 || i === totalPage || (i >= currentPage - 1 && i <= currentPage + 1)) {
      html += `<button class="page-btn ${i === currentPage ? 'active' : ''}"
        onclick="gantiPage(${i})">${i}</button>`;
    } else if (i === currentPage - 2 || i === currentPage + 2) {
      html += `<span style="color:var(--text-dim);padding:0 2px">…</span>`;
    }
  }

  html += `<button class="page-btn" onclick="gantiPage(${currentPage + 1})"
    ${currentPage === totalPage ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_right</span>
  </button>`;

  wrap.innerHTML = html;
}

function gantiPage(p) {
  const total = Math.ceil(filteredData.length / PER_PAGE);
  if (p < 1 || p > total) return;
  currentPage = p;
  renderTabel();
  renderPaginasi();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


/* ══════════════════════════════════════════════════════════
   6. STATS
══════════════════════════════════════════════════════════ */
function updateStats() {
  const total = semuaPelanggan.length;
  const online = semuaPelanggan.filter(p => p.status === 'Online').length;
  const offline = total - online;

  animNum('stat-total', total);
  animNum('stat-aktif', online);
  animNum('stat-nonaktif', offline);
  animNum('stat-online', online);

}

function animNum(id, target) {
  const el = document.getElementById(id);
  const dur = 500;
  const start = performance.now();
  const from = parseInt(el.textContent) || 0;
  function step(now) {
    const t = Math.min((now - start) / dur, 1);
    el.textContent = Math.round(from + (target - from) * t);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}


/* ══════════════════════════════════════════════════════════
   7. FILTER PROFIL
══════════════════════════════════════════════════════════ */
function updateFilterProfil() {
  const profils = [...new Set(semuaPelanggan.map(p => p.profil).filter(Boolean))].sort();
  const sel = document.getElementById('filter-profil');
  sel.innerHTML = '<option value="">Semua Profil</option>';
  profils.forEach(pr => sel.appendChild(new Option(pr, pr)));

  // Isi juga di form modal
  const fProfil = document.getElementById('f-profil');
  const prev = fProfil.value;
  fProfil.innerHTML = '<option value="">— Pilih Profil —</option>';
  profils.forEach(pr => fProfil.appendChild(new Option(pr, pr)));
  if (prev) fProfil.value = prev;
}


/* ══════════════════════════════════════════════════════════
   8. MODAL TAMBAH PELANGGAN
══════════════════════════════════════════════════════════ */
function openModalTambah() {
  editingId = null;
  document.getElementById('modal-pelanggan-title').textContent = 'Tambah Pelanggan';

  // Reset semua field
  ['f-username', 'f-password', 'f-hp',
    'f-slot', 'f-vlan', 'f-sn'].forEach(id => {
      document.getElementById(id).value = '';
    });
  document.getElementById('f-profil').value = '';
  document.getElementById('f-service').value = 'pppoe';

  // Sinkron device
  const devSel = document.getElementById('select-device');
  document.getElementById('f-device').value = devSel.value;

  bukaModal('modal-pelanggan');
}


/* ══════════════════════════════════════════════════════════
   9. MODAL EDIT PELANGGAN
══════════════════════════════════════════════════════════ */
function openEdit(id) {
  const p = semuaPelanggan.find(x => x.id === id);
  if (!p) return;

  editingId = id;
  document.getElementById('modal-pelanggan-title').textContent = 'Edit Pelanggan';
  document.getElementById('f-username').value = p.username || '';
  document.getElementById('f-password').value = '';           // kosong = tidak diubah
  document.getElementById('f-hp').value = p.hp || '';
  document.getElementById('f-profil').value = p.profil || '';
  document.getElementById('f-slot').value = p.slot_port || '';
  document.getElementById('f-vlan').value = p.vlan || '';
  document.getElementById('f-sn').value = p.sn || '';
  document.getElementById('f-service').value = 'pppoe';

  const devSel = document.getElementById('select-device');
  document.getElementById('f-device').value = devSel.value;

  bukaModal('modal-pelanggan');
}


/* ══════════════════════════════════════════════════════════
   10. SIMPAN PELANGGAN
   POST /api/pelanggan        → tambah baru (input.py)
   PUT  /api/pelanggan/<id>   → edit (input.py)
══════════════════════════════════════════════════════════ */
async function simpanPelanggan() {
  const deviceId = document.getElementById('f-device').value;
  const username = document.getElementById('f-username').value.trim();
  const password = document.getElementById('f-password').value.trim();
  const hp = document.getElementById('f-hp').value.trim();
  const profil = document.getElementById('f-profil').value;
  const service = document.getElementById('f-service').value;
  const slot = document.getElementById('f-slot').value.trim();
  const vlan = document.getElementById('f-vlan').value.trim();
  const sn = document.getElementById('f-sn').value.trim();

  // Validasi
  if (!username) { showToast('Username wajib diisi', 'err'); return; }
  if (!editingId && !password) { showToast('Password wajib diisi untuk pelanggan baru', 'err'); return; }
  if (!deviceId) { showToast('Pilih perangkat terlebih dahulu', 'err'); return; }

  const btn = document.getElementById('btn-save-pelanggan');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Menyimpan...';

  try {
    let url, method, body;

    if (editingId) {
      // ── EDIT: PUT /api/pelanggan/<id> ──
      url = `${API_BASE}/api/pelanggan/${editingId}`;
      method = 'PUT';
      body = {
        username, password, hp, profil, service,
        slot_port: slot, vlan, sn, device_id: Number(deviceId)
      };
      if (!password) delete body.password; // jangan kirim kalau kosong

    } else {
      // ── TAMBAH: POST /api/pelanggan ──
      url = `${API_BASE}/api/pelanggan`;
      method = 'POST';
      body = {
        device_id: Number(deviceId), username, password,
        hp, profil, slot_port: slot, vlan, sn
      };
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok && data.status === 'error') throw new Error(data.message);

    tutupModalPelanggan();
    showToast(
      editingId
        ? `✓ Data ${username} berhasil diperbarui`
        : `✓ Pelanggan ${username} berhasil ditambahkan`,
      'ok'
    );
    await loadPelanggan();

  } catch (err) {
    showToast('✗ ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">save</span> Simpan';
  }
  const searchBox = document.getElementById('input-search');
  if (searchBox) searchBox.value = '';
  filterPelanggan();
}



/* ══════════════════════════════════════════════════════════
   11. HAPUS PELANGGAN
   DELETE /api/pelanggan/<id>   (input.py)
══════════════════════════════════════════════════════════ */
function openHapus(id, username) {
  hapusTarget = { id, username };
  document.getElementById('hapus-username').textContent = username;
  bukaModal('modal-hapus');
}

async function konfirmasiHapus() {
  if (!hapusTarget) return;

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${hapusTarget.id}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message);

    tutupModalHapus();
    showToast(`🗑 ${hapusTarget.username} berhasil dihapus`, 'ok');
    hapusTarget = null;
    await loadPelanggan();

  } catch (err) {
    showToast('✗ ' + err.message, 'err');
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Modal
══════════════════════════════════════════════════════════ */
function bukaModal(id) { document.getElementById(id).classList.add('open'); }
function tutupModal(id) { document.getElementById(id).classList.remove('open'); }

function tutupModalPelanggan() { tutupModal('modal-pelanggan'); }
function tutupModalHapus() { tutupModal('modal-hapus'); }

function closeModalPelanggan(e) {
  if (e.target.id === 'modal-pelanggan') tutupModalPelanggan();
}
function closeModalHapus(e) {
  if (e.target.id === 'modal-hapus') tutupModalHapus();
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Password toggle
══════════════════════════════════════════════════════════ */
function togglePwd(inputId, iconId) {
  const inp = document.getElementById(inputId);
  const icon = document.getElementById(iconId);
  if (inp.type === 'password') {
    inp.type = 'text'; icon.textContent = 'visibility_off';
  } else {
    inp.type = 'password'; icon.textContent = 'visibility';
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — UI States
══════════════════════════════════════════════════════════ */
function sembunyikanSemuaState() {
  ['state-loading', 'state-empty', 'state-error'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
}
function tampilLoading() {
  sembunyikanSemuaState();
  document.getElementById('table-pelanggan').style.display = 'none';
  document.getElementById('state-loading').style.display = 'flex';
}
function tampilEmpty() {
  sembunyikanSemuaState();
  document.getElementById('table-pelanggan').style.display = 'none';
  document.getElementById('state-empty').style.display = 'flex';
}
function tampilError(msg) {
  sembunyikanSemuaState();
  document.getElementById('table-pelanggan').style.display = 'none';
  document.getElementById('state-error').style.display = 'flex';
  document.getElementById('error-msg').textContent = msg;
}
function updateSyncStatus(ok) {
  const el = document.getElementById('sync-status');

  if (!el) return;

  if (ok) {
    el.innerHTML = '🟢 Terhubung';
    el.className = 'sync-status ok';
  } else {
    el.innerHTML = '🔴 Gagal Terhubung';
    el.className = 'sync-status err';
  }

}
function animasiRefresh(on) {
  const icon = document.getElementById('refresh-icon');
  icon.style.animation = on ? 'spin .8s linear infinite' : '';
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Toast
══════════════════════════════════════════════════════════ */
function showToast(msg, type) {
  const t = document.getElementById('toast');
  const icon = type === 'ok' ? 'check_circle' : 'error';
  t.innerHTML = `<span class="material-symbols-outlined">${icon}</span>${msg}`;
  t.style.background = type === 'ok' ? '#14532d' : '#7f1d1d';
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3200);
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Sanitasi HTML (cegah XSS)
══════════════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function perbaruiDropdownProfil() {
  const select = document.getElementById('f-profil');
  if (!select) return;

  // Cari nama profil unik dari data MikroTik
  const profilUnik = [...new Set(semuaPelanggan.map(p => p.profile || p.profil || 'default'))];

  select.innerHTML = '';
  profilUnik.forEach(prof => {
    const opt = document.createElement('option');
    opt.value = prof;
    opt.textContent = prof;
    select.appendChild(opt);
  });
}

// Fungsi untuk Dropdown 50/100/200
function ubahJumlahTampil() {
  const select = document.getElementById('perPageSelect');
  if (select) {
    PER_PAGE = parseInt(select.value) || 50;
  }
  currentPage = 1; // Kembali ke halaman 1
  renderTabel();   // Gambar ulang tabel menggunakan fungsi bawaan
  renderPaginasi(); // Gambar ulang paginasi menggunakan fungsi bawaan
}

// Modifikasi fungsi renderTable Anda untuk mendukung Pagination
function ubahJumlahTampil() {
  const select = document.getElementById('perPageSelect');
  if (select) {
    PER_PAGE = parseInt(select.value) || 50;
  }
  currentPage = 1; // Kembali ke halaman 1

  // Gunakan fungsi bawaan yang sudah ada di bagian atas kodemu
  renderTabel();
  renderPaginasi();
}

// Fungsi untuk mengambil daftar OLT dari backend
async function loadOltOptions() {
 try {
        // Karena di input.py: app.register_blueprint(olt_bp, url_prefix='/olt')
        // Dan di olt.py: @olt_bp.route('/')
        const res = await fetch(`${API_BASE}/olt`); 
        
        if (!res.ok) throw new Error("Gagal ambil data OLT");
        
        const data = await res.json();
        const sel = document.getElementById('f-olt');
        if (!sel) return;

        sel.innerHTML = '<option value="">-- Pilih OLT --</option>';
        data.forEach(olt => {
            const opt = document.createElement('option');
            opt.value = olt.id;   // Disimpan sebagai olt_id
            opt.textContent = olt.name; // Nama OLT yang tampil
            sel.appendChild(opt);
        });
        console.log("✅ OLT Load Success:", data);
    } catch (err) {
        console.error("❌ OLT Load Error:", err);
    }
}