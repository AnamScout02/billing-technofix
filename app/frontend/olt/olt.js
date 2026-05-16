/* ============================================================
   olt.js — Manajemen Perangkat OLT TechnoFix
   Terhubung ke input.py (Flask) via fetch()

   Endpoint yang dipakai:
   GET    /olt              → daftar semua OLT
   POST   /olt              → tambah OLT baru
   PUT    /olt/<id>         → edit OLT
   DELETE /olt/<id>         → hapus OLT
   POST   /olt/<id>/sync    → tes koneksi ulang
   ============================================================ */

'use strict';

const API_BASE = 'http://localhost:5000';

/* ── STATE ── */
let semuaOlt    = [];   // data mentah dari API
let filteredOlt = [];   // setelah filter/search
let editingId   = null; // null = tambah baru, number = id yang diedit
let hapusTarget = null; // { id, nama }


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  loadOlt();
});


/* ══════════════════════════════════════════════════════════
   1. LOAD SEMUA OLT
   GET /olt
══════════════════════════════════════════════════════════ */
async function loadOlt() {
  tampilLoading();
  animRefresh(true);

  try {
    const res  = await fetch(`${API_BASE}/olt`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.message || 'Gagal memuat data');

    semuaOlt = Array.isArray(data) ? data : (data.devices || []);
    updateStats();
    updateFilterTipe();
    filterOlt();

  } catch (err) {
    tampilError(err.message);
  } finally {
    animRefresh(false);
  }
}


/* ══════════════════════════════════════════════════════════
   2. FILTER + SEARCH
══════════════════════════════════════════════════════════ */
function filterOlt() {
  const keyword = document.getElementById('input-search').value.toLowerCase().trim();
  const status  = document.getElementById('filter-status').value;
  const tipe    = document.getElementById('filter-tipe').value;

  filteredOlt = semuaOlt.filter(d => {
    const matchKeyword =
      !keyword ||
      (d.name     || '').toLowerCase().includes(keyword) ||
      (d.ip       || '').toLowerCase().includes(keyword) ||
      (d.lokasi   || '').toLowerCase().includes(keyword) ||
      (d.tipe     || '').toLowerCase().includes(keyword);

    const matchStatus = !status || d.status === status;
    const matchTipe   = !tipe   || d.tipe   === tipe;

    return matchKeyword && matchStatus && matchTipe;
  });

  renderKartu();
}


