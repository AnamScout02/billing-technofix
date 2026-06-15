/**
 * maps.js — TechnoFix · Peta Topologi Jaringan
 * =============================================
 * v4.0 — MapLibre GL JS rebuild
 *
 * Stack:
 *  - MapLibre GL JS (WebGL, gratis, open source)
 *  - Tile: Esri World Imagery (satelit) +
 *          Esri Boundaries & Places (label admin, tanpa POI)
 *  - Marker: HTML div via maplibregl.Marker
 *  - Tidak ada device card, tidak ada style switcher
 *
 * Klasifikasi RX Power ONU:
 *   Bagus  🟢  -20 ≤ rx ≤ -8   → marker hijau
 *   Sedang 🟡  -26 ≤ rx < -20  → marker kuning
 *   Buruk  🔴  rx > -8 atau < -26 → marker merah
 */

'use strict';

/* ════════════════════════════════════════════════════════════
   KONSTANTA
════════════════════════════════════════════════════════════ */

const MAP_CENTER    = [-7.5, 112.5];
const MAP_ZOOM_INIT = 15;        /* ≈ 1 km view default */
const API_ENDPOINT  = '/api/maps/topology';

const RX_SAT_THRESH = -8;
const RX_WARN_OK    = -20;
const RX_BAD_LOW    = -26;

/* Palet warna terpadu — dipakai utk MARKER & KABEL (link) sekaligus,
   supaya konsisten di seluruh peta. Satu spektrum hijau→merah agar
   "makin merah = makin parah" langsung kebaca tanpa mikir, dan tetap
   kontras tajam di atas citra satelit (yang banyak nuansa coklat/hijau):
     bagus   → hijau
     sedang  → kuning
     buruk   → oranye        (redaman jelek tapi PERANGKAT MASIH ONLINE)
     offline → merah pekat / maroon (perangkat/ONU mati total — paling
               gelap & kontras, jadi langsung menonjol begitu halaman
               dibuka — prioritas utama)                              */
const QUALITY_COLORS = {
  good:    '#16a34a',   /* hijau       — redaman bagus */
  warning: '#eab308',   /* kuning      — redaman sedang */
  bad:     '#ea580c',   /* oranye      — redaman buruk (online) */
  offline: '#7f1d1d',   /* merah pekat — mati / terputus */
};

const TYPE_COLORS = {
  router: '#1d4ed8',   /* biru royal */
  olt:    '#f97316',   /* oranye terang — beda dari biru router & amber ONU warning */
  odc:    '#0891b2',   /* cyan */
  odp:    '#db2777',   /* pink/magenta — benar-benar beda dari semua warna lain */
};

const TYPE_ICONS = {
  router: 'router',
  olt:    'settings_input_antenna',
  odc:    'storage',
  odp:    'hub',
  onu:    'wifi_tethering',
};

const TYPE_LABELS = {
  router: 'Router', olt: 'OLT', odc: 'ODC', odp: 'ODP',
};

/* Ukuran SERAGAM untuk semua tipe — konsisten seperti pin Google Maps */
const MARKER_SIZE = {
  router: 26, olt: 26, odc: 26, odp: 26, onu: 26,
};

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

let map              = null;
let markers          = [];
let _clusterEls      = [];   // DOM elemen cluster bubble yang aktif
let _pendingLinkData = null;
let _currentMapStyle = 'satellite';

/* ════════════════════════════════════════════════════════════
   MAP STYLES — Satelit vs Peta Jalan
════════════════════════════════════════════════════════════ */

const MAP_STYLES = {
  satellite: {
    version: 8,
    sources: {
      'sat': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '© Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        /* Esri MENGAKU mendukung z19, tapi utk sebagian besar wilayah
           Indonesia (di luar kota besar) citra sedetail itu belum ada —
           server malah balas tile abu-abu bertuliskan "Map data not yet
           available". Deklarasikan maxzoom lebih rendah (17) supaya
           MapLibre BERHENTI meminta tile sedetail itu & otomatis
           mem-perbesar (over-zoom) tile z17 yang sudah ada utk level
           di atasnya — hasil sedikit blur, tapi placeholder tak pernah muncul. */
        maxzoom: 17,
      },
      'labels': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png',
          'https://d.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap, © CARTO',
        maxzoom: 20,
      },
    },
    layers: [
      { id: 'sat-layer',    type: 'raster', source: 'sat' },
      { id: 'labels-layer', type: 'raster', source: 'labels',
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } },
    ],
  },
  street: {
    version: 8,
    sources: {
      'osm': {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'osm-layer', type: 'raster', source: 'osm' },
    ],
  },
};

/* ════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSearch();
  loadTopology();

  document.getElementById('btn-refresh-map')
    ?.addEventListener('click', () => loadTopology(true));

  /* Klik/tap peta kosong → tutup card.
     Guard waktu 350ms: cegah event yang sama (dari tap marker) menutup card
     yang baru dibuka. Tanpa ini, di HP nyata MapLibre re-fire click pada map
     setelah touchend sehingga card langsung tertutup. */
  document.getElementById('networkMap')
    ?.addEventListener('click', (e) => {
      if (Date.now() - _cardOpenAt < 350) return;
      if (!e.target.closest('.tf-marker-outer') && !e.target.closest('.device-card') && !e.target.closest('.tf-cluster'))
        hideCard();
    });

  /* Tutup card saat orientasi berubah agar tidak stuck di mode yang salah */
  window.addEventListener('resize', function() {
    const card = document.getElementById('device-card');
    if (card && card.style.display !== 'none') hideCard();
  }, { passive: true });

  /* Mobile: panel terpadu mulai tertutup agar peta lega */
  if (window.innerWidth < 768) {
    const mlpBody = document.getElementById('mlp-body');
    const mlpChevron = document.getElementById('mlp-chevron');
    if (mlpBody) mlpBody.style.display = 'none';
    if (mlpChevron) mlpChevron.textContent = 'expand_more';
  }
});

/* ════════════════════════════════════════════════════════════
   1. INIT MAP — MapLibre GL JS
════════════════════════════════════════════════════════════ */

function initMap() {
  map = new maplibregl.Map({
    container: 'networkMap',
    style:     MAP_STYLES.satellite,   // default satelit; bisa ganti via setMapStyle()
    center:    [MAP_CENTER[1], MAP_CENTER[0]],
    zoom:      MAP_ZOOM_INIT,
    minZoom:   5,
    maxZoom:   22,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  /* Saat map selesai load — render links yang mungkin sudah menunggu */
  map.on('load', function() {
    if (_pendingLinkData) {
      _doRenderLinks(_pendingLinkData.nodes, _pendingLinkData.links);
      _pendingLinkData = null;
    }
    _applyMarkerZoomScale();
  });

  /* Marker mengecil/membesar + ONU disembunyikan saat zoom out.
     Event 'zoom' bisa beruntun jauh lebih sering dari frame render
     (terutama saat pinch di WebView) — throttle ke rAF supaya tidak
     menulis style ratusan marker berkali-kali per frame. */
  let _zoomScaleQueued = false;
  map.on('zoom', function() {
    if (_zoomScaleQueued) return;
    _zoomScaleQueued = true;
    requestAnimationFrame(function() { _zoomScaleQueued = false; _applyMarkerZoomScale(); _rebuildClusters(); });
  });

  /* Rebuild cluster setelah pan selesai (posisi layar berubah) */
  map.on('moveend', function() { _rebuildClusters(); });

  /* Pause kedip offline saat tab tidak aktif — hemat CPU walau sudah ringan */
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      if (_offlineBlinkTimer) { clearInterval(_offlineBlinkTimer); _offlineBlinkTimer = null; }
    } else {
      if (_linkGeoms.length && !_offlineBlinkTimer) _startOfflineBlink();
    }
  });
}

/* ════════════════════════════════════════════════════════════
   2. FETCH TOPOLOGI
════════════════════════════════════════════════════════════ */

