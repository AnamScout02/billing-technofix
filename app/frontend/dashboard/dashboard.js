/* ============================================================
   dashboard.js — TechnoFix Dashboard
   Requires: global.js  ← wajib di-load lebih dulu di HTML
             (API_BASE, animNum, toast, escHtml, openModalForm,
              closeModalForm, toggleProfileMenu, initBottomNav)
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  updateDashboardStats();
  loadDaftarJatuhTempo();
  loadNetworkSummary();

  // Refresh statistik setiap 1 menit
  setInterval(updateDashboardStats, 60_000);
}


/* ── Tanggal Hari Ini (dihandle global.js via initDateBadge) ── */
/* Tidak perlu ditulis ulang di sini */


/* ══════════════════════════════════════════════════════════
   STATS CARDS
══════════════════════════════════════════════════════════ */
async function updateDashboardStats() {
  // Nilai statis sementara — ganti dengan endpoint API jika tersedia
  animNum('stat-tempo-hari',    5);
  animNum('stat-tempo-minggu', 18);
  animNum('stat-pendapatan',   4_250_000, 'Rp ');

  try {
    const deviceId = localStorage.getItem('lastSelectedDevice') || 1;
    const res = await fetch(`${API_BASE}/api/pelanggan/${deviceId}`);
    if (!res.ok) throw new Error('Gagal mengambil data');

    const pelanggan  = await res.json();
    const totalOnline = pelanggan.filter(p =>
      p.status && p.status.toLowerCase() === 'online'
    ).length;
    animNum('stat-online-aktif', totalOnline);
  } catch (err) {
    console.warn('Info: Gagal load Pelanggan Aktif —', err.message);
  }
}


/* ══════════════════════════════════════════════════════════
   NETWORK SUMMARY
══════════════════════════════════════════════════════════ */
async function loadNetworkSummary() {
  const elMt  = document.getElementById('net-mt-count');
  const elOlt = document.getElementById('net-olt-count');

  try {
    const res = await fetch(`${API_BASE}/devices`);
    if (res.ok) {
      const devices     = await res.json();
      const mtConnected = devices.filter(d => d.status === 'connected').length;
      if (elMt) elMt.textContent = `${mtConnected}/${devices.length} Online`;
    }
  } catch (e) {
    if (elMt) elMt.textContent = 'Error / Offline';
  }

  try {
    const res = await fetch(`${API_BASE}/olt`);
    if (res.ok) {
      const olts         = await res.json();
      const oltConnected = olts.filter(o => o.status === 'connected').length;
      if (elOlt) elOlt.textContent = `${oltConnected}/${olts.length} Online`;
    }
  } catch (e) {
    if (elOlt) elOlt.textContent = 'Error / Offline';
  }
}


