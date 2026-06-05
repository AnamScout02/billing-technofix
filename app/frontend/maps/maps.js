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

const TYPE_COLORS = {
  router: '#1d4ed8',
  olt:    '#7c3aed',
  odc:    '#0891b2',
  odp:    '#d97706',
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
  router: 32, olt: 32, odc: 32, odp: 32, onu: 32,
};

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

let map              = null;
let markers          = [];
let _pendingLinkData = null;   // simpan data links saat map belum siap

/* ════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSearch();
  loadTopology();

  document.getElementById('btn-refresh-map')
    ?.addEventListener('click', () => loadTopology(true));

  /* Klik peta kosong → tutup card */
  document.getElementById('networkMap')
    ?.addEventListener('click', (e) => {
      if (!e.target.closest('.tf-marker-outer') && !e.target.closest('.device-card'))
        hideCard();
    });

  /* Tutup card saat orientasi berubah agar tidak stuck di mode yang salah */
  window.addEventListener('resize', function() {
    const card = document.getElementById('device-card');
    if (card && card.style.display !== 'none') hideCard();
  }, { passive: true });

  /* Mobile: keterangan kabel & filter mulai tertutup agar peta lega */
  if (window.innerWidth < 768) {
    document.getElementById('cable-legend')?.classList.add('collapsed');
  }
});

/* ════════════════════════════════════════════════════════════
   1. INIT MAP — MapLibre GL JS
════════════════════════════════════════════════════════════ */

