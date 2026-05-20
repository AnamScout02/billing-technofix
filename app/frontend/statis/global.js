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
const API_BASE = 'http://103.194.175.54:5000';


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
     > -27 dBm   : sinyal bagus  → rx-ok  (hijau)
     -27 ~ -30   : peringatan   → rx-warn (kuning)
     < -30 dBm   : sinyal lemah → rx-bad  (merah)
  ── */
  let rxClass = 'rx-ok';
  if (rxVal !== null) {
    if (rxVal < -30)      rxClass = 'rx-bad';
    else if (rxVal < -27) rxClass = 'rx-warn';
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