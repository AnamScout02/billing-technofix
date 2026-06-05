/**
 * keuangan.js — TechnoFix · Halaman Keuangan
 * ============================================
 * Mengelola tampilan data keuangan:
 *  - Fetch & render ringkasan statistik ke Stat-Cards
 *  - Render tabel transaksi
 *  - Form Catat Transaksi (via openModalForm dari global.js)
 *  - Aksi: Set Lunas, Edit, Hapus, Cetak Struk
 *  - Filter tipe (chip), filter status (select), search, sort
 *  - Pagination client-side
 *
 * Depends: global.js (API_BASE, toast, openModalForm, closeModalForm, escHtml, animNum)
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */

let _allData  = [];     // data mentah dari API
let _filteredData      = [];     // setelah filter/search/sort
let _filterTipe    = '';     // '' | 'pemasukan' | 'pengeluaran'
let _sortKey       = 'tanggal';
let _sortAsc       = false;
let _currentPage   = 1;
const PAGE_SIZE    = 25;

// ID yang sedang ditunggu konfirmasi hapus
let _hapusId       = null;


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  // Set default bulan = bulan ini
  const inputBulan = document.getElementById('input-bulan');
  if (inputBulan) {
    const now  = new Date();
    const yyyy = now.getFullYear();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    inputBulan.value = `${yyyy}-${mm}`;
  }

  loadKeuangan();
});


/* ══════════════════════════════════════════════════════════
   1. FETCH DATA DARI BACKEND
══════════════════════════════════════════════════════════ */

