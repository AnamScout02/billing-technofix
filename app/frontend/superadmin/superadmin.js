/* superadmin.js — Panel Super Admin */
'use strict';

const ADMIN_API   = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/auth/admin';
const LOGIN_PAGE  = '/app/frontend/auth/admin_login.html';

/* Daftar paket (key→nama+harga) untuk dropdown aktivasi & label */
const PAKET = {
  trial:'Trial', starter:'Pemula', essential:'Esensial', standar:'Standar',
  pro:'Pro', advanced:'Lanjutan', business:'Bisnis', enterprise:'Enterprise',
};
const PAKET_BERBAYAR = ['starter','essential','standar','pro','advanced','business','enterprise'];

let _owners = [];
let _modalNid = null;

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmtTgl(iso){ if(!iso) return '-'; try{return new Date(iso).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});}catch{return '-';} }

/* Sel password perangkat — disamarkan, klik ikon mata untuk lihat/sembunyikan */
function pwCell(pw){
  return `<span class="sa-pw-wrap">
    <span class="sa-pw-mask" data-pw="${esc(pw)}">••••••••</span>
    <button class="sa-ico sa-ico-xs" onclick="togglePw(this)" title="Tampilkan/sembunyikan password">
      <span class="material-symbols-outlined">visibility</span>
    </button>
  </span>`;
}
function togglePw(btn){
  const span = btn.previousElementSibling;
  const icon = btn.querySelector('.material-symbols-outlined');
  const shown = span.dataset.shown === '1';
  if(shown){
    span.textContent = '••••••••';
    span.dataset.shown = '0';
    icon.textContent = 'visibility';
  }else{
    span.textContent = span.dataset.pw;
    span.dataset.shown = '1';
    icon.textContent = 'visibility_off';
  }
}

/* ── Auth check ── */
async function init(){
  try{
    const r = await fetch(`${ADMIN_API}/me`, { credentials:'include' });
    if(!r.ok){ window.location.replace(LOGIN_PAGE); return; }
    const me = await r.json();
    document.getElementById('sa-admin-name').textContent = me.username || 'admin';
  }catch{ window.location.replace(LOGIN_PAGE); return; }

  /* isi dropdown paket di modal */
  document.getElementById('sa-modal-paket').innerHTML =
    PAKET_BERBAYAR.map(k=>`<option value="${k}">${PAKET[k]}</option>`).join('');
  document.getElementById('sa-modal-confirm').onclick = doActivate;

  loadOwners();
  loadRequests();
  loadStats();
  loadSuperadmins();
  loadLogs();
  loadDevicesOverview();
  loadUsersAll();
}

