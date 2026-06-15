/* ============================================================
   detail_pelanggan.js — Halaman Rincian Pelanggan TechnoFix
   Requires: global.js  ← wajib di-load lebih dulu di HTML

   Alur:
   1. Baca data pelanggan dari sessionStorage (tf_detail_pelanggan)
      yang di-set oleh pelanggan.js saat tombol "Detail" diklik.
   2. Render semua informasi ke elemen halaman.
   3. Generate script CLI OLT (ZTE GPON / Huawei) secara otomatis.
   4. Sediakan tombol aksi:
      - Enable / Disable → toggle secret PPPoE di MikroTik
      - Isolir           → ubah profil ke "Isolir" + kick active session
      - Reboot Modem     → kirim perintah reboot ke modem
      - Remote Modem     → buka IP modem di tab baru
      - Hapus Pelanggan  → pilihan: Billing / MikroTik / OLT
      - Regis Ulang      → auto-provisioning ONU ke terminal OLT
   ============================================================ */

'use strict';

/* ── Pelanggan aktif yang sedang ditampilkan ── */
let _pelanggan = null;

/* ── Tab CLI aktif: 'zte' | 'huawei' ── */
let _cliTab = 'zte';


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const raw = sessionStorage.getItem('tf_detail_pelanggan');
  if (!raw) {
    _redirectBack('Data pelanggan tidak ditemukan. Kembali ke daftar.');
    return;
  }

  try {
    _pelanggan = JSON.parse(raw);
  } catch (_) {
    _redirectBack('Data pelanggan tidak valid.');
    return;
  }

  _renderHero(_pelanggan);
  _renderInfoCards(_pelanggan);

  // Kolektor: tampilkan bar aksi terbatas + info ringkas, sembunyikan bar penuh + CLI + info penuh
  var _role = localStorage.getItem('tf_role') || '';
  if (_role === 'kolektor') {
    var barFull    = document.getElementById('dp-action-bar-full');
    var barKol     = document.getElementById('dp-action-bar-kolektor');
    var cliCol     = document.querySelector('.dp-card-cli');
    var infoFull   = document.getElementById('dp-info-full');
    var infoKol    = document.getElementById('dp-info-kolektor');
    if (barFull)  barFull.style.display  = 'none';
    if (barKol)   barKol.style.display   = '';
    if (cliCol)   cliCol.style.display   = 'none';
    if (infoFull) infoFull.style.display = 'none';
    if (infoKol)  infoKol.style.display  = '';
    // Isi info ringkas kolektor
    var p = _pelanggan;
    var fmtD = function(v){ if(!v) return '—'; try{ return new Date(v).toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}); }catch(_){ return v; } };
    _setText('kol-info-nama',       p.nama || p.username || '—');
    _setText('kol-info-username',   p.username || '—');
    _setText('kol-info-hp',         p.hp || '—');
    _setText('kol-info-profil',     p.profil || '—');
    var _rph = p.harga ? 'Rp ' + Number(p.harga).toLocaleString('id-ID') + ' / bulan' : '—';
    _setText('kol-info-tgl-jatuh',  fmtD(p.tgl_jatuh));
    // Tambah tagihan ke info kolektor jika ada elemennya
    var hEl = document.getElementById('kol-info-harga');
    if (hEl) hEl.textContent = _rph;
    _setText('kol-info-status',     p.status || '—');
    _setText('kol-info-koordinat',  p.titik_koordinat || p.koordinat || '—');
  }

  // Tentukan tab default berdasarkan tipe OLT yang tersimpan
  const tipe = (_pelanggan._oltTipe || '').toLowerCase();
  if (tipe.includes('huawei'))
    _cliTab = 'huawei';
  else if (['epon','hsgq','e04','e08'].some(k => tipe.includes(k)))
    _cliTab = 'epon';
  else
    _cliTab = 'zte';
  _syncCliTabs();
  _renderCli(_pelanggan);

  // Tampilkan warning hapus OLT secara reaktif
  const cbOlt = document.getElementById('hapus-olt');
  if (cbOlt) {
    cbOlt.addEventListener('change', () => {
      const warn = document.getElementById('hapus-olt-warning');
      if (warn) warn.style.display = cbOlt.checked ? 'flex' : 'none';
    });
  }

  // ── Load riwayat transaksi ──
  _loadRiwayat(_pelanggan.username);
});


