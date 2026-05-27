/* ============================================================
   dashboard.js — TechnoFix · Dashboard Utama
   Dependensi: global.js, Chart.js

   Alur:
   1. loadMikrotikList()          → isi <select> MikroTik
   2. onMikrotikChange()          → dipicu saat user ganti pilihan
   3. loadDashboardData(id)       → load semua blok sekaligus:
        - loadStats(id)           → stat cards
        - loadInterfaces(id)      → isi dropdown interface BW
        - loadOfflineList(id)     → daftar pelanggan offline
        - loadTrendChart(id)      → grafik 7 hari
        - loadActivityLog(id)     → log sistem
   4. startBandwidthPoll(id)      → polling BW setiap 3 detik
   5. stopBandwidthPoll()         → hentikan interval sebelumnya

   Endpoint yang dipakai (semua diawali API_BASE dari global.js):
   - GET /api/mikrotik/list
   - GET /api/mikrotik/{id}/status
   - GET /api/mikrotik/{id}/stats          → { total, online, offline }
   - GET /api/mikrotik/{id}/interfaces     → [{ name, description }]
   - GET /api/mikrotik/{id}/bandwidth?interface=ether1
   - GET /api/mikrotik/{id}/pelanggan/offline
   - GET /api/mikrotik/{id}/trend          → { labels[], online[], offline[] }
   - GET /api/mikrotik/{id}/log            → [{ time, topic, message }]
   - GET /api/keuangan/ringkasan           → { pendapatan_bulan, jatuh_tempo }
   ============================================================ */

'use strict';

/* ── State ── */
var _selectedMikrotikId   = null;
var _bandwidthInterval    = null;
var _chartBandwidth       = null;
var _chartTrend           = null;
var _bwLabels             = [];
var _bwRxData             = [];
var _bwTxData             = [];
var _bwMaxPoints          = 40;   /* jumlah titik data yang ditampilkan di grafik */
var _selectedInterface    = '';
var _autoRefreshInterval  = null;

/* ── Baca setting auto-refresh ── */
function getAutoRefreshMs() {
  var v = parseInt(localStorage.getItem('tf_setting_refresh') || '0', 10);
  return v > 0 ? v * 1000 : 0;
}


/* ══════════════════════════════════════════════════════════
   INIT — dipanggil saat DOM siap
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  /* Fungsi global.js */
  if (typeof initHeaderCanvas === 'function') initHeaderCanvas();
  if (typeof initBottomNav    === 'function') initBottomNav();
  if (typeof initDateBadge    === 'function') initDateBadge();
  if (typeof applyUIPermissions === 'function') applyUIPermissions();

  /* Cek auth */
  var token = localStorage.getItem('tf_token');
  if (!token) {
    window.location.href = '/app/frontend/auth/auth.html';
    return;
  }

  /* Inisialisasi chart (kosong) */
  initChartBandwidth();
  initChartTrend();

  /* Load daftar MikroTik */
  loadMikrotikList();

  /* Auto-refresh global */
  startAutoRefresh();
});


/* ══════════════════════════════════════════════════════════
   AUTO-REFRESH
══════════════════════════════════════════════════════════ */
function startAutoRefresh() {
  if (_autoRefreshInterval) clearInterval(_autoRefreshInterval);
  var ms = getAutoRefreshMs();
  if (ms <= 0) return;
  _autoRefreshInterval = setInterval(function () {
    if (_selectedMikrotikId) loadDashboardData(_selectedMikrotikId);
  }, ms);
}


/* ══════════════════════════════════════════════════════════
   REFRESH ALL (tombol header)
══════════════════════════════════════════════════════════ */
function refreshAll() {
  var icon = document.getElementById('refresh-icon');
  if (icon) {
    icon.style.animation = 'spin 0.8s linear infinite';
    setTimeout(function () { icon.style.animation = ''; }, 900);
  }
  if (_selectedMikrotikId) {
    loadDashboardData(_selectedMikrotikId);
  } else {
    loadMikrotikList();
  }
}

/* CSS spin — inject sekali */
(function () {
  var style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
})();