async function loadTopology(isRefresh = false) {
  setLoading(true);
  if (isRefresh) spinRefreshIcon(true);

  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + API_ENDPOINT, {
      credentials: 'include',
      headers: (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${API_ENDPOINT}`);
    const data = await res.json();

    window._lastLinks = data.links || [];
    _koordinatKosong  = data.koordinat_kosong || 0;
    renderTopology(data.nodes || [], data.links || []);
    updateStats(data.nodes || []);
    updateLastUpdate();

  } catch (err) {
    console.error('[Maps]', err.message);
    if (typeof toast === 'function') toast('Gagal memuat topologi', 'danger');
  } finally {
    setLoading(false);
    spinRefreshIcon(false);
  }
}

/* ════════════════════════════════════════════════════════════
   3. RENDER MARKER
════════════════════════════════════════════════════════════ */

/* ── State untuk links ── */
let _topologyNodes = [];   // semua nodes (untuk lookup koordinat)
let _linkGeoms     = [];   // [{src:[lng,lat], tgt:[lng,lat], quality, status}]
let _offlineBlinkTimer = null; // setInterval handle — kedip kabel offline (ringan)
let _flowTimer     = null; // setInterval handle — sapuan cahaya 'data berjalan' (ringan)
let _flowPos       = 0;    // posisi sapuan 0..1 di sepanjang line-progress

function renderTopology(nodes, links) {
  /* Hapus marker lama */
  markers.forEach(function(m) { try { m.mlMarker.remove(); } catch(_) {} });
  markers = [];

  _topologyNodes = nodes;

  const valid = nodes.filter(function(n) { return n.lat != null && n.lng != null; });

  /* Buat marker satu per satu — error satu node tidak hentikan yang lain */
  valid.forEach(function(node) {
    try {
      markers.push(createMarker(node));
    } catch(e) {
      console.warn('[Maps] createMarker error for', node.id, e);
    }
  });

  /* Render garis — dipanggil terpisah, tidak terpengaruh error marker */
  _renderLinks(valid, links || []);

  applyFilter();
  updateFilterCounts();
  _applyMarkerZoomScale();   /* set ukuran awal sesuai zoom saat ini */
  _rebuildClusters();        /* kelompokkan marker yang berdekatan */

  /* Auto-fit */
  if (valid.length && map) {
    const lngs = valid.map(function(n) { return n.lng; });
    const lats = valid.map(function(n) { return n.lat; });
    map.fitBounds(
      [[Math.min.apply(null,lngs), Math.min.apply(null,lats)],
       [Math.max.apply(null,lngs), Math.max.apply(null,lats)]],
      { padding: 60, maxZoom: 15, duration: 800 }
    );
  }
}

/* ════════════════════════════════════════════════════════════
   RENDER LINKS — garis koneksi antar perangkat dengan animasi
════════════════════════════════════════════════════════════ */

const LINK_COLORS = {
  good:    QUALITY_COLORS.good,
  warning: QUALITY_COLORS.warning,
  bad:     QUALITY_COLORS.bad,
  offline: QUALITY_COLORS.offline,
};

/* Gate: cek map siap, simpan pending jika belum */
function _renderLinks(nodes, links) {
  if (!map) return;
  if (!map.loaded()) {
    _pendingLinkData = { nodes: nodes, links: links };
    return;
  }
  _doRenderLinks(nodes, links);
}

/* Actual render — dipanggil hanya saat map sudah loaded */
function _doRenderLinks(nodes, links) {
  const nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = n; });

  /* Bangun fitur garis kabel + simpan geometri untuk partikel */
  _linkGeoms = [];
  const features = links.map(function(lk) {
    const src = nodeMap[lk.source];
    const tgt = nodeMap[lk.target];
    if (!src || !tgt) return null;
    const quality = lk.quality || 'good';
    const status  = lk.status  || 'online';
    _linkGeoms.push({ src: [src.lng, src.lat], tgt: [tgt.lng, tgt.lat], quality: quality, status: status });
    return {
      type: 'Feature',
      properties: { quality: quality, status: status },
      geometry: { type: 'LineString', coordinates: [[src.lng, src.lat], [tgt.lng, tgt.lat]] },
    };
  }).filter(Boolean);

  const geojson = { type: 'FeatureCollection', features };
  console.log('[Links]', features.length, 'garis dari', links.length, 'relasi');

  /* Update source yang sudah ada */
  if (map.getSource('topo-links')) {
    map.getSource('topo-links').setData(geojson);
    _startOfflineBlink();
    _startFlowAnimation();
    return;
  }

  const colorExpr = [
    'match', ['get', 'quality'],
    'good', LINK_COLORS.good, 'warning', LINK_COLORS.warning, 'bad', LINK_COLORS.bad,
    '#94a3b8',
  ];
  const widthBase = ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4.5, 18, 7];

  /* ── Source garis kabel ──
     lineMetrics:true wajib utk paint property 'line-gradient' (sapuan cahaya) */
  map.addSource('topo-links', { type: 'geojson', data: geojson, lineMetrics: true });

  /* Filter "bukan offline" — dipakai di GLOW/CASING/BASE supaya kabel
     terputus TIDAK ikut dirender lewat layer-layer ini (yang sumber
     warnanya dari 'quality', bisa jadi oranye/kuning & berhalo/nyala).
     Kabel offline dirender KHUSUS oleh layer 'links-offline' di bawah
     (putus-putus, merah pekat, berkedip) — tanpa glow / efek menyala,
     supaya kelihatan jelas "mati total", bukan "masih nyala". */
  const NOT_OFFLINE = ['!=', ['get', 'status'], 'offline'];

  /* GLOW halo */
  map.addLayer({ id: 'links-glow', type: 'line', source: 'topo-links',
    filter: NOT_OFFLINE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colorExpr, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 14, 13, 18, 20], 'line-opacity': 0.16, 'line-blur': 5 } });
  /* CASING gelap */
  map.addLayer({ id: 'links-casing', type: 'line', source: 'topo-links',
    filter: NOT_OFFLINE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': 'rgba(15,23,42,.5)', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 14, 7, 18, 10], 'line-opacity': 0.85 } });
  /* BASE garis warna utama */
  map.addLayer({ id: 'links-base', type: 'line', source: 'topo-links',
    filter: NOT_OFFLINE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colorExpr, 'line-width': widthBase, 'line-opacity': 0.55 } });
  /* SAPUAN cahaya 'data berjalan' — hanya kabel ONLINE, di atas BASE.
     Warna seragam putih-kebiruan agar kontras di atas garis hijau/
     kuning/merah manapun (kesan pulsa cahaya di serat optik).
     Digerakkan oleh _startFlowAnimation via setPaintProperty saja —
     TIDAK ada setData/rebuild geometri, sangat ringan (lihat di bawah). */
  map.addLayer({ id: 'links-flow', type: 'line', source: 'topo-links',
    filter: ['==', ['get', 'status'], 'online'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4.5, 18, 7],
      'line-gradient': _flowGradientExpr(0),
      'line-opacity': 0.85,
      'line-blur': 0.6,
    } });
  /* OFFLINE garis putus-putus, berkedip pelan (lihat _startOfflineBlink).
     Layer ini ditambahkan PALING TERAKHIR → digambar PALING ATAS dari
     semua layer kabel lain, jadi kabel terputus selalu terlihat duluan
     ("merah pekat") begitu halaman peta dibuka — sesuai prioritas yang
     diminta: perangkat & kabel offline harus paling menonjol. */
  map.addLayer({ id: 'links-offline', type: 'line', source: 'topo-links',
    filter: ['==', ['get', 'status'], 'offline'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': LINK_COLORS.offline, 'line-width': widthBase, 'line-dasharray': [1.5, 2], 'line-opacity': 0.95 } });

  _startOfflineBlink();
  _startFlowAnimation();
}

/* Warna sapuan — putih kebiruan terang (transparan di kedua ujung) */
const FLOW_GLOW_COLOR  = 'rgba(226,242,255,0.95)';
const FLOW_TRANSPARENT = 'rgba(226,242,255,0)';

/* Ekspresi line-gradient: segmen cahaya selebar ~18% panjang garis,
   pusatnya di posisi 'pos' (0..1) sepanjang line-progress. Stop WAJIB
   naik ketat menurut MapLibre → di-clamp & diberi jarak EPS minimal
   supaya tidak pernah error walau 'pos' mepet ke 0 atau 1. */
function _flowGradientExpr(pos) {
  const EPS = 0.0008, HALF = 0.09;
  const s1 = Math.max(EPS,        Math.min(1 - 3 * EPS, pos - HALF));
  const s2 = Math.max(s1 + EPS,   Math.min(1 - 2 * EPS, pos));
  const s3 = Math.max(s2 + EPS,   Math.min(1 - EPS,     pos + HALF));
  return [
    'interpolate', ['linear'], ['line-progress'],
    0,  FLOW_TRANSPARENT,
    s1, FLOW_TRANSPARENT,
    s2, FLOW_GLOW_COLOR,
    s3, FLOW_TRANSPARENT,
    1,  FLOW_TRANSPARENT,
  ];
}

/* Animasi 'data berjalan' — geser posisi sapuan cahaya tiap ~90ms via
   setPaintProperty('line-gradient', ...) SAJA. Tidak ada setData atau
   rebuild geometri sama sekali (beda total dari sistem komet lama yang
   memanggil setData() 60x/detik) — GPU MapLibre yang menginterpolasi
   gradiennya, jadi tetap terlihat mengalir mulus walau update ringan. */
function _startFlowAnimation() {
  if (_flowTimer) { clearInterval(_flowTimer); _flowTimer = null; }
  if (!map || !map.getLayer('links-flow')) return;
  _flowPos = 0;
  _flowTimer = setInterval(function() {
    if (!map || !map.getLayer('links-flow')) { clearInterval(_flowTimer); _flowTimer = null; return; }
    _flowPos += 0.028;
    if (_flowPos > 1) _flowPos = 0;
    try { map.setPaintProperty('links-flow', 'line-gradient', _flowGradientExpr(_flowPos)); } catch(_) {}
  }, 90);
}

/* Kedip CEPAT untuk kabel OFFLINE — penanda darurat yang harus langsung
   menarik perhatian ("putus, bukan sekadar redup"). Toggle opacity tiap
   ~280ms (± 3.6x/detik), transisi dipersingkat juga supaya kedipnya
   terasa "tegas/cepat", bukan pelan berdenyut lambat. */
function _startOfflineBlink() {
  if (_offlineBlinkTimer) { clearInterval(_offlineBlinkTimer); _offlineBlinkTimer = null; }
  if (!map || !map.getLayer('links-offline')) return;
  try { map.setPaintProperty('links-offline', 'line-opacity-transition', { duration: 120 }); } catch(_) {}
  let dim = false;
  _offlineBlinkTimer = setInterval(function() {
    if (!map || !map.getLayer('links-offline')) { clearInterval(_offlineBlinkTimer); _offlineBlinkTimer = null; return; }
    dim = !dim;
    try { map.setPaintProperty('links-offline', 'line-opacity', dim ? 0.30 : 1); } catch(_) {}
  }, 280);
}

function createMarker(node) {
  const color = getMarkerColor(node);
  const size  = MARKER_SIZE[node.type] || 32;
  const icon  = TYPE_ICONS[node.type] || 'device_unknown';

  /* ═══════════════════════════════════════════════════════════
     ARSITEKTUR DUA-LAPIS MURNI — anti-konflik 100%:

       el  (LUAR) → MILIK MapLibre. MapLibre menulis:
                      el.style.transform = translate(-50%,-50%) translate(x,y)
                      el.style.position  = absolute
                    SAYA TIDAK PERNAH menyentuh transform/position/
                    width/height el setelah dibuat. Ukuran el TETAP.

       vis (DALAM)→ MILIK SAYA. Saya menulis vis.style.transform =
                    scale(f) untuk zoom. transform-origin:center →
                    membesar/mengecil dari titik tengah = titik el =
                    koordinat GPS. POSISI TIDAK PERNAH BERGESER.

     Karena el dan vis adalah elemen BERBEDA, transform MapLibre (el)
     dan transform saya (vis) tidak akan pernah saling menimpa.
  ═══════════════════════════════════════════════════════════════ */
  const el = document.createElement('div');
  el.className = 'tf-marker-outer';
  el.dataset.mtype   = node.type;
  el.dataset.mstatus = node.status;
  /* el: kotak fix base size, hanya container posisi — transparan */
  el.style.cssText = [
    `width:${size}px`, `height:${size}px`,
    'display:flex', 'align-items:center', 'justify-content:center',
    'cursor:pointer',
  ].join(';');

  /* PRIORITAS TAMPILAN: marker OFFLINE digambar di atas marker ONLINE
     yang bertumpukan, supaya perangkat yang terputus langsung kelihatan
     begitu halaman peta dibuka (bukan tertutup marker lain yang sehat). */
  const _baseZ = node.status !== 'online' ? '6' : '1';
  el.style.zIndex = _baseZ;

  const vis = document.createElement('div');
  vis.className = 'tf-marker';
  vis.style.cssText = [
    `width:${size}px`, `height:${size}px`,
    `background:${color}`,
    'border-radius:50%',
    'border:2.5px solid rgba(255,255,255,.92)',
    'box-shadow:0 2px 10px rgba(0,0,0,.40)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'transform-origin:center center',
    'transition:filter .12s',
  ].join(';');
  el.appendChild(vis);

  const ic = document.createElement('span');
  ic.className = 'material-symbols-outlined';
  ic.style.cssText = `font-size:${Math.round(size * .52)}px;color:#fff;user-select:none;line-height:1;pointer-events:none;`;
  ic.textContent = icon;
  vis.appendChild(ic);

  /* Animasi ring — ONU dan infrastruktur offline */
  if (node.status === 'online') {
    /* Online: ring melebar keluar tipis (warna sesuai tipe/kualitas) */
    const pulse = document.createElement('div');
    pulse.style.cssText = [
      'position:absolute', 'inset:-6px', 'border-radius:50%',
      `border:2px solid ${color}`,
      'animation:tfPulse 2.4s ease-out infinite',
      'pointer-events:none',
    ].join(';');
    vis.appendChild(pulse);
  } else {
    /* Offline (semua tipe): 2 ring merah bergantian + marker kedip-kedip */
    const ring1 = document.createElement('div');
    ring1.style.cssText = [
      'position:absolute', 'inset:-7px', 'border-radius:50%',
      'border:3px solid #dc2626',
      'animation:tfOffPulse1 1.1s ease-out infinite',
      'pointer-events:none',
    ].join(';');
    const ring2 = document.createElement('div');
    ring2.style.cssText = [
      'position:absolute', 'inset:-14px', 'border-radius:50%',
      'border:2px solid #dc2626',
      'animation:tfOffPulse2 1.1s ease-out infinite',
      'pointer-events:none', 'opacity:0',
    ].join(';');
    vis.appendChild(ring1);
    vis.appendChild(ring2);
    vis.style.animation = 'tfOffBlink 1.1s ease-in-out infinite';
  }

  /* Hover: brightness pada vis (BUKAN el) */
  el.addEventListener('mouseenter', function() {
    vis.style.filter = 'brightness(1.18) drop-shadow(0 3px 10px rgba(0,0,0,.55))';
    el.style.zIndex = '10';
  });
  el.addEventListener('mouseleave', function() {
    vis.style.filter = '';
    el.style.zIndex = _baseZ;
  });

  /* Tangani click DAN touchend untuk mobile nyata.
     stopImmediatePropagation mencegah MapLibre memproses event lebih lanjut. */
  el.addEventListener('click', function(e) {
    e.stopPropagation();
    e.stopImmediatePropagation();
    showCard(node);
  });
  el.addEventListener('touchend', function(e) {
    e.stopPropagation();
    e.preventDefault();          /* cegah synthetic click dari touchend */
    showCard(node);
  }, { passive: false });

  const popup = new maplibregl.Popup({
    closeButton: false, closeOnClick: false,
    offset: [0, -(Math.round(size / 2) + 4)],
    className: 'tf-tooltip-popup',
  }).setText(node.name);
  el.addEventListener('mouseenter', function() { popup.addTo(map); });
  el.addEventListener('mouseleave', function() { popup.remove(); });

  const mlMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([node.lng, node.lat])
    .addTo(map);

  /* Simpan vis untuk scaling zoom */
  return { mlMarker, el, vis, node };
}

/* Semua marker disembunyikan di bawah zoom ini */
const ALL_HIDE_ZOOM = 10;

/* ── Resize marker + sembunyikan semua marker saat zoom out ── */
function _applyMarkerZoomScale() {
  if (!map || !markers.length) return;
  const z = map.getZoom();
  const hideAll = z < ALL_HIDE_ZOOM;

  let f, op;
  if (z <= 9)        { f = 0.35; op = 0.45; }
  else if (z >= 17)  { f = 1.30; op = 1; }
  else {
    const t = (z - 9) / (17 - 9);
    f = 0.35 + (1.30 - 0.35) * t;
    op = z < 11 ? 0.45 + (1 - 0.45) * ((z - 9) / 2) : 1;
  }
  const sf = 'scale(' + f.toFixed(3) + ')';

  const onuHint = document.getElementById('fc-onu-zoom-hint');
  if (onuHint) onuHint.style.display = hideAll ? '' : 'none';

  markers.forEach(function(m) {
    if (!m.vis) return;
    if (hideAll) { m.el.style.display = 'none'; return; }
    m.el.style.display    = '';
    m.vis.style.transform = sf;
    m.vis.style.opacity   = op;
  });
}

/* Expose untuk applyFilter agar sinkron dengan zoom state */
function _isHiddenByZoom() {
  return map ? map.getZoom() < ALL_HIDE_ZOOM : false;
}

/* ── CLUSTERING ──────────────────────────────────────────────
   Zoom < CLUSTER_ZOOM → kelompokkan marker yang saling berdekatan
   di layar (< CLUSTER_PX pixel) menjadi satu bubble count.
   Zoom >= CLUSTER_ZOOM → tampilkan marker individual biasa.
──────────────────────────────────────────────────────────────── */
const CLUSTER_ZOOM = 13;
const CLUSTER_PX   = 56;   // jarak layar (px) untuk dianggap 1 cluster

function _clearClusters() {
  _clusterEls.forEach(function(el) { el.remove(); });
  _clusterEls = [];
}

function _rebuildClusters() {
  _clearClusters();
  if (!map) return;

  const z = map.getZoom();
  const mapContainer = map.getContainer();

  /* Di zoom tinggi — tampilkan semua marker normal, hapus cluster */
  if (z >= CLUSTER_ZOOM) {
    markers.forEach(function(m) {
      if (m.el.style.visibility !== 'hidden') m.el.style.opacity = '';
    });
    return;
  }

  /* Kumpulkan marker yang visible saat ini */
  const visible = markers.filter(function(m) {
    return m.el.style.display !== 'none' && m.el.style.visibility !== 'hidden';
  });

  if (visible.length === 0) return;

  /* Hitung posisi layar setiap marker */
  const pts = visible.map(function(m) {
    const p = map.project([m.node.lng, m.node.lat]);
    return { x: p.x, y: p.y, m: m, used: false };
  });

  /* Greedy clustering: ambil titik pertama yang belum dipakai,
     cari semua titik dalam radius CLUSTER_PX */
  var groups = [];
  pts.forEach(function(pt) {
    if (pt.used) return;
    var group = [pt];
    pt.used = true;
    pts.forEach(function(other) {
      if (other.used) return;
      var dx = pt.x - other.x, dy = pt.y - other.y;
      if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_PX) {
        group.push(other);
        other.used = true;
      }
    });
    groups.push(group);
  });

  groups.forEach(function(group) {
    /* Individu — biarkan marker normal */
    if (group.length === 1) {
      group[0].m.el.style.opacity = '';
      return;
    }

    /* Kelompok → sembunyikan marker individual, tampilkan 1 cluster bubble */
    group.forEach(function(pt) { pt.m.el.style.opacity = '0'; });

    /* Hitung centroid posisi layar */
    var cx = group.reduce(function(s, p) { return s + p.x; }, 0) / group.length;
    var cy = group.reduce(function(s, p) { return s + p.y; }, 0) / group.length;

    /* Hitung berapa offline */
    var offCount = group.filter(function(p) { return p.m.node.status !== 'online'; }).length;
    var total    = group.length;
    var hasOff   = offCount > 0;

    /* Buat cluster DOM */
    var clEl = document.createElement('div');
    clEl.className = 'tf-cluster' + (hasOff ? ' tf-cluster-warn' : '');
    clEl.style.cssText = [
      'position:absolute',
      'left:' + Math.round(cx) + 'px',
      'top:'  + Math.round(cy) + 'px',
      'transform:translate(-50%,-50%)',
      'z-index:20',
      'pointer-events:all',
      'cursor:pointer',
    ].join(';');

    var inner = document.createElement('div');
    inner.className = 'tf-cluster-inner';
    inner.innerHTML = '<span class="tf-cluster-count">' + total + '</span>'
      + (hasOff ? '<span class="tf-cluster-warn-dot"></span>' : '');
    clEl.appendChild(inner);

    /* Klik cluster → zoom + pan ke bounding box semua node dalam cluster */
    clEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (group.length < 2) return;
      var lngs = group.map(function(p) { return p.m.node.lng; });
      var lats = group.map(function(p) { return p.m.node.lat; });
      map.fitBounds(
        [[Math.min.apply(null, lngs), Math.min.apply(null, lats)],
         [Math.max.apply(null, lngs), Math.max.apply(null, lats)]],
        { padding: 80, maxZoom: CLUSTER_ZOOM + 1, duration: 500 }
      );
    });

    /* Tambahkan ke overlay container MapLibre */
    var pane = mapContainer.querySelector('.maplibregl-marker');
    var parent = pane ? pane.parentElement : mapContainer;
    parent.appendChild(clEl);
    _clusterEls.push(clEl);
  });
}