/* ══════════════════════════════════════════════════════════
   1. HERO CARD
══════════════════════════════════════════════════════════ */
function _renderHero(p) {
  const username = p.username || '—';
  const initials = username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
  const isOnline = p.status === 'Online';

  _setText('bc-username',     username);
  _setText('dp-username',     username);
  _setText('dp-avatar',       initials);
  _setText('dp-hp',           p.hp      || '—');
  _setText('dp-profil',       p.profil  || '—');
  _setText('dp-status-label', isOnline ? 'Online' : (p.status === 'Router Disconnected' ? 'Router Off' : 'Offline'));

  const statusBadge = document.getElementById('dp-status-badge');
  if (statusBadge) {
    statusBadge.classList.toggle('online',  isOnline);
    statusBadge.classList.toggle('offline', !isOnline);
  }

  // Badge prioritas
  const badgePrioritas = document.getElementById('dp-badge-prioritas');
  if (badgePrioritas) badgePrioritas.style.display = p.is_prioritas ? 'inline-flex' : 'none';
  // Tombol piutang — tampilkan hanya untuk owner/admin
  const btnPiutang = document.getElementById('btn-dp-piutang');
  if (btnPiutang) {
    const r = localStorage.getItem('tf_role') || '';
    btnPiutang.style.display = (r === 'owner' || r === 'admin') ? '' : 'none';
  }

  const rxInfo  = (typeof parseRxTx === 'function') ? parseRxTx(p, isOnline) : _fallbackRxTx(p, isOnline);
  const rxEl    = document.getElementById('dp-rx');
  const txSubEl = document.getElementById('dp-tx-sub');

  if (rxEl) {
    rxEl.textContent = rxInfo.rxFormatted;
    rxEl.className = 'dp-rx-value ' + (
      rxInfo.rxClass === 'rx-ok'   ? 'rx-good' :
      rxInfo.rxClass === 'rx-warn' ? 'rx-warn'  :
      rxInfo.rxClass === 'rx-bad'  ? 'rx-bad'   :
      'rx-none'
    );
  }
  if (txSubEl) txSubEl.textContent = `TX: ${rxInfo.txFormatted}`;
}


/* ══════════════════════════════════════════════════════════
   2. INFO CARDS
══════════════════════════════════════════════════════════ */
function _renderInfoCards(p) {
  const fmt = v => v || '—';
  const fmtDate = v => {
    if (!v) return '—';
    try { return new Date(v).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }); }
    catch (_) { return v; }
  };
  const isOnline = p.status === 'Online';

  // Informasi Pelanggan
  _setText('info-username',   fmt(p.username));
  _setText('info-hp',         fmt(p.hp));
  _setText('info-profil',     fmt(p.profil));
  const _rp = n => n ? 'Rp ' + Number(n).toLocaleString('id-ID') + ' / bulan' : '—';
  _setText('info-harga', _rp(p.harga));
  _setText('info-tgl-pasang', fmtDate(p.tgl_pasang));
  _setText('info-tgl-jatuh',  fmtDate(p.tgl_jatuh));
  _setText('info-koordinat',  fmt(p.titik_koordinat || p.koordinat));
  _setText('info-status',     isOnline ? 'Online ✅' : (p.status === 'Router Disconnected' ? 'Router Disconnected ⚠' : 'Offline ❌'));

  // IP Address & MAC Address dari MikroTik active session
  // Field: ip_modem / address (IP yang di-assign ke pelanggan), mac_address / caller_id (MAC modem)
  _setText('info-ip-modem', fmt(p.ip_modem  || p.address));
  _setText('info-mac',      fmt(p.mac_address || p.caller_id));

  // Data OLT
  _setText('info-olt-name',  fmt(p._oltName));
  _setText('info-olt-tipe',  fmt(p._oltTipe));
  _setText('info-olt-ip',    fmt(p._oltIp));
  _setText('info-slot-port', fmt(p.slot_port));
  _setText('info-vlan',      fmt(p.vlan));
  const _snTipe = (p._oltTipe || '').toLowerCase();
  const _snIsEpon = _snTipe === 'epon' || _snTipe === 'hsgq';
  _setText('info-sn', _snIsEpon ? '(-)' : fmt(p.sn));

  const _isOnline = p.status === 'Online';
  const rxInfo = (typeof parseRxTx === 'function') ? parseRxTx(p, _isOnline) : _fallbackRxTx(p, _isOnline);
  _setText('info-rx', rxInfo.rxFormatted);
  _setText('info-tx', rxInfo.txFormatted);
}