/* ══════════════════════════════════════════════════════════
   3. RENDER KARTU OLT
══════════════════════════════════════════════════════════ */
function renderKartu() {
  const wrap = document.getElementById('olt-list');
  sembunyikanState();

  if (filteredOlt.length === 0) {
    wrap.innerHTML = '';
    tampilEmpty();
    return;
  }

  document.getElementById('device-count').textContent =
    `${filteredOlt.length} perangkat`;

  wrap.innerHTML = filteredOlt.map((d, idx) => {
    const statusClass = d.status === 'connected' ? 'status-connected'
                      : d.status === 'failed'    ? 'status-failed'
                      : 'status-pending';

    const badgeClass  = d.status === 'connected' ? 'badge-connected'
                      : d.status === 'failed'    ? 'badge-failed'
                      : 'badge-pending';

    const badgeLabel  = d.status === 'connected' ? 'Terhubung'
                      : d.status === 'failed'    ? 'Gagal'
                      : 'Pending';

    const tipe = d.tipe || 'OLT';

    return `
      <div class="olt-card ${statusClass}" style="animation-delay:${idx * 40}ms" id="olt-card-${d.id}">

        <!-- Ikon -->
        <div class="olt-card-icon">
          <span class="material-symbols-outlined">cell_tower</span>
        </div>

        <!-- Info -->
        <div class="olt-card-info">
          <div class="olt-card-top">
            <span class="olt-card-name">${escHtml(d.name)}</span>
            <span class="olt-tipe-badge">${escHtml(tipe)}</span>
            <span class="status-badge ${badgeClass}" id="badge-${d.id}">
              <span class="status-badge-dot"></span>
              ${badgeLabel}
            </span>
          </div>

          <div class="olt-card-meta">
            <span class="olt-meta-item">
              <span class="material-symbols-outlined mat-icon">dns</span>
              ${escHtml(d.ip)}:${escHtml(String(d.port || 23))}
            </span>
            <span class="olt-meta-item">
              <span class="material-symbols-outlined mat-icon">person</span>
              ${escHtml(d.username)}
            </span>
            ${d.snmp ? `
            <span class="olt-meta-item">
              <span class="material-symbols-outlined mat-icon">key</span>
              ${escHtml(d.snmp)}
            </span>` : ''}
            ${d.lokasi ? `
            <span class="olt-lokasi">
              <span class="material-symbols-outlined" style="font-size:13px;color:#94a3b8">location_on</span>
              ${escHtml(d.lokasi)}
            </span>` : ''}
          </div>

          ${d.keterangan ? `
          <p style="font-size:11px;color:#94a3b8;margin-top:5px;font-style:italic">
            ${escHtml(d.keterangan)}
          </p>` : ''}
        </div>

        <!-- Aksi -->
        <div class="olt-actions">
          <button class="olt-btn sync" id="sync-btn-${d.id}"
            onclick="syncOlt(${d.id})" title="Sinkronisasi">
            <span class="material-symbols-outlined mat-icon" id="sync-icon-${d.id}">sync</span>
          </button>
          <button class="olt-btn edit"
            onclick="openEdit(${d.id})" title="Edit">
            <span class="material-symbols-outlined mat-icon">edit</span>
          </button>
          <button class="olt-btn hapus"
            onclick="openHapus(${d.id}, '${escHtml(d.name)}')" title="Hapus">
            <span class="material-symbols-outlined mat-icon">delete</span>
          </button>
        </div>

      </div>`;
  }).join('');
}


/* ══════════════════════════════════════════════════════════
   4. STATS
══════════════════════════════════════════════════════════ */
function updateStats() {
  const total     = semuaOlt.length;
  const connected = semuaOlt.filter(d => d.status === 'connected').length;
  const failed    = semuaOlt.filter(d => d.status === 'failed').length;
  const pending   = semuaOlt.filter(d => d.status === 'pending').length;

  animNum('stat-total',     total);
  animNum('stat-connected', connected);
  animNum('stat-failed',    failed);
  animNum('stat-pending',   pending);
}

function animNum(id, target) {
  const el    = document.getElementById(id);
  const from  = parseInt(el.textContent) || 0;
  const dur   = 500;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / dur, 1);
    el.textContent = Math.round(from + (target - from) * t);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}


/* ══════════════════════════════════════════════════════════
   5. UPDATE FILTER TIPE dari data
══════════════════════════════════════════════════════════ */
function updateFilterTipe() {
  const tipes = [...new Set(semuaOlt.map(d => d.tipe).filter(Boolean))].sort();
  const sel   = document.getElementById('filter-tipe');
  // Simpan pilihan lama
  const prev  = sel.value;
  sel.innerHTML = '<option value="">Semua Tipe</option>';
  tipes.forEach(t => sel.appendChild(new Option(t, t)));
  if (prev) sel.value = prev;
}


/* ══════════════════════════════════════════════════════════
   6. MODAL TAMBAH
══════════════════════════════════════════════════════════ */
function openModalTambah() {
  editingId = null;
  document.getElementById('modal-olt-title').textContent = 'Tambah Perangkat OLT';
  resetForm();
  bukaModal('modal-olt');
}

