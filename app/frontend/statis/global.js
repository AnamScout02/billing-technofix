/* ============================================================
   global.js — TechnoFix · Fungsi bersama semua halaman
   Load SEBELUM JS halaman spesifik.

   Isi:
   1.  API_BASE
   2.  escHtml()
   3.  val()
   4.  statusInfo()
   5.  animNum()
   6.  toast()
   7.  closeModal()
   8.  toggleProfileMenu()
   9.  togglePwd()
   10. initBottomNav()
   11. initHeaderCanvas()  — animasi partikel jaringan di header
   12. initDateBadge()
   13. openPerangkatSheet() / closePerangkatSheet()
   14. parseRxTx()          — parsing nilai RX/TX dari MikroTik/OLT
   15. getRxTxClass()       — menentukan class warna berdasarkan nilai
   16. openModalForm()      — membuka modal form di tengah halaman
   17. closeModalForm()
   ============================================================ */

'use strict';


/* ══════════════════════════════════════════════════════════
   1. API BASE
══════════════════════════════════════════════════════════ */
const API_BASE = 'http://127.0.0.1:5000';


/* ══════════════════════════════════════════════════════════
   2. escHtml
══════════════════════════════════════════════════════════ */
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ══════════════════════════════════════════════════════════
   3. val
══════════════════════════════════════════════════════════ */
function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}


/* ══════════════════════════════════════════════════════════
   4. statusInfo
══════════════════════════════════════════════════════════ */
function statusInfo(s) {
  const map = {
    connected: { label: 'Terhubung',       icon: 'ti-wifi'     },
    failed:    { label: 'Gagal Terhubung', icon: 'ti-wifi-off' },
    pending:   { label: 'Belum Disinkron', icon: 'ti-clock'    },
    syncing:   { label: 'Menyinkron...',   icon: 'ti-refresh'  },
  };
  return map[s] || map.pending;
}


/* ══════════════════════════════════════════════════════════
   5. animNum — count-up dari "-" ke target
══════════════════════════════════════════════════════════ */
function animNum(id, target, prefix = '', dur = 900) {
  const el = document.getElementById(id);
  if (!el) return;

  el.textContent = prefix ? (prefix + '-') : '-';

  const startTime = performance.now();

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function step(now) {
    const raw  = Math.min((now - startTime) / dur, 1);
    const t    = easeOut(raw);
    const curr = Math.round(target * t);
    el.textContent = prefix + curr.toLocaleString('id-ID');
    if (raw < 1) requestAnimationFrame(step);
  }

  setTimeout(() => requestAnimationFrame(step), 120);
}


/* ══════════════════════════════════════════════════════════
   6. toast
══════════════════════════════════════════════════════════ */
let _toastTimer = null;

function toast(msg, type = 'success', duration = 3500) {
  clearTimeout(_toastTimer);

  const icons = {
    success: 'check_circle',
    danger:  'error',
    warning: 'warning',
    info:    'info',
  };

  const el = document.getElementById('toast');
  if (!el) return;

  el.className = `show ${type}`;
  el.innerHTML =
    `<span class="material-symbols-outlined" style="font-size:17px;">`
    + (icons[type] || 'check_circle')
    + `</span>${escHtml(msg)}`;

  _toastTimer = setTimeout(() => {
    el.className = 'hidden';
  }, duration);
}


/* ══════════════════════════════════════════════════════════
   7. closeModal
══════════════════════════════════════════════════════════ */
function closeModal() {
  const el = document.getElementById('modal-container');
  if (el) el.innerHTML = '';
}


/* ══════════════════════════════════════════════════════════
   8. toggleProfileMenu
══════════════════════════════════════════════════════════ */
function toggleProfileMenu() {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.toggle('open');
}

document.addEventListener('click', function (e) {
  const wrap = document.getElementById('profile-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const dd = document.getElementById('profile-dropdown');
    if (dd) dd.classList.remove('open');
  }
});


