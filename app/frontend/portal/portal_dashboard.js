/* ============================================================
   portal_dashboard.js — Portal Pelanggan TechnoFix-Bill
   v2.1 — Fix: konsistensi key backend, endpoint lengkap
   ============================================================
   Perubahan v2.1:
   ✅ Naming state: pelangganData → _pelangganData, statusData → _statusData
   ✅ Fix parse rate_down/rate_up — backend kirim string "10M/5M" atau terpisah
   ✅ fetch tagihan/tiket/perpanjang/ganti-password sudah ada endpoint backend
   ✅ credentials: 'include' sudah konsisten di semua fetch
   ============================================================ */

'use strict';

const PORTAL_API = (function(){
  var h = window.location.hostname;
  var base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  if (!base) {
    if (h === 'localhost' || h === '127.0.0.1') base = 'http://127.0.0.1:5000';
    else if (h === '192.168.70.7')              base = 'http://192.168.70.7:5000';
    // 103.194.175.54, 172.15.0.11, technofix-bill.com & lainnya → same-origin
    // (port 5000 diblokir firewall dari luar — HARUS lewat Apache reverse
    // proxy, bukan port langsung. Beda port = beda origin = cookie sesi
    // login tidak konsisten, picu redirect loop login<->dashboard).
  }
  return base + '/api/portal';
})();
let _pelangganData = null;
let _statusData    = null;

/* ════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const ok = await checkSession();
  if (!ok) return;
  await Promise.all([loadDetail(), loadStatus()]);
});

async function checkSession() {
  try {
    const r = await fetch(`${PORTAL_API}/check`, { credentials: 'include' });
    if (!r.ok) throw new Error();
    const d = await r.json();
    if (!d.logged_in) {
      window.location.replace('/app/frontend/portal/portal_login.html');
      return false;
    }
    return true;
  } catch (_) {
    window.location.replace('/app/frontend/portal/portal_login.html');
    return false;
  }
}

/* ════════════════════════════════════════════════════════════
   TAB NAVIGATION
════════════════════════════════════════════════════════════ */
function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.remove('active'));
  const content = document.getElementById(`tab-${tabName}`);
  if (content) content.classList.add('active');
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(el => el.classList.add('active'));

  // Lazy load per tab
  if (tabName === 'tagihan')    loadTagihan();
  if (tabName === 'tiket')      loadTiket();
  if (tabName === 'pengaturan') renderPengaturan();
  if (tabName === 'speedtest')  { setTimeout(_stInit, 50); }
}