/* ── Permintaan upgrade ── */
async function loadRequests() {
  try {
    const r = await fetch(`${ADMIN_API}/requests?status=pending`, { credentials: 'include' });
    const d = await r.json();
    const list = d.requests || [];
    const wrap = document.getElementById('sa-requests-wrap');
    const badge = document.getElementById('sa-req-badge');
    if (badge) badge.textContent = list.length;
    if (!list.length) { if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    document.getElementById('sa-requests').innerHTML = list.map(function (q) {
      return `<div class="sa-req">
        <div class="sa-req-info">
          <div class="sa-req-isp">${esc(q.isp_name)}</div>
          <div class="sa-req-sub">Ajukan paket <b>${esc(q.paket_nama)}</b> · ${q.bulan} bulan · ${fmtTgl(q.created_at)}</div>
        </div>
        <div class="sa-req-actions">
          <button class="sa-btn sa-btn-primary" onclick="approveReq(${q.id})"><span class="material-symbols-outlined">check_circle</span>Setujui & Aktifkan</button>
          <button class="sa-btn sa-btn-ghost" onclick="rejectReq(${q.id})"><span class="material-symbols-outlined">close</span>Tolak</button>
        </div>
      </div>`;
    }).join('');
  } catch { /* abaikan */ }
}

async function approveReq(id) {
  if (!confirm('Setujui permintaan ini? Paket owner akan langsung aktif.')) return;
  const r = await fetch(`${ADMIN_API}/requests/${id}/approve`, { method: 'POST', credentials: 'include' });
  const d = await r.json();
  toast(r.ok ? (d.message || 'Disetujui') : (d.message || 'Gagal'), r.ok ? 'success' : 'danger');
  if (r.ok) { loadRequests(); loadOwners(); }
}
async function rejectReq(id) {
  if (!confirm('Tolak permintaan upgrade ini?')) return;
  const r = await fetch(`${ADMIN_API}/requests/${id}/reject`, { method: 'POST', credentials: 'include' });
  toast(r.ok ? 'Permintaan ditolak' : 'Gagal', r.ok ? 'success' : 'danger');
  if (r.ok) loadRequests();
}

async function loadOwners(){
  try{
    const r = await fetch(`${ADMIN_API}/networks`, { credentials:'include' });
    const d = await r.json();
    _owners = d.networks || [];
    renderStats();
    renderTable(_owners);
    renderExpiringSoon();
    renderDevicesTab();
  }catch{
    document.getElementById('sa-tbody').innerHTML =
      '<tr><td colspan="7" class="sa-loading">Gagal memuat data.</td></tr>';
  }
}

function renderStats(){
  const c={active:0,trial:0,locked:0};
  _owners.forEach(o=>{ const s=o.status_efektif; if(s==='active')c.active++; else if(s==='trial')c.trial++; else c.locked++; });
  document.getElementById('st-total').textContent  = _owners.length;
  document.getElementById('st-active').textContent = c.active;
  document.getElementById('st-trial').textContent  = c.trial;
  document.getElementById('st-locked').textContent = c.locked;
}

/* ── Owner akan segera expired (≤7 hari) ── */
function renderExpiringSoon(){
  const wrap  = document.getElementById('sa-expiring-wrap');
  const list  = document.getElementById('sa-expiring-list');
  const badge = document.getElementById('sa-expiring-badge');
  if (!wrap || !list) return;

  const now = Date.now();
  const soon = [];
  _owners.forEach(o=>{
    const s = o.status_efektif;
    if (s !== 'active' && s !== 'trial') return;
    const tgl = s === 'trial' ? o.trial_end : o.expired_at;
    if (!tgl) return;
    const sisaHari = Math.ceil((new Date(tgl).getTime() - now) / 86400000);
    if (sisaHari >= 0 && sisaHari <= 7) soon.push({ o, s, sisaHari });
  });
  soon.sort((a,b)=>a.sisaHari-b.sisaHari);

  if (!soon.length){ wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (badge) badge.textContent = soon.length;

  list.innerHTML = soon.map(({o,s,sisaHari})=>{
    const nid = esc(o.network_id);
    const label = s === 'trial' ? 'Trial' : 'Paket ' + esc(o.paket_nama||o.paket);
    const sisaTxt = sisaHari === 0 ? 'berakhir hari ini' : `${sisaHari} hari lagi`;
    const action = s === 'trial'
      ? `<button class="sa-btn sa-btn-ghost" onclick="extendTrial('${nid}')"><span class="material-symbols-outlined">more_time</span>Perpanjang Trial</button>`
      : `<button class="sa-btn sa-btn-primary" onclick="openActivate('${nid}')"><span class="material-symbols-outlined">bolt</span>Perpanjang Paket</button>`;
    return `<div class="sa-req sa-req-expiring">
      <div class="sa-req-info">
        <div class="sa-req-isp">${esc(o.isp_name)}</div>
        <div class="sa-req-sub">${label} · berakhir ${fmtTgl(s==='trial'?o.trial_end:o.expired_at)} · <b>${sisaTxt}</b></div>
      </div>
      <div class="sa-req-actions">${action}</div>
    </div>`;
  }).join('');
}

function renderTable(list){
  const tb = document.getElementById('sa-tbody');
  if(!list.length){ tb.innerHTML='<tr><td colspan="9" class="sa-loading">Belum ada owner.</td></tr>'; return; }
  tb.innerHTML = list.map(o=>{
    const s = o.status_efektif;
    const badge = `<span class="sa-badge ${s}"><span class="dot"></span>${({trial:'Trial',active:'Aktif',locked:'Terkunci',suspended:'Disuspend'}[s]||s)}</span>`;
    const berlaku = s==='trial' ? ('Trial: '+fmtTgl(o.trial_end)) : (o.expired_at?fmtTgl(o.expired_at):'-');
    const nid = esc(o.network_id);
    return `<tr>
      <td><div class="sa-isp">${esc(o.isp_name)}</div><div class="sa-isp-id">${nid.slice(0,8)}…</div></td>
      <td><span class="sa-pkg">${esc(o.paket_nama||o.paket)}</span></td>
      <td>${badge}</td>
      <td>${o.jumlah_user}</td>
      <td>${o.jumlah_user_aktif} aktif</td>
      <td>${o.jumlah_pelanggan ?? 0}</td>
      <td>${berlaku}</td>
      <td>${fmtTgl(o.created_at)}</td>
      <td class="ta-right"><div class="sa-actions">
        <button class="sa-ico" title="Lihat detail" onclick="openDetail('${nid}')"><span class="material-symbols-outlined">visibility</span></button>
        <button class="sa-ico green" title="Aktifkan paket" onclick="openActivate('${nid}')"><span class="material-symbols-outlined">bolt</span></button>
        <button class="sa-ico amber" title="Perpanjang trial" onclick="extendTrial('${nid}')"><span class="material-symbols-outlined">more_time</span></button>
        ${ s==='suspended'
          ? `<button class="sa-ico green" title="Cabut suspend" onclick="unsuspend('${nid}')"><span class="material-symbols-outlined">lock_open</span></button>`
          : `<button class="sa-ico" title="Suspend" onclick="suspend('${nid}')"><span class="material-symbols-outlined">block</span></button>` }
        <button class="sa-ico" title="Reset password owner" onclick="resetPassword('${nid}','${esc(o.isp_name)}')"><span class="material-symbols-outlined">key</span></button>
        <button class="sa-ico red" title="Hapus owner" onclick="hapus('${nid}','${esc(o.isp_name)}')"><span class="material-symbols-outlined">delete</span></button>
      </div></td>
    </tr>`;
  }).join('');
}

function filterOwners(){
  const q = document.getElementById('sa-search').value.toLowerCase().trim();
  renderTable(q ? _owners.filter(o=>(o.isp_name||'').toLowerCase().includes(q)) : _owners);
}

/* ── Aktivasi paket ── */
function openActivate(nid){
  _modalNid = nid;
  const o = _owners.find(x=>x.network_id===nid);
  document.getElementById('sa-modal-owner').textContent = o ? o.isp_name : nid;
  if(o && PAKET_BERBAYAR.includes(o.paket)) document.getElementById('sa-modal-paket').value = o.paket;
  document.getElementById('sa-modal').classList.add('open');
}
function closeModal(e){ if(e && e.target!==e.currentTarget && e.type==='click' && !e.target.closest('.sa-x')) {} document.getElementById('sa-modal').classList.remove('open'); }

async function doActivate(){
  const paket = document.getElementById('sa-modal-paket').value;
  const bulan = document.getElementById('sa-modal-bulan').value;
  const btn = document.getElementById('sa-modal-confirm'); btn.disabled=true;
  try{
    const r = await fetch(`${ADMIN_API}/networks/${_modalNid}/activate`, {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ paket, bulan: Number(bulan) }),
    });
    const d = await r.json();
    if(r.ok){ toast(d.message||'Paket diaktifkan','success'); closeModal(); loadOwners(); }
    else toast(d.message||'Gagal','danger');
  }catch{ toast('Tidak bisa menghubungi server','danger'); }
  btn.disabled=false;
}