/* ══════════════════════════════════════════════════════════
   1. LOAD DAFTAR MIKROTIK
══════════════════════════════════════════════════════════ */
function loadMikrotikList() {
  fetch(API_BASE + '/api/mikrotik/list', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = Array.isArray(data) ? data : (data.data || []);
      var sel  = document.getElementById('mikrotik-select');
      if (!sel) return;

      sel.innerHTML = '';

      if (list.length === 0) {
        sel.innerHTML = '<option value="">— Belum ada MikroTik —</option>';
        return;
      }

      /* Placeholder */
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '— Pilih MikroTik —';
      sel.appendChild(ph);

      list.forEach(function (mt) {
        var opt = document.createElement('option');
        opt.value       = mt.id;
        opt.textContent = mt.nama || mt.name || ('MikroTik #' + mt.id);
        if (mt.ip_address) opt.textContent += ' (' + mt.ip_address + ')';
        sel.appendChild(opt);
      });

      /* Restore pilihan terakhir (simpan di localStorage) */
      var lastId = localStorage.getItem('tf_dashboard_mt');
      if (lastId) {
        sel.value = lastId;
        if (sel.value === lastId) {
          _selectedMikrotikId = lastId;
          loadDashboardData(lastId);
        }
      }
    })
    .catch(function (err) {
      console.error('loadMikrotikList error:', err);
      var sel = document.getElementById('mikrotik-select');
      if (sel) sel.innerHTML = '<option value="">— Gagal memuat —</option>';
      setMtStatus('offline', 'Gagal terhubung ke server', '');
    });
}


/* ══════════════════════════════════════════════════════════
   2. EVENT: GANTI MIKROTIK
══════════════════════════════════════════════════════════ */
function onMikrotikChange() {
  var sel = document.getElementById('mikrotik-select');
  if (!sel) return;
  var id = sel.value;
  if (!id) {
    _selectedMikrotikId = null;
    stopBandwidthPoll();
    resetDashboard();
    return;
  }
  _selectedMikrotikId = id;
  localStorage.setItem('tf_dashboard_mt', id);
  loadDashboardData(id);
}


/* ══════════════════════════════════════════════════════════
   3. LOAD SEMUA DATA DASHBOARD
══════════════════════════════════════════════════════════ */
function loadDashboardData(id) {
  loadMtStatus(id);
  loadStats(id);
  loadInterfaces(id);
  loadOfflineList(id);
  loadTrendChart(id);
  loadActivityLog(id);
  loadKeuangan();
}


/* ── 3a. Status MikroTik ── */
function loadMtStatus(id) {
  fetch(API_BASE + '/api/mikrotik/' + id + '/status', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var status = (d.status || d.connected) === true || d.status === 'connected'
        ? 'online' : 'offline';
      var label  = status === 'online' ? 'Terhubung' : 'Tidak Terhubung';
      var uptime = d.uptime || d.system_uptime || '';
      setMtStatus(status, label, uptime);
    })
    .catch(function () {
      setMtStatus('offline', 'Tidak Terhubung', '');
    });
}

function setMtStatus(cls, label, uptime) {
  var dot    = document.getElementById('mt-status-dot');
  var text   = document.getElementById('mt-status-text');
  var uptimeEl = document.getElementById('mt-uptime');

  if (dot)   { dot.className = 'dash-status-dot ' + cls; }
  if (text)  { text.className = 'dash-status-text ' + cls; text.textContent = label; }
  if (uptimeEl) { uptimeEl.textContent = uptime ? ('Uptime: ' + uptime) : ''; }
}


/* ── 3b. Stat Cards ── */
function loadStats(id) {
  /* Skeleton */
  ['stat-total','stat-online','stat-offline'].forEach(function (elId) {
    var el = document.getElementById(elId);
    if (el) el.textContent = '...';
  });

  fetch(API_BASE + '/api/mikrotik/' + id + '/stats', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var total   = d.total   || 0;
      var online  = d.online  || 0;
      var offline = d.offline || 0;

      if (typeof animNum === 'function') {
        animNum('stat-total',   total);
        animNum('stat-online',  online);
        animNum('stat-offline', offline);
      } else {
        document.getElementById('stat-total').textContent   = total;
        document.getElementById('stat-online').textContent  = online;
        document.getElementById('stat-offline').textContent = offline;
      }

      var pctOn  = total > 0 ? Math.round((online  / total) * 100) : 0;
      var pctOff = total > 0 ? Math.round((offline / total) * 100) : 0;

      var subOn  = document.getElementById('stat-online-pct');
      var subOff = document.getElementById('stat-offline-pct');
      var subTot = document.getElementById('stat-total-sub');

      if (subOn)  subOn.textContent  = pctOn  + '% dari total';
      if (subOff) subOff.textContent = pctOff + '% dari total';
      if (subTot) {
        var sel = document.getElementById('mikrotik-select');
        var mtName = sel ? (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '') : '';
        subTot.textContent = mtName || 'dari MikroTik terpilih';
      }
    })
    .catch(function (err) {
      console.error('loadStats error:', err);
      ['stat-total','stat-online','stat-offline'].forEach(function (elId) {
        var el = document.getElementById(elId);
        if (el) el.textContent = '—';
      });
    });
}


