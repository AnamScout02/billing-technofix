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
const API_BASE = (() => {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'http://127.0.0.1:5000';
  if (h === '192.168.70.7')                   return 'http://192.168.70.7:5000';
  if (h === '103.194.175.54')                 return 'http://103.194.175.54:5000';
  return '';  // ← production: pakai Apache reverse proxy, same origin
})();


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
   11. initHeaderCanvas — Network Topology Animation
   Node jaringan + flowing edges + paket data + trail
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
  let W, H, CDIST;

  function resize() {
    W = canvas.width  = header.offsetWidth;
    H = canvas.height = header.offsetHeight;
    CDIST = Math.max(110, Math.min(230, W * 0.17));
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── Node: 5 core (router utama) + 11 edge (switch/endpoint) ── */
  const N_CORE = 5, N_TOTAL = 16;
  const nodes = Array.from({ length: N_TOTAL }, function (_, i) {
    const core = i < N_CORE;
    return {
      x:  0.04 + Math.random() * 0.92,
      y:  0.10 + Math.random() * 0.80,
      vx: (Math.random() - 0.5) * (core ? 0.00006 : 0.00010),
      vy: (Math.random() - 0.5) * (core ? 0.00012 : 0.00017),
      r:  core ? (4.5 + Math.random() * 2.0) : (2.0 + Math.random() * 1.5),
      a0: core ? 0.92 : (0.50 + Math.random() * 0.35),
      ph: Math.random() * Math.PI * 2,
      rph: Math.random() * Math.PI * 2, /* ring pulse phase */
      core: core,
      flash: 0,
    };
  });

  /* ── Activity map: fade saat tidak ada paket ── */
  const edgeAct = {};

  /* ── Paket data ── */
  const pkts = [];

  function spawnPkt() {
    if (pkts.length >= 10) return;
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = (nodes[i].x - nodes[j].x) * W;
        const dy = (nodes[i].y - nodes[j].y) * H;
        if (Math.sqrt(dx * dx + dy * dy) < CDIST) edges.push([i, j]);
      }
    }
    if (!edges.length) return;
    const e = edges[Math.floor(Math.random() * edges.length)];
    const from = Math.random() < 0.5 ? e[0] : e[1];
    const to   = from === e[0] ? e[1] : e[0];
    pkts.push({ from: from, to: to, t: 0, spd: 0.007 + Math.random() * 0.011, r: 1.8 + Math.random() * 1.2 });
  }

  spawnPkt();
  setInterval(spawnPkt, 360);

  /* ── Aurora backdrop ── */
  const orbs = [0.16, 0.51, 0.83].map(function (xi, i) {
    return {
      x: xi, y: 0.5,
      vx: (Math.random() - 0.5) * 0.00009,
      vy: (Math.random() - 0.5) * 0.00012,
      r:  0.28 + Math.random() * 0.14,
      hue: [210, 198, 222][i],
      ph: Math.random() * Math.PI * 2,
    };
  });

  /* ── Render loop ── */
  function draw(ts) {
    const time = (ts || 0) / 1000;
    ctx.clearRect(0, 0, W, H);

    /* — Aurora backdrop — */
    orbs.forEach(function (o) {
      o.x += o.vx; o.y += o.vy; o.ph += 0.005;
      o.x = ((o.x % 1) + 1) % 1;
      if (o.y <= 0.05 || o.y >= 0.95) o.vy = -o.vy;
      o.y = Math.max(0.05, Math.min(0.95, o.y));
      const a  = 0.018 + Math.sin(o.ph * 0.6) * 0.006;
      const rx = o.x * W, ry = o.y * H, rr = o.r * Math.min(W, H);
      const g  = ctx.createRadialGradient(rx, ry, 0, rx, ry, rr);
      g.addColorStop(0, 'hsla(' + o.hue + ',80%,72%,' + (a * 3.0) + ')');
      g.addColorStop(0.55, 'hsla(' + o.hue + ',68%,60%,' + a + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();
    });

    /* — Update edge activity: decay semua, mark yang ada paket — */
    for (const k in edgeAct) edgeAct[k] = Math.max(0, edgeAct[k] - 0.055);
    pkts.forEach(function (pk) {
      const k = Math.min(pk.from, pk.to) + ',' + Math.max(pk.from, pk.to);
      edgeAct[k] = 1.0;
    });

    /* — Edges — */
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const ni = nodes[i], nj = nodes[j];
        const dx = (ni.x - nj.x) * W, dy = (ni.y - nj.y) * H;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d >= CDIST) continue;

        const fade = Math.pow(1 - d / CDIST, 1.5);
        const act  = edgeAct[i + ',' + j] || 0;

        /* Garis dasar */
        ctx.beginPath();
        ctx.moveTo(ni.x * W, ni.y * H);
        ctx.lineTo(nj.x * W, nj.y * H);
        ctx.strokeStyle = act > 0.05
          ? 'rgba(96,208,255,' + (fade * (0.14 + act * 0.20)) + ')'
          : 'rgba(118,186,255,' + (fade * 0.13) + ')';
        ctx.lineWidth = (ni.core || nj.core) ? 0.90 : 0.60;
        ctx.setLineDash([]);
        ctx.stroke();

        /* Flowing dashes saat edge aktif — memberi kesan arus data */
        if (act > 0.15) {
          ctx.beginPath();
          ctx.moveTo(ni.x * W, ni.y * H);
          ctx.lineTo(nj.x * W, nj.y * H);
          ctx.strokeStyle = 'rgba(180,232,255,' + (act * 0.28) + ')';
          ctx.lineWidth   = 1.0;
          ctx.setLineDash([4, 8]);
          ctx.lineDashOffset = -(time * 42);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    ctx.setLineDash([]);

    /* — Paket data + trail — */
    for (let i = pkts.length - 1; i >= 0; i--) {
      const pk = pkts[i];
      pk.t += pk.spd;
      if (pk.t >= 1) { nodes[pk.to].flash = 1.0; pkts.splice(i, 1); continue; }

      const fr = nodes[pk.from], to = nodes[pk.to];
      const edDx = (fr.x - to.x) * W, edDy = (fr.y - to.y) * H;
      if (Math.sqrt(edDx * edDx + edDy * edDy) > CDIST * 1.1) { pkts.splice(i, 1); continue; }

      const px = (fr.x + (to.x - fr.x) * pk.t) * W;
      const py = (fr.y + (to.y - fr.y) * pk.t) * H;
      const ea = Math.sin(pk.t * Math.PI); /* fade in/out */

      /* Trail — 3 titik memudar di belakang */
      for (let ti = 1; ti <= 3; ti++) {
        const tt = Math.max(0, pk.t - ti * 0.045);
        if (tt <= 0) continue;
        const trx = (fr.x + (to.x - fr.x) * tt) * W;
        const try_ = (fr.y + (to.y - fr.y) * tt) * H;
        ctx.beginPath();
        ctx.arc(trx, try_, pk.r * (0.55 - ti * 0.13), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(155,228,255,' + (ea * 0.28 / ti) + ')';
        ctx.fill();
      }

      /* Glow aura */
      const g = ctx.createRadialGradient(px, py, 0, px, py, pk.r * 5.2);
      g.addColorStop(0, 'rgba(138,214,255,' + (ea * 0.62) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath(); ctx.arc(px, py, pk.r * 5.2, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill();

      /* Titik inti */
      ctx.beginPath(); ctx.arc(px, py, pk.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(218,244,255,' + (ea * 0.94) + ')';
      ctx.fill();
    }

    /* — Node jaringan — */
    nodes.forEach(function (n) {
      n.x += n.vx; n.y += n.vy; n.ph += 0.013; n.rph += 0.019;
      if (n.x < 0.04) { n.x = 0.04; n.vx =  Math.abs(n.vx); }
      if (n.x > 0.96) { n.x = 0.96; n.vx = -Math.abs(n.vx); }
      if (n.y < 0.08) { n.y = 0.08; n.vy =  Math.abs(n.vy); }
      if (n.y > 0.92) { n.y = 0.92; n.vy = -Math.abs(n.vy); }
      if (n.flash > 0) n.flash = Math.max(0, n.flash - 0.07);

      const pulse = 1 + Math.sin(n.ph) * (n.core ? 0.18 : 0.10);
      const a     = Math.min(1, n.a0 + n.flash * 0.28);
      const nr    = n.r * pulse;
      const nx    = n.x * W, ny = n.y * H;
      const glowR = nr * (n.core ? 5.5 : 3.8);

      /* Outer glow halo */
      const glow = ctx.createRadialGradient(nx, ny, 0, nx, ny, glowR);
      glow.addColorStop(0, 'rgba(106,200,255,' + (a * (n.core ? 0.46 : 0.24)) + ')');
      glow.addColorStop(0.5, 'rgba(56,158,240,' + (a * (n.core ? 0.13 : 0.05)) + ')');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath(); ctx.arc(nx, ny, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow; ctx.fill();

      /* Cincin berdenyut untuk core node — tanda router utama */
      if (n.core) {
        const ringA = 0.10 + Math.sin(n.rph) * 0.06;
        ctx.beginPath(); ctx.arc(nx, ny, nr * 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(118,212,255,' + (a * ringA) + ')';
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      /* Badan node */
      ctx.beginPath(); ctx.arc(nx, ny, nr, 0, Math.PI * 2);
      ctx.fillStyle = n.core
        ? 'rgba(164,226,255,' + a + ')'
        : 'rgba(100,174,242,' + (a * 0.76) + ')';
      ctx.fill();

      /* Titik pusat terang — core node lebih jelas */
      if (n.core) {
        ctx.beginPath(); ctx.arc(nx, ny, nr * 0.38, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(232,250,255,' + (a * 0.84) + ')';
        ctx.fill();
      }
    });

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
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
   Mobile  : bottom sheet (overlay + slide-up)
   Desktop : dropdown muncul tepat di bawah tombol Perangkat
══════════════════════════════════════════════════════════ */
function openPerangkatSheet(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById('psheet-overlay');
  const sheet   = document.getElementById('psheet');
  if (!sheet) return;

  const isDesktop = window.innerWidth >= 769;

  if (isDesktop) {
    /* ── Posisikan dropdown di bawah tombol yang diklik ── */
    const trigger = e && e.currentTarget ? e.currentTarget : null;
    if (trigger) {
      const rect      = trigger.getBoundingClientRect();
      const sheetW    = 320;
      /* Letakkan kiri sejajar tombol, tapi jangan keluar viewport */
      let leftPos     = rect.left;
      if (leftPos + sheetW > window.innerWidth - 12) {
        leftPos = window.innerWidth - sheetW - 12;
      }
      sheet.style.left = leftPos + 'px';
      sheet.style.right = 'auto';
    } else {
      /* Fallback: sejajar kanan */
      sheet.style.right = '32px';
      sheet.style.left  = 'auto';
    }
    /* Overlay tidak dipakai di desktop */
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  } else {
    /* ── Mobile: bottom sheet dengan overlay ── */
    if (overlay) overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    sheet.style.left  = '';
    sheet.style.right = '';
  }

  sheet.classList.add('open');
}

function closePerangkatSheet() {
  const overlay = document.getElementById('psheet-overlay');
  const sheet   = document.getElementById('psheet');
  if (overlay) overlay.classList.remove('open');
  if (sheet)   sheet.classList.remove('open');
  document.body.style.overflow = '';
}

/* ══ Keuangan sheet (Tagihan / Loket / Notifikasi / Bayar Online) ══
   Mekanisme identik dengan perangkat sheet, hanya beda id 'ksheet'. */
function openKeuanganSheet(e) {
  if (e) e.preventDefault();
  const overlay = document.getElementById('ksheet-overlay');
  const sheet   = document.getElementById('ksheet');
  if (!sheet) return;

  if (window.innerWidth >= 769) {
    const trigger = e && e.currentTarget ? e.currentTarget : null;
    if (trigger) {
      const rect   = trigger.getBoundingClientRect();
      const sheetW = 320;
      let leftPos  = rect.left;
      if (leftPos + sheetW > window.innerWidth - 12) {
        leftPos = window.innerWidth - sheetW - 12;
      }
      sheet.style.left  = leftPos + 'px';
      sheet.style.right = 'auto';
    } else {
      sheet.style.right = '32px';
      sheet.style.left  = 'auto';
    }
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  } else {
    if (overlay) overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    sheet.style.left  = '';
    sheet.style.right = '';
  }
  sheet.classList.add('open');
}

function closeKeuanganSheet() {
  const overlay = document.getElementById('ksheet-overlay');
  const sheet   = document.getElementById('ksheet');
  if (overlay) overlay.classList.remove('open');
  if (sheet)   sheet.classList.remove('open');
  document.body.style.overflow = '';
}

/* ── Tutup dropdown saat klik di luar (desktop) ── */
document.addEventListener('click', function (e) {
  if (window.innerWidth < 769) return; /* Mobile: overlay sudah handle */
  var sheets = [
    { id: 'psheet', close: closePerangkatSheet, trig: 'openPerangkatSheet' },
    { id: 'ksheet', close: closeKeuanganSheet, trig: 'openKeuanganSheet' },
  ];
  sheets.forEach(function (s) {
    var sheet = document.getElementById(s.id);
    if (!sheet || !sheet.classList.contains('open')) return;
    var trigger = e.target.closest('[onclick*="' + s.trig + '"]');
    if (!trigger && !sheet.contains(e.target)) s.close();
  });
});

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

  /* ── 4. Tentukan class warna RX berdasarkan klasifikasi redaman ──
     null               : tidak ada data → rx-none   (abu)
     > -8 dBm           : redaman buruk  → rx-buruk  (merah)   sinyal terlalu kuat
     -8 dBm s/d -20 dBm : redaman bagus  → rx-bagus  (hijau)   inklusif keduanya
     < -20 dBm s/d -26  : redaman sedang → rx-sedang (kuning)  inklusif -26
     < -26 dBm          : redaman buruk  → rx-buruk  (merah)
  ── */
  let rxClass = 'rx-none';
  if (rxVal !== null) {
    if      (rxVal > -8)   rxClass = 'rx-buruk';   // terlalu kuat
    else if (rxVal >= -20) rxClass = 'rx-bagus';   // -8 s/d -20 inklusif
    else if (rxVal >= -26) rxClass = 'rx-sedang';  // -20 s/d -26 inklusif
    else                   rxClass = 'rx-buruk';   // < -26
  }

  return { rx: rxVal, tx: txVal, rxFormatted, txFormatted, rxClass };
}


/* ══════════════════════════════════════════════════════════
   15. getRxTxClass — alias ringkas
══════════════════════════════════════════════════════════ */
function getRxTxClass(rxVal) {
  if (rxVal === null || rxVal === undefined) return 'rx-none';
  if (rxVal > -8)   return 'rx-buruk';   // terlalu kuat
  if (rxVal >= -20) return 'rx-bagus';   // -8 s/d -20 inklusif
  if (rxVal >= -26) return 'rx-sedang';  // -20 s/d -26 inklusif
  return 'rx-buruk';                     // < -26
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
   DETEKSI LOKASI (geolocation) — SATU fungsi untuk semua form
   Mengisi input #f-koordinat dengan "lat, lng" dari GPS browser.

   Catatan penting: browser HANYA mengizinkan geolocation pada
   secure context (HTTPS) atau localhost/127.0.0.1. Pada http://IP
   biasa, getCurrentPosition langsung gagal tanpa prompt izin.
══════════════════════════════════════════════════════════ */
function geoDetectKoordinat() {
  const btn   = document.querySelector('.koordinat-btn');
  const input = document.getElementById('f-koordinat');
  const reset = function () {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">my_location</span> Deteksi'; }
  };

  /* 1. Cek secure context — penyebab paling umum gagal */
  if (!window.isSecureContext) {
    toast('Lokasi diblokir browser: situs harus diakses via HTTPS atau localhost (bukan http://IP). Akses lewat localhost atau pasang HTTPS.', 'danger');
    return;
  }
  if (!navigator.geolocation) {
    toast('Browser tidak mendukung geolokasi.', 'warning');
    return;
  }

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Mendeteksi...'; }

  navigator.geolocation.getCurrentPosition(
    function (pos) {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      if (input) input.value = lat + ', ' + lng;
      /* panggil preview apa pun yang tersedia di halaman ini */
      if (typeof previewKoordinat === 'function') previewKoordinat();
      if (typeof previewKoordinatPelanggan === 'function') previewKoordinatPelanggan();
      reset();
      toast('Lokasi terdeteksi: ' + lat + ', ' + lng, 'success');
    },
    function (err) {
      reset();
      let msg;
      if (err.code === 1)      msg = 'Akses lokasi ditolak. Klik ikon gembok di address bar → izinkan "Lokasi".';
      else if (err.code === 2) msg = 'Lokasi tidak tersedia. Pastikan GPS/Wi-Fi aktif.';
      else                     msg = 'Deteksi lokasi timeout. Coba lagi.';
      toast(msg, 'danger');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}


/* ══════════════════════════════════════════════════════════
   AUTO-INIT saat DOM siap
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  initBottomNav();
  initHeaderCanvas();
  initDateBadge();

  var _path = window.location.pathname;

  /* Halaman yang boleh diakses tanpa login */
  var _publicPages = ['/auth/', '/landing/', '/portal/', '/superadmin/'];
  var _isPublic = _publicPages.some(function(p) { return _path.includes(p); });

  /* ── Guard: belum login → paksa ke halaman login ── */
  if (!_isPublic && !localStorage.getItem('tf_token')) {
    var _returnUrl = encodeURIComponent(window.location.href);
    window.location.replace('/app/frontend/auth/auth.html?next=' + _returnUrl);
    return;
  }

  /* Superadmin yang nyasar ke halaman ISP → redirect ke panel superadmin */
  if (!_isPublic && localStorage.getItem('tf_network_id') === '__superadmin__') {
    if (!_path.includes('/superadmin/')) {
      window.location.replace('/app/frontend/superadmin/superadmin.html');
      return;
    }
  }

  if (!_isPublic && localStorage.getItem('tf_token')) {
    initProfileHeader();
    initDropdownHeader();
    applyRbacUi();
    applyUIPermissions();
    checkSubscriptionLock();
  }
});


/* ══════════════════════════════════════════════════════════
   CEK STATUS LANGGANAN — jika owner terkunci (trial habis /
   langganan expired / suspended), arahkan ke halaman Langganan.
   Halaman Langganan & Superadmin dikecualikan agar tidak loop.
══════════════════════════════════════════════════════════ */
function checkSubscriptionLock() {
  var path = window.location.pathname;
  /* Jangan cek di halaman langganan / superadmin / auth */
  if (path.includes('/langganan/') || path.includes('/superadmin/') || path.includes('/auth/')) return;

  var base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  fetch(base + '/api/usage', { credentials: 'include' })
    .then(function (r) {
      if (r.status === 402) return { status: 'locked' };
      return r.ok ? r.json() : null;
    })
    .then(function (d) {
      if (!d) return;
      if (d.status !== 'locked' && d.status !== 'suspended') return;

      var role = localStorage.getItem('tf_role') || '';
      if (role === 'owner') {
        /* Owner → arahkan ke halaman Langganan untuk pilih/perpanjang paket */
        if (typeof toast === 'function') toast('Masa trial / langganan berakhir. Mengarahkan ke Langganan…', 'warning');
        setTimeout(function () { window.location.href = '/app/frontend/langganan/langganan.html'; }, 1200);
      } else {
        /* Anggota tim tidak bisa kelola langganan → beri info saja (tanpa redirect, hindari loop) */
        if (typeof toast === 'function') toast('Workspace terkunci. Hubungi Owner untuk memperpanjang langganan.', 'danger');
      }
    })
    .catch(function () { /* offline → abaikan */ });
}

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
    'technofix_user',   // ← key utama dari auth.js (sebelumnya tidak dihapus!)
    'tf_token', 'tf_user_id', 'tf_username',
    'tf_role', 'tf_network_id', 'tf_isp_name',
    'tf_permissions',   // ← untuk applyUIPermissions()
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
   RBAC & profile init sudah digabungkan ke blok DOMContentLoaded
   tunggal di atas (bagian AUTO-INIT). Tidak perlu blok terpisah.
══════════════════════════════════════════════════════════ */

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
   initDropdownHeader sudah digabungkan ke blok DOMContentLoaded
   tunggal di atas. Tidak perlu blok terpisah.
══════════════════════════════════════════════════════════ */

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

  /* Menu profil (tanpa data-perm) — gating berdasarkan href:
     - Manajemen User → owner + admin (punya perm 'manajemen_user')
     - Langganan       → owner saja (punya perm 'langganan') */
  if (!isOwner) {
    document.querySelectorAll('a[href*="manajemen_user"]').forEach(function (el) {
      el.style.display = permissions.includes('manajemen_user') ? '' : 'none';
    });
    document.querySelectorAll('a[href*="langganan"]').forEach(function (el) {
      el.style.display = permissions.includes('langganan') ? '' : 'none';
    });
  }

  /* Guard halaman — redirect jika peran tidak punya izin halaman ini.
     Token selaras dengan roles.py: perangkat, maps, keuangan,
     manajemen_user, langganan. */
  if (!isOwner) {
    var PAGE_PERM_MAP = {
      '/keuangan/':         'keuangan',
      '/tagihan/':          'keuangan',
      '/loket/':            'bayar',
      '/notifikasi/':       'pelanggan',
      '/pembayaran/':       'bayar',
      '/genieacs/':         'perangkat',
      '/maps/':             'maps',
      '/input_perangkat/':  'perangkat',
      '/manajemen_user/':   'manajemen_user',
      '/langganan/':        'langganan',
    };
    /* Permission kolektor dari roles.py mungkin belum ada di localStorage
       user lama — inject secara dinamis berdasarkan role dan simpan ke localStorage */
    if (role === 'kolektor') {
      var kolPerms = ['pelanggan', 'bayar', 'maps'];
      var updated = false;
      kolPerms.forEach(function(p) {
        if (!permissions.includes(p)) { permissions.push(p); updated = true; }
      });
      if (updated) {
        try { localStorage.setItem('tf_permissions', JSON.stringify(permissions)); } catch(_) {}
      }
    }
    // Owner/admin: pastikan perangkat_manage ada
    if (role === 'owner' || role === 'admin') {
      if (!permissions.includes('perangkat_manage')) {
        permissions.push('perangkat_manage');
        try { localStorage.setItem('tf_permissions', JSON.stringify(permissions)); } catch(_) {}
      }
    }
    var path = window.location.pathname;
    for (var pagePath in PAGE_PERM_MAP) {
      if (path.includes(pagePath) && !permissions.includes(PAGE_PERM_MAP[pagePath])) {
        if (typeof toast === 'function') toast('Akses ditolak untuk peran Anda.', 'danger');
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
/* ══════════════════════════════════════════════════════════
   DARK MODE
══════════════════════════════════════════════════════════ */
(function() {
  // Halaman auth, landing, portal, superadmin → selalu light mode
  var _noThemePaths = ['/auth/', '/landing/', '/portal/', '/superadmin/'];
  var _pathNow = window.location.pathname;
  if (_noThemePaths.some(function(p){ return _pathNow.includes(p); })) return;
  var saved = localStorage.getItem('tf_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
})();

function toggleDarkMode() {
  var cur  = document.documentElement.getAttribute('data-theme') || 'light';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('tf_theme', next);
  document.querySelectorAll('.dark-toggle-input').forEach(function(el) {
    el.checked = (next === 'dark');
  });
  var icon = document.getElementById('dark-mode-icon');
  if (icon) icon.textContent = next === 'dark' ? 'light_mode' : 'dark_mode';
}

window.toggleDarkMode = toggleDarkMode;

/* Sync toggle on DOM ready */
document.addEventListener('DOMContentLoaded', function() {
  var cur = localStorage.getItem('tf_theme') || 'light';
  document.querySelectorAll('.dark-toggle-input').forEach(function(el) {
    el.checked = (cur === 'dark');
  });
  var icon = document.getElementById('dark-mode-icon');
  if (icon) icon.textContent = cur === 'dark' ? 'light_mode' : 'dark_mode';
});
