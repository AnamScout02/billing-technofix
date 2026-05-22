/**
 * maps.js — TechnoFix · Peta Topologi Jaringan
 * ==============================================
 * Leaflet.js script untuk menampilkan node perangkat dan
 * relasi kabel topologi jaringan ISP di area Banyuwangi.
 *
 * Fitur:
 *  - Inisialisasi peta terpusat di Banyuwangi
 *  - Layer Control: OpenStreetMap vs Esri Satellite
 *  - Fetch data dari GET /api/maps/topology
 *  - Marker dinamis berbasis CSS (per tipe & status perangkat)
 *  - Warna ONU otomatis sesuai rx_power threshold
 *  - Polyline kabel berwarna sesuai status node target
 *  - Popup detail per perangkat
 *  - Statistik ringkasan (online / offline / redaman tinggi)
 *  - Tombol refresh dengan animasi spin
 *
 * Depends: Leaflet 1.9.x (CDN), global.js (toast dll.)
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   KONSTANTA KONFIGURASI
══════════════════════════════════════════════════════════ */

const MAP_CENTER     = [-8.2192, 114.3691];   // Banyuwangi kota
const MAP_ZOOM_INIT  = 11;
const API_ENDPOINT   = '/api/maps/topology';

// Ambang batas RX Power (dBm)
const RX_NORMAL_THRESH  = -20;   // > ini = hijau (normal)
const RX_WARN_THRESH    = -25;   // > ini = kuning (redaman); ≤ ini = merah (LOS)

// Warna marker per tipe
const MARKER_COLORS = {
  router: '#0040a1',
  olt:    '#7c3aed',
  odp:    '#b45309',
};

// Warna kabel
const LINK_COLOR_ONLINE  = '#22c55e';
const LINK_COLOR_OFFLINE = '#ef4444';


/* ══════════════════════════════════════════════════════════
   STATE GLOBAL
══════════════════════════════════════════════════════════ */

let map          = null;    // instance Leaflet
let markerLayer  = null;    // LayerGroup marker
let polylineLayer = null;   // LayerGroup polyline
let nodeIndex    = {};      // { id: nodeObject } untuk lookup cepat


/* ══════════════════════════════════════════════════════════
   INIT — dipanggil saat DOM siap
══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadTopology();

  // Tombol refresh di header
  const btnRefresh = document.getElementById('btn-refresh-map');
  if (btnRefresh) btnRefresh.addEventListener('click', () => loadTopology(true));
});


/* ══════════════════════════════════════════════════════════
   1. INISIALISASI PETA
══════════════════════════════════════════════════════════ */

function initMap() {
  // Buat instance Leaflet
  map = L.map('networkMap', {
    center:          MAP_CENTER,
    zoom:            MAP_ZOOM_INIT,
    zoomControl:     true,
    attributionControl: true,
  });

  // ── Layer Tiles ──────────────────────────────────────

  // Peta Jalan Raya — OpenStreetMap (selalu reliable)
  const layerOSM = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      subdomains: ['a', 'b', 'c'],
    }
  );

  // Peta Satelit — Google Maps Hybrid (jalan + label kota tetap muncul)
  // Menggunakan proxy tile publik yang kompatibel dengan Leaflet
  const layerSatellite = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    {
      attribution: 'Map data &copy; Google',
      subdomains:  ['0', '1', '2', '3'],
      maxZoom: 20,
      tileSize: 256,
    }
  );

  // Peta Satelit murni (tanpa label) — opsional sebagai layer ke-3
  const layerSatPure = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    {
      attribution: 'Map data &copy; Google',
      subdomains:  ['0', '1', '2', '3'],
      maxZoom: 20,
    }
  );

  // Default: OpenStreetMap
  layerOSM.addTo(map);

  // ── Layer Control (switch view) ──────────────────────
  const baseLayers = {
    '<span style="font-family:var(--sans);font-size:12px;font-weight:600">🗺 Peta Jalan Raya</span>':          layerOSM,
    '<span style="font-family:var(--sans);font-size:12px;font-weight:600">🛰 Satelit + Label Kota</span>':    layerSatellite,
    '<span style="font-family:var(--sans);font-size:12px;font-weight:600">🛰 Satelit Murni</span>':           layerSatPure,
  };
  L.control.layers(baseLayers, null, { position: 'topright', collapsed: false }).addTo(map);

  // ── Layer Group untuk marker & polyline ─────────────
  polylineLayer = L.layerGroup().addTo(map);
  markerLayer   = L.layerGroup().addTo(map);

  // Pindahkan zoomControl ke kanan bawah agar tidak nabrak legend
  map.zoomControl.setPosition('bottomright');
}