/* ── 3c. Keuangan (ringkasan, owner only) ── */
function loadKeuangan() {
  var role = localStorage.getItem('tf_role') || '';
  var permsRaw = localStorage.getItem('tf_permissions') || '[]';
  var perms = [];
  try { perms = JSON.parse(permsRaw); } catch(_) {}

  var hasKeuangan = role === 'owner' || perms.includes('keuangan');
  if (!hasKeuangan) {
    var card = document.getElementById('stat-pendapatan');
    if (card) {
      var parent = card.closest('.stat-card');
      if (parent) parent.style.display = 'none';
    }
    return;
  }

  fetch(API_BASE + '/api/keuangan/ringkasan', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var pendEl = document.getElementById('stat-pendapatan');
      var jtEl   = document.getElementById('stat-jatuh-tempo');

      var nominal = d.pendapatan_bulan || d.total || 0;
      var jt      = d.jatuh_tempo || 0;

      if (pendEl) pendEl.textContent = 'Rp ' + Number(nominal).toLocaleString('id-ID');
      if (jtEl)   jtEl.textContent   = jt + ' tagihan jatuh tempo';
    })
    .catch(function () {
      var pendEl = document.getElementById('stat-pendapatan');
      if (pendEl) pendEl.textContent = '—';
    });
}


/* ── 3d. Interfaces (untuk selector BW) ── */
function loadInterfaces(id) {
  fetch(API_BASE + '/api/mikrotik/' + id + '/interfaces', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = Array.isArray(data) ? data : (data.interfaces || data.data || []);
      var sel  = document.getElementById('bw-interface-select');
      if (!sel) return;

      /* Simpan nilai sebelumnya */
      var prev = sel.value;
      sel.innerHTML = '<option value="">— Pilih Interface —</option>';

      list.forEach(function (iface) {
        var opt = document.createElement('option');
        var name = iface.name || iface['name'] || iface;
        opt.value = name;
        opt.textContent = iface.description ? (name + ' — ' + iface.description) : name;
        sel.appendChild(opt);
      });

      /* Restore atau pilih ether1 / WAN default */
      if (prev && [...sel.options].some(function (o) { return o.value === prev; })) {
        sel.value = prev;
        _selectedInterface = prev;
      } else {
        /* Auto-pilih interface WAN pertama */
        var autoIface = list.find(function (i) {
          var n = (i.name || i || '').toLowerCase();
          return n.includes('ether1') || n.includes('wan') || n.includes('sfp');
        });
        if (autoIface) {
          sel.value = autoIface.name || autoIface;
          _selectedInterface = sel.value;
        }
      }

      /* Update label */
      var label = document.getElementById('bw-interface-label');
      if (label) label.textContent = _selectedInterface || 'Pilih interface di atas';

      /* Mulai polling jika interface sudah terpilih */
      if (_selectedInterface) {
        startBandwidthPoll(id);
      }
    })
    .catch(function (err) {
      console.error('loadInterfaces error:', err);
      setMtStatus('offline', 'Gagal ambil interfaces', '');
    });
}


/* ══════════════════════════════════════════════════════════
   4. BANDWIDTH REALTIME
══════════════════════════════════════════════════════════ */
function onInterfaceChange() {
  var sel = document.getElementById('bw-interface-select');
  if (!sel) return;
  _selectedInterface = sel.value;

  var label = document.getElementById('bw-interface-label');
  if (label) label.textContent = _selectedInterface || 'Pilih interface di atas';

  /* Reset data grafik */
  _bwLabels  = [];
  _bwRxData  = [];
  _bwTxData  = [];
  if (_chartBandwidth) {
    _chartBandwidth.data.labels   = _bwLabels;
    _chartBandwidth.data.datasets[0].data = _bwRxData;
    _chartBandwidth.data.datasets[1].data = _bwTxData;
    _chartBandwidth.update('none');
  }

  if (_selectedMikrotikId && _selectedInterface) {
    startBandwidthPoll(_selectedMikrotikId);
  } else {
    stopBandwidthPoll();
  }
}

