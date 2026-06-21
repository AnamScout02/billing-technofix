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
  perangkat_manage: 'Kelola Perangkat', maps: 'Maps', keuangan: 'Keuangan',
  manajemen_user: 'Tim', bayar: 'Pembayaran', langganan: 'Langganan',
};

let _members = [];
let _toggleTarget = null;
let _maxDevicesPkgLimit = null;

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtTgl(iso) { if (!iso) return '-'; try { return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '-'; } }

/* ── LOAD ── */
async function loadTeam() {
  try {
    const r = await fetch(`${TEAM_API}/team`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { renderError('Anda tidak punya akses ke Manajemen User.'); return; }
    const d = await r.json();
    _members = d.members || [];
    _maxDevicesPkgLimit = (typeof d.max_devices_pkg_limit === 'number') ? d.max_devices_pkg_limit : null;
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
           <button class="ico-btn blue" title="Atur batas perangkat (saat ini ${m.max_devices})" onclick="bukaMaxDevices(${m.id})">
             <span class="material-symbols-outlined">devices</span></button>
           <button class="ico-btn ${m.aktif ? 'amber' : 'green'}" title="${m.aktif ? 'Nonaktifkan' : 'Aktifkan'}" onclick="konfirmasiToggle(${m.id})">
             <span class="material-symbols-outlined">${m.aktif ? 'person_off' : 'person_check'}</span></button>
           <button class="ico-btn blue" title="Reset Password" onclick="resetTeamPassword(${m.id},'${esc(m.username)}')">
             <span class="material-symbols-outlined">key</span></button>
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

/* ── BATAS PERANGKAT ── */
let _maxDevTarget = null;
function bukaMaxDevices(id) {
  const m = _members.find(x => x.id === id); if (!m) return;
  _maxDevTarget = id;
  const batasAtas = _maxDevicesPkgLimit || 5;
  document.getElementById('maxdev-sub').textContent =
    `Atur jumlah perangkat yang bisa login bersamaan untuk akun "${m.username}". `
    + `Maksimal ${batasAtas} perangkat sesuai jatah paket langganan saat ini — upgrade paket untuk jatah lebih besar.`;
  const input = document.getElementById('maxdev-input');
  input.value = Math.min(m.max_devices || 2, batasAtas);
  input.max = batasAtas;
  document.getElementById('modal-maxdev').classList.add('open');
}
function closeModalMaxDevices(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('modal-maxdev').classList.remove('open');
  _maxDevTarget = null;
}
async function eksekusiMaxDevices() {
  if (!_maxDevTarget) return;
  const input = document.getElementById('maxdev-input');
  const nilai = parseInt(input.value, 10);
  const batasAtas = _maxDevicesPkgLimit || 5;
  if (!Number.isInteger(nilai) || nilai < 1 || nilai > batasAtas) {
    toast(`Jumlah perangkat harus angka 1-${batasAtas} (sesuai jatah paket)`, 'danger');
    return;
  }
  const btn = document.getElementById('btn-konfirm-maxdev');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${TEAM_API}/team/${_maxDevTarget}/max-devices`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ..._hdr() },
      body: JSON.stringify({ max_devices: nilai }),
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Batas perangkat diubah' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeModalMaxDevices(); loadTeam(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) btn.disabled = false;
}

/* ── HAPUS ── */
let _hapusTarget = null;
function hapusUser(id, username) {
  _hapusTarget = id;
  const sub = document.getElementById('hapus-sub-text');
  if (sub) sub.textContent = `Akun "${username}" akan dihapus permanen dan tidak dapat login kembali.`;
  document.getElementById('modal-hapus-overlay').classList.add('open');
}
function closeModalHapus(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('modal-hapus-overlay').classList.remove('open');
  _hapusTarget = null;
}
async function eksekusiHapus() {
  if (!_hapusTarget) return;
  const id = _hapusTarget;
  const btn = document.getElementById('btn-konfirm-hapus');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`${TEAM_API}/team/${id}`, { method: 'DELETE', credentials: 'include', headers: _hdr() });
    const d = await r.json();
    toast(r.ok ? (d.message || 'Anggota dihapus') : (d.message || 'Gagal menghapus'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeModalHapus(); loadTeam(); loadAuditLog(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  if (btn) btn.disabled = false;
}

/* ── RESET PASSWORD ANGGOTA TIM ── */
let _lastTeamResetPw = '';
async function resetTeamPassword(id, username) {
  if (!(await tfConfirm(`Reset password akun "${username}"? Sesi login user ini di semua perangkat akan dihapus.`, { icon: 'lock_reset' }))) return;
  try {
    const r = await fetch(`${TEAM_API}/team/${id}/reset-password`, { method: 'POST', credentials: 'include', headers: _hdr() });
    const d = await r.json();
    if (!r.ok) { toast(d.message || 'Gagal reset password', 'danger'); return; }
    _lastTeamResetPw = d.password;
    document.getElementById('mu-resetpw-username').textContent = d.username;
    document.getElementById('mu-resetpw-password').textContent = d.password;
    document.getElementById('mu-resetpw-modal').classList.add('open');
    loadAuditLog();
  } catch (e) { toast('Tidak bisa menghubungi server', 'danger'); }
}
function closeTeamResetPwModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('mu-resetpw-modal').classList.remove('open');
}
async function copyTeamResetPw() {
  try { await navigator.clipboard.writeText(_lastTeamResetPw); toast('Password disalin', 'success'); }
  catch { toast('Gagal menyalin', 'danger'); }
}

/* ── LOG AKTIVITAS ── */
const AUDIT_ICON = {
  invite:            { icon: 'person_add',   cls: 'green' },
  aktifkan_user:     { icon: 'person_check', cls: 'green' },
  nonaktifkan_user:  { icon: 'person_off',   cls: 'amber' },
  ubah_max_devices:  { icon: 'devices',      cls: 'blue' },
  hapus_user:        { icon: 'person_remove', cls: 'red' },
  reset_password_user: { icon: 'key',        cls: 'blue' },
};
const AUDIT_LABEL = {
  invite:           (a, t, d) => `<b>${esc(a)}</b> menambahkan anggota <b>${esc(t)}</b>${d ? ` (${esc(d)})` : ''}`,
  aktifkan_user:    (a, t)    => `<b>${esc(a)}</b> mengaktifkan akun <b>${esc(t)}</b>`,
  nonaktifkan_user: (a, t)    => `<b>${esc(a)}</b> menonaktifkan akun <b>${esc(t)}</b>`,
  ubah_max_devices: (a, t, d) => `<b>${esc(a)}</b> mengubah batas perangkat <b>${esc(t)}</b>${d ? ` (${esc(d)})` : ''}`,
  hapus_user:       (a, t, d) => `<b>${esc(a)}</b> menghapus akun <b>${esc(t)}</b>${d ? ` (${esc(d)})` : ''}`,
  reset_password_user: (a, t) => `<b>${esc(a)}</b> mereset password akun <b>${esc(t)}</b>`,
};
function fmtTglWaktu(iso) {
  if (!iso) return '-';
  try {
    const dt = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(dt)) return esc(iso);
    return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch { return esc(iso); }
}
async function loadAuditLog() {
  const wrap = document.getElementById('audit-list');
  if (!wrap) return;
  try {
    const r = await fetch(`${TEAM_API}/audit-log?limit=50`, { credentials: 'include', headers: _hdr() });
    if (!r.ok) { wrap.innerHTML = '<div class="state-box"><p class="state-title">Gagal memuat log aktivitas.</p></div>'; return; }
    const d = await r.json();
    const logs = d.logs || [];
    if (!logs.length) {
      wrap.innerHTML = '<div class="state-box"><p class="state-title">Belum ada aktivitas tercatat.</p></div>';
      return;
    }
    wrap.innerHTML = logs.map(l => {
      const ic = AUDIT_ICON[l.action] || { icon: 'history', cls: '' };
      const labelFn = AUDIT_LABEL[l.action];
      const text = labelFn ? labelFn(l.actor, l.target, l.detail) : `<b>${esc(l.actor)}</b> ${esc(l.action)} ${esc(l.target)}`;
      return `<div class="audit-row">
        <div class="audit-icon ${ic.cls}"><span class="material-symbols-outlined">${ic.icon}</span></div>
        <div class="audit-body">
          <div class="audit-text">${text}</div>
          <div class="audit-time">${fmtTglWaktu(l.created_at)}</div>
        </div>
      </div>`;
    }).join('');
  } catch {
    wrap.innerHTML = '<div class="state-box"><p class="state-title">Tidak bisa menghubungi server.</p></div>';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  loadTeam();
  loadAuditLog();
});
