/* ============================================================
   dashboard.js — TechnoFix · Dashboard  v4.1
   ─────────────────────────────────────────────────────────
   ⚠  global.js WAJIB dimuat sebelum file ini.

   Endpoint yang digunakan (semua ada di api.py v4.1):
     GET /devices                              → daftar MikroTik
     GET /api/pelanggan/<device_id>            → pelanggan + status aktif/nonaktif
     GET /api/profile/<device_id>              → profil PPPoE dari MikroTik
     GET /api/keuangan/ringkasan               → pendapatan (owner/keuangan only)
     GET /api/mikrotik/<id>/interfaces         → daftar interface BW
     GET /api/mikrotik/<id>/bandwidth?iface=X  → data BW realtime
     GET /api/mikrotik/<id>/log               → log MikroTik
     GET /api/log/aktivitas?device_id=<id>    → log billing
   ============================================================ */

'use strict';

/* ── Constants ── */
var BASE = (typeof API_BASE !== 'undefined') ? API_BASE : '';

/* ── State modul ── */
var _deviceId   = null;
var _deviceName = '';
var _allPel     = [];
var _bwTimer    = null;
var _chartBW    = null;
var _chartTrend = null;
var _bwLabels   = [];
var _bwRx       = [];
var _bwTx       = [];
var _iface      = '';
var _arTimer    = null;
var BW_WIN      = 40;

/* ── Bandwidth Sparklines ── */
var _spkRx = null;
var _spkTx = null;


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  if (!localStorage.getItem('tf_token')) {
    window.location.href = '/app/frontend/auth/auth.html';
    return;
  }

  if (typeof initDateBadge      === 'function') initDateBadge();
  if (typeof initBottomNav      === 'function') initBottomNav();
  if (typeof initHeaderCanvas   === 'function') initHeaderCanvas();
  if (typeof initDropdownHeader === 'function') initDropdownHeader();

  // Kolektor → tampilkan dashboard khusus, sembunyikan dashboard biasa
  var _role = localStorage.getItem('tf_role') || '';
  if (_role === 'kolektor') {
    var mainDash = document.getElementById('dashboard-main');
    var kolDash  = document.getElementById('dashboard-kolektor');
    if (mainDash) mainDash.style.display = 'none';
    if (kolDash)  kolDash.style.display  = '';
    _initTodayDate();
    _initKolektorDashboard();
    return;
  }

  _initTodayDate();
  initChartBW();
  initChartTrend();
  initSparklines();
  _loadSettingDash();
  loadDevices();
});

function _initTodayDate() {
  var el = document.getElementById('today-date');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}


/* ══════════════════════════════════════════════════════════
   REFRESH ALL
══════════════════════════════════════════════════════════ */
function refreshAll() {
  _spinRefresh(true);
  if (_deviceId) {
    _loadStats(_deviceId);
    _loadProfil(_deviceId);
    _loadKeuangan();
    _loadInterfaces(_deviceId);
    loadActivityLog();
    loadResource();
    loadTicker();
  } else {
    loadDevices();
  }
  setTimeout(function () { _spinRefresh(false); }, 900);
}

function _spinRefresh(on) {
  var icon = document.getElementById('refresh-icon');
  if (!icon) return;
  icon.style.animation = on ? 'spin .7s linear infinite' : '';
}


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR PERANGKAT
   GET /devices
══════════════════════════════════════════════════════════ */
async function loadDevices() {
  var sel = document.getElementById('select-device');
  if (!sel) return;

  try {
    var res  = await fetch(BASE + '/devices', { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    var list = Array.isArray(data) ? data : (data.data || []);

    sel.innerHTML = '<option value="">— Pilih Perangkat —</option>';
    list.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value       = d.id;
      opt.textContent = d.name + '  (' + d.ip + ')';
      opt.dataset.status = d.status || '';
      sel.appendChild(opt);
    });

    /* Restore pilihan terakhir */
    var saved = localStorage.getItem('lastSelectedDevice');
    if (saved && list.some(function (d) { return String(d.id) === String(saved); })) {
      sel.value   = saved;
      _deviceId   = saved;
      _deviceName = sel.options[sel.selectedIndex].text.split('  (')[0].trim();
    } else if (list.length === 1) {
      sel.value   = String(list[0].id);
      _deviceId   = sel.value;
      _deviceName = list[0].name;
    }

    _setStatus('', 'Pilih perangkat...');

    if (_deviceId) {
      _afterDeviceSelect();
    }

  } catch (err) {
    console.error('[dash] loadDevices:', err);
    _setStatus('offline', 'Gagal memuat daftar perangkat');
    if (sel) sel.innerHTML = '<option value="">— Gagal memuat —</option>';
    _showToast('Gagal memuat daftar perangkat MikroTik', 'error');
  }
}


/* ══════════════════════════════════════════════════════════
   2. GANTI DEVICE — onchange select
══════════════════════════════════════════════════════════ */
function onDeviceChange() {
  var sel = document.getElementById('select-device');
  if (!sel) return;
  var id = sel.value;

  _stopBW();

  if (!id) {
    _deviceId = null; _deviceName = '';
    localStorage.removeItem('lastSelectedDevice');
    _resetDash();
    return;
  }

  _deviceId   = id;
  _deviceName = sel.options[sel.selectedIndex].text.split('  (')[0].trim();
  localStorage.setItem('lastSelectedDevice', id);
  _afterDeviceSelect();
}

function _afterDeviceSelect() {
  _loadStats(_deviceId);
  _loadProfil(_deviceId);
  _loadKeuangan();
  _loadInterfaces(_deviceId);
  loadActivityLog();
  loadResource();
  loadTicker();
}


/* ══════════════════════════════════════════════════════════
   3. STATISTIK PELANGGAN
   GET /api/pelanggan/<device_id>
══════════════════════════════════════════════════════════ */
/* ── polling handle sync ── */
var _syncPollTimer = null;

function _stopSyncPoll() {
  if (_syncPollTimer) { clearInterval(_syncPollTimer); _syncPollTimer = null; }
}