function resetForm() {
  ['f-nama','f-ip','f-username','f-password',
   'f-snmp','f-lokasi','f-keterangan'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-port').value = '23';
  // Reset password visibility
  document.getElementById('f-password').type = 'password';
  document.getElementById('pwd-eye').textContent = 'visibility';
}


/* ══════════════════════════════════════════════════════════
   7. MODAL EDIT
══════════════════════════════════════════════════════════ */
function openEdit(id) {
  const d = semuaOlt.find(x => x.id === id);
  if (!d) return;

  editingId = id;
  document.getElementById('modal-olt-title').textContent = 'Edit Perangkat OLT';

  document.getElementById('f-nama').value       = d.name      || '';
  document.getElementById('f-ip').value         = d.ip        || '';
  document.getElementById('f-port').value       = d.port      || 23;
  document.getElementById('f-username').value   = d.username  || '';
  document.getElementById('f-password').value   = '';           // kosong = tidak ubah
  document.getElementById('f-snmp').value       = d.snmp      || '';
  document.getElementById('f-lokasi').value     = d.lokasi    || '';
  document.getElementById('f-keterangan').value = d.keterangan || '';

  bukaModal('modal-olt');
}


/* ══════════════════════════════════════════════════════════
   8. SIMPAN OLT
   POST /olt        → tambah
   PUT  /olt/<id>   → edit
══════════════════════════════════════════════════════════ */
async function simpanOlt() {
  const nama       = document.getElementById('f-nama').value.trim();
  const ip         = document.getElementById('f-ip').value.trim();
  const port       = document.getElementById('f-port').value || '23';
  const username   = document.getElementById('f-username').value.trim();
  const password   = document.getElementById('f-password').value.trim();
  const snmp       = document.getElementById('f-snmp').value.trim();
  const lokasi     = document.getElementById('f-lokasi').value.trim();
  const keterangan = document.getElementById('f-keterangan').value.trim();

  // Validasi
  if (!nama)                       { showToast('Nama OLT wajib diisi', 'err'); return; }
  if (!ip)                         { showToast('IP Address wajib diisi', 'err'); return; }
  if (!username)                   { showToast('Username wajib diisi', 'err'); return; }
  if (!editingId && !password)     { showToast('Password wajib diisi', 'err'); return; }

  // Validasi format IP
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) { showToast('Format IP address tidak valid', 'err'); return; }

  const btn = document.getElementById('btn-save-olt');
  btn.disabled = true;
  btn.innerHTML = `<span class="material-symbols-outlined spinning" style="font-size:18px">sync</span> Menyimpan...`;

  const payload = {
    name: nama, tipe, ip,
    port: parseInt(port),
    username, snmp, lokasi, keterangan,
  };
  if (password) payload.password = password;

  try {
    const method = editingId ? 'PUT'  : 'POST';
    const url    = editingId
      ? `${API_BASE}/olt/${editingId}`
      : `${API_BASE}/olt`;

    const res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.status === 'error') throw new Error(data.message);

    tutupModalOlt();

    const pesan = editingId
      ? `✓ ${nama} berhasil diperbarui`
      : `✓ ${nama} berhasil ditambahkan`;
    showToast(pesan, 'ok');

    await loadOlt();

  } catch (err) {
    showToast('✗ ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px">save</span> Simpan Perangkat`;
  }
}


/* ══════════════════════════════════════════════════════════
   9. SINKRONISASI / TES KONEKSI
   POST /olt/<id>/sync
══════════════════════════════════════════════════════════ */
async function syncOlt(id) {
  const btn  = document.getElementById(`sync-btn-${id}`);
  const icon = document.getElementById(`sync-icon-${id}`);
  const badge = document.getElementById(`badge-${id}`);
  const card  = document.getElementById(`olt-card-${id}`);

  // Loading state
  if (btn)  btn.disabled = true;
  if (icon) icon.classList.add('spinning');
  if (badge) {
    badge.className   = 'status-badge badge-syncing';
    badge.innerHTML   = '<span class="status-badge-dot"></span>Menyinkron...';
  }

  try {
    const res  = await fetch(`${API_BASE}/olt/${id}/sync`, { method: 'POST' });
    const data = await res.json();

    const ok      = data.connected === true;
    const d       = semuaOlt.find(x => x.id === id);
    if (d) d.status = ok ? 'connected' : 'failed';

    // Update badge
    if (badge) {
      badge.className = `status-badge ${ok ? 'badge-connected' : 'badge-failed'}`;
      badge.innerHTML = `<span class="status-badge-dot"></span>${ok ? 'Terhubung' : 'Gagal'}`;
    }

    // Update border card
    if (card) {
      card.classList.remove('status-connected', 'status-failed', 'status-pending');
      card.classList.add(ok ? 'status-connected' : 'status-failed');
    }

    showToast(
      ok
        ? `✓ ${d?.name || 'OLT'} berhasil terhubung`
        : `✗ Gagal terhubung ke ${d?.name || 'OLT'}. Periksa IP & kredensial`,
      ok ? 'ok' : 'err'
    );

    updateStats();

  } catch (err) {
    showToast('✗ ' + err.message, 'err');
    if (badge) {
      badge.className = 'status-badge badge-failed';
      badge.innerHTML = '<span class="status-badge-dot"></span>Gagal';
    }
  } finally {
    if (btn)  btn.disabled = false;
    if (icon) icon.classList.remove('spinning');
  }
}


