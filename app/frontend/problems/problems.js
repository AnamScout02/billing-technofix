/* ============================================================
   problems.js — Halaman Problems (NOC) TechnoFix-Bill
   ============================================================ */

'use strict';

const PROB_REASON_LABEL = {
  offline:         'Offline',
  redaman_kritis:  'Redaman Kritis',
  redaman_lemah:   'Redaman Lemah',
};
const PROB_TYPE_LABEL = { router: 'Router', olt: 'OLT', onu: 'ONU' };
const PROB_TYPE_ICON  = { router: 'router', olt: 'settings_input_antenna', onu: 'wifi_tethering' };
const PROB_PAGE_SIZE  = 20;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }

/* ── State: data lengkap di-fetch sekali, filter/search/pagination
   semua client-side (tidak fetch ulang ke server tiap ganti filter) ── */
let _allProblems   = [];
let _filterSeverity = 'all';
let _filterType      = 'all';
let _filterAck        = 'all';
let _searchQuery      = '';
let _currentPage       = 1;

function _filteredProblems() {
  const q = _searchQuery.trim().toLowerCase();
  return _allProblems.filter(function (p) {
    if (_filterSeverity !== 'all' && p.severity !== _filterSeverity) return false;
    if (_filterType !== 'all' && p.type !== _filterType) return false;
    if (_filterAck === 'acked'   && !p.acked) return false;
    if (_filterAck === 'unacked' &&  p.acked) return false;
    if (q && !String(p.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderProblemsSummary(data) {
  document.getElementById('sum-critical').textContent = data.critical;
  document.getElementById('sum-warning').textContent  = data.warning;
  document.getElementById('sum-total').textContent    = data.total;
}

function renderProblemsList() {
  const filtered = _filteredProblems();
  const list  = document.getElementById('problems-list');
  const pager = document.getElementById('problems-pagination');

  if (!filtered.length) {
    list.innerHTML = `
      <div class="prob-empty">
        <span class="material-symbols-outlined">check_circle</span>
        <p>${_allProblems.length ? 'Tidak ada yang cocok dengan filter/pencarian.' : 'Tidak ada gangguan aktif saat ini. Semua perangkat normal.'}</p>
      </div>`;
    pager.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PROB_PAGE_SIZE));
  if (_currentPage > totalPages) _currentPage = totalPages;
  const start = (_currentPage - 1) * PROB_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PROB_PAGE_SIZE);

  list.innerHTML = pageItems.map(function (p) {
    const cls    = p.severity === 'critical' ? 'prob-critical' : 'prob-warning';
    const icon   = p.severity === 'critical' ? 'error' : 'warning';
    const reason = PROB_REASON_LABEL[p.reason] || p.reason;
    let   meta   = reason + (p.detail ? ' &middot; ' + esc(p.detail) : '');
    if (p.acked) meta += ' &middot; Ditangani oleh ' + esc(p.acked_by);
    const ackBtn = p.acked
      ? `<button type="button" class="prob-ack-btn prob-ack-btn-active" onclick="event.stopPropagation();unackProblem('${esc(p.id)}')" title="Batalkan tanda selesai">
           <span class="material-symbols-outlined">check_circle</span><span class="prob-ack-label">Selesai</span></button>`
      : `<button type="button" class="prob-ack-btn" onclick="event.stopPropagation();ackProblem('${esc(p.id)}')" title="Tandai sudah ditangani">
           <span class="material-symbols-outlined">check</span><span class="prob-ack-label">Tandai</span></button>`;
    return `
      <div class="prob-row ${cls} ${p.acked ? 'prob-row-acked' : ''}" onclick="goToMaps()" title="Lihat di Maps">
        <div class="prob-row-icon"><span class="material-symbols-outlined">${icon}</span></div>
        <div class="prob-row-body">
          <div class="prob-row-name">${esc(p.name)}</div>
          <div class="prob-row-meta">${meta}</div>
        </div>
        <div class="prob-row-type">
          <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">${PROB_TYPE_ICON[p.type] || 'help'}</span>
          ${PROB_TYPE_LABEL[p.type] || p.type}
        </div>
        ${ackBtn}
        <span class="material-symbols-outlined prob-row-arrow">chevron_right</span>
      </div>`;
  }).join('');

  renderProblemsPagination(totalPages);
}

/* Pola identik renderPaginasi() di pelanggan.js — angka halaman dgn
   ellipsis, bukan cuma Sebelumnya/Berikutnya. */
function renderProblemsPagination(totalPages) {
  const wrap = document.getElementById('problems-pagination');
  if (!wrap) return;
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }

  let html = `<button class="page-btn" onclick="changeProblemsPageTo(${_currentPage - 1})"
    ${_currentPage === 1 ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_left</span>
  </button>`;

  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= _currentPage - 1 && i <= _currentPage + 1)) {
      html += `<button class="page-btn ${i === _currentPage ? 'active' : ''}" onclick="changeProblemsPageTo(${i})">${i}</button>`;
    } else if (i === _currentPage - 2 || i === _currentPage + 2) {
      html += `<span class="page-btn ellipsis">…</span>`;
    }
  }

  html += `<button class="page-btn" onclick="changeProblemsPageTo(${_currentPage + 1})"
    ${_currentPage === totalPages ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_right</span>
  </button>`;

  wrap.innerHTML = html;
}