/* ══════════════════════════════════════════════════════════
   DAFTAR JATUH TEMPO
══════════════════════════════════════════════════════════ */
async function loadDaftarJatuhTempo() {
  const container = document.getElementById('jatuh-tempo-list');
  if (!container) return;

  try {
    const deviceId = localStorage.getItem('lastSelectedDevice') || 1;
    const res      = await fetch(`${API_BASE}/api/pelanggan/${deviceId}`);
    if (!res.ok) throw new Error('Gagal memuat data tabel');

    const data           = await res.json();
    const listJatuhTempo = data.slice(0, 10);

    if (listJatuhTempo.length === 0) {
      container.innerHTML = `<tr><td colspan="7" class="tbl-empty-msg">
        Tidak ada data pelanggan pada perangkat ini.
      </td></tr>`;
      return;
    }

    container.innerHTML = listJatuhTempo.map((p, index) => {
      const username = String(p.username || '?');
      const inisial  = username.substring(0, 2).toUpperCase();

      return `
      <tr>
        <td class="sticky-col-1">${index + 1}</td>
        <td class="sticky-col-2">
          <div class="tbl-user-cell">
            <div class="user-avatar">${escHtml(inisial)}</div>
            <span class="tbl-username">${escHtml(username)}</span>
          </div>
        </td>
        <td><span class="badge-profil">${escHtml(p.profil || 'Default-Profile')}</span></td>
        <td><span class="tbl-wilayah">${escHtml(p.koordinat || 'Banyuwangi')}</span></td>
        <td><span class="tbl-tagihan">Rp 150.000</span></td>
        <td><span class="tbl-jatuh-tempo">${escHtml(p.tgl_jatuh || '—')}</span></td>
        <td>
          <div class="action-btn-group">
            <button class="btn-action-dash btn-pay"
              onclick="modalBayar(${JSON.stringify(p).replace(/"/g, '&quot;')})"
              title="Bayar">
              <span class="material-symbols-outlined">payments</span> Bayar
            </button>
            <button class="btn-action-dash btn-isolate"
              onclick="modalIsolir(${JSON.stringify(p).replace(/"/g, '&quot;')})"
              title="Isolir">
              <span class="material-symbols-outlined">link_off</span> Isolir
            </button>
            <button class="btn-action-dash btn-msg"
              onclick="kirimNotifPesan('${escHtml(p.hp || '')}', '${escHtml(username)}')"
              title="Kirim Pesan">
              <span class="material-symbols-outlined">sms</span> Pesan
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

  } catch (error) {
    container.innerHTML = `<tr><td colspan="7" class="tbl-empty-msg">
      Gagal memuat data dari server. (Pilih perangkat terlebih dahulu)
    </td></tr>`;
  }
}


/* ══════════════════════════════════════════════════════════
   TAB JATUH TEMPO
══════════════════════════════════════════════════════════ */
function switchTab(btn, tabId) {
  document.querySelectorAll('.jatuh-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.jatuh-table').forEach(t => t.classList.add('hidden'));
  const target = document.getElementById('tbl-' + tabId);
  if (target) target.classList.remove('hidden');
}


/* ══════════════════════════════════════════════════════════
   MODAL BAYAR — pengganti alert('Memproses pembayaran')
══════════════════════════════════════════════════════════ */
function modalBayar(p) {
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) { p = { username: p }; }
  }

  const username = escHtml(p.username || '—');
  const tagihan  = 'Rp 150.000';
  const jatuh    = escHtml(p.tgl_jatuh || '—');
  const hp       = escHtml(p.hp || '');

  const html = `
    <div class="modal" style="max-width:420px;width:100%;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);
             background:var(--green-bg);color:var(--green);
             display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <span class="material-symbols-outlined" style="font-size:20px;">payments</span>
        </div>
        <div>
          <div style="font-family:var(--heading);font-size:15px;font-weight:800;color:var(--text);">
            Konfirmasi Pembayaran
          </div>
          <div style="font-size:12px;color:var(--text-muted);">Tagihan internet pelanggan</div>
        </div>
        <button class="psheet-close" onclick="closeModalForm()" style="margin-left:auto;" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div style="background:var(--surface);border-radius:var(--r-md);padding:14px;
           margin-bottom:16px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span style="color:var(--text-muted);">Pelanggan</span>
          <span style="font-weight:700;color:var(--text);">${username}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span style="color:var(--text-muted);">Tagihan</span>
          <span style="font-weight:700;color:var(--text);">${tagihan}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span style="color:var(--text-muted);">Jatuh Tempo</span>
          <span style="font-weight:600;color:var(--amber);">${jatuh}</span>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        ${hp ? `
        <button class="btn btn-green" onclick="hubungiWA('${hp}', '${username}')">
          <span class="material-symbols-outlined">whatsapp</span> Konfirmasi via WA
        </button>` : ''}
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn-primary" onclick="_prosesKonfirmasiBayar('${username}')">
          <span class="material-symbols-outlined">check_circle</span> Tandai Lunas
        </button>
      </div>
    </div>`;

  openModalForm(html);  // dari global.js
}

async function _prosesKonfirmasiBayar(username) {
  // TODO: hubungkan ke endpoint API pembayaran jika tersedia
  closeModalForm();
  toast(`Pembayaran ${username} berhasil dicatat`, 'success');
}


/* ══════════════════════════════════════════════════════════
   MODAL ISOLIR — pengganti alert('Memproses isolir')
══════════════════════════════════════════════════════════ */
function modalIsolir(p) {
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch (_) { p = { username: p }; }
  }

  const username = escHtml(p.username || '—');
  const deviceId = localStorage.getItem('lastSelectedDevice') || '';

  const html = `
    <div class="modal" style="max-width:400px;width:100%;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:var(--r-md);
             background:var(--amber-bg);color:var(--amber);
             display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <span class="material-symbols-outlined" style="font-size:20px;">link_off</span>
        </div>
        <div>
          <div style="font-family:var(--heading);font-size:15px;font-weight:800;color:var(--text);">
            Isolir Jaringan
          </div>
          <div style="font-size:12px;color:var(--text-muted);">Nonaktifkan akses internet sementara</div>
        </div>
        <button class="psheet-close" onclick="closeModalForm()" style="margin-left:auto;" title="Tutup">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div style="font-size:13px;color:var(--text-muted);margin-bottom:18px;line-height:1.7;">
        Akses internet pelanggan <strong style="color:var(--text);">${username}</strong>
        akan dinonaktifkan sementara. Pelanggan dapat diaktifkan kembali kapan saja.
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-cancel" onclick="closeModalForm()">Batal</button>
        <button class="btn btn-amber" onclick="_prosesIsolir('${username}', '${deviceId}')">
          <span class="material-symbols-outlined">link_off</span> Ya, Isolir
        </button>
      </div>
    </div>`;

  openModalForm(html);  // dari global.js
}

async function _prosesIsolir(username, deviceId) {
  if (!deviceId) { toast('Perangkat tidak dipilih', 'warning'); return; }

  try {
    const res = await fetch(`${API_BASE}/api/pelanggan`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        username,
        device_id: Number(deviceId),
        disabled:  true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal isolir');
    closeModalForm();
    toast(`${username} berhasil diisolir`, 'warning');
  } catch (err) {
    toast(err.message, 'danger');
  }
}


/* ══════════════════════════════════════════════════════════
   KIRIM NOTIFIKASI WA
══════════════════════════════════════════════════════════ */
function kirimNotifPesan(noHp, nama) {
  if (!noHp) {
    toast('Nomor HP tidak tersedia untuk pelanggan ini', 'warning');
    return;
  }
  hubungiWA(noHp, nama || '');
}

function hubungiWA(noHp, nama) {
  const clean = noHp.replace(/[-\s]/g, '').replace(/^0/, '62');
  const pesan = encodeURIComponent(
    `Halo ${nama || 'Pelanggan'}, tagihan internet Anda sudah jatuh tempo hari ini. `
    + `Mohon segera lakukan pembayaran. Terima kasih — TechnoFix`
  );
  window.open(`https://wa.me/${clean}?text=${pesan}`, '_blank');
}


/* ══════════════════════════════════════════════════════════
   REFRESH
══════════════════════════════════════════════════════════ */
function refreshDashboard() {
  const icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('spinning');
  Promise.all([
    updateDashboardStats(),
    loadDaftarJatuhTempo(),
    loadNetworkSummary(),
  ]).finally(() => {
    setTimeout(() => { if (icon) icon.classList.remove('spinning'); }, 800);
  });
}

function refreshNetwork() {
  toast('Mengecek status jaringan...', 'info');
  loadNetworkSummary();
}


/* ══════════════════════════════════════════════════════════
   CHART: Pertumbuhan Pelanggan (Line)
══════════════════════════════════════════════════════════ */
(function () {
  const ctx = document.getElementById('chartPelanggan');
  if (!ctx || typeof Chart === 'undefined') return;

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun'],
      datasets: [{
        label: 'Pelanggan Aktif',
        data: [198, 211, 219, 228, 235, 247],
        borderColor: '#0040a1',
        backgroundColor: 'rgba(0,64,161,.08)',
        borderWidth: 2.5,
        pointBackgroundColor: '#0040a1',
        pointRadius: 4,
        pointHoverRadius: 6,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1117', titleColor: '#f0f4ff',
          bodyColor: '#c8d0e0', padding: 10, cornerRadius: 8,
          callbacks: { label: c => ` ${c.parsed.y} pelanggan` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: 'Poppins', size: 11 }, color: '#6a82a8' },
        },
        y: {
          min: 180,
          grid: { color: 'rgba(0,0,0,.05)' },
          ticks: { font: { family: 'Poppins', size: 11 }, color: '#6a82a8', stepSize: 20 },
        },
      },
    },
  });
})();


/* ══════════════════════════════════════════════════════════
   CHART: Pendapatan Bulanan (Bar)
══════════════════════════════════════════════════════════ */
(function () {
  const ctx = document.getElementById('chartPendapatan');
  if (!ctx || typeof Chart === 'undefined') return;

  const data = [11.2, 12.0, 12.8, 13.4, 13.9, 14.7];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun'],
      datasets: [{
        label: 'Pendapatan (Juta Rp)',
        data,
        backgroundColor: (c) =>
          c.dataIndex === data.length - 1
            ? '#006c47'
            : 'rgba(0,108,71,.35)',
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1117', titleColor: '#f0f4ff',
          bodyColor: '#c8d0e0', padding: 10, cornerRadius: 8,
          callbacks: { label: c => ` Rp ${c.parsed.y.toFixed(1)} Juta` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { family: 'Poppins', size: 11 },
            color: '#6a82a8', autoSkip: false,
          },
        },
        y: {
          min: 8,
          grid: { color: 'rgba(0,0,0,.05)' },
          ticks: {
            font: { family: 'Poppins', size: 11 },
            color: '#6a82a8',
            callback: v => `${v}Jt`,
          },
        },
      },
    },
  });
})();