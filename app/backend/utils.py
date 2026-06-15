"""
utils.py — TechnoFix · Backend Helpers Terpusat
================================================
Semua fungsi helper yang dipakai bersama oleh:
  api.py, input.py, olt.py, olt_sync.py

Import dari sini agar tidak ada redudansi kode:
  from utils import get_db, try_connect_mikrotik, try_connect_olt,
                    parse_rx_power, olt_to_dict, device_to_dict

Isi:
  1.  DB_PATH & get_db()
  2.  device_to_dict()
  3.  olt_to_dict()
  4.  try_connect_mikrotik()
  5.  try_connect_olt()
  6.  parse_rx_power()       ← NEW: parsing nilai dBm dari string CLI OLT
  7.  parse_huawei_rx()      ← NEW: regex parser khusus Huawei
  8.  parse_zte_rx()         ← NEW: regex parser khusus ZTE
"""

import os
import re
import socket
import logging
import sqlite3

import routeros_api

# ── Setup Logging ──────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════
# 1. PATH DATABASE — MULTI-TENANT (Opsi B: 1 file per owner)
# ══════════════════════════════════════════════════════════════
#
# Arsitektur:
#   master.db (= devices.db lama)  → AUTH & owner: networks, users,
#                                     superadmins, packages
#   owners/<network_id>.db         → DATA operasional milik 1 owner:
#                                     devices, pelanggan, olt, odc,
#                                     odp, onu_mapping, profil_harga
#
# get_master_db()      → koneksi ke master.db (auth/owner)
# get_owner_db(nid)    → koneksi ke file owner (auto-buat + init skema)
# get_db()             → owner-aware: pilih file sesuai owner yang login
# ══════════════════════════════════════════════════════════════

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DB_DIR   = os.path.join(_BASE_DIR, '..', 'database')

# master.db = file lama devices.db (sudah berisi networks/users/superadmins)
MASTER_DB_PATH = os.path.join(_DB_DIR, 'devices.db')
# folder file per-owner
OWNER_DB_DIR   = os.path.join(_DB_DIR, 'owners')

# Backward-compat: sebagian kode lama masih pakai DB_PATH
DB_PATH = MASTER_DB_PATH


