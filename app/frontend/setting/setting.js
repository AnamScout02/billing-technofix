/* ============================================================
   setting.js — TechnoFix-Bill · Halaman Pengaturan
   v2.0
   ============================================================
   Modul:
     1. Profil ISP  → /api/setting (app_settings)
     2. Rekening Pembayaran → /api/payment/rekening
     3. Portal Pelanggan → /api/setting (app_settings)
     4. Preferensi Sistem → /api/setting (app_settings)
     5. Info Sistem → /api/setting/info

   Requires: global.js (API_BASE, getAuthHeaders, toast)
   ============================================================ */

'use strict';

// ── DEFAULT STATE ─────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  profil: {
    isp_name:  '',
    alamat:    '',
    telepon:   '',
    email:     '',
    wa_admin:  '',
  },
  portal: {
    enabled:     true,
    welcome_msg: '',
  },
  preferensi: {
    refresh_interval: 60,
    rx_good:          -20,
    rx_bad:           -27,
    show_harga:       true,
    auto_sync:        true,
  },
};

let _settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));


// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkBackendStatus();
});


// ══════════════════════════════════════════════════════════════
// LOAD
// ══════════════════════════════════════════════════════════════

async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/setting`, {
      credentials: 'include',
      headers:     getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      _settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), data);
    }
  } catch (_) {}

  applySettingsToForm();
  _loadLogo();
  updateStatusBadge(false);
}


// ══════════════════════════════════════════════════════════════
// SAVE
// ══════════════════════════════════════════════════════════════

async function saveSection(section) {
  collectFormValues(section);

  const btn = document.querySelector(`[onclick="saveSection('${section}')"]`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...'; }

  try {
    {
      // Profil, portal, preferensi → endpoint terpadu
      const res = await fetch(`${API_BASE}/api/setting`, {
        method:      'POST',
        credentials: 'include',
        headers:     { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body:        JSON.stringify({ section, data: _settings[section] }),
      });
      if (!res.ok) throw new Error('Gagal simpan pengaturan');
    }

    updateStatusBadge(true);
    showToast('Pengaturan berhasil disimpan', 'success');
  } catch (e) {
    showToast(e.message || 'Gagal menyimpan', 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">save</span> Simpan';
    }
  }
}


// ══════════════════════════════════════════════════════════════
// APPLY → FORM
// ══════════════════════════════════════════════════════════════

function applySettingsToForm() {
  const p    = _settings.profil      || {};
  const por  = _settings.portal      || {};
  const pref = _settings.preferensi  || {};

  // Profil ISP
  setVal('profil-isp-name', p.isp_name || '');
  setVal('profil-alamat',   p.alamat   || '');
  setVal('profil-telepon',  p.telepon  || '');
  setVal('profil-email',    p.email    || '');
  setVal('profil-wa-admin', p.wa_admin || '');

  // Portal
  setCheck('portal-enabled',     por.enabled !== false);
  setVal('portal-welcome-msg',   por.welcome_msg || '');

  // Preferensi
  setVal('pref-refresh-interval', String(pref.refresh_interval ?? 60));
  setVal('pref-rx-good',          String(pref.rx_good          ?? -20));
  setVal('pref-rx-bad',           String(pref.rx_bad           ?? -27));
  setCheck('pref-show-harga',     pref.show_harga !== false);
  setCheck('pref-auto-sync',      pref.auto_sync  !== false);

}


// ══════════════════════════════════════════════════════════════
// COLLECT FORM → STATE
// ══════════════════════════════════════════════════════════════

function collectFormValues(section) {
  if (section === 'profil' || section === 'all') {
    _settings.profil = {
      isp_name:  getVal('profil-isp-name'),
      alamat:    getVal('profil-alamat'),
      telepon:   getVal('profil-telepon'),
      email:     getVal('profil-email'),
      wa_admin:  getVal('profil-wa-admin'),
    };
  }
  if (section === 'portal' || section === 'all') {
    _settings.portal = {
      enabled:     getCheck('portal-enabled'),
      welcome_msg: getVal('portal-welcome-msg'),
    };
  }
  if (section === 'preferensi' || section === 'all') {
    _settings.preferensi = {
      refresh_interval: parseInt(getVal('pref-refresh-interval')) || 60,
      rx_good:          parseFloat(getVal('pref-rx-good'))        || -20,
      rx_bad:           parseFloat(getVal('pref-rx-bad'))         || -27,
      show_harga:       getCheck('pref-show-harga'),
      auto_sync:        getCheck('pref-auto-sync'),
    };
  }
}



// ══════════════════════════════════════════════════════════════
// INFO SISTEM
// ══════════════════════════════════════════════════════════════

async function checkBackendStatus() {
  const el = document.getElementById('info-backend-status');
  try {
    const res = await fetch(`${API_BASE}/devices`, { credentials:'include', headers:getAuthHeaders() });
    if (res.ok || res.status === 401 || res.status === 403) {
      if (el) el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block"></span> <span style="color:var(--green);font-weight:700">Online</span>`;
    } else throw new Error();
  } catch (_) {
    if (el) el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--red);display:inline-block"></span> <span style="color:var(--red);font-weight:700">Offline</span>`;
  }
  try {
    const res = await fetch(`${API_BASE}/api/setting/info`, { credentials:'include', headers:getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      const el2  = document.getElementById('info-db-size');
      if (el2 && data.db_size_kb) {
        el2.textContent = data.db_size_kb < 1024
          ? `${data.db_size_kb} KB`
          : `${(data.db_size_kb / 1024).toFixed(1)} MB`;
      }
    }
  } catch (_) {}
}