/* ════════════════════════════════════════════════════════════
   LOAD DATA DETAIL PELANGGAN
════════════════════════════════════════════════════════════ */
async function loadDetail() {
  try {
    const r = await fetch(`${PORTAL_API}/detail`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _pelangganData = await r.json();

    // Jika akun di-nonaktifkan ATAU sedang diisolir krn nunggak (profil
    // diganti ke profil isolir, akun tetap aktif supaya bisa login & bayar)
    // → redirect ke halaman isolir
    if (_pelangganData.aktif === false || _pelangganData.isolir === true) {
      window.location.replace('/app/frontend/isolir/isolir.html');
      return;
    }

    renderDetail(_pelangganData);
  } catch (e) {
    toast('Gagal memuat data langganan', 'danger');
  }
}

function renderDetail(d) {
  const displayName = d.nama || d.username || '—';
  const avatarTxt   = initials(displayName);

  // Header avatar & greeting
  setText('portal-username', displayName);
  setText('portal-avatar', avatarTxt);
  setText('portal-greeting', 'Halo, ' + (d.nama || d.username || '—'));

  // Welcome card sapaan
  setText('welcome-avatar', avatarTxt);
  // Pilih sapaan berdasarkan waktu
  const hour = new Date().getHours();
  const sapa = hour < 11 ? 'Selamat Pagi' : hour < 15 ? 'Selamat Siang' : hour < 18 ? 'Selamat Sore' : 'Selamat Malam';
  setText('welcome-greeting', sapa + '! 👋');
  setText('welcome-name', displayName);
  setText('welcome-sub', d.profil ? `Paket ${d.profil} · ${d.router_name || 'TechnoFix-Bill'}` : 'Selamat datang di Portal Pelanggan TechnoFix-Bill');

  // Waktu login sesi ini
  const loginAtEl = document.getElementById('welcome-login-at');
  if (loginAtEl && d.login_at) {
    try {
      const dt = new Date(String(d.login_at).replace(' ', 'T'));
      if (!isNaN(dt)) {
        setText('welcome-login-at-text', 'Masuk: ' + dt.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
        loginAtEl.style.display = '';
      }
    } catch (_) {}
  }

  // Pesan pengumuman dari ISP (diset di Pengaturan > Portal)
  const wmBanner = document.getElementById('welcome-msg-banner');
  const wmText   = document.getElementById('welcome-msg-text');
  if (wmBanner && wmText) {
    if (d.welcome_msg) {
      wmText.textContent = d.welcome_msg;
      wmBanner.style.display = '';
    } else {
      wmBanner.style.display = 'none';
    }
  }

  // Tampilkan paket di welcome card
  const paketWrap = document.getElementById('welcome-paket-wrap');
  if (paketWrap && d.profil) {
    paketWrap.style.display = '';
    setText('welcome-paket', d.profil);
    setText('welcome-price', d.harga > 0 ? `Rp ${fmtRupiah(d.harga)}/bln` : '');
  }

  setText('paket-val',   d.profil || '—');
  const rate = _parseRate(d);
  setText('paket-speed', rate.down !== 'unlimited' || rate.up !== 'unlimited'
    ? `↓ ${rate.down} / ↑ ${rate.up}` : '—');

  renderJatuhTempo(d.tgl_jatuh);

  setText('pinfo-username',   d.username  || '—');
  setText('pinfo-hp',         d.hp        || '—');
  setText('pinfo-profil',     d.profil    || '—');
  setText('pinfo-speed',      rate.down !== 'unlimited' || rate.up !== 'unlimited'
    ? `↓ ${rate.down} / ↑ ${rate.up}` : '—');
  setText('pinfo-harga',      d.harga > 0 ? `Rp ${fmtRupiah(d.harga)}/bulan` : '—');
  setText('pinfo-tgl-pasang', fmtTanggal(d.tgl_pasang));
  setText('pinfo-tgl-jatuh',  fmtTanggal(d.tgl_jatuh));
  renderSisaHari(d.tgl_jatuh);

  const rx = d.rx_power;
  renderRxGauge(rx);
  setText('pinfo-rx',   rx != null ? `${Number(rx).toFixed(2)} dBm` : '—');
  setText('pinfo-tx',   d.tx_power != null ? `${Number(d.tx_power).toFixed(2)} dBm` : '—');
  setText('pinfo-sn',   d.sn        || '—');
  setText('pinfo-slot', d.slot_port || '—');
  setText('pinfo-vlan', d.vlan      || '—');

  renderRxCard(rx);

  // Isi data di perpanjang form
  setText('perp-paket', d.profil || '—');
  setText('perp-harga', d.harga > 0 ? `Rp ${fmtRupiah(d.harga)}` : 'Hubungi admin');

  // Cek apakah perlu tampilkan banner perpanjang
  const sisa = sisaHari(d.tgl_jatuh);
  renderBannerPerpanjang(sisa, d.tgl_jatuh);
}

/* ════════════════════════════════════════════════════════════
   LOAD STATUS KONEKSI REALTIME
════════════════════════════════════════════════════════════ */
async function loadStatus() {
  setStatusLoading();
  try {
    const r = await fetch(`${PORTAL_API}/status`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _statusData = await r.json();
    renderStatus(_statusData);
  } catch (e) {
    renderStatusOffline('Gagal mengambil status koneksi');
  }
}

function setStatusLoading() {
  const heroLabel = document.getElementById('hero-status-label');
  const heroSub   = document.getElementById('hero-status-sub');
  if (heroLabel) heroLabel.textContent = 'Mengecek...';
  if (heroSub)   heroSub.textContent   = 'Memuat status koneksi realtime';
  const statusEl = document.getElementById('pinfo-status');
  if (statusEl) statusEl.innerHTML =
    `<span class="badge syncing"><span class="badge-dot spin"></span>Mengecek...</span>`;
}

function renderStatus(d) {
  const isOnline  = d.online === true;
  const heroIcon  = document.getElementById('hero-status-icon');
  const heroLabel = document.getElementById('hero-status-label');
  const heroSub   = document.getElementById('hero-status-sub');
  const heroUptime = document.getElementById('hero-uptime-wrap');

  if (heroIcon) {
    heroIcon.className = `portal-status-icon ${isOnline ? 'online' : 'offline'}`;
    heroIcon.innerHTML = `<span class="material-symbols-outlined">${isOnline ? 'wifi' : 'wifi_off'}</span>`;
  }
  if (heroLabel) heroLabel.textContent = isOnline ? 'Koneksi Aktif' : 'Tidak Terhubung';
  if (heroSub)   heroSub.textContent   = isOnline
    ? `Terhubung via ${d.router_name || 'MikroTik'}`
    : 'Modem Anda sedang tidak terhubung ke jaringan';

  if (heroUptime) {
    heroUptime.style.display = isOnline && d.uptime ? 'flex' : 'none';
    document.getElementById('hero-uptime').textContent = d.uptime || '';
  }

  const statusEl = document.getElementById('pinfo-status');
  if (statusEl) {
    statusEl.innerHTML = isOnline
      ? `<span class="badge connected"><span class="badge-dot"></span>Online</span>`
      : `<span class="badge failed"><span class="badge-dot"></span>Offline</span>`;
  }

  setText('pinfo-ip',     d.ip      || (isOnline ? '—' : 'Tidak terhubung'));
  setText('pinfo-mac',    d.mac     || '—');
  setText('pinfo-uptime', d.uptime  || '—');
  setText('pinfo-router', d.router_name || '—');

  // Traffic sesi
  const dlEl = document.getElementById('traffic-dl');
  const ulEl = document.getElementById('traffic-ul');
  if (isOnline && d.bytes_in != null) {
    if (dlEl) dlEl.textContent = '↓ ' + _fmtBytes(d.bytes_in);
    if (ulEl) ulEl.textContent = '↑ ' + _fmtBytes(d.bytes_out);
  } else {
    if (dlEl) dlEl.textContent = '↓ —';
    if (ulEl) ulEl.textContent = '↑ —';
  }
}

function _fmtBytes(b) {
  const n = parseInt(b, 10) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576)    return (n / 1048576).toFixed(1)    + ' MB';
  if (n >= 1024)       return (n / 1024).toFixed(0)       + ' KB';
  return n + ' B';
}

function renderStatusOffline(msg) {
  const heroIcon  = document.getElementById('hero-status-icon');
  const heroLabel = document.getElementById('hero-status-label');
  const heroSub   = document.getElementById('hero-status-sub');
  if (heroIcon) {
    heroIcon.className = 'portal-status-icon offline';
    heroIcon.innerHTML = `<span class="material-symbols-outlined">wifi_off</span>`;
  }
  if (heroLabel) heroLabel.textContent = 'Tidak Terhubung';
  if (heroSub)   heroSub.textContent   = msg;
  const statusEl = document.getElementById('pinfo-status');
  if (statusEl) statusEl.innerHTML =
    `<span class="badge failed"><span class="badge-dot"></span>Offline</span>`;
  ['pinfo-ip','pinfo-mac','pinfo-uptime','pinfo-router'].forEach(id => setText(id, '—'));
}

/* ════════════════════════════════════════════════════════════
   RX GAUGE
════════════════════════════════════════════════════════════ */
function renderRxGauge(rx) {
  const fill  = document.getElementById('rx-gauge-fill');
  const text  = document.getElementById('rx-gauge-text');
  if (!fill || !text) return;

  // SVG circle r=30 → circumference = 2*π*30 ≈ 188.5
  const CIRC = 188.5;

  if (rx == null) {
    text.textContent  = '—';
    fill.style.stroke = 'rgba(255,255,255,.2)';
    fill.setAttribute('stroke-dashoffset', CIRC);
    return;
  }

  const rxNum = Number(rx);
  const pct   = Math.min(1, Math.max(0, (rxNum - (-35)) / ((-10) - (-35))));
  const offset = CIRC * (1 - pct);

  let color;
  if (rxNum > -20)      color = '#16a34a';
  else if (rxNum > -27) color = '#d97706';
  else                  color = '#dc2626';

  fill.style.stroke = color;
  fill.setAttribute('stroke-dashoffset', offset.toFixed(1));
  text.textContent  = rxNum.toFixed(1);
  text.setAttribute('fill', color);
}

function renderRxCard(rx) {
  const iconWrap = document.getElementById('rx-icon-wrap');
  const rxVal    = document.getElementById('rx-val');
  const rxSub    = document.getElementById('rx-sub');
  if (!iconWrap || !rxVal) return;

  if (rx == null) {
    iconWrap.className = 'psc-icon';
    rxVal.textContent  = '—';
    if (rxSub) rxSub.textContent = 'Data tidak tersedia';
    return;
  }

  const rxNum = Number(rx);
  let cls, sub;
  if (rxNum > -20)      { cls = 'green'; sub = 'Normal'; }
  else if (rxNum > -27) { cls = 'amber'; sub = 'Redaman sedang'; }
  else                  { cls = 'red';   sub = 'Sinyal lemah!'; }

  iconWrap.className = `psc-icon ${cls}`;
  rxVal.textContent  = `${rxNum.toFixed(1)} dBm`;
  if (rxSub) rxSub.textContent = sub;
}

/* ════════════════════════════════════════════════════════════
   JATUH TEMPO & BANNER PERPANJANG
════════════════════════════════════════════════════════════ */
function renderJatuhTempo(tgl) {
  const jatuhVal  = document.getElementById('jatuh-val');
  const jatuhSub  = document.getElementById('jatuh-sub');
  const jatuhIcon = document.getElementById('jatuh-icon-wrap');
  if (!jatuhVal) return;

  if (!tgl) {
    jatuhVal.textContent = '—';
    if (jatuhSub) jatuhSub.textContent = 'Tidak diset';
    return;
  }

  const sisa = sisaHari(tgl);
  jatuhVal.textContent = fmtTanggal(tgl);

  if (sisa <= 0) {
    if (jatuhSub)  jatuhSub.textContent = 'Sudah jatuh tempo!';
    if (jatuhIcon) jatuhIcon.className  = 'psc-icon red';
  } else if (sisa <= 7) {
    if (jatuhSub)  jatuhSub.textContent = `${sisa} hari lagi`;
    if (jatuhIcon) jatuhIcon.className  = 'psc-icon amber';
  } else {
    if (jatuhSub)  jatuhSub.textContent = `${sisa} hari lagi`;
    if (jatuhIcon) jatuhIcon.className  = 'psc-icon green';
  }
}

function renderSisaHari(tgl) {
  const el = document.getElementById('pinfo-sisa-hari');
  if (!el) return;
  if (!tgl) { el.textContent = '—'; return; }
  const sisa = sisaHari(tgl);
  if (sisa <= 0)      el.innerHTML = `<span style="color:var(--red);font-weight:700">Sudah jatuh tempo!</span>`;
  else if (sisa <= 7) el.innerHTML = `<span style="color:var(--amber);font-weight:700">${sisa} hari lagi</span>`;
  else                el.innerHTML = `<span style="color:var(--green);font-weight:700">${sisa} hari lagi</span>`;
}

function renderBannerPerpanjang(sisa, tgl) {
  const banner = document.getElementById('perpanjang-banner');
  if (!banner) return;
  if (sisa == null) return;

  if (sisa <= 0) {
    banner.style.display = '';
    banner.className     = 'perpanjang-banner expired';
    setText('pb-title', 'Paket sudah habis!');
    setText('pb-sub',   'Akun Anda mungkin sudah diblokir. Perpanjang sekarang.');
  } else if (sisa <= 7) {
    banner.style.display = '';
    banner.className     = 'perpanjang-banner warning';
    setText('pb-title', `Paket habis dalam ${sisa} hari (${fmtTanggal(tgl)})`);
    setText('pb-sub',   'Perpanjang sekarang agar koneksi tidak terputus.');
  } else {
    banner.style.display = 'none';
  }
}

/* ════════════════════════════════════════════════════════════
   TAGIHAN
════════════════════════════════════════════════════════════ */
async function loadTagihan() {
  const icon = document.getElementById('tagihan-refresh-icon');
  if (icon) icon.classList.add('spin');

  try {
    const r = await fetch(`${PORTAL_API}/tagihan`, { credentials: 'include' });
    if (!r.ok) throw new Error();
    const d = await r.json();
    renderTagihan(d);
  } catch (e) {
    document.getElementById('tagihan-list').innerHTML =
      `<div class="portal-empty"><span class="material-symbols-outlined">error</span><div>Gagal memuat data tagihan.</div></div>`;
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

function renderTagihan(d) {
  // Ringkasan — support format lama (pending) dan baru (belum_bayar)
  const ring = d.ringkasan || {};
  const totalLunas   = ring.total_lunas  || 0;
  const jmlLunas     = ring.jumlah_lunas || 0;
  const totalBelum   = ring.total_belum  || ring.total_pending  || 0;
  const jmlBelum     = ring.jumlah_belum || ring.jumlah_pending || 0;

  setText('stat-lunas-nominal',   totalLunas  > 0 ? `Rp ${fmtRupiah(totalLunas)}`  : 'Rp 0');
  setText('stat-lunas-count',     `${jmlLunas} tagihan`);
  setText('stat-pending-nominal', totalBelum  > 0 ? `Rp ${fmtRupiah(totalBelum)}` : 'Rp 0');
  setText('stat-pending-count',   `${jmlBelum} tagihan`);

  // Tabel rows
  const tbody = document.getElementById('tagihan-list');
  if (!d.tagihan || d.tagihan.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="p-empty"><span class="material-symbols-outlined">receipt_long</span><div class="p-empty-txt">Belum ada riwayat tagihan.</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = d.tagihan.map(t => {
    const isLunas  = t.status === 'lunas' || t.status === 'Lunas';
    const isBelum  = t.status === 'belum_bayar';
    const statusLbl = isLunas ? 'Lunas' : isBelum ? 'Belum Bayar' : (t.status || '—');
    const badgeCls  = isLunas ? 'badge-on' : isBelum ? 'badge-iso' : 'badge-off';
    const strukBtn  = isLunas
      ? `<button class="icon-btn-sm" title="Lihat struk" onclick="_lihatStruk(${t.id})"><span class="material-symbols-outlined">receipt</span></button>`
      : '—';
    return `<tr>
      <td style="font-weight:700">${escHtml(t.periode || '—')}</td>
      <td>${escHtml(t.profil || t.keterangan || '—')}</td>
      <td style="font-weight:700">Rp ${fmtRupiah(t.nominal)}</td>
      <td>${fmtTanggal(t.jatuh_tempo || '')}</td>
      <td>${isLunas ? fmtTanggal(t.paid_at || '') : '—'}</td>
      <td>${escHtml(t.metode || '—')}</td>
      <td><span class="badge-status ${badgeCls}"><span class="badge-dot"></span>${statusLbl}</span></td>
      <td>${strukBtn}</td>
    </tr>`;
  }).join('');
}

function _lihatStruk(tagihanId) {
  const url = `/app/frontend/invoice/struk.html?id=${tagihanId}&portal=1`;
  window.open(url, '_blank', 'width=440,height=700,noopener');
}

/* ════════════════════════════════════════════════════════════
   PERPANJANG PAKET
════════════════════════════════════════════════════════════ */
function openPerpanjang() {
  const card = document.getElementById('card-perpanjang');
  const info = document.getElementById('card-info-bayar');
  if (card) { card.style.display = ''; card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (info) info.style.display = 'none';
}

function closePerpanjang() {
  const card = document.getElementById('card-perpanjang');
  if (card) card.style.display = 'none';
}

async function submitPerpanjang() {
  const btn     = document.getElementById('btn-perpanjang');
  const metode  = document.getElementById('perp-metode')?.value || 'Transfer';
  const catatan = document.getElementById('perp-catatan')?.value.trim() || '';

  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Mengirim...';

  try {
    const r = await fetch(`${PORTAL_API}/perpanjang`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ metode, catatan }),
    });
    const d = await r.json();

    if (r.ok && d.success) {
      closePerpanjang();
      renderInfoBayar(d);
      toast('Request perpanjangan berhasil dikirim!', 'success');
      loadTagihan();
    } else {
      toast(d.error || 'Gagal mengirim request.', 'danger');
    }
  } catch (e) {
    toast('Tidak dapat terhubung ke server.', 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">send</span> Kirim Request';
  }
}

function renderInfoBayar(d) {
  const card = document.getElementById('card-info-bayar');
  const list = document.getElementById('info-bayar-list');
  if (!card || !list) return;

  const ib = d.info_bayar || {};
  list.innerHTML = `
    <div class="portal-info-row">
      <span class="portal-info-key">No. Referensi</span>
      <span class="portal-info-val mono">#${d.trx_id}</span>
    </div>
    <div class="portal-info-row">
      <span class="portal-info-key">Nominal</span>
      <span class="portal-info-val" style="color:var(--primary);font-weight:800">${d.nominal_fmt}</span>
    </div>
    <div class="portal-info-row">
      <span class="portal-info-key">Bank</span>
      <span class="portal-info-val">${escHtml(ib.bank || '—')}</span>
    </div>
    <div class="portal-info-row">
      <span class="portal-info-key">No. Rekening</span>
      <span class="portal-info-val mono">${escHtml(ib.rekening || ib.nomor || '—')}</span>
    </div>
    <div class="portal-info-row">
      <span class="portal-info-key">Atas Nama</span>
      <span class="portal-info-val">${escHtml(ib.atas_nama || ib.nama || '—')}</span>
    </div>
    <div class="portal-info-row">
      <span class="portal-info-key">Keterangan</span>
      <span class="portal-info-val small">${escHtml(ib.keterangan || ib.ket || '—')}</span>
    </div>
    ${d.rekening && d.rekening.length > 1 ? `
    <div class="portal-info-row" style="flex-direction:column;gap:8px;margin-top:8px">
      <span class="portal-info-key">Opsi Rekening Lain</span>
      ${d.rekening.slice(1).map(r => `<div style="font-size:12.5px;color:var(--text2)"><b>${escHtml(r.bank||'')}</b> ${escHtml(r.nomor||r.rekening||'')} a/n ${escHtml(r.nama||r.atas_nama||'')}</div>`).join('')}
    </div>` : ''}
  `;
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ════════════════════════════════════════════════════════════
   TIKET / LAPORAN GANGGUAN
════════════════════════════════════════════════════════════ */
async function loadTiket() {
  const icon = document.getElementById('tiket-refresh-icon');
  if (icon) icon.classList.add('spin');

  try {
    const r = await fetch(`${PORTAL_API}/tiket`, { credentials: 'include' });
    if (!r.ok) throw new Error();
    const tikets = await r.json();
    renderTiketList(tikets);

    // Update badge tab jika ada tiket aktif
    const aktif = tikets.filter(t => ['Baru','Diproses'].includes(t.status)).length;
    const badge = document.getElementById('tab-badge-tiket');
    if (badge) badge.style.display = aktif > 0 ? '' : 'none';

  } catch (e) {
    document.getElementById('tiket-list').innerHTML =
      `<div class="portal-empty"><span class="material-symbols-outlined">error</span><div>Gagal memuat laporan.</div></div>`;
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

function renderTiketList(tikets) {
  const list = document.getElementById('tiket-list');
  if (!tikets || tikets.length === 0) {
    list.innerHTML = `<div class="p-empty"><span class="material-symbols-outlined">support_agent</span><div class="p-empty-txt">Belum ada laporan gangguan.</div></div>`;
    return;
  }
  const dotCls   = { 'Baru':'baru','Diproses':'diproses','Selesai':'selesai','Ditutup':'selesai' };
  const badgeCls = { 'Baru':'tb-baru','Diproses':'tb-diproses','Selesai':'tb-selesai','Ditutup':'tb-selesai' };
  list.innerHTML = tikets.map(t => {
    const dc = dotCls[t.status] || 'baru';
    const bc = badgeCls[t.status] || 'tb-baru';
    return `<div class="tiket-item">
      <span class="tiket-dot ${dc}"></span>
      <div class="tiket-body">
        <div class="tiket-judul-txt">${escHtml(t.judul)}</div>
        <div class="tiket-meta">${escHtml(t.kategori)} · ${fmtTanggal((t.created_at||'').split('T')[0])}${t.catatan_cs ? ` · <em>${escHtml(t.catatan_cs)}</em>` : ''}</div>
      </div>
      <span class="tiket-badge ${bc}">${escHtml(t.status)}</span>
    </div>`;
  }).join('');
}

async function submitTiket() {
  const btn       = document.getElementById('btn-tiket');
  const kategori  = document.getElementById('tiket-kategori')?.value || 'Umum';
  const judul     = document.getElementById('tiket-judul')?.value.trim() || '';
  const deskripsi = document.getElementById('tiket-deskripsi')?.value.trim() || '';

  if (!judul) {
    toast('Judul laporan wajib diisi.', 'warning');
    document.getElementById('tiket-judul')?.focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Mengirim...';

  try {
    const r = await fetch(`${PORTAL_API}/tiket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ kategori, judul, deskripsi }),
    });
    const d = await r.json();

    if (r.ok && d.success) {
      toast('Laporan berhasil dikirim! Tim kami akan segera menghubungi Anda.', 'success');
      // Reset form
      if (document.getElementById('tiket-judul'))     document.getElementById('tiket-judul').value     = '';
      if (document.getElementById('tiket-deskripsi')) document.getElementById('tiket-deskripsi').value = '';
      loadTiket();
    } else {
      toast(d.error || 'Gagal mengirim laporan.', 'danger');
    }
  } catch (e) {
    toast('Tidak dapat terhubung ke server.', 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">send</span> Kirim Laporan';
  }
}

/* ════════════════════════════════════════════════════════════
   SPEED TEST — dark speedometer with log scale
════════════════════════════════════════════════════════════ */
function loadSpeedTest() { startSpeedTest(); }

/* ── Gauge geometry constants ─────────────────────────────── */
const _ST = {
  cx:150, cy:148, r:105,
  startAngle:225,   // degrees from 12-o'clock (CW) — 7:30 position
  sweep:270,        // total sweep degrees
  maxSpeed:1000,    // Mbps
  initialized:false
};

/* Convert angle (degrees from 12-o'clock CW) to SVG x,y */
function _stPt(angle, r) {
  const rad = (angle - 90) * Math.PI / 180;
  return { x: _ST.cx + r * Math.cos(rad), y: _ST.cy + r * Math.sin(rad) };
}

/* Build SVG arc path string */
function _stArcPath(startA, endA, r) {
  const s = _stPt(startA, r), e = _stPt(endA, r);
  const sweep = ((endA - startA) % 360 + 360) % 360;
  const large = sweep > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/* Map speed to angle using logarithmic scale */
function _stSpeedAngle(speed) {
  const pct = speed <= 0 ? 0 : Math.min(1, Math.log(1 + speed) / Math.log(1 + _ST.maxSpeed));
  return _ST.startAngle + pct * _ST.sweep;
}

/* Initialize gauge: draw background arc, ticks, labels */
function _stInit() {
  if (_ST.initialized) return;
  _ST.initialized = true;

  const bgArc = document.getElementById('st-bg-arc');
  if (!bgArc) return;
  const endAngle = _ST.startAngle + _ST.sweep;
  bgArc.setAttribute('d', _stArcPath(_ST.startAngle, endAngle, _ST.r));

  // Tick labels: log scale
  const labels = [0, 5, 10, 50, 100, 250, 500, 750, 1000];
  const tickG   = document.getElementById('st-ticks');
  if (!tickG) return;

  labels.forEach(speed => {
    const angle = _stSpeedAngle(speed);
    const outer = _stPt(angle, _ST.r + 6);
    const inner = _stPt(angle, _ST.r - 6);
    const lblPt = _stPt(angle, _ST.r + 22);

    // Tick mark
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', inner.x.toFixed(1)); line.setAttribute('y1', inner.y.toFixed(1));
    line.setAttribute('x2', outer.x.toFixed(1)); line.setAttribute('y2', outer.y.toFixed(1));
    line.setAttribute('stroke', '#cbd5e1'); line.setAttribute('stroke-width', '1.5');
    tickG.appendChild(line);

    // Label
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', lblPt.x.toFixed(1)); txt.setAttribute('y', lblPt.y.toFixed(1));
    txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('fill', '#94a3b8'); txt.setAttribute('font-size', '9');
    txt.setAttribute('font-weight', '700');
    txt.textContent = speed >= 1000 ? '1k' : speed;
    tickG.appendChild(txt);
  });

  // Set needle to 0
  _stSetGauge(0);
}

/* Update gauge: fill arc + needle + center number */
function _stSetGauge(speed) {
  const fillArc = document.getElementById('st-fill-arc');
  const needleG = document.getElementById('st-needle-g');
  const numEl   = document.getElementById('st-speed-num');
  const angle   = _stSpeedAngle(speed);

  if (fillArc) {
    if (speed <= 0) {
      fillArc.setAttribute('d', '');
    } else {
      fillArc.setAttribute('d', _stArcPath(_ST.startAngle, angle, _ST.r));
    }
  }
  if (needleG) needleG.style.transform = `rotate(${angle}deg)`;
  if (numEl)   numEl.textContent = speed < 10 ? speed.toFixed(1) : String(Math.round(speed));
}

/* Update phase bar state */
function _stPhase(active) {
  ['ping','dl','ul'].forEach(p => {
    const e = document.getElementById('stps-' + p);
    if (!e) return;
    e.classList.remove('active','done');
    if (p === active) e.classList.add('active');
  });
}
function _stDoneStep(name, val, unit) {
  const e = document.getElementById('stps-' + name);
  if (e) { e.classList.remove('active'); e.classList.add('done'); }
  const v = document.getElementById('stps-' + name + '-v');
  if (v) v.textContent = val + ' ' + unit;
}

/* Highlight/unhighlight result cards */
function _stCardActive(name) {
  ['ping','dl','ul'].forEach(p => {
    const c = document.getElementById('stc-' + p);
    if (c) c.classList.remove('active');
  });
  const c = document.getElementById('stc-' + name);
  if (c) c.classList.add('active');
}
function _stCardDone(name) {
  const c = document.getElementById('stc-' + name);
  if (c) { c.classList.remove('active'); c.classList.add('done'); }
}

function _stCenterLbl(txt, color) {
  const el = document.getElementById('st-center-lbl');
  if (!el) return;
  el.textContent = txt;
  el.setAttribute('fill', color || '#48dbfb');
}

let _stRunning = false;

async function startSpeedTest() {
  if (_stRunning) return;
  _stRunning = true;

  _stInit();

  const btn    = document.getElementById('st-action-btn');
  const noteEl = document.getElementById('st-r-note');
  const unitEl = document.getElementById('st-speed-unit');
  if (btn)    { btn.disabled=true; btn.innerHTML='<span class="material-symbols-outlined spin" style="font-size:18px">refresh</span> Menguji...'; }
  if (noteEl) noteEl.style.display='none';

  // Reset state
  _stSetGauge(0);
  ['ping','dl','ul'].forEach(p => {
    const c=document.getElementById('stc-'+p); if(c){c.classList.remove('active','done');}
    const s=document.getElementById('stps-'+p); if(s){s.classList.remove('active','done');}
    const sv=document.getElementById('stps-'+p+'-v'); if(sv)sv.textContent='';
    setText('st-r-'+(p==='ping'?'ping':p==='dl'?'dl':'ul'),'—');
  });

  // ── 1. PING ──────────────────────────────────────────────
  _stPhase('ping'); _stCardActive('ping');
  _stCenterLbl('PING','#64748b');
  if (unitEl) unitEl.textContent='ms';

  let pingMs=0;
  try { pingMs=await _stPing(); } catch(_){}
  _stSetGauge(0);
  setText('st-r-ping', pingMs);
  _stDoneStep('ping', pingMs, 'ms');
  _stCardDone('ping');
  await sleep(400);

  // ── 2. DOWNLOAD ──────────────────────────────────────────
  _stPhase('dl'); _stCardActive('dl');
  _stCenterLbl('DOWNLOAD ↓','#0040a1');
  if (unitEl) unitEl.textContent='Mbps';
  _stSetGauge(0);

  let dlMbps=0;
  try {
    dlMbps=await _stDownload(8000, mbps=>{
      _stSetGauge(mbps);
      const n=document.getElementById('st-r-dl'); if(n)n.textContent=mbps<10?mbps.toFixed(1):Math.round(mbps);
    });
  } catch(_){}
  const dlStr=_stNum(dlMbps);
  setText('st-r-dl',dlStr); _stSetGauge(dlMbps);
  _stDoneStep('dl',dlStr,'Mbps'); _stCardDone('dl');
  await sleep(500);

  // ── 3. UPLOAD ────────────────────────────────────────────
  _stPhase('ul'); _stCardActive('ul');
  _stCenterLbl('UPLOAD ↑','#0040a1');
  if (unitEl) unitEl.textContent='Mbps';
  _stSetGauge(0);

  let ulMbps=0;
  try {
    ulMbps=await _stUpload(8000, mbps=>{
      _stSetGauge(mbps);
      const n=document.getElementById('st-r-ul'); if(n)n.textContent=mbps<10?mbps.toFixed(1):Math.round(mbps);
    });
  } catch(_){}
  const ulStr=_stNum(ulMbps);
  setText('st-r-ul',ulStr); _stSetGauge(ulMbps);
  _stDoneStep('ul',ulStr,'Mbps'); _stCardDone('ul');
  await sleep(400);

  // ── SELESAI ───────────────────────────────────────────────
  ['ping','dl','ul'].forEach(p=>{const e=document.getElementById('stps-'+p);if(e)e.classList.remove('active');});
  _stCenterLbl('SELESAI ✓','#16a34a');

  let note='Tidak dapat terhubung ke server tes.';
  if      (dlMbps>=50) note='Koneksi sangat cepat — cocok untuk streaming 4K & gaming.';
  else if (dlMbps>=20) note='Koneksi baik — streaming HD & video call lancar.';
  else if (dlMbps>=5)  note='Koneksi cukup untuk browsing & streaming SD.';
  else if (dlMbps>0)   note='Koneksi lambat — pertimbangkan upgrade paket.';
  if (noteEl){noteEl.textContent=note;noteEl.style.display='block';}
  if (btn){btn.disabled=false;btn.innerHTML='<span class="material-symbols-outlined" style="font-size:18px">refresh</span> Uji Ulang';}
  _stRunning=false;
}

function _stNum(v){return v===null||v===undefined?'—':v<10?v.toFixed(1):String(Math.round(v));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/* ── Ping: 5 XHR HEAD, return median ──────────────────────── */
function _stPing() {
  return new Promise((resolve) => {
    const times = []; let i = 0;
    function next() {
      if (i >= 5) { times.sort((a,b)=>a-b); resolve(Math.round(times[Math.floor(times.length/2)]||999)); return; }
      const xhr = new XMLHttpRequest(); xhr.timeout = 5000;
      const t0 = performance.now();
      xhr.onloadend = () => { times.push(performance.now()-t0); i++; next(); };
      xhr.ontimeout = () => { times.push(999); i++; next(); };
      xhr.open('HEAD', `https://speed.cloudflare.com/__down?bytes=1&ts=${Date.now()+i}`);
      xhr.send();
    }
    next();
  });
}

/* ── Download: XHR onprogress, time-limited ───────────────── */
function _stDownload(durationMs, onUpdate) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let startTime = 0; let lastMbps = 0;
    xhr.open('GET', `https://speed.cloudflare.com/__down?bytes=100000000&ts=${Date.now()}`);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (e) => {
      if (!startTime) startTime = performance.now();
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= 0.3 && e.loaded > 0) {
        lastMbps = (e.loaded * 8) / (elapsed * 1e6);
        onUpdate(lastMbps);
      }
    };
    const timer = setTimeout(() => xhr.abort(), durationMs);
    xhr.onabort = () => { clearTimeout(timer); resolve(lastMbps); };
    xhr.onload  = () => {
      clearTimeout(timer);
      const elapsed = startTime ? (performance.now()-startTime)/1000 : 1;
      const bytes   = xhr.response ? xhr.response.byteLength : 0;
      resolve(bytes > 0 ? (bytes*8)/(elapsed*1e6) : lastMbps);
    };
    xhr.onerror = () => { clearTimeout(timer); resolve(0); };
    xhr.send();
  });
}

/* ── Upload: sequential fetch POST, text/plain avoids CORS preflight ─ */
async function _stUpload(durationMs, onUpdate) {
  const CHUNK = 256 * 1024; // 256 KB — lebih sering update
  const raw   = new Uint8Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) raw[i] = 65 + (i % 26); // printable ASCII
  // Blob text/plain = simple CORS request, no preflight
  const blob  = new Blob([raw], { type: 'text/plain' });

  const endTime  = performance.now() + durationMs;
  const t0       = performance.now();
  let   total    = 0;
  let   errCount = 0;

  while (performance.now() < endTime) {
    try {
      const res = await fetch(`https://speed.cloudflare.com/__up?ts=${Date.now()}`, {
        method: 'POST',
        body:   blob,
        cache:  'no-store',
      });
      if (!res.ok && res.status !== 200) { errCount++; if (errCount >= 3) break; continue; }
      errCount = 0;
      total += CHUNK;
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed > 0.3) onUpdate((total * 8) / (elapsed * 1e6));
    } catch(_) {
      errCount++;
      if (errCount >= 3) break;
      await sleep(200);
    }
  }
  const elapsed = (performance.now() - t0) / 1000;
  return elapsed > 0 ? (total * 8) / (elapsed * 1e6) : 0;
}

/* ════════════════════════════════════════════════════════════
   PENGATURAN
════════════════════════════════════════════════════════════ */
function renderPengaturan() {
  if (!_pelangganData) return;
  const d = _pelangganData;
  setText('setting-username', d.username || '—');
  setText('setting-hp',       d.hp       || '—');
  setText('setting-paket',    d.profil   || '—');
  setText('setting-sn',       d.sn       || '—');
}

/* ════════════════════════════════════════════════════════════
   ACTIONS
════════════════════════════════════════════════════════════ */
async function refreshAll() {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('spin');
  await Promise.all([loadDetail(), loadStatus()]);
  if (icon) icon.classList.remove('spin');
}

async function refreshStatus() {
  const icon = document.getElementById('status-refresh-icon');
  if (icon) icon.classList.add('spin');
  await loadStatus();
  if (icon) icon.classList.remove('spin');
}

async function doLogout() {
  try {
    await fetch(`${PORTAL_API}/logout`, { method: 'POST', credentials: 'include' });
  } catch (_) {}
  window.location.replace('/app/frontend/portal/portal_login.html');
}

/* ════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════ */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * Parse rate dari backend.
 * Backend bisa kirim:
 *   - { rate_down: "10M", rate_up: "5M" }  ← sudah terpisah
 *   - { rate_down: "10M/5M" }               ← gabungan (fallback MikroTik)
 *   - { rate_down: "unlimited" }
 * Return: { down: string, up: string }
 */
function _parseRate(d) {
  let down = (d.rate_down || '').toString().trim();
  let up   = (d.rate_up   || '').toString().trim();

  // Jika rate_down berisi format "X/Y" (gabungan dari MikroTik)
  if (!up && down.includes('/')) {
    const parts = down.split('/');
    down = parts[0].trim();
    up   = parts[1].trim();
  }

  // Normalisasi "unlimited" dan kosong
  if (!down || down === '0') down = 'unlimited';
  if (!up   || up   === '0') up   = 'unlimited';

  return { down, up };
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(username) {
  const parts = username.split(/[.\-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return username.substring(0, 2).toUpperCase();
}

function fmtRupiah(n) {
  return Number(n).toLocaleString('id-ID');
}

function fmtTanggal(tgl) {
  if (!tgl) return '—';
  try {
    const d = new Date(tgl);
    if (isNaN(d)) return tgl;
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) { return tgl; }
}

function sisaHari(tgl) {
  if (!tgl) return null;
  const now   = new Date(); now.setHours(0,0,0,0);
  const jatuh = new Date(tgl); jatuh.setHours(0,0,0,0);
  return Math.floor((jatuh - now) / 86400000);
}

function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast toast-${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}