/* ── Filter panel ── */
function applyFilter() {
  const fType = {
    router: document.getElementById('f-router')?.checked ?? true,
    olt:    document.getElementById('f-olt')?.checked    ?? true,
    odc:    document.getElementById('f-odc')?.checked    ?? true,
    odp:    document.getElementById('f-odp')?.checked    ?? true,
    onu:    document.getElementById('f-onu')?.checked    ?? true,
  };
  const fOnline  = document.getElementById('f-online')?.checked  ?? true;
  const fOffline = document.getElementById('f-offline')?.checked ?? true;

  const hideAll = _isHiddenByZoom();
  markers.forEach(function({ el, node }) {
    if (hideAll) { el.style.display = 'none'; return; }
    const typeOk   = fType[node.type] !== false;
    const statusOk = node.status === 'online' ? fOnline : fOffline;
    const show     = typeOk && statusOk;
    el.style.display    = '';
    el.style.visibility = show ? '' : 'hidden';
  });
}

function updateFilterCounts() {
  const counts = { router: 0, olt: 0, odc: 0, odp: 0, onu: 0 };
  markers.forEach(function({ node }) { if (counts[node.type] !== undefined) counts[node.type]++; });
  Object.keys(counts).forEach(function(t) {
    const el = document.getElementById('fc-' + t);
    if (el) el.textContent = counts[t];
  });
}

