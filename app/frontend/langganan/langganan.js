/* langganan.js — Halaman Langganan & Paket */
'use strict';

/* Nomor WhatsApp admin TechnoFix untuk konfirmasi upgrade (sama dengan landing.html) */
const ADMIN_WA = '6283135851605';

const STATUS_LABEL = {
  trial:     { txt: 'Masa Uji Coba', cls: 'is-trial' },
  active:    { txt: 'Aktif',          cls: 'is-active' },
  locked:    { txt: 'Terkunci',       cls: 'is-locked' },
  suspended: { txt: 'Disuspend',      cls: 'is-locked' },
};

const FEATURE_LABEL = {
  mikrotik_api:        'Integrasi MikroTik (API)',
  odp_map:             'ODP & Peta Perangkat',
  remote_modem:        'Remote Modem',
  monitoring_redaman:  'Monitoring Redaman',
  broadcast:           'Broadcast Pesan',
  loket:               'Loket (Kasir)',
  payment_gateway:     'Payment Gateway',
  export:              'Laporan / Export',
  whitelabel:          'Whitelabel & Custom Logo',
  dedicated:           'Dedicated Server',
};
/* Fitur yang ditampilkan di kartu (urutan) */
const FEATURE_SHOW = ['mikrotik_api', 'monitoring_redaman', 'remote_modem', 'export', 'whitelabel'];

let _currentPaket = null;

function rupiah(n) {
  if (!n) return '0';
  return n.toLocaleString('id-ID');
}

function fmtTanggal(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '-'; }
}