async function _loadStats(id) {
  _setStatus('pending', 'Memuat...');
  _setSyncBadge('syncing', 'Memuat...');

  /* 1. Tampilkan data DB lokal SEKARANG (instan) */
  try {
    var res = await fetch(BASE + '/api/stats/' + id, { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    if (d.error) throw new Error(d.error);

    /* Angka lokal: total akurat, online/offline = aktif/nonaktif (bukan realtime) */
    _updateStatCards(d.total || 0, d.online || 0, d.offline || 0, true);
    _setStatus('online', 'Terhubung');
    _setSyncBadge('syncing', 'Menyinkron...');

  } catch (err) {
    console.error('[dash] _loadStats (lokal):', err);
    _setStatus('offline', 'Gagal');
    _setSyncBadge('error', 'Gagal');
    ['stat-total','stat-online','stat-offline'].forEach(function(i){ _setText(i,'—'); });
  }

  /* 2. Minta sinkron MikroTik di background */
  try {
    await fetch(BASE + '/api/sync/' + id, {
      method: 'POST', credentials: 'include', headers: _authH()
    });
  } catch (_) { /* senyap */ }

  /* 3. Polling sampai sinkron selesai, lalu refresh angka realtime */
  _stopSyncPoll();
  var _pollCount = 0;
  _syncPollTimer = setInterval(async function() {
    _pollCount++;
    if (_pollCount > 40) { _stopSyncPoll(); _setSyncBadge('ok', 'Tersinkron'); return; }

    try {
      var r2 = await fetch(BASE + '/api/stats/' + id, { credentials: 'include', headers: _authH() });
      if (!r2.ok) return;
      var d2 = await r2.json();
      var sync = d2.sync || {};

      if (sync.status === 'running') {
        _setSyncBadge('syncing', 'Menyinkron...');
        return;
      }

      if (sync.status === 'done' || sync.status === 'error') {
        _stopSyncPoll();

        if (sync.status === 'done') {
          /* Fetch /api/pelanggan — sama persis seperti pelanggan.js */
          _setSyncBadge('syncing', 'Memperbarui...');
          var r3 = await fetch(BASE + '/api/pelanggan/' + id, { credentials: 'include', headers: _authH() });
          if (r3.ok) {
            var data = await r3.json();
            _allPel = Array.isArray(data) ? data : (data.data || []);
            var total  = _allPel.length;
            /* Hitung online SAMA seperti pelanggan.js: p.status === 'Online' */
            var online = _allPel.filter(_isOnline).length;
            var off    = total - online;
            _updateStatCards(total, online, off, false);
            _renderOffline(_allPel.filter(function(p){ return !_isOnline(p); }));
            _buildTrend(online, off, total);
            _setSyncBadge('ok', 'Tersinkron');
          }
        } else {
          /* Sync error — tetap tampil data lokal, tapi tandai */
          _setSyncBadge('error', sync.msg || 'Sinkron gagal');
        }
      }
    } catch(_) { /* senyap */ }

  }, 2000);
}

function _updateStatCards(total, online, off, isEstimate) {
  var pctOn  = total ? Math.round(online / total * 100) : 0;
  var pctOff = total ? Math.round(off    / total * 100) : 0;
  if (typeof animNum === 'function') {
    animNum('stat-total',   total);
    animNum('stat-online',  online);
    animNum('stat-offline', off);
  } else {
    _setText('stat-total',   total);
    _setText('stat-online',  online);
    _setText('stat-offline', off);
  }
  _setText('stat-total-sub',   _deviceName || 'MikroTik');
  /* Saat estimasi, beri tanda ~ agar user tahu belum realtime */
  _setText('stat-online-pct',  (isEstimate ? '~' : '') + pctOn  + '% dari total');
  _setText('stat-offline-pct', (isEstimate ? '~' : '') + pctOff + '% dari total');
}


/* ══════════════════════════════════════════════════════════
   4. PROFIL PPPoE
   GET /api/profile/<device_id>
══════════════════════════════════════════════════════════ */
async function _loadProfil(id) {
  var stateLoading = document.getElementById('profile-state-loading');
  var stateEmpty   = document.getElementById('profile-state-empty');
  var tableWrap    = document.getElementById('profile-table-wrap');
  var tbody        = document.getElementById('tbody-profile');
  var countLabel   = document.getElementById('profile-count-label');

  if (!tbody) return;

  /* Loading */
  if (stateLoading) stateLoading.style.display = '';
  if (stateEmpty)   stateEmpty.style.display   = 'none';
  if (tableWrap)    tableWrap.style.display     = 'none';

  try {
    var res = await fetch(BASE + '/api/profile/' + id, { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var list = await res.json();
    if (!Array.isArray(list)) list = list.profiles || list.data || [];

    if (!list.length) {
      if (stateLoading) stateLoading.style.display = 'none';
      if (stateEmpty)   stateEmpty.style.display   = '';
      if (countLabel)   countLabel.textContent = 'Tidak ada profil untuk perangkat ini';
      return;
    }

    /* Hitung pelanggan per profil dari data yang sudah ada */
    var profilCount = {};
    _allPel.forEach(function (p) {
      var pr = (p.profil || p.profile || '').trim();
      if (pr) profilCount[pr] = (profilCount[pr] || 0) + 1;
    });

    tbody.innerHTML = list.map(function (pr, idx) {
      var nama  = escHtml(pr.name || pr.nama_profile || '');
      /* Rate limit: gunakan rate_limit langsung, atau down/up */
      var rl    = pr.rate_limit || pr['rate-limit'] || '';
      var down  = pr.rate_down  || pr.download || '—';
      var up    = pr.rate_up    || pr.upload   || '—';
      var rateStr = rl
        ? escHtml(rl)
        : escHtml(down) + ' / ' + escHtml(up);

      var harga     = pr.harga;
      var hargaHtml = (harga != null && harga !== '' && harga !== 0)
        ? '<span class="dash-profile-harga">Rp ' + Number(harga).toLocaleString('id-ID') + '</span>'
        : '<span class="dash-profile-harga none">Belum diset</span>';

      var jumlah = profilCount[pr.name || pr.nama_profile] || pr.total_user || 0;

      return '<tr>'
        + '<td style="text-align:center;color:var(--text-dim);font-size:12px">' + (idx + 1) + '</td>'
        + '<td><span class="badge-profil">' + nama + '</span></td>'
        + '<td><span class="dash-profile-rate">' + rateStr + '</span></td>'
        + '<td>' + hargaHtml + '</td>'
        + '<td>'
          + '<span class="dash-profile-pakai">'
            + '<span class="material-symbols-outlined">person</span>'
            + jumlah + ' pelanggan'
          + '</span>'
        + '</td>'
        + '</tr>';
    }).join('');

    if (stateLoading) stateLoading.style.display = 'none';
    if (stateEmpty)   stateEmpty.style.display   = 'none';
    if (tableWrap)    tableWrap.style.display     = '';
    if (countLabel)   countLabel.textContent = list.length + ' profil aktif dari ' + (_deviceName || 'MikroTik');

  } catch (err) {
    console.error('[dash] _loadProfil:', err);
    if (stateLoading) stateLoading.style.display = 'none';
    if (stateEmpty) {
      stateEmpty.style.display = '';
      stateEmpty.innerHTML =
        '<span class="material-symbols-outlined" style="opacity:.25;font-size:36px">manage_accounts</span>'
        + '<p style="font-size:13px;color:var(--text-dim)">Gagal mengambil profil PPPoE dari MikroTik</p>';
    }
    if (countLabel) countLabel.textContent = 'Gagal mengambil profil';
  }
}


/* ══════════════════════════════════════════════════════════
   5. KEUANGAN — owner / permission keuangan only
   GET /api/keuangan/ringkasan
══════════════════════════════════════════════════════════ */
function _loadKeuangan() {
  var role  = localStorage.getItem('tf_role') || '';
  var perms = [];
  try { perms = JSON.parse(localStorage.getItem('tf_permissions') || '[]'); } catch (_) {}
  var hasKeu = (role === 'owner' || perms.includes('keuangan'));

  var card = document.getElementById('card-keuangan');
  if (card) card.style.display = hasKeu ? '' : 'none';
  if (!hasKeu) return;

  fetch(BASE + '/api/keuangan/ringkasan', { credentials: 'include', headers: _authH() })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      var nominal = d.pendapatan_bulan || d.total_pemasukan || 0;
      var jt      = d.jatuh_tempo || 0;
      _setText('stat-pendapatan', 'Rp ' + Number(nominal).toLocaleString('id-ID'));
      _setText('stat-jatuh-tempo', jt + ' tagihan jatuh tempo');
    })
    .catch(function (e) {
      console.warn('[dash] keuangan/ringkasan:', e.message);
      _setText('stat-pendapatan', '—');
    });
}


/* ══════════════════════════════════════════════════════════
   6. INTERFACES
   GET /api/mikrotik/<id>/interfaces
══════════════════════════════════════════════════════════ */
async function _loadInterfaces(id) {
  var sel   = document.getElementById('bw-iface-select');
  var label = document.getElementById('bw-iface-label');
  var bwE   = document.getElementById('bw-empty');

  if (!sel) return;
  sel.innerHTML = '<option value="">— Memuat interface... —</option>';

  try {
    var res = await fetch(BASE + '/api/mikrotik/' + id + '/interfaces', { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (data && data.error) throw new Error(data.error);

    var list = Array.isArray(data) ? data : (data.interfaces || data.data || []);
    if (!list.length) throw new Error('Tidak ada interface');

    sel.innerHTML = '<option value="">— Pilih Interface —</option>';
    list.forEach(function (item) {
      var name = (typeof item === 'string') ? item : (item.name || '');
      if (!name) return;
      var desc = item.comment ? name + ' — ' + item.comment : name;
      /* Tandai interface yang sedang running */
      if (item.running === false) desc += ' (down)';
      var opt = document.createElement('option');
      opt.value       = name;
      opt.textContent = desc;
      sel.appendChild(opt);
    });

    /* Auto-select: tersimpan sebelumnya → ether1/WAN → index 0 */
    var opts   = Array.from(sel.options).map(function (o) { return o.value; }).filter(Boolean);
    var saved  = localStorage.getItem('dash_iface_' + id);
    var wan    = opts.find(function (n) { return /ether1|wan|uplink|sfp1/i.test(n); });
    var target = (saved && opts.includes(saved)) ? saved : (wan || opts[0] || '');

    if (target) {
      sel.value = target;
      _iface    = target;
      if (label) label.textContent = (_deviceName || 'MikroTik') + ' — ' + target;
      _startBW(id, target);
    }

  } catch (err) {
    console.warn('[dash] interfaces:', err.message);
    sel.innerHTML = '<option value="">— Interface tidak tersedia —</option>';
    if (label) label.textContent = 'Gagal mengambil interface dari ' + (_deviceName || 'MikroTik');
    if (bwE) {
      bwE.classList.remove('hidden');
      var p = bwE.querySelector('p');
      if (p) p.textContent = 'Tidak dapat mengambil daftar interface. Pastikan perangkat terhubung.';
    }
  }
}


/* ══════════════════════════════════════════════════════════
   7. GANTI INTERFACE
══════════════════════════════════════════════════════════ */
function onIfaceChange() {
  var sel = document.getElementById('bw-iface-select');
  if (!sel || !_deviceId) return;

  _stopBW();
  _iface = sel.value;

  var bwE = document.getElementById('bw-empty');

  if (!_iface) {
    _resetBWChart();
    if (bwE) bwE.classList.remove('hidden');
    _resetBWDisplay('bw-rx-val');
    _resetBWDisplay('bw-tx-val');
    return;
  }

  localStorage.setItem('dash_iface_' + _deviceId, _iface);
  var label = document.getElementById('bw-iface-label');
  if (label) label.textContent = (_deviceName || 'MikroTik') + ' — ' + _iface;

  if (bwE) bwE.classList.add('hidden');
  _startBW(_deviceId, _iface);
}


/* ══════════════════════════════════════════════════════════
   8. BANDWIDTH POLLING
   GET /api/mikrotik/<id>/bandwidth?iface=<name>
══════════════════════════════════════════════════════════ */
function _startBW(id, iface) {
  _stopBW();
  _fetchBW(id, iface);
  /* Interval 4 detik — backend butuh ~1 detik untuk sample */
  _bwTimer = setInterval(function () { _fetchBW(id, iface); }, 4000);
}

function _stopBW() {
  if (_bwTimer) { clearInterval(_bwTimer); _bwTimer = null; }
}

async function _fetchBW(id, iface) {
  try {
    var res = await fetch(
      BASE + '/api/mikrotik/' + id + '/bandwidth?iface=' + encodeURIComponent(iface),
      { credentials: 'include', headers: _authH() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    if (d.error) throw new Error(d.error);

    var rx = parseFloat(d.rx_mbps ?? d.download_mbps ?? d.rx ?? 0) || 0;
    var tx = parseFloat(d.tx_mbps ?? d.upload_mbps   ?? d.tx ?? 0) || 0;
    var ts = new Date().toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    _bwLabels.push(ts);
    _bwRx.push(rx);
    _bwTx.push(tx);
    if (_bwLabels.length > BW_WIN) {
      _bwLabels.shift(); _bwRx.shift(); _bwTx.shift();
    }

    _setBWDisplay('bw-rx-val', rx);
    _setBWDisplay('bw-tx-val', tx);

    /* Sparkline BW */
    if (_spkRx) { _spkRx.data.labels = _bwLabels.slice(); _spkRx.data.datasets[0].data = _bwRx.slice(); _spkRx.update('none'); }
    if (_spkTx) { _spkTx.data.labels = _bwLabels.slice(); _spkTx.data.datasets[0].data = _bwTx.slice(); _spkTx.update('none'); }

    /* Peak, rata-rata, jumlah titik */
    var rxPeak = _bwRx.length ? Math.max.apply(null, _bwRx) : 0;
    var rxAvg  = _bwRx.length ? _bwRx.reduce(function(a,b){return a+b;},0) / _bwRx.length : 0;
    _setText('bw-peak',  _fmtMbps(rxPeak));
    _setText('bw-avg',   _fmtMbps(rxAvg));
    _setText('bw-count', _bwRx.length);

    /* Trend vs rata-rata */
    _setBWTrend('bw-rx-sub', rx, rxAvg);
    var txAvg = _bwTx.length ? _bwTx.reduce(function(a,b){return a+b;},0) / _bwTx.length : 0;
    _setBWTrend('bw-tx-sub', tx, txAvg);

    var bwE = document.getElementById('bw-empty');
    if (bwE) bwE.classList.add('hidden');
    _showBWUI();

    if (_chartBW) {
      _chartBW.data.labels             = _bwLabels.slice();
      _chartBW.data.datasets[0].data   = _bwRx.slice();
      _chartBW.data.datasets[1].data   = _bwTx.slice();
      _chartBW.update('none');
    }

  } catch (err) {
    /* Diam — jangan spam console setiap 4 detik */
  }
}


/* ══════════════════════════════════════════════════════════
   9. RENDER OFFLINE LIST
══════════════════════════════════════════════════════════ */
function _renderOffline(offList) {
  var box   = document.getElementById('offline-list');
  var label = document.getElementById('offline-count-label');
  if (!box) return;

  if (label) label.textContent = offList.length + ' pelanggan offline';

  if (!offList.length) {
    box.innerHTML = _emptyHtml('ok', 'Semua pelanggan sedang online');
    return;
  }

  var MAX_SHOW = 15;
  var html = offList.slice(0, MAX_SHOW).map(function (p) {
    var uname  = escHtml(p.username || '—');
    var profil = escHtml(p.profil  || p.profile || '');
    var hp     = escHtml(p.hp || '');
    var meta   = [profil, hp].filter(Boolean).join(' · ');
    var href   = '/app/frontend/pelanggan/detail_pelanggan.html?id=' + (p.id || '');

    return '<a class="dash-offline-item" href="' + href + '">'
      + '<div class="dash-offline-icon">'
        + '<span class="material-symbols-outlined">wifi_off</span>'
      + '</div>'
      + '<div class="dash-offline-body">'
        + '<span class="dash-offline-name">' + uname + '</span>'
        + (meta ? '<span class="dash-offline-meta">' + meta + '</span>' : '')
      + '</div>'
      + '<div class="dash-offline-right">'
        + '<span class="dash-offline-badge">Offline</span>'
      + '</div>'
      + '</a>';
  }).join('');

  if (offList.length > MAX_SHOW) {
    html += '<a class="dash-offline-more" href="/app/frontend/pelanggan/pelanggan.html">'
      + '+ ' + (offList.length - MAX_SHOW) + ' lainnya — Lihat semua'
      + '</a>';
  }

  box.innerHTML = html;
}


/* ══════════════════════════════════════════════════════════
   10. TREN CHART — bar per profil (online vs offline)
══════════════════════════════════════════════════════════ */
function _buildTrend(online, off, total) {
  var te = document.getElementById('trend-empty');

  if (!_chartTrend) {
    if (te) te.classList.remove('hidden');
    return;
  }

  if (!total) {
    _chartTrend.data.labels = [];
    _chartTrend.data.datasets.forEach(function (d) { d.data = []; });
    _chartTrend.update();
    if (te) te.classList.remove('hidden');
    return;
  }

  /* Distribusi per profil */
  var profilMap = {};
  _allPel.forEach(function (p) {
    var pr = (p.profil || p.profile || 'Lainnya').trim() || 'Lainnya';
    if (!profilMap[pr]) profilMap[pr] = { on: 0, off: 0 };
    if (_isOnline(p)) profilMap[pr].on++;
    else              profilMap[pr].off++;
  });

  /* Urutkan dari yang paling banyak pelanggan */
  var labels = Object.keys(profilMap)
    .sort(function (a, b) {
      return (profilMap[b].on + profilMap[b].off) - (profilMap[a].on + profilMap[a].off);
    })
    .slice(0, 8);

  var onData  = labels.map(function (k) { return profilMap[k].on;  });
  var offData = labels.map(function (k) { return profilMap[k].off; });

  _chartTrend.data.labels           = labels;
  _chartTrend.data.datasets[0].data = onData;
  _chartTrend.data.datasets[1].data = offData;
  _chartTrend.update();

  if (te) te.classList.add('hidden');
}


/* ══════════════════════════════════════════════════════════
   11. AKTIVITAS TERBARU
   GET /api/mikrotik/<id>/log  +  /api/log/aktivitas
══════════════════════════════════════════════════════════ */
function loadActivityLog() {
  var id  = _deviceId;
  var box = document.getElementById('activity-log');
  var lbl = document.getElementById('log-device-label');
  if (!box) return;

  if (!id) {
    box.innerHTML = _emptyHtml('empty', 'Pilih MikroTik untuk melihat aktivitas');
    return;
  }

  if (lbl) lbl.textContent = 'Aktivitas terbaru — ' + (_deviceName || 'MikroTik');
  box.innerHTML = '<div class="dash-log-item" style="grid-column:1/-1;justify-content:center">'
    + '<span class="material-symbols-outlined" style="animation:spin 1s linear infinite;font-size:16px;color:var(--text-dim)">refresh</span>'
    + '<span class="dash-log-msg">Memuat log...</span>'
    + '</div>';

  Promise.allSettled([
    fetch(BASE + '/api/mikrotik/' + id + '/log?limit=30', { credentials: 'include', headers: _authH() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; }),

    fetch(BASE + '/api/log/aktivitas?device_id=' + id + '&limit=30', { credentials: 'include', headers: _authH() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; }),
  ]).then(function (results) {
    var mtLog  = _normLog(results[0].value || []);
    var bilLog = _normLog(results[1].value || []);

    /* Tag sumber */
    mtLog.forEach(function (e)  { e._src = 'MikroTik'; });
    bilLog.forEach(function (e) { e._src = 'Billing';  });

    var all = mtLog.concat(bilLog);
    all.sort(function (a, b) {
      return String(b.ts || '').localeCompare(String(a.ts || ''));
    });

    if (!all.length) {
      box.innerHTML = _emptyHtml('empty', 'Belum ada aktivitas untuk perangkat ini');
      return;
    }

    box.innerHTML = all.slice(0, 60).map(function (e) {
      var cls  = _logDot(e.topic);
      var msg  = escHtml(e.message || '').replace(/^\[(\w+)\]/, '<strong>[$1]</strong>');
      var src  = e._src
        ? '<span style="font-size:9.5px;font-weight:700;color:var(--text-dim);'
          + 'background:var(--surface);border:1px solid var(--border);'
          + 'padding:1px 5px;border-radius:4px;margin-left:4px">' + escHtml(e._src) + '</span>'
        : '';
      return '<div class="dash-log-item">'
        + '<span class="dash-log-dot ' + cls + '"></span>'
        + '<span class="dash-log-msg">' + msg + src + '</span>'
        + '<span class="dash-log-time">' + escHtml(e.time || '') + '</span>'
        + '</div>';
    }).join('');
  });
}

function _normLog(raw) {
  if (!Array.isArray(raw)) raw = (raw && (raw.data || raw.logs)) ? (raw.data || raw.logs) : [];
  if (!Array.isArray(raw)) return [];
  return raw.map(function (e) {
    return {
      topic:   e.topic   || e.topics    || e.type  || e.aksi     || 'info',
      message: e.message || e.msg       || e.keterangan || e.detail || '',
      time:    e.time    || e.timestamp || e.waktu  || '',
      ts:      e.ts      || e.timestamp || e.waktu  || e.time     || '',
    };
  });
}

function _logDot(t) {
  t = String(t || '').toLowerCase();
  if (/warn|dhcp|isolir|pending/.test(t))               return 'warning';
  if (/err|fail|hapus|drop|remove|block/.test(t))        return 'error';
  if (/ok|sukses|lunas|tambah|add|edit|update/.test(t))  return 'success';
  return 'info';
}


/* ══════════════════════════════════════════════════════════
   CHART — BW Realtime (line)
══════════════════════════════════════════════════════════ */
function initChartBW() {
  var canvas = document.getElementById('chart-bw');
  if (!canvas || typeof Chart === 'undefined') return;

  _chartBW = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Download',
          data: [],
          borderColor: '#378add',
          backgroundColor: 'rgba(55,138,221,.10)',
          borderWidth: 1.8, pointRadius: 0, fill: true, tension: .4,
        },
        {
          label: 'Upload',
          data: [],
          borderColor: '#1d9e75',
          backgroundColor: 'rgba(29,158,117,.08)',
          borderWidth: 1.8, pointRadius: 0, fill: true, tension: .4,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10,20,34,.92)',
          borderColor: 'rgba(255,255,255,.12)',
          borderWidth: 1,
          titleColor: 'rgba(255,255,255,.7)',
          bodyColor: '#fff',
          callbacks: {
            label: function (c) {
              return ' ' + c.dataset.label + ': ' + _fmtMbps(c.parsed.y);
            }
          }
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 6,
            font: { size: 10, family: 'Poppins,sans-serif' },
            color: '#6a82a8',
          },
          grid: { color: '#e4e8f0' },
          border: { color: '#e4e8f0' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            font: { size: 10, family: 'Poppins,sans-serif' },
            color: '#6a82a8',
            callback: function (v) {
              if (v >= 1000) return (v/1000).toFixed(1) + 'G';
              if (v >= 100)  return v.toFixed(0) + 'M';
              return v.toFixed(1) + 'M';
            },
          },
          grid: { color: '#e4e8f0' },
          border: { color: '#e4e8f0' },
        },
      },
    },
  });
}


