/**
 * auth.js — TechnoFix · Autentikasi Frontend
 * ============================================
 * Bergantung pada global.js (harus di-load lebih dulu):
 *   - API_BASE  → base URL server
 *   - toast()   → notifikasi
 *   - escHtml() → sanitasi string
 *
 * Menangani:
 *   1. Cek session aktif → redirect dashboard jika sudah login
 *   2. Toggle tab Login ↔ Daftar ISP
 *   3. Submit form Login  (POST /api/auth/login)
 *   4. Submit form Register (POST /api/auth/register)
 *   5. Simpan data user ke localStorage setelah login
 *   6. Redirect ke dashboard setelah login berhasil
 *   7. doLogout() — dipanggil dari navbar halaman lain
 *   8. initRBAC() — pembatasan menu berdasarkan role (dipanggil tiap halaman)
 *
 * KEY localStorage:
 *   technofix_user → JSON { id, username, role, network_id, isp_name }
 */

'use strict';

// ── Konstanta ─────────────────────────────────────────────────
const STORAGE_KEY   = 'technofix_user';
const DASHBOARD_URL = '/app/frontend/dashboard/dashboard.html';
const AUTH_URL      = '/app/frontend/auth/auth.html';

// API_BASE sudah tersedia dari global.js
// Endpoint auth
const AUTH_API = `${API_BASE}/api/auth`;


// ══════════════════════════════════════════════════════════════
// 1. CEK SESSION — jika sudah login, langsung redirect
// ══════════════════════════════════════════════════════════════

(async function checkExistingSession() {
  const stored = getStoredUser();
  if (!stored) return; // Belum pernah login, tampilkan form

  // Verifikasi ke server — session cookie masih valid?
  try {
    const res = await fetch(`${AUTH_API}/me`, { credentials: 'include' });
    if (res.ok) {
      window.location.replace(DASHBOARD_URL);
    } else {
      clearStoredUser();
    }
  } catch {
    clearStoredUser();
  }
})();


// ══════════════════════════════════════════════════════════════
// 2. TOGGLE TAB
// ══════════════════════════════════════════════════════════════

