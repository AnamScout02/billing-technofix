/* ============================================================
   diagnostik.js — Diagnostik Jaringan (Ping via MikroTik)
   ============================================================ */

'use strict';

function _hdr(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (typeof getAuthHeaders === 'function') Object.assign(h, getAuthHeaders());
  return h;
}
function _get(url)  { return fetch(url, { credentials: 'include', headers: _hdr() }); }
function _post(url, body) { return fetch(url, { method: 'POST', credentials: 'include', headers: _hdr(), body: JSON.stringify(body) }); }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Parse durasi RouterOS (mis. "1ms", "830us", "1s200ms") jadi milidetik */
function parseRtt(v) {
  if (v == null) return null;
  var s = String(v);
  var re = /(\d+(?:\.\d+)?)(s|ms|us)/g;
  var m, total = 0, matched = false;
  while ((m = re.exec(s))) {
    matched = true;
    var num = parseFloat(m[1]);
    if (m[2] === 's') total += num * 1000;
    else if (m[2] === 'ms') total += num;
    else if (m[2] === 'us') total += num / 1000;
  }
  if (!matched) {
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  return total;
}

function fmtMs(v) {
  return v == null ? '—' : String(v);
}

async function loadDevices() {
  const sel = document.getElementById('f-device');
  try {
    const res  = await _get(`${API_BASE}/devices`);
    const data = await res.json();
    const devices = (Array.isArray(data) ? data : []).filter(function(d){ return d.username; });
    if (!devices.length) {
      sel.innerHTML = '<option value="">Belum ada MikroTik terdaftar</option>';
      return;
    }
    sel.innerHTML = devices.map(function(d) {
      return '<option value="' + d.id + '">' + esc(d.name) + ' (' + esc(d.ip) + ')</option>';
    }).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Gagal memuat perangkat</option>';
  }
}

function renderEmptyIn(containerId, icon, text) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML =
    '<div class="empty-state"><span class="material-symbols-outlined">' + icon + '</span><p>' + esc(text) + '</p></div>';
}
function renderEmpty(icon, text) { renderEmptyIn('ping-results', icon, text); }

/* Ambil nilai pertama yang tidak null dari beberapa kandidat nama field —
   nama field balasan RouterOS untuk /tool/traceroute belum divalidasi ke
   device nyata, jadi render dibuat toleran kalau asumsi nama field meleset. */
function pick(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] != null) return obj[keys[i]];
  }
  return null;
}

/* ── Tab switcher Ping / Traceroute ── */
function switchDiagTab(tab) {
  document.getElementById('tab-ping').classList.toggle('active', tab === 'ping');
  document.getElementById('tab-traceroute').classList.toggle('active', tab === 'traceroute');
  document.querySelectorAll('.diag-only-ping').forEach(function(el) {
    el.classList.toggle('diag-panel-hidden', tab !== 'ping');
  });
  document.querySelectorAll('.diag-only-traceroute').forEach(function(el) {
    el.classList.toggle('diag-panel-hidden', tab !== 'traceroute');
  });
}

/* ── Mode ping realtime: mulai/stop kapan saja, tanpa jumlah paket tetap ── */
let pingActive = false;
let pingSeq    = 0;
let pingStats  = { sent: 0, received: 0, rtts: [] };

function selectedDeviceLabel() {
  const sel = document.getElementById('f-device');
  const opt = sel.options[sel.selectedIndex];
  return opt ? opt.textContent : '';
}