function startBandwidthPoll(id) {
  stopBandwidthPoll();
  if (!_selectedInterface) return;

  /* Sembunyikan empty state */
  var empty = document.getElementById('bw-empty');
  if (empty) empty.classList.add('hidden');

  fetchBandwidth(id);
  _bandwidthInterval = setInterval(function () {
    fetchBandwidth(id);
  }, 3000);  /* polling tiap 3 detik */
}

function stopBandwidthPoll() {
  if (_bandwidthInterval) {
    clearInterval(_bandwidthInterval);
    _bandwidthInterval = null;
  }
}

function fetchBandwidth(id) {
  if (!_selectedInterface) return;

  var url = API_BASE + '/api/mikrotik/' + id + '/bandwidth?interface='
    + encodeURIComponent(_selectedInterface);

  fetch(url, { headers: getAuthHeaders() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      /* Terima field: rx_bits, tx_bits, rx_mbps, tx_mbps, download, upload */
      var rxMbps = parseFloat(
        d.rx_mbps ?? d.download ?? (d.rx_bits ? d.rx_bits / 1e6 : null) ?? 0
      );
      var txMbps = parseFloat(
        d.tx_mbps ?? d.upload   ?? (d.tx_bits ? d.tx_bits / 1e6 : null) ?? 0
      );

      /* Label waktu */
      var now = new Date();
      var timeLabel = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      /* Tambah ke array data */
      _bwLabels.push(timeLabel);
      _bwRxData.push(rxMbps);
      _bwTxData.push(txMbps);

      /* Batasi jumlah titik */
      if (_bwLabels.length > _bwMaxPoints) {
        _bwLabels.shift();
        _bwRxData.shift();
        _bwTxData.shift();
      }

      /* Update chart */
      if (_chartBandwidth) {
        _chartBandwidth.data.labels             = _bwLabels;
        _chartBandwidth.data.datasets[0].data   = _bwRxData;
        _chartBandwidth.data.datasets[1].data   = _bwTxData;
        _chartBandwidth.update('none');
      }

      /* Update pill values */
      var rxEl = document.getElementById('bw-rx-val');
      var txEl = document.getElementById('bw-tx-val');
      if (rxEl) rxEl.textContent = rxMbps.toFixed(2) + ' Mbps';
      if (txEl) txEl.textContent = txMbps.toFixed(2) + ' Mbps';
    })
    .catch(function (err) {
      console.error('fetchBandwidth error:', err);
    });
}


/* ══════════════════════════════════════════════════════════
   5. PELANGGAN OFFLINE
══════════════════════════════════════════════════════════ */
function loadOfflineList(id) {
  var container = document.getElementById('offline-list');
  var countLabel = document.getElementById('offline-count-label');
  if (!container) return;

  container.innerHTML = '<div class="dash-empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>Memuat...</p></div>';

  fetch(API_BASE + '/api/mikrotik/' + id + '/pelanggan/offline', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = Array.isArray(data) ? data : (data.data || []);

      if (countLabel) countLabel.textContent = list.length + ' pelanggan offline';

      if (list.length === 0) {
        container.innerHTML =
          '<div class="dash-empty-state">'
          + '<span class="material-symbols-outlined">wifi</span>'
          + '<p>Semua pelanggan online ✓</p>'
          + '</div>';
        return;
      }

      /* Tampilkan maks 20 item */
      var shown = list.slice(0, 20);
      container.innerHTML = shown.map(function (p) {
        var name     = escHtml(p.name || p.username || p.nama || 'Pelanggan');
        var ip       = escHtml(p.address || p.ip || p.ip_address || '');
        var profile  = escHtml(p.profile || p.paket || '');
        var since    = p.last_seen || p.offline_since || '';
        var sinceStr = since ? formatRelativeTime(since) : 'Tidak diketahui';
        var href     = p.id
          ? '/app/frontend/pelanggan/detail_pelanggan.html?id=' + p.id
          : '/app/frontend/pelanggan/pelanggan.html';

        return '<a href="' + href + '" class="dash-offline-item">'
          + '<div class="dash-offline-icon"><span class="material-symbols-outlined">wifi_off</span></div>'
          + '<div style="flex:1;min-width:0">'
          + '<div class="dash-offline-name">' + name + '</div>'
          + '<div class="dash-offline-meta">'
          + (ip ? ip : '') + (profile ? (ip ? ' · ' : '') + profile : '')
          + '</div>'
          + '</div>'
          + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">'
          + '<span class="dash-offline-badge">Offline</span>'
          + '<span style="font-size:10.5px;color:var(--text-dim)">' + escHtml(sinceStr) + '</span>'
          + '</div>'
          + '</a>';
      }).join('');

      /* Jika ada lebih dari 20, tambah link lihat semua */
      if (list.length > 20) {
        container.innerHTML +=
          '<a href="/app/frontend/pelanggan/pelanggan.html" style="display:block;text-align:center;padding:10px;font-size:12.5px;color:var(--primary);font-weight:600;text-decoration:none">'
          + '+ ' + (list.length - 20) + ' lainnya — Lihat semua'
          + '</a>';
      }
    })
    .catch(function (err) {
      console.error('loadOfflineList error:', err);
      container.innerHTML =
        '<div class="dash-empty-state"><span class="material-symbols-outlined">error</span><p>Gagal memuat data</p></div>';
    });
}