function toggleMLP() {
  const body    = document.getElementById('mlp-body');
  const chevron = document.getElementById('mlp-chevron');
  if (!body || !chevron) return;
  const isOpen = body.style.display !== 'none';
  body.style.display  = isOpen ? 'none' : '';
  chevron.textContent = isOpen ? 'expand_more' : 'expand_less';
}

function switchMLPTab(tab) {
  document.getElementById('mlp-pane-filter').style.display  = tab === 'filter'  ? '' : 'none';
  document.getElementById('mlp-pane-legenda').style.display = tab === 'legenda' ? '' : 'none';
  document.getElementById('mlp-tab-filter').classList.toggle('mlp-tab-active',  tab === 'filter');
  document.getElementById('mlp-tab-legenda').classList.toggle('mlp-tab-active', tab === 'legenda');
}

/* ════════════════════════════════════════════════════════════
   4. HELPERS
════════════════════════════════════════════════════════════ */

function classifyRx(rx) {
  if (rx === null || rx === undefined) return 'crit';
  if (rx > RX_SAT_THRESH) return 'crit';
  if (rx >= RX_WARN_OK)   return 'ok';
  if (rx >= RX_BAD_LOW)   return 'warn';
  return 'crit';
}

function getMarkerColor(node) {
  if (node.type === 'onu') {
    /* Offline ONU → merah pekat (paling kontras, prioritas utama) */
    if (node.status !== 'online') return QUALITY_COLORS.offline;
    /* Online, belum ada data redaman → abu biru (belum sync) */
    const rx = node.rx_power;
    if (rx === null || rx === undefined) return '#64748b';
    /* Online + redaman → hijau (bagus) / kuning (sedang) / oranye (buruk) */
    const c = classifyRx(rx);
    return c === 'ok' ? QUALITY_COLORS.good : c === 'warn' ? QUALITY_COLORS.warning : QUALITY_COLORS.bad;
  }
  /* Infrastruktur offline → merah pekat (sama dengan ONU offline) */
  if (node.status !== 'online') return QUALITY_COLORS.offline;
  return TYPE_COLORS[node.type] || '#0040a1';
}

var _koordinatKosong = 0;