function setFormDisabled(disabled) {
  document.getElementById('f-device').disabled = disabled;
  document.getElementById('f-target').disabled = disabled;
  document.getElementById('f-size').disabled   = disabled;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderLiveSkeleton(target, deviceLabel, size) {
  document.getElementById('ping-results').innerHTML = `
    <div class="form-card">
      <div class="form-card-title">
        <span class="material-symbols-outlined">flag</span>
        Ping ke ${esc(target)}
        <span class="diag-live-badge"><span class="diag-live-dot"></span>Live</span>
        <span class="diag-target-sub">via ${esc(deviceLabel)} &middot; ${esc(size)} bytes</span>
      </div>

      <div class="diag-summary-grid">
        <div class="diag-stat"><div class="diag-stat-label">Terkirim</div><div class="diag-stat-value" id="diag-sent">0</div></div>
        <div class="diag-stat"><div class="diag-stat-label">Diterima</div><div class="diag-stat-value" id="diag-received">0</div></div>
        <div class="diag-stat diag-stat-ok" id="diag-stat-lost"><div class="diag-stat-label">Hilang</div><div class="diag-stat-value" id="diag-lost">0 (0%)</div></div>
        <div class="diag-stat"><div class="diag-stat-label">Min</div><div class="diag-stat-value" id="diag-min">—</div></div>
        <div class="diag-stat"><div class="diag-stat-label">Avg</div><div class="diag-stat-value" id="diag-avg">—</div></div>
        <div class="diag-stat"><div class="diag-stat-label">Max</div><div class="diag-stat-value" id="diag-max">—</div></div>
        <div class="diag-stat"><div class="diag-stat-label">Jitter (Max−Min)</div><div class="diag-stat-value" id="diag-jitter">—</div></div>
        <div class="diag-stat" id="diag-stat-status"><div class="diag-stat-label">Status Koneksi</div><div class="diag-stat-value" id="diag-status">—</div></div>
      </div>

      <div class="diag-table-wrap" id="diag-table-wrap">
        <table class="diag-table">
          <thead><tr><th>Seq</th><th>Size</th><th>TTL</th><th>Time</th></tr></thead>
          <tbody id="diag-table-body"></tbody>
        </table>
      </div>
    </div>
  `;
}

function appendPacketRow(seq, packet) {
  const tbody = document.getElementById('diag-table-body');
  if (!tbody) return;
  const tr = document.createElement('tr');
  if (packet) {
    tr.innerHTML = '<td class="sticky-col-1">' + esc(seq) + '</td><td>' + esc(packet.size) + '</td><td>' + esc(packet.ttl) + '</td><td>' + esc(fmtMs(packet.time)) + '</td>';
  } else {
    tr.className = 'diag-row-timeout';
    tr.innerHTML = '<td class="sticky-col-1">' + esc(seq) + '</td><td>—</td><td>—</td><td>Request timeout</td>';
  }
  tbody.appendChild(tr);
  const wrap = document.getElementById('diag-table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

/* Ambang batas jitter (ms) untuk kategori status koneksi kualitatif */
const JITTER_WARN_MS = 15;
const JITTER_BAD_MS  = 40;

function updateSummary() {
  const s = pingStats;
  const lost = s.sent - s.received;
  const lossPct = s.sent ? Math.round((lost / s.sent) * 1000) / 10 : 0;
  const min = s.rtts.length ? Math.min.apply(null, s.rtts) : null;
  const max = s.rtts.length ? Math.max.apply(null, s.rtts) : null;
  const avg = s.rtts.length ? (s.rtts.reduce(function(a,b){ return a+b; }, 0) / s.rtts.length) : null;
  const jitterVal = (min != null && max != null) ? (max - min) : null;

  setText('diag-sent', s.sent);
  setText('diag-received', s.received);
  setText('diag-lost', lost + ' (' + lossPct + '%)');
  setText('diag-min', min != null ? min.toFixed(2) + ' ms' : '—');
  setText('diag-avg', avg != null ? avg.toFixed(2) + ' ms' : '—');
  setText('diag-max', max != null ? max.toFixed(2) + ' ms' : '—');
  setText('diag-jitter', jitterVal != null ? jitterVal.toFixed(2) + ' ms' : '—');

  const lostEl = document.getElementById('diag-stat-lost');
  if (lostEl) lostEl.className = 'diag-stat ' + (lost > 0 ? 'diag-stat-bad' : 'diag-stat-ok');

  let statusText = '—', statusCls = '';
  if (lossPct > 0) {
    statusText = 'Bermasalah'; statusCls = 'diag-stat-bad';
  } else if (jitterVal != null) {
    if (jitterVal >= JITTER_BAD_MS)       { statusText = 'Bermasalah'; statusCls = 'diag-stat-bad'; }
    else if (jitterVal >= JITTER_WARN_MS) { statusText = 'Fluktuatif'; statusCls = 'diag-stat-warn'; }
    else                                  { statusText = 'Stabil';     statusCls = 'diag-stat-ok'; }
  }
  setText('diag-status', statusText);
  const statusEl = document.getElementById('diag-stat-status');
  if (statusEl) statusEl.className = 'diag-stat ' + statusCls;
}

function setRunningButton(running) {
  const btn = document.getElementById('btn-ping');
  if (running) {
    btn.className = 'btn btn-red diag-only-ping';
    btn.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> Hentikan Ping';
  } else {
    btn.className = 'btn-primary diag-only-ping';
    btn.innerHTML = '<span class="material-symbols-outlined">network_ping</span> Mulai Ping';
  }
}

function runPing() {
  if (pingActive) {
    stopPing();
  } else {
    startPing();
  }
}

function startPing() {
  const deviceId = document.getElementById('f-device').value;
  const target   = document.getElementById('f-target').value.trim();
  const size     = document.getElementById('f-size').value || 64;

  if (!deviceId) { toast('Pilih MikroTik terlebih dahulu', 'warning'); return; }
  if (!target)   { toast('Isi target IP/domain terlebih dahulu', 'warning'); return; }

  pingActive = true;
  pingSeq    = 0;
  pingStats  = { sent: 0, received: 0, rtts: [] };

  setFormDisabled(true);
  setRunningButton(true);
  renderLiveSkeleton(target, selectedDeviceLabel(), size);

  pingLoop(deviceId, target, size);
}

function stopPing() {
  pingActive = false;
  setFormDisabled(false);
  setRunningButton(false);

  const badge = document.querySelector('.diag-live-badge');
  if (badge) badge.remove();
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/* RouterOS hanya menjaga jarak 1 detik ANTAR paket berikutnya, bukan
   sesudah balasan diterima — untuk count=1 ia langsung selesai begitu
   reply datang (bisa cuma beberapa ms untuk target dekat). Tanpa pacing
   ini, loop akan menembak request secepat round-trip API (mirip flood
   ping). Beri jeda supaya ritme ~1 paket/detik seperti terminal asli. */
const PING_INTERVAL_MS = 1000;

async function pingLoop(deviceId, target, size) {
  while (pingActive) {
    const t0 = performance.now();
    let res, data;
    try {
      res  = await _post(`${API_BASE}/api/diagnostik/ping`, { device_id: deviceId, target: target, count: 1, size: size });
      data = await res.json();
    } catch (e) {
      toast('Tidak bisa terhubung ke server.', 'danger');
      stopPing();
      break;
    }
    if (!res.ok) {
      toast(data.error || 'Ping gagal.', 'danger');
      stopPing();
      break;
    }

    pingSeq++;
    const packet = (data.packets || [])[0] || null;
    pingStats.sent++;
    if (packet) {
      pingStats.received++;
      const rtt = parseRtt(packet.time);
      if (rtt != null) pingStats.rtts.push(rtt);
    }
    appendPacketRow(pingSeq, packet);
    updateSummary();

    if (!pingActive) break;
    const elapsed = performance.now() - t0;
    await sleep(Math.max(0, PING_INTERVAL_MS - elapsed));
  }
}

/* ── Traceroute live: 1 job di background server, di-poll tiap ~1 detik ── */
let trJobId   = null;
let trPolling = false;

function setTrFormDisabled(disabled) {
  document.getElementById('f-device').disabled  = disabled;
  document.getElementById('f-target').disabled   = disabled;
  document.getElementById('f-maxhops').disabled  = disabled;
}

function setTrRunningButton(running) {
  const btn = document.getElementById('btn-traceroute');
  if (running) {
    btn.className = 'btn btn-red diag-only-traceroute';
    btn.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> Hentikan Traceroute';
  } else {
    btn.className = 'btn-primary diag-only-traceroute';
    btn.innerHTML = '<span class="material-symbols-outlined">route</span> Mulai Traceroute';
  }
}

function renderTracerouteSkeleton(target, deviceLabel, maxHops) {
  document.getElementById('traceroute-results').innerHTML = `
    <div class="form-card">
      <div class="form-card-title">
        <span class="material-symbols-outlined">route</span>
        Traceroute ke ${esc(target)}
        <span class="diag-live-badge"><span class="diag-live-dot"></span>Live</span>
        <span class="diag-target-sub">via ${esc(deviceLabel)} &middot; maks. ${esc(maxHops)} hop</span>
      </div>
      <div class="diag-table-wrap" id="tr-table-wrap">
        <table class="diag-table">
          <thead>
            <tr>
              <th>Hop</th><th class="diag-col-host">Host</th><th>Loss%</th>
              <th>Last</th><th>Avg</th><th>Best</th><th>Worst</th>
            </tr>
          </thead>
          <tbody id="tr-table-body"></tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTracerouteHops(hops) {
  const tbody = document.getElementById('tr-table-body');
  if (!tbody) return;
  tbody.innerHTML = (hops || []).map(function(row) {
    const host  = pick(row, ['address', 'host']) || row.status || '—';
    const loss  = pick(row, ['loss', 'packet-loss']);
    const last  = pick(row, ['last', 'time']);
    const avg   = pick(row, ['avg', 'avg-rtt']);
    const best  = pick(row, ['best', 'min-rtt']);
    const worst = pick(row, ['worst', 'max-rtt']);
    return '<tr>'
      + '<td class="sticky-col-1">' + esc(row.hop) + '</td>'
      + '<td class="diag-col-host">' + esc(host) + '</td>'
      + '<td>' + (loss != null ? esc(loss) + '%' : '—') + '</td>'
      + '<td>' + esc(fmtMs(last)) + '</td>'
      + '<td>' + esc(fmtMs(avg)) + '</td>'
      + '<td>' + esc(fmtMs(best)) + '</td>'
      + '<td>' + esc(fmtMs(worst)) + '</td>'
      + '</tr>';
  }).join('');
  const wrap = document.getElementById('tr-table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function removeTrLiveBadge() {
  const card = document.querySelector('#traceroute-results .diag-live-badge');
  if (card) card.remove();
}

function runTraceroute() {
  if (trPolling) {
    stopTraceroute();
  } else {
    startTraceroute();
  }
}

async function startTraceroute() {
  const deviceId = document.getElementById('f-device').value;
  const target   = document.getElementById('f-target').value.trim();
  const maxHops  = document.getElementById('f-maxhops').value || 15;

  if (!deviceId) { toast('Pilih MikroTik terlebih dahulu', 'warning'); return; }
  if (!target)   { toast('Isi target IP/domain terlebih dahulu', 'warning'); return; }

  setTrFormDisabled(true);
  setTrRunningButton(true);
  renderTracerouteSkeleton(target, selectedDeviceLabel(), maxHops);

  try {
    const res  = await _post(`${API_BASE}/api/diagnostik/traceroute/start`, { device_id: deviceId, target: target, max_hops: maxHops });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Traceroute gagal dimulai.', 'danger');
      renderEmptyIn('traceroute-results', 'error', data.error || 'Traceroute gagal dimulai.');
      setTrFormDisabled(false);
      setTrRunningButton(false);
      return;
    }
    trJobId   = data.job_id;
    trPolling = true;
    trPollLoop();
  } catch (e) {
    toast('Tidak bisa terhubung ke server.', 'danger');
    setTrFormDisabled(false);
    setTrRunningButton(false);
  }
}

async function trPollLoop() {
  while (trPolling) {
    let res, data;
    try {
      res  = await _get(`${API_BASE}/api/diagnostik/traceroute/status/${trJobId}`);
      data = await res.json();
    } catch (e) {
      toast('Tidak bisa terhubung ke server.', 'danger');
      trPolling = false;
      break;
    }
    if (!res.ok) {
      toast(data.error || 'Traceroute gagal.', 'danger');
      trPolling = false;
      break;
    }

    renderTracerouteHops(data.hops);

    if (data.status !== 'running' && data.status !== 'stopping') {
      trPolling = false;
      if (data.status === 'error') toast(data.error || 'Traceroute gagal.', 'danger');
      else if (data.status === 'timeout') toast('Traceroute melebihi batas waktu.', 'warning');
      break;
    }
    await sleep(1000);
  }
  setTrFormDisabled(false);
  setTrRunningButton(false);
  removeTrLiveBadge();
}

async function stopTraceroute() {
  trPolling = false;
  setTrFormDisabled(false);
  setTrRunningButton(false);
  removeTrLiveBadge();
  if (trJobId) {
    try { await _post(`${API_BASE}/api/diagnostik/traceroute/stop/${trJobId}`, {}); } catch (e) {}
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (!localStorage.getItem('tf_token')) {
    window.location.href = '/app/frontend/auth/auth.html';
    return;
  }
  if (typeof initDateBadge      === 'function') initDateBadge();
  if (typeof initBottomNav      === 'function') initBottomNav();
  if (typeof initDropdownHeader === 'function') initDropdownHeader();
  if (typeof applyUIPermissions === 'function') applyUIPermissions();

  loadDevices();
});