def get_master_db() -> sqlite3.Connection:
    """Koneksi ke MASTER db (auth, networks, users, superadmins)."""
    conn = sqlite3.connect(MASTER_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _owner_db_path(network_id: str) -> str:
    """Path file DB untuk satu owner. network_id dipakai sbg nama file."""
    safe = ''.join(c for c in str(network_id) if c.isalnum() or c in '-_')
    return os.path.join(OWNER_DB_DIR, '{}.db'.format(safe))


def get_owner_db(network_id: str) -> sqlite3.Connection:
    """
    Koneksi ke file DB milik owner tertentu.
    File otomatis dibuat + skema di-init jika belum ada (idempotent).
    """
    if not network_id:
        raise ValueError('network_id wajib untuk get_owner_db()')
    os.makedirs(OWNER_DB_DIR, exist_ok=True)
    path = _owner_db_path(network_id)
    # timeout besar + WAL: penting karena sync OLT (olt_sync.py) bisa membuka
    # banyak koneksi paralel ke file owner yang sama — tanpa ini, penulisan
    # bersamaan akan gagal cepat dengan error "database is locked".
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    init_owner_schema(conn)        # idempotent — CREATE TABLE IF NOT EXISTS
    return conn


def get_db() -> sqlite3.Connection:
    """
    OWNER-AWARE: kembalikan koneksi ke file DB owner yang sedang login.

    Urutan sumber network_id:
      1. g.network_id   → diset oleh decorator @login_required (paling andal)
      2. session['network_id'] → diset saat login

    Jika tidak ada konteks owner (import-time / startup / endpoint tanpa
    login) → fallback ke MASTER agar tidak crash. Endpoint data operasional
    WAJIB dilindungi @login_required (Stage 4) agar selalu dapat owner DB.
    """
    nid = None
    try:
        from flask import g, session, has_request_context
        nid = getattr(g, 'network_id', None)
        if not nid and has_request_context():
            nid = session.get('network_id')
    except Exception:
        nid = None

    if nid:
        return get_owner_db(nid)

    # Fallback → master (tanpa konteks owner)
    conn = sqlite3.connect(MASTER_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ══════════════════════════════════════════════════════════════
# SKEMA DB OWNER — semua tabel operasional 1 owner
# Dipanggil otomatis tiap buka file owner (CREATE TABLE IF NOT EXISTS).
# ══════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════
# PAKET & STATUS LANGGANAN OWNER (sumber: packages.py + master.db)
# ══════════════════════════════════════════════════════════════

def get_network_row(network_id: str):
    """Ambil baris networks (paket, status, trial_end, expired_at, created_at)."""
    try:
        conn = get_master_db()
        row = conn.execute(
            'SELECT paket, status, trial_end, expired_at, created_at FROM networks WHERE network_id = ?',
            (network_id,)
        ).fetchone()
        conn.close()
        return row
    except Exception:
        return None


def get_isp_profile(conn, network_id: str = None) -> dict:
    """
    Ambil profil ISP (nama + logo) untuk kop laporan/struk.
    `conn` = koneksi DB owner (get_db()) yang menyimpan tabel app_settings.
    Fallback nama ISP ke `networks.isp_name` (master) bila `profil_isp`
    belum diisi di pengaturan owner.
    """
    import json as _json

    def _load_setting(key, default):
        try:
            row = conn.execute('SELECT value FROM app_settings WHERE key = ?', (key,)).fetchone()
        except Exception:
            return default
        if not row:
            return default
        try:
            return _json.loads(row['value'])
        except Exception:
            return default

    logo_data  = _load_setting('isp_logo', {})
    profil_isp = _load_setting('profil_isp', {})

    isp_name = profil_isp.get('isp_name', '')
    if not isp_name and network_id:
        try:
            mconn = get_master_db()
            row = mconn.execute('SELECT isp_name FROM networks WHERE network_id = ?', (network_id,)).fetchone()
            mconn.close()
            isp_name = (row['isp_name'] if row else '') or ''
        except Exception:
            isp_name = ''

    return {
        'isp_name': isp_name or 'ISP',
        'isp_logo': logo_data.get('logo_base64', ''),
    }


_ISOLIR_KEYWORDS = ('isolir', 'blokir', 'suspend', 'block', 'isolasi')


def is_isolir_profil(profil: str) -> bool:
    """
    True kalau nama profil PPP menandakan pelanggan sedang diisolir/diblokir
    karena nunggak (bukan di-disable — secret tetap aktif tapi profil diganti
    ke profil berkecepatan rendah). Dipakai portal pelanggan untuk redirect
    ke halaman isolir, karena kolom `aktif` (= status disabled di MikroTik)
    tidak berubah saat isolir.
    """
    p = (profil or '').lower()
    return any(kw in p for kw in _ISOLIR_KEYWORDS)


def status_secret_comment(nama: str, status: str = '') -> str:
    """
    Bangun teks komentar PPP Secret dengan tag status singkat — supaya staf
    yang cek MikroTik langsung bisa melihat pelanggan mana yang sedang
    diisolir karena nunggak, tanpa perlu buka aplikasi billing.

    status: '' (normal) | 'isolir' (sedang diisolir krn belum bayar)
    """
    nama = (nama or '').strip() or '-'
    if status == 'isolir':
        return f'{nama} - ISOLIR (nunggak)'
    if status == 'piutang':
        return f'{nama} - PIUTANG (diaktifkan)'
    return nama


def get_network_package(network_id: str) -> str:
    """
    Nama paket owner untuk keperluan limit/fitur. Default 'trial'.

    Selama status masih 'trial', limit yang dipakai SELALU paket 'trial'
    (bukan paket yang dipilih saat registrasi) — agar pendaftar tidak bisa
    mendapatkan limit paket besar (mis. enterprise) secara gratis selama
    masa uji coba. `networks.paket` tetap menyimpan paket pilihan untuk
    referensi setelah owner upgrade ke status 'active'.
    """
    row = get_network_row(network_id)
    if not row:
        return 'trial'
    status = (row['status'] or 'trial')
    if status == 'trial':
        return 'trial'
    if row['paket']:
        return row['paket']
    return 'trial'


def get_pelanggan_limit(network_id: str):
    """Batas jumlah pelanggan untuk paket owner. None = unlimited."""
    from packages import package_limit
    return package_limit(get_network_package(network_id), 'pelanggan')


def get_effective_status(network_id: str) -> str:
    """
    Status efektif owner:
      'trial'   → masih dalam masa uji coba (belum lewat trial_end)
      'active'  → langganan berbayar aktif (belum lewat expired_at)
      'locked'  → trial habis / langganan expired → akses data diblokir
      'suspended' → di-suspend superadmin
    """
    from datetime import datetime
    row = get_network_row(network_id)
    if not row:
        return 'locked'
    status = (row['status'] or 'trial')

    if status == 'suspended':
        return 'suspended'

    now = datetime.now()
    if status == 'trial':
        te = (row['trial_end'] or '').strip()
        if te:
            try:
                if now > datetime.fromisoformat(te):
                    return 'locked'        # trial sudah lewat
                return 'trial'
            except Exception:
                pass
        # trial_end kosong/tidak valid (data lama/korup) → fallback hitung
        # dari created_at + TRIAL_DAYS, supaya trial tetap bisa berakhir.
        try:
            from packages import TRIAL_DAYS
            from datetime import timedelta
            ca = (row['created_at'] or '').strip()
            if ca:
                created = datetime.fromisoformat(ca.replace(' ', 'T'))
                if now > created + timedelta(days=TRIAL_DAYS):
                    return 'locked'
        except Exception:
            pass
        return 'trial'

    if status == 'active':
        ex = (row['expired_at'] or '').strip()
        if ex:
            try:
                if now > datetime.fromisoformat(ex):
                    return 'locked'        # langganan habis
            except Exception:
                pass
        return 'active'

    return status  # locked / lainnya


def _add_column(cur, table: str, column: str, decl: str) -> None:
    """ALTER TABLE ADD COLUMN aman: lewati bila kolom sudah ada."""
    cols = [r[1] for r in cur.execute('PRAGMA table_info(%s)' % table).fetchall()]
    if column not in cols:
        cur.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, column, decl))