/* ══════════════════════════════════════════════════════════
   CHART — Tren per Profil (bar)
══════════════════════════════════════════════════════════ */
function initChartTrend() {
  var canvas = document.getElementById('chart-trend');
  if (!canvas || typeof Chart === 'undefined') return;

  _chartTrend = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Online',
          data: [],
          backgroundColor: 'rgba(96,212,248,.85)',
          borderRadius: 5,
          borderSkipped: false,
        },
        {
          label: 'Offline',
          data: [],
          backgroundColor: 'rgba(248,113,113,.70)',
          borderRadius: 5,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (c) {
              return c.dataset.label + ': ' + c.parsed.y + ' pelanggan';
            }
          }
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10, family: 'Poppins,sans-serif' },
            color: '#6a82a8',
          },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            font: { size: 10, family: 'Poppins,sans-serif' },
            color: '#6a82a8',
          },
          grid: { color: 'rgba(0,0,0,.04)' },
        },
      },
    },
  });
}


/* ══════════════════════════════════════════════════════════
   SPARKLINES — CPU & Memory mini chart di Resource section
══════════════════════════════════════════════════════════ */
function initSparklines() {
  _spkRx = _createSparkline('spk-rx', '#378add', 'rgba(55,138,221,.12)');
  _spkTx = _createSparkline('spk-tx', '#1d9e75', 'rgba(29,158,117,.12)');
}

