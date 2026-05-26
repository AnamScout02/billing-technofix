/**
 * manajemen_user.js — TechnoFix · Halaman Manajemen User & Hak Akses
 * =====================================================================
 * Bergantung pada global.js (harus di-load lebih dulu):
 *   - API_BASE, toast(), escHtml(), getAuthHeaders(), getSession()
 *
 * Fitur:
 *   1. loadUsers()       — muat & render tabel user dari API
 *   2. filterUsers()     — filter tabel secara client-side
 *   3. openFormTambah()  — buka modal form tambah user
 *   4. openFormEdit(id)  — buka modal form edit + isi data + centang permissions
 *   5. submitFormUser()  — POST/PUT ke API
 *   6. openModalHapus()  — konfirmasi nonaktifkan user
 *   7. eksekusiHapus()   — DELETE ke API
 *   8. toggleAktif(id)   — toggle status aktif user
 */

'use strict';

// ── State ──────────────────────────────────────────────────────
let _allUsers      = [];   // data lengkap dari API
let _editUserId    = null; // ID user yang sedang diedit
let _hapusUserId   = null; // ID user yang akan dihapus

// Daftar menu yang bisa diberi hak akses
const MENU_PERMISSIONS = [
  { key: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { key: 'pelanggan',  label: 'Pelanggan',  icon: 'group' },
  { key: 'keuangan',   label: 'Keuangan',   icon: 'payments' },
  { key: 'olt',        label: 'OLT',        icon: 'settings_input_antenna' },
  { key: 'mikrotik',   label: 'MikroTik',   icon: 'router' },
  { key: 'maps',       label: 'Maps',       icon: 'map' },
];


// ══════════════════════════════════════════════════════════════
// 1. LOAD USERS — ambil dari API dan render tabel
// ══════════════════════════════════════════════════════════════

async function loadUsers() {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('spin');

  try {
    const res  = await fetch(`${API_BASE}/api/users`, {
      headers: getAuthHeaders(),
    });
    const data = await res.json();

    if (!res.ok) {
      toast(data.error || 'Gagal memuat data user.', 'danger');
      return;
    }

    _allUsers = Array.isArray(data) ? data : [];
    renderStats();
    renderTable(_allUsers);

  } catch (e) {
    toast('Tidak dapat terhubung ke server.', 'danger');
    console.error('[MU]', e);
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}


// ══════════════════════════════════════════════════════════════
// 2. RENDER STATS
// ══════════════════════════════════════════════════════════════

function renderStats() {
  const total    = _allUsers.length;
  const aktif    = _allUsers.filter(u => u.aktif).length;
  const teknisi  = _allUsers.filter(u => u.role === 'teknisi' || u.role === 'admin').length;

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl('stat-total',   total);
  setEl('stat-aktif',   aktif);
  setEl('stat-teknisi', teknisi);
}


// ══════════════════════════════════════════════════════════════
// 3. RENDER TABEL
// ══════════════════════════════════════════════════════════════

function renderTable(users) {
  const tbody = document.getElementById('tbody-users');
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="mu-empty">
          <span class="material-symbols-outlined">manage_search</span>
          Tidak ada user ditemukan.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => _buildRow(u)).join('');
}

function _buildRow(u) {
  const initials = (u.nama || u.username).slice(0, 2).toUpperCase();
  const roleCls  = u.role === 'owner' ? 'owner' : u.role === 'admin' ? 'admin' : '';

  // Role badge
  const roleLabel = u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin' : 'Teknisi';
  const roleIcon  = u.role === 'owner' ? 'shield_person' : u.role === 'admin' ? 'admin_panel_settings' : 'engineering';

  // Permissions
  let permHtml = '';
  if (u.role === 'owner') {
    permHtml = '<span class="perm-pill all">Semua Akses</span>';
  } else if (!u.permissions || !u.permissions.length) {
    permHtml = '<span class="perm-pill" style="color:var(--red);border-color:var(--red-border);background:var(--red-bg)">Tidak Ada Izin</span>';
  } else {
    permHtml = u.permissions.map(p => {
      const menu = MENU_PERMISSIONS.find(m => m.key === p);
      return `<span class="perm-pill">${escHtml(menu ? menu.label : p)}</span>`;
    }).join('');
  }

  // Status
  const statusCls   = u.aktif ? 'aktif' : 'nonaktif';
  const statusLabel = u.aktif ? 'Aktif' : 'Nonaktif';

  // Action buttons — owner tidak bisa diedit/dihapus dari baris sendiri
  const isOwner = u.role === 'owner';
  const editBtn = `
    <button class="btn-tbl edit" onclick="openFormEdit(${u.id})" title="Edit">
      <span class="material-symbols-outlined">edit</span>
    </button>`;
  const toggleBtn = !isOwner ? `
    <button class="btn-tbl ${u.aktif ? 'hapus' : 'detail'}"
      onclick="toggleAktif(${u.id})"
      title="${u.aktif ? 'Nonaktifkan' : 'Aktifkan'}">
      <span class="material-symbols-outlined">${u.aktif ? 'person_off' : 'person_check'}</span>
    </button>` : '';
  const hapusBtn = !isOwner ? `
    <button class="btn-tbl hapus" onclick="openModalHapus(${u.id}, '${escHtml(u.nama || u.username)}')" title="Hapus">
      <span class="material-symbols-outlined">delete</span>
    </button>` : '';

  return `
    <tr id="row-user-${u.id}">
      <td>
        <div class="mu-user-cell">
          <div class="mu-avatar ${roleCls}">${escHtml(initials)}</div>
          <div>
            <div class="mu-user-name">${escHtml(u.nama || u.username)}</div>
            <div class="mu-user-uname">@${escHtml(u.username)}</div>
          </div>
        </div>
      </td>
      <td>
        <span class="role-badge ${u.role}">
          <span class="material-symbols-outlined" style="font-size:12px;">${roleIcon}</span>
          ${escHtml(roleLabel)}
        </span>
      </td>
      <td>
        <div class="perm-list">${permHtml}</div>
      </td>
      <td>
        <span class="status-badge ${statusCls}">
          <span class="badge-dot"></span>${escHtml(statusLabel)}
        </span>
      </td>
      <td>
        <div class="mu-actions">
          ${editBtn}${toggleBtn}${hapusBtn}
        </div>
      </td>
    </tr>`;
}


// ══════════════════════════════════════════════════════════════
// 4. FILTER CLIENT-SIDE
// ══════════════════════════════════════════════════════════════

function filterUsers() {
  const q      = (document.getElementById('mu-search')?.value || '').toLowerCase();
  const role   = document.getElementById('filter-role')?.value   || '';
  const status = document.getElementById('filter-status')?.value || '';

  const filtered = _allUsers.filter(u => {
    const matchQ = !q ||
      (u.nama     || '').toLowerCase().includes(q) ||
      (u.username || '').toLowerCase().includes(q);

    const matchRole   = !role   || u.role === role;
    const matchStatus = !status ||
      (status === 'aktif'    &&  u.aktif) ||
      (status === 'nonaktif' && !u.aktif);

    return matchQ && matchRole && matchStatus;
  });

  renderTable(filtered);
}


// ══════════════════════════════════════════════════════════════
// 5. BUKA FORM TAMBAH
// ══════════════════════════════════════════════════════════════

function openFormTambah() {
  _editUserId = null;
  _renderModalForm(null);
}


// ══════════════════════════════════════════════════════════════
// 6. BUKA FORM EDIT — isi data + centang permissions otomatis
// ══════════════════════════════════════════════════════════════

function openFormEdit(id) {
  const user = _allUsers.find(u => u.id === id);
  if (!user) { toast('Data user tidak ditemukan.', 'danger'); return; }
  _editUserId = id;
  _renderModalForm(user);
}


// ══════════════════════════════════════════════════════════════
// 7. RENDER MODAL FORM (dipakai tambah & edit)
// ══════════════════════════════════════════════════════════════

function _renderModalForm(user) {
  const isEdit = !!user;
  const title  = isEdit ? 'Edit User' : 'Tambah User Baru';
  const icon   = isEdit ? 'manage_accounts' : 'person_add';

  // Nilai awal form
  const nama     = escHtml(user?.nama        || '');
  const username = escHtml(user?.username    || '');
  const role     = user?.role || 'teknisi';
  const perms    = user?.permissions || [];

  // HTML checklist permissions
  const permChecklist = MENU_PERMISSIONS.map(m => {
    const checked = user?.role === 'owner' || perms.includes(m.key);
    return `
      <label class="perm-check-item${checked ? ' checked' : ''}" id="perm-item-${m.key}"
        onclick="togglePermCheck('${m.key}')">
        <input type="checkbox" name="perm" value="${m.key}" id="perm-cb-${m.key}"
          ${checked ? 'checked' : ''} style="display:none;" />
        <div class="perm-check-box">
          <span class="material-symbols-outlined">check</span>
        </div>
        <div class="perm-check-label">
          ${escHtml(m.label)}
        </div>
      </label>`;
  }).join('');

  const html = `
    <div class="mu-modal" onclick="event.stopPropagation()">
      <div class="mu-modal-head">
        <div class="mu-modal-title">
          <span class="material-symbols-outlined">${icon}</span>
          ${escHtml(title)}
        </div>
        <button class="modal-close" onclick="closeFormUser()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <!-- ── Bagian 1: Data Akun ── -->
      <div class="mu-section-label">Data Akun</div>
      <div class="mu-form-grid">

        <div class="form-group full">
          <label class="form-label">Nama Lengkap <span class="req">*</span></label>
          <input type="text" class="form-input" id="f-nama"
            placeholder="Nama staf" value="${nama}" autocomplete="off" />
        </div>

        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input type="text" class="form-input" id="f-username"
            placeholder="username_staf"
            value="${username}"
            ${isEdit ? 'readonly style="background:var(--surface);color:var(--text-dim);"' : ''}
            autocomplete="off" autocapitalize="none" />
        </div>

        <div class="form-group">
          <label class="form-label">Role <span class="req">*</span></label>
          <select class="form-input" id="f-role" onchange="onRoleChange()">
            <option value="teknisi" ${role === 'teknisi' ? 'selected' : ''}>Teknisi</option>
            <option value="admin"   ${role === 'admin'   ? 'selected' : ''}>Admin</option>
          </select>
        </div>

        <div class="form-group full">
          <label class="form-label">
            Password ${isEdit ? '(kosongkan jika tidak ganti)' : '<span class="req">*</span>'}
          </label>
          <div class="form-pwd-wrap">
            <input type="password" class="form-input" id="f-pass"
              placeholder="${isEdit ? 'Kosongkan jika tidak berubah' : 'Min. 6 karakter'}"
              autocomplete="new-password" />
            <button type="button" class="form-pwd-toggle"
              onclick="togglePwd('f-pass','pwd-eye-f')">
              <span class="material-symbols-outlined" id="pwd-eye-f">visibility</span>
            </button>
          </div>
        </div>

      </div>

      <!-- ── Bagian 2: Hak Akses ── -->
      <div class="mu-section-label" id="perm-section-label"
        style="${role === 'owner' ? 'display:none' : ''}">
        Hak Akses Menu
      </div>
      <div class="perm-grid" id="perm-grid-wrap"
        style="${role === 'owner' ? 'display:none' : ''}">
        ${permChecklist}
      </div>
      <p class="form-hint" id="perm-owner-note"
        style="${role !== 'owner' ? 'display:none' : 'display:block;color:var(--blue);background:var(--blue-bg);border:1px solid var(--blue-border);border-radius:var(--r-sm);padding:8px 11px;font-size:11.5px;margin-top:8px;'}">
        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px;">info</span>
        Owner memiliki akses ke seluruh menu secara otomatis.
      </p>

      <!-- Error hint -->
      <div class="mu-form-hint" id="form-hint"></div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn btn-cancel btn-sm" onclick="closeFormUser()">Batal</button>
        <button class="btn btn-save btn-sm" id="btn-simpan-user" onclick="submitFormUser()">
          <span class="material-symbols-outlined">save</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah User'}
        </button>
      </div>
    </div>`;

  const overlay = document.getElementById('modal-form-overlay');
  if (overlay) {
    overlay.innerHTML = html;
    overlay.classList.add('open');
  }
}

// Toggle centang permission checkbox custom
function togglePermCheck(key) {
  const item = document.getElementById(`perm-item-${key}`);
  const cb   = document.getElementById(`perm-cb-${key}`);
  if (!item || !cb) return;

  cb.checked = !cb.checked;
  item.classList.toggle('checked', cb.checked);
}

// Ketika role berubah — tampilkan/sembunyikan bagian hak akses
function onRoleChange() {
  const role    = document.getElementById('f-role')?.value || 'teknisi';
  const grid    = document.getElementById('perm-grid-wrap');
  const label   = document.getElementById('perm-section-label');
  const note    = document.getElementById('perm-owner-note');
  const isOwner = role === 'owner';

  if (grid)  grid.style.display  = isOwner ? 'none' : '';
  if (label) label.style.display = isOwner ? 'none' : '';
  if (note) {
    note.style.display = isOwner ? 'block' : 'none';
  }
}

function closeFormUser() {
  const overlay = document.getElementById('modal-form-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
  }
  _editUserId = null;
}

function handleOverlayClick(e) {
  if (e.target === e.currentTarget) closeFormUser();
}


// ══════════════════════════════════════════════════════════════
// 8. SUBMIT FORM — POST (tambah) / PUT (edit)
// ══════════════════════════════════════════════════════════════

async function submitFormUser() {
  const nama     = document.getElementById('f-nama')?.value.trim()     || '';
  const username = document.getElementById('f-username')?.value.trim() || '';
  const role     = document.getElementById('f-role')?.value            || 'teknisi';
  const password = document.getElementById('f-pass')?.value.trim()     || '';

  // Kumpulkan permissions yang dicentang
  const permissions = Array.from(
    document.querySelectorAll('#perm-grid-wrap input[name="perm"]:checked')
  ).map(cb => cb.value);

  // Validasi
  const hint = document.getElementById('form-hint');
  function showHint(msg) {
    if (!hint) return;
    hint.textContent  = msg;
    hint.style.display = 'block';
  }
  if (hint) hint.style.display = 'none';

  if (!nama)                                 return showHint('Nama lengkap wajib diisi.');
  if (!username)                             return showHint('Username wajib diisi.');
  if (!_editUserId && password.length < 6)  return showHint('Password minimal 6 karakter.');
  if (_editUserId && password && password.length < 6) return showHint('Password baru minimal 6 karakter.');

  const btn = document.getElementById('btn-simpan-user');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan…'; }

  const body = { nama, role, permissions };
  if (!_editUserId) {
    body.username = username;
    body.password = password;
  } else {
    if (password) body.password = password;
  }

  const url    = _editUserId ? `${API_BASE}/api/users/${_editUserId}` : `${API_BASE}/api/users`;
  const method = _editUserId ? 'PUT' : 'POST';

  try {
    const res  = await fetch(url, {
      method,
      headers: getAuthHeaders(),
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      showHint(data.error || 'Gagal menyimpan data user.');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">save</span> ' + (_editUserId ? 'Simpan Perubahan' : 'Tambah User'); }
      return;
    }

    toast(data.message || 'User berhasil disimpan.', 'success');
    closeFormUser();
    await loadUsers();

  } catch (e) {
    showHint('Tidak dapat terhubung ke server.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">save</span> Simpan'; }
    console.error('[MU submit]', e);
  }
}


// ══════════════════════════════════════════════════════════════
// 9. TOGGLE AKTIF
// ══════════════════════════════════════════════════════════════

async function toggleAktif(id) {
  try {
    const res  = await fetch(`${API_BASE}/api/users/${id}/toggle-aktif`, {
      method:  'POST',
      headers: getAuthHeaders(),
    });
    const data = await res.json();

    if (!res.ok) { toast(data.error || 'Gagal mengubah status.', 'danger'); return; }

    // Update baris tanpa reload penuh
    const idx = _allUsers.findIndex(u => u.id === id);
    if (idx !== -1 && data.user) {
      _allUsers[idx] = data.user;
      const row = document.getElementById(`row-user-${id}`);
      if (row) {
        row.outerHTML = _buildRow(data.user);
      }
      renderStats();
    }
    toast(data.message || 'Status berhasil diubah.', 'success');

  } catch (e) {
    toast('Gagal terhubung ke server.', 'danger');
  }
}


// ══════════════════════════════════════════════════════════════
// 10. HAPUS / NONAKTIFKAN USER
// ══════════════════════════════════════════════════════════════

function openModalHapus(id, nama) {
  _hapusUserId = id;
  const sub = document.getElementById('hapus-sub-text');
  if (sub) sub.textContent = `User "${nama}" akan dinonaktifkan dan tidak dapat login.`;
  const m = document.getElementById('modal-hapus-overlay');
  if (m) m.classList.add('open');
}

function closeModalHapus(e) {
  if (e && e.target !== e.currentTarget) return;
  const m = document.getElementById('modal-hapus-overlay');
  if (m) m.classList.remove('open');
  _hapusUserId = null;
}

async function eksekusiHapus() {
  if (!_hapusUserId) return;

  const btn = document.getElementById('btn-konfirm-hapus');
  if (btn) btn.disabled = true;

  try {
    const res  = await fetch(`${API_BASE}/api/users/${_hapusUserId}`, {
      method:  'DELETE',
      headers: getAuthHeaders(),
    });
    const data = await res.json();

    if (!res.ok) { toast(data.error || 'Gagal menonaktifkan user.', 'danger'); return; }

    toast(data.message || 'User berhasil dinonaktifkan.', 'success');
    closeModalHapus();
    await loadUsers();

  } catch (e) {
    toast('Gagal terhubung ke server.', 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}


// ══════════════════════════════════════════════════════════════
// AUTO-INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
  // Hanya Owner yang boleh akses halaman ini
  if (typeof requireLogin === 'function') {
    const ok = requireLogin({ ownerOnly: true });
    if (!ok) return;
  }

  loadUsers();
});


/* ════════════════════════════════════════════════════════════
   TAMBAHAN GLOBAL.JS — Fungsi applyUIPermissions()
   ═══════════════════════════════════════════════════════════
   CATATAN INTEGRASI:
   Tambahkan fungsi di bawah ini ke global.js (bagian bawah),
   dan panggil applyUIPermissions() di setiap halaman setelah
   DOM siap dan user sudah login.

   Cara pakai di tiap halaman:
     document.addEventListener('DOMContentLoaded', () => {
       applyUIPermissions();
     });

   Cara tandai elemen di HTML:
     <a href="..." data-perm="keuangan">Keuangan</a>
     <a href="..." data-perm="olt">OLT</a>
     <button data-perm="pelanggan">Tambah Pelanggan</button>

   Atau gunakan class nav-keuangan, nav-olt, dll. yang sudah
   ada di applyRbacUi() untuk backward-compatibility.
   ════════════════════════════════════════════════════════════ */

/**
 * applyUIPermissions()
 * ─────────────────────
 * Baca permissions user dari localStorage dan sembunyikan elemen
 * menu/tombol yang tidak ada dalam daftar izin user tersebut.
 *
 * Alur:
 * 1. Baca session: role + permissions dari localStorage.
 * 2. Jika role = 'owner' → tampilkan SEMUA elemen (owner bypass).
 * 3. Untuk role lain → sembunyikan elemen yang data-perm-nya
 *    tidak ada dalam array permissions user.
 * 4. Tambahkan badge role di elemen #role-badge (jika ada).
 *
 * Integrasi dengan global.js yang sudah ada:
 * Fungsi ini melengkapi applyRbacUi() yang mengontrol elemen
 * berdasarkan owner/non-owner. applyUIPermissions() lebih
 * granular: per-menu, berdasarkan data permissions dari DB.
 */
function applyUIPermissions() {
  // Baca data sesi
  const session     = (typeof getSession === 'function') ? getSession() : {};
  const role        = session.role        || localStorage.getItem('tf_role')        || '';
  const permsRaw    = session.permissions || localStorage.getItem('tf_permissions') || '[]';

  let permissions = [];
  try {
    const parsed = JSON.parse(permsRaw);
    permissions  = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    permissions = [];
  }

  const isOwner = role === 'owner';

  // ── 1. Elemen dengan atribut [data-perm] ──
  document.querySelectorAll('[data-perm]').forEach(function (el) {
    const perm = el.getAttribute('data-perm');
    if (!perm) return;

    if (isOwner) {
      el.classList.remove('d-none');
      el.style.display = '';
    } else {
      const hasAccess = permissions.includes(perm);
      el.classList.toggle('d-none', !hasAccess);
      if (!hasAccess) el.style.display = 'none';
      else            el.style.display = '';
    }
  });

  // ── 2. Nav items berdasarkan perm-key class (.nav-keuangan, .nav-olt, .nav-maps, dll.) ──
  const NAV_PERM_MAP = {
    'nav-keuangan':  'keuangan',
    'nav-olt':       'olt',
    'nav-mikrotik':  'mikrotik',
    'nav-maps':      'maps',
    'nav-pelanggan': 'pelanggan',
  };

  Object.keys(NAV_PERM_MAP).forEach(function (cls) {
    const perm = NAV_PERM_MAP[cls];
    document.querySelectorAll('.' + cls).forEach(function (el) {
      if (isOwner) {
        el.classList.remove('d-none');
        el.style.display = '';
      } else {
        const hasAccess = permissions.includes(perm);
        el.classList.toggle('d-none', !hasAccess);
        if (!hasAccess) el.style.display = 'none';
        else            el.style.display = '';
      }
    });
  });

  // ── 3. Badge role di header ──
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.textContent = isOwner ? 'Owner' : (role === 'admin' ? 'Admin' : 'Teknisi');
    roleBadge.style.background  = isOwner
      ? 'var(--primary-light)' : role === 'admin'
      ? 'var(--amber-bg)' : 'var(--surface-2)';
    roleBadge.style.color       = isOwner ? 'var(--primary)' : role === 'admin' ? 'var(--amber)' : 'var(--text-dim)';
    roleBadge.style.borderColor = isOwner ? 'rgba(0,64,161,.2)' : role === 'admin' ? 'var(--amber-border)' : 'var(--border)';
  }

  // ── 4. Halaman-halaman yang memerlukan permission khusus:
  //       Jika user buka langsung, cek URL dan redirect jika tidak punya akses ──
  const PAGE_PERM_MAP = {
    '/keuangan/':       'keuangan',
    '/olt/':            'olt',
    '/mikrotik/':       'mikrotik',
    '/maps/':           'maps',
    '/pelanggan/':      'pelanggan',
    '/manajemen_user/': null, // selalu butuh owner — ditangani requireLogin
  };

  if (!isOwner) {
    const pathname = window.location.pathname;
    for (const [path, perm] of Object.entries(PAGE_PERM_MAP)) {
      if (perm && pathname.includes(path) && !permissions.includes(perm)) {
        if (typeof toast === 'function') {
          toast(`Akses ke halaman ini tidak diizinkan.`, 'danger');
        }
        setTimeout(function () {
          window.location.href = '/app/frontend/dashboard/dashboard.html';
        }, 1500);
        break;
      }
    }
  }
}

// Simpan permissions ke localStorage setelah login berhasil.
// Panggil ini dari auth.js / halaman login setelah dapat response sukses:
//   savePermissions(data.user.permissions);
function savePermissions(permissions) {
  if (!Array.isArray(permissions)) permissions = [];
  localStorage.setItem('tf_permissions', JSON.stringify(permissions));
}

// Expose ke global
window.applyUIPermissions = applyUIPermissions;
window.savePermissions    = savePermissions;


/* ════════════════════════════════════════════════════════════
   PATCH global.js — DOMContentLoaded auto-init
   ═══════════════════════════════════════════════════════════
   Tambahkan dua baris berikut di dalam blok DOMContentLoaded
   yang sudah ada di global.js (di bagian paling bawah):

   document.addEventListener('DOMContentLoaded', function () {
     const isAuthPage = window.location.pathname.includes('auth');
     if (!isAuthPage && localStorage.getItem('tf_token')) {
       initProfileHeader();
       applyRbacUi();
       applyUIPermissions();   // <-- TAMBAHKAN INI
     }
   });
   ════════════════════════════════════════════════════════════ */