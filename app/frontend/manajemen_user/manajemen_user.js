/* ============================================================
   manajemen_user.js — Kelola Tim (Owner)
   Endpoint: POST /api/auth/invite, GET /api/auth/team,
             POST /api/auth/team/<id>/toggle, DELETE /api/auth/team/<id>
   ============================================================ */
'use strict';

const TEAM_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/auth';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', teknisi: 'Teknisi', kolektor: 'Kolektor' };
const ROLE_BADGE = { owner: 'role-owner', admin: 'role-admin', teknisi: 'role-teknisi', kolektor: 'role-kolektor' };
const PERM_LABEL = {
  pelanggan: 'Pelanggan', pelanggan_manage: 'Kelola Pelanggan', perangkat: 'Perangkat',
  maps: 'Maps', keuangan: 'Keuangan', manajemen_user: 'Tim', bayar: 'Pembayaran', langganan: 'Langganan',
};

let _members = [];
let _toggleTarget = null;

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtTgl(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '-'; } }

/* ── LOAD ── */
async function loadTeam() {
  try {
    const r = await fetch(`${TEAM_API}/team`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { renderError('Hanya Owner yang dapat mengakses Manajemen User.'); return; }
    const d = await r.json();
    _members = d.members || [];
    renderStats();
    renderUsers(_members);
  } catch (e) {
    renderError('Gagal memuat data tim. Pastikan backend berjalan.');
  }
}

function renderError(msg) {
  document.getElementById('tbody-users').innerHTML =
    `<tr><td colspan="7"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`;
}

function renderStats() {
  const total = _members.length;
  const aktif = _members.filter(m => m.aktif).length;
  const tek   = _members.filter(m => m.role === 'teknisi').length;
  setNum('stat-total', total); setNum('stat-aktif', aktif); setNum('stat-teknisi', tek);
  const c = document.getElementById('user-count'); if (c) c.textContent = `${total} user`;
}
function setNum(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function renderUsers(list) {
  const tb = document.getElementById('tbody-users');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="7"><div class="state-box"><p class="state-title">Belum ada anggota tim.</p></div></td></tr>';
    return;
  }
  const me = (typeof getStoredUser === 'function') ? getStoredUser() : null;
  tb.innerHTML = list.map((m, i) => {
    const isOwner = m.role === 'owner';
    const isSelf  = me && String(me.id) === String(m.id);
    const perms = isOwner
      ? '<span class="perm-chip perm-all">Akses Penuh</span>'
      : ((m.permissions || []).map(p => `<span class="perm-chip">${esc(PERM_LABEL[p] || p)}</span>`).join('') || '<span class="perm-chip perm-none">—</span>');
    const statusBadge = m.aktif
      ? '<span class="st-badge st-on"><span class="dot"></span>Aktif</span>'
      : '<span class="st-badge st-off"><span class="dot"></span>Nonaktif</span>';
    const aksi = isOwner
      ? '<span style="color:var(--text-dim);font-size:12px">—</span>'
      : `<div class="row-actions">
           <button class="ico-btn ${m.aktif ? 'amber' : 'green'}" title="${m.aktif ? 'Nonaktifkan' : 'Aktifkan'}" onclick="konfirmasiToggle(${m.id})">
             <span class="material-symbols-outlined">${m.aktif ? 'person_off' : 'person_check'}</span></button>
           <button class="ico-btn red" title="Hapus" onclick="hapusUser(${m.id},'${esc(m.username)}')">
             <span class="material-symbols-outlined">delete</span></button>
         </div>`;
    return `<tr>
      <td class="sticky-col-1">${i + 1}</td>
      <td class="sticky-col-2"><div class="u-name">${esc(m.nama || m.username)}${isSelf ? ' <span class="u-you">Anda</span>' : ''}</div><div class="u-user">@${esc(m.username)}</div></td>
      <td><span class="role-badge ${ROLE_BADGE[m.role] || ''}">${esc(ROLE_LABEL[m.role] || m.role)}</span></td>
      <td><div class="perm-wrap">${perms}</div></td>
      <td>${statusBadge}</td>
      <td>${fmtTgl(m.created_at)}</td>
      <td>${aksi}</td>
    </tr>`;
  }).join('');
}

/* ── FILTER ── */
function filterUsers() {
  const q  = (document.getElementById('mu-search').value || '').toLowerCase().trim();
  const fr = document.getElementById('filter-role').value;
  const fs = document.getElementById('filter-status').value;
  let list = _members.slice();
  if (q)  list = list.filter(m => (m.nama || '').toLowerCase().includes(q) || (m.username || '').toLowerCase().includes(q));
  if (fr) list = list.filter(m => m.role === fr);
  if (fs) list = list.filter(m => (fs === 'aktif') ? m.aktif : !m.aktif);
  renderUsers(list);
}

/* ── TAMBAH USER (invite) ── */
function openFormTambah() {
  const html = `
    <div class="form-modal" style="width:440px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
        <div style="width:40px;height:40px;border-radius:var(--r-md);flex-shrink:0;background:var(--primary-light);color:var(--primary);display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined">person_add</span></div>
        <div style="flex:1"><div style="font-family:var(--heading);font-size:16px;font-weight:800;color:var(--text)">Tambah Anggota Tim</div>
          <div style="font-size:12px;color:var(--text-muted)">Buat akun Admin, Teknisi, atau Kolektor</div></div>
        <button class="psheet-close" onclick="closeForm()"><span class="material-symbols-outlined">close</span></button>
      </div>
      <div class="form-grid">
        <div class="form-group full">
          <label class="form-label">Peran <span class="req">*</span></label>
          <select class="form-input" id="iv-role" onchange="previewPerms()">
            <option value="admin">Admin — operasional penuh + keuangan</option>
            <option value="teknisi" selected>Teknisi — perangkat & maps</option>
            <option value="kolektor">Kolektor — pelanggan & pembayaran</option>
          </select>
          <div class="form-hint" id="iv-perm-hint"></div>
        </div>
        <div class="form-group full">
          <label class="form-label">Nama Lengkap</label>
          <input class="form-input" type="text" id="iv-nama" placeholder="cth: Budi Santoso">
        </div>
        <div class="form-group full">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" type="text" id="iv-username" placeholder="huruf kecil, tanpa spasi" autocapitalize="none">
        </div>
        <div class="form-group full">
          <label class="form-label">Password <span class="req">*</span></label>
          <div class="form-pwd-wrap">
            <input class="form-input" type="password" id="iv-password" placeholder="min. 6 karakter" autocomplete="new-password">
            <button type="button" class="form-pwd-toggle" onclick="togglePwd('iv-password','iv-eye')"><span class="material-symbols-outlined" id="iv-eye">visibility</span></button>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeForm()"><span class="material-symbols-outlined">close</span>Batal</button>
        <button class="btn-primary" id="iv-submit" onclick="submitInvite()"><span class="material-symbols-outlined">person_add</span>Buat Akun</button>
      </div>
    </div>`;
  const ov = document.getElementById('modal-form-overlay');
  ov.innerHTML = html; ov.classList.add('open');
  previewPerms();
  requestAnimationFrame(() => { const u = document.getElementById('iv-username'); if (u) u.focus(); });
}

function previewPerms() {
  const role = document.getElementById('iv-role') ? document.getElementById('iv-role').value : '';
  const map = {
    admin:    'Pelanggan, Perangkat, Maps, Keuangan, Tim',
    teknisi:  'Pelanggan, Perangkat, Maps (tanpa Keuangan)',
    kolektor: 'Lihat Pelanggan & Pembayaran saja',
  };
  const el = document.getElementById('iv-perm-hint');
  if (el) el.textContent = 'Hak akses: ' + (map[role] || '');
}

function closeForm() {
  const ov = document.getElementById('modal-form-overlay');
  ov.classList.remove('open'); ov.innerHTML = '';
}
function handleOverlayClick(e) { if (e.target === e.currentTarget) closeForm(); }

async function submitInvite() {
  const role     = document.getElementById('iv-role').value;
  const nama     = document.getElementById('iv-nama').value.trim();
  const username = document.getElementById('iv-username').value.trim();
  const password = document.getElementById('iv-password').value;
  if (!username) { toast('Username wajib diisi', 'warning'); return; }
  if (password.length < 6) { toast('Password minimal 6 karakter', 'warning'); return; }

  const btn = document.getElementById('iv-submit'); if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${TEAM_API}/invite`, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _hdr()),
      body: JSON.stringify({ username, password, role, nama }),
    });
    const d = await r.json();
    if (r.ok) { toast(d.message || 'Akun dibuat', 'success'); closeForm(); loadTeam(); }
    else toast(d.message || 'Gagal membuat akun', 'danger');
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) btn.disabled = false;
}

/* ── TOGGLE AKTIF ── */
function konfirmasiToggle(id) {
  const m = _members.find(x => x.id === id); if (!m) return;
  _toggleTarget = id;
  const aktif = m.aktif;
  document.getElementById('toggle-modal-icon').textContent = aktif ? 'person_off' : 'person_check';
  document.getElementById('toggle-modal-title').textContent = aktif ? 'Nonaktifkan User?' : 'Aktifkan User?';
  document.getElementById('toggle-modal-sub').textContent = aktif
    ? `"${m.username}" tidak akan bisa login sampai diaktifkan kembali.`
    : `"${m.username}" akan bisa login kembali.`;
  const b = document.getElementById('btn-konfirm-toggle');
  if (b) b.textContent = aktif ? 'Ya, Nonaktifkan' : 'Ya, Aktifkan';
  document.getElementById('modal-toggle-overlay').classList.add('open');
}
function closeKonfirmasiToggle(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('modal-toggle-overlay').classList.remove('open'); _toggleTarget = null;
}
async function eksekusiToggle() {
  if (!_toggleTarget) return;
  const r = await fetch(`${TEAM_API}/team/${_toggleTarget}/toggle`, { method: 'POST', credentials: 'include', headers: _hdr() });
  const d = await r.json();
  document.getElementById('modal-toggle-overlay').classList.remove('open');
  toast(r.ok ? (d.message || 'Status diubah') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
  _toggleTarget = null;
  if (r.ok) loadTeam();
}

/* ── HAPUS ── */
async function hapusUser(id, username) {
  if (!confirm(`Hapus anggota "${username}"? Tindakan ini permanen.`)) return;
  const r = await fetch(`${TEAM_API}/team/${id}`, { method: 'DELETE', credentials: 'include', headers: _hdr() });
  toast(r.ok ? 'Anggota dihapus' : 'Gagal menghapus', r.ok ? 'success' : 'danger');
  if (r.ok) loadTeam();
}

document.addEventListener('DOMContentLoaded', loadTeam);