async function loadKeuangan() {
  showState('loading');
  spinRefresh(true);

  const bulan  = document.getElementById('input-bulan')?.value || '';
  const status = document.getElementById('filter-status')?.value || '';
  const q      = document.getElementById('input-search')?.value.trim() || '';

  const params = new URLSearchParams();
  if (bulan)  params.set('bulan',  bulan);
  if (status) params.set('status', status);
  if (q)      params.set('q',      q);
  // Ambil semua data, filter & paginasi di client agar search real-time
  params.set('limit', 1000);

  try {
    const res  = await fetch(`${API_BASE}/api/keuangan?${params}`, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderStats(data.stats);
    _allData = data.transaksi || [];
    applyFilterSort();
    showState('table');

  } catch (err) {
    console.error('[Keuangan] Fetch error:', err);
    document.getElementById('error-msg').textContent =
      'Gagal terhubung ke server. Periksa backend Python.';
    showState('error');
  } finally {
    spinRefresh(false);
  }
}


/* ══════════════════════════════════════════════════════════
   2. RENDER STAT CARDS
══════════════════════════════════════════════════════════ */

function renderStats(stats) {
  if (!stats) return;

  const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

  // animNum tidak cocok untuk format Rupiah, langsung set teks
  setText('stat-pemasukan',   fmt(stats.total_pemasukan));
  setText('stat-piutang',     fmt(stats.total_piutang));
  setText('stat-pengeluaran', fmt(stats.total_pengeluaran));

  const saldo = stats.saldo_bersih || 0;
  const elSaldo = document.getElementById('stat-saldo');
  if (elSaldo) {
    elSaldo.textContent = fmt(saldo);
    elSaldo.style.color = saldo >= 0 ? 'var(--green)' : 'var(--red)';
  }

  // Label bulan
  setText('saldo-bulan-label',  stats.bulan_label || '');
  setText('page-sub-label',
    `Pemasukan, pengeluaran & piutang — ${stats.bulan_label || 'bulan ini'}`);
}


/* ══════════════════════════════════════════════════════════
   3. FILTER, SEARCH, SORT
══════════════════════════════════════════════════════════ */

function setFilterTipe(tipe) {
  _filterTipe   = tipe;
  _currentPage  = 1;
  // Update chip visual
  document.getElementById('chip-semua')?.classList.toggle('active', tipe === '');
  document.getElementById('chip-pemasukan')?.classList.toggle('active', tipe === 'pemasukan');
  document.getElementById('chip-pengeluaran')?.classList.toggle('active', tipe === 'pengeluaran');
  applyFilterSort();
}

function filterTabel() {
  _currentPage = 1;
  applyFilterSort();
}

function sortTable(key) {
  if (_sortKey === key) {
    _sortAsc = !_sortAsc;
  } else {
    _sortKey = key;
    _sortAsc = key !== 'tanggal'; // tanggal default DESC
  }
  applyFilterSort();
}

function applyFilterSort() {
  const q      = (document.getElementById('input-search')?.value || '').toLowerCase();
  const status = document.getElementById('filter-status')?.value || '';

  let list = [..._allData];

  // Filter tipe
  if (_filterTipe) list = list.filter(t => t.tipe === _filterTipe);

  // Filter status
  if (status) list = list.filter(t => t.status === status);

  // Search
  if (q) {
    list = list.filter(t =>
      (t.keterangan || '').toLowerCase().includes(q) ||
      (t.username   || '').toLowerCase().includes(q) ||
      (t.catatan    || '').toLowerCase().includes(q) ||
      (t.metode     || '').toLowerCase().includes(q)
    );
  }

  // Sort
  list.sort((a, b) => {
    let va = a[_sortKey] ?? '';
    let vb = b[_sortKey] ?? '';
    if (_sortKey === 'nominal') { va = Number(va); vb = Number(vb); }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return _sortAsc ? cmp : -cmp;
  });

  _filteredData = list;
  renderTabel();
  renderPaginasi();
}


/* ══════════════════════════════════════════════════════════
   4. RENDER TABEL
══════════════════════════════════════════════════════════ */

function renderTabel() {
  const tbody = document.getElementById('tbody-keuangan');
  if (!tbody) return;

  const start  = (_currentPage - 1) * PAGE_SIZE;
  const page   = _filteredData.slice(start, start + PAGE_SIZE);

  if (_filteredData.length === 0) {
    tbody.innerHTML = '';
    showState('empty');
    return;
  }
  showState('table');

  // Total nominal terpilih (semua baris, bukan hanya satu halaman)
  const totalNominal = _filteredData.reduce((sum, t) => {
    return sum + (t.tipe === 'pemasukan' ? t.nominal : -t.nominal);
  }, 0);

  const fmt = n => 'Rp ' + Number(n).toLocaleString('id-ID');
  setText('tabel-count',
    `Menampilkan ${start + 1}–${Math.min(start + page.length, _filteredData.length)} dari ${_filteredData.length} transaksi`);
  const elTotal = document.getElementById('tabel-total-nominal');
  if (elTotal) {
    elTotal.textContent = `Netto: ${fmt(Math.abs(totalNominal))}`;
    elTotal.style.color = totalNominal >= 0 ? 'var(--green)' : 'var(--red)';
  }

  tbody.innerHTML = page.map((t, idx) => {
    const no = start + idx + 1;

    // Badge tipe
    const tipeIcon  = t.tipe === 'pemasukan' ? 'arrow_downward' : 'arrow_upward';
    const tipeLabel = t.tipe === 'pemasukan' ? 'Pemasukan' : 'Pengeluaran';
    const badgeTipe = `
      <span class="badge-tipe ${escHtml(t.tipe)}">
        <span class="material-symbols-outlined">${tipeIcon}</span>
        ${tipeLabel}
      </span>`;

    // Badge status
    const statusClass = { Lunas: 'lunas', Pending: 'pending', Gagal: 'gagal' }[t.status] || 'pending';
    const statusIcon  = { Lunas: 'check_circle', Pending: 'hourglass_empty', Gagal: 'cancel' }[t.status] || 'hourglass_empty';
    const badgeStatus = `
      <span class="badge-status-trx ${statusClass}">
        <span class="material-symbols-outlined" style="font-size:12px">${statusIcon}</span>
        ${escHtml(t.status)}
      </span>`;

    // Nominal berwarna
    const nominalClass = t.tipe === 'pemasukan' ? 'nominal-pemasukan' : 'nominal-pengeluaran';
    const nominalSign  = t.tipe === 'pemasukan' ? '+' : '−';
    const nominalFmt   = fmt(t.nominal);

    // Tanggal
    const tgl = formatTanggal(t.tanggal);

    // Aksi — tombol Set Lunas hanya muncul jika status Pending
    const btnLunas = t.status === 'Pending'
      ? `<button class="btn-tbl detail" onclick="konfirmasiLunas(${t.id})"
           title="Tandai Lunas">
           <span class="material-symbols-outlined">check_circle</span>
         </button>`
      : '';

    return `
      <tr>
        <td style="text-align:center;font-size:12px;color:var(--text-dim);font-weight:600">${no}</td>
        <td style="color:var(--text-muted);font-size:12px">${tgl}</td>
        <td>
          <div class="tbl-keterangan">${escHtml(t.keterangan)}</div>
          ${t.username ? `<div class="tbl-username">${escHtml(t.username)}</div>` : ''}
        </td>
        <td>${badgeTipe}</td>
        <td class="td-nominal">
          <span class="${nominalClass}">${nominalSign} ${nominalFmt}</span>
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-muted)">${escHtml(t.metode)}</span>
        </td>
        <td>${badgeStatus}</td>
        <td>
          <div class="tbl-actions">
            ${btnLunas}
            <button class="btn-tbl edit" onclick="showFormEdit(${t.id})"
              title="Edit">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="btn-tbl" onclick="cetakStruk(${t.id})"
              title="Cetak Struk">
              <span class="material-symbols-outlined">print</span>
            </button>
            <button class="btn-tbl hapus" onclick="showModalHapus(${t.id}, '${escHtml(t.keterangan)}')"
              title="Hapus">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}


/* ══════════════════════════════════════════════════════════
   5. FORM CATAT TRANSAKSI — via openModalForm() dari global.js
══════════════════════════════════════════════════════════ */

function showFormTransaksi(prefillTipe = 'pemasukan') {
  const html = `
    <div class="form-modal" onclick="event.stopPropagation()">
      <div class="modal-head">
        <div class="modal-head-left">
          <div class="modal-head-icon">
            <span class="material-symbols-outlined">add_circle</span>
          </div>
          <div>
            <div class="modal-title">Catat Transaksi</div>
            <div class="modal-sub">Tambahkan pemasukan atau pengeluaran baru</div>
          </div>
        </div>
        <button class="modal-close" onclick="closeModalForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="modal-fields">

        <!-- Jenis transaksi -->
        <div class="form-group full">
          <label class="form-label">Jenis Transaksi <span class="req">*</span></label>
          <select id="f-tipe" class="form-input" onchange="onTipeChange()">
            <option value="pemasukan"    ${prefillTipe === 'pemasukan'    ? 'selected' : ''}>💰 Pembayaran Pelanggan (Pemasukan)</option>
            <option value="pemasukan_lain" ${prefillTipe === 'pemasukan_lain' ? 'selected' : ''}>📥 Pemasukan Lainnya</option>
            <option value="pengeluaran"  ${prefillTipe === 'pengeluaran'  ? 'selected' : ''}>💸 Biaya Operasional (Pengeluaran)</option>
          </select>
        </div>

        <!-- Keterangan -->
        <div class="form-group full">
          <label class="form-label" id="label-keterangan">Nama Pelanggan / Keterangan <span class="req">*</span></label>
          <input type="text" id="f-keterangan" class="form-input"
            placeholder="Contoh: Tagihan Mei — Budi Santoso" />
        </div>

        <!-- Username & Nominal -->
        <div class="form-grid">
          <div class="form-group" id="grup-username">
            <label class="form-label">Username PPP (opsional)</label>
            <input type="text" id="f-username" class="form-input"
              placeholder="pelanggan.budi" />
          </div>
          <div class="form-group">
            <label class="form-label">Nominal (Rp) <span class="req">*</span></label>
            <input type="number" id="f-nominal" class="form-input"
              placeholder="150000" min="0" />
          </div>
        </div>

        <!-- Metode & Status -->
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Metode Pembayaran</label>
            <select id="f-metode" class="form-input">
              <option>Transfer</option>
              <option>Tunai</option>
              <option>QRIS</option>
              <option>GoPay</option>
              <option>OVO</option>
              <option>Dana</option>
              <option>ShopeePay</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <select id="f-status" class="form-input">
              <option value="Lunas">✅ Lunas</option>
              <option value="Pending" selected>⏳ Pending</option>
              <option value="Gagal">❌ Gagal</option>
            </select>
          </div>
        </div>

        <!-- Tanggal & Catatan -->
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Tanggal</label>
            <input type="date" id="f-tanggal" class="form-input"
              value="${new Date().toISOString().slice(0, 10)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Catatan (opsional)</label>
            <input type="text" id="f-catatan" class="form-input"
              placeholder="Periode, keterangan tambahan..." />
          </div>
        </div>

      </div>

      <div class="modal-footer">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn-primary" onclick="simpanTransaksi()">
          <span class="material-symbols-outlined">save</span>Simpan
        </button>
      </div>
    </div>`;

  openModalForm(html);
}


/** Saat tipe berubah — sembunyikan username jika bukan Pembayaran Pelanggan */
function onTipeChange() {
  const tipe  = document.getElementById('f-tipe')?.value || '';
  const grpUn = document.getElementById('grup-username');
  const lbl   = document.getElementById('label-keterangan');
  if (grpUn) grpUn.style.display = tipe === 'pemasukan' ? '' : 'none';
  if (lbl) lbl.textContent =
    tipe === 'pemasukan'
      ? 'Nama Pelanggan / Keterangan *'
      : 'Keterangan *';
}


/** Simpan transaksi baru ke backend */
async function simpanTransaksi() {
  const tipeRaw    = val('f-tipe');
  const tipe       = tipeRaw === 'pemasukan_lain' ? 'pemasukan' : tipeRaw;
  const keterangan = val('f-keterangan');
  const nominal    = val('f-nominal');
  const metode     = val('f-metode');
  const status     = val('f-status');
  const tanggal    = val('f-tanggal');
  const username   = val('f-username');
  const catatan    = val('f-catatan');

  if (!keterangan) { toast('Keterangan wajib diisi', 'warning'); return; }
  if (!nominal || isNaN(Number(nominal)) || Number(nominal) < 0) {
    toast('Nominal harus berupa angka positif', 'warning'); return;
  }

  const btnSimpan = document.querySelector('.form-modal .btn-primary');
  if (btnSimpan) { btnSimpan.disabled = true; btnSimpan.textContent = 'Menyimpan...'; }

  try {
    const res  = await fetch(`${API_BASE}/api/keuangan`, {
      method:  'POST',
      credentials: 'include', headers: getAuthHeaders(),
      body:    JSON.stringify({
        tipe, keterangan, nominal: Number(nominal),
        metode, status, tanggal, username, catatan,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Gagal menyimpan');

    toast('Transaksi berhasil dicatat', 'success');
    closeModalForm();
    loadKeuangan();

  } catch (err) {
    toast(`Gagal: ${err.message}`, 'danger');
    if (btnSimpan) { btnSimpan.disabled = false; btnSimpan.innerHTML = '<span class="material-symbols-outlined">save</span>Simpan'; }
  }
}


/* ══════════════════════════════════════════════════════════
   6. FORM EDIT TRANSAKSI
══════════════════════════════════════════════════════════ */

function showFormEdit(id) {
  const trx = _allData.find(t => t.id === id);
  if (!trx) { toast('Data tidak ditemukan', 'warning'); return; }

  const html = `
    <div class="form-modal" onclick="event.stopPropagation()">
      <div class="modal-head">
        <div class="modal-head-left">
          <div class="modal-head-icon">
            <span class="material-symbols-outlined">edit</span>
          </div>
          <div>
            <div class="modal-title">Edit Transaksi</div>
            <div class="modal-sub">#${trx.id} — ${escHtml(trx.keterangan)}</div>
          </div>
        </div>
        <button class="modal-close" onclick="closeModalForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="modal-fields">
        <div class="form-group full">
          <label class="form-label">Tipe Transaksi</label>
          <select id="f-tipe" class="form-input">
            <option value="pemasukan"   ${trx.tipe === 'pemasukan'   ? 'selected' : ''}>Pemasukan</option>
            <option value="pengeluaran" ${trx.tipe === 'pengeluaran' ? 'selected' : ''}>Pengeluaran</option>
          </select>
        </div>
        <div class="form-group full">
          <label class="form-label">Keterangan <span class="req">*</span></label>
          <input type="text" id="f-keterangan" class="form-input"
            value="${escHtml(trx.keterangan)}" />
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" id="f-username" class="form-input"
              value="${escHtml(trx.username)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Nominal (Rp) <span class="req">*</span></label>
            <input type="number" id="f-nominal" class="form-input"
              value="${trx.nominal}" min="0" />
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Metode</label>
            <select id="f-metode" class="form-input">
              ${['Transfer','Tunai','QRIS','GoPay','OVO','Dana','ShopeePay'].map(m =>
                `<option ${trx.metode === m ? 'selected' : ''}>${m}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <select id="f-status" class="form-input">
              ${['Lunas','Pending','Gagal'].map(s =>
                `<option value="${s}" ${trx.status === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Tanggal</label>
            <input type="date" id="f-tanggal" class="form-input"
              value="${trx.tanggal}" />
          </div>
          <div class="form-group">
            <label class="form-label">Catatan</label>
            <input type="text" id="f-catatan" class="form-input"
              value="${escHtml(trx.catatan)}" />
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn-primary" onclick="updateTransaksi(${trx.id})">
          <span class="material-symbols-outlined">save</span>Simpan Perubahan
        </button>
      </div>
    </div>`;

  openModalForm(html);
}


async function updateTransaksi(id) {
  const tipe       = val('f-tipe');
  const keterangan = val('f-keterangan');
  const nominal    = val('f-nominal');
  const metode     = val('f-metode');
  const status     = val('f-status');
  const tanggal    = val('f-tanggal');
  const username   = val('f-username');
  const catatan    = val('f-catatan');

  if (!keterangan) { toast('Keterangan wajib diisi', 'warning'); return; }
  if (!nominal || isNaN(Number(nominal))) { toast('Nominal tidak valid', 'warning'); return; }

  try {
    const res  = await fetch(`${API_BASE}/api/keuangan/${id}`, {
      method:  'PUT',
      credentials: 'include', headers: getAuthHeaders(),
      body:    JSON.stringify({ tipe, keterangan, nominal: Number(nominal), metode, status, tanggal, username, catatan }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Gagal update');
    toast('Transaksi berhasil diperbarui', 'success');
    closeModalForm();
    loadKeuangan();
  } catch (err) {
    toast(`Gagal: ${err.message}`, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   7. SET LUNAS
══════════════════════════════════════════════════════════ */

function konfirmasiLunas(id) {
  const trx = _allData.find(t => t.id === id);
  if (!trx) return;

  const html = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="hapus-icon-wrap" style="background:var(--green-bg)">
        <span class="material-symbols-outlined" style="color:var(--green);font-size:26px">check_circle</span>
      </div>
      <div class="hapus-title">Tandai Lunas?</div>
      <div class="hapus-sub">
        Transaksi <strong>${escHtml(trx.keterangan)}</strong><br>
        senilai <strong>Rp ${Number(trx.nominal).toLocaleString('id-ID')}</strong>
        akan ditandai sebagai <strong>Lunas</strong>.
      </div>
      <div class="modal-footer">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-green" onclick="eksekusiLunas(${id})">
          <span class="material-symbols-outlined">check_circle</span>Ya, Lunas
        </button>
      </div>
    </div>`;
  openModalForm(html);
}


async function eksekusiLunas(id) {
  try {
    const res  = await fetch(`${API_BASE}/api/keuangan/${id}/lunas`, { method: 'POST', credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok && data.status !== 'info') throw new Error(data.message || 'Gagal');
    toast(data.message || 'Berhasil ditandai Lunas', 'success');
    closeModalForm();
    loadKeuangan();
  } catch (err) {
    toast(`Gagal: ${err.message}`, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   8. HAPUS
══════════════════════════════════════════════════════════ */

function showModalHapus(id, keterangan) {
  _hapusId = id;
  document.getElementById('hapus-keterangan').textContent = keterangan;
  const m = document.getElementById('modal-hapus');
  if (m) m.classList.add('open');

  const btnKonfirmasi = document.getElementById('btn-konfirmasi-hapus');
  if (btnKonfirmasi) btnKonfirmasi.onclick = eksekusiHapus;
}

function closeModalHapus(event) {
  if (event && event.target !== event.currentTarget) return;
  tutupModalHapus();
}

function tutupModalHapus() {
  const m = document.getElementById('modal-hapus');
  if (m) m.classList.remove('open');
  _hapusId = null;
}

async function eksekusiHapus() {
  if (!_hapusId) return;
  try {
    const res  = await fetch(`${API_BASE}/api/keuangan/${_hapusId}`, { method: 'DELETE', credentials: 'include', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Gagal hapus');
    toast('Transaksi berhasil dihapus', 'success');
    tutupModalHapus();
    loadKeuangan();
  } catch (err) {
    toast(`Gagal: ${err.message}`, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   9. CETAK STRUK — Skeleton
══════════════════════════════════════════════════════════ */

function cetakStruk(id) {
  const trx = _allData.find(t => t.id === id);
  if (!trx) { toast('Data tidak ditemukan', 'warning'); return; }

  /**
   * TODO: Implementasi cetak struk
   * Opsi yang bisa dikembangkan:
   *   1. Buka window baru dengan HTML struk → window.print()
   *   2. Generate PDF menggunakan jsPDF atau endpoint /api/keuangan/<id>/struk
   *   3. Kirim via WhatsApp API
   *
   * Skeleton:
   *   const strukHtml = buildStrukHtml(trx);
   *   const win = window.open('', '_blank');
   *   win.document.write(strukHtml);
   *   win.print();
   */

  // Sementara: tampilkan detail di modal
  const fmt = n => 'Rp ' + Number(n).toLocaleString('id-ID');
  const html = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:360px">
      <div class="modal-head">
        <div class="modal-head-left">
          <div class="modal-head-icon"><span class="material-symbols-outlined">receipt</span></div>
          <div>
            <div class="modal-title">Detail Struk</div>
            <div class="modal-sub">Transaksi #${trx.id}</div>
          </div>
        </div>
        <button class="modal-close" onclick="closeModalForm()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div style="font-size:13px;color:var(--text-muted);line-height:2">
        <div style="display:flex;justify-content:space-between"><span>Tanggal</span><strong>${formatTanggal(trx.tanggal)}</strong></div>
        <div style="display:flex;justify-content:space-between"><span>Keterangan</span><strong>${escHtml(trx.keterangan)}</strong></div>
        ${trx.username ? `<div style="display:flex;justify-content:space-between"><span>Username</span><strong>${escHtml(trx.username)}</strong></div>` : ''}
        <div style="display:flex;justify-content:space-between"><span>Tipe</span><strong>${trx.tipe}</strong></div>
        <div style="display:flex;justify-content:space-between"><span>Nominal</span><strong style="color:var(--${trx.tipe === 'pemasukan' ? 'green' : 'red'})">${fmt(trx.nominal)}</strong></div>
        <div style="display:flex;justify-content:space-between"><span>Metode</span><strong>${escHtml(trx.metode)}</strong></div>
        <div style="display:flex;justify-content:space-between"><span>Status</span><strong>${escHtml(trx.status)}</strong></div>
        ${trx.catatan ? `<div style="display:flex;justify-content:space-between"><span>Catatan</span><strong>${escHtml(trx.catatan)}</strong></div>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-cancel" onclick="closeModalForm()">Tutup</button>
        <button class="btn btn-blue" onclick="alert('Fitur cetak akan diimplementasi')">
          <span class="material-symbols-outlined">print</span>Cetak
        </button>
      </div>
    </div>`;
  openModalForm(html);
}


/* ══════════════════════════════════════════════════════════
   10. PAGINATION
══════════════════════════════════════════════════════════ */

function renderPaginasi() {
  const container   = document.getElementById('pagination');
  if (!container) return;

  const totalPages = Math.ceil(_filteredData.length / PAGE_SIZE);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';

  // Prev
  html += `<button class="page-btn" onclick="goPage(${_currentPage - 1})"
    ${_currentPage === 1 ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_left</span>
  </button>`;

  // Halaman
  for (let p = 1; p <= totalPages; p++) {
    if (
      p === 1 || p === totalPages ||
      (p >= _currentPage - 1 && p <= _currentPage + 1)
    ) {
      html += `<button class="page-btn ${p === _currentPage ? 'active' : ''}"
        onclick="goPage(${p})">${p}</button>`;
    } else if (p === _currentPage - 2 || p === _currentPage + 2) {
      html += `<span style="padding:0 4px;color:var(--text-dim)">…</span>`;
    }
  }

  // Next
  html += `<button class="page-btn" onclick="goPage(${_currentPage + 1})"
    ${_currentPage === totalPages ? 'disabled' : ''}>
    <span class="material-symbols-outlined" style="font-size:16px">chevron_right</span>
  </button>`;

  container.innerHTML = html;
}

function goPage(p) {
  const totalPages = Math.ceil(_filteredData.length / PAGE_SIZE);
  if (p < 1 || p > totalPages) return;
  _currentPage = p;
  renderTabel();
  renderPaginasi();
  // Scroll ke atas tabel
  document.getElementById('table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/* ══════════════════════════════════════════════════════════
   11. HELPER — UI STATE
══════════════════════════════════════════════════════════ */

/**
 * showState: tampilkan/sembunyikan elemen sesuai state.
 * @param {'loading'|'empty'|'error'|'table'} state
 */
function showState(state) {
  const states = {
    loading: document.getElementById('state-loading'),
    empty:   document.getElementById('state-empty'),
    error:   document.getElementById('state-error'),
    table:   document.getElementById('table-scroll'),
  };
  Object.entries(states).forEach(([k, el]) => {
    if (!el) return;
    if (k === 'table') {
      el.style.display = state === 'table' ? '' : 'none';
    } else {
      el.style.display = k === state ? 'flex' : 'none';
    }
  });
  // Footer hanya saat tabel tampil
  const footer = document.querySelector('.table-footer');
  if (footer) footer.style.display = state === 'table' ? '' : 'none';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function spinRefresh(isSpin) {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.style.animation = isSpin ? 'spin .8s linear infinite' : '';
}

function formatTanggal(isoDate) {
  if (!isoDate) return '—';
  try {
    return new Date(isoDate).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch { return isoDate; }
}