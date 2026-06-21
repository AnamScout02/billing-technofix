/* theme.js — Tema warna white-label per ISP.
   Dimuat di <head> SEBELUM body dirender: kalau ada cache tema di
   localStorage, langsung diterapkan supaya tidak ada flash warna default
   saat halaman dibuka ulang. global.js akan refresh dari API & update cache. */

function hexToRgb(hex) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function(c) { return c + c; }).join('');
  return [
    parseInt(hex.slice(0, 2), 16) || 0,
    parseInt(hex.slice(2, 4), 16) || 0,
    parseInt(hex.slice(4, 6), 16) || 0,
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(function(v) {
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  }).join('');
}

/* percent < 0 -> campur ke hitam (darken), percent > 0 -> campur ke putih (lighten) */
function shade(hex, percent) {
  const rgb = hexToRgb(hex);
  const target = percent < 0 ? 0 : 255;
  const p = Math.abs(percent);
  return rgbToHex(
    rgb[0] + (target - rgb[0]) * p,
    rgb[1] + (target - rgb[1]) * p,
    rgb[2] + (target - rgb[2]) * p
  );
}

function hexToRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
}

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function deriveThemePalette(primary) {
  const light = relativeLuminance(primary) > 0.55;
  const onText   = light ? '#0f172a'            : '#ffffff';
  const onSub    = light ? 'rgba(15,23,42,.60)' : 'rgba(255,255,255,.60)';
  const onItem   = light ? 'rgba(15,23,42,.70)' : 'rgba(255,255,255,.70)';
  const onIcon   = light ? 'rgba(15,23,42,.80)' : 'rgba(255,255,255,.80)';
  const onBorder = light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)';
  return {
    primary:        primary,
    primaryDark:    shade(primary, -0.18),
    primaryLight:   shade(primary, 0.92),
    primaryBright:  shade(primary, 0.15),
    primaryDarker:  shade(primary, -0.17),
    primaryRing:    hexToRgba(primary, 0.12),
    primaryRgb:     hexToRgb(primary).join(','),
    primaryDeep:    shade(primary, -0.62),
    primaryDeepRgb: hexToRgb(shade(primary, -0.62)).join(','),
    headerBg:       shade(primary, -0.08),
    headerText:     onText,
    headerSub:      onSub,
    headerItem:     onItem,
    cardHeadText:   onText,
    cardHeadIcon:   onIcon,
    cardHeadBorder: onBorder,
    bnavActive:     onText,
    bnavInactive:   onItem,
    card1Bg:        'linear-gradient(135deg, ' + shade(primary, -0.17) + ' 0%, ' + shade(primary, 0.15) + ' 100%)',
    card1Shadow:    hexToRgba(primary, 0.30),
    text:           shade(primary, -0.18),
  };
}

function applyTheme(theme) {
  if (!theme || !theme.primary) return;
  const p = deriveThemePalette(theme.primary);
  const root = document.documentElement.style;
  root.setProperty('--primary',          p.primary);
  root.setProperty('--primary-dark',     p.primaryDark);
  root.setProperty('--primary-light',    p.primaryLight);
  root.setProperty('--primary-bright',   p.primaryBright);
  root.setProperty('--primary-darker',   p.primaryDarker);
  root.setProperty('--primary-ring',     p.primaryRing);
  root.setProperty('--primary-rgb',      p.primaryRgb);
  root.setProperty('--primary-deep',     p.primaryDeep);
  root.setProperty('--primary-deep-rgb', p.primaryDeepRgb);
  root.setProperty('--header-bg',        p.headerBg);
  root.setProperty('--header-text',      p.headerText);
  root.setProperty('--header-sub',       p.headerSub);
  root.setProperty('--header-item',      p.headerItem);
  root.setProperty('--header-active',    p.headerText);
  root.setProperty('--card-head-bg',     p.headerBg);
  root.setProperty('--card-head-text',   p.cardHeadText);
  root.setProperty('--card-head-icon',   p.cardHeadIcon);
  root.setProperty('--card-head-border', p.cardHeadBorder);
  root.setProperty('--bnav-bg',          p.headerBg);
  root.setProperty('--bnav-active',      p.bnavActive);
  root.setProperty('--bnav-inactive',    p.bnavInactive);
  root.setProperty('--card-1-bg',        p.card1Bg);
  root.setProperty('--card-1-shadow',    p.card1Shadow);
  root.setProperty('--text',             p.text);
}

window.applyTheme         = applyTheme;
window.deriveThemePalette = deriveThemePalette;

/* Terapkan tema dari cache (jika ada) sesegera mungkin */
(function() {
  try {
    const cached = localStorage.getItem('tf_theme');
    if (cached) applyTheme(JSON.parse(cached));
  } catch (_) {}
})();