/* ══════════════════════════════════════════════════════════
   9. togglePwd
══════════════════════════════════════════════════════════ */
function togglePwd(inputId = 'f-pass', iconId = 'pwd-eye') {
  const inp  = document.getElementById(inputId);
  const icon = document.getElementById(iconId);
  if (!inp || !icon) return;

  if (inp.type === 'password') {
    inp.type         = 'text';
    icon.textContent = 'visibility_off';
  } else {
    inp.type         = 'password';
    icon.textContent = 'visibility';
  }
}


/* ══════════════════════════════════════════════════════════
   10. initBottomNav — sliding indicator + ripple
══════════════════════════════════════════════════════════ */
function initBottomNav() {
  const indicator = document.getElementById('bottom-nav-indicator');
  const inner     = document.querySelector('.bottom-nav-inner');
  if (!indicator || !inner) return;

  function moveIndicator(item) {
    const iR = item.getBoundingClientRect();
    const nR = inner.getBoundingClientRect();
    indicator.style.left  = (iR.left - nR.left) + 'px';
    indicator.style.width = iR.width + 'px';
  }

  function addRipple(item, e) {
    const rect = item.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const r    = document.createElement('span');
    r.className = 'bottom-nav-ripple';
    r.style.cssText =
      'width:'  + size + 'px;'
      + 'height:' + size + 'px;'
      + 'left:'   + (e.clientX - rect.left - size / 2) + 'px;'
      + 'top:'    + (e.clientY - rect.top  - size / 2) + 'px;';
    item.appendChild(r);
    r.addEventListener('animationend', function () { r.remove(); });
  }

  document.querySelectorAll('.bottom-nav-item').forEach(function (item) {
    item.addEventListener('click', function (e) {
      const href    = item.getAttribute('href');
      const isSheet = item.getAttribute('onclick');
      if ((href && href !== '#') || isSheet) {
        document.querySelectorAll('.bottom-nav-item')
          .forEach(function (el) { el.classList.remove('active'); });
        item.classList.add('active');
        moveIndicator(item);
      }
      addRipple(item, e);
    });
  });

  requestAnimationFrame(function () {
    const active = document.querySelector('.bottom-nav-item.active');
    if (!active) return;
    indicator.style.transition = 'none';
    moveIndicator(active);
    requestAnimationFrame(function () { indicator.style.transition = ''; });
  });

  window.addEventListener('resize', function () {
    const active = document.querySelector('.bottom-nav-item.active');
    if (active) moveIndicator(active);
  });
}


/* ══════════════════════════════════════════════════════════
   11. initHeaderCanvas — animasi partikel jaringan di header
══════════════════════════════════════════════════════════ */
function initHeaderCanvas() {
  const header = document.querySelector('.header');
  if (!header) return;

  let canvas = header.querySelector('.header-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'header-canvas';
    header.insertBefore(canvas, header.firstChild);
  }

  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = header.offsetWidth;
    canvas.height = header.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const NODE_COUNT = 28;
  const MAX_DIST   = 120;

  const nodes = Array.from({ length: NODE_COUNT }, function () {
    return {
      x:    Math.random() * canvas.width,
      y:    Math.random() * canvas.height,
      vx:   (Math.random() - .5) * .55,
      vy:   (Math.random() - .5) * .55,
      r:    Math.random() * 1.8 + .8,
      pulse: Math.random() * Math.PI * 2,
    };
  });

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const W = canvas.width;
    const H = canvas.height;

    nodes.forEach(function (n) {
      n.x    += n.vx;
      n.y    += n.vy;
      n.pulse += 0.035;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a  = nodes[i];
        const b  = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < MAX_DIST) {
          const alpha = (1 - d / MAX_DIST) * .28;
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
          ctx.lineWidth   = .8;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    nodes.forEach(function (n) {
      const pulseFactor = 1 + Math.sin(n.pulse) * .25;
      const r = n.r * pulseFactor;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.50)';
      ctx.fill();
    });

    requestAnimationFrame(draw);
  }

  draw();
}


/* ══════════════════════════════════════════════════════════
   12. initDateBadge — isi tanggal ke semua #today-date
══════════════════════════════════════════════════════════ */
function initDateBadge() {
  const el = document.getElementById('today-date');
  if (!el) return;
  const opts = {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  };
  el.textContent = new Date().toLocaleDateString('id-ID', opts);
}


