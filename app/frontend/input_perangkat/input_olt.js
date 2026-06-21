/* ============================================================
   input_olt.js — Manajemen Perangkat OLT TechnoFix-Bill
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, escHtml, val, statusInfo, animNum,
              toast, togglePwd, openModalForm, closeModalForm)

   Perubahan dari versi lama:
   - showForm()      → form muncul sebagai MODAL POPUP di tengah halaman
   - cancelForm()    → menutup modal (closeModalForm)
   - confirmDelete() → modal konfirmasi via openModalForm

   Endpoint:
   GET    /olt              → daftar semua OLT
   POST   /olt              → tambah OLT baru
   PUT    /olt/<id>         → edit OLT
   DELETE /olt/<id>         → hapus OLT
   POST   /olt/<id>/sync    → tes koneksi ulang
   ============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let devices    = [];
let routers    = [];   // daftar MikroTik untuk dropdown router OLT
let editingId  = null;
let syncingIds = new Set();

// ── SIGNAL ONU STATE ───────────────────────────────────────────
// onuSignalCache[olt_id] = { crit: N, warn: N, ok: N, list: [...] }
let onuSignalCache = {};


// ── SIGNAL HELPERS ─────────────────────────────────────────────
const RX_CRIT  = -27;  // RX < -27 dBm → kritis
const RX_WARN  = -24;  // -27 <= RX < -24 dBm → lemah

function rxSignalLevel(rx) {
  if (rx === null || rx === undefined || rx === '') return 'unknown';
  const v = parseFloat(rx);
  if (isNaN(v)) return 'unknown';
  if (v < RX_CRIT) return 'crit';
  if (v < RX_WARN) return 'warn';
  return 'ok';
}

function rxSignalClass(rx) {
  const lvl = rxSignalLevel(rx);
  if (lvl === 'crit') return 'onu-rx-crit';
  if (lvl === 'warn') return 'onu-rx-warn';
  return '';
}

function rxSignalLabel(rx) {
  const lvl = rxSignalLevel(rx);
  if (lvl === 'crit') return 'Kritis';
  if (lvl === 'warn') return 'Lemah';
  if (lvl === 'ok')   return 'Baik';
  return '—';
}


// ── HELPER: Cari elemen list/count — dukung kedua ID ──────
// HTML lama pakai 'device-list/count', HTML baru pakai 'olt-list/count'
function _listEl()  { return document.getElementById('olt-list')  || document.getElementById('device-list'); }
function _countEl() { return document.getElementById('olt-count') || document.getElementById('device-count'); }

// Resolusi nilai keyword tipe ONU dari form — kalau pilih "custom",
// ambil dari kolom teks bebas di sebelahnya.
function _resolveOnuTypeKeyword() {
  const sel = val('f-onu-type-keyword');
  if (sel === 'custom') {
    return (val('f-onu-type-keyword-custom') || '').trim().toUpperCase() || 'ALL';
  }
  return sel || 'ALL';
}


// ── HELPERS ────────────────────────────────────────────────────

function showListLoading() {
  const el = _listEl();
  if (!el) return;   // Defensive: kalau halaman bukan input_olt, skip
  el.innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined spin" style="font-size:32px;">refresh</span>
      <p>Memuat perangkat OLT...</p>
    </div>`;
}


// ── STATS ──────────────────────────────────────────────────────

function updateStats() {
  animNum('stat-total',     devices.length);
  animNum('stat-connected', devices.filter(d => d.status === 'connected').length);
  animNum('stat-failed',    devices.filter(d => d.status === 'failed').length);
  animNum('stat-pending',   devices.filter(d => d.status === 'pending').length);

  const el = _countEl();
  if (el) el.textContent = `${devices.length} Perangkat OLT`;
}


// ── API CALLS ──────────────────────────────────────────────────

async function loadDevices() {
  showListLoading();
  try {
    const [resOlt, resDev] = await Promise.all([
      fetch(`${API_BASE}/olt`,     { credentials: 'include', headers: getAuthHeaders() }),
      fetch(`${API_BASE}/devices`, { credentials: 'include', headers: getAuthHeaders() }),
    ]);
    const data = await resOlt.json();
    devices    = Array.isArray(data) ? data : (data.devices || []);
    const devData = await resDev.json();
    routers = (Array.isArray(devData) ? devData : (devData.devices || []))
      .filter(d => d.status === 'connected');
    renderDevices();
    // Cek ulang koneksi live — status di DB bisa basi (mis. OLT baru saja
    // mati lampu/terputus setelah sync terakhir). Tanpa ini, badge "Terhubung"
    // bisa menyesatkan padahal perangkat sudah tidak bisa dihubungi.
    if (devices.length) syncAll(true);
  } catch (e) {
    const errEl = _listEl();
    if (errEl) {
      errEl.innerHTML = `
        <div class="empty-state">
          <span class="material-symbols-outlined" style="font-size:40px;color:var(--red);">wifi_off</span>
          <p style="font-weight:600;color:var(--text);">Tidak bisa terhubung ke server</p>
          <p style="font-size:12px;color:var(--text-muted);">Pastikan backend Flask sudah berjalan.</p>
        </div>`;
    }
    updateStats();
  }
}

async function addDevice() {
  const name       = val('f-name');
  const tipe       = val('f-tipe');
  const ip         = val('f-ip');
  const port       = val('f-port') || '23';
  const user       = val('f-user');
  const pass       = val('f-pass');
  const snmp       = val('f-snmp');
  const lokasi     = val('f-lokasi');
  const keterangan = val('f-keterangan');
  const epon_ports = val('f-epon-ports') || '4';
  const onu_type_keyword = _resolveOnuTypeKeyword();
  const uplinks    = collectUplinks();

  if (!name || !ip || !user || !pass) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }
  if (!tipe) {
    toast('Pilih Tipe OLT terlebih dahulu (GPON/EPON)', 'warning');
    return;
  }

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/olt`, {
      method:  'POST',
      credentials: 'include', headers: getAuthHeaders(),
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, koordinat: val('f-koordinat'), keterangan, epon_ports, onu_type_keyword, uplinks }),
    });
    const data = await res.json();

    if (res.ok) {
      devices.push(data.device || data);
      cancelForm();
      renderDevices();
      toast(
        data.message || `${name} berhasil ditambahkan`,
        data.device?.status === 'connected' ? 'success' : 'danger'
      );
    } else {
      toast(data.message || 'Gagal menyimpan perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah OLT'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">add</span> Tambah OLT'; }
  }
}

async function saveEdit() {
  const name       = val('f-name');
  const tipe       = val('f-tipe');
  const ip         = val('f-ip');
  const port       = val('f-port') || '23';
  const user       = val('f-user');
  const pass       = val('f-pass');
  const snmp       = val('f-snmp');
  const lokasi     = val('f-lokasi');
  const keterangan = val('f-keterangan');
  const epon_ports = val('f-epon-ports') || '4';
  const onu_type_keyword = _resolveOnuTypeKeyword();
  const uplinks    = collectUplinks();

  if (!name || !ip || !user) {
    toast('Mohon isi semua field yang wajib diisi.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-submit-form');
  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = '<span class="material-symbols-outlined spin">refresh</span> Menyimpan...';
  }

  try {
    const res  = await fetch(`${API_BASE}/olt/${editingId}`, {
      method:  'PUT',
      credentials: 'include', headers: getAuthHeaders(),
      body:    JSON.stringify({ name, tipe, ip, port, username: user, password: pass, snmp, lokasi, koordinat: val('f-koordinat'), keterangan, epon_ports, onu_type_keyword, uplinks }),
    });
    const data = await res.json();

    if (res.ok) {
      const idx = devices.findIndex(x => x.id === editingId);
      if (idx !== -1) devices[idx] = data.device || data;
      cancelForm();
      renderDevices();
      toast('Data perangkat OLT berhasil diperbarui.', 'success');
    } else {
      toast(data.message || 'Gagal memperbarui perangkat.', 'danger');
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span> Simpan Perubahan'; }
  }
}

async function doDelete(id) {
  closeModalForm();
  try {
    const res = await fetch(`${API_BASE}/olt/${id}`, { method: 'DELETE', credentials: 'include', headers: getAuthHeaders() });
    if (res.ok) {
      devices = devices.filter(x => x.id !== id);
      renderDevices();
      toast('Perangkat OLT berhasil dihapus.', 'danger');
    } else {
      toast('Gagal menghapus perangkat.', 'danger');
    }
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
  }
}

async function syncDevice(id) {
  if (syncingIds.has(id)) return;

  syncingIds.add(id);
  renderDevices();

  try {
    const res  = await fetch(`${API_BASE}/olt/${id}/sync`, { method: 'POST', credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    const d    = devices.find(x => x.id === id);
    if (d) {
      d.status = data.connected ? 'connected' : 'failed';
      toast(
        data.message || (d.status === 'connected' ? `${d.name} terhubung` : `Gagal terhubung ke ${d.name}`),
        d.status === 'connected' ? 'success' : 'danger'
      );
    }
  } catch (e) {
    const d = devices.find(x => x.id === id);
    if (d) d.status = 'failed';
    toast('Tidak bisa menghubungi server.', 'danger');
  }

  syncingIds.delete(id);
  renderDevices();
}

async function syncOnu(id) {
  const btn = document.getElementById(`sync-onu-btn-${id}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">sensors</span> Memproses…'; }
  try {
    const res  = await fetch(`${API_BASE}/olt/${id}/sync-onu`, { method: 'POST', credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    toast(data.message || (res.ok ? 'Sync ONU dimulai' : 'Gagal'), res.ok ? 'success' : 'danger');
  } catch (e) {
    toast('Tidak bisa menghubungi server.', 'danger');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">sensors</span> Sync ONU'; }
}

async function syncAll(silent) {
  const icon    = document.getElementById('sync-all-icon');
  const pending = devices.filter(d => !syncingIds.has(d.id));

  if (!pending.length) {
    if (!silent) toast('Semua perangkat sedang disinkron.', 'info');
    return;
  }

  if (icon) icon.classList.add('spin');
  pending.forEach(d => syncingIds.add(d.id));
  renderDevices();

  await Promise.all(pending.map(async d => {
    const statusSebelum = d.status;
    try {
      const res  = await fetch(`${API_BASE}/olt/${d.id}/sync`, { method: 'POST', credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      d.status   = data.connected ? 'connected' : 'failed';
    } catch (e) { d.status = 'failed'; }
    syncingIds.delete(d.id);
    // Beri tahu kalau perangkat baru saja terputus (beda dari status sebelumnya)
    if (silent && statusSebelum === 'connected' && d.status === 'failed') {
      toast(`Perangkat OLT "${d.name}" terputus — tidak bisa dihubungi saat ini.`, 'danger');
    }
  }));

  if (icon) icon.classList.remove('spin');
  renderDevices();
  if (!silent) toast('Sinkronisasi semua perangkat OLT selesai.', 'success');
}


// ── FETCH ONU SIGNAL PER OLT ───────────────────────────────────

async function fetchOnuSignal(d) {
  // Ambil router_id dari uplink pertama
  const routerId = d.uplinks && d.uplinks.length ? d.uplinks[0].router_id : (d.router_id || null);
  if (!routerId) return;

  try {
    const res  = await fetch(`${API_BASE}/api/pelanggan/${routerId}/rx-tx`,
      { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;

    // Filter hanya ONU yang berasal dari OLT ini
    const forThisOlt = data.filter(item => item.olt_id === d.id || String(item.olt_id) === String(d.id));
    const list = forThisOlt.filter(item => item.rx_power !== null && item.rx_power !== undefined);

    const crit = list.filter(item => rxSignalLevel(item.rx_power) === 'crit').length;
    const warn = list.filter(item => rxSignalLevel(item.rx_power) === 'warn').length;

    onuSignalCache[d.id] = { crit, warn, total: list.length, list };

    // Perbarui badge pada card tanpa render ulang seluruh daftar
    _updateSignalBadge(d.id);
  } catch (e) { /* senyap */ }
}