/* ══════════════════════════════════════════════════════════
   10. HAPUS OLT
   DELETE /olt/<id>
══════════════════════════════════════════════════════════ */
function openHapus(id, nama) {
  hapusTarget = { id, nama };
  document.getElementById('hapus-nama').textContent = nama;
  bukaModal('modal-hapus');
}

async function konfirmasiHapus() {
  if (!hapusTarget) return;

  try {
    const res  = await fetch(`${API_BASE}/olt/${hapusTarget.id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.status === 'error') throw new Error(data.message);

    tutupModalHapus();
    showToast(`🗑 ${hapusTarget.nama} berhasil dihapus`, 'ok');
    hapusTarget = null;
    await loadOlt();

  } catch (err) {
    showToast('✗ ' + err.message, 'err');
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Modal
══════════════════════════════════════════════════════════ */
function bukaModal(id)  { document.getElementById(id).classList.add('open'); }
function tutupModal(id) { document.getElementById(id).classList.remove('open'); }

function tutupModalOlt()  { tutupModal('modal-olt'); }
function tutupModalHapus(){ tutupModal('modal-hapus'); }

function closeModalOlt(e)  { if (e.target.id === 'modal-olt')  tutupModalOlt();  }
function closeModalHapus(e){ if (e.target.id === 'modal-hapus') tutupModalHapus();}


/* ══════════════════════════════════════════════════════════
   HELPERS — Password toggle
══════════════════════════════════════════════════════════ */
function togglePwd() {
  const inp  = document.getElementById('f-password');
  const icon = document.getElementById('pwd-eye');
  if (inp.type === 'password') {
    inp.type = 'text'; icon.textContent = 'visibility_off';
  } else {
    inp.type = 'password'; icon.textContent = 'visibility';
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — UI States
══════════════════════════════════════════════════════════ */
function sembunyikanState() {
  ['state-loading', 'state-empty', 'state-error'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.add('hidden');
    el.classList.remove('flex');
  });
}
function tampilState(id) {
  sembunyikanState();
  document.getElementById('olt-list').innerHTML = '';
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function tampilLoading() { tampilState('state-loading'); }
function tampilEmpty()   { tampilState('state-empty');   }
function tampilError(msg){
  tampilState('state-error');
  document.getElementById('error-msg').textContent = msg;
}

function animRefresh(on) {
  // Opsional: jika ada tombol refresh di header
  const icon = document.querySelector('#btn-refresh-icon');
  if (!icon) return;
  icon.classList.toggle('spinning', on);
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Toast
══════════════════════════════════════════════════════════ */
function showToast(msg, type) {
  const t    = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  const msgEl = document.getElementById('toast-msg');

  msgEl.textContent       = msg;
  icon.textContent        = type === 'ok' ? 'check_circle' : 'error';
  t.style.background      = type === 'ok' ? '#14532d' : '#7f1d1d';
  t.className = 'toast-show fixed bottom-6 left-1/2 z-50 flex items-center gap-2.5 px-5 py-3 rounded-2xl text-white text-sm font-semibold shadow-xl pointer-events-none whitespace-nowrap transition-all duration-300';

  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.className = 'toast-hidden fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-5 py-3 rounded-2xl text-white text-sm font-semibold shadow-xl pointer-events-none whitespace-nowrap transition-all duration-300';
  }, 3200);
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Sanitasi XSS
══════════════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}