/* ══════════════════════════════════════════════════════════
   3. CLI SCRIPT GENERATOR
   Tab ZTE C300/C600 dan Huawei MA5600/MA5800 dapat dipilih
   secara manual terlepas dari tipe OLT yang terdeteksi.
══════════════════════════════════════════════════════════ */

/**
 * Ambil & tampilkan preview script CLI dari backend (GET /cli-preview).
 * Backend memakai _build_olt_cli() — satu-satunya generator, sama persis
 * dengan yang dipakai saat "Regis Ulang" benar-benar mengirim ke OLT —
 * supaya preview tidak pernah berbeda/ketinggalan dari implementasi nyata.
 * @param {object} p - data pelanggan
 */
async function _renderCli(p) {
  const cliEl   = document.getElementById('cli-script-content');
  const labelEl = document.getElementById('dp-cli-device-label');
  const labels  = { huawei: 'Huawei MA5600/MA5800', epon: 'HSGQ EPON' };

  if (labelEl) labelEl.textContent = `${labels[_cliTab] || 'ZTE C300/C600 GPON'} Terminal — ${p._oltName || 'OLT'}`;
  if (cliEl) cliEl.textContent = 'Memuat script CLI…';

  if (!p?.id) return;

  try {
    const res  = await fetch(`${API_BASE}/api/pelanggan/${p.id}/cli-preview?cli_type=${encodeURIComponent(_cliTab)}`, {
      credentials: 'include',
      headers:     getAuthHeaders(),
    });
    const data = await res.json();

    if (!res.ok) {
      if (cliEl) cliEl.textContent = `! ${data.error || 'Gagal memuat preview script CLI dari server.'}`;
      return;
    }
    if (cliEl) cliEl.textContent = data.script || '';
    _renderCliCatatan(data.catatan_onu || '');
  } catch (e) {
    if (cliEl) cliEl.textContent = '! Tidak bisa menghubungi server untuk memuat preview script CLI.';
  }
}

/**
 * Tampilkan catatan konfigurasi manual ONU (kolom "keterangan" pada OLT)
 * di bawah script CLI — mis. langkah konfigurasi untuk ONU tanpa OMCI.
 * @param {string} catatan
 */