function initMap() {
  map = new maplibregl.Map({
    container: 'networkMap',
    style: {
      version: 8,
      sources: {
        'sat': {
          type: 'raster',
          /* Esri World Imagery — satelit gratis & legal, tanpa API key */
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: '© Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          maxzoom: 19,
        },
        'labels': {
          type: 'raster',
          /* CARTO "dark_only_labels" — tile transparan berbasis OpenStreetMap
             yang HANYA menampilkan label administratif:
               provinsi, kabupaten, kecamatan, desa/kelurahan, dusun, nama jalan.
             TIDAK ada POI bisnis (warung, sekolah, toko, bengkel, dll).
             Teks putih + outline gelap → terbaca jelas di atas satelit. */
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
        /* Label administratif (desa/dusun/kecamatan/provinsi) dari CARTO.
           raster-fade-duration:0 → label TIDAK memudar/hilang perlahan
           saat zoom, langsung tetap tampil stabil. */
        { id: 'labels-layer', type: 'raster', source: 'labels',
          paint: {
            'raster-opacity': 1,
            'raster-fade-duration': 0,
          } },
      ],
    },
    center:    [MAP_CENTER[1], MAP_CENTER[0]],   // MapLibre: [lng, lat]
    zoom:      MAP_ZOOM_INIT,
    minZoom:   5,
    maxZoom:   19,   // Esri World Imagery maks zoom 19
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

  /* Marker mengecil/membesar mengikuti zoom (via width/height, aman) */
  map.on('zoom', _applyMarkerZoomScale);
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
    _isKolektor    = !!data.is_kolektor || (localStorage.getItem('tf_role') === 'kolektor');
    _koordinatKosong = data.koordinat_kosong || 0;
    renderTopology(data.nodes || [], data.links || []);
    updateStats(data.nodes || []);
    updateLastUpdate();
    _renderKolektorBanner();

  } catch (err) {
    console.error('[Maps]', err.message);
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
let _linkAnimFrame = null; // requestAnimationFrame handle animasi
let _linkGeoms     = [];   // [{src:[lng,lat], tgt:[lng,lat], quality, status}]
let _comets        = [];   // [{li, progress, speed, color}]
let _lastAnimTs    = 0;

/* Warna cahaya (terang) per kondisi REDAMAN */
const PARTICLE_COLOR = { good:'#86efac', warning:'#fcd34d', bad:'#fca5a5' };
/* Kecepatan (progress/ms) — makin buruk makin pelan */
const PARTICLE_SPEED = { good:0.00055, warning:0.00026, bad:0.00013 };
/* Jumlah "komet" cahaya per kabel (tiap komet = head + ekor) */
const COMETS_PER_LINK = 3;
/* Bentuk ekor: faktor radius & opacity per titik (head → ekor) */
const TAIL_SHAPE = [
  { d: 0.000, rf: 1.20, op: 1.00 },  /* head terang & besar */
  { d: 0.018, rf: 0.85, op: 0.65 },  /* ekor 1 */
  { d: 0.036, rf: 0.58, op: 0.42 },  /* ekor 2 */
  { d: 0.054, rf: 0.38, op: 0.24 },  /* ekor 3 */
  { d: 0.072, rf: 0.22, op: 0.12 },  /* ekor 4 */
];

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
  good:    '#16a34a',   /* hijau  — sinyal bagus */
  warning: '#d97706',   /* amber  — sinyal sedang */
  bad:     '#dc2626',   /* merah  — sinyal buruk / offline */
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

  /* Bangun ulang daftar partikel */
  _buildParticles();

  /* Update source yang sudah ada */
  if (map.getSource('topo-links')) {
    map.getSource('topo-links').setData(geojson);
    _startLinkAnimation();   /* selalu restart agar animasi pasti jalan */
    return;
  }

  const colorExpr = [
    'match', ['get', 'quality'],
    'good', LINK_COLORS.good, 'warning', LINK_COLORS.warning, 'bad', LINK_COLORS.bad,
    '#94a3b8',
  ];
  const widthBase = ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4.5, 18, 7];

  /* ── Source garis kabel ── */
  map.addSource('topo-links', { type: 'geojson', data: geojson });

  /* GLOW halo */
  map.addLayer({ id: 'links-glow', type: 'line', source: 'topo-links',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colorExpr, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 14, 13, 18, 20], 'line-opacity': 0.16, 'line-blur': 5 } });
  /* CASING gelap */
  map.addLayer({ id: 'links-casing', type: 'line', source: 'topo-links',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': 'rgba(15,23,42,.5)', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 14, 7, 18, 10], 'line-opacity': 0.85 } });
  /* BASE garis warna utama */
  map.addLayer({ id: 'links-base', type: 'line', source: 'topo-links',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colorExpr, 'line-width': widthBase, 'line-opacity': 0.55 } });
  /* OFFLINE garis putus-putus statis */
  map.addLayer({ id: 'links-offline', type: 'line', source: 'topo-links',
    filter: ['==', ['get', 'status'], 'offline'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': LINK_COLORS.bad, 'line-width': widthBase, 'line-dasharray': [1.5, 2], 'line-opacity': 0.95 } });

  /* ── Source + layer PARTIKEL cahaya (head + ekor, glow) ──
     radius & opacity DATA-DRIVEN via properti 'rf' & 'op' tiap titik
     → head besar terang, ekor mengecil & meredup (efek komet). */
  map.addSource('topo-particles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  /* Halo glow (besar, blur).
     PENTING: interpolate(zoom) HARUS terluar; faktor 'rf' dikalikan
     di tiap nilai stop, BUKAN membungkus interpolate. */
  map.addLayer({ id: 'particles-glow', type: 'circle', source: 'topo-particles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        10, ['*', 6,  ['get', 'rf']],
        14, ['*', 11, ['get', 'rf']],
        18, ['*', 16, ['get', 'rf']]],
      'circle-color': ['get', 'color'],
      'circle-blur': 1,
      'circle-opacity': ['*', 0.45, ['get', 'op']],
    } });
  /* Inti tajam PUTIH TERANG dengan halo warna = kesan cahaya menyala */
  map.addLayer({ id: 'particles-core', type: 'circle', source: 'topo-particles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        10, ['*', 3.5, ['get', 'rf']],
        14, ['*', 5.5, ['get', 'rf']],
        18, ['*', 8,   ['get', 'rf']]],
      'circle-color': '#ffffff',
      'circle-opacity': ['get', 'op'],
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['*', 2, ['get', 'rf']],
      'circle-stroke-opacity': ['get', 'op'],
    } });

  _startLinkAnimation();
}

/* Bangun komet: tiap kabel ONLINE dapat beberapa komet cahaya
   dengan progress awal merata. Offline → tidak ada (aliran berhenti). */
function _buildParticles() {
  _comets = [];
  _linkGeoms.forEach(function(g, li) {
    if (g.status !== 'online') return;           /* offline = aliran berhenti */
    const speed = PARTICLE_SPEED[g.quality] || PARTICLE_SPEED.good;
    const color = PARTICLE_COLOR[g.quality] || PARTICLE_COLOR.good;
    for (let k = 0; k < COMETS_PER_LINK; k++) {
      _comets.push({ li: li, progress: k / COMETS_PER_LINK, speed: speed, color: color });
    }
  });
  console.log('[Links] komet cahaya:', _comets.length, '| kabel:', _linkGeoms.length);
}

/* Animasi CAHAYA BERIRINGAN — tiap komet = head + ekor meluncur
   dari perangkat sumber ke tujuan. Plus kabel OFFLINE berkedip-kedip. */
function _startLinkAnimation() {
  if (_linkAnimFrame) cancelAnimationFrame(_linkAnimFrame);
  _lastAnimTs = 0;

  function frame(ts) {
    if (!map || !map.getSource('topo-particles')) { _linkAnimFrame = null; return; }
    const dt = _lastAnimTs ? (ts - _lastAnimTs) : 16;
    _lastAnimTs = ts;

    /* ── Komet cahaya (head + ekor) ── */
    const feats = [];
    for (let i = 0; i < _comets.length; i++) {
      const c = _comets[i];
      c.progress += c.speed * dt;
      if (c.progress > 1) c.progress -= 1;
      const g = _linkGeoms[c.li];
      if (!g) continue;
      const dx = g.tgt[0] - g.src[0], dy = g.tgt[1] - g.src[1];
      /* head + tiap titik ekor (di belakang head) */
      for (let t = 0; t < TAIL_SHAPE.length; t++) {
        const seg = TAIL_SHAPE[t];
        const pr = c.progress - seg.d;
        if (pr < 0) continue;                    /* ekor belum keluar dari sumber */
        feats.push({
          type: 'Feature',
          properties: { color: c.color, rf: seg.rf, op: seg.op },
          geometry: { type: 'Point', coordinates: [g.src[0] + dx * pr, g.src[1] + dy * pr] },
        });
      }
    }
    try { map.getSource('topo-particles').setData({ type: 'FeatureCollection', features: feats }); } catch(_) {}

    /* ── Kabel OFFLINE berkedip-kedip ── */
    if (map.getLayer('links-offline')) {
      const blink = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(ts / 320));  /* 0.35..0.9 */
      try { map.setPaintProperty('links-offline', 'line-opacity', blink); } catch(_) {}
    }

    _linkAnimFrame = requestAnimationFrame(frame);
  }
  _linkAnimFrame = requestAnimationFrame(frame);
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

  /* Pulse ring — ONU online sinyal bagus */
  if (node.type === 'onu' && node.status === 'online' && classifyRx(node.rx_power) === 'ok') {
    const pulse = document.createElement('div');
    pulse.style.cssText = [
      'position:absolute', 'inset:-6px', 'border-radius:50%',
      `border:2px solid ${color}`,
      'animation:tfPulse 2.2s ease-out infinite',
      'pointer-events:none',
    ].join(';');
    vis.appendChild(pulse);
  }

  /* Hover: brightness pada vis (BUKAN el) */
  el.addEventListener('mouseenter', function() {
    vis.style.filter = 'brightness(1.18) drop-shadow(0 3px 10px rgba(0,0,0,.55))';
    el.style.zIndex = '10';
  });
  el.addEventListener('mouseleave', function() {
    vis.style.filter = '';
    el.style.zIndex = '';
  });

  el.addEventListener('click', function(e) {
    e.stopPropagation();
    showCard(node);
  });

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

/* ── Resize marker mengikuti zoom — AMAN (scale elemen DALAM 'vis',
   bukan elemen luar 'el' milik MapLibre). Posisi tidak pernah berubah.
     Zoom sangat jauh (≤9)  → 0.35× + redup (hampir tak terlihat)
     Zoom jauh        (≤12) → mengecil
     Default          (15)  → 1.0×
     Zoom dekat       (≥17) → 1.3× */
function _applyMarkerZoomScale() {
  if (!map || !markers.length) return;
  const z = map.getZoom();

  /* Kurva skala: makin zoom out makin kecil & redup */
  let f, op;
  if (z <= 9)        { f = 0.35; op = 0.45; }
  else if (z >= 17)  { f = 1.30; op = 1; }
  else {
    /* interpolasi 9→17 : skala 0.35→1.30 */
    const t = (z - 9) / (17 - 9);
    f = 0.35 + (1.30 - 0.35) * t;
    op = z < 11 ? 0.45 + (1 - 0.45) * ((z - 9) / 2) : 1;
  }
  const sf = 'scale(' + f.toFixed(3) + ')';

  markers.forEach(function(m) {
    if (!m.vis) return;
    m.vis.style.transform = sf;
    m.vis.style.opacity   = op;
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

  markers.forEach(function({ el, node }) {
    const typeOk   = fType[node.type] !== false;
    const statusOk = node.status === 'online' ? fOnline : fOffline;
    el.style.visibility = (typeOk && statusOk) ? '' : 'hidden';
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

function toggleFilterPanel() {
  const body    = document.getElementById('mfp-body');
  const chevron = document.getElementById('mfp-chevron');
  if (!body || !chevron) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  chevron.textContent = isOpen ? 'expand_more' : 'expand_less';
}

function toggleCableLegend() {
  const el = document.getElementById('cable-legend');
  if (el) el.classList.toggle('collapsed');
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
    // Kolektor: warna berdasarkan status tagihan (merah=belum bayar, hijau=lunas)
    if (_isKolektor) {
      return node.tagihan_status === 'belum_bayar' ? '#dc2626' : '#16a34a';
    }
    // Owner/Admin: warna berdasarkan RX power
    if (node.status !== 'online') return '#dc2626';
    const rx = node.rx_power;
    if (rx === null || rx === undefined) return '#dc2626';
    const c = classifyRx(rx);
    return c === 'ok' ? '#16a34a' : c === 'warn' ? '#d97706' : '#dc2626';
  }
  if (node.status !== 'online') return '#94a3b8';
  return TYPE_COLORS[node.type] || '#0040a1';
}

/* Flag kolektor — diisi saat data topology dimuat */
var _isKolektor = (localStorage.getItem('tf_role') === 'kolektor');
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

const KEY_LABEL = {
  ip: 'IP Address', lokasi: 'Lokasi', tipe: 'Tipe',
  profil: 'Profil PPPoE', sn: 'Serial Number',
  vlan: 'VLAN', slot_port: 'Slot / Port', hp: 'No. HP',
};

function showCard(node) {
  const card     = document.getElementById('device-card');
  const backdrop = document.getElementById('device-card-backdrop');
  if (!card) return;

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

  /* Backdrop — hanya aktif pada mobile */
  if (backdrop) {
    backdrop.classList.toggle('active', isMobile);
  }
}

function hideCard() {
  const card     = document.getElementById('device-card');
  const backdrop = document.getElementById('device-card-backdrop');
  if (card)     card.style.display = 'none';
  if (backdrop) backdrop.classList.remove('active');
}

/* Helper: banner header premium dengan gradient accent */
function _cardBanner(accent, icon, typeLabel, name, isOnline, subInfo) {
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

/* ── Render banner info koordinat kosong untuk kolektor ── */
function _renderKolektorBanner() {
  var el = document.getElementById('kol-maps-banner');
  if (!el) return;
  if (!_isKolektor) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  var txt = document.getElementById('kol-maps-banner-txt');
  if (txt) {
    txt.textContent = _koordinatKosong > 0
      ? _koordinatKosong + ' pelanggan Anda belum punya koordinat — tidak tampil di peta.'
      : 'Semua pelanggan Anda sudah punya koordinat.';
  }
  // Legend warna
  var legend = document.getElementById('kol-maps-legend');
  if (legend) legend.style.display = '';
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
  const accent     = getMarkerColor(node);
  const stCls      = isOnline ? 'dcx-st-online' : 'dcx-st-offline';
  const bs         = window.innerWidth < 768 ? '<div class="bs-handle bs-handle-light"></div>' : '';
  const belumBayar = node.tagihan_status === 'belum_bayar';

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

  // Tombol Rute ke Google Maps
  const lat = node.lat, lng = node.lng;
  const ruteBtn = '<button class="dcx-btn dcx-btn-navy" onclick="window.open(\'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '\',\'_blank\')">' +
    '<span class="material-symbols-outlined">directions</span>Rute</button>';

  // Tombol Bayar — arahkan ke halaman pelanggan (kolektor saja)
  const bayarBtn = (_isKolektor && belumBayar)
    ? '<button class="dcx-btn dcx-btn-amber" onclick="_mapsKolektorDetail(\'' + escHtml(d.username) + '\')">' +
        '<span class="material-symbols-outlined">payments</span>Bayar</button>'
    : '';

  // Untuk kolektor: hanya Hubungi + Rute + Bayar (tidak ada Reboot/Remote)
  const actionBtns = _isKolektor
    ? waBtn + ruteBtn + bayarBtn
    : waBtn + ruteBtn +
      '<button class="dcx-btn dcx-btn-purple" onclick="mapActionToast(\'Reboot Modem\')">' +
        '<span class="material-symbols-outlined">restart_alt</span>Reboot</button>' +
      '<button class="dcx-btn dcx-btn-navy" onclick="mapActionToast(\'Remote Modem\')">' +
        '<span class="material-symbols-outlined">terminal</span>Remote</button>';

  // Status tagihan badge (kolektor)
  const tagihanBadge = _isKolektor
    ? '<span class="dcx-tagihan-badge ' + (belumBayar ? 'dcx-tbadge-belum' : 'dcx-tbadge-lunas') + '">' +
        (belumBayar ? 'Belum Bayar' : 'Lunas') + '</span>'
    : '';

  return '<div class="dcx dcx-onu">' +
    '<div class="dcx-banner" style="--accent:' + accent + '">' +
      bs +
      '<button class="dcx-close" onclick="hideCard()"><span class="material-symbols-outlined">close</span></button>' +
      '<div class="dcx-banner-row">' +
        '<div class="dcx-icon"><span class="material-symbols-outlined">wifi_tethering</span></div>' +
        '<div class="dcx-titles">' +
          '<span class="dcx-type">ONU · PELANGGAN</span>' +
          '<div class="dcx-name">' + escHtml(node.name) + '</div>' +
          tagihanBadge +
        '</div>' +
      '</div>' +
      '<div class="dcx-mid">' +
        '<span class="dcx-status-pill ' + stCls + '">' +
          '<span class="dcx-st-dot"></span>' + (isOnline ? 'Online' : 'Offline') +
          (slot ? '<span class="dcx-st-sub">' + slot + '</span>' : '') +
        '</span>' +
        '<div class="dcx-rxbig">' +
          (_isKolektor ? (rawHp || '—') : ((rx != null ? rx.toFixed(1) : '—') + '<small>dBm</small>')) +
        '</div>' +
      '</div>' +
      ((footL || footR) ? '<div class="dcx-foot">' + footL + footR + '</div>' : '') +
    '</div>' +
    '<div class="dcx-actions">' + actionBtns + '</div>' +
  '</div>';
}

/* Navigasi ke halaman pelanggan untuk kolektor (dari Maps) */
function _mapsKolektorDetail(username) {
  // Simpan username ke sessionStorage lalu buka halaman pelanggan
  try { sessionStorage.setItem('kol_maps_target', username); } catch(_) {}
  window.location.href = '/app/frontend/pelanggan/pelanggan.html';
}

/* ── Card infrastruktur (Router/OLT/ODC/ODP) — Premium ── */
function _buildDeviceCard(node) {
  const accent   = TYPE_COLORS[node.type] || '#0040a1';
  const isOnline = node.status === 'online';
  const d        = node.detail || {};

  /* Hanya tampilkan detail dasar perangkat — TANPA info topologi
     (Router via ...) yang diminta dihilangkan. */
  const KEY_MAP = {
    ip: ['lan', 'IP Address'], lokasi: ['place', 'Lokasi'], tipe: ['memory', 'Tipe'],
    jumlah_port: ['settings_ethernet', 'Jumlah Port'], port_terpakai: ['cable', 'Port Terpakai'],
  };
  /* Field yang ditampilkan (whitelist) — sisanya disembunyikan */
  const SHOW = ['ip', 'lokasi', 'tipe', 'jumlah_port', 'port_terpakai'];

  const rows = SHOW
    .filter(function(k) { return d[k] || d[k] === 0; })
    .map(function(k) {
      const meta = KEY_MAP[k] || ['info', k];
      return _cardRow(meta[0], meta[1], escHtml(String(d[k])));
    }).join('');

  return '<div class="dcx">' +
    _cardBanner(accent, TYPE_ICONS[node.type] || 'device_unknown',
                (TYPE_LABELS[node.type] || node.type).toUpperCase(), node.name, isOnline, '') +
    '<div class="dcx-body">' +
      (rows
        ? '<div class="dcx-rows">' + rows + '</div>'
        : '<div class="dcx-empty"><span class="material-symbols-outlined">info</span>Tidak ada detail tersedia</div>') +
    '</div>' +
  '</div>';
}

function mapActionToast(msg) {
  if (typeof toast === 'function') toast(msg + ' — fitur dalam pengembangan', 'info');
}

/* ── Bangun info koneksi untuk card berdasarkan relasi di topologi ── */
function _buildConnInfo(node) {
  const info = {};
  if (!window._lastLinks) return info;
  const links = window._lastLinks;

  if (node.type === 'router') {
    /* Router: tampilkan OLT yang terhubung */
    const targets = links
      .filter(function(lk) { return lk.source === node.id; })
      .map(function(lk) {
        const tgt = _topologyNodes.find(function(n) { return n.id === lk.target; });
        return tgt ? tgt.name + (lk.label ? ' (' + lk.label + ')' : '') : lk.target;
      });
    if (targets.length) info['OLT'] = targets.join(', ');
  }

  if (node.type === 'olt') {
    /* OLT: tampilkan router upstream + ODC downstream */
    const uplink = links.find(function(lk) { return lk.target === node.id; });
    if (uplink) {
      const src = _topologyNodes.find(function(n) { return n.id === uplink.source; });
      if (src) info['router_name'] = src.name + (uplink.label ? ' via ' + uplink.label : '');
    }
    const odc = links.filter(function(lk) { return lk.source === node.id; });
    if (odc.length) info['odc_count'] = odc.length + ' ODC';
    /* Hitung ONU dari links-odp-onu melalui chain */
    const onuCount = links.filter(function(lk) {
      return lk.target.startsWith('onu-') && (function() {
        const odcNode = links.find(function(l) { return l.target === lk.source; });
        if (!odcNode) return false;
        return links.some(function(l) { return l.target === odcNode.source && l.source === node.id; });
      })();
    }).length;
    if (onuCount) info['onu_count'] = onuCount + ' aktif';
  }

  if (node.type === 'odc') {
    /* ODC: OLT upstream + jumlah ODP downstream */
    const uplink = links.find(function(lk) { return lk.target === node.id; });
    if (uplink) {
      const src = _topologyNodes.find(function(n) { return n.id === uplink.source; });
      if (src) info['OLT'] = src.name;
    }
    const odp = links.filter(function(lk) { return lk.source === node.id; });
    if (odp.length) info['jumlah_odp'] = odp.length + ' ODP';
  }

  if (node.type === 'odp') {
    /* ODP: ODC upstream + jumlah ONU terhubung */
    const uplink = links.find(function(lk) { return lk.target === node.id; });
    if (uplink) {
      const src = _topologyNodes.find(function(n) { return n.id === uplink.source; });
      if (src) info['ODC'] = src.name;
    }
    const onus = links.filter(function(lk) { return lk.source === node.id; });
    if (onus.length) info['onu_count'] = onus.length + ' ONU';
  }

  return info;
}


if (typeof escHtml === 'undefined') {
  window.escHtml = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