function _updateSignalBadge(oltId) {
  const sig  = onuSignalCache[oltId];
  const wrap = document.getElementById(`onu-signal-${oltId}`);
  if (!wrap || !sig) return;

  if (sig.crit === 0 && sig.warn === 0) {
    wrap.innerHTML = sig.total > 0
      ? `<span class="onu-sig-badge onu-sig-ok"><span class="material-symbols-outlined">check_circle</span>Semua sinyal baik (${sig.total} ONU)</span>`
      : '';
    return;
  }

  const parts = [];
  if (sig.crit > 0) parts.push(`<span class="onu-sig-badge onu-sig-crit"><span class="material-symbols-outlined">warning</span>${sig.crit} ONU sinyal kritis</span>`);
  if (sig.warn > 0) parts.push(`<span class="onu-sig-badge onu-sig-warn"><span class="material-symbols-outlined">signal_cellular_alt</span>${sig.warn} ONU sinyal lemah</span>`);
  wrap.innerHTML = parts.join('');
}


// ── RENDER ─────────────────────────────────────────────────────

function renderDevices() {
  const container = _listEl();
  if (!container) return;   // Defensive: jangan crash kalau elemen tidak ada
  const canManage = (typeof hasPerm === 'function') ? hasPerm('perangkat_manage') : true;

  if (!devices.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined" style="font-size:40px;color:var(--text-dim);">settings_input_antenna</span>
        <p style="font-weight:600;color:var(--text);">Belum ada perangkat OLT terdaftar</p>
        <p style="font-size:12px;color:var(--text-muted);">Klik <strong>Tambah OLT</strong> untuk memulai.</p>
      </div>`;
    updateStats();
    return;
  }

  container.innerHTML = devices.map((d, idx) => {
    const si         = statusInfo(d.status);
    const isSyncing  = syncingIds.has(d.id);
    const badgeCls   = isSyncing ? 'syncing' : d.status;
    const badgeLabel = isSyncing ? 'Menyinkron...' : si.label;
    const statusCls  = d.status === 'connected' ? 'status-connected'
                     : d.status === 'failed'    ? 'status-failed'
                     : 'status-pending';

    return `
      <div class="device-card ${statusCls}" id="card-${d.id}" style="animation-delay:${idx * 40}ms">

        <div class="device-icon">
          <span class="material-symbols-outlined">settings_input_antenna</span>
        </div>

        <div class="device-info">
          <div class="device-top">
            <span class="device-name">${escHtml(d.name)}</span>
            ${d.tipe ? `<span class="device-tipe-badge">${escHtml(d.tipe)}</span>` : ''}
            <span class="badge ${escHtml(badgeCls)}" id="badge-${d.id}">
              <span class="badge-dot ${isSyncing ? 'spin' : ''}"></span>
              ${escHtml(badgeLabel)}
            </span>
          </div>
          <div class="device-meta">
            <span class="device-meta-item">
              <span class="material-symbols-outlined">lan</span>
              ${escHtml(d.ip)}:${escHtml(String(d.port || 23))}
            </span>
            <span class="device-meta-item">
              <span class="material-symbols-outlined">person</span>
              ${escHtml(d.username)}
            </span>
            ${d.snmp ? `<span class="device-meta-item"><span class="material-symbols-outlined">vpn_key</span>${escHtml(d.snmp)}</span>` : ''}
            ${d.lokasi ? `<span class="device-meta-item"><span class="material-symbols-outlined">location_on</span>${escHtml(d.lokasi)}</span>` : ''}
          </div>
          ${d.keterangan ? `<p class="device-keterangan">${escHtml(d.keterangan)}</p>` : ''}
          ${d.koordinat ? `
          <div class="device-profile-row" style="margin-top:6px">
            <a href="https://www.google.com/maps?q=${encodeURIComponent(d.koordinat)}"
               target="_blank" class="koordinat-badge">
              <span class="material-symbols-outlined">location_on</span>
              ${escHtml(d.koordinat)}
            </a>
          </div>` : ''}
          <div class="onu-signal-row" id="onu-signal-${d.id}">
            <span class="onu-sig-loading"><span class="material-symbols-outlined" style="font-size:13px;animation:spin 1s linear infinite">refresh</span> Memeriksa sinyal ONU...</span>
          </div>
        </div>

        <div class="device-actions">
          <button class="btn btn-blue btn-sm" id="sync-btn-${d.id}"
                  onclick="syncDevice(${d.id})" ${isSyncing ? 'disabled' : ''}>
            <span class="material-symbols-outlined ${isSyncing ? 'spin' : ''}">refresh</span>
            Sinkron
          </button>
          <button class="btn btn-green btn-sm" id="sync-onu-btn-${d.id}"
                  onclick="syncOnu(${d.id})" title="Ambil data ONU (SN, VLAN, redaman) dari OLT">
            <span class="material-symbols-outlined">sensors</span>
            Sync ONU
          </button>
          ${canManage ? `
          <button class="btn btn-amber btn-sm" onclick="editDevice(${d.id})">
            <span class="material-symbols-outlined">edit</span> Edit
          </button>
          <button class="btn btn-red btn-sm" onclick="confirmDelete(${d.id})" title="Hapus">
            <span class="material-symbols-outlined">delete</span>
          </button>` : ''}
        </div>

      </div>`;
  }).join('');

  updateStats();

  // Setelah render, ambil data sinyal ONU per OLT (async, non-blocking)
  devices.forEach(d => fetchOnuSignal(d));
}


// ── FORM MODAL ─────────────────────────────────────────────────

function showForm(prefill = null) {
  editingId    = prefill ? prefill.id : null;
  const isEdit = !!prefill;
  const v      = k => prefill ? escHtml(String(prefill[k] || '')) : '';
  const _curOnuType   = prefill ? String(prefill.onu_type_keyword || '') : '';
  const _isCustomOnuType = _curOnuType !== '' && _curOnuType !== 'ALL' && _curOnuType !== 'ALL-ONT';

  initUplinkRows(prefill);

  const html = `
    <div class="form-modal" style="width:560px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;
             background:var(--primary-light);color:var(--primary);
             display:flex;align-items:center;justify-content:center;">
          <span class="material-symbols-outlined" style="font-size:20px;">${isEdit ? 'edit' : 'add_circle'}</span>
        </div>
        <div style="flex:1;">
          <div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text);">
            ${isEdit ? 'Edit Perangkat OLT' : 'Tambah Perangkat OLT'}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
            ${isEdit ? 'Perbarui data OLT yang terdaftar' : 'Daftarkan Optical Line Terminal baru'}
          </div>
        </div>
        <button class="psheet-close" onclick="cancelForm()" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="form-grid">

        <div class="form-group full">
          <label class="form-label">Nama OLT <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-name"
                 placeholder="cth: OLT-Pusat-01" value="${v('name')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Tipe / Merk OLT <span class="req">*</span></label>
          <select class="form-input" id="f-tipe">
            <option value="">Pilih Tipe OLT</option>
            <optgroup label="GPON">
              <option value="zte"    ${v('tipe')==='zte'    ?'selected':''}>ZTE GPON (C300 / C600 / C650)</option>
              <option value="huawei" ${v('tipe')==='huawei' ?'selected':''}>Huawei GPON (MA5800 / MA5600)</option>
              <option value="vsol"   ${v('tipe')==='vsol'   ?'selected':''}>V-Sol GPON (V1600D / V1600G)</option>
            </optgroup>
            <optgroup label="EPON">
              <option value="epon"   ${v('tipe')==='epon'   ?'selected':''}>HSGQ EPON (E04ID / E08ID)</option>
              <option value="hsgq"   ${v('tipe')==='hsgq'   ?'selected':''}>HSGQ EPON (spesifik)</option>
            </optgroup>
            <optgroup label="Lainnya">
              <option value="generic" ${v('tipe')==='generic'?'selected':''}>Generic / Tidak dikenal</option>
            </optgroup>
          </select>
          <span class="form-hint">
            GPON: pakai SN (serial number 16 karakter) ·
            EPON: pakai MAC address sebagai SN
          </span>
        </div>

        <div class="form-group full">
          <label class="form-label">Keyword tipe ONU di perintah registrasi</label>
          <select class="form-input" id="f-onu-type-keyword">
            <option value="ALL"     ${!_isCustomOnuType ? (v('onu_type_keyword')!=='ALL-ONT' ?'selected':'') : ''}>ALL (mis. "onu 1 type ALL sn ...") — Default</option>
            <option value="ALL-ONT" ${!_isCustomOnuType ? (v('onu_type_keyword')==='ALL-ONT'?'selected':'') : ''}>ALL-ONT (mis. "onu 1 type ALL-ONT sn ...")</option>
            <option value="custom"  ${_isCustomOnuType ? 'selected' : ''}>Lainnya (custom)…</option>
          </select>
          <input class="form-input" type="text" id="f-onu-type-keyword-custom"
                 placeholder="mis. ONT, GPON-ONU, dst" maxlength="32"
                 style="margin-top:8px;${_isCustomOnuType ? '' : 'display:none'}"
                 value="${_isCustomOnuType ? escHtml(v('onu_type_keyword')) : ''}">
          <span class="form-hint">Ganti kalau OLT menolak perintah registrasi (cek output CLI saat gagal).</span>
        </div>

        <div class="form-group full" id="epon-ports-wrap" style="display:none">
          <label class="form-label">Jumlah PON Port EPON</label>
          <input class="form-input" type="number" id="f-epon-ports"
                 placeholder="4" min="1" max="16"
                 value="${v('epon_ports') || 4}">
          <span class="form-hint">Jumlah port fisik EPON di OLT (umumnya 4 atau 8)</span>
        </div>

        <div class="form-group full">
          <label class="form-label">
            <span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle;color:var(--primary)">cable</span>
            Router / MikroTik (Uplink)
          </label>
          <div id="f-uplinks-list"></div>
          <button type="button" class="btn btn-sm" onclick="addUplinkRow()" style="margin-top:2px">
            <span class="material-symbols-outlined">add</span> Tambah Jalur Uplink
          </button>
        </div>

        <div class="form-group full">
          <label class="form-label">IP Address &amp; Port <span class="req">*</span></label>
          <div class="ip-port-row">
            <input class="form-input" type="text" id="f-ip"
                   placeholder="192.168.1.100" value="${v('ip')}">
            <input class="form-input port" type="number" id="f-port"
                   placeholder="23" min="1" max="65535"
                   value="${prefill ? escHtml(String(prefill.port || 23)) : '23'}">
          </div>
          <span class="form-hint">Port default: 23 (Telnet) · 22 (SSH) · 161 (SNMP)</span>
        </div>

        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" type="text" id="f-user"
                 placeholder="admin" value="${v('username')}">
        </div>

        <div class="form-group">
          <label class="form-label">Password ${isEdit ? '' : '<span class="req">*</span>'}</label>
          <div class="form-pwd-wrap">
            <input class="form-input" type="password" id="f-pass"
                   placeholder="${isEdit ? 'Kosongkan jika tidak diubah' : '••••••••'}"
                   autocomplete="new-password">
            <button type="button" class="form-pwd-toggle" onclick="togglePwd('f-pass','pwd-eye')">
              <span class="material-symbols-outlined" id="pwd-eye">visibility</span>
            </button>
          </div>
        </div>

        <div class="form-group full">
          <label class="form-label">Lokasi (alamat singkat, opsional)</label>
          <input class="form-input" type="text" id="f-lokasi"
                 placeholder="mis. Tiang ODP Jl. Merdeka No. 10"
                 value="${v('lokasi')}">
        </div>

        <div class="form-group full">
          <label class="form-label">Titik Koordinat OLT</label>
          <div class="koordinat-row">
            <input class="form-input" type="text" id="f-koordinat"
                   placeholder="-6.200000, 106.816666"
                   value="${prefill ? escHtml(prefill.koordinat || '') : ''}"
                   oninput="previewKoordinat()">
            <button type="button" class="koordinat-btn" onclick="deteksiLokasi()">
              <span class="material-symbols-outlined">my_location</span>
              Deteksi
            </button>
          </div>
          <div class="koordinat-preview" id="koordinat-preview">
            <iframe id="koordinat-iframe" src="" loading="lazy"></iframe>
          </div>
        </div>

        <div class="form-group full">
          <label class="form-label">Catatan Konfigurasi ONU (opsional)</label>
          <textarea class="form-input" id="f-keterangan" rows="3"
                    placeholder="mis. ONU C-DATA/FHTT tanpa OMCI: login 192.168.1.1, set mode bridge + VLAN manual di LAN port">${v('keterangan')}</textarea>
          <span class="form-hint">Tampil di modal "CLI Preview" saat tambah/edit pelanggan.</span>
        </div>

      </div>

      <div class="form-actions">
        <button class="btn" onclick="cancelForm()">
          <span class="material-symbols-outlined">close</span> Batal
        </button>
        <button class="btn-primary" id="btn-submit-form"
                onclick="${isEdit ? 'saveEdit()' : 'addDevice()'}">
          <span class="material-symbols-outlined">${isEdit ? 'check' : 'add'}</span>
          ${isEdit ? 'Simpan Perubahan' : 'Tambah OLT'}
        </button>
      </div>
    </div>`;

  openModalForm(html);

  requestAnimationFrame(function() {
    const el = document.getElementById('f-name');
    if (el) el.focus();

    // Show/hide EPON ports field based on tipe selection
    const tipeEl = document.getElementById('f-tipe');
    const eponWrap = document.getElementById('epon-ports-wrap');
    function toggleEponPorts() {
      const isEpon = tipeEl && (tipeEl.value === 'epon' || tipeEl.value === 'hsgq');
      if (eponWrap) eponWrap.style.display = isEpon ? '' : 'none';
    }
    if (tipeEl) {
      tipeEl.addEventListener('change', toggleEponPorts);
      toggleEponPorts();
    }

    // Show/hide kolom custom keyword tipe ONU
    const onuTypeEl       = document.getElementById('f-onu-type-keyword');
    const onuTypeCustomEl = document.getElementById('f-onu-type-keyword-custom');
    function toggleOnuTypeCustom() {
      const isCustom = onuTypeEl && onuTypeEl.value === 'custom';
      if (onuTypeCustomEl) onuTypeCustomEl.style.display = isCustom ? '' : 'none';
    }
    if (onuTypeEl) {
      onuTypeEl.addEventListener('change', toggleOnuTypeCustom);
      toggleOnuTypeCustom();
    }

    // Render daftar uplink (1 OLT bisa terhubung ke beberapa router)
    renderUplinkRows();
  });
}

function cancelForm() {
  editingId = null;
  closeModalForm();
}

function editDevice(id) {
  const d = devices.find(x => x.id === id);
  if (d) showForm(d);
}


// ── DELETE MODAL ───────────────────────────────────────────────

function confirmDelete(id) {
  const d = devices.find(x => x.id === id);
  if (!d) return;

  const html = `
    <div class="modal">
      <div class="hapus-icon-wrap">
        <span class="material-symbols-outlined hapus-icon">delete</span>
      </div>
      <div class="hapus-title">Hapus Perangkat OLT?</div>
      <div class="hapus-sub">
        Yakin ingin menghapus <strong>${escHtml(d.name)}</strong>?<br>
        Semua konfigurasi dan data ONU yang terpetakan akan dihapus permanen.
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-red" onclick="doDelete(${id})">
          <span class="material-symbols-outlined">delete</span> Ya, Hapus
        </button>
      </div>
    </div>`;

  openModalForm(html);
}


// ── INIT ───────────────────────────────────────────────────────

// ── KOORDINAT HELPERS ─────────────────────────────────────────
function deteksiLokasi() { geoDetectKoordinat(); }  /* pakai fungsi bersama di global.js */

function previewKoordinat() {
  const raw     = (document.getElementById('f-koordinat')?.value || '').trim();
  const preview = document.getElementById('koordinat-preview');
  const iframe  = document.getElementById('koordinat-iframe');
  if (!preview || !iframe) return;
  const parts = raw.split(',').map(s => s.trim());
  if (parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
    iframe.src = `https://maps.google.com/maps?q=${parseFloat(parts[0])},${parseFloat(parts[1])}&z=15&output=embed`;
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
    iframe.src = '';
  }
}