function _renderCliCatatan(catatan) {
  const wrap = document.getElementById('dp-cli-catatan');
  const text = document.getElementById('dp-cli-catatan-text');
  if (!wrap || !text) return;

  if (catatan && catatan.trim()) {
    text.textContent = catatan.trim();
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

/**
 * Ganti tab CLI (ZTE ↔ Huawei) dan re-render script.
 * @param {'zte'|'huawei'} tab
 */
function switchCliTab(tab) {
  _cliTab = tab;
  _syncCliTabs();
  if (_pelanggan) _renderCli(_pelanggan);
}

function _syncCliTabs() {
  const tabZte    = document.getElementById('tab-zte');
  const tabHuawei = document.getElementById('tab-huawei');
  const tabEpon   = document.getElementById('tab-epon');
  if (tabZte)    tabZte.classList.toggle('active',    _cliTab === 'zte');
  if (tabHuawei) tabHuawei.classList.toggle('active', _cliTab === 'huawei');
  if (tabEpon)   tabEpon.classList.toggle('active',   _cliTab === 'epon');
}


/* ══════════════════════════════════════════════════════════
   4. AKSI — Salin CLI Script
══════════════════════════════════════════════════════════ */
function copyCliScript() {
  const el = document.getElementById('cli-script-content');
  if (!el) return;

  const text = el.textContent;
  navigator.clipboard.writeText(text)
    .then(() => toast('Script berhasil disalin ke clipboard ✓', 'success'))
    .catch(() => {
      /* Fallback untuk browser tanpa Clipboard API */
      const ta = document.createElement('textarea');
      ta.value = text;
      Object.assign(ta.style, { position: 'fixed', opacity: '0', left: '-9999px' });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Script berhasil disalin ✓', 'success');
    });
}


/* ══════════════════════════════════════════════════════════
   5. AKSI — Enable Pelanggan (MikroTik)
   POST /api/pelanggan/<id>/enable → aktifkan secret PPPoE
══════════════════════════════════════════════════════════ */
function aksiModem(aksi) {
  if (!_pelanggan) return;

  // Teknisi tidak bisa isolir/enable/disable
  const _role = localStorage.getItem('tf_role') || '';
  if (_role === 'teknisi' && ['isolir','enable','disable'].includes(aksi)) {
    if (typeof toast === 'function') {
      toast('Aksi ini hanya bisa dilakukan oleh Admin atau Owner. Silakan hubungi Admin/Owner.', 'warning');
    }
    return;
  }

  switch (aksi) {
    case 'enable':
      _setText('enable-username', _pelanggan.username || '—');
      _bukaModal('modal-enable');
      break;

    case 'disable':
      _setText('disable-username', _pelanggan.username || '—');
      _bukaModal('modal-disable');
      break;

    case 'isolir':
      _setText('isolir-username', _pelanggan.username || '—');
      _bukaModal('modal-isolir');
      break;

    case 'reboot':
      _setText('reboot-username', _pelanggan.username || '—');
      _bukaModal('modal-reboot');
      break;

    default:
      toast(`Aksi "${aksi}" belum tersedia`, 'info');
  }
}


/* ── Konfirmasi Enable ── */
async function konfirmasiEnable() {
  await _aksiFetch(
    'btn-konfirmasi-enable',
    `${API_BASE}/api/pelanggan/${_pelanggan.id}/enable`,
    'POST',
    { username: _pelanggan.username, device_id: _pelanggan.device_id },
    `✅ ${_pelanggan.username} berhasil di-enable`,
    'modal-enable'
  );
}

/* ── Konfirmasi Disable ── */
async function konfirmasiDisable() {
  await _aksiFetch(
    'btn-konfirmasi-disable',
    `${API_BASE}/api/pelanggan/${_pelanggan.id}/disable`,
    'POST',
    { username: _pelanggan.username, device_id: _pelanggan.device_id },
    `${_pelanggan.username} berhasil di-disable`,
    'modal-disable'
  );
}

/* ── Konfirmasi Isolir ── */
async function konfirmasiIsolir() {
  await _aksiFetch(
    'btn-konfirmasi-isolir',
    `${API_BASE}/api/pelanggan/${_pelanggan.id}/isolir`,
    'POST',
    { username: _pelanggan.username, device_id: _pelanggan.device_id },
    `⚠ ${_pelanggan.username} berhasil diisolir`,
    'modal-isolir',
    'warning'
  );
}

/* ── Konfirmasi Reboot ── */
async function konfirmasiReboot() {
  await _aksiFetch(
    'btn-konfirmasi-reboot',
    `${API_BASE}/api/pelanggan/${_pelanggan.id}/reboot`,
    'POST',
    { username: _pelanggan.username, device_id: _pelanggan.device_id },
    `🔄 Perintah reboot berhasil dikirim ke modem ${_pelanggan.username}`,
    'modal-reboot'
  );
}

/* ── Remote Modem — repoint slot NAT "Remote-Onu" lalu buka di tab baru ── */
async function aksiRemoteModem() {
  if (!_pelanggan) return;
  const btn = document.getElementById('btn-remote-modem');
  _setButtonLoading(btn, '<span class="material-symbols-outlined spin">refresh</span> Menyiapkan...');

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan/${_pelanggan.id}/remote-on`, {
      method:      'POST',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify({ device_id: _pelanggan.device_id }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Gagal menyiapkan remote');
    }

    openRemoteLinksModal(data.modem_ip, data.url, _pelanggan.username);

  } catch (e) {
    toast(e.message || 'Gagal membuat remote', 'danger');
  } finally {
    _resetButtonLoading(btn, '<span class="material-symbols-outlined">settings_remote</span>Remote Modem');
  }
}


/* ══════════════════════════════════════════════════════════
   6. AKSI — Hapus Pelanggan (Billing / MikroTik / OLT)
   DELETE /api/pelanggan/<id>?target=billing,mikrotik,olt
══════════════════════════════════════════════════════════ */
function openModalHapusPelanggan() {
  if (!_pelanggan) return;

  _setText('hapus-nama-pelanggan', _pelanggan.username || '—');

  // Reset checkbox ke default
  const cbBilling  = document.getElementById('hapus-billing');
  const cbMikrotik = document.getElementById('hapus-mikrotik');
  const cbOlt      = document.getElementById('hapus-olt');
  const warning    = document.getElementById('hapus-olt-warning');

  if (cbBilling)  cbBilling.checked  = true;
  if (cbMikrotik) cbMikrotik.checked = false;
  if (cbOlt)      cbOlt.checked      = false;
  if (warning)    warning.style.display = 'none';

  // Sembunyikan opsi OLT jika tidak ada data OLT
  const cbOltParent = cbOlt?.closest('.hapus-option');
  if (cbOltParent) {
    cbOltParent.style.display = _pelanggan.olt_id && _pelanggan.slot_port ? '' : 'none';
  }

  _bukaModal('modal-hapus-pelanggan');
}

async function konfirmasiHapusPelanggan() {
  if (!_pelanggan) return;

  const billing  = document.getElementById('hapus-billing')?.checked  ?? true;
  const mikrotik = document.getElementById('hapus-mikrotik')?.checked ?? false;
  const olt      = document.getElementById('hapus-olt')?.checked      ?? false;

  if (!billing && !mikrotik && !olt) {
    toast('Pilih minimal satu target penghapusan', 'warning');
    return;
  }

  const targets = [billing && 'billing', mikrotik && 'mikrotik', olt && 'olt'].filter(Boolean);
  const btn     = document.getElementById('btn-konfirmasi-hapus');

  _setButtonLoading(btn, 'Menghapus data...');

  try {
    const res  = await fetch(`${API_BASE}/api/pelanggan/${_pelanggan.id}`, {
      method:      'DELETE',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify({
        device_id: _pelanggan.device_id,
        username:  _pelanggan.username,
        targets,
        olt_id:    _pelanggan.olt_id    || null,
        slot_port: _pelanggan.slot_port || null,
      }),
    });

    const data = await res.json();

    if (!res.ok && res.status !== 207) {
      throw new Error(data.error || data.message || 'Gagal menghapus pelanggan');
    }

    _tutupModal('modal-hapus-pelanggan');

    const targetLabel = targets.join(' + ');
    const warnings    = data.warnings || [];

    if (warnings.length > 0) {
      toast(`⚠ Hapus selesai (${targetLabel}) dengan peringatan: ${warnings[0]}`, 'warning');
    } else {
      toast(`🗑 ${_pelanggan.username} berhasil dihapus dari: ${targetLabel}`, 'danger');
    }

    // Kembali ke halaman daftar setelah 2 detik
    setTimeout(() => {
      window.location.href = '/app/frontend/pelanggan/pelanggan.html';
    }, 2000);

  } catch (err) {
    toast(err.message || 'Gagal menghubungi server', 'danger');
  } finally {
    _resetButtonLoading(btn, '<span class="material-symbols-outlined">delete</span>Ya, Hapus');
  }
}


/* ══════════════════════════════════════════════════════════
   7. AKSI — Registrasi Ulang (Auto-Provisioning OLT)
   POST /api/pelanggan/<id>/provision
══════════════════════════════════════════════════════════ */
async function registrasiUlang() {
  if (!_pelanggan) return;

  if (!_pelanggan.olt_id || !_pelanggan.sn) {
    toast('Data OLT atau SN belum lengkap. Tidak dapat melakukan auto-provisioning.', 'warning');
    return;
  }

  const oltName = _pelanggan._oltName || 'OLT';
  const konfirm = confirm(
    `Lakukan registrasi ulang ONU "${_pelanggan.username}" ke OLT "${oltName}"?\n\n` +
    `Perintah akan dikirim otomatis ke terminal OLT via SSH.\n` +
    `Tab aktif: ${_cliTab.toUpperCase()}`
  );
  if (!konfirm) return;

  const btn = document.getElementById('btn-regis-ulang');
  _setButtonLoading(btn, '<span class="material-symbols-outlined">hourglass_top</span> Mengirim perintah...');

  try {
    const res  = await fetch(`${API_BASE}/api/pelanggan/${_pelanggan.id}/provision`, {
      method:      'POST',
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify({
        olt_id:        _pelanggan.olt_id,
        slot_port:     _pelanggan.slot_port,
        vlan:          _pelanggan.vlan,
        sn:            _pelanggan.sn,
        username:      _pelanggan.username,
        profil:        _pelanggan.profil,
        tcont_profile: _pelanggan.tcont_profile || '',
        re_provision:  true,
        cli_type:      _cliTab,
      }),
    });

    const data = await res.json();

    if (!res.ok && res.status !== 207) {
      throw new Error(data.error || data.message || 'Gagal registrasi ulang');
    }

    // Jika backend mengembalikan script lengkap (dengan password real),
    // update tampilan CLI script di halaman
    if (data.script) {
      const cliEl = document.getElementById('cli-script-content');
      if (cliEl) {
        cliEl.textContent = data.script;
        toast('✅ Script CLI diperbarui dengan data lengkap dari backend', 'info');
      }
    }

    const warnings = data.warnings || [];
    if (warnings.length > 0) {
      toast(`⚠ Registrasi selesai dengan peringatan: ${warnings[0]}`, 'warning');
    } else {
      const target = data.ok
        ? `✅ Registrasi ulang "${_pelanggan.username}" berhasil dikirim ke OLT ${data.olt_name || ''}`
        : `📋 Script digenerate untuk OLT ${data.olt_name || ''} — kirim manual ke terminal`;
      toast(target, data.ok ? 'success' : 'warning');
    }

  } catch (err) {
    toast(err.message || 'Gagal menghubungi server', 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">bolt</span> Regis Ulang';
    }
  }
}


/* ══════════════════════════════════════════════════════════
   8. AKSI — Edit Pelanggan (kembali ke pelanggan.html dengan intent edit)
══════════════════════════════════════════════════════════ */
function openEditFromDetail() {
  if (!_pelanggan) return;
  try {
    sessionStorage.setItem('tf_edit_pelanggan_id', String(_pelanggan.id));
  } catch (_) { /* ignore quota errors */ }
  window.location.href = '/app/frontend/pelanggan/pelanggan.html';
}


/* ══════════════════════════════════════════════════════════
   HELPER INTERNAL — fetch aksi generik dengan loading state
   @param {string}  btnId       - ID tombol konfirmasi
   @param {string}  url         - endpoint API
   @param {string}  method      - 'POST' | 'PUT' | 'DELETE'
   @param {object}  body        - payload JSON
   @param {string}  successMsg  - pesan toast sukses
   @param {string}  modalId     - ID modal yang akan ditutup setelah berhasil
   @param {string}  [toastType] - 'success' | 'warning' | 'danger' (default 'success')
══════════════════════════════════════════════════════════ */
async function _aksiFetch(btnId, url, method, body, successMsg, modalId, toastType = 'success') {
  const btn = document.getElementById(btnId);
  _setButtonLoading(btn, 'Memproses...');

  try {
    const res  = await fetch(url, {
      method,
      credentials: 'include',
      headers:     getAuthHeaders(),
      body:        JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok && res.status !== 207) {
      throw new Error(data.error || data.message || 'Permintaan gagal');
    }

    _tutupModal(modalId);
    toast(successMsg, toastType);

    const warnings = data.warnings || [];
    if (warnings.length > 0) {
      setTimeout(() => toast(`⚠ ${warnings[0]}`, 'warning'), 600);
    }

  } catch (err) {
    toast(err.message || 'Gagal menghubungi server', 'danger');
  } finally {
    // Restore tombol — teks asal diambil dari data-label atau biarkan kosong
    const label = btn?.dataset?.label || 'Konfirmasi';
    _resetButtonLoading(btn, label);
  }
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Modal
══════════════════════════════════════════════════════════ */
function _bukaModal(id)  { document.getElementById(id)?.classList.add('open'); }
function _tutupModal(id) { document.getElementById(id)?.classList.remove('open'); }

/** Tutup modal saat klik overlay (event.target === overlay sendiri) */
function _closeModalOnOverlay(event, id) {
  if (event.target.id === id) _tutupModal(id);
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Button Loading State
══════════════════════════════════════════════════════════ */
function _setButtonLoading(btn, label) {
  if (!btn) return;
  btn.disabled   = true;
  btn.innerHTML  = label;
}

function _resetButtonLoading(btn, label) {
  if (!btn) return;
  btn.disabled  = false;
  btn.innerHTML = label;
}


/* ══════════════════════════════════════════════════════════
   HELPERS — DOM
══════════════════════════════════════════════════════════ */
function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _redirectBack(msg) {
  if (typeof toast === 'function') toast(msg, 'warning');
  setTimeout(() => {
    window.location.href = '/app/frontend/pelanggan/pelanggan.html';
  }, 1800);
}


/* ══════════════════════════════════════════════════════════
   HELPERS — Fallback parseRxTx (jika global.js belum load)
══════════════════════════════════════════════════════════ */
function _fallbackRxTx(p, isOnline) {
  if (isOnline === false) return { rx: null, tx: null, rxFormatted: '—', txFormatted: '—', rxClass: 'rx-none' };
  const rx = p.rx_power ? parseFloat(String(p.rx_power).replace(/[^\d.-]/g, '')) : null;
  const tx = p.tx_power ? parseFloat(String(p.tx_power).replace(/[^\d.-]/g, '')) : null;
  const fmt = v => (v !== null && !isNaN(v)) ? `${v.toFixed(1)} dBm` : '—';
  let rxClass = 'rx-none';
  if (rx !== null && !isNaN(rx)) {
    if      (rx < -30) rxClass = 'rx-bad';
    else if (rx < -27) rxClass = 'rx-warn';
    else               rxClass = 'rx-ok';
  }
  return { rx, tx, rxFormatted: fmt(rx), txFormatted: fmt(tx), rxClass };
}

/* ══════════════════════════════════════════════════════════
   RIWAYAT TRANSAKSI
══════════════════════════════════════════════════════════ */
async function _loadRiwayat(username) {
  if (!username) return;
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  try {
    const r = await fetch(`${base}/api/tagihan/pelanggan/${encodeURIComponent(username)}`,
      { credentials: 'include', headers: hdr });
    if (!r.ok) return;
    const d = await r.json();
    const list = d.tagihan || [];
    const sub = document.getElementById('riwayat-sub');
    if (sub) sub.textContent = list.length + ' transaksi';
    const tbody = document.getElementById('riwayat-tbody');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-dim)">Belum ada riwayat tagihan.</td></tr>';
      return;
    }
    function rp(n) { return 'Rp ' + (Number(n)||0).toLocaleString('id-ID'); }
    function fmtTgl(s) { if (!s) return '—'; try { return new Date(s).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); } catch { return s; } }
    tbody.innerHTML = list.map(t => {
      const lunas   = t.status === 'lunas';
      const piutang = t.status === 'piutang';
      const badge = lunas
        ? '<span class="rw-badge rw-lunas"><span class="dot"></span>Lunas</span>'
        : piutang
          ? '<span class="rw-badge" style="background:var(--purple-bg,#f3e8ff);color:var(--purple,#7c3aed)"><span class="dot" style="background:var(--purple,#7c3aed)"></span>Piutang</span>'
          : '<span class="rw-badge rw-belum"><span class="dot"></span>Belum Bayar</span>';
      return `<tr>
        <td class="rw-col-periode sticky-col-0">${t.periode}</td>
        <td>${t.profil || '—'}</td>
        <td class="rw-col-nominal">${rp(t.nominal)}</td>
        <td class="rw-col-dim">${fmtTgl(t.jatuh_tempo)}</td>
        <td>${badge}</td>
        <td class="rw-col-dim">${lunas ? fmtTgl(t.paid_at) : '—'}</td>
        <td class="rw-col-dim">${lunas ? (t.metode || '—') : '—'}</td>
      </tr>`;
    }).join('');
  } catch (_) {}
}


/* ══════════════════════════════════════════════════════════
   AKSI KOLEKTOR — Hubungi & Rute
══════════════════════════════════════════════════════════ */
function _dpHubungi() {
  if (!_pelanggan) return;
  var hp = (_pelanggan.hp || '').replace(/\D/g, '');
  if (!hp) { if (typeof toast === 'function') toast('Nomor HP tidak tersedia', 'warning'); return; }
  var wa = '62' + (hp.startsWith('0') ? hp.slice(1) : hp);
  window.open('https://wa.me/' + wa, '_blank');
}

function _dpRute() {
  if (!_pelanggan) return;
  var coord = _pelanggan.titik_koordinat || _pelanggan.koordinat || '';
  if (!coord) { if (typeof toast === 'function') toast('Koordinat belum diisi', 'warning'); return; }
  var parts = coord.split(',');
  var lat = parts[0] ? parts[0].trim() : '';
  var lng = parts[1] ? parts[1].trim() : '';
  if (!lat || !lng) { if (typeof toast === 'function') toast('Format koordinat tidak valid', 'warning'); return; }
  window.open('https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng, '_blank');
}


/* ══════════════════════════════════════════════════════════
   PIUTANG — dari detail pelanggan
   Cari tagihan belum_bayar terbaru milik pelanggan ini, lalu setujui piutang
══════════════════════════════════════════════════════════ */
let _dpPiutangTagihanId = null;

async function aksiPiutang() {
  if (!_pelanggan) return;
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  try {
    const r = await fetch(`${base}/api/tagihan/pelanggan/${encodeURIComponent(_pelanggan.username)}`,
      { credentials: 'include', headers: hdr });
    const d = await r.json();
    const list = (d.tagihan || []).filter(t => t.status === 'belum_bayar' || t.status === 'piutang');
    if (!list.length) {
      toast('Tidak ada tagihan belum bayar untuk pelanggan ini', 'warning');
      return;
    }
    // Ambil tagihan belum_bayar terbaru (bukan piutang)
    const belum = list.filter(t => t.status === 'belum_bayar');
    const target = belum.length ? belum[0] : list[0];
    _dpPiutangTagihanId = target.id;
    const namaEl = document.getElementById('dp-piutang-nama');
    if (namaEl) namaEl.textContent = (_pelanggan.nama || _pelanggan.username) + ' — ' + target.periode;
    _bukaModal('modal-dp-piutang');
  } catch (_) {
    toast('Gagal memuat tagihan pelanggan', 'danger');
  }
}

function tutupModalDpPiutang() {
  _dpPiutangTagihanId = null;
  _tutupModal('modal-dp-piutang');
}

async function eksekusiDpPiutang() {
  if (!_dpPiutangTagihanId) return;
  const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
  const hdr  = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  const btn  = document.getElementById('btn-dp-piutang-ok');
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }
  try {
    const r = await fetch(`${base}/api/tagihan/${_dpPiutangTagihanId}/piutang`,
      { method: 'POST', credentials: 'include', headers: hdr });
    const d = await r.json();
    toast(r.ok ? (d.message || 'Piutang disetujui') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) {
      tutupModalDpPiutang();
      _loadRiwayat(_pelanggan.username);
    }
  } catch (_) { toast('Gagal menghubungi server', 'danger'); }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">handshake</span>Ya, Setujui';
  }
}