/* ══════════════════════════════════════════════════════════
   6. TREND CHART (7 hari)
══════════════════════════════════════════════════════════ */
function loadTrendChart(id) {
  var trendEmpty = document.getElementById('trend-empty');

  fetch(API_BASE + '/api/mikrotik/' + id + '/trend', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var labels  = d.labels  || [];
      var online  = d.online  || [];
      var offline = d.offline || [];

      if (trendEmpty) trendEmpty.classList.add('hidden');

      if (_chartTrend) {
        _chartTrend.data.labels             = labels;
        _chartTrend.data.datasets[0].data   = online;
        _chartTrend.data.datasets[1].data   = offline;
        _chartTrend.update();
      }
    })
    .catch(function (err) {
      console.error('loadTrendChart error:', err);
      if (trendEmpty) trendEmpty.classList.remove('hidden');
    });
}


/* ══════════════════════════════════════════════════════════
   7. ACTIVITY LOG
══════════════════════════════════════════════════════════ */
function loadActivityLog(id) {
  id = id || _selectedMikrotikId;
  if (!id) return;

  var container = document.getElementById('activity-log');
  if (!container) return;

  container.innerHTML =
    '<div class="dash-empty-state"><span class="material-symbols-outlined">hourglass_empty</span><p>Memuat log...</p></div>';

  fetch(API_BASE + '/api/mikrotik/' + id + '/log', {
    headers: getAuthHeaders()
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = Array.isArray(data) ? data : (data.logs || data.data || []);

      if (list.length === 0) {
        container.innerHTML =
          '<div class="dash-empty-state"><span class="material-symbols-outlined">history</span><p>Belum ada log</p></div>';
        return;
      }

      container.innerHTML = list.slice(0, 50).map(function (entry) {
        var topic   = (entry.topic || entry.type || 'info').toLowerCase();
        var dotCls  = logTopicClass(topic);
        var msg     = escHtml(entry.message || entry.msg || '');
        var timeStr = escHtml(entry.time || entry.timestamp || '');

        /* Bold nama di pesan (format: "<name> xxx") */
        msg = msg.replace(/^([^\s]+)/, '<strong>$1</strong>');

        return '<div class="dash-log-item">'
          + '<div class="dash-log-dot ' + dotCls + '"></div>'
          + '<div class="dash-log-msg">' + msg + '</div>'
          + '<div class="dash-log-time">' + timeStr + '</div>'
          + '</div>';
      }).join('');
    })
    .catch(function (err) {
      console.error('loadActivityLog error:', err);
      container.innerHTML =
        '<div class="dash-empty-state"><span class="material-symbols-outlined">error</span><p>Gagal memuat log</p></div>';
    });
}

function logTopicClass(topic) {
  if (topic.includes('warn') || topic.includes('dhcp') || topic.includes('firewall')) return 'warning';
  if (topic.includes('err')  || topic.includes('fail') || topic.includes('drop'))    return 'error';
  if (topic.includes('info') || topic.includes('system') || topic.includes('login')) return 'info';
  if (topic.includes('ok')   || topic.includes('success'))                           return 'success';
  return 'info';
}