/* ══════════════════════════════════════════════════════════
   13. openPerangkatSheet / closePerangkatSheet
══════════════════════════════════════════════════════════ */
function openPerangkatSheet(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById('psheet-overlay');
  const sheet   = document.getElementById('psheet');
  if (!overlay || !sheet) return;
  overlay.classList.add('open');
  sheet.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closePerangkatSheet() {
  const overlay = document.getElementById('psheet-overlay');
  const sheet   = document.getElementById('psheet');
  if (overlay) overlay.classList.remove('open');
  if (sheet)   sheet.classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    closePerangkatSheet();
    closeModalForm();
  }
});


/* ══════════════════════════════════════════════════════════
   14. parseRxTx — parsing nilai RX/TX dari respons MikroTik/OLT
   Bug fix: data bisa datang dari berbagai field name & format.

   Untuk MikroTik (RouterOS API):
   - rx-byte, tx-byte   → total bytes (butuh delta untuk rate)
   - rx-bits-per-second, tx-bits-per-second → rate realtime
   - rx-drop, tx-drop   → packet drop

   Untuk OLT (SSH/Telnet CLI):
   - rx-power, tx-power  → nilai dBm (float negatif)
   - rx_power, rx_level  → alias snake_case dari backend
   - Nilai: "-25.5 dBm" atau "-25.5" (perlu di-strip satuan)

   @param {object} p — objek pelanggan/perangkat dari API
   @returns {{ rx: number|null, tx: number|null, rxFormatted: string,
               rxClass: string }}
══════════════════════════════════════════════════════════ */
function parseRxTx(p) {
  /* ── 1. Coba ambil nilai RX dari berbagai kemungkinan field name ── */
  let rxRaw =
    p.rx_power    ??   // OLT: snake_case dari backend Python
    p['rx-power'] ??   // OLT: key asli jika tidak diubah
    p.rx_level    ??   // OLT: alias lain
    p.rx_signal   ??   // OLT: nama lain
    p.rx          ??   // OLT: field pendek
    p.rxPower     ??   // camelCase
    p.signal_level ?? // alias umum
    null;

  let txRaw =
    p.tx_power    ??
    p['tx-power'] ??
    p.tx_level    ??
    p.tx          ??
    p.txPower     ??
    null;

  /* ── 2. Parse: hapus satuan "dBm", trim spasi ── */
  function parseDbm(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).replace(/dBm/i, '').replace(/\s/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  const rxVal = parseDbm(rxRaw);
  const txVal = parseDbm(txRaw);

  /* ── 3. Format string untuk tampilan ── */
  const rxFormatted = rxVal !== null ? `${rxVal.toFixed(1)} dBm` : '—';
  const txFormatted = txVal !== null ? `${txVal.toFixed(1)} dBm` : '—';

  /* ── 4. Tentukan class warna RX berdasarkan threshold OLT standar ──
     null          : tidak ada data → rx-none (abu)
     > -27 dBm     : sinyal bagus  → rx-ok   (hijau)
     -27 ~ -30 dBm : peringatan    → rx-warn  (kuning)
     < -30 dBm     : sinyal lemah  → rx-bad   (merah)
  ── */
  let rxClass = 'rx-none';
  if (rxVal !== null) {
    if      (rxVal < -30) rxClass = 'rx-bad';
    else if (rxVal < -27) rxClass = 'rx-warn';
    else                  rxClass = 'rx-ok';
  }

  return { rx: rxVal, tx: txVal, rxFormatted, txFormatted, rxClass };
}


/* ══════════════════════════════════════════════════════════
   15. getRxTxClass — alias ringkas
══════════════════════════════════════════════════════════ */
function getRxTxClass(rxVal) {
  if (rxVal === null) return '';
  if (rxVal < -30)    return 'rx-bad';
  if (rxVal < -27)    return 'rx-warn';
  return 'rx-ok';
}


/* ══════════════════════════════════════════════════════════
   16. openModalForm — tampilkan modal form di tengah halaman
   Menggunakan elemen #modal-form-overlay jika ada,
   atau membuat overlay dinamis.

   @param {string} html — konten HTML form (sudah berisi .form-modal)
══════════════════════════════════════════════════════════ */
function openModalForm(html) {
  /* Buat overlay jika belum ada */
  let overlay = document.getElementById('modal-form-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-form-overlay';
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModalForm();
    });
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = html;
  overlay.classList.add('open');

  /* Blur hanya pada konten page — header & navbar tidak blur
     (sudah diatur oleh z-index di CSS: overlay z-index 80,
      header z-index 50 → header render DI ATAS overlay = tidak blur) */
}

