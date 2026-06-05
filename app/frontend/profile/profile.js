/* profile.js — Halaman Profil TechnoFix */
'use strict';

const AUTH_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/auth';

/* ── Load data profil dari server ─────────────────────────── */
async function loadProfil() {
  try {
    const r = await fetch(AUTH_API + '/me', { credentials: 'include', headers: (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {} });
    if (!r.ok) return;
    const d = await r.json();
    const u = d.user || {};

    // Avatar
    const initials = (u.nama || u.username || 'U').replace(/[^a-zA-Z0-9]/g,'').slice(0,2).toUpperCase();
    const avatarEl = document.getElementById('profile-avatar-big');
    if (avatarEl) avatarEl.textContent = initials;

    // Display info
    const nameEl = document.getElementById('profile-name-display');
    if (nameEl) nameEl.textContent = u.nama || u.username || '—';

    const roleEl = document.querySelector('.profile-role');
    if (roleEl) roleEl.textContent = (u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : '') + ' — ' + (u.isp_name || 'TechnoFix');

    const hpEl = document.getElementById('profile-hp-display');
    if (hpEl) hpEl.textContent = u.hp || '—';

    // Sembunyikan email display (tidak ada di DB)
    const emailWrap = document.getElementById('profile-email-display')?.closest('.profile-meta-item');
    if (emailWrap) emailWrap.style.display = 'none';

    // Isi form
    const fNama = document.getElementById('f-nama'); if (fNama) fNama.value = u.nama || '';
    const fUname = document.getElementById('f-uname'); if (fUname) { fUname.value = u.username || ''; fUname.readOnly = true; fUname.style.background = 'var(--surface)'; }
    const fHp = document.getElementById('f-hp-profile'); if (fHp) fHp.value = u.hp || '';

    // Sembunyikan field email dari form
    const emailFormGroup = document.getElementById('f-email')?.closest('.form-group');
    if (emailFormGroup) emailFormGroup.style.display = 'none';

    // Info tambahan
    const ispEl = document.getElementById('profile-isp-name'); if (ispEl) ispEl.textContent = u.isp_name || '—';
    const paketEl = document.getElementById('profile-paket'); if (paketEl) paketEl.textContent = u.paket || '—';

  } catch(e) { console.error('[profile] load error:', e); }
}

/* ── Simpan perubahan profil ──────────────────────────────── */
async function simpanProfil() {
  const nama = (document.getElementById('f-nama')?.value || '').trim();
  const hp   = (document.getElementById('f-hp-profile')?.value || '').trim();

  if (!nama) { if (typeof toast === 'function') toast('Nama tidak boleh kosong', 'warning'); return; }

  const btn = document.querySelector('[onclick="simpanProfil()"]');
  if (btn) btn.disabled = true;

  try {
    const r = await fetch(AUTH_API + '/me', {
      method: 'PUT', credentials: 'include',
      headers: Object.assign({'Content-Type':'application/json'}, (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}),
      body: JSON.stringify({ nama, hp }),
    });
    const d = await r.json();
    if (typeof toast === 'function') toast(d.message || (r.ok ? 'Profil tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadProfil();
  } catch(e) { if (typeof toast === 'function') toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) btn.disabled = false;
}

/* ── Ganti Password ───────────────────────────────────────── */
async function gantiPasswordProfil() {
  const lama  = (document.getElementById('pwd-lama-profile')?.value  || '').trim();
  const baru  = (document.getElementById('pwd-baru-profile')?.value  || '').trim();
  const konfirm = (document.getElementById('pwd-konfirm-profile')?.value || '').trim();

  if (!lama || !baru) { toast('Isi semua field password', 'warning'); return; }
  if (baru !== konfirm) { toast('Konfirmasi password tidak cocok', 'danger'); return; }
  if (baru.length < 6) { toast('Password minimal 6 karakter', 'warning'); return; }

  const btn = document.querySelector('[onclick="gantiPasswordProfil()"]');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(AUTH_API + '/me', {
      method: 'PUT', credentials: 'include',
      headers: Object.assign({'Content-Type':'application/json'}, (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}),
      body: JSON.stringify({ password_lama: lama, password_baru: baru }),
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Password berhasil diubah' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) {
      ['pwd-lama-profile','pwd-baru-profile','pwd-konfirm-profile'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
    }
  } catch(e) { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) btn.disabled = false;
}

/* ── Ganti password (form inline di halaman, bukan modal) ──── */
async function gantiPassword() {
  const lama    = (document.getElementById('f-pass-lama')?.value    || '').trim();
  const baru    = (document.getElementById('f-pass-baru')?.value    || '').trim();
  const konfirm = (document.getElementById('f-pass-konfirm')?.value || '').trim();

  if (!lama)            { toast('Masukkan password lama', 'warning'); return; }
  if (baru.length < 6)  { toast('Password baru minimal 6 karakter', 'warning'); return; }
  if (baru !== konfirm) { toast('Konfirmasi password tidak cocok', 'danger'); return; }

  const btn = document.querySelector('[onclick="gantiPassword()"]');
  if (btn) { btn.disabled=true; btn.innerHTML='<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    const r = await fetch(AUTH_API + '/me', {
      method: 'PUT', credentials: 'include',
      headers: Object.assign({'Content-Type':'application/json'}, typeof getAuthHeaders==='function'?getAuthHeaders():{}),
      body: JSON.stringify({ password_lama: lama, password_baru: baru }),
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Password berhasil diperbarui' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) ['f-pass-lama','f-pass-baru','f-pass-konfirm'].forEach(id => {
      const el = document.getElementById(id); if(el) el.value='';
    });
  } catch(_) { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) { btn.disabled=false; btn.innerHTML='<span class="material-symbols-outlined">lock_reset</span> Perbarui Password'; }
}

/* ── Toggle preferensi (localStorage) ────────────────────── */
function toggleSetting(key) {
  const btn = document.getElementById('toggle-' + key);
  if (!btn) return;
  btn.classList.toggle('on');
  toast(btn.classList.contains('on') ? 'Diaktifkan' : 'Dinonaktifkan', 'info');
  const prefs = JSON.parse(localStorage.getItem('technofix_prefs') || '{}');
  prefs[key] = btn.classList.contains('on');
  localStorage.setItem('technofix_prefs', JSON.stringify(prefs));
}

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