/* fixedMax: opsional. Jika diberikan, Y axis dibatas max itu. Jika tidak, auto-scale. */
function _createSparkline(canvasId, color, fill, fixedMax) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return null;
  var yOpts = { display: false, beginAtZero: true };
  if (fixedMax !== undefined) yOpts.max = fixedMax;
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        backgroundColor: fill,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: .4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: yOpts,
      },
    }
  });
}

/* Format Mbps → tampilkan Gbps jika >= 1000 */
function _fmtMbps(v) {
  if (!v || v < 0.005) return '0 Mbps';
  if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbps';
  if (v >= 100)  return v.toFixed(0)  + ' Mbps';
  return v.toFixed(2) + ' Mbps';
}

/* Angka saja (untuk bw-val-num) */
function _fmtBWNum(v) {
  if (!v || v < 0.005) return '0';
  if (v >= 1000) return (v / 1000).toFixed(2);
  if (v >= 100)  return v.toFixed(0);
  return v.toFixed(2);
}
/* Satuan saja (untuk bw-val-unit) */
function _fmtBWUnit(v) {
  return (v >= 1000) ? ' Gbps' : ' Mbps';
}

/* Update bw-rx-val / bw-tx-val dengan animasi flash */
function _setBWDisplay(elId, val) {
  var el = document.getElementById(elId);
  if (!el) return;
  var numEl  = el.querySelector('.bw-val-num');
  var unitEl = el.querySelector('.bw-val-unit');
  var prevRaw = parseFloat(el.dataset.raw) || 0;
  el.dataset.raw = val;

  if (numEl && unitEl) {
    numEl.textContent  = _fmtBWNum(val);
    unitEl.textContent = _fmtBWUnit(val);
    /* Flash jika perubahan > 6% */
    if (prevRaw > 0 && Math.abs(val - prevRaw) / prevRaw > 0.06) {
      numEl.classList.remove('bw-flash');
      void numEl.offsetWidth;
      numEl.classList.add('bw-flash');
    }
  } else {
    el.textContent = _fmtMbps(val);
  }
}