function closeModalForm() {
  const overlay = document.getElementById('modal-form-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
  }
}


/* ══════════════════════════════════════════════════════════
   AUTO-INIT saat DOM siap
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  initBottomNav();
  initHeaderCanvas();
  initDateBadge();
});

/* ══════════════════════════════════════════════════════════
   18. getSession — ambil data user dari localStorage
   Return: { token, user_id, username, role, network_id, isp_name }
══════════════════════════════════════════════════════════ */
function getSession() {
  return {
    token:      localStorage.getItem('tf_token')      || '',
    user_id:    localStorage.getItem('tf_user_id')    || '',
    username:   localStorage.getItem('tf_username')   || '',
    role:       localStorage.getItem('tf_role')        || '',
    network_id: localStorage.getItem('tf_network_id') || '',
    isp_name:   localStorage.getItem('tf_isp_name')   || '',
  };
}
 
 
/* ══════════════════════════════════════════════════════════
   19. getAuthHeaders — header untuk fetch() ke API
   Sertakan Authorization: Bearer <token> dan network_id
   agar backend dapat memvalidasi hak akses multi-tenant.
══════════════════════════════════════════════════════════ */
function getAuthHeaders(extra = {}) {
  const { token, network_id } = getSession();
  return {
    'Content-Type':  'application/json',
    'Authorization': token ? ('Bearer ' + token) : '',
    'X-Network-Id':  network_id || '',
    ...extra,
  };
}
 
 
/* ══════════════════════════════════════════════════════════
   20. applyRbacUi — sembunyikan/tampilkan elemen UI
       berdasarkan role user yang sedang login.
 
   Elemen yang dikontrol:
   ─ [data-role-owner]   → hanya tampil jika role = 'owner'
   ─ [data-role-teknisi] → hanya tampil jika role = 'teknisi'
   ─ .nav-keuangan       → menu Keuangan (owner only)
   ─ .nav-pengaturan     → menu Pengaturan / Infrastruktur (owner only)
   ─ .nav-manajemen-tim  → menu Manajemen Tim (owner only)
   ─ .btn-owner-only     → tombol/aksi owner-only (hapus, edit keuangan, dsb.)
 
   Cara pakai di HTML:
     <a class="nav-keuangan" href="...">Keuangan</a>
     <button class="btn-owner-only" ...>Hapus Data</button>
     <span data-role-owner>Hanya Owner</span>
══════════════════════════════════════════════════════════ */
function applyRbacUi() {
  const { role } = getSession();
  const isOwner  = role === 'owner';
 
  /* Kelas CSS yang hanya boleh dilihat Owner */
  const ownerOnlySelectors = [
    '.nav-keuangan',
    '.nav-pengaturan',
    '.nav-infrastruktur',
    '.nav-manajemen-tim',
    '.nav-olt',        // OLT management — opsional batasi ke owner
    '.btn-owner-only',
    '[data-role-owner]',
    '.menu-keuangan',  // alias alternatif
  ];
 
  ownerOnlySelectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.style.display = isOwner ? '' : 'none';
    });
  });
 
  /* Elemen khusus Teknisi */
  document.querySelectorAll('[data-role-teknisi]').forEach(function (el) {
    el.style.display = isOwner ? 'none' : '';
  });
 
  /* Badge role di header (jika ada) */
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge) {
    roleBadge.textContent = isOwner ? 'Owner' : 'Teknisi';
    roleBadge.className   = isOwner
      ? 'badge-profil'
      : 'badge-profil';
    roleBadge.style.background    = isOwner ? 'var(--primary-light)' : 'var(--amber-bg)';
    roleBadge.style.color         = isOwner ? 'var(--primary)'       : 'var(--amber)';
    roleBadge.style.borderColor   = isOwner ? 'rgba(0,64,161,.2)'    : 'var(--amber-border)';
  }
}
 
 
/* ══════════════════════════════════════════════════════════
   21. initProfileHeader — isi nama & inisial di header
   Panggil di setiap halaman setelah DOM siap.
   Bergantung pada elemen:
     #profile-username → teks nama user
     #avatar-initials  → 2 huruf inisial di avatar
══════════════════════════════════════════════════════════ */
function initProfileHeader() {
  const { username, isp_name } = getSession();
  if (!username) return;
 
  /* Teks username di header */
  const nameEl = document.getElementById('profile-username');
  if (nameEl) nameEl.textContent = username;
 
  /* Inisial avatar */
  const avatarEl = document.getElementById('avatar-initials');
  if (avatarEl) {
    const initials = username.slice(0, 2).toUpperCase();
    avatarEl.textContent = initials;
  }
 
  /* Nama ISP di subtitle brand (opsional, jika elemen ada) */
  const brandSubEl = document.querySelector('.brand-sub');
  if (brandSubEl && isp_name) {
    brandSubEl.textContent = isp_name;
  }
}
 
 
/* ══════════════════════════════════════════════════════════
   22. logout — hapus sesi & kembali ke auth.html
══════════════════════════════════════════════════════════ */
function logout() {
  const keys = [
    'tf_token', 'tf_user_id', 'tf_username',
    'tf_role', 'tf_network_id', 'tf_isp_name',
  ];
  keys.forEach(function (k) { localStorage.removeItem(k); });
  window.location.href = '/app/frontend/auth/auth.html';
}
 
 
/* ══════════════════════════════════════════════════════════
   23. requireLogin — redirect ke auth jika belum login
   Panggil di awal setiap halaman yang butuh autentikasi:
     requireLogin();
   Opsional hanya izinkan owner:
     requireLogin({ ownerOnly: true });
══════════════════════════════════════════════════════════ */
function requireLogin(options) {
  const opts  = options || {};
  const { token, role } = getSession();
 
  if (!token) {
    window.location.href = '/app/frontend/auth/auth.html';
    return false;
  }
 
  if (opts.ownerOnly && role !== 'owner') {
    /* Tampilkan pesan error dan redirect ke dashboard */
    toast('Akses ditolak: hanya Owner yang dapat mengakses halaman ini.', 'danger');
    setTimeout(function () {
      window.location.href = '/app/frontend/dashboard/dashboard.html';
    }, 2000);
    return false;
  }
 
  return true;
}
 
 
/* ══════════════════════════════════════════════════════════
   PATCH AUTO-INIT — tambahkan RBAC & profile ke initisasi
   global yang sudah ada di bagian bawah global.js.
 
   CATATAN: Gantikan atau tambahkan baris berikut di dalam
   blok DOMContentLoaded yang sudah ada:
     initProfileHeader();
     applyRbacUi();
 
   Atau jika ingin otomatis di setiap halaman, biarkan
   kode ini berjalan sendiri:
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  /* Hanya jalankan RBAC jika ada sesi aktif (bukan di auth.html) */
  const isAuthPage = window.location.pathname.includes('auth');
  if (!isAuthPage && localStorage.getItem('tf_token')) {
    initProfileHeader();
    applyRbacUi();
    applyUIPermissions();
  }
});