function updateStats(nodes) {
  let online = 0, offline = 0, warning = 0;
  nodes.forEach(n => {
    if (n.status !== 'online') { offline++; return; }
    online++;
    if (n.type === 'onu' && n.rx_power != null && classifyRx(n.rx_power) !== 'ok')
      warning++;
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-online',  online  + ' Online');
  set('stat-offline', offline + ' Offline');
  set('stat-warning', warning + ' Redaman');
}

function updateLastUpdate() {
  const el = document.getElementById('map-last-update');
  if (el) el.textContent = 'Update ' + new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function setLoading(v) {
  document.getElementById('map-loading')?.classList.toggle('hidden', !v);
}

function spinRefreshIcon(on) {
  const ic = document.getElementById('map-refresh-icon');
  if (ic) ic.style.animation = on ? 'spin .7s linear infinite' : '';
}

/* ════════════════════════════════════════════════════════════
   5. SEARCH PERANGKAT
════════════════════════════════════════════════════════════ */

function initSearch() {
  const input   = document.getElementById('map-search-input');
  const results = document.getElementById('map-search-results');
  const clear   = document.getElementById('map-search-clear');
  if (!input) return;

  input.addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    if (clear) clear.style.display = q ? '' : 'none';
    if (!q) { results.style.display = 'none'; return; }
    renderSearchResults(q);
  });

  input.addEventListener('focus', function() {
    const q = this.value.trim().toLowerCase();
    if (q) renderSearchResults(q);
  });

  /* Tutup dropdown klik di luar */
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#map-search')) {
      if (results) results.style.display = 'none';
    }
  }, true);
}

