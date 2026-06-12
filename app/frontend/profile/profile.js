

/* ── Cek status backend ────────────────────────────────────── */
async function checkBackend() {
  const el  = document.getElementById('info-status');
  const srv = document.getElementById('info-server');
  if (srv) srv.textContent = typeof API_BASE !== 'undefined' ? API_BASE : '';
  try {
    const res = await fetch((typeof API_BASE!=='undefined'?API_BASE:'') + '/devices', {
      credentials: 'include',
      headers: typeof getAuthHeaders==='function' ? getAuthHeaders() : {},
      signal: AbortSignal.timeout(4000)
    });
    if (el) el.innerHTML = (res.ok || res.status===401 || res.status===403)
      ? '<span class="badge connected"><span class="badge-dot"></span>Terhubung</span>'
      : '<span class="badge failed"><span class="badge-dot"></span>Error</span>';
  } catch {
    if (el) el.innerHTML = '<span class="badge failed"><span class="badge-dot"></span>Tidak terhubung</span>';
  }
}

/* ── Ganti foto (belum ada endpoint) ──────────────────────── */
function gantiFoto() { toast('Fitur ganti foto profil belum tersedia', 'info'); }

/* ── Muat data profil dari server & isi form/tampilan ─────── */
async function loadProfil() {
  try {
    const res  = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Gagal memuat profil');
    const u = data.user;

    const setVal  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    setVal('f-nama', u.nama || '');
    setVal('f-uname', u.username || '');
    setVal('f-hp-profile', u.hp || '');

    const displayName = u.nama || u.username;
    const roleLabel = u.role ? (u.role.charAt(0).toUpperCase() + u.role.slice(1)) : '—';

    setText('profile-name-display', displayName);
    setText('profile-username', displayName);
    setText('dd-username', displayName);
    setText('profile-username-display', u.username || '—');
    setText('profile-role-display', roleLabel + (u.isp_name ? ' — ' + u.isp_name : ''));
    setText('profile-hp-display', u.hp || '—');
    setText('profile-paket', u.paket ? u.paket.toUpperCase() : '—');
    setText('profile-isp-name', u.isp_name || '—');

    const roleBadge = document.getElementById('dd-role-badge');
    if (roleBadge) roleBadge.textContent = roleLabel;

    const initials = displayName.trim().slice(0, 2).toUpperCase();
    ['profile-avatar-big', 'avatar-initials', 'dd-avatar'].forEach(id => setText(id, initials));
  } catch (err) {
    console.error('[Profile] loadProfil error:', err);
    toast('Gagal memuat data profil', 'error');
  }
}

/* ── Simpan perubahan nama & no HP ─────────────────────────── */
async function simpanProfil() {
  const nama = document.getElementById('f-nama')?.value.trim() || '';
  const hp   = document.getElementById('f-hp-profile')?.value.trim() || '';
  if (!nama) return toast('Nama tidak boleh kosong', 'error');

  try {
    const res  = await fetch(`${API_BASE}/api/auth/me`, {
      method: 'PUT',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ nama, hp }),
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Gagal menyimpan profil');
    toast('Profil berhasil disimpan', 'success');
    loadProfil();
  } catch (err) {
    console.error('[Profile] simpanProfil error:', err);
    toast(err.message || 'Gagal menyimpan profil', 'error');
  }
}

/* ── Ganti password akun ───────────────────────────────────── */
async function gantiPassword() {
  const lama    = document.getElementById('f-pass-lama')?.value.trim()    || '';
  const baru    = document.getElementById('f-pass-baru')?.value.trim()    || '';
  const konfirm = document.getElementById('f-pass-konfirm')?.value.trim() || '';

  if (!lama)            return toast('Password lama wajib diisi', 'error');
  if (baru.length < 6)  return toast('Password baru minimal 6 karakter', 'error');
  if (baru !== konfirm) return toast('Konfirmasi password baru tidak cocok', 'error');

  try {
    const res  = await fetch(`${API_BASE}/api/auth/me`, {
      method: 'PUT',
      credentials: 'include',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password_lama: lama, password_baru: baru }),
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Gagal mengganti password');
    ['f-pass-lama', 'f-pass-baru', 'f-pass-konfirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    toast('Password berhasil diperbarui', 'success');
  } catch (err) {
    console.error('[Profile] gantiPassword error:', err);
    toast(err.message || 'Gagal mengganti password', 'error');
  }
}

/* ── Init ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  loadProfil();
  checkBackend();
  // Load toggle prefs dari localStorage
  const prefs = JSON.parse(localStorage.getItem('technofix_prefs') || '{}');
  Object.keys(prefs).forEach(key => {
    const btn = document.getElementById('toggle-' + key);
    if (!btn) return;
    if (prefs[key]) btn.classList.add('on'); else btn.classList.remove('on');
  });
  // Sync dark mode icon
  const cur  = localStorage.getItem('tf_theme') || 'light';
  const icon = document.getElementById('dark-mode-icon');
  if (icon) icon.textContent = cur === 'dark' ? 'light_mode' : 'dark_mode';
});