/* ══════════════════════════════════════════════════════════
   24. initDropdownHeader — isi avatar + nama + badge role
   di header dropdown profil. Panggil setelah initProfileHeader().
══════════════════════════════════════════════════════════ */
function initDropdownHeader() {
  const { username, role } = getSession();
  if (!username) return;

  const ddAvatar = document.getElementById('dd-avatar');
  const ddName   = document.getElementById('dd-username');
  const ddBadge  = document.getElementById('dd-role-badge');

  if (ddAvatar) ddAvatar.textContent = username.slice(0, 2).toUpperCase();
  if (ddName)   ddName.textContent   = username;
  if (ddBadge) {
    const isOwner = role === 'owner';
    ddBadge.textContent = isOwner ? 'Owner' : 'Teknisi';
    ddBadge.classList.toggle('teknisi', !isOwner);
  }
}


/* ══════════════════════════════════════════════════════════
   25. Modal Logout
══════════════════════════════════════════════════════════ */
function showModalLogout() {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
  const m = document.getElementById('modal-logout');
  if (m) m.classList.add('open');
}
function closeModalLogout(e) {
  if (e && e.target !== e.currentTarget) return;
  const m = document.getElementById('modal-logout');
  if (m) m.classList.remove('open');
}


/* ══════════════════════════════════════════════════════════
   26. Modal Ganti Password
══════════════════════════════════════════════════════════ */
function showModalGantiPassword() {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
  ['pwd-lama','pwd-baru','pwd-konfirm'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const hint = document.getElementById('pwd-hint');
  if (hint) hint.style.display = 'none';
  const m = document.getElementById('modal-ganti-password');
  if (m) m.classList.add('open');
}
function closeModalGantiPassword(e) {
  if (e && e.target !== e.currentTarget) return;
  const m = document.getElementById('modal-ganti-password');
  if (m) m.classList.remove('open');
}
async function submitGantiPassword() {
  const lama    = document.getElementById('pwd-lama')   ?.value.trim() || '';
  const baru    = document.getElementById('pwd-baru')   ?.value.trim() || '';
  const konfirm = document.getElementById('pwd-konfirm')?.value.trim() || '';
  const hint    = document.getElementById('pwd-hint');

  function showHint(msg) {
    if (!hint) return;
    hint.textContent  = msg;
    hint.style.display = 'block';
  }

  if (!lama)             return showHint('Password lama wajib diisi.');
  if (baru.length < 8)   return showHint('Password baru minimal 8 karakter.');
  if (baru !== konfirm)  return showHint('Konfirmasi password tidak cocok.');
  if (hint) hint.style.display = 'none';

  try {
    const res = await fetch(API_BASE + '/api/auth/ganti-password', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password_lama: lama, password_baru: baru }),
    });
    const data = await res.json();
    if (!res.ok) return showHint(data.message || 'Gagal mengganti password.');
    closeModalGantiPassword();
    toast('Password berhasil diperbarui.', 'success');
  } catch (_) {
    showHint('Gagal terhubung ke server.');
  }
}