/* Reset tampilan ke "—" */
function _resetBWDisplay(elId) {
  var el = document.getElementById(elId);
  if (!el) return;
  el.dataset.raw = '0';
  var numEl  = el.querySelector('.bw-val-num');
  var unitEl = el.querySelector('.bw-val-unit');
  if (numEl)  numEl.textContent  = '—';
  if (unitEl) unitEl.textContent = ' Mbps';
  else el.textContent = '—';
}

/* Sub-text tren vs rata-rata untuk metric bandwidth */
function _setBWTrend(elId, current, avg) {
  var el = document.getElementById(elId);
  if (!el) return;
  if (!avg || _bwRx.length < 4) { el.textContent = ' '; el.className = 'dash-bw-metric-sub'; return; }
  var pct = Math.round((current - avg) / avg * 100);
  if (pct > 2) {
    el.textContent = '▲ ' + pct + '% dari rata-rata';
    el.className = 'dash-bw-metric-sub up';
  } else if (pct < -2) {
    el.textContent = '▼ ' + Math.abs(pct) + '% dari rata-rata';
    el.className = 'dash-bw-metric-sub dn';
  } else {
    el.textContent = 'Stabil';
    el.className = 'dash-bw-metric-sub';
  }
}

/* Tampilkan / sembunyikan area UI bandwidth (metric, stats, foot, live badge) */
function _showBWUI() {
  ['bw-metrics', 'bw-stats', 'bw-foot'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = '';
  });
  var lb = document.getElementById('bw-live-badge');
  if (lb) lb.style.display = '';

  /* Entrance animation — hanya saat pertama kali tampil */
  var section = document.querySelector('.dash-bw-section');
  if (section && !section.classList.contains('bw-entered')) {
    section.classList.add('bw-entered');
  }
}
function _hideBWUI() {
  ['bw-metrics', 'bw-stats', 'bw-foot'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var lb = document.getElementById('bw-live-badge');
  if (lb) lb.style.display = 'none';
}


/* ══════════════════════════════════════════════════════════
   SETTING
══════════════════════════════════════════════════════════ */
function _loadSettingDash() {
  var refresh = localStorage.getItem('tf_setting_refresh') || '0';
  var perpage = localStorage.getItem('tf_setting_perpage') || '50';
  var selR = document.getElementById('setting-refresh');
  var selP = document.getElementById('setting-perpage');
  if (selR) selR.value = refresh;
  if (selP) selP.value = perpage;
  _restartAutoRefresh(Number(refresh));
}

function simpanSetting() {
  var refresh = (document.getElementById('setting-refresh') || {}).value || '0';
  var perpage = (document.getElementById('setting-perpage') || {}).value || '50';
  localStorage.setItem('tf_setting_refresh', refresh);
  localStorage.setItem('tf_setting_perpage', perpage);
  _restartAutoRefresh(Number(refresh));
  if (typeof closeModalSetting === 'function') closeModalSetting();
  _showToast('Setting berhasil disimpan', 'success');
}

function _restartAutoRefresh(seconds) {
  if (_arTimer) { clearInterval(_arTimer); _arTimer = null; }
  if (seconds > 0 && seconds <= 3600) {
    _arTimer = setInterval(function () {
      if (_deviceId) {
        _loadStats(_deviceId);
        _loadProfil(_deviceId);
        _loadKeuangan();
        loadActivityLog();
      }
    }, seconds * 1000);
  }
}


/* ══════════════════════════════════════════════════════════
   RESET DASHBOARD
══════════════════════════════════════════════════════════ */
function _resetDash() {
  ['stat-total', 'stat-online', 'stat-offline', 'stat-pendapatan']
    .forEach(function (id) { _setText(id, '—'); });

  _setStatus('', 'Pilih perangkat...');
  _setSyncBadge('', '');
  _stopBW();
  _stopSyncPoll();
  _resetBWChart();

  /* BW section */
  var bwE = document.getElementById('bw-empty');
  if (bwE) {
    bwE.classList.remove('hidden');
    var p = bwE.querySelector('p');
    if (p) p.textContent = 'Pilih MikroTik & interface untuk melihat grafik bandwidth';
  }
  _setText('bw-rx-val', '— Mbps');
  _setText('bw-tx-val', '— Mbps');
  _setText('bw-iface-label', 'Pilih MikroTik terlebih dahulu');

  var ifSel = document.getElementById('bw-iface-select');
  if (ifSel) ifSel.innerHTML = '<option value="">— Interface —</option>';

  /* Offline list */
  var offBox = document.getElementById('offline-list');
  if (offBox) offBox.innerHTML = _emptyHtml('empty', 'Pilih perangkat untuk melihat data');

  /* Log */
  var logBox = document.getElementById('activity-log');
  if (logBox) logBox.innerHTML = _emptyHtml('empty', 'Pilih MikroTik untuk melihat aktivitas');

  /* Tren chart */
  if (_chartTrend) {
    _chartTrend.data.labels = [];
    _chartTrend.data.datasets.forEach(function (d) { d.data = []; });
    _chartTrend.update();
    var te = document.getElementById('trend-empty');
    if (te) te.classList.remove('hidden');
  }

  /* Profil */
  var stL = document.getElementById('profile-state-loading');
  var stE = document.getElementById('profile-state-empty');
  var tW  = document.getElementById('profile-table-wrap');
  if (stL) stL.style.display = 'none';
  if (stE) stE.style.display = '';
  if (tW)  tW.style.display  = 'none';
  _setText('profile-count-label', '—');

  _allPel = [];

}

function _resetBWChart() {
  _bwLabels = []; _bwRx = []; _bwTx = [];
  if (_chartBW) {
    _chartBW.data.labels = [];
    _chartBW.data.datasets.forEach(function (d) { d.data = []; });
    _chartBW.update('none');
  }
  if (_spkRx) { _spkRx.data.labels = []; _spkRx.data.datasets[0].data = []; _spkRx.update('none'); }
  if (_spkTx) { _spkTx.data.labels = []; _spkTx.data.datasets[0].data = []; _spkTx.update('none'); }
  _hideBWUI();
}


/* ══════════════════════════════════════════════════════════
   LOGOUT
══════════════════════════════════════════════════════════ */
function doLogout() {
  if (typeof logout === 'function') { logout(); return; }
  ['tf_token', 'tf_user_id', 'tf_username', 'tf_role', 'tf_network_id', 'tf_isp_name']
    .forEach(function (k) { localStorage.removeItem(k); });
  window.location.href = '/app/frontend/auth/auth.html';
}


/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function _authH() {
  if (typeof getAuthHeaders === 'function') return getAuthHeaders();
  var token = localStorage.getItem('tf_token') || '';
  var h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

function _isOnline(p) {
  var s = String(p.status ?? p.running ?? p.aktif ?? '').toLowerCase();
  return s === 'true' || s === 'online' || s === '1' || s === 'running' || s === 'yes';
}

function _setText(id, v) {
  var el = document.getElementById(id);
  if (el) el.textContent = (v === null || v === undefined) ? '—' : v;
}

function _setStatus(cls, label) {
  var dot  = document.getElementById('mt-status-dot');
  var text = document.getElementById('mt-status-text');
  if (dot)  dot.className  = 'dash-status-dot'  + (cls ? ' ' + cls : '');
  if (text) {
    text.className  = 'dash-status-text' + (cls ? ' ' + cls : '');
    text.textContent = label;
  }
}

function _setSyncBadge(cls, label) {
  var el = document.getElementById('sync-status');
  if (!el) return;
  el.className   = 'sync-badge' + (cls ? ' ' + cls : '');
  el.textContent = label;
}

function _emptyHtml(type, msg) {
  var icons = { ok: 'wifi', error: 'error_outline', loading: 'hourglass_empty', empty: 'info' };
  var cls   = type === 'error' ? ' error' : type === 'ok' ? ' ok' : '';
  var safe  = typeof escHtml === 'function' ? escHtml(msg) : msg;
  return '<div class="dash-empty-state' + cls + '">'
    + '<span class="material-symbols-outlined">' + (icons[type] || 'info') + '</span>'
    + '<p>' + safe + '</p>'
    + '</div>';
}

function _showToast(msg, type) {
  if (typeof toast === 'function') { toast(msg, type); return; }
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.className = 'toast'; }, 3000);
}