// ══════════════════════════════════════════════════════════════
// STATUS BADGE & TOAST
// ══════════════════════════════════════════════════════════════

function updateStatusBadge(saved) {
  const badge = document.getElementById('setting-status-badge');
  if (!badge) return;
  badge.className = saved ? 'badge connected' : 'badge pending';
  badge.innerHTML = saved
    ? '<span class="badge-dot"></span> Tersimpan'
    : '<span class="badge-dot"></span> Belum tersimpan';
  if (saved) setTimeout(() => updateStatusBadge(false), 3000);
}

function showToast(msg, type = 'success') {
  // Pakai toast() dari global.js jika tersedia, fallback ke setting-toast
  if (typeof toast === 'function') { toast(msg, type); return; }
  const el = document.getElementById('setting-toast');
  const tx = document.getElementById('setting-toast-msg');
  if (!el || !tx) return;
  tx.textContent = msg;
  el.className   = `setting-toast show ${type}`;
  setTimeout(() => { el.className = 'setting-toast'; }, 3000);
}


// ══════════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════════

function getVal(id)      { return (document.getElementById(id)?.value || '').trim(); }
function setVal(id, v)   { const e = document.getElementById(id); if (e) e.value = v; }
function getCheck(id)    { return !!document.getElementById(id)?.checked; }
function setCheck(id, v) { const e = document.getElementById(id); if (e) e.checked = !!v; }
function escHtml(str)    {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function togglePwdField(inputId, eyeId) {
  const inp = document.getElementById(inputId);
  const eye = document.getElementById(eyeId);
  if (!inp || !eye) return;
  const h = inp.type === 'password';
  inp.type = h ? 'text' : 'password';
  eye.textContent = h ? 'visibility_off' : 'visibility';
}
function deepMerge(base, src) {
  const r = Object.assign({}, base);
  for (const k of Object.keys(src || {})) {
    r[k] = (src[k] !== null && typeof src[k] === 'object' && !Array.isArray(src[k])
         && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], src[k]) : src[k];
  }
  return r;
}


// ══════════════════════════════════════════════════════════════
// LOGO ISP — preview + simpan base64 ke app_settings
// ══════════════════════════════════════════════════════════════

function previewLogo(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('File terlalu besar (maks 5 MB)', 'danger'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      // Kompres ke maks 256x256 px agar base64 kecil (< 30 KB)
      const compressed = await _compressImage(e.target.result, 256, 256, 0.85);

      // Tampil preview dulu
      _setLogoPreview(compressed);

      // Simpan ke backend
      const r = await fetch(`${API_BASE}/api/setting`, {
        method:  'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ section: 'logo', data: { logo_base64: compressed } }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `Server error ${r.status}`);
      }
      showToast('Logo berhasil disimpan', 'success');
    } catch(err) {
      showToast(err.message || 'Gagal simpan logo', 'danger');
      // Hapus preview karena save gagal
      hapusLogo();
    }
  };
  reader.readAsDataURL(file);
}

/* Kompres gambar menggunakan Canvas sebelum encode base64 */
function _compressImage(dataUrl, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      // Pertahankan aspect ratio
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function hapusLogo() {
  document.getElementById('logo-preview').innerHTML =
    '<span class="material-symbols-outlined" id="logo-icon" style="font-size:28px;color:var(--text-dim)">add_photo_alternate</span>';
  document.getElementById('btn-hapus-logo').style.display = 'none';
  document.getElementById('logo-input').value = '';
  fetch(`${API_BASE}/api/setting`, {
    method: 'POST', credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'logo', data: { logo_base64: '' } }),
  }).catch(()=>{});
  showToast('Logo dihapus', 'success');
}

function _setLogoPreview(src) {
  const wrap = document.getElementById('logo-preview');
  if (!wrap) return;
  if (src) {
    wrap.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:contain;border-radius:12px"/>`;
    const btn = document.getElementById('btn-hapus-logo');
    if (btn) btn.style.display = '';
  }
}

async function _loadLogo() {
  try {
    const r = await fetch(`${API_BASE}/api/setting`, { credentials:'include', headers:getAuthHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    const logo = d.logo?.logo_base64 || '';
    if (logo) _setLogoPreview(logo);

    // Badge status: nama ISP & Logo Perusahaan di atas otomatis dipakai
    // juga di header app KALAU paket whitelabel (Pro ke atas) — tidak ada
    // field/upload terpisah, cukup info status di sini.
    const statusEl = document.getElementById('branding-status');
    if (statusEl) {
      if (d.whitelabel_ok) {
        statusEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">check_circle</span> Aktif — tampil juga di header semua halaman';
        statusEl.style.color = 'var(--green)';
      } else {
        statusEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">lock</span> Upgrade ke paket Pro supaya tampil di header app';
        statusEl.style.color = 'var(--text-dim)';
      }
    }
  } catch(_){}
}


// ── Global exports
window.saveSection    = saveSection;
window.togglePwdField = togglePwdField;
window.previewLogo    = previewLogo;
window.hapusLogo      = hapusLogo;