async function extendTrial(nid){
  const hari = prompt('Perpanjang trial berapa hari?', '7');
  if(!hari) return;
  const r = await fetch(`${ADMIN_API}/networks/${nid}/extend-trial`, {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ hari: Number(hari) }),
  });
  const d = await r.json();
  toast(r.ok?(d.message||'Trial diperpanjang'):(d.message||'Gagal'), r.ok?'success':'danger');
  if(r.ok) loadOwners();
}

async function suspend(nid){
  if(!confirm('Suspend owner ini? Akses datanya akan diblokir.')) return;
  const r = await fetch(`${ADMIN_API}/networks/${nid}/suspend`, { method:'POST', credentials:'include' });
  toast(r.ok?'Owner disuspend':'Gagal', r.ok?'success':'danger'); if(r.ok) loadOwners();
}
async function unsuspend(nid){
  const r = await fetch(`${ADMIN_API}/networks/${nid}/unsuspend`, { method:'POST', credentials:'include' });
  toast(r.ok?'Suspend dicabut':'Gagal', r.ok?'success':'danger'); if(r.ok) loadOwners();
}

async function hapus(nid, nama){
  if(!confirm(`Hapus owner "${nama}" beserta SEMUA datanya? Tindakan ini permanen.`)) return;
  const r = await fetch(`${ADMIN_API}/networks/${nid}`, { method:'DELETE', credentials:'include' });
  toast(r.ok?'Owner dihapus':'Gagal menghapus', r.ok?'success':'danger'); if(r.ok) loadOwners();
}