/**
 * Pindah antara panel Login dan Daftar ISP.
 * @param {'login'|'register'} tab
 */
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => {
    const active = t.id === `tab-${tab}`;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.auth-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tab}`);
  });

  // Bersihkan alert saat pindah tab
  hideAlert('login');
  hideAlert('register');
}


// ══════════════════════════════════════════════════════════════
// 3. SUBMIT LOGIN
// ══════════════════════════════════════════════════════════════

/**
 * Kirim form login ke POST /api/auth/login.
 * @param {SubmitEvent} event
 */
async function submitLogin(event) {
  if (event && event.preventDefault) event.preventDefault();
  hideAlert('login');

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  if (!username || !password) {
    showAlert('login', 'error', 'Username dan password wajib diisi');
    return;
  }

  const btn = document.getElementById('btn-login');
  setButtonLoading(btn, true, 'Memproses...');

  try {
    const res  = await fetch(`${AUTH_API}/login`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:        JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      saveStoredUser(data.user);
      showAlert('login', 'success', `Selamat datang, ${escHtml(data.user.username)}! Mengalihkan...`);
      setTimeout(() => window.location.replace(DASHBOARD_URL), 700);

    } else {
      showAlert('login', 'error', data.message || 'Login gagal. Periksa username dan password.');
      setButtonLoading(btn, false, 'Masuk', 'login');
    }

  } catch (err) {
    console.error('[Auth] Login error:', err);
    showAlert('login', 'error', 'Tidak dapat terhubung ke server. Periksa koneksi Anda.');
    setButtonLoading(btn, false, 'Masuk', 'login');
  }
}


// ══════════════════════════════════════════════════════════════
// 4. SUBMIT REGISTER ISP
// ══════════════════════════════════════════════════════════════

/**
 * Kirim form pendaftaran ISP baru ke POST /api/auth/register.
 * @param {SubmitEvent} event
 */
async function submitRegister(event) {
  if (event && event.preventDefault) event.preventDefault();
  hideAlert('register');

  const isp_name  = document.getElementById('reg-isp-name').value.trim();
  const username  = document.getElementById('reg-username').value.trim();
  const password  = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password-confirm').value;

  if (!isp_name) {
    showAlert('register', 'error', 'Nama ISP wajib diisi');
    return;
  }
  if (!username) {
    showAlert('register', 'error', 'Username Owner wajib diisi');
    return;
  }
  if (password.length < 6) {
    showAlert('register', 'error', 'Password minimal 6 karakter');
    return;
  }
  if (password !== password2) {
    showAlert('register', 'error', 'Konfirmasi password tidak cocok');
    return;
  }

  const btn = document.getElementById('btn-register');
  setButtonLoading(btn, true, 'Mendaftarkan...');

  try {
    const res  = await fetch(`${AUTH_API}/register`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:        JSON.stringify({ isp_name, username, password }),
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      showAlert('register', 'success',
        `ISP "${escHtml(isp_name)}" berhasil didaftarkan! Silakan login dengan akun Owner Anda.`
      );
      document.getElementById('form-register').reset();
      setTimeout(() => switchTab('login'), 1500);

    } else {
      showAlert('register', 'error', data.message || 'Pendaftaran gagal. Coba lagi.');
    }

  } catch (err) {
    console.error('[Auth] Register error:', err);
    showAlert('register', 'error', 'Tidak dapat terhubung ke server. Periksa koneksi Anda.');
  } finally {
    setButtonLoading(btn, false, 'Daftarkan ISP', 'business');
  }
}


// ══════════════════════════════════════════════════════════════
// 5. LOGOUT — dipanggil dari navbar di halaman lain
// ══════════════════════════════════════════════════════════════

/**
 * Kirim request logout, bersihkan localStorage, redirect ke halaman auth.
 *
 * Cara pasang di tombol Logout di navbar (pelanggan.html, dll.):
 *   <a href="#" class="profile-menu-item logout"
 *      onclick="doLogout(); return false">
 *     <span class="material-symbols-outlined">logout</span>Logout
 *   </a>
 */
async function doLogout() {
  try {
    await fetch(`${AUTH_API}/logout`, {
      method:      'POST',
      credentials: 'include',
    });
  } catch {
    // Abaikan error jaringan — tetap bersihkan lokal
  }
  clearStoredUser();
  toast('Berhasil logout. Sampai jumpa!', 'info', 2000);
  setTimeout(() => window.location.replace(AUTH_URL), 600);
}

window.doLogout = doLogout;


// ══════════════════════════════════════════════════════════════
// 6. HELPER — localStorage
// ══════════════════════════════════════════════════════════════

/** Simpan data user setelah login berhasil. */
function saveStoredUser(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));

  // Key individual yang dibaca oleh getSession() di global.js
  localStorage.setItem('tf_token',      user.id       || user.username || 'active');
  localStorage.setItem('tf_user_id',    String(user.id        || ''));
  localStorage.setItem('tf_username',   user.username  || '');
  localStorage.setItem('tf_role',       user.role      || '');
  localStorage.setItem('tf_network_id', user.network_id || '');
  localStorage.setItem('tf_isp_name',   user.isp_name  || '');

  // permissions — dipakai applyUIPermissions()
  if (user && Array.isArray(user.permissions)) {
    localStorage.setItem('tf_permissions', JSON.stringify(user.permissions));
  } else {
    localStorage.setItem('tf_permissions', '[]');
  }
}

/** Ambil data user dari localStorage. */
function getStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Hapus data user dari localStorage (saat logout / session expired). */
function clearStoredUser() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('tf_token');
  localStorage.removeItem('tf_user_id');
  localStorage.removeItem('tf_username');
  localStorage.removeItem('tf_role');
  localStorage.removeItem('tf_network_id');
  localStorage.removeItem('tf_isp_name');
  localStorage.removeItem('tf_permissions');
}

// Expose agar bisa dipakai di halaman lain
window.getStoredUser   = getStoredUser;
window.clearStoredUser = clearStoredUser;
window.saveStoredUser  = saveStoredUser;


// ══════════════════════════════════════════════════════════════
// 7. HELPER — UI feedback inline
// ══════════════════════════════════════════════════════════════

/**
 * Tampilkan alert di dalam kartu form.
 * @param {'login'|'register'} form
 * @param {'error'|'success'} type
 * @param {string} message
 */
function showAlert(form, type, message) {
  // Support dua format ID: alert-{form} dan {form}-alert
  const el  = document.getElementById(`alert-${form}`) || document.getElementById(`${form}-alert`);
  const msg = document.getElementById(`alert-${form}-msg`) || document.getElementById(`${form}-alert-msg`);
  if (!el) return;

  el.className     = `auth-alert show ${type}`;
  if (msg) msg.innerHTML = message;
}

function hideAlert(form) {
  const el = document.getElementById(`alert-${form}`) || document.getElementById(`${form}-alert`);
  if (el) el.className = 'auth-alert';
}

/**
 * Set state loading pada tombol submit.
 * @param {HTMLButtonElement} btn
 * @param {boolean} loading
 * @param {string} label    - teks tombol
 * @param {string} [icon]   - nama Material Symbol
 */
function setButtonLoading(btn, loading, label, icon = 'check') {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  const iconEl = btn.querySelector('.material-symbols-outlined');
  if (iconEl) iconEl.textContent = loading ? 'progress_activity' : icon;
  // Update teks label (text node setelah icon)
  const textNode = [...btn.childNodes].find(n =>
    n.nodeType === Node.TEXT_NODE && n.textContent.trim()
  );
  if (textNode) textNode.textContent = ` ${label}`;
}

/**
 * Toggle visibilitas input password.
 * Versi ini pakai referensi elemen langsung (berbeda dari togglePwd() di global.js
 * yang pakai ID string — keduanya bisa hidup berdampingan).
 * @param {string} inputId
 * @param {HTMLButtonElement} btn
 */
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const icon  = btn ? btn.querySelector('.material-symbols-outlined') : null;
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.textContent = 'visibility_off';
  } else {
    input.type = 'password';
    if (icon) icon.textContent = 'visibility';
  }
}

// Expose ke global (onclick di HTML)
window.switchTab      = switchTab;
window.submitLogin    = submitLogin;
window.submitRegister = submitRegister;
window.togglePassword = togglePassword;


// ══════════════════════════════════════════════════════════════
// 8. RBAC — Pembatasan menu berdasarkan role
//    Tambahkan fungsi ini ke global.js ATAU panggil dari auth.js
//    yang sudah di-load di setiap halaman.
// ══════════════════════════════════════════════════════════════

/**
 * initRBAC() — panggil di DOMContentLoaded setiap halaman app.
 *
 * Yang dilakukan:
 *   1. Cek localStorage. Jika tidak ada → redirect ke login.
 *   2. Sembunyikan elemen [data-role="owner"] dari Teknisi.
 *   3. Isi username & inisial avatar di header.
 *   4. Isi nama ISP di .brand-sub.
 *
 * Cara pakai di setiap halaman:
 *   <script>
 *     document.addEventListener('DOMContentLoaded', () => initRBAC());
 *   </script>
 *
 * Cara tandai elemen Owner-only di HTML:
 *   <a href="/keuangan" data-role="owner">Keuangan</a>
 *   <button data-role="owner">Manajemen Tim</button>
 *
 * @returns {{ id, username, role, network_id, isp_name }|void}
 */
function initRBAC() {
  const user = getStoredUser();

  if (!user) {
    // Tidak ada data lokal → paksa ke halaman login
    // (server juga akan tolak request via @login_required)
    window.location.replace(AUTH_URL);
    return;
  }

  // ── Sembunyikan elemen berdasarkan role ──────────────────
  applyRBAC(user.role);

  // ── Isi username & avatar di header ──────────────────────
  const usernameEl = document.getElementById('profile-username');
  const avatarEl   = document.getElementById('avatar-initials');

  if (usernameEl) usernameEl.textContent = user.username;
  if (avatarEl)   avatarEl.textContent   = user.username.slice(0, 2).toUpperCase();

  // ── Isi nama ISP di brand-sub ─────────────────────────────
  const brandSubEl = document.querySelector('.brand-sub');
  if (brandSubEl && user.isp_name) {
    brandSubEl.textContent = user.isp_name;
  }

  // ── Badge role di profil dropdown (jika ada elemen-nya) ──
  const roleBadgeEl = document.getElementById('profile-role');
  if (roleBadgeEl) {
    roleBadgeEl.textContent = user.role === 'owner' ? '👑 Owner' : '🔧 Teknisi';
  }

  return user;
}

/**
 * applyRBAC() — sembunyikan elemen berdasarkan role.
 *
 * Aturan:
 *   [data-role="owner"]   → hanya Owner yang bisa melihat
 *   [data-role="teknisi"] → hanya Teknisi yang bisa melihat
 *
 * @param {'owner'|'teknisi'} role
 */
function applyRBAC(role) {
  if (role !== 'owner') {
    // Sembunyikan semua elemen Owner-only dari Teknisi
    document.querySelectorAll('[data-role="owner"]').forEach(el => {
      el.style.display = 'none';
    });
  }

  if (role !== 'teknisi') {
    // Sembunyikan semua elemen Teknisi-only dari Owner (jarang, tapi disiapkan)
    document.querySelectorAll('[data-role="teknisi"]').forEach(el => {
      el.style.display = 'none';
    });
  }
}

window.initRBAC  = initRBAC;
window.applyRBAC = applyRBAC;


// ══════════════════════════════════════════════════════════════
//
//  PANDUAN MIGRASI — Halaman yang sudah ada (pelanggan.html, dll.)
//  ──────────────────────────────────────────────────────────────
//
//  LANGKAH 1 — Tandai menu Owner-only dengan data-role="owner"
//
//  Di topbar-nav (sembunyikan dari Teknisi):
//    <a href="#" data-role="owner">
//      <span class="material-symbols-outlined">payments</span>Keuangan
//    </a>
//    <a href="#" data-role="owner">
//      <span class="material-symbols-outlined">settings</span>Pengaturan
//    </a>
//
//  Di bottom-nav mobile:
//    <a href="#" class="bottom-nav-item" data-role="owner">
//      <div class="bottom-nav-icon">
//        <span class="material-symbols-outlined">payments</span>
//      </div>
//      <span class="bottom-nav-label">Keuangan</span>
//    </a>
//
//  Tombol sensitif:
//    <button class="btn-primary" data-role="owner" onclick="...">
//      Manajemen Tim
//    </button>
//
//  LANGKAH 2 — Pasang tombol Logout di profile-dropdown:
//    <a href="#" class="profile-menu-item logout"
//       onclick="doLogout(); return false">
//      <span class="material-symbols-outlined">logout</span>Logout
//    </a>
//
//  LANGKAH 3 — Panggil initRBAC() di setiap halaman:
//    <script>
//      document.addEventListener('DOMContentLoaded', () => initRBAC());
//    </script>
//
//  LANGKAH 4 — Filter data di backend berdasarkan network_id:
//    @api_bp.route('/pelanggan/<int:device_id>')
//    @login_required
//    def get_pelanggan(device_id):
//        network_id = g.current_user['network_id']
//        # Tambahkan filter WHERE network_id = ? ke semua query
//        ...
//
// ══════════════════════════════════════════════════════════════