// ── DAFTAR UPLINK DINAMIS (1 OLT bisa terhubung ke beberapa router) ──

let uplinkRows = [];   // [{idx, router_id, router_interface, uplink_port, keterangan}]
let uplinkRowSeq = 0;

function _emptyUplinkRow() {
  return { idx: uplinkRowSeq++, router_id: '', router_interface: '', uplink_port: '', keterangan: '' };
}

/* Inisialisasi state dari prefill (edit) — dukung format baru `uplinks[]`
   maupun format lama (field tunggal router_id/router_interface/olt_uplink_port) */
function initUplinkRows(prefill) {
  uplinkRowSeq = 0;
  if (prefill && Array.isArray(prefill.uplinks) && prefill.uplinks.length) {
    uplinkRows = prefill.uplinks.map(u => ({
      idx: uplinkRowSeq++,
      router_id:        u.router_id ?? '',
      router_interface: u.router_interface || '',
      uplink_port:      u.uplink_port || '',
      keterangan:       u.keterangan || '',
    }));
  } else if (prefill && prefill.router_id) {
    uplinkRows = [{
      idx: uplinkRowSeq++,
      router_id:        prefill.router_id,
      router_interface: prefill.router_interface || '',
      uplink_port:      prefill.olt_uplink_port || '',
      keterangan:       '',
    }];
  } else {
    uplinkRows = [_emptyUplinkRow()];
  }
}