/* escHtml fallback jika global.js belum punya */
if (typeof escHtml === 'undefined') {
  window.escHtml = function (s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
}


/* ══════════════════════════════════════════════════════════
   RESOURCE MIKROTIK — realtime polling
══════════════════════════════════════════════════════════ */
var _resTimer   = null;
var _tickTimer  = null;
var _tickLastTs = '';

function _stopResTimer()  { if (_resTimer)  { clearInterval(_resTimer);  _resTimer  = null; } }
function _stopTickTimer() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

async function loadResource() {
  var id  = _deviceId;
  var sec = document.getElementById('resource-section');
  if (!sec || !id) { if (sec) sec.style.display = 'none'; return; }

  sec.style.display = '';
  var lbl = document.getElementById('resource-device-label');
  if (lbl) lbl.textContent = _deviceName || 'MikroTik';

  try {
    var res = await fetch(BASE + '/api/mikrotik/' + id + '/resource', { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    if (d.error) throw new Error(d.error);

    /* CPU */
    _setText('res-cpu', d.cpu_load || 0);
    _resBar('res-cpu-bar', d.cpu_load || 0, 100);
    _resStatus('res-cpu-status', d.cpu_load || 0, 70, 90);

    /* Memory */
    _setText('res-mem', d.mem_pct || 0);
    _resBar('res-mem-bar', d.mem_pct || 0, 100);
    var mu = Math.round((d.mem_used  || 0) / 1024 / 1024);
    var mt = Math.round((d.mem_total || 0) / 1024 / 1024);
    _resStatus('res-mem-status', d.mem_pct || 0, 70, 90, mu + ' / ' + mt + ' MB');

    /* Uptime */
    var up = _formatUptime(d.uptime || '');
    var upEl = document.getElementById('res-uptime');
    if (upEl) upEl.textContent = up || d.uptime || '—';
    var upBar = document.getElementById('res-uptime-bar');
    if (upBar) { upBar.style.width = '100%'; upBar.className = 'dash-res-bar ok'; }
    var upSt = document.getElementById('res-uptime-status');
    if (upSt) { upSt.textContent = 'Berjalan stabil'; upSt.className = 'dash-res-status ok'; }

    /* Suhu */
    var suhuCard = document.getElementById('res-suhu-card');
    if (d.suhu !== null && d.suhu !== undefined) {
      if (suhuCard) suhuCard.style.display = '';
      _setText('res-suhu', d.suhu);
      _resBar('res-suhu-bar', d.suhu, 100);
      _resStatus('res-suhu-status', d.suhu, 65, 80);
    } else {
      if (suhuCard) suhuCard.style.display = 'none';
    }

    /* Tipe Board */
    var boardEl = document.getElementById('res-board');
    var boardSt = document.getElementById('res-board-status');
    if (boardEl) boardEl.textContent = d.board_name || '—';
    if (boardSt) { boardSt.textContent = d.architecture || 'MikroTik'; boardSt.className = 'dash-res-status ok'; }

    /* RouterOS Version */
    var verEl = document.getElementById('res-version');
    var verSt = document.getElementById('res-version-status');
    if (verEl) verEl.textContent = d.version || '—';
    if (verSt) {
      /* Tampilkan channel build: stable / long-term / testing */
      var ch = (d.version || '').toLowerCase();
      var channel = ch.includes('stable') ? 'Stable'
                  : ch.includes('long-term') ? 'Long-term'
                  : ch.includes('testing') ? 'Testing'
                  : 'RouterOS';
      verSt.textContent = channel;
      verSt.className   = 'dash-res-status ' + (ch.includes('testing') ? 'warn' : 'ok');
    }

    /* Timestamp */
    var upd = document.getElementById('resource-updated');
    if (upd) upd.textContent = 'Update ' + new Date().toLocaleTimeString('id-ID');

  } catch (err) {
    console.warn('[dash] resource:', err.message);
  }

  _stopResTimer();
  _resTimer = setInterval(function () { if (_deviceId) loadResource(); }, 10000);
}

function _resBar(barId, val, max) {
  var el = document.getElementById(barId);
  if (!el) return;
  var pct = Math.min(Math.round(val / max * 100), 100);
  el.style.width = pct + '%';
  el.className   = 'dash-res-bar ' + (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');
}

function _resStatus(statusId, val, warnAt, dangerAt, override) {
  var el = document.getElementById(statusId);
  if (!el) return;
  var cls   = val >= dangerAt ? 'danger' : val >= warnAt ? 'warn' : 'ok';
  var label = override || (val >= dangerAt ? 'Kritis' : val >= warnAt ? 'Waspada' : 'Normal');
  el.textContent = label;
  el.className   = 'dash-res-status ' + cls;
}

function _formatUptime(raw) {
  if (!raw) return '—';
  var w = (raw.match(/(\d+)w/)      || [])[1] || 0;
  var d = (raw.match(/(\d+)d/)      || [])[1] || 0;
  var h = (raw.match(/(\d+)h/)      || [])[1] || 0;
  var m = (raw.match(/(\d+)m(?!s)/) || [])[1] || 0;
  var parts = [];
  if (w) parts.push(w + 'w');
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m && !w && !d) parts.push(m + 'm');
  return parts.slice(0, 3).join(' ') || raw;
}


/* ══════════════════════════════════════════════════════════
   LIVE TICKER
══════════════════════════════════════════════════════════ */
async function loadTicker() {
  var id  = _deviceId;
  var sec = document.getElementById('ticker-section');
  if (!sec || !id) { if (sec) sec.style.display = 'none'; _stopTickTimer(); return; }
  sec.style.display = '';
  _stopTickTimer();
  _fetchTicker(id);
  _tickTimer = setInterval(function () { if (_deviceId) _fetchTicker(_deviceId); }, 10000);
}

async function _fetchTicker(id) {
  try {
    var res = await fetch(BASE + '/api/log/aktivitas?device_id=' + id + '&limit=20', { credentials: 'include', headers: _authH() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var logs = await res.json();
    if (!Array.isArray(logs) || !logs.length) return;

    var filtered = logs.filter(function (e) {
      var m = (e.message || '').toLowerCase();
      var t = (e.topic   || '').toLowerCase();
      return /lunas|bayar|tambah|pppoe|connect|isolir|sukses|pending/.test(m + t);
    }).slice(0, 8);
    if (!filtered.length) return;

    var newestTs = filtered[0].ts || filtered[0].time || '';
    if (newestTs && newestTs === _tickLastTs) return;
    _tickLastTs = newestTs;

    var box = document.getElementById('ticker-list');
    if (!box) return;
    box.innerHTML = filtered.map(function (e) {
      var info = _tickerParse(e);
      return '<div class="dash-ticker-item">'
        + '<div class="dash-ticker-icon ' + info.type + '"><span class="material-symbols-outlined">' + info.icon + '</span></div>'
        + '<span class="dash-ticker-msg">' + info.msg + '</span>'
        + '<span class="dash-ticker-time">' + escHtml(_tickerTime(e.time || e.ts || '')) + '</span>'
        + '</div>';
    }).join('');
  } catch (_) { /* senyap */ }
}

function _tickerParse(e) {
  var raw = (e.message || '').toLowerCase();
  var tp  = (e.topic   || '').toLowerCase();
  var msg = escHtml(e.message || '').replace(/\[(\w+)\]/g, '<strong>[$1]</strong>');
  if (/lunas|bayar/.test(raw)  || /sukses/.test(tp))          return { type:'payment',    icon:'payments',   msg:msg };
  if (/tambah|add/.test(raw + tp))                             return { type:'add',        icon:'person_add', msg:msg };
  if (/isolir|block|disconnect/.test(raw + tp))                return { type:'disconnect', icon:'wifi_off',   msg:msg };
  if (/connect|online/.test(raw + tp))                         return { type:'connect',    icon:'wifi',       msg:msg };
  if (/pending|warning/.test(raw + tp))                        return { type:'warning',    icon:'warning',    msg:msg };
  return { type:'add', icon:'info', msg:msg };
}

function _tickerTime(raw) {
  if (!raw) return '';
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  try {
    var d = new Date(raw);
    if (!isNaN(d)) return d.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
  } catch(_) {}
  return raw.slice(0,10);
}


/* ══════════════════════════════════════════════════════════
   EXPOSE KE WINDOW (onclick di HTML)
══════════════════════════════════════════════════════════ */
window.refreshAll      = refreshAll;
window.onDeviceChange  = onDeviceChange;
window.onIfaceChange   = onIfaceChange;
window.loadActivityLog = loadActivityLog;
window.loadResource    = loadResource;
window.loadTicker      = loadTicker;
window.simpanSetting   = simpanSetting;
window.doLogout        = doLogout;

/* ══════════════════════════════════════════════════════════
   DASHBOARD KOLEKTOR
══════════════════════════════════════════════════════════ */
var _kolData  = []; // semua tagihan kolektor (belum bayar)
var _kolStats = {};

async function _initKolektorDashboard() {
  var hdr = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  // Load stats + tagihan belum bayar paralel
  try {
    var [rStats, rDevs] = await Promise.all([
      fetch(BASE + '/api/tagihan/kolektor-stats', { credentials: 'include', headers: hdr }),
      fetch(BASE + '/devices', { credentials: 'include', headers: hdr }),
    ]);
    if (rStats.ok) _kolStats = await rStats.json();
    var devs = rDevs.ok ? await rDevs.json() : [];

    // Render stat cards
    _kolRenderStats();

    // Load tagihan belum bayar dari semua device
    _kolData = [];
    for (var d of devs) {
      try {
        var rp = await fetch(BASE + '/api/pelanggan/' + d.id, { credentials: 'include', headers: hdr });
        if (!rp.ok) continue;
        var pels = await rp.json();
        pels.forEach(function(p) { p._device = d; });
        _kolData = _kolData.concat(pels);
      } catch(_) {}
    }
    _kolRenderTable();
  } catch(e) {
    console.error('[kolektor] init error', e);
  }
}

function _kolRenderStats() {
  var s = _kolStats;
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
  function rp(n) { return 'Rp ' + (Number(n)||0).toLocaleString('id-ID'); }
  set('kol-stat-total',        s.total_pelanggan || 0);
  set('kol-stat-lunas',        s.lunas_bulan_ini || 0);
  set('kol-stat-belum',        s.belum_bayar || 0);
  set('kol-stat-nominal',      rp(s.nominal_belum || 0));
  set('kol-stat-tunggakan',    s.tunggakan || 0);
  set('kol-stat-nom-tung',     rp(s.nominal_tunggakan || 0));
  set('kol-stat-setoran',      s.setoran_hari_ini || 0);
  set('kol-stat-nom-setoran',  rp(s.nominal_setoran_hari_ini || 0));
}

function _kolRenderTable() {
  var now = new Date();
  var periodeIni = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

  var tblBulanIni = document.getElementById('kol-tbody-ini');
  var tblTunggakan = document.getElementById('kol-tbody-tung');
  if (!tblBulanIni || !tblTunggakan) return;

  // Ambil tagihan belum bayar dari API (sudah difilter kolektor di backend)
  // _kolData berisi pelanggan — ambil username-nya lalu fetch tagihan
  _renderKolTables(periodeIni);
}

async function _renderKolTables(periodeIni) {
  var hdr = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  var tblIni  = document.getElementById('kol-tbody-ini');
  var tblTung = document.getElementById('kol-tbody-tung');
  if (!tblIni) return;

  // Fetch semua tagihan belum bayar (tanpa filter periode → kita pisah di frontend)
  var r = await fetch(BASE + '/api/tagihan?status=belum_bayar', { credentials: 'include', headers: hdr });
  if (!r.ok) return;
  var d = await r.json();
  var semua = d.tagihan || [];

  // Ambil hanya pelanggan kolektor ini (sudah terfilter dari backend karena login kolektor)
  var usernames = new Set(_kolData.map(function(p){ return p.username; }));
  semua = semua.filter(function(t){ return usernames.has(t.username); });

  var bulanIni   = semua.filter(function(t){ return t.periode === periodeIni; });
  var tunggakan  = semua.filter(function(t){ return t.periode < periodeIni; });

  function rp(n) { return 'Rp ' + (Number(n)||0).toLocaleString('id-ID'); }
  function fmtTgl(s) { if(!s) return '—'; try { return new Date(s).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); } catch{return s;} }
  function escHtml(s) { return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function rowHtml(t, i) {
    var p = _kolData.find(function(x){ return x.username === t.username; }) || {};
    var hp = escHtml(p.hp || '—');
    // Buat nomor telepon jadi link panggilan jika ada
    var hpCell = p.hp ? '<a href="tel:' + p.hp + '" style="color:var(--primary);text-decoration:none">' + escHtml(p.hp) + '</a>' : '—';
    return '<tr>' +
      '<td class="kol-dim" style="text-align:center">' + (i+1) + '</td>' +
      '<td><div class="kol-nama">' + escHtml(t.nama||t.username) + '</div>' +
        '<div class="kol-sub">@' + escHtml(t.username) + '</div></td>' +
      '<td>' + hpCell + '</td>' +
      '<td><span style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600">' + escHtml(t.profil||'—') + '</span></td>' +
      '<td class="kol-num">' + escHtml(t.periode) + '</td>' +
      '<td class="kol-num" style="color:var(--primary)">' + rp(t.nominal) + '</td>' +
      '<td class="kol-dim">' + fmtTgl(t.jatuh_tempo) + '</td>' +
      '<td><div style="display:flex;gap:6px">' +
        '<button class="btn btn-sm btn-blue" onclick="_kolDetail(\'' + escHtml(t.username) + '\')">' +
          '<span class="material-symbols-outlined">person</span>Detail</button>' +
        '<button class="btn btn-sm btn-green" onclick="_kolBayar(' + t.id + ',\'' + escHtml(t.username) + '\',' + t.nominal + ',\'' + escHtml(t.periode) + '\')">' +
          '<span class="material-symbols-outlined">payments</span>Bayar</button>' +
      '</div></td></tr>';
  }

  var emptyIni  = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-dim)"><span class="material-symbols-outlined" style="font-size:28px;display:block;margin-bottom:8px;opacity:.35">check_circle</span>Semua pelanggan sudah lunas bulan ini.</td></tr>';
  var emptyTung = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-dim)"><span class="material-symbols-outlined" style="font-size:28px;display:block;margin-bottom:8px;opacity:.35">done_all</span>Tidak ada tunggakan.</td></tr>';

  tblIni.innerHTML  = bulanIni.length  ? bulanIni.map(rowHtml).join('')  : emptyIni;
  tblTung.innerHTML = tunggakan.length ? tunggakan.map(rowHtml).join('') : emptyTung;

  // Update count badges
  var cntIni  = document.getElementById('kol-count-ini');
  var cntTung = document.getElementById('kol-count-tung');
  if (cntIni)  cntIni.textContent  = bulanIni.length  + ' tagihan';
  if (cntTung) cntTung.textContent = tunggakan.length + ' tagihan';
}

function _kolDetail(username) {
  // Temukan data pelanggan dari _kolData dan buka detail
  var p = _kolData.find(function(x){ return x.username === username; });
  if (!p) { alert('Data tidak ditemukan'); return; }
  try { sessionStorage.setItem('tf_detail_pelanggan', JSON.stringify(p)); } catch(_) {}
  window.open('/app/frontend/pelanggan/detail_pelanggan.html', '_blank');
}

var _bayarTarget = null;
async function _kolBayar(tagihan_id, username, nominal, periode) {
  var hdr = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  function rp(n) { return 'Rp ' + (Number(n)||0).toLocaleString('id-ID'); }

  // Cek apakah ada tunggakan bulan lain untuk username ini
  var r = await fetch(BASE + '/api/tagihan/pelanggan/' + encodeURIComponent(username),
    { credentials: 'include', headers: hdr });
  var d = await r.json();
  var belum = (d.tagihan || []).filter(function(t){ return t.status === 'belum_bayar'; });

  if (belum.length <= 1) {
    // Hanya 1 tagihan — langsung bayar
    _kolBayarProses([tagihan_id], username, nominal);
    return;
  }

  // Lebih dari 1 — tampilkan popup pilih bulan
  _kolBayarTarget = belum;
  _kolBayarTargetUser = username;
  var modal = document.getElementById('kol-bayar-modal');
  var list  = document.getElementById('kol-bayar-list');
  if (!modal || !list) return;

  list.innerHTML = belum.map(function(t) {
    var checked = t.id === tagihan_id ? 'checked' : '';
    return '<label class="kol-bayar-item">' +
      '<input type="checkbox" value="' + t.id + '" ' + checked + '> ' +
      '<span><strong>' + t.periode + '</strong> — ' + rp(t.nominal) + ' (jatuh tempo ' + (t.jatuh_tempo||'-') + ')</span>' +
      '</label>';
  }).join('');

  modal.classList.add('show');
  document.getElementById('kol-bayar-overlay').classList.add('show');
}

var _kolBayarTarget = [], _kolBayarTargetUser = '';

function _kolBayarTutup() {
  var m = document.getElementById('kol-bayar-modal');
  var o = document.getElementById('kol-bayar-overlay');
  if (m) m.classList.remove('show');
  if (o) o.classList.remove('show');
}

async function _kolBayarKonfirm() {
  var ids = Array.from(document.querySelectorAll('#kol-bayar-list input:checked'))
              .map(function(el){ return parseInt(el.value); });
  if (!ids.length) { alert('Pilih minimal 1 tagihan'); return; }
  var metode = (document.getElementById('kol-bayar-metode') || {value:'Cash'}).value || 'Cash';
  _kolBayarTutup();
  _kolBayarProses(ids, _kolBayarTargetUser, 0, metode);
}

async function _kolBayarProses(ids, username, nominal, metode) {
  metode = metode || 'Cash';
  var hdr = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
  try {
    var r = await fetch(BASE + '/api/tagihan/bayar-multi', {
      method: 'POST', credentials: 'include',
      headers: Object.assign({'Content-Type':'application/json'}, hdr),
      body: JSON.stringify({ tagihan_ids: ids, metode: metode })
    });
    var d = await r.json();
    if (typeof toast === 'function') toast(d.message || (r.ok ? 'Lunas' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) {
      _kolStats = {};
      _initKolektorDashboard();
      // Tawaran kirim struk via WA
      var pel = _kolData.find(function(p){ return p.username === username; });
      var hp  = pel ? ((pel.hp || '').replace(/\D/g,'')) : '';
      if (hp) {
        var waNum  = '62' + (hp.startsWith('0') ? hp.slice(1) : hp);
        var kol    = localStorage.getItem('tf_username') || 'Kolektor';
        var isp    = localStorage.getItem('tf_isp_name') || 'TechnoFix';
        var tgl    = new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'});
        var total  = 'Rp ' + (Number(d.total)||0).toLocaleString('id-ID');
        var pesan  = encodeURIComponent(
          'Bukti Pembayaran - ' + isp + '\n' +
          '--------------------------------\n' +
          'Pelanggan : ' + (pel.nama || username) + '\n' +
          'Tanggal   : ' + tgl + '\n' +
          'Metode    : ' + metode + '\n' +
          'Total     : ' + total + '\n' +
          'Kolektor  : ' + kol + '\n' +
          '--------------------------------\n' +
          'Terima kasih telah membayar tagihan Anda.'
        );
        // Tawaran kirim struk lewat konfirmasi
        setTimeout(function() {
          if (confirm('Kirim struk pembayaran ke pelanggan via WhatsApp?')) {
            window.open('https://wa.me/' + waNum + '?text=' + pesan, '_blank');
          }
        }, 400);
      }
    }
  } catch(e) {
    if (typeof toast === 'function') toast('Tidak bisa menghubungi server', 'danger');
  }
}