/* ══════════════════════════════════════════════════════════
   27. Slide-over Panel Setting
══════════════════════════════════════════════════════════ */
function showPanelSetting() { showModalSetting(); }
function closePanelSetting() { closeModalSetting(); }

function showModalSetting() {
  const dd = document.getElementById('profile-dropdown');
  if (dd) dd.classList.remove('open');
  loadSetting();
  const m = document.getElementById('modal-setting');
  if (m) m.classList.add('open');
}
function closeModalSetting(e) {
  if (e && e.target !== e.currentTarget) return;
  const m = document.getElementById('modal-setting');
  if (m) m.classList.remove('open');
}

function loadSetting() {
  const keys = ['tema','bahasa','refresh','perpage'];
  const defaults = { tema:'auto', bahasa:'id', refresh:'0', perpage:'50' };
  keys.forEach(function(k) {
    const el = document.getElementById('setting-' + k);
    if (el) el.value = localStorage.getItem('tf_setting_' + k) || defaults[k];
  });
  /* Toggle notifikasi */
  ['offline','rx'].forEach(function(key) {
    const checked = localStorage.getItem('tf_notif_' + key) === '1';
    const input = document.getElementById('notif-' + key);
    if (input) {
      input.checked = checked;
      applyToggleStyle('notif-' + key, checked);
    }
  });
}