/* Baca nilai terkini tiap baris dari DOM ke state (sebelum render ulang) */
function syncUplinkRowsFromDOM() {
  uplinkRows = uplinkRows.map(row => {
    const routerSel = document.getElementById(`f-uplink-router-${row.idx}`);
    if (!routerSel) return row;   // baris belum ter-render
    return {
      idx:              row.idx,
      router_id:        routerSel.value || '',
      router_interface: getUplinkIface(row.idx),
      uplink_port:      (document.getElementById(`f-uplink-port-${row.idx}`)?.value || '').trim(),
      keterangan:       (document.getElementById(`f-uplink-ket-${row.idx}`)?.value || '').trim(),
    };
  });
}

function addUplinkRow() {
  syncUplinkRowsFromDOM();
  uplinkRows.push(_emptyUplinkRow());
  renderUplinkRows();
}

function removeUplinkRow(idx) {
  syncUplinkRowsFromDOM();
  uplinkRows = uplinkRows.filter(r => r.idx !== idx);
  if (uplinkRows.length === 0) uplinkRows.push(_emptyUplinkRow());
  renderUplinkRows();
}

function renderUplinkRows() {
  const wrap = document.getElementById('f-uplinks-list');
  if (!wrap) return;

  wrap.innerHTML = uplinkRows.map((u, i) => `
    <div style="border:1px solid var(--border);border-radius:var(--r-md);padding:10px;margin-bottom:8px;position:relative;">
      ${uplinkRows.length > 1 ? `
      <button type="button" onclick="removeUplinkRow(${u.idx})" title="Hapus jalur ini"
              style="position:absolute;top:8px;right:8px;background:none;border:none;color:var(--red);cursor:pointer;display:flex;padding:2px">
        <span class="material-symbols-outlined" style="font-size:18px">close</span>
      </button>` : ''}
      <div style="font-size:11px;font-weight:700;color:var(--text-dim);margin-bottom:6px;">
        Jalur Uplink ${i + 1}${i === 0 ? ' (utama)' : ''}
      </div>
      <select class="form-input" id="f-uplink-router-${u.idx}" onchange="onUplinkRouterChange(${u.idx}, this.value)">
        <option value="">Tidak terhubung</option>
        ${routers.map(r => `<option value="${r.id}" ${String(u.router_id) === String(r.id) ? 'selected' : ''}>${escHtml(r.name)} (${r.ip})</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;margin-top:6px">
        <div style="flex:1;position:relative">
          <div class="g-select-wrap" id="f-uplink-iface-sel-wrap-${u.idx}" style="display:none;width:100%">
            <select class="g-select" id="f-uplink-iface-sel-${u.idx}" style="width:100%">
              <option value="">Pilih interface</option>
            </select>
            <span class="material-symbols-outlined g-select-icon">expand_more</span>
          </div>
          <input class="form-input" type="text" id="f-uplink-iface-${u.idx}"
                 placeholder="ether5 (port MikroTik ke OLT)"
                 value="${escHtml(u.router_interface || '')}" data-prev-val="${escHtml(u.router_interface || '')}">
          <span id="f-uplink-iface-loading-${u.idx}" style="display:none;position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text-dim)">Memuat...</span>
        </div>
        <input class="form-input" type="text" id="f-uplink-port-${u.idx}"
               placeholder="GE01 (port OLT ke router)"
               value="${escHtml(u.uplink_port || '')}" style="flex:1">
      </div>
      <input class="form-input" type="text" id="f-uplink-ket-${u.idx}"
             placeholder="Keterangan (opsional, mis: jalur cadangan / VLAN 215)"
             value="${escHtml(u.keterangan || '')}" style="margin-top:6px">
    </div>`).join('');

  /* Auto-load dropdown interface utk baris yang sudah punya router (edit mode) */
  uplinkRows.forEach(u => {
    if (u.router_id) onUplinkRouterChange(u.idx, u.router_id);
  });
}

async function onUplinkRouterChange(idx, routerId) {
  const wrap    = document.getElementById(`f-uplink-iface-sel-wrap-${idx}`);
  const sel     = document.getElementById(`f-uplink-iface-sel-${idx}`);
  const txt     = document.getElementById(`f-uplink-iface-${idx}`);
  const loading = document.getElementById(`f-uplink-iface-loading-${idx}`);
  if (!wrap || !sel || !txt) return;

  if (!routerId) {
    /* Tidak ada router — kembali ke text input */
    wrap.style.display = 'none';
    txt.style.display = '';
    txt.value = '';
    return;
  }

  loading.style.display = '';
  txt.style.display = 'none';
  wrap.style.display = 'none';

  try {
    const res  = await fetch(`${API_BASE}/api/mikrotik/${routerId}/interfaces`,
      { credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    const ifaces = Array.isArray(data) ? data : (data.interfaces || []);

    sel.innerHTML = '<option value="">Pilih interface</option>' +
      ifaces.map(i => `<option value="${escHtml(i.name)}">${escHtml(i.name)}${i.comment ? ' — ' + escHtml(i.comment) : ''}</option>`).join('');

    /* Pertahankan nilai lama (edit mode) */
    const prev = txt.getAttribute('data-prev-val') || txt.value;
    if (prev) sel.value = prev;

    wrap.style.display = '';
    loading.style.display = 'none';
  } catch(e) {
    /* Gagal fetch → fallback ke text input */
    txt.style.display = '';
    loading.style.display = 'none';
  }
}

/* Ambil nilai interface baris ke-idx — dari select jika aktif, fallback ke text */
function getUplinkIface(idx) {
  const wrap = document.getElementById(`f-uplink-iface-sel-wrap-${idx}`);
  const sel  = document.getElementById(`f-uplink-iface-sel-${idx}`);
  if (wrap && sel && wrap.style.display !== 'none') return sel.value;
  return (document.getElementById(`f-uplink-iface-${idx}`)?.value || '').trim();
}

/* Kumpulkan semua baris uplink yg punya router terpilih (siap dikirim ke API) */
function collectUplinks() {
  syncUplinkRowsFromDOM();
  return uplinkRows
    .filter(u => u.router_id)
    .map(u => ({
      router_id:        Number(u.router_id),
      router_interface: u.router_interface || '',
      uplink_port:      u.uplink_port || '',
      keterangan:       u.keterangan || '',
    }));
}


// ── INIT ─────────────────────────────────────────────────────
// Pastikan DOM siap sebelum loadDevices() — jika script di-load di <head>
// atau ada race condition, ini mencegah crash "Cannot set null"
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadDevices);
} else {
  loadDevices();
}