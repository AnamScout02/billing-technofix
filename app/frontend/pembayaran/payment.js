/* payment.js — Pembayaran Online */
'use strict';

const PG_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/payment';
const LK_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/loket';
const TG_API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/tagihan';
let _cfg = {};
let _debTimer = null;
let _selectedBtIds = new Set();

function _hdr() { return (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {}; }
function _jhdr() { return Object.assign({ 'Content-Type': 'application/json' }, _hdr()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rp(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtTgl(s) { if (!s) return '-'; try { return new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return esc(s); } }
function periodeNow() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

function switchTab(t) {
  ['buat','tx','rekening'].forEach(id => {
    const tab = document.getElementById('tab-' + id);
    const panel = document.getElementById('panel-' + id);
    if (tab) tab.classList.toggle('active', t === id);
    if (panel) panel.style.display = t === id ? '' : 'none';
  });
  if (t === 'tx') loadTx();
  if (t === 'rekening') loadRekening();
}

// ── Rekening Bank ──────────────────────────────────────────────
let _rekening = [];

async function loadRekening() {
  try {
    const r = await fetch(`${PG_API}/rekening`, { credentials: 'include', headers: _hdr() });
    const d = await r.json();
    _rekening = d.rekening || [];
    renderRekening();
  } catch { toast('Gagal memuat rekening', 'danger'); }
}

function renderRekening() {
  const el = document.getElementById('rekening-list');
  if (!el) return;
  if (!_rekening.length) {
    el.innerHTML = '<p style="font-size:13px;color:var(--text-dim);">Belum ada rekening. Klik tombol di bawah.</p>';
    return;
  }
  el.innerHTML = _rekening.map((r, i) => `
    <div class="rekening-card" id="rek-row-${i}" style="display:flex;gap:10px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 16px;">
      <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">BANK / E-WALLET</div>
          <input class="filter-select" style="width:100%;height:36px" type="text" value="${esc(r.bank||'')}" placeholder="BCA, BRI, OVO…" oninput="_rekening[${i}].bank=this.value" />
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">NOMOR REKENING</div>
          <input class="filter-select" style="width:100%;height:36px" type="text" value="${esc(r.nomor||'')}" placeholder="0123456789" oninput="_rekening[${i}].nomor=this.value" />
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">ATAS NAMA</div>
          <input class="filter-select" style="width:100%;height:36px" type="text" value="${esc(r.nama||'')}" placeholder="Nama pemilik rekening" oninput="_rekening[${i}].nama=this.value" />
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">KETERANGAN (opsional)</div>
          <input class="filter-select" style="width:100%;height:36px" type="text" value="${esc(r.ket||'')}" placeholder="Transfer 24 jam…" oninput="_rekening[${i}].ket=this.value" />
        </div>
      </div>
      <button onclick="removeRekening(${i})" style="background:var(--red-bg,#fdecec);border:1px solid var(--red);color:var(--red);border-radius:8px;padding:6px 8px;cursor:pointer;flex-shrink:0;">
        <span class="material-symbols-outlined" style="font-size:17px;">delete</span>
      </button>
    </div>`).join('');
}

function addRekeningRow() {
  _rekening.push({ bank: '', nomor: '', nama: '', ket: '' });
  renderRekening();
}

function removeRekening(i) {
  _rekening.splice(i, 1);
  renderRekening();
}

async function saveRekening() {
  const btn = document.getElementById('btn-save-rekening'); btn.disabled = true;
  try {
    const r = await fetch(`${PG_API}/rekening`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ rekening: _rekening }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

async function loadConfig() {
  try {
    const r = await fetch(`${PG_API}/config`, { credentials: 'include', headers: _hdr() });
    const d = await r.json(); _cfg = d.config || {};
    renderBanner();
  } catch {}
}
function renderBanner() {
  const b = document.getElementById('mode-banner');
  if (_cfg.enabled && _cfg.has_server_key) {
    b.className = 'mode-banner mode-live'; b.style.display = 'flex';
    b.innerHTML = `<span class="material-symbols-outlined">cloud_done</span>Gateway ${esc(_cfg.provider || '')} (${esc(_cfg.mode || '')}) aktif.`;
  } else {
    b.className = 'mode-banner mode-mock'; b.style.display = 'flex';
    b.innerHTML = '<span class="material-symbols-outlined">info</span>Gateway belum aktif — link dummy. Gunakan "Konfirmasi Bayar Manual" untuk menutup transaksi.';
  }
}

// ── Buat pembayaran (tagihan belum lunas) ──────────────────────
function debLoad() { clearTimeout(_debTimer); _debTimer = setTimeout(loadUnpaid, 300); }
async function loadUnpaid() {
  const q = (document.getElementById('bt-search').value || '').trim();
  const periode = document.getElementById('bt-periode').value || '';
  const tb = document.getElementById('bt-tbody');
  tb.innerHTML = '<tr><td colspan="8"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  _selectedBtIds.clear();
  _updateBtBulkToolbar();
  const cbAll = document.getElementById('bt-cb-all');
  if (cbAll) cbAll.checked = false;
  try {
    const qs = new URLSearchParams(); if (q) qs.set('q', q); if (periode) qs.set('periode', periode);
    const r = await fetch(`${LK_API}/tagihan?${qs}`, { credentials: 'include', headers: _hdr() });
    if (r.status === 403) { tb.innerHTML = stateRow(8, 'Anda tidak punya akses.'); return; }
    const d = await r.json(); const list = d.tagihan || [];
    const cnt = document.getElementById('bt-count');
    if (!list.length) { tb.innerHTML = stateRow(8, 'Tidak ada tagihan belum lunas.'); if (cnt) cnt.textContent = '0 tagihan'; return; }
    if (cnt) cnt.textContent = list.length + ' tagihan';
    tb.innerHTML = list.map((t, i) => `<tr>
      <td class="sticky-col-0"><input type="checkbox" class="bt-cb-row" data-id="${t.id}" data-nominal="${t.nominal}"
        onchange="toggleBtSelect(${t.id},this.checked)" /></td>
      <td class="sticky-col-1">${i + 1}</td>
      <td class="sticky-col-2"><div class="pg-name">${esc(t.nama)}</div><div class="pg-sub">@${esc(t.username)}</div></td>
      <td><span class="pg-chip">${esc(t.profil || '-')}</span></td>
      <td>${esc(t.periode)}</td>
      <td class="pg-nominal">${rp(t.nominal)}</td>
      <td>${esc(fmtTgl(t.jatuh_tempo))}</td>
      <td><button class="btn-link" onclick="createLink(${t.id})"><span class="material-symbols-outlined">add_link</span>Buat Link</button></td>
    </tr>`).join('');
    _injectBtBulkToolbar();
  } catch { tb.innerHTML = stateRow(8, 'Gagal memuat tagihan.'); }
}

// ── Bulk select & bayar massal (Cash) ──────────────────────────
function toggleBtSelect(id, checked) {
  if (checked) _selectedBtIds.add(Number(id));
  else {
    _selectedBtIds.delete(Number(id));
    const cbAll = document.getElementById('bt-cb-all');
    if (cbAll) cbAll.checked = false;
  }
  _updateBtBulkToolbar();
}

function toggleBtSelectAll(checked) {
  document.querySelectorAll('.bt-cb-row').forEach(cb => {
    cb.checked = checked;
    const id = Number(cb.dataset.id);
    if (checked) _selectedBtIds.add(id);
    else _selectedBtIds.delete(id);
  });
  _updateBtBulkToolbar();
}

function clearBtSelection() {
  _selectedBtIds.clear();
  document.querySelectorAll('.bt-cb-row').forEach(cb => cb.checked = false);
  const cbAll = document.getElementById('bt-cb-all');
  if (cbAll) cbAll.checked = false;
  _updateBtBulkToolbar();
}

function _updateBtBulkToolbar() {
  const count   = _selectedBtIds.size;
  const toolbar = document.getElementById('bt-bulk-toolbar');
  if (!toolbar) return;
  toolbar.style.display = count > 0 ? 'flex' : 'none';
  const lbl = document.getElementById('bt-bulk-label');
  if (lbl) {
    const total = [...document.querySelectorAll('.bt-cb-row')]
      .filter(cb => _selectedBtIds.has(Number(cb.dataset.id)))
      .reduce((s, cb) => s + Number(cb.dataset.nominal), 0);
    lbl.textContent = `${count} tagihan · ${rp(total)}`;
  }
}

function _injectBtBulkToolbar() {
  if (document.getElementById('bt-bulk-toolbar')) return;
  const t = document.createElement('div');
  t.id = 'bt-bulk-toolbar';
  t.style.cssText = 'display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:var(--text);color:#fff;border-radius:99px;padding:10px 16px;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.3);align-items:center;gap:10px;z-index:200;' +
    'font-size:13px;font-weight:600;white-space:nowrap;';
  t.innerHTML = `
    <span class="material-symbols-outlined" style="font-size:18px">checklist</span>
    <span id="bt-bulk-label">0 dipilih</span>
    <div style="width:1px;height:20px;background:rgba(255,255,255,.25)"></div>
    <button onclick="bayarMassal()" style="background:var(--green);color:#fff;border:none;border-radius:99px;
      padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:14px">payments</span>Bayar Massal (Cash)
    </button>
    <button onclick="clearBtSelection()" style="background:rgba(255,255,255,.15);color:#fff;border:none;
      border-radius:99px;padding:6px 10px;cursor:pointer;display:flex;align-items:center;font-family:var(--sans)">
      <span class="material-symbols-outlined" style="font-size:16px">close</span>
    </button>`;
  document.body.appendChild(t);
}

async function bayarMassal() {
  const ids = [..._selectedBtIds];
  if (!ids.length) return;
  if (!confirm(`Tandai ${ids.length} tagihan terpilih sebagai LUNAS (Cash)?`)) return;
  try {
    const r = await fetch(`${TG_API}/bayar-multi`, {
      method: 'POST', credentials: 'include', headers: _jhdr(),
      body: JSON.stringify({ tagihan_ids: ids, metode: 'Cash' })
    });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tagihan lunas' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadUnpaid();
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
}

async function createLink(tid) {
  try {
    const r = await fetch(`${PG_API}/create`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ tagihan_id: tid }) });
    const d = await r.json();
    if (!r.ok) { toast(d.message || 'Gagal', 'danger'); return; }
    if (d.mock) {
      toast(d.message + ' — order ' + d.order_id, 'success');
    } else {
      toast('Link dibuat. Membuka halaman pembayaran…', 'success');
      if (d.payment_url && d.payment_url.startsWith('http')) window.open(d.payment_url, '_blank');
    }
    switchTab('tx');
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
}

// ── Transaksi ──────────────────────────────────────────────────
async function loadTx() {
  const periode = document.getElementById('tx-periode').value || '';
  const tb = document.getElementById('tx-tbody');
  tb.innerHTML = '<tr><td colspan="7"><div class="state-box"><div class="spinner"></div><p class="state-title">Memuat…</p></div></td></tr>';
  try {
    const qs = periode ? '?periode=' + periode : '';
    const r = await fetch(`${PG_API}/transactions${qs}`, { credentials: 'include', headers: _hdr() });
    const d = await r.json(); const list = d.transactions || [];
    const cnt = document.getElementById('tx-count');
    if (!list.length) { tb.innerHTML = stateRow(7, 'Belum ada transaksi.'); if (cnt) cnt.textContent = '0 transaksi'; return; }
    if (cnt) cnt.textContent = list.length + ' transaksi';
    tb.innerHTML = list.map((x, i) => {
      const cls = x.status === 'paid' ? 'p-paid' : (x.status === 'pending' ? 'p-pending' : 'p-expired');
      const label = x.status === 'paid' ? 'Lunas' : (x.status === 'pending' ? 'Pending' : 'Kadaluarsa');
      let aksi = '<span class="pg-sub">—</span>';
      if (x.status === 'pending') {
        const openBtn = (x.payment_url && x.payment_url.startsWith('http'))
          ? `<button class="btn-link" onclick="window.open('${esc(x.payment_url)}','_blank')"><span class="material-symbols-outlined">open_in_new</span>Buka</button>` : '';
        aksi = `${openBtn}<button class="btn-paid" data-perm="keuangan" onclick="markPaid('${esc(x.order_id)}')"><span class="material-symbols-outlined">check</span>Konfirmasi Bayar Manual</button>`;
      }
      return `<tr>
        <td class="sticky-col-1">${i + 1}</td>
        <td class="sticky-col-2"><div class="pg-name">${esc(x.nama || x.username)}</div><div class="pg-sub">@${esc(x.username)}</div></td>
        <td class="pg-mono">${esc(x.order_id)}</td>
        <td><span class="pg-chip">${esc(x.provider)}</span></td>
        <td class="pg-nominal">${rp(x.amount)}</td>
        <td><span class="pg-status ${cls}"><span class="dot"></span>${label}</span></td>
        <td><div style="display:flex;gap:6px">${aksi}</div></td>
      </tr>`;
    }).join('');
    if (typeof applyUIPermissions === 'function') applyUIPermissions();
  } catch { tb.innerHTML = stateRow(7, 'Gagal memuat transaksi.'); }
}

async function markPaid(orderId) {
  if (!confirm('Konfirmasi transaksi ' + orderId + ' sebagai LUNAS?\nTagihan akan tercatat lunas di keuangan.')) return;
  try {
    const r = await fetch(`${PG_API}/mark-paid`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify({ order_id: orderId }) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Transaksi dikonfirmasi lunas' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) loadTx();
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
}

function stateRow(cols, msg) { return `<tr><td colspan="${cols}"><div class="state-box"><p class="state-title">${esc(msg)}</p></div></td></tr>`; }

// ── Config modal ───────────────────────────────────────────────
function openConfig() {
  document.getElementById('cfg-provider').value = _cfg.provider || 'midtrans';
  document.getElementById('cfg-mode').value = _cfg.mode || 'sandbox';
  document.getElementById('cfg-client').value = _cfg.client_key || '';
  document.getElementById('cfg-server').value = '';
  document.getElementById('cfg-server').placeholder = _cfg.has_server_key ? '•••••• (tersimpan)' : 'server key';
  document.getElementById('cfg-callback').value = '';
  document.getElementById('cfg-callback').placeholder = _cfg.has_callback_token ? '•••••• (tersimpan)' : 'x-callback-token verifikasi';
  document.getElementById('cfg-enabled').checked = !!_cfg.enabled;
  const nid = (localStorage.getItem('tf_network_id') || '<network_id>');
  document.getElementById('wh-url').textContent = `${API_BASE}/api/payment/webhook?network_id=${nid}`;
  show('cfg');
}
function closeConfig() { hide('cfg'); }
async function saveConfig() {
  const body = {
    provider: document.getElementById('cfg-provider').value,
    mode: document.getElementById('cfg-mode').value,
    client_key: document.getElementById('cfg-client').value.trim(),
    enabled: document.getElementById('cfg-enabled').checked,
  };
  const sk = document.getElementById('cfg-server').value; if (sk) body.server_key = sk;
  const cb = document.getElementById('cfg-callback').value; if (cb) body.callback_token = cb;
  const btn = document.getElementById('cfg-save'); btn.disabled = true;
  try {
    const r = await fetch(`${PG_API}/config`, { method: 'POST', credentials: 'include', headers: _jhdr(), body: JSON.stringify(body) });
    const d = await r.json();
    toast(d.message || (r.ok ? 'Tersimpan' : 'Gagal'), r.ok ? 'success' : 'danger');
    if (r.ok) { closeConfig(); loadConfig(); }
  } catch { toast('Tidak bisa menghubungi server', 'danger'); }
  btn.disabled = false;
}

function show(p) { document.getElementById(p + '-overlay').classList.add('show'); document.getElementById(p + '-modal').classList.add('show'); }
function hide(p) { document.getElementById(p + '-overlay').classList.remove('show'); document.getElementById(p + '-modal').classList.remove('show'); }
function loadAll() { loadConfig(); loadUnpaid(); if (document.getElementById('panel-tx').style.display !== 'none') loadTx(); }

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('bt-periode').value = periodeNow();
  document.getElementById('tx-periode').value = periodeNow();
  loadConfig(); loadUnpaid();
});