/* ══════════════════════════════════════════════════════════
   RESET DASHBOARD (saat tidak ada MikroTik dipilih)
══════════════════════════════════════════════════════════ */
function resetDashboard() {
  ['stat-total','stat-online','stat-offline','stat-pendapatan'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '—';
  });

  setMtStatus('', 'Pilih MikroTik...', '');

  var offList = document.getElementById('offline-list');
  if (offList) offList.innerHTML =
    '<div class="dash-empty-state"><span class="material-symbols-outlined">wifi</span><p>Pilih MikroTik untuk melihat data</p></div>';

  var actLog = document.getElementById('activity-log');
  if (actLog) actLog.innerHTML =
    '<div class="dash-empty-state"><span class="material-symbols-outlined">history</span><p>Pilih MikroTik untuk melihat log</p></div>';

  var bwEmpty = document.getElementById('bw-empty');
  if (bwEmpty) bwEmpty.classList.remove('hidden');

  /* Reset pill BW */
  var rxEl = document.getElementById('bw-rx-val');
  var txEl = document.getElementById('bw-tx-val');
  if (rxEl) rxEl.textContent = '— Mbps';
  if (txEl) txEl.textContent = '— Mbps';

  if (_chartTrend) {
    _chartTrend.data.labels = [];
    _chartTrend.data.datasets.forEach(function (ds) { ds.data = []; });
    _chartTrend.update();
  }

  if (_chartBandwidth) {
    _bwLabels = []; _bwRxData = []; _bwTxData = [];
    _chartBandwidth.data.labels = [];
    _chartBandwidth.data.datasets.forEach(function (ds) { ds.data = []; });
    _chartBandwidth.update('none');
  }

  stopBandwidthPoll();
}


/* ══════════════════════════════════════════════════════════
   CHART INIT — Bandwidth
══════════════════════════════════════════════════════════ */
function initChartBandwidth() {
  var canvas = document.getElementById('chart-bandwidth');
  if (!canvas || typeof Chart === 'undefined') return;

  _chartBandwidth = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: _bwLabels,
      datasets: [
        {
          label: 'Download (Mbps)',
          data:  _bwRxData,
          borderColor:     '#00aeef',
          backgroundColor: 'rgba(0,174,239,.10)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Upload (Mbps)',
          data:  _bwTxData,
          borderColor:     '#00c48c',
          backgroundColor: 'rgba(0,196,140,.10)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: false,  /* kita pakai pill sendiri */
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' Mbps';
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 6,
            font: { size: 10, family: 'Poppins, sans-serif' },
            color: '#6a82a8',
          },
          grid: { color: 'rgba(0,0,0,.05)' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            font: { size: 10, family: 'Poppins, sans-serif' },
            color: '#6a82a8',
            callback: function (v) { return v + ' M'; }
          },
          grid: { color: 'rgba(0,0,0,.05)' },
        },
      },
    },
  });
}


/* ══════════════════════════════════════════════════════════
   CHART INIT — Trend Pelanggan
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
          data:  [],
          backgroundColor: 'rgba(0,64,161,.65)',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'Offline',
          data:  [],
          backgroundColor: 'rgba(186,26,26,.55)',
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              return ctx.dataset.label + ': ' + ctx.parsed.y + ' pelanggan';
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10, family: 'Poppins, sans-serif' },
            color: '#6a82a8',
          },
          grid: { display: false },
          stacked: false,
        },
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1,
            font: { size: 10, family: 'Poppins, sans-serif' },
            color: '#6a82a8',
          },
          grid: { color: 'rgba(0,0,0,.05)' },
        },
      },
    },
  });
}


/* ══════════════════════════════════════════════════════════
   HELPER — Auth Headers
══════════════════════════════════════════════════════════ */
function getAuthHeaders() {
  var token = localStorage.getItem('tf_token') || '';
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
  };
}

/* ── Helper: waktu relatif ── */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  try {
    var d    = new Date(dateStr);
    var diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60)   return diff + ' dtk lalu';
    if (diff < 3600) return Math.floor(diff / 60) + ' mnt lalu';
    if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
    return Math.floor(diff / 86400) + ' hari lalu';
  } catch (_) {
    return dateStr;
  }
}

/* ── Logout ── */
function doLogout() {
  localStorage.removeItem('tf_token');
  localStorage.removeItem('tf_role');
  localStorage.removeItem('tf_permissions');
  window.location.href = '/app/frontend/auth/auth.html';
}