function simpanSetting() {
  ['tema','bahasa','refresh','perpage'].forEach(function(k) {
    const el = document.getElementById('setting-' + k);
    if (el) localStorage.setItem('tf_setting_' + k, el.value);
  });
  ['offline','rx'].forEach(function(key) {
    const el = document.getElementById('notif-' + key);
    if (el) localStorage.setItem('tf_notif_' + key, el.checked ? '1' : '0');
  });
  closePanelSetting();
  toast('Setting berhasil disimpan.', 'success');
}

function toggleNotif(input, id) {
  applyToggleStyle(id, input.checked);
  localStorage.setItem('tf_notif_' + id.replace('notif-',''), input.checked ? '1' : '0');
}

function applyToggleStyle(id, on) {
  const track = document.getElementById('track-' + id.replace('notif-',''));
  const thumb = document.getElementById('thumb-' + id.replace('notif-',''));
  if (track) track.style.background = on ? 'var(--primary)' : 'var(--border)';
  if (thumb) thumb.style.transform  = on ? 'translateX(18px)' : 'translateX(0)';
}


/* ══════════════════════════════════════════════════════════
   PATCH AUTO-INIT — tambahkan initDropdownHeader
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  const isAuthPage = window.location.pathname.includes('auth');
  if (!isAuthPage && localStorage.getItem('tf_token')) {
    initDropdownHeader();
  }
});

/* ══════════════════════════════════════════════════════════
   applyUIPermissions() — kontrol visibilitas menu per user
   ══════════════════════════════════════════════════════════
   Cara kerja:
   - Baca permissions dari localStorage (tf_permissions)
   - Owner (role=owner) → semua elemen ditampilkan
   - Role lain → elemen dengan data-perm yang tidak ada
     dalam list permissions user → disembunyikan (display:none)

   Cara tandai elemen di HTML:
     <a href="..." data-perm="keuangan">Keuangan</a>
     <a href="..." data-perm="maps">Maps</a>
     <a href="..." data-perm="olt">OLT</a>
     <a href="..." data-perm="mikrotik">MikroTik</a>
     <a href="..." data-perm="pelanggan">Pelanggan</a>
     <a href="..." data-perm="perangkat">Perangkat</a>
══════════════════════════════════════════════════════════ */
function applyUIPermissions() {
  var session     = (typeof getSession === 'function') ? getSession() : {};
  var role        = session.role || localStorage.getItem('tf_role') || '';
  var permsRaw    = localStorage.getItem('tf_permissions') || '[]';
  var permissions = [];

  try {
    var parsed = JSON.parse(permsRaw);
    permissions = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    permissions = [];
  }

  var isOwner = (role === 'owner');

  /* Sembunyikan/tampilkan elemen [data-perm] */
  document.querySelectorAll('[data-perm]').forEach(function (el) {
    var perm = el.getAttribute('data-perm');
    if (!perm) return;
    if (isOwner) {
      el.style.display = '';
    } else {
      el.style.display = permissions.includes(perm) ? '' : 'none';
    }
  });

  /* Guard halaman — redirect jika tidak punya izin */
  if (!isOwner) {
    var PAGE_PERM_MAP = {
      '/keuangan/':  'keuangan',
      '/maps/':      'maps',
      '/olt/':       'olt',
      '/mikrotik/':  'mikrotik',
    };
    var path = window.location.pathname;
    for (var pagePath in PAGE_PERM_MAP) {
      if (path.includes(pagePath) && !permissions.includes(PAGE_PERM_MAP[pagePath])) {
        if (typeof toast === 'function') toast('Akses ditolak.', 'danger');
        setTimeout(function () {
          window.location.href = '/app/frontend/dashboard/dashboard.html';
        }, 1200);
        break;
      }
    }
  }
}

/* Simpan permissions ke localStorage setelah login berhasil.
   Panggil dari auth.js: savePermissions(data.user.permissions) */
function savePermissions(permissions) {
  if (!Array.isArray(permissions)) permissions = [];
  localStorage.setItem('tf_permissions', JSON.stringify(permissions));
}

window.applyUIPermissions = applyUIPermissions;
window.savePermissions    = savePermissions;