def init_owner_schema(conn: sqlite3.Connection) -> None:
    """Buat semua tabel operasional di file DB owner (idempotent)."""
    cur = conn.cursor()

    cur.execute('''CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, ip TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 8728,
        username TEXT NOT NULL, password TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        koordinat TEXT DEFAULT '',
        public_ip TEXT DEFAULT '', wan_interface TEXT DEFAULT '',
        remote_onu_ip TEXT DEFAULT '', remote_onu_port INTEGER DEFAULT NULL,
        remote_onu_comment TEXT DEFAULT 'Remote-Onu',
        remote_onu_local_ip TEXT DEFAULT '',
        UNIQUE(ip, port)
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS pelanggan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER, username TEXT, password TEXT,
        sn TEXT DEFAULT '', hp TEXT DEFAULT '', profil TEXT DEFAULT '',
        service TEXT DEFAULT 'pppoe', slot_port_onu TEXT DEFAULT '',
        vlan TEXT DEFAULT '', titik_koordinat TEXT DEFAULT '',
        tgl_pasang TEXT DEFAULT '', tgl_jatuh TEXT DEFAULT '',
        profil_sebelum TEXT DEFAULT '', nama TEXT DEFAULT '',
        aktif INTEGER DEFAULT 1, odp_id INTEGER DEFAULT NULL
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS onu_mapping (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE, olt_id INTEGER,
        slot_port TEXT DEFAULT '', vlan TEXT DEFAULT '', sn TEXT DEFAULT '',
        rx_power REAL, tx_power REAL, synced_at TEXT DEFAULT '',
        tcont_profile TEXT DEFAULT '', ip_address TEXT DEFAULT '',
        is_online INTEGER DEFAULT 0
    )''')
    # Migrasi kolom baru (idempotent)
    for col, defval in [('ip_address', '""'), ('is_online', '0')]:
        try:
            cur.execute(f'ALTER TABLE onu_mapping ADD COLUMN {col} TEXT DEFAULT {defval}')
        except Exception:
            pass

    cur.execute('''CREATE TABLE IF NOT EXISTS onu_liar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        olt_id INTEGER NOT NULL,
        sn TEXT NOT NULL,
        port TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        UNIQUE(olt_id, sn)
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS profil_harga (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL, nama_profile TEXT NOT NULL,
        harga INTEGER NOT NULL DEFAULT 0, deskripsi TEXT DEFAULT '',
        bandwidth_note TEXT DEFAULT '',
        UNIQUE(device_id, nama_profile)
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS olt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, tipe TEXT DEFAULT '', ip TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 23, username TEXT NOT NULL,
        password TEXT NOT NULL, snmp TEXT DEFAULT '', lokasi TEXT DEFAULT '',
        keterangan TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        epon_ports INTEGER DEFAULT 4, koordinat TEXT DEFAULT '',
        router_id INTEGER DEFAULT NULL, router_interface TEXT DEFAULT '',
        olt_uplink_port TEXT DEFAULT ''
    )''')

    # Satu OLT bisa punya >1 jalur uplink fisik ke router berbeda
    # (mis. redundansi atau split trafik per VLAN ke 2 MikroTik).
    cur.execute('''CREATE TABLE IF NOT EXISTS olt_uplink (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        olt_id INTEGER NOT NULL,
        router_id INTEGER NOT NULL,
        router_interface TEXT DEFAULT '',
        uplink_port TEXT DEFAULT '',
        keterangan TEXT DEFAULT ''
    )''')

    # Migrasi data lama: olt.router_id (kolom tunggal) -> baris pertama di olt_uplink
    _sudah_migrasi = {r['olt_id'] for r in cur.execute(
        'SELECT DISTINCT olt_id FROM olt_uplink').fetchall()}
    for r in cur.execute(
        'SELECT id, router_id, router_interface, olt_uplink_port FROM olt '
        'WHERE router_id IS NOT NULL'
    ).fetchall():
        if r['id'] not in _sudah_migrasi:
            cur.execute(
                'INSERT INTO olt_uplink (olt_id, router_id, router_interface, uplink_port) '
                'VALUES (?, ?, ?, ?)',
                (r['id'], r['router_id'], r['router_interface'] or '', r['olt_uplink_port'] or '')
            )

    cur.execute('''CREATE TABLE IF NOT EXISTS odc (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama TEXT NOT NULL, lokasi TEXT DEFAULT '', koordinat TEXT DEFAULT '',
        tipe_kabel TEXT DEFAULT '', jumlah_port INTEGER DEFAULT 0,
        olt_id INTEGER, keterangan TEXT DEFAULT '',
        port_terpakai INTEGER DEFAULT 0
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS odp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nama TEXT NOT NULL, lokasi TEXT DEFAULT '', koordinat TEXT DEFAULT '',
        jumlah_port INTEGER DEFAULT 0, port_terpakai INTEGER DEFAULT 0,
        odc_id INTEGER DEFAULT NULL,
        parent_odp_id INTEGER DEFAULT NULL,  -- cascade: terhubung ke ODP lain
        port_odc INTEGER DEFAULT NULL,       -- port ODC yang dipakai
        port_parent_odp INTEGER DEFAULT NULL, -- port ODP parent yang dipakai
        keterangan TEXT DEFAULT ''
    )''')

    # Migrasi kolom baru ke tabel existing
    # Slot NAT "Remote ONU" — port forwarding tetap per MikroTik (comment=Remote-Onu di NAT),
    # to-addresses-nya direpoint ke IP modem pelanggan saat tombol Remote Modem ditekan.
    _add_column(cur, 'devices', 'remote_onu_ip', "TEXT DEFAULT ''")
    _add_column(cur, 'devices', 'remote_onu_port', 'INTEGER DEFAULT NULL')
    _add_column(cur, 'devices', 'remote_onu_comment', "TEXT DEFAULT 'Remote-Onu'")
    _add_column(cur, 'devices', 'remote_onu_local_ip', "TEXT DEFAULT ''")
    _add_column(cur, 'odc', 'port_terpakai', 'INTEGER DEFAULT 0')
    _add_column(cur, 'odp', 'port_odc', 'INTEGER DEFAULT NULL')
    _add_column(cur, 'odp', 'parent_odp_id', 'INTEGER DEFAULT NULL')
    _add_column(cur, 'odp', 'port_parent_odp', 'INTEGER DEFAULT NULL')
    _add_column(cur, 'odp', 'olt_id', 'INTEGER DEFAULT NULL')
    _add_column(cur, 'pelanggan', 'port_odp', 'INTEGER DEFAULT NULL')
    # Keyword tipe ONU di perintah CLI registrasi — beda firmware/model OLT
    # pakai 'ALL' atau 'ALL-ONT' (lihat _build_olt_cli di api.py)
    _add_column(cur, 'olt', 'onu_type_keyword', "TEXT DEFAULT 'ALL'")

    cur.execute('''CREATE TABLE IF NOT EXISTS keuangan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tanggal TEXT NOT NULL,
        keterangan TEXT DEFAULT '',
        tipe TEXT NOT NULL DEFAULT 'pemasukan',  -- pemasukan | pengeluaran
        nominal INTEGER NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'Pending',           -- Lunas | Pending | Gagal
        metode TEXT DEFAULT '',
        device_id INTEGER,
        username TEXT DEFAULT '',
        catatan TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS tagihan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pelanggan_id INTEGER NOT NULL,
        username TEXT DEFAULT '',
        nama TEXT DEFAULT '',
        profil TEXT DEFAULT '',
        periode TEXT NOT NULL,                   -- YYYY-MM
        nominal INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'belum_bayar',  -- belum_bayar | lunas
        jatuh_tempo TEXT DEFAULT '',
        paid_at TEXT DEFAULT '',
        metode TEXT DEFAULT '',
        kolektor TEXT DEFAULT '',                 -- username yang menerima bayar (loket)
        komisi INTEGER NOT NULL DEFAULT 0,        -- komisi kolektor untuk tagihan ini
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(pelanggan_id, periode)
    )''')

    # Migrasi kolom tagihan untuk DB owner lama
    _add_column(cur, 'tagihan', 'kolektor', "TEXT DEFAULT ''")
    _add_column(cur, 'tagihan', 'komisi', "INTEGER NOT NULL DEFAULT 0")

    # Migrasi kolom kolektor di pelanggan
    _add_column(cur, 'pelanggan', 'kolektor', "TEXT DEFAULT ''")
    # Kolom profil sebelum isolir (dipakai auto-isolir & restore)
    _add_column(cur, 'pelanggan', 'profil_sebelum_isolir', "TEXT DEFAULT ''")
    # Kolom status khusus pelanggan
    _add_column(cur, 'pelanggan', 'is_prioritas', 'INTEGER DEFAULT 0')
    _add_column(cur, 'pelanggan', 'catatan_khusus', "TEXT DEFAULT ''")
    # Alamat pelanggan — dibaca oleh loket.py (struk) & portal.py, tapi
    # kolomnya belum pernah ada di skema sehingga query SELECT alamat gagal
    _add_column(cur, 'pelanggan', 'alamat', "TEXT DEFAULT ''")
    # Kolom berikut dipakai api.py (sync MikroTik/OLT) & portal.py tapi hanya
    # dimigrasikan oleh api.migrate_pelanggan_table() yang berjalan SEKALI saat
    # modul di-import — owner yang DB-nya dibuat SETELAH itu (mis. ISP baru
    # daftar setelah server start) tidak pernah dapat kolom ini, sehingga
    # SELECT/INSERT/UPDATE terkait gagal dengan "no such column". Pindahkan ke
    # sini supaya selalu ditambahkan tiap kali koneksi owner dibuka.
    _add_column(cur, 'pelanggan', 'olt_id', 'INTEGER')
    _add_column(cur, 'pelanggan', 'slot_port', "TEXT DEFAULT ''")
    _add_column(cur, 'pelanggan', 'no_hp', "TEXT DEFAULT ''")
    _add_column(cur, 'pelanggan', 'harga', 'INTEGER DEFAULT 0')
    # Kolom audit piutang di tagihan
    _add_column(cur, 'tagihan', 'piutang_at', "TEXT DEFAULT ''")
    _add_column(cur, 'tagihan', 'piutang_oleh', "TEXT DEFAULT ''")

    # Pengaturan key-value per-owner (mis. komisi loket,
    # gateway WhatsApp, payment gateway)
    cur.execute('''CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')

    # Log pengiriman WhatsApp
    cur.execute('''CREATE TABLE IF NOT EXISTS wa_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tujuan TEXT DEFAULT '', nama TEXT DEFAULT '',
        pesan TEXT DEFAULT '', status TEXT DEFAULT 'terkirim',  -- terkirim | gagal | mock
        provider TEXT DEFAULT '', keterangan TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')

    # Jejak pengiriman pengingat WA otomatis — cegah kirim dobel untuk
    # tagihan+tipe (h3/jatuh_tempo/telat) yang sama
    cur.execute('''CREATE TABLE IF NOT EXISTS wa_reminder_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tagihan_id INTEGER NOT NULL,
        tipe TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tagihan_id, tipe)
    )''')

    # Record transaksi payment gateway
    cur.execute('''CREATE TABLE IF NOT EXISTS pembayaran (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tagihan_id INTEGER, order_id TEXT UNIQUE,
        provider TEXT DEFAULT '', channel TEXT DEFAULT '',
        amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | expired | failed
        payment_url TEXT DEFAULT '',
        username TEXT DEFAULT '', periode TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at TEXT DEFAULT ''
    )''')

    # Tiket laporan gangguan pelanggan (dari portal)
    cur.execute('''CREATE TABLE IF NOT EXISTS tiket (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT NOT NULL,
        network_id TEXT DEFAULT '',
        kategori   TEXT DEFAULT 'Umum',
        judul      TEXT NOT NULL,
        deskripsi  TEXT DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'Baru',
        catatan_cs TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )''')

    # Feed "Live Aktivitas" dashboard — semua aksi penting (pelanggan,
    # perangkat, keuangan, tagihan), bukan cuma transaksi keuangan.
    cur.execute('''CREATE TABLE IF NOT EXISTS aktivitas_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tipe       TEXT NOT NULL,            -- pelanggan | perangkat | keuangan | tagihan
        aksi       TEXT NOT NULL,            -- tambah | edit | hapus | isolir | aktifkan |
                                              -- nonaktif | pemasukan | pengeluaran | lunas |
                                              -- piutang | connect | disconnect
        target     TEXT DEFAULT '',
        pesan      TEXT NOT NULL DEFAULT '',
        nominal    INTEGER,
        aktor      TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')

    conn.commit()


def catat_aktivitas(tipe, aksi, target='', pesan='', nominal=None, aktor='', conn=None):
    """
    Catat satu baris ke aktivitas_log (sumber feed "Live Aktivitas" dashboard).

    Gagal-aman: error di sini TIDAK boleh menggagalkan aksi utama pemanggil.
    Jika `conn` diberikan (koneksi owner yang sudah terbuka & akan di-commit
    oleh caller), insert ikut transaksi itu tanpa membuka koneksi baru.
    """
    if not aktor:
        try:
            from flask import g
            cu = getattr(g, 'current_user', None)
            aktor = (cu or {}).get('username', '') or ''
        except Exception:
            aktor = ''
    try:
        own_conn = conn is None
        c = conn or get_db()
        c.execute(
            'INSERT INTO aktivitas_log (tipe, aksi, target, pesan, nominal, aktor) VALUES (?,?,?,?,?,?)',
            (tipe, aksi, target, pesan, nominal, aktor)
        )
        if own_conn:
            c.commit()
            c.close()
    except Exception as e:
        logger.warning(f'[Aktivitas] Gagal mencatat log: {e}')


# ══════════════════════════════════════════════════════════════
# 2. DEVICE (MikroTik) → dict
# ══════════════════════════════════════════════════════════════

def device_to_dict(row) -> dict:
    """
    Ubah sqlite3.Row tabel 'devices' → dict.
    Password TIDAK disertakan untuk keamanan frontend.
    """
    return {
        'id':        row['id'],
        'name':      row['name'],
        'ip':        row['ip'],
        'port':      row['port'],
        'username':  row['username'],
        'status':    row['status'],
        'koordinat': row['koordinat'] if 'koordinat' in row.keys() else '',
        'public_ip': row['public_ip'] if 'public_ip' in row.keys() else '',
        'wan_interface': row['wan_interface'] if 'wan_interface' in row.keys() else '',
        'remote_onu_ip': row['remote_onu_ip'] if 'remote_onu_ip' in row.keys() else '',
        'remote_onu_port': row['remote_onu_port'] if 'remote_onu_port' in row.keys() else None,
        'remote_onu_comment': (row['remote_onu_comment'] if 'remote_onu_comment' in row.keys() else '') or 'Remote-Onu',
        'remote_onu_local_ip': row['remote_onu_local_ip'] if 'remote_onu_local_ip' in row.keys() else '',
    }


# ══════════════════════════════════════════════════════════════
# 3. OLT → dict
# ══════════════════════════════════════════════════════════════

def olt_to_dict(row) -> dict:
    """
    Ubah sqlite3.Row tabel 'olt' → dict.
    Password TIDAK disertakan untuk keamanan frontend.
    """
    def _safe(k):
        try: return row[k] or ''
        except: return ''
    return {
        'id':               row['id'],
        'name':             row['name'],
        'tipe':             _safe('tipe'),
        'ip':               row['ip'],
        'port':             row['port'],
        'username':         row['username'],
        'snmp':             _safe('snmp'),
        'lokasi':           _safe('lokasi'),
        'koordinat':        _safe('koordinat'),
        'keterangan':       _safe('keterangan'),
        'status':           row['status'],
        # v3.0 — topologi: relasi OLT → Router (legacy, lihat olt_uplink utk multi-uplink)
        'router_id':        row['router_id']        if 'router_id'        in row.keys() else None,
        'router_interface': row['router_interface'] if 'router_interface' in row.keys() else '',
        'olt_uplink_port':  row['olt_uplink_port']  if 'olt_uplink_port'  in row.keys() else '',
    }


def get_olt_uplinks(conn, olt_id: int) -> list:
    """
    Daftar jalur uplink fisik OLT -> router (satu OLT bisa >1 uplink,
    mis. 2 jalur fisik ke 2 MikroTik berbeda untuk redundansi/split VLAN).
    """
    rows = conn.execute(
        'SELECT id, router_id, router_interface, uplink_port, keterangan '
        'FROM olt_uplink WHERE olt_id = ? ORDER BY id', (olt_id,)
    ).fetchall()
    return [{
        'id':               r['id'],
        'router_id':        r['router_id'],
        'router_interface': r['router_interface'] or '',
        'uplink_port':      r['uplink_port'] or '',
        'keterangan':       r['keterangan'] or '',
    } for r in rows]


# ══════════════════════════════════════════════════════════════
# 4. KONEKSI MIKROTIK — RouterOS API
# ══════════════════════════════════════════════════════════════

def try_connect_mikrotik(ip: str, port, username: str, password: str):
    """
    Coba koneksi ke MikroTik via RouterOS API.
    Mengembalikan (True, nama_router) jika berhasil,
    atau (False, pesan_error) jika gagal.

    Dipakai oleh: input.py  (tambah/sync perangkat)
    """
    try:
        port_int = int(port) if str(port).strip().isdigit() else 8728

        connection = routeros_api.RouterOsApiPool(
            ip,
            username=username,
            password=password,
            port=port_int,
            plaintext_login=True
        )
        api         = connection.get_api()
        system_id   = api.get_resource('/system/identity').get()
        router_name = system_id[0]['name'] if system_id else ip
        connection.disconnect()

        logger.info(f'[MikroTik] Koneksi OK → {ip}:{port_int} ({router_name})')
        return True, router_name

    except Exception as e:
        msg = 'Gagal terhubung. Periksa IP, port, username, dan password.'
        logger.error(f'[MikroTik] Koneksi gagal ke {ip}:{port} — {e}')
        return False, msg


# ══════════════════════════════════════════════════════════════
# 5. KONEKSI OLT — TCP Socket
# ══════════════════════════════════════════════════════════════

def try_connect_olt(ip: str, port, username: str, password: str):
    """
    Tes koneksi ke OLT dengan membuka socket TCP ke ip:port.
    Jika port terbuka → status 'connected'.

    Untuk koneksi Telnet/SSH penuh, ganti implementasi ini dengan
    librari paramiko (SSH) atau telnetlib (Telnet).

    Dipakai oleh: olt.py  (tambah/sync OLT)
    """
    try:
        port_int = int(port) if str(port).strip().isdigit() else 23
        sock     = socket.create_connection((ip, port_int), timeout=8)
        sock.close()
        logger.info(f'[OLT] Koneksi OK → {ip}:{port_int}')
        return True, f'Berhasil terhubung ke {ip}:{port_int}'

    except socket.timeout:
        msg = f'Koneksi ke {ip}:{port} timeout (8 detik)'
        logger.warning(f'[OLT] {msg}')
        return False, msg

    except ConnectionRefusedError:
        msg = f'Port {port} di {ip} ditolak atau tidak aktif'
        logger.warning(f'[OLT] {msg}')
        return False, msg

    except OSError as e:
        msg = f'Tidak dapat menjangkau {ip}:{port} — {e}'
        logger.error(f'[OLT] {msg}')
        return False, msg


# ══════════════════════════════════════════════════════════════
# 6. PARSE RX POWER — nilai dBm dari string CLI/API
# ══════════════════════════════════════════════════════════════

def parse_rx_power(raw_value) -> float | None:
    """
    Parse nilai daya optik RX/TX dari string CLI OLT atau field API.

    Contoh input yang didukung:
      "-25.50 dBm"    → -25.5
      "-25.50"        → -25.5
      -25.50          → -25.5   (sudah float)
      "N/A"           → None
      ""              → None
      None            → None

    Return: float atau None jika tidak bisa di-parse.
    """
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)

    # Hapus satuan dan whitespace
    s = str(raw_value).replace('dBm', '').replace('DBM', '').strip()

    # Coba parse langsung
    try:
        return float(s)
    except ValueError:
        pass

    # Cari pola angka (positif atau negatif, opsional desimal)
    m = re.search(r'(-?\d+(?:\.\d+)?)', s)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass

    return None


# ══════════════════════════════════════════════════════════════
# 7. PARSE RX POWER — Huawei MA5600/MA5800 CLI
# ══════════════════════════════════════════════════════════════

def parse_huawei_rx(cli_output: str) -> dict:
    """
    Parse output perintah Huawei:
      'display ont optical-info <frame/slot/port> <ont-id>'
    atau
      'display pon onu optical-info <card/port> <onu-id>'

    Contoh output:
      Rx optical power(dBm)  : -24.50
      Tx optical power(dBm)  : 2.34

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    # Huawei biasanya pakai format "Rx optical power(dBm)  : -24.50"
    rx_match = re.search(
        r'[Rr]x\s+optical\s+power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )
    tx_match = re.search(
        r'[Tt]x\s+optical\s+power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 8. PARSE RX POWER — ZTE C300/C600 CLI
# ══════════════════════════════════════════════════════════════

def parse_zte_rx(cli_output: str) -> dict:
    """
    Parse output perintah ZTE:
      'show pon onu optical-info gpon-onu_<slot/port>:<onu>'
      'show pon power attenuation gpon-onu_<slot/port>:<onu>'
    atau perintah equivalen.

    Mendukung tiga format output ZTE C300/C600/C320 yang umum ditemui:

    Format A — satuan di belakang label (paling umum di C300/C600):
      Rx optical power(dBm)         :-25.47
      Tx optical power(dBm)         : 2.10

    Format B — satuan di belakang angka:
      Rx power   : -25.47 dBm
      Tx power   : 2.10 dBm

    Format C — tabel "show pon power attenuation" (umum di ZTE C320):
                 OLT                  ONU              Attenuation
       up      Rx :no signal         Tx:2.868(dbm)        N/A
       down    Tx :4.230(dbm)        Rx:-18.210(dbm)      22.440(dB)
      Nilai ONU Rx (downstream, baris "down") = rx_power pelanggan,
      nilai ONU Tx (upstream, baris "up") = tx_power pelanggan.

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    # Format A: "Rx optical power(dBm) : -25.47"  — satuan di label
    rx_match = re.search(
        r'[Rr]x\s+(?:optical\s+)?power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )
    tx_match = re.search(
        r'[Tt]x\s+(?:optical\s+)?power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )

    # Format B: "Rx power : -25.47 dBm"  — satuan di belakang angka (fallback)
    if not rx_match:
        rx_match = re.search(
            r'[Rr]x\s+power\s*[:\-]\s*(-?\d+(?:\.\d+)?)\s*dBm',
            cli_output
        )
    if not tx_match:
        tx_match = re.search(
            r'[Tt]x\s+power\s*[:\-]\s*(-?\d+(?:\.\d+)?)\s*dBm',
            cli_output
        )

    # Format C: tabel "show pon power attenuation" — kolom ONU pada baris up/down
    if not tx_match:
        tx_match = re.search(
            r'up\s+Rx\s*:\s*\S+\s+Tx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm\)?',
            cli_output, re.IGNORECASE
        )
    if not rx_match:
        rx_match = re.search(
            r'down\s+Tx\s*:\s*\S+\s+Rx\s*:\s*(-?\d+(?:\.\d+)?)\s*\(?dbm\)?',
            cli_output, re.IGNORECASE
        )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 9. PARSE RX POWER — Generic / V-Sol / Hioso
# ══════════════════════════════════════════════════════════════

def parse_generic_rx(cli_output: str) -> dict:
    """
    Parser umum untuk merk OLT yang belum dikenal.
    Mencari pola angka dBm di output CLI mana saja.

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    # Cari RX dulu
    rx_match = re.search(
        r'(?:[Rr][Xx]|[Rr]eceive)\s*(?:power|level|signal)?\s*[:\-=]?\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )
    tx_match = re.search(
        r'(?:[Tt][Xx]|[Tt]ransmit)\s*(?:power|level|signal)?\s*[:\-=]?\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 10. AMBIL DATA ONU DARI DATABASE
# ══════════════════════════════════════════════════════════════

def get_onu_data(username: str, conn: sqlite3.Connection = None) -> dict:
    """
    Ambil data ONU dari onu_mapping berdasarkan username.
    Fallback: cari via slot_port_onu atau sn dari tabel pelanggan
    (untuk EPON yang sync pakai MAC, bukan PPPoE username).

    Jika `conn` diberikan (koneksi yang sudah terbuka), dipakai langsung —
    penting saat dipanggil dalam loop per-pelanggan agar tidak membuka
    koneksi baru (+ init_owner_schema) untuk setiap baris.
    """
    own_conn = conn is None
    if own_conn:
        conn = get_db()
    row  = conn.execute(
        '''SELECT slot_port, vlan, sn, olt_id,
                  rx_power, tx_power, tcont_profile
           FROM onu_mapping WHERE username = ?''',
        (username,)
    ).fetchone()

    # Fallback untuk EPON: cari via slot_port atau sn pelanggan
    if not row:
        p = conn.execute(
            "SELECT slot_port_onu, sn FROM pelanggan WHERE username=? LIMIT 1",
            (username,)
        ).fetchone()
        if p:
            if p['slot_port_onu']:
                row = conn.execute(
                    '''SELECT slot_port, vlan, sn, olt_id, rx_power, tx_power, tcont_profile
                       FROM onu_mapping WHERE slot_port=? LIMIT 1''',
                    (p['slot_port_onu'],)
                ).fetchone()
            if not row and p['sn']:
                row = conn.execute(
                    '''SELECT slot_port, vlan, sn, olt_id, rx_power, tx_power, tcont_profile
                       FROM onu_mapping WHERE sn=? LIMIT 1''',
                    (p['sn'],)
                ).fetchone()

    # Fallback: OLT HSGQ EPON truncate nama ONU (mis. 'deva_kulonka' vs 'deva_kulonkali')
    # Coba prefix match — ambil yang paling panjang agar tidak salah cocok
    if not row and len(username) > 6:
        candidates = conn.execute(
            '''SELECT slot_port, vlan, sn, olt_id, rx_power, tx_power, tcont_profile, username
               FROM onu_mapping WHERE username LIKE ? AND username NOT LIKE 'mac:%' ''',
            (username[:8] + '%',)
        ).fetchall()
        # Pilih kandidat yang nama-nya merupakan prefix dari username pelanggan
        best = None
        for c in candidates:
            if username.startswith(c['username']) or c['username'].startswith(username[:10]):
                if best is None or len(c['username']) > len(best['username']):
                    best = c
        if best:
            # Sekalian update username di onu_mapping agar berikutnya langsung cocok
            try:
                conn.execute(
                    'UPDATE onu_mapping SET username=? WHERE username=?',
                    (username, best['username'])
                )
                if own_conn:
                    conn.commit()
            except sqlite3.IntegrityError:
                # username sudah dipakai baris lain (UNIQUE) — biarkan baris lama,
                # tetap pakai data 'best' untuk response kali ini
                if own_conn:
                    conn.rollback()
            row = best

    if own_conn:
        conn.close()

    if row:
        return {
            'slot_port':     row['slot_port'] or '',
            'vlan':          row['vlan']      or '',
            'sn':            row['sn']        or '',
            'olt_id':        row['olt_id'],
            'rx_power':      parse_rx_power(row['rx_power']),
            'tx_power':      parse_rx_power(row['tx_power']),
            'tcont_profile': (row['tcont_profile'] if 'tcont_profile' in row.keys() else '') or '',
        }

    return {
        'slot_port':     '',
        'vlan':          '',
        'sn':            '',
        'olt_id':        None,
        'rx_power':      None,
        'tx_power':      None,
        'tcont_profile': '',
    }