/* ══════════════════════════════════════════════════════════
   2. FETCH DATA TOPOLOGI
══════════════════════════════════════════════════════════ */

async function loadTopology(isRefresh = false) {
  setLoading(true);

  if (isRefresh) spinRefreshIcon(true);

  try {
    const res  = await fetch(API_ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderTopology(data.nodes || [], data.links || []);
    updateStats(data.nodes || []);
    updateLastUpdate();

    if (typeof showToast === 'function') {
      showToast('success', 'Peta berhasil diperbarui');
    }
  } catch (err) {
    console.error('[Maps] Gagal fetch topologi:', err);
    if (typeof showToast === 'function') {
      showToast('error', 'Gagal memuat data topologi. Periksa server backend.');
    }
  } finally {
    setLoading(false);
    if (isRefresh) spinRefreshIcon(false);
  }
}


/* ══════════════════════════════════════════════════════════
   3. RENDER TOPOLOGI (MARKER + POLYLINE)
══════════════════════════════════════════════════════════ */

function renderTopology(nodes, links) {
  // Bersihkan layer lama
  markerLayer.clearLayers();
  polylineLayer.clearLayers();
  nodeIndex = {};

  // Bangun index node → untuk lookup koordinat saat render link
  nodes.forEach(node => { nodeIndex[node.id] = node; });

  // Render polyline DULU agar berada di bawah marker
  links.forEach(link => renderLink(link));

  // Render marker
  nodes.forEach(node => renderMarker(node));
}


/* ──────────────────────────────────────────────────────────
   3a. RENDER MARKER
────────────────────────────────────────────────────────── */

function renderMarker(node) {
  const colorClass = getMarkerClass(node);
  const isOffline  = node.status !== 'online';

  // HTML marker (CSS-based, bukan gambar)
  const iconHtml = `
    <div class="tf-marker ${colorClass} ${isOffline ? 'tf-marker-offline' : ''}">
      <div class="tf-marker-inner"></div>
    </div>`;

  const icon = L.divIcon({
    html:        iconHtml,
    className:   '',             // kosong — kita kelola class sendiri
    iconSize:    [32, 32],
    iconAnchor:  [16, 32],       // ujung bawah marker = titik koordinat
    popupAnchor: [0, -34],
  });

  const marker = L.marker([node.lat, node.lng], { icon })
    .bindPopup(buildPopupHtml(node), {
      maxWidth:   280,
      minWidth:   220,
      className:  'tf-popup',
    });

  // Label nama di bawah marker (tooltip permanen)
  marker.bindTooltip(node.name, {
    permanent:  false,
    direction:  'top',
    offset:     [0, -34],
    className:  'tf-tooltip',
    opacity:    0.95,
  });

  markerLayer.addLayer(marker);
}


/* ──────────────────────────────────────────────────────────
   3b. RENDER POLYLINE (KABEL)
────────────────────────────────────────────────────────── */

function renderLink(link) {
  const src = nodeIndex[link.source];
  const tgt = nodeIndex[link.target];
  if (!src || !tgt) return;

  // Warna garis mengikuti status node TARGET
  const isTargetOnline = tgt.status === 'online';
  const color  = isTargetOnline ? LINK_COLOR_ONLINE : LINK_COLOR_OFFLINE;
  const weight = getLinkWeight(src.type, tgt.type);
  const dash   = isTargetOnline ? null : '8, 6';

  const polyline = L.polyline(
    [[src.lat, src.lng], [tgt.lat, tgt.lng]],
    {
      color,
      weight,
      opacity: 0.75,
      dashArray: dash,
      lineJoin: 'round',
      lineCap: 'round',
    }
  );

  // Tooltip kabel saat hover
  polyline.bindTooltip(
    `${src.name} → ${tgt.name}<br><small style="opacity:.75">${isTargetOnline ? '🟢 Online' : '🔴 Offline'}</small>`,
    { sticky: true, opacity: 0.9 }
  );

  polylineLayer.addLayer(polyline);
}


/* ══════════════════════════════════════════════════════════
   4. HELPER — WARNA & KELAS MARKER
══════════════════════════════════════════════════════════ */

/**
 * Tentukan CSS class warna marker berdasarkan tipe & rx_power.
 */
function getMarkerClass(node) {
  if (node.type === 'onu') {
    // Offline langsung → merah
    if (node.status !== 'online') return 'tf-marker-onu-crit';

    const rx = node.rx_power;
    if (rx === null || rx === undefined) return 'tf-marker-onu-crit';
    if (rx > RX_NORMAL_THRESH)  return 'tf-marker-onu-ok';
    if (rx > RX_WARN_THRESH)    return 'tf-marker-onu-warn';
    return 'tf-marker-onu-crit';
  }

  // Non-ONU: pakai warna tipe
  return `tf-marker-${node.type}`;
}

/**
 * Tebal garis kabel berdasarkan level hierarki.
 *   router→router   : 3px (backbone)
 *   router/olt→olt  : 2.5px
 *   olt→odp         : 2px
 *   odp→onu         : 1.5px
 */
function getLinkWeight(srcType, tgtType) {
  if (srcType === 'router' && tgtType === 'router') return 3;
  if (tgtType === 'olt')  return 2.5;
  if (tgtType === 'odp')  return 2;
  return 1.5;
}


/* ══════════════════════════════════════════════════════════
   5. BUILD POPUP HTML
══════════════════════════════════════════════════════════ */

/**
 * Buat konten HTML popup Leaflet berdasarkan data node.
 * Warna header popup mengikuti warna tipe perangkat.
 */
function buildPopupHtml(node) {
  const headerColor = getHeaderColor(node);
  const statusLabel = node.status === 'online' ? 'Online' : 'Offline';
  const statusDot   = node.status === 'online' ? '#4ade80' : '#fca5a5';
  const typeLabel   = node.type.toUpperCase();

  let detailRows = '';
  if (node.detail) {
    Object.entries(node.detail).forEach(([key, val]) => {
      const keyLabel = formatDetailKey(key);
      detailRows += `
        <div class="popup-row">
          <span class="key">${keyLabel}</span>
          <span class="val">${val || '—'}</span>
        </div>`;
    });
  }

  // Blok RX Power khusus ONU
  let rxBlock = '';
  if (node.type === 'onu' && node.rx_power !== null && node.rx_power !== undefined) {
    const rxClass = node.rx_power > RX_NORMAL_THRESH ? 'rx-ok'
                  : node.rx_power > RX_WARN_THRESH   ? 'rx-warn'
                  : 'rx-crit';
    const rxIcon  = node.rx_power > RX_NORMAL_THRESH  ? 'signal_cellular_alt'
                  : node.rx_power > RX_WARN_THRESH    ? 'signal_cellular_2_bar'
                  : 'signal_cellular_off';
    const rxLabel = node.rx_power > RX_NORMAL_THRESH  ? 'Normal'
                  : node.rx_power > RX_WARN_THRESH    ? 'Redaman Tinggi'
                  : 'LOS / Kritis';

    rxBlock = `
      <div class="popup-rx ${rxClass}">
        <span class="material-symbols-outlined">${rxIcon}</span>
        RX Power: <strong>${node.rx_power.toFixed(2)} dBm</strong> — ${rxLabel}
      </div>`;
  }

  return `
    <div>
      <div class="popup-header" style="background:${headerColor}">
        <div style="flex:1;min-width:0">
          <div class="popup-type-badge" style="background:rgba(255,255,255,.2)">${typeLabel}</div>
          <div class="popup-name">${escHtml(node.name)}</div>
          <div class="popup-status-row">
            <span class="popup-status-dot" style="background:${statusDot}"></span>
            ${statusLabel}
          </div>
        </div>
      </div>
      <div class="popup-body">
        ${detailRows}
        ${rxBlock}
      </div>
    </div>`;
}

function getHeaderColor(node) {
  if (node.type === 'onu') {
    if (node.status !== 'online') return '#dc2626';
    if (node.rx_power > RX_NORMAL_THRESH) return '#16a34a';
    if (node.rx_power > RX_WARN_THRESH)   return '#d97706';
    return '#dc2626';
  }
  return MARKER_COLORS[node.type] || '#0040a1';
}

function formatDetailKey(key) {
  const map = {
    ip:         'IP Address',
    model:      'Model',
    uptime:     'Uptime',
    lokasi:     'Lokasi',
    tipe:       'Tipe OLT',
    port:       'Port',
    kapasitas:  'Kapasitas',
    terisi:     'Terisi',
    profil:     'Profil',
    sn:         'Serial Number',
    vlan:       'VLAN',
    slot_port:  'Slot / Port',
    hp:         'No. HP',
  };
  return map[key] || key;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ══════════════════════════════════════════════════════════
   6. STATISTIK RINGKASAN (TOOLBAR)
══════════════════════════════════════════════════════════ */

function updateStats(nodes) {
  let online = 0, offline = 0, warning = 0;

  nodes.forEach(n => {
    if (n.status !== 'online') {
      offline++;
      return;
    }
    online++;
    // Hitung ONU dengan redaman tinggi
    if (n.type === 'onu' && n.rx_power !== null && n.rx_power !== undefined) {
      if (n.rx_power <= RX_NORMAL_THRESH) warning++;
    }
  });

  setText('stat-online',  `${online} Online`);
  setText('stat-offline', `${offline} Offline`);
  setText('stat-warning', `${warning} Redaman Tinggi`);
}

function updateLastUpdate() {
  const now = new Date();
  const fmt = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  setText('map-last-update', `Diperbarui: ${fmt}`);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}


/* ══════════════════════════════════════════════════════════
   7. UI HELPERS
══════════════════════════════════════════════════════════ */

function setLoading(isLoading) {
  const el = document.getElementById('map-loading');
  if (!el) return;
  if (isLoading) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function spinRefreshIcon(isSpin) {
  const icon = document.getElementById('map-refresh-icon');
  if (!icon) return;
  if (isSpin) {
    icon.style.animation = 'spin 1s linear infinite';
  } else {
    icon.style.animation = '';
  }
}

/* Tambahkan keyframe spin jika global.css belum punya */
(function injectSpin() {
  if (document.getElementById('tf-spin-style')) return;
  const s = document.createElement('style');
  s.id = 'tf-spin-style';
  s.textContent = `
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .tf-tooltip {
      font-family: var(--sans, sans-serif) !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      background: rgba(15,23,42,.88) !important;
      color: #fff !important;
      border: none !important;
      border-radius: 6px !important;
      padding: 4px 9px !important;
      box-shadow: 0 4px 12px rgba(0,0,0,.2) !important;
      white-space: nowrap !important;
    }
    .tf-tooltip::before { display: none !important; }
  `;
  document.head.appendChild(s);
})();