/* ── Export daftar owner ke CSV ── */
function exportOwnersCSV(){
  if(!_owners.length){ toast('Belum ada data owner untuk diexport','danger'); return; }
  const header = ['ISP','Network ID','Paket','Status','Status Efektif','Jumlah Tim','Tim Aktif','Jumlah Pelanggan','Trial Sampai','Berlaku Sampai','Terdaftar'];
  const csvEsc = v => `"${String(v==null?'':v).replace(/"/g,'""')}"`;
  const rows = _owners.map(o => [
    o.isp_name, o.network_id, o.paket_nama||o.paket, o.status, o.status_efektif,
    o.jumlah_user, o.jumlah_user_aktif, o.jumlah_pelanggan ?? 0,
    o.trial_end||'', o.expired_at||'', o.created_at||'',
  ].map(csvEsc).join(','));
  const csv = '﻿sep=,\r\n' + [header.map(csvEsc).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `owners-technofix-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Reset password owner ── */
let _lastResetPw = '';
async function resetPassword(nid, nama){
  if(!confirm(`Reset password akun owner "${nama}"? Sesi login owner ini di semua perangkat akan dihapus.`)) return;
  const r = await fetch(`${ADMIN_API}/networks/${nid}/reset-password`, { method:'POST', credentials:'include' });
  const d = await r.json();
  if(!r.ok){ toast(d.message||'Gagal reset password','danger'); return; }
  _lastResetPw = d.password;
  document.getElementById('sa-resetpw-username').textContent = d.username;
  document.getElementById('sa-resetpw-password').textContent = d.password;
  document.getElementById('sa-resetpw-modal').classList.add('open');
  loadLogs();
}
function closeResetPwModal(e){ if(e && e.target!==e.currentTarget) return; document.getElementById('sa-resetpw-modal').classList.remove('open'); }
async function copyResetPw(){
  try{ await navigator.clipboard.writeText(_lastResetPw); toast('Password disalin','success'); }
  catch{ toast('Gagal menyalin','danger'); }
}

/* ── Perangkat (MikroTik & OLT) + User — diambil sekali, ditampilkan per-ISP ── */
let _devMikrotik = [];
let _devOlt      = [];
let _devUsers    = [];

async function loadDevicesOverview(){
  try{
    const r = await fetch(`${ADMIN_API}/devices-overview`, { credentials:'include' });
    const d = await r.json();
    if(!r.ok) return;
    _devMikrotik = d.mikrotik || [];
    _devOlt      = d.olt || [];
    renderDevicesTab();
  }catch{
    document.getElementById('dv-mikrotik-tbody').innerHTML = '<tr><td colspan="3" class="sa-loading">Gagal memuat data.</td></tr>';
    document.getElementById('dv-olt-tbody').innerHTML = '<tr><td colspan="4" class="sa-loading">Gagal memuat data.</td></tr>';
  }
}

async function loadUsersAll(){
  try{
    const r = await fetch(`${ADMIN_API}/users`, { credentials:'include' });
    const d = await r.json();
    if(!r.ok) return;
    _devUsers = d.users || [];
    renderDevicesTab();
  }catch{
    document.getElementById('dv-users-tbody').innerHTML = '<tr><td colspan="4" class="sa-loading">Gagal memuat data.</td></tr>';
  }
}

/* Isi dropdown ISP (mempertahankan pilihan jika masih valid) lalu render */
function renderDevicesTab(){
  const sel = document.getElementById('dv-owner-select');
  if(!sel || !_owners.length) return;
  const current = sel.value;
  const sorted = [..._owners].sort((a,b)=>(a.isp_name||'').localeCompare(b.isp_name||''));
  sel.innerHTML = sorted.map(o=>`<option value="${esc(o.network_id)}">${esc(o.isp_name)}</option>`).join('');
  sel.value = (current && sorted.some(o=>o.network_id===current)) ? current : sorted[0].network_id;
  filterDevicesByOwner();
}

/* Tampilkan perangkat & user untuk ISP yang dipilih saja */
function filterDevicesByOwner(){
  const sel = document.getElementById('dv-owner-select');
  const nid = sel ? sel.value : '';
  const owner = _owners.find(o=>o.network_id===nid);

  const mt    = _devMikrotik.filter(m=>m.network_id===nid);
  const olt   = _devOlt.filter(o=>o.network_id===nid);
  const users = _devUsers.filter(u=>u.network_id===nid);

  document.getElementById('dv-mikrotik').textContent  = mt.length;
  document.getElementById('dv-olt').textContent       = olt.length;
  document.getElementById('dv-users').textContent     = users.length;
  document.getElementById('dv-pelanggan').textContent = owner ? (owner.jumlah_pelanggan ?? 0) : 0;

  const mtTb = document.getElementById('dv-mikrotik-tbody');
  mtTb.innerHTML = mt.length ? mt.map(m => `
    <tr>
      <td>${esc(m.name)}</td>
      <td>${esc(m.ip)}</td>
      <td>${esc(m.port)}</td>
      <td>${esc(m.username)}</td>
      <td>${pwCell(m.password)}</td>
      <td><span class="sa-badge ${esc(m.status)}"><span class="dot"></span>${esc(m.status)}</span></td>
    </tr>`).join('') : '<tr><td colspan="6" class="sa-loading">Belum ada perangkat MikroTik.</td></tr>';

  const oltTb = document.getElementById('dv-olt-tbody');
  oltTb.innerHTML = olt.length ? olt.map(o => `
    <tr>
      <td>${esc(o.name)}</td>
      <td>${esc(o.tipe)||'-'}</td>
      <td>${esc(o.ip)}</td>
      <td>${esc(o.port)}</td>
      <td>${esc(o.username)}</td>
      <td>${pwCell(o.password)}</td>
      <td><span class="sa-badge ${esc(o.status)}"><span class="dot"></span>${esc(o.status)}</span></td>
    </tr>`).join('') : '<tr><td colspan="7" class="sa-loading">Belum ada perangkat OLT.</td></tr>';

  const usersTb = document.getElementById('dv-users-tbody');
  usersTb.innerHTML = users.length ? users.map(u => `
    <tr>
      <td>${esc(u.username)}</td>
      <td>${esc(u.nama)||'-'}</td>
      <td>${esc(u.role)}</td>
      <td>${(u.aktif===null||u.aktif===1) ? 'Aktif' : 'Nonaktif'}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="sa-loading">Belum ada user.</td></tr>';
}

/* ── Statistik pendapatan & distribusi paket ── */
function fmtRupiah(n){ return 'Rp ' + Number(n||0).toLocaleString('id-ID'); }

async function loadStats(){
  try{
    const r = await fetch(`${ADMIN_API}/stats`, { credentials:'include' });
    const d = await r.json();
    if(!r.ok) return;
    document.getElementById('rv-mrr').textContent  = fmtRupiah(d.mrr);
    document.getElementById('rv-paid').textContent = d.paid_owners;
    document.getElementById('rv-arpu').textContent = fmtRupiah(d.arpu);
    const wrap = document.getElementById('sa-pkg-chips');
    if(!d.distribusi || !d.distribusi.length){
      wrap.innerHTML = '<div class="sa-loading">Belum ada owner berlangganan paket berbayar.</div>';
      return;
    }
    wrap.innerHTML = d.distribusi.map(p => `
      <div class="sa-req">
        <div class="sa-req-info">
          <div class="sa-req-isp">${esc(p.paket_nama)}</div>
          <div class="sa-req-sub">${p.jumlah} owner × ${fmtRupiah(p.harga)} = ${fmtRupiah(p.subtotal)} /bln</div>
        </div>
      </div>`).join('');
    /* render visual bar chart */
    if (typeof renderPkgBarChart === 'function') {
      renderPkgBarChart(d.distribusi.map(p => ({ paket: p.paket_nama, count: p.jumlah })));
    }
  }catch{ /* abaikan */ }
}

/* ── Manajemen akun Super Admin ── */
let _admins = [];

async function loadSuperadmins(){
  try{
    const r = await fetch(`${ADMIN_API}/superadmins`, { credentials:'include' });
    const d = await r.json();
    _admins = d.admins || [];
    renderAdminTable();
  }catch{
    document.getElementById('sa-admin-tbody').innerHTML =
      '<tr><td colspan="4" class="sa-loading">Gagal memuat data.</td></tr>';
  }
}

function renderAdminTable(){
  const tb = document.getElementById('sa-admin-tbody');
  if(!_admins.length){ tb.innerHTML = '<tr><td colspan="4" class="sa-loading">Belum ada akun.</td></tr>'; return; }
  tb.innerHTML = _admins.map(a => `
    <tr>
      <td>${esc(a.username)}</td>
      <td>${fmtTgl(a.created_at)}</td>
      <td>${a.last_login ? fmtTgl(a.last_login) : '-'}</td>
      <td class="ta-right"><div class="sa-actions">
        <button class="sa-ico red" title="Hapus akun" onclick="deleteSuperadmin(${a.id},'${esc(a.username)}')"><span class="material-symbols-outlined">delete</span></button>
      </div></td>
    </tr>`).join('');
}

function openAddSuperadmin(){
  document.getElementById('sa-admin-username').value = '';
  document.getElementById('sa-admin-password').value = '';
  document.getElementById('sa-admin-modal').classList.add('open');
}
function closeAdminModal(e){ if(e && e.target!==e.currentTarget) return; document.getElementById('sa-admin-modal').classList.remove('open'); }

async function doAddSuperadmin(){
  const username = document.getElementById('sa-admin-username').value.trim();
  const password = document.getElementById('sa-admin-password').value.trim();
  if(!username) return toast('Username wajib diisi','danger');
  if(password.length < 6) return toast('Password minimal 6 karakter','danger');
  const btn = document.getElementById('sa-admin-confirm'); btn.disabled = true;
  try{
    const r = await fetch(`${ADMIN_API}/superadmins`, {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if(r.ok){ toast(d.message||'Akun ditambahkan','success'); closeAdminModal(); loadSuperadmins(); loadLogs(); }
    else toast(d.message||'Gagal','danger');
  }catch{ toast('Tidak bisa menghubungi server','danger'); }
  btn.disabled = false;
}

async function deleteSuperadmin(id, username){
  if(!confirm(`Hapus akun superadmin "${username}"?`)) return;
  const r = await fetch(`${ADMIN_API}/superadmins/${id}`, { method:'DELETE', credentials:'include' });
  const d = await r.json();
  toast(r.ok?(d.message||'Akun dihapus'):(d.message||'Gagal'), r.ok?'success':'danger');
  if(r.ok){ loadSuperadmins(); loadLogs(); }
}

/* ── Log aktivitas ── */
async function loadLogs(){
  try{
    const r = await fetch(`${ADMIN_API}/logs`, { credentials:'include' });
    const d = await r.json();
    const tb = document.getElementById('sa-log-tbody');
    const list = d.logs || [];
    if(!list.length){ tb.innerHTML = '<tr><td colspan="5" class="sa-loading">Belum ada aktivitas.</td></tr>'; return; }
    tb.innerHTML = list.map(l => `
      <tr>
        <td>${fmtTgl(l.created_at)}</td>
        <td>${esc(l.admin)}</td>
        <td>${esc(l.aksi)}</td>
        <td>${esc(l.target)||'-'}</td>
        <td>${esc(l.detail)||'-'}</td>
      </tr>`).join('');
  }catch{
    document.getElementById('sa-log-tbody').innerHTML =
      '<tr><td colspan="5" class="sa-loading">Gagal memuat log.</td></tr>';
  }
}

/* ── Detail / drill-down owner ── */
async function openDetail(nid){
  const modal = document.getElementById('sa-detail-modal');
  const body  = document.getElementById('sa-detail-body');
  body.innerHTML = '<div class="sa-loading"><span class="material-symbols-outlined spin">progress_activity</span> Memuat…</div>';
  modal.classList.add('open');
  try{
    const r = await fetch(`${ADMIN_API}/networks/${nid}/detail`, { credentials:'include' });
    const d = await r.json();
    if(!r.ok){ body.innerHTML = `<div class="sa-loading">${esc(d.message||'Gagal memuat detail')}</div>`; return; }
    const teamRows = (d.team||[]).map(u => `
      <tr>
        <td>${esc(u.nama || u.username)}</td>
        <td>${esc(u.role)}</td>
        <td>${(u.aktif===null || u.aktif===1) ? 'Aktif' : 'Nonaktif'}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="sa-loading">Belum ada anggota tim.</td></tr>';
    body.innerHTML = `
      <div class="sa-owner-chip">${esc(d.isp_name)}</div>
      <div class="sa-form-row" style="margin-top:14px">
        <div class="sa-form-group"><label class="sa-label">Paket</label><div>${esc(d.paket)}</div></div>
        <div class="sa-form-group"><label class="sa-label">Status</label><div>${esc(d.status)}</div></div>
        <div class="sa-form-group"><label class="sa-label">Terdaftar</label><div>${fmtTgl(d.created_at)}</div></div>
      </div>
      <div class="sa-form-row" style="margin-top:6px">
        <div class="sa-form-group"><label class="sa-label">Jumlah Pelanggan</label><div>${d.jumlah_pelanggan}</div></div>
        <div class="sa-form-group"><label class="sa-label">Jumlah Perangkat</label><div>${d.jumlah_perangkat}</div></div>
        <div class="sa-form-group"><label class="sa-label">Anggota Tim</label><div>${(d.team||[]).length}</div></div>
      </div>
      <label class="sa-label" style="margin-top:14px;display:block">Anggota Tim</label>
      <div class="sa-table-wrap"><table class="sa-table">
        <thead><tr><th>Nama</th><th>Peran</th><th>Status</th></tr></thead>
        <tbody>${teamRows}</tbody>
      </table></div>`;
  }catch{
    body.innerHTML = '<div class="sa-loading">Tidak bisa menghubungi server</div>';
  }
}
function closeDetailModal(e){ if(e && e.target!==e.currentTarget) return; document.getElementById('sa-detail-modal').classList.remove('open'); }

async function adminLogout(){
  try{ await fetch(`${ADMIN_API}/logout`, { method:'POST', credentials:'include' }); }catch{}
  window.location.replace(LOGIN_PAGE);
}

document.addEventListener('DOMContentLoaded', init);