function sisaHari(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

async function loadSubscription() {
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  try {
    const [subRes, useRes] = await Promise.all([
      fetch(base + '/api/subscription', { credentials: 'include' }),
      fetch(base + '/api/usage',        { credentials: 'include' }),
    ]);
    const sub = await subRes.json();
    const use = await useRes.json();
    _currentPaket = sub.current.paket;
    renderCurrent(sub.current, use);
    renderPackages(sub.packages, sub.current.paket);
  } catch (e) {
    document.getElementById('sub-current').innerHTML =
      '<div class="sub-current-loading">Gagal memuat data langganan. Pastikan sudah login.</div>';
  }
}

function renderCurrent(cur, use) {
  const st = STATUS_LABEL[cur.status] || STATUS_LABEL.trial;
  const limit = use.limit;
  const pakai = use.pelanggan || 0;
  const pct = (limit == null || limit === 0) ? 8 : Math.min(100, Math.round((pakai / limit) * 100));
  const limitTxt = (limit == null) ? '∞' : limit.toLocaleString('id-ID');

  /* catatan status */
  let note = '';
  if (cur.status === 'trial') {
    const d = sisaHari(cur.trial_end);
    note = '<div class="sub-note"><span class="material-symbols-outlined">schedule</span>' +
           'Masa uji coba berakhir ' + (d != null ? '<strong>' + d + ' hari lagi</strong> (' + fmtTanggal(cur.trial_end) + ')' : fmtTanggal(cur.trial_end)) +
           '. Pilih paket berbayar agar tidak terkunci.</div>';
  } else if (cur.status === 'active' && cur.expired_at) {
    note = '<div class="sub-note"><span class="material-symbols-outlined">event_available</span>' +
           'Langganan aktif sampai <strong>' + fmtTanggal(cur.expired_at) + '</strong>.</div>';
  } else if (cur.status === 'locked') {
    note = '<div class="sub-note"><span class="material-symbols-outlined">lock</span>' +
           'Akses data terkunci. Pilih paket di bawah untuk mengaktifkan kembali.</div>';
  }

  document.getElementById('sub-current').innerHTML =
    '<div class="sub-cur-top">' +
      '<div>' +
        '<div class="sub-cur-label">Paket Saat Ini</div>' +
        '<div class="sub-cur-name">' + (use.paket_nama || cur.paket_nama || '-') + '</div>' +
      '</div>' +
      '<span class="sub-status ' + st.cls + '"><span class="dot"></span>' + st.txt + '</span>' +
    '</div>' +
    '<div class="sub-usage">' +
      '<div class="sub-usage-row"><span>Pelanggan</span><span>' + pakai.toLocaleString('id-ID') + ' / ' + limitTxt + '</span></div>' +
      '<div class="sub-bar"><div class="sub-bar-fill" style="width:' + pct + '%"></div></div>' +
    '</div>' +
    note;
}

function renderPackages(packages, currentKey) {
  const grid = document.getElementById('sub-grid');
  /* Paket Trial tidak bisa "diupgrade" ke — backend menolak
     upgrade-request dengan paket=trial. Sembunyikan kartunya
     kecuali memang itu paket yang sedang aktif (info saja). */
  grid.innerHTML = packages.filter(function (p) {
    return p.key !== 'trial' || p.key === currentKey;
  }).map(function (p) {
    const isCur = p.key === currentKey;
    const feats = FEATURE_SHOW.map(function (fk) {
      const on = !!p.features[fk];
      return '<li><span class="material-symbols-outlined ' + (on ? 'ok' : 'no') + '">' +
        (on ? 'check_circle' : 'cancel') + '</span>' + (FEATURE_LABEL[fk] || fk) + '</li>';
    }).join('');

    const pelangganTxt = (p.limits.pelanggan == null) ? 'Tanpa batas' : p.limits.pelanggan.toLocaleString('id-ID') + ' pelanggan';
    const priceBlock = (p.price === 0)
      ? '<div class="pkg-price">Gratis</div>'
      : '<div class="pkg-price"><span class="cur">Rp</span> ' + rupiah(p.price) + '<span class="per"> /bln</span></div>';

    const btn = isCur
      ? '<button class="pkg-btn pkg-btn-current" disabled><span class="material-symbols-outlined">check</span>Paket Aktif</button>'
      : '<button class="pkg-btn pkg-btn-primary" onclick="pilihPaket(\'' + p.key + '\',\'' + p.name + '\',' + p.price + ')">' +
        '<span class="material-symbols-outlined">' + (p.price === 0 ? 'play_circle' : 'upgrade') + '</span>' +
        (p.price === 0 ? 'Mulai Trial' : 'Upgrade') + '</button>';

    return '<div class="pkg' + (isCur ? ' is-current' : '') + '">' +
      '<div class="pkg-name">' + p.name + '</div>' +
      '<div class="pkg-tag">' + (p.tagline || '') + '</div>' +
      priceBlock +
      '<div class="pkg-pelanggan">' + pelangganTxt + '</div>' +
      '<ul class="pkg-feats">' + feats + '</ul>' +
      btn +
    '</div>';
  }).join('');
}

/* Upgrade — kirim permintaan ke admin (tracked) + opsi konfirmasi via WA */
async function pilihPaket(key, nama, price) {
  if (!confirm('Ajukan upgrade ke paket "' + nama + '" (Rp ' + rupiah(price) + '/bln)?\n\nPermintaan akan dikirim ke admin untuk konfirmasi pembayaran & aktivasi.')) return;
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  try {
    const r = await fetch(base + '/api/auth/upgrade-request', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paket: key, bulan: 1 }),
    });
    const d = await r.json();
    if (r.ok) {
      if (typeof toast === 'function') toast(d.message || 'Permintaan upgrade terkirim', 'success');
      /* Lanjut konfirmasi pembayaran via WhatsApp */
      const msg = encodeURIComponent('Halo Admin TechnoFix, saya mengajukan upgrade ke paket *' + nama + '* (Rp ' + rupiah(price) + '/bln). Mohon info pembayaran & aktivasi.');
      setTimeout(function () { window.open('https://wa.me/' + ADMIN_WA + '?text=' + msg, '_blank'); }, 900);
    } else {
      if (typeof toast === 'function') toast(d.message || 'Gagal mengirim permintaan', 'danger');
    }
  } catch {
    if (typeof toast === 'function') toast('Tidak bisa menghubungi server', 'danger');
  }
}

document.addEventListener('DOMContentLoaded', loadSubscription);