function changeProblemsPageTo(p) {
  const totalPages = Math.max(1, Math.ceil(_filteredProblems().length / PROB_PAGE_SIZE));
  if (p < 1 || p > totalPages) return;
  _currentPage = p;
  renderProblemsList();
  document.getElementById('problems-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function goToMaps() {
  window.location.href = '/app/frontend/maps/maps.html';
}

async function ackProblem(problemId) {
  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + '/api/maps/problems/' + encodeURIComponent(problemId) + '/ack', {
      method: 'POST', credentials: 'include', headers: _hdr(),
    });
    if (!res.ok) { if (typeof toast === 'function') toast('Gagal acknowledge', 'danger'); return; }
    const item = _allProblems.find(function (p) { return p.id === problemId; });
    if (item) { item.acked = true; item.acked_by = localStorage.getItem('tf_username') || 'Anda'; }
    renderProblemsList();
    if (typeof toast === 'function') toast('Ditandai sudah ditangani', 'success');
  } catch (e) {
    if (typeof toast === 'function') toast('Tidak bisa menghubungi server', 'danger');
  }
}

async function unackProblem(problemId) {
  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + '/api/maps/problems/' + encodeURIComponent(problemId) + '/ack', {
      method: 'DELETE', credentials: 'include', headers: _hdr(),
    });
    if (!res.ok) { if (typeof toast === 'function') toast('Gagal batalkan acknowledge', 'danger'); return; }
    const item = _allProblems.find(function (p) { return p.id === problemId; });
    if (item) { item.acked = false; item.acked_by = null; }
    renderProblemsList();
  } catch (e) {
    if (typeof toast === 'function') toast('Tidak bisa menghubungi server', 'danger');
  }
}


function onProblemsSearch() {
  _searchQuery = document.getElementById('prob-search').value || '';
  _currentPage = 1;
  renderProblemsList();
}

function onProblemsFilterChange() {
  _filterSeverity = document.getElementById('filter-severity').value;
  _filterType      = document.getElementById('filter-type').value;
  _filterAck        = document.getElementById('filter-ack').value;
  _currentPage = 1;
  renderProblemsList();
}

async function loadProblems() {
  try {
    const base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    const res  = await fetch(base + '/api/maps/problems', { credentials: 'include', headers: _hdr() });
    const data = await res.json();
    if (!res.ok) {
      if (typeof toast === 'function') toast(data.error || 'Gagal memuat data problems', 'danger');
      return;
    }
    _allProblems = data.problems || [];
    renderProblemsSummary(data);
    renderProblemsList();
  } catch (e) {
    if (typeof toast === 'function') toast('Tidak bisa terhubung ke server', 'danger');
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


  loadProblems();
  setInterval(loadProblems, 30000);
});