function renderSearchResults(q) {
  const results = document.getElementById('map-search-results');
  if (!results) return;

  const matched = markers
    .filter(function(m) {
      const n = m.node;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.detail && n.detail.username && n.detail.username.toLowerCase().includes(q)) ||
        (n.detail && n.detail.ip && n.detail.ip.toLowerCase().includes(q))
      );
    })
    .slice(0, 10);

  if (!matched.length) {
    results.innerHTML = '<div class="map-search-empty">Tidak ada perangkat yang cocok</div>';
    results.style.display = '';
    return;
  }

  results.innerHTML = matched.map(function(m) {
    const n      = m.node;
    const color  = n.type === 'onu' ? getMarkerColor(n) : (TYPE_COLORS[n.type] || '#0040a1');
    const icon   = TYPE_ICONS[n.type] || 'device_unknown';
    const label  = n.type === 'onu' ? 'Pelanggan' : (TYPE_LABELS[n.type] || n.type.toUpperCase());
    const stCls  = n.status === 'online' ? 'msi-online' : 'msi-offline';
    const stTxt  = n.status === 'online' ? '● Online' : '○ Offline';
    return (
      '<div class="map-search-item" onclick="searchFlyTo(\'' + n.id + '\')">' +
        '<div class="msi-icon" style="background:' + color + '22">' +
          '<span class="material-symbols-outlined" style="color:' + color + '">' + icon + '</span>' +
        '</div>' +
        '<div class="msi-info">' +
          '<div class="msi-name">' + escHtml(n.name) + '</div>' +
          '<div class="msi-sub">' + label + ' &nbsp;·&nbsp; <span class="' + stCls + '">' + stTxt + '</span></div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
  results.style.display = '';
}

function searchFlyTo(nodeId) {
  const found = markers.find(function(m) { return m.node.id === nodeId; });
  if (!found || !map) return;

  /* Tutup search */
  clearSearch();

  const n = found.node;
  map.flyTo({ center: [n.lng, n.lat], zoom: 17, duration: 900, essential: true });

  /* Tampilkan card setelah animasi fly selesai */
  setTimeout(function() { showCard(n); }, 700);
}

function clearSearch() {
  const input   = document.getElementById('map-search-input');
  const results = document.getElementById('map-search-results');
  const clear   = document.getElementById('map-search-clear');
  if (input)   input.value = '';
  if (results) results.style.display = 'none';
  if (clear)   clear.style.display = 'none';
}

/* ════════════════════════════════════════════════════════════
   6. DEVICE DETAIL CARD
════════════════════════════════════════════════════════════ */

let _cardOpenAt = 0;   // timestamp showCard terakhir — juga diakses backdrop inline
window._cardOpenAt = 0;

function showCard(node) {
  const card     = document.getElementById('device-card');
  const backdrop = document.getElementById('device-card-backdrop');
  if (!card) return;

  _cardOpenAt = window._cardOpenAt = Date.now();

  /* Reset animasi CSS */
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';

  /* Banner membawa accent — tidak perlu border accent lagi */
  card.style.borderLeft = 'none';
  card.style.borderTop  = 'none';

  const isMobile = window.innerWidth < 768;
  card.innerHTML = node.type === 'onu' ? _buildOnuCard(node) : _buildDeviceCard(node);
  card.style.display = '';

  if (typeof applyFeatureLocks === 'function') applyFeatureLocks();

  /* Backdrop mobile: non-interaktif selama 300ms setelah muncul
     agar event tap yang sama tidak langsung menutup card. */
  if (backdrop) {
    if (isMobile) {
      backdrop.classList.add('active');
      backdrop.style.pointerEvents = 'none';
      setTimeout(function() { backdrop.style.pointerEvents = ''; }, 300);
    } else {
      backdrop.classList.remove('active');
    }
  }
}

function hideCard() {
  const card     = document.getElementById('device-card');
  const backdrop = document.getElementById('device-card-backdrop');
  if (card)     card.style.display = 'none';
  if (backdrop) backdrop.classList.remove('active');
}

/* Helper: banner header premium dengan gradient accent */
function _cardBanner(accent, icon, typeLabel, name, isOnline, subInfo, ipLine) {
  const stTxt = isOnline ? 'Online' : 'Offline';
  const stCls = isOnline ? 'dcx-st-online' : 'dcx-st-offline';
  const bs    = window.innerWidth < 768 ? '<div class="bs-handle bs-handle-light"></div>' : '';
  return '' +
    '<div class="dcx-banner" style="--accent:' + accent + '">' +
      bs +
      '<button class="dcx-close" onclick="hideCard()"><span class="material-symbols-outlined">close</span></button>' +
      '<div class="dcx-banner-row">' +
        '<div class="dcx-icon"><span class="material-symbols-outlined">' + icon + '</span></div>' +
        '<div class="dcx-titles">' +
          '<span class="dcx-type">' + typeLabel + '</span>' +
          '<div class="dcx-name">' + escHtml(name) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="dcx-status-pill ' + stCls + '">' +
        '<span class="dcx-st-dot"></span>' + stTxt +
        (subInfo ? '<span class="dcx-st-sub">' + subInfo + '</span>' : '') +
      '</div>' +
      (ipLine ? '<div class="dcx-foot"><span class="dcx-foot-l"><span class="material-symbols-outlined">lan</span>' + escHtml(ipLine) + '</span></div>' : '') +
    '</div>';
}

/* Helper: baris info dengan ikon */
function _cardRow(icon, key, val) {
  return '<div class="dcx-row">' +
    '<span class="material-symbols-outlined dcx-row-ic">' + icon + '</span>' +
    '<span class="dcx-row-key">' + key + '</span>' +
    '<span class="dcx-row-val">' + val + '</span>' +
  '</div>';
}


/* ── Card ONU (pelanggan) — sesuai desain referensi:
   semua info di dalam banner berwarna (RX besar di kanan,
   serial + info di bawah), tombol di area putih bawah. ── */
function _buildOnuCard(node) {
  const isOnline   = node.status === 'online';
  const rx         = node.rx_power;
  const d          = node.detail || {};
  const slot       = d.slot_port ? escHtml(d.slot_port) : '';
  const rawHp      = (d.hp || '').replace(/\D/g, '');
  const waNum      = rawHp ? '62' + (rawHp.startsWith('0') ? rawHp.slice(1) : rawHp) : '';
  const accent = getMarkerColor(node);
  const stCls  = isOnline ? 'dcx-st-online' : 'dcx-st-offline';
  const bs     = window.innerWidth < 768 ? '<div class="bs-handle bs-handle-light"></div>' : '';

  /* Baris bawah banner */
  const sn    = d.sn ? escHtml(d.sn) : '';
  const ip    = d.ip ? escHtml(d.ip) : '';
  const footL = sn ? '<span class="dcx-foot-l"><span class="material-symbols-outlined">qr_code_2</span>' + sn + '</span>' : '';
  const footR = ip ? '<span class="dcx-foot-r"><span class="material-symbols-outlined">lan</span>' + ip + '</span>' : '';

  const waBtn = waNum
    ? '<button class="dcx-btn dcx-btn-green" onclick="window.open(\'https://wa.me/' + waNum + '\',\'_blank\')">' +
        '<span class="material-symbols-outlined">chat</span>Hubungi</button>'
    : '<button class="dcx-btn dcx-btn-green" onclick="mapActionToast(\'Nomor HP tidak tersedia\')">' +
        '<span class="material-symbols-outlined">call</span>Hubungi</button>';

  const lat = node.lat, lng = node.lng;
  const ruteBtn = '<button class="dcx-btn dcx-btn-navy" onclick="window.open(\'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '\',\'_blank\')">' +
    '<span class="material-symbols-outlined">directions</span>Rute</button>';

  /* Kolektor: hanya tombol Hubungi & Rute (tanpa Reboot/Remote) */
  const isKolektor = (localStorage.getItem('tf_role') || '') === 'kolektor';
  const actionBtns = isKolektor ? (waBtn + ruteBtn) : (waBtn + ruteBtn +
    '<button class="dcx-btn dcx-btn-purple" onclick="mapRebootModem(' + d.pelanggan_id + ',\'' + escHtml(d.username) + '\')">' +
      '<span class="material-symbols-outlined">restart_alt</span>Reboot</button>' +
    '<button class="dcx-btn dcx-btn-navy" data-feature-lock="remote_modem" onclick="mapRemoteModem(' + d.pelanggan_id + ',\'' + escHtml(d.username) + '\')">' +
      '<span class="material-symbols-outlined">terminal</span>Remote</button>');

  return '<div class="dcx dcx-onu">' +
    '<div class="dcx-banner" style="--accent:' + accent + '">' +
      bs +
      '<button class="dcx-close" onclick="hideCard()"><span class="material-symbols-outlined">close</span></button>' +
      '<div class="dcx-banner-row">' +
        '<div class="dcx-icon"><span class="material-symbols-outlined">wifi_tethering</span></div>' +
        '<div class="dcx-titles">' +
          '<span class="dcx-type">ONU · PELANGGAN</span>' +
          '<div class="dcx-name">' + escHtml(node.name) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="dcx-mid">' +
        '<span class="dcx-status-pill ' + stCls + '">' +
          '<span class="dcx-st-dot"></span>' + (isOnline ? 'Online' : 'Offline') +
          (slot ? '<span class="dcx-st-sub">' + slot + '</span>' : '') +
        '</span>' +
        '<div class="dcx-rxbig">' + (isOnline && rx != null ? rx.toFixed(1) : '—') + '<small>dBm</small></div>' +
      '</div>' +
      ((footL || footR) ? '<div class="dcx-foot">' + footL + footR + '</div>' : '') +
    '</div>' +
    '<div class="dcx-actions">' + actionBtns + '</div>' +
  '</div>';
}


/* ── Card infrastruktur (Router/OLT/ODC/ODP) — Premium ── */
function _buildDeviceCard(node) {
  if (node.type === 'router') return _buildRouterCard(node);
  if (node.type === 'olt')    return _buildOltCard(node);
  if (node.type === 'odc')    return _buildOdcCard(node);
  if (node.type === 'odp')    return _buildOdpCard(node);

  const accent   = TYPE_COLORS[node.type] || '#0040a1';
  const isOnline = node.status === 'online';
  const d        = node.detail || {};

  const KEY_MAP = {
    ip: ['lan', 'IP Address'], lokasi: ['place', 'Lokasi'], tipe: ['memory', 'Tipe'],
    jumlah_port: ['settings_ethernet', 'Jumlah Port'], port_terpakai: ['cable', 'Port Terpakai'],
  };
  const SHOW = ['ip', 'lokasi', 'tipe', 'jumlah_port', 'port_terpakai'];

  const rows = SHOW
    .filter(function(k) { return d[k] || d[k] === 0; })
    .map(function(k) {
      const meta = KEY_MAP[k] || ['info', k];
      return _cardRow(meta[0], meta[1], escHtml(String(d[k])));
    }).join('');

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS[node.type] || 'device_unknown',
                (TYPE_LABELS[node.type] || node.type).toUpperCase(), node.name, isOnline, '', '') +
    '<div class="dcx-body">' +
      (rows
        ? '<div class="dcx-rows">' + rows + '</div>'
        : '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Tidak ada detail tersedia</div>') +
    '</div>' +
  '</div>';
}

function _statChip(icon, label, value, color) {
  return '<div class="dcx-stat-chip" style="--chip-color:' + (color || 'var(--primary)') + '">' +
    '<span class="material-symbols-outlined">' + icon + '</span>' +
    '<div class="dcx-stat-val">' + escHtml(String(value)) + '</div>' +
    '<div class="dcx-stat-lbl">' + label + '</div>' +
  '</div>';
}

function _buildRouterCard(node) {
  const accent   = TYPE_COLORS['router'] || '#0040a1';
  const isOnline = node.status === 'online';
  const d        = node.detail || {};

  /* OLT downstream dari topologi (lebih akurat dari d.olt_names) */
  let oltLinks = [];
  if (window._lastLinks) {
    oltLinks = window._lastLinks
      .filter(function(lk) { return lk.source === node.id; })
      .map(function(lk) {
        const tgt = _topologyNodes.find(function(n) { return n.id === lk.target; });
        return tgt ? { name: tgt.name, label: lk.label || '' } : null;
      }).filter(Boolean);
  }

  /* Statistik */
  const statsHtml = '<div class="dcx-stats-row">' +
    _statChip('settings_input_antenna', 'OLT', oltLinks.length || d.olt_count || 0, '#0891b2') +
    (isOnline
      ? _statChip('check_circle', 'Status', 'Online', '#22c55e')
      : _statChip('cancel', 'Status', 'Offline', '#ef4444')) +
  '</div>';

  /* Daftar OLT terhubung */
  let oltListHtml = '';
  if (oltLinks.length) {
    oltListHtml = '<div class="dcx-port-list">' +
      '<div class="dcx-port-list-hdr"><span class="material-symbols-outlined">settings_input_antenna</span>OLT Terhubung</div>' +
      oltLinks.map(function(lk, i) {
        return '<div class="dcx-port-item">' +
          '<div class="dcx-pi-port">OLT ' + (i + 1) + '</div>' +
          '<div class="dcx-pi-name">' + escHtml(lk.name) + '</div>' +
          '<div class="dcx-pi-info">' + (lk.label ? escHtml(lk.label) : '—') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS['router'] || 'router', 'MIKROTIK', node.name, isOnline, '', d.ip || '') +
    '<div class="dcx-body">' +
      statsHtml +
      (d.public_ip     ? _cardRow('public', 'Public IP',     escHtml(d.public_ip))      : '') +
      (d.wan_interface ? _cardRow('cable',  'WAN Interface', escHtml(d.wan_interface))  : '') +
      (oltListHtml || '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Belum ada OLT terhubung</div>') +
    '</div>' +
  '</div>';
}

function _buildOltCard(node) {
  const accent   = TYPE_COLORS['olt'] || '#0369a1';
  const isOnline = node.status === 'online';
  const d        = node.detail || {};

  /* Upstream router dari topologi — satu OLT bisa punya beberapa jalur uplink */
  let upLinks = [];
  if (window._lastLinks) {
    upLinks = window._lastLinks
      .filter(function(lk) { return lk.target === node.id; })
      .map(function(lk) {
        const src = _topologyNodes.find(function(n) { return n.id === lk.source; });
        return { name: src ? src.name : '', label: lk.label || '' };
      });
  }

  /* Downstream ODC dari topologi */
  let odcLinks = [];
  if (window._lastLinks) {
    odcLinks = window._lastLinks
      .filter(function(lk) { return lk.source === node.id; })
      .map(function(lk) {
        const tgt = _topologyNodes.find(function(n) { return n.id === lk.target; });
        return tgt || null;
      }).filter(Boolean);
  }

  const tipeLabel = { zte:'ZTE GPON', huawei:'Huawei GPON', vsol:'V-Sol GPON',
                      epon:'HSGQ EPON', hsgq:'HSGQ EPON', generic:'Generic' };

  const statsHtml = '<div class="dcx-stats-row">' +
    _statChip('hub',    'ODC',  d.odc_count  || odcLinks.length || 0, '#0891b2') +
    _statChip('person', 'ONU',  d.onu_count  || 0, '#7c3aed') +
    (isOnline
      ? _statChip('check_circle', 'Status', 'Online',  '#22c55e')
      : _statChip('cancel',       'Status', 'Offline', '#ef4444')) +
  '</div>';

  /* Daftar ODC downstream */
  let odcListHtml = '';
  if (odcLinks.length) {
    odcListHtml = '<div class="dcx-port-list">' +
      '<div class="dcx-port-list-hdr"><span class="material-symbols-outlined">hub</span>ODC Terhubung</div>' +
      odcLinks.map(function(n, i) {
        const det = n.detail || {};
        const sisa = (parseInt(det.jumlah_port) || 0) - (parseInt(det.terpakai) || 0);
        return '<div class="dcx-port-item">' +
          '<div class="dcx-pi-port">ODC ' + (i + 1) + '</div>' +
          '<div class="dcx-pi-name">' + escHtml(n.name) + '</div>' +
          '<div class="dcx-pi-info">' + (det.jumlah_port ? det.terpakai + '/' + det.jumlah_port + ' port · ' + sisa + ' sisa' : '—') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } else {
    odcListHtml = '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Belum ada ODC terhubung</div>';
  }

  /* Koneksi ke router — render sebagai daftar kalau lebih dari satu jalur */
  let routerInfoHtml = '';
  if (upLinks.length === 1) {
    routerInfoHtml =
      (upLinks[0].name  ? _cardRow('router', 'MikroTik',   escHtml(upLinks[0].name))  : '') +
      (upLinks[0].label ? _cardRow('cable',  'Port Koneksi', escHtml(upLinks[0].label)) : '');
  } else if (upLinks.length > 1) {
    routerInfoHtml = '<div class="dcx-port-list">' +
      '<div class="dcx-port-list-hdr"><span class="material-symbols-outlined">router</span>Jalur Uplink (' + upLinks.length + ')</div>' +
      upLinks.map(function(u, i) {
        return '<div class="dcx-port-item">' +
          '<div class="dcx-pi-port">Jalur ' + (i + 1) + '</div>' +
          '<div class="dcx-pi-name">' + escHtml(u.name || '—') + '</div>' +
          '<div class="dcx-pi-info">' + (u.label ? escHtml(u.label) : '—') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS['olt'] || 'settings_input_antenna', 'OLT', node.name, isOnline, '', d.ip || '') +
    '<div class="dcx-body">' +
      statsHtml +
      (d.tipe        ? _cardRow('memory', 'Tipe',       escHtml(tipeLabel[d.tipe] || d.tipe)): '') +
      (d.lokasi      ? _cardRow('place',  'Lokasi',     escHtml(d.lokasi))                   : '') +
      routerInfoHtml +
      (d.keterangan  ? _cardRow('notes',  'Keterangan', escHtml(d.keterangan))               : '') +
      odcListHtml +
    '</div>' +
  '</div>';
}

function _portBadge(used, total) {
  const sisa = Math.max(total - used, 0);
  const pct  = total > 0 ? Math.round(used / total * 100) : 0;
  const color = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#22c55e';
  return '<div class="dcx-port-stat">' +
    '<div class="dcx-port-bar-wrap"><div class="dcx-port-bar" style="width:' + pct + '%;background:' + color + '"></div></div>' +
    '<div class="dcx-port-nums">' +
      '<span><span class="material-symbols-outlined">cable</span>' + used + '/' + total + ' port</span>' +
      '<span class="dcx-port-sisa" style="color:' + color + '">' + sisa + ' sisa</span>' +
    '</div>' +
  '</div>';
}

function _buildOdcCard(node) {
  const accent = TYPE_COLORS['odc'] || '#0891b2';
  const d = node.detail || {};
  const jp       = parseInt(d.jumlah_port) || 0;
  const terpakai = parseInt(d.terpakai)    || 0;
  const ports    = d.ports || [];

  /* Cari nama OLT dari topologi */
  let oltName = '';
  if (window._lastLinks) {
    const uplink = window._lastLinks.find(function(lk) { return lk.target === node.id; });
    if (uplink) {
      const src = _topologyNodes.find(function(n) { return n.id === uplink.source; });
      if (src) oltName = src.name;
    }
  }

  let portsHtml = '';
  if (ports.length) {
    portsHtml = '<div class="dcx-port-list">' +
      '<div class="dcx-port-list-hdr"><span class="material-symbols-outlined">hub</span>Daftar ODP</div>' +
      ports.map(function(p, i) {
        const t    = parseInt(p.jumlah_port) || 0;
        const u    = parseInt(p.terpakai)    || 0;
        const sisa = Math.max(t - u, 0);
        const portLabel = p.port_odc ? 'Port ' + p.port_odc : 'Port ' + (i + 1);
        return '<div class="dcx-port-item">' +
          '<div class="dcx-pi-port">' + escHtml(portLabel) + '</div>' +
          '<div class="dcx-pi-name">' + escHtml(p.nama) + '</div>' +
          '<div class="dcx-pi-info">' + u + '/' + t + ' port · ' + sisa + ' sisa</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } else {
    portsHtml = '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Belum ada ODP terhubung</div>';
  }

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS['odc'] || 'device_hub', 'ODC', node.name, true, '', '') +
    '<div class="dcx-body">' +
      (d.lokasi ? _cardRow('place', 'Lokasi', escHtml(d.lokasi)) : '') +
      (oltName  ? _cardRow('router', 'Terhubung ke OLT', escHtml(oltName)) : '') +
      _portBadge(terpakai, jp) +
      portsHtml +
    '</div>' +
  '</div>';
}

function _buildOdpCard(node) {
  const accent = TYPE_COLORS['odp'] || '#7c3aed';
  const d = node.detail || {};
  const jp       = parseInt(d.jumlah_port) || 0;
  const terpakai = parseInt(d.terpakai)    || 0;
  const pelList  = d.pelanggan || [];
  const anakList = d.odp_anak  || [];

  /* Cari upstream dari topologi (ODC, ODP induk, atau OLT langsung) */
  let upstreamLabel = '';
  let upstreamIcon  = 'hub';
  if (window._lastLinks) {
    const uplink = window._lastLinks.find(function(lk) { return lk.target === node.id; });
    if (uplink) {
      const src = _topologyNodes.find(function(n) { return n.id === uplink.source; });
      if (src) {
        upstreamLabel = src.name;
        upstreamIcon  = src.type === 'olt' ? 'router' : src.type === 'odp' ? 'device_hub' : 'hub';
      }
    }
  }

  /* Gabung pelanggan + ODP anak jadi satu daftar "Port Terhubung",
     diurutkan berdasarkan nomor port — mencerminkan kondisi fisik port. */
  const portEntries = pelList.map(function(p, i) {
    return { jenis: 'pelanggan', slot_port: p.slot_port, sortKey: parseInt(p.slot_port) || (i + 1),
             nama: p.nama || p.username, info: p.username };
  }).concat(anakList.map(function(a, i) {
    return { jenis: 'odp', slot_port: a.slot_port, sortKey: parseInt(a.slot_port) || (i + 1),
             nama: a.nama, info: 'ODP turunan' };
  }));
  portEntries.sort(function(a, b) { return a.sortKey - b.sortKey; });

  let pelHtml = '';
  if (portEntries.length) {
    pelHtml = '<div class="dcx-port-list">' +
      '<div class="dcx-port-list-hdr"><span class="material-symbols-outlined">cable</span>Port Terhubung</div>' +
      portEntries.map(function(e) {
        const portLabel = e.slot_port ? 'Port ' + e.slot_port : '-';
        const icon      = e.jenis === 'odp' ? 'device_hub' : 'person';
        return '<div class="dcx-port-item">' +
          '<div class="dcx-pi-port">' + escHtml(portLabel) + '</div>' +
          '<div class="dcx-pi-name"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:text-bottom;margin-right:4px;">' + icon + '</span>' + escHtml(e.nama) + '</div>' +
          '<div class="dcx-pi-info">' + escHtml(e.info) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } else {
    pelHtml = '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Belum ada port yang terhubung</div>';
  }

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS['odp'] || 'device_hub', 'ODP', node.name, true, '', '') +
    '<div class="dcx-body">' +
      (d.lokasi       ? _cardRow('place', 'Lokasi', escHtml(d.lokasi)) : '') +
      (upstreamLabel  ? _cardRow(upstreamIcon, 'Terhubung ke', escHtml(upstreamLabel)) : '') +
      _portBadge(terpakai, jp) +
      pelHtml +
    '</div>' +
  '</div>';
}

/* ════════════════════════════════════════════════════════════
   EXPORT KML
════════════════════════════════════════════════════════════ */

const KML_TYPE_ICON = {
  router: 'http://maps.google.com/mapfiles/kml/shapes/router.png',
  olt:    'http://maps.google.com/mapfiles/kml/shapes/signal.png',
  odc:    'http://maps.google.com/mapfiles/kml/shapes/square.png',
  odp:    'http://maps.google.com/mapfiles/kml/shapes/donut.png',
  onu:    'http://maps.google.com/mapfiles/kml/shapes/wifi.png',
};

const KML_TYPE_COLOR = {
  router: 'ff1d4ed8',   /* blue */
  olt:    'fff97316',   /* orange */
  odc:    'ff0891b2',   /* cyan */
  odp:    'ffdb2777',   /* pink */
  onu_ok:   'ff16a34a', /* hijau  — bagus */
  onu_warn: 'ffeab308', /* kuning — sedang */
  onu_bad:  'ffea580c', /* oranye — buruk (online) */
  offline:  'ff7f1d1d', /* merah pekat — mati / terputus */
};

function _kmlEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _kmlStyleId(node) {
  if (node.status !== 'online') return 'offline';
  if (node.type === 'onu') {
    const c = classifyRx(node.rx_power);
    return c === 'ok' ? 'onu_ok' : c === 'warn' ? 'onu_warn' : 'onu_bad';
  }
  return node.type || 'router';
}

function exportKML() {
  const nodes = _topologyNodes.filter(function(n) { return n.lat != null && n.lng != null; });
  if (!nodes.length) {
    if (typeof toast === 'function') toast('Belum ada data topologi untuk diekspor', 'warning');
    return;
  }

  const TYPE_LABELS_KML = { router:'Router', olt:'OLT', odc:'ODC', odp:'ODP', onu:'Pelanggan' };

  /* Buat style unik tiap tipe/status */
  const styleKeys = ['router','olt','odc','odp','onu_ok','onu_warn','onu_bad','offline'];
  const styles = styleKeys.map(function(k) {
    const color = KML_TYPE_COLOR[k] || 'ff0040a1';
    const icon  = KML_TYPE_ICON[k.startsWith('onu') ? 'onu' : k.replace(/_.*$/,'')] || KML_TYPE_ICON.onu;
    return [
      '<Style id="s_' + k + '">',
      '  <IconStyle><color>' + color + '</color><scale>0.9</scale><Icon><href>' + icon + '</href></Icon></IconStyle>',
      '  <LabelStyle><color>' + color + '</color><scale>0.75</scale></LabelStyle>',
      '  <BalloonStyle><text><![CDATA[$[description]]]></text></BalloonStyle>',
      '</Style>',
    ].join('\n');
  }).join('\n');

  /* Folder per tipe */
  const folders = {};
  nodes.forEach(function(n) {
    const tkey = n.type || 'onu';
    if (!folders[tkey]) folders[tkey] = [];
    const d      = n.detail || {};
    const status = n.status === 'online' ? 'Online' : 'Offline';
    const rxLine = (n.type === 'onu' && n.status === 'online' && n.rx_power != null) ? '<tr><td>RX Power</td><td>' + n.rx_power.toFixed(1) + ' dBm</td></tr>' : '';
    const ipLine = d.ip   ? '<tr><td>IP</td><td>' + _kmlEsc(d.ip) + '</td></tr>' : '';
    const snLine = d.sn   ? '<tr><td>SN</td><td>' + _kmlEsc(d.sn) + '</td></tr>' : '';
    const loLine = d.lokasi ? '<tr><td>Lokasi</td><td>' + _kmlEsc(d.lokasi) + '</td></tr>' : '';
    const desc = '<![CDATA[<table>' +
      '<tr><td><b>Tipe</b></td><td>' + _kmlEsc(TYPE_LABELS_KML[n.type] || n.type) + '</td></tr>' +
      '<tr><td>Status</td><td>' + status + '</td></tr>' +
      rxLine + ipLine + snLine + loLine +
      '</table>]]>';

    folders[tkey].push(
      '<Placemark>',
      '  <name>' + _kmlEsc(n.name) + '</name>',
      '  <description>' + desc + '</description>',
      '  <styleUrl>#s_' + _kmlStyleId(n) + '</styleUrl>',
      '  <Point><coordinates>' + n.lng + ',' + n.lat + ',0</coordinates></Point>',
      '</Placemark>',
    );
  });

  /* Garis koneksi antar perangkat */
  const linkPlacemarks = (window._lastLinks || []).map(function(lk) {
    const src = _topologyNodes.find(function(n) { return n.id === lk.source; });
    const tgt = _topologyNodes.find(function(n) { return n.id === lk.target; });
    if (!src || !tgt || src.lat == null || tgt.lat == null) return '';
    const q      = lk.quality || 'good';
    const status = lk.status  || 'online';
    const color  = status !== 'online' ? KML_TYPE_COLOR.offline
                 : q === 'good'    ? KML_TYPE_COLOR.onu_ok
                 : q === 'warning' ? KML_TYPE_COLOR.onu_warn
                 :                   KML_TYPE_COLOR.onu_bad;
    return [
      '<Placemark>',
      '  <name>' + _kmlEsc((src.name||'') + ' → ' + (tgt.name||'')) + '</name>',
      '  <Style><LineStyle><color>' + color + '</color><width>2</width></LineStyle></Style>',
      '  <LineString><tessellate>1</tessellate><coordinates>' +
             src.lng+','+src.lat+',0 ' + tgt.lng+','+tgt.lat+',0' +
         '</coordinates></LineString>',
      '</Placemark>',
    ].join('\n');
  }).filter(Boolean).join('\n');

  /* Susun KML lengkap */
  const folderBlocks = Object.keys(folders).map(function(tkey) {
    return [
      '<Folder><name>' + (TYPE_LABELS_KML[tkey]||tkey) + '</name>',
      folders[tkey].join('\n'),
      '</Folder>',
    ].join('\n');
  }).join('\n');

  const now     = new Date().toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
  const kml     = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    '<name>Topologi Jaringan — ' + now + '</name>',
    '<description>Diekspor dari TechnoFix · ' + nodes.length + ' perangkat</description>',
    styles,
    folderBlocks,
    (linkPlacemarks ? '<Folder><name>Kabel / Koneksi</name>\n' + linkPlacemarks + '\n</Folder>' : ''),
    '</Document>',
    '</kml>',
  ].join('\n');

  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'topologi-jaringan-' + new Date().toISOString().slice(0,10) + '.kml';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 2000);

  if (typeof toast === 'function')
    toast(nodes.length + ' perangkat diekspor ke file KML', 'success');
}

function mapActionToast(msg) {
  if (typeof toast === 'function') toast(msg + ' — fitur dalam pengembangan', 'info');
}

async function mapRebootModem(pelangganId, username) {
  if (!confirm('Reboot modem ' + username + '?\n\nSesi PPPoE aktif akan diputus, modem reconnect otomatis.')) return;
  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + '/api/pelanggan/' + pelangganId + '/reboot', {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}),
      body: JSON.stringify({ username: username }),
    });
    const data = await res.json();
    if (typeof toast === 'function')
      toast(res.ok ? ('Reboot terkirim ke ' + username) : (data.error || 'Gagal reboot'), res.ok ? 'success' : 'error');
  } catch (e) {
    if (typeof toast === 'function') toast('Gagal reboot: ' + e.message, 'error');
  }
}

/* Remote Modem — repoint slot NAT "Remote-Onu" lalu buka di tab baru */
async function mapRemoteModem(pelangganId, username) {
  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + '/api/pelanggan/' + pelangganId + '/remote-on', {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}),
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      if (typeof toast === 'function') toast(data.error || 'Gagal menyiapkan remote', 'error');
      return;
    }
    if (typeof openRemoteLinksModal === 'function') {
      openRemoteLinksModal(data.modem_ip, data.url, username);
    } else {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    if (typeof toast === 'function') toast('Gagal menyiapkan remote: ' + e.message, 'error');
  }
}

if (typeof escHtml === 'undefined') {
  window.escHtml = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setMapStyle(style) {
  if (!map || style === _currentMapStyle) return;
  _currentMapStyle = style;

  const center = map.getCenter();
  const zoom   = map.getZoom();

  /* Hentikan kedip offline sebelum setStyle — layer lama akan hilang,
     nanti di-restart otomatis oleh _doRenderLinks setelah style.load */
  if (_offlineBlinkTimer) {
    clearInterval(_offlineBlinkTimer);
    _offlineBlinkTimer = null;
  }

  map.setStyle(MAP_STYLES[style]);

  /* style.load → posisi sudah bisa di-restore */
  map.once('style.load', function() {
    map.jumpTo({ center: center, zoom: zoom });
  });

  /* idle → map benar-benar selesai render tile baru,
     aman untuk addSource / addLayer custom */
  map.once('idle', function() {
    if (!_topologyNodes.length || !window._lastLinks || !window._lastLinks.length) return;
    /* Pastikan source belum ada (style baru bersih) */
    if (map.getSource('topo-links')) return;
    const validNodes = _topologyNodes.filter(function(n) { return n.lat != null && n.lng != null; });
    _doRenderLinks(validNodes, window._lastLinks);
  });

  document.getElementById('msw-sat')?.classList.toggle('msw-active', style === 'satellite');
  document.getElementById('msw-street')?.classList.toggle('msw-active', style === 'street');
}
