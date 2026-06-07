"""
api.py — TechnoFix Backend
============================
Blueprint Flask yang mencakup semua endpoint API:
  1. Pelanggan (PPP Secrets MikroTik + ONU mapping)
  2. Peta Topologi Jaringan
  3. Keuangan (transaksi, statistik)
  4. PPPoE Profile (MikroTik + harga lokal)

Menggunakan utils.py untuk helper terpusat.

✅ FASE 1 — CLEANUP:
   - Hapus Blueprint duplikat (api_bp dideklarasikan 2x → crash AssertionError).
   - Hapus semua docstring artefak instruksi copy-paste
     ("maps_api_snippet.py", "keuangan_api_snippet.py", dll).
   - Selamatkan endpoint action_pelanggan & PPPoE Profile yang
     sebelumnya hanya ada di duplikat kedua — dipindah ke sini.
   - Pindahkan init_keuangan_table() agar dipanggil dari init_db()
     di input.py, bukan auto-run saat import (side-effect berbahaya).
"""

import os
import re
import io
import csv
import logging
from datetime import datetime, date
import calendar

from flask import Blueprint, jsonify, request, g, Response

# ── Shared helpers ────────────────────────────────────────────
from utils import get_db, get_onu_data

# ── MikroTik client ───────────────────────────────────────────
from mikrotik import MikroTikClient, MikroTikError

# ── Scrapli untuk RX/TX real-time dari OLT (opsional) ────────
try:
    from scrapli.driver.generic import GenericDriver
    SCRAPLI_OK = True
except ImportError:
    SCRAPLI_OK = False

# ── Blueprint ─────────────────────────────────────────────────
# [SATU DEFINISI — duplikat di baris ~1389 asli dihapus]
api_bp = Blueprint('api', __name__)


# ── Guard multi-tenant: login + lock + permission per-path ─────
@api_bp.before_request
def _api_guard():
    if request.method == 'OPTIONS':
        return  # biarkan CORS preflight lewat
    from auth import guard_request

    p = request.path.rstrip('/')
    method = request.method

    # Endpoint langganan/usage boleh meski langganan terkunci
    if p.endswith('/usage') or p.endswith('/subscription'):
        return guard_request(allow_locked=True)

    # Tentukan permission yang dibutuhkan berdasarkan path
    perm = 'pelanggan'                              # default: butuh akses pelanggan
    if 'keuangan' in p:
        perm = 'keuangan'
    elif p.endswith('/bayar') or p.endswith('/enable') or p.endswith('/isolir') or p.endswith('/disable'):
        perm = 'bayar'                             # aksi pembayaran/aktivasi (kolektor boleh)
    elif '/pelanggan' in p and method in ('POST', 'PUT', 'DELETE'):
        perm = 'pelanggan_manage'                  # tambah/edit/hapus → kolektor TIDAK boleh
    elif '/pelanggan' in p:
        perm = 'pelanggan'                         # GET daftar/detail

    return guard_request(perm=perm)


# ── Info pemakaian & paket owner (untuk UI) ────────────────────
@api_bp.route('/usage', methods=['GET'])
def usage():
    """Paket aktif + status langganan + jumlah/limit pelanggan."""
    from utils import get_network_package, get_pelanggan_limit, get_effective_status, get_network_row
    from packages import get_package
    pkg    = get_network_package(g.network_id)
    limit  = get_pelanggan_limit(g.network_id)
    status = get_effective_status(g.network_id)
    row    = get_network_row(g.network_id)
    try:
        conn = get_db()
        jml  = conn.execute('SELECT COUNT(*) FROM pelanggan').fetchone()[0]
        conn.close()
    except Exception:
        jml = 0
    pdef = get_package(pkg)
    return jsonify({
        'paket':       pkg,
        'paket_nama':  pdef['name'],
        'status':      status,                           # trial|active|locked|suspended
        'trial_end':   (row['trial_end'] if row else '') or '',
        'expired_at':  (row['expired_at'] if row else '') or '',
        'pelanggan':   jml,
        'limit':       limit,                            # None = unlimited
        'sisa':        (None if limit is None else max(0, limit - jml)),
        'features':    pdef['features'],
    }), 200


# ── Daftar paket + langganan saat ini (boleh saat locked) ──────
@api_bp.route('/subscription', methods=['GET'])
def subscription():
    """Info langganan owner + semua paket yang tersedia (untuk halaman upgrade)."""
    from utils import get_network_package, get_effective_status, get_network_row
    from packages import public_packages, get_package
    pkg  = get_network_package(g.network_id)
    row  = get_network_row(g.network_id)
    return jsonify({
        'current': {
            'paket':      pkg,
            'paket_nama': get_package(pkg)['name'],
            'status':     get_effective_status(g.network_id),
            'trial_end':  (row['trial_end'] if row else '') or '',
            'expired_at': (row['expired_at'] if row else '') or '',
        },
        'packages': public_packages(),
    }), 200


logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# ══════════════════════════════════════════════════════════════
# MIGRASI DB — jalankan otomatis saat modul di-import
# Tambahkan kolom baru ke tabel pelanggan jika belum ada.
# Aman dipanggil berulang kali (cek PRAGMA table_info dulu).
# ══════════════════════════════════════════════════════════════

def migrate_pelanggan_table():
    """Tambahkan kolom yang belum ada ke tabel pelanggan di SEMUA owner DB.
    Aman dipanggil berulang kali — hanya ALTER jika kolom belum ada."""
    import glob as _glob, os as _os
    from utils import get_owner_db, OWNER_DB_DIR

    migrations = [
        ('tgl_pasang',       "TEXT DEFAULT ''"),
        ('tgl_jatuh',        "TEXT DEFAULT ''"),
        ('titik_koordinat',  "TEXT DEFAULT ''"),
        ('olt_id',           'INTEGER'),
        ('slot_port',        "TEXT DEFAULT ''"),
        ('vlan',             'INTEGER'),
        ('sn',               "TEXT DEFAULT ''"),
        ('hp',               "TEXT DEFAULT ''"),
        ('no_hp',            "TEXT DEFAULT ''"),
        ('harga',            "INTEGER DEFAULT 0"),
    ]

    owner_files = _glob.glob(_os.path.join(OWNER_DB_DIR, '*.db'))
    for db_path in owner_files:
        network_id = _os.path.splitext(_os.path.basename(db_path))[0]
        try:
            conn = get_owner_db(network_id)
            cols = {r[1] for r in conn.execute('PRAGMA table_info(pelanggan)').fetchall()}
            added = []
            for col, col_type in migrations:
                if col not in cols:
                    try:
                        conn.execute(f"ALTER TABLE pelanggan ADD COLUMN {col} {col_type}")
                        added.append(col)
                    except Exception as e:
                        logging.warning(f'[migrate] {network_id} kolom {col}: {e}')
            if added:
                conn.commit()
                logging.info(f'[migrate] {network_id}: kolom ditambahkan {added}')
            conn.close()
        except Exception as e:
            logging.warning(f'[migrate] {network_id} gagal: {e}')

# Jalankan migrasi saat modul di-import
try:
    migrate_pelanggan_table()
except Exception as _me:
    logging.warning(f'[migrate] Gagal migrasi tabel pelanggan: {_me}')




def cari_device(device_id: int) -> dict | None:
    """Cari device di tabel 'devices' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password, koordinat, public_ip FROM devices WHERE id = ?',
        (device_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def cari_olt(olt_id: int) -> dict | None:
    """Cari OLT di tabel 'olt' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password, tipe FROM olt WHERE id = ?',
        (olt_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# ══════════════════════════════════════════════════════════════
# HELPER — CLI Builder + Pengirim ke OLT (dipakai bersama oleh
#          /provision DAN tambah_pelanggan agar konsisten)
# ══════════════════════════════════════════════════════════════

def _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password, tcont_profile=None):
    """
    Bangun daftar perintah CLI registrasi ONU untuk OLT.

    Identik dengan yang ditampilkan di detail_pelanggan (Script CLI OLT).
    Password memakai password PPPoE ASLI (bukan potongan SN).

    PENTING — beda 2 jenis "profil":
      - profil         : nama profil PPPoE di MikroTik (cth: "100RB") — TIDAK dipakai di OLT
      - tcont_profile  : nama TCONT/bandwidth profile yang SUDAH ADA di OLT
                         (cth: "100M", "TCONT_100M"). Inilah yang dipakai di
                         perintah `tcont 1 profile <X>`.
      Kalau tcont_profile kosong, fallback ke 'default' (hampir semua OLT punya).

    Return: list[str] perintah CLI
    """
    parts     = (slot_port or '').split(':')
    gpon_path = parts[0] if parts else slot_port
    onu_id    = parts[1] if len(parts) > 1 else '1'
    vlan_val  = vlan or '200'
    pwd       = password or ''   # password PPPoE asli
    # TCONT profile di OLT — bukan profil PPPoE. Fallback 'default' kalau kosong.
    tcont     = (tcont_profile or '').strip() or 'default'

    if 'huawei' in (cli_type or '').lower():
        return [
            'enable',
            'config',
            f'interface gpon 0/{gpon_path}',
            f'ont add {onu_id} sn-auth {sn} omci ont-lineprofile-id 10 ont-srvprofile-id 10 desc {username}',
            'quit',
            f'service-port vlan {vlan_val} gpon 0/{gpon_path} ont {onu_id} gemport 1 multi-service user-vlan {vlan_val} tag-transform translate',
            'quit',
            'save',
        ]

    # HSGQ EPON (E04ID / E08ID)
    # slot_port format EPON: "2/3" → port=2, onu_id=3
    # sn di EPON = MAC address tanpa titik dua (disimpan dari sync), mis: 0C3747A4B510
    # mac diformatkan ulang: AABBCCDDEEFF → aa:bb:cc:dd:ee:ff untuk perintah OLT
    if any(k in (cli_type or '').lower() for k in ('epon', 'hsgq', 'e04', 'e08')):
        epon_parts = (slot_port or '1/1').split('/')
        epon_port  = epon_parts[0] if len(epon_parts) > 0 else '1'
        epon_onu   = epon_parts[1] if len(epon_parts) > 1 else '1'
        # Normalkan MAC: strip titik dua/dash dulu, lalu format ulang xx:xx:xx:xx:xx:xx
        mac_clean = sn.replace(':', '').replace('-', '').lower()
        mac_fmt   = ':'.join(mac_clean[i:i+2] for i in range(0, 12, 2)) \
                    if len(mac_clean) == 12 else sn.lower()
        return [
            'enable',
            'configure',
            f'interface epon {epon_port}',
            f'onu {epon_onu} mac-address {mac_fmt}',
            f'name {username}',
            f'vlan pvid {vlan_val}',
            'exit',
            'write',
        ]

    # ZTE (default)
    return [
        'con t',
        f'interface gpon-olt_{gpon_path}',
        f'no onu {onu_id}',
        f'onu {onu_id} type ALL-ONT sn {sn} vport-mode gemport',
        'exit',
        f'interface gpon-onu_{gpon_path}:{onu_id}',
        f'name {username}',
        'sn-bind enable sn',
        f'tcont 1 profile {tcont}',
        'gemport 1 tcont 1',
        'switchport mode hybrid vport 1',
        f'service-port 1 vport 1 user-vlan {vlan_val} vlan {vlan_val}',
        'exit',
        f'pon-onu-mng gpon-onu_{gpon_path}:{onu_id}',
        f'service HSI gemport 1 cos 0-7 vlan {vlan_val}',
        f'wan-ip 1 mode pppoe username {username} password {pwd} vlan-profile vlan{vlan_val} host 1',
        'wan-ip 1 ping-response enable traceroute-response enable',
        'security-mgmt 212 state enable mode forward protocol web',
        'end',
        'wr',
    ]


def _kirim_olt_cli(olt, commands):
    """
    Kirim daftar perintah CLI ke OLT via SSH (Scrapli).

    Return: (ok: bool, message: str, output: str|None)
    """
    if not SCRAPLI_OK:
        return False, 'Scrapli tidak terinstall — script di-generate tapi tidak dikirim otomatis', None

    try:
        from scrapli.driver.generic import GenericDriver
        device_cfg = {
            'host':                  olt['ip'],
            'auth_username':         olt['username'],
            'auth_password':         olt['password'],
            'auth_strict_key':       False,
            'transport':             'system',
            'port':                  int(olt.get('port') or 22),
            'timeout_socket':        15,
            'timeout_transport':     20,
        }
        outputs = []
        with GenericDriver(**device_cfg) as conn:
            for cmd in commands:
                r = conn.send_command(cmd)
                outputs.append(r.result)
        return True, 'Registrasi ONU berhasil dikirim ke OLT', '\n'.join(outputs)
    except Exception as e:
        logging.error(f'[_kirim_olt_cli] OLT {olt.get("ip")}: {e}')
        return False, f'Gagal kirim ke OLT: {e}', None


def _fetch_tcont_profiles(olt) -> list:
    """
    Ambil daftar nama TCONT/DBA profile yang ada di OLT via SSH.

    ZTE C300/C600 : `show gpon profile tcont`
    Huawei MA5600 : `display dba-profile all`

    Return: list[str] nama profile. Kosong kalau gagal/tidak ada.
    """
    if not SCRAPLI_OK:
        return []

    tipe = (olt.get('tipe') or '').lower()
    is_huawei = 'huawei' in tipe

    if is_huawei:
        commands = ['enable', 'display dba-profile all']
    else:
        commands = ['show gpon profile tcont']

    try:
        from scrapli.driver.generic import GenericDriver
        device_cfg = {
            'host':              olt['ip'],
            'auth_username':     olt['username'],
            'auth_password':     olt['password'],
            'auth_strict_key':   False,
            'transport':         'system',
            'port':              int(olt.get('port') or 22),
            'timeout_socket':    12,
            'timeout_transport': 15,
        }
        output = ''
        with GenericDriver(**device_cfg) as conn:
            for cmd in commands:
                output += conn.send_command(cmd).result + '\n'
    except Exception as e:
        logging.warning(f'[tcont-profiles] OLT {olt.get("ip")} gagal: {e}')
        return []

    names = set()
    if is_huawei:
        # Huawei: baris "  1   profile-name   ..." → ambil kolom nama
        for line in output.splitlines():
            m = re.match(r'\s*\d+\s+(\S+)', line)
            if m and m.group(1).lower() not in ('profile-id', 'dba'):
                names.add(m.group(1))
    else:
        # ZTE: "Profile Name: NAMA" atau baris "  NAMA   ..."
        for line in output.splitlines():
            m = re.search(r'(?:profile\s+name|name)\s*[:\s]\s*(\S+)', line, re.IGNORECASE)
            if m:
                names.add(m.group(1))
        # Fallback pola tabel ZTE: "<id> <nama> ..."
        if not names:
            for line in output.splitlines():
                m = re.match(r'\s*\d+\s+(\S+)', line)
                if m:
                    names.add(m.group(1))

    # Bersihkan token yang jelas bukan nama profile
    blacklist = {'name', 'profile', 'id', 'type', 'total', 'gpon', 'tcont', '---', '----'}
    return sorted(n for n in names if n.lower() not in blacklist and len(n) > 1)


@api_bp.route('/kolektor-list', methods=['GET'])
def get_kolektor_list():
    """Daftar user dengan role 'kolektor' milik owner ini, untuk dropdown form pelanggan."""
    from utils import get_master_db as _master
    conn = _master()
    network_id = getattr(g, 'network_id', None)
    rows = conn.execute(
        "SELECT username, nama FROM users WHERE role='kolektor' AND network_id=? AND aktif=1 ORDER BY nama",
        (network_id,)
    ).fetchall()
    conn.close()
    return jsonify([{'username': r['username'], 'nama': r['nama'] or r['username']} for r in rows]), 200


@api_bp.route('/olt/<int:olt_id>/tcont-profiles', methods=['GET'])
def get_tcont_profiles(olt_id):
    """
    Kembalikan daftar TCONT/DBA profile dari OLT untuk dropdown di form pelanggan.
    Response: { "profiles": ["100M", "50M", "default"], "source": "olt"|"fallback" }
    """
    olt = cari_olt(olt_id)
    if not olt:
        return jsonify({'error': 'OLT tidak ditemukan'}), 404

    profiles = _fetch_tcont_profiles(olt)
    if profiles:
        # Pastikan 'default' selalu ada sebagai opsi
        if 'default' not in [p.lower() for p in profiles]:
            profiles.append('default')
        return jsonify({'profiles': profiles, 'source': 'olt'}), 200

    # Fallback: kalau gagal baca dari OLT, kasih opsi umum
    return jsonify({
        'profiles': ['default'],
        'source':   'fallback',
        'note':     'Gagal baca profile dari OLT — pastikan OLT online & kredensial benar',
    }), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 1 — PELANGGAN (PPP Secrets + ONU Mapping)
# ══════════════════════════════════════════════════════════════

def _harga_dari_profil(conn, device_id, profil_nama):
    """Ambil harga bulanan dari tabel profil_harga berdasarkan device + nama profil."""
    if not profil_nama:
        return 0
    row = conn.execute(
        'SELECT harga FROM profil_harga WHERE device_id=? AND nama_profile=?',
        (device_id, profil_nama)
    ).fetchone()
    if row:
        return int(row['harga'] or 0)
    # fallback: cari by nama profil saja
    row = conn.execute(
        'SELECT harga FROM profil_harga WHERE nama_profile=? ORDER BY id LIMIT 1',
        (profil_nama,)
    ).fetchone()
    return int(row['harga'] or 0) if row else 0


def _get_pelanggan_dari_db(device_id, kolektor_filter=None):
    """
    Baca data pelanggan langsung dari DB lokal (tanpa konek MikroTik).
    Dipakai untuk role kolektor agar tidak bergantung koneksi MikroTik.
    """
    conn = get_db()
    q = 'SELECT * FROM pelanggan WHERE device_id = ? AND aktif = 1'
    params = [device_id]
    if kolektor_filter:
        q += ' AND kolektor = ?'
        params.append(kolektor_filter)
    q += ' ORDER BY nama, username'
    rows = conn.execute(q, params).fetchall()

    hasil = []
    for row in rows:
        username = row['username'] or ''
        onu = get_onu_data(username)
        hasil.append({
            'id':              row['id'],
            'mikrotik_id':     None,
            'device_id':       device_id,
            'username':        username,
            'password':        '',  # kolektor tidak perlu password
            'profil':          row['profil'] or '',
            'service':         row['service'] or 'pppoe',
            'comment':         row['nama'] or username,
            'disabled':        'false',
            'status':          'Online' if row['aktif'] else 'Offline',
            'ip_modem':        '',
            'mac_address':     '',
            'hp':              row['hp'] or row['no_hp'] or '',
            'slot_port':       onu['slot_port'],
            'vlan':            onu['vlan'],
            'sn':              onu['sn'],
            'tcont_profile':   onu.get('tcont_profile', ''),
            'olt_id':          onu['olt_id'],
            'titik_koordinat': row['titik_koordinat'] or '',
            'tgl_pasang':      row['tgl_pasang'] or '',
            'tgl_jatuh':       row['tgl_jatuh'] or '',
            'nama':            row['nama'] or username,
            'kolektor':        row['kolektor'] or '',
            'harga':           _harga_dari_profil(conn, device_id, row['profil'] or ''),
            'rx_power':        onu['rx_power'],
            'tx_power':        onu['tx_power'],
        })
    conn.close()
    return hasil


@api_bp.route('/pelanggan/<int:device_id>', methods=['GET'])
def get_pelanggan(device_id):
    """
    Gabungkan data PPP Secret dari MikroTik dengan data ONU dari onu_mapping,
    serta lakukan AUTO-SAVE (Upsert) ke database lokal.
    Jika password dari MikroTik disembunyikan (kosong), gunakan password dari DB lokal.
    Role kolektor: bypass MikroTik, baca langsung dari DB lokal.
    """
    current = getattr(g, 'current_user', None)
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            secrets      = mt.get_ppp_secrets()
            active_conns = mt.get_active_connections()
            active_names = {a.get('name') for a in active_conns}
            # Mapping username → raw dict active session (IP & MAC)
            active_detail = {
                a.get('name'): a
                for a in active_conns if a.get('name')
            }
            # Debug: log sample active session untuk verifikasi field tersedia
            if active_conns:
                sample = active_conns[0]
                logging.info(f"[active sample] keys={list(sample.keys())} "
                             f"address={sample.get('address')} "
                             f"caller-id={sample.get('caller-id')}")

        hasil = []
        conn  = get_db()

        # ── EPON FIX: cocokan MAC dari active sessions ke onu_mapping ──
        # EPON sync menyimpan username='mac:xx:xx', sedangkan MikroTik
        # active sessions punya caller-id=MAC. Kalau cocok → update username.
        try:
            updated_mac = 0
            for ac in active_conns:
                pppoe_user = (ac.get('name') or '').strip()
                caller_id  = (ac.get('caller-id') or '').strip().lower().replace('-', ':')
                if not pppoe_user or not caller_id:
                    continue
                mac_key = f'mac:{caller_id}'
                existing = conn.execute(
                    "SELECT username FROM onu_mapping WHERE username=? LIMIT 1",
                    (mac_key,)
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE onu_mapping SET username=? WHERE username=?",
                        (pppoe_user, mac_key)
                    )
                    updated_mac += 1
            if updated_mac:
                conn.commit()
                logging.info(f"[EPON Fix] {updated_mac} entri onu_mapping diperbarui dari MAC ke PPPoE username")
        except Exception as e_mac:
            logging.warning(f"[EPON Fix] MAC matching error: {e_mac}")

        for s in secrets:
            username = str(s.get('name', '') or '').strip()
            if not username:
                continue

            onu = get_onu_data(username)

            profile_mt  = s.get('profile', 'default')
            comment_mt  = s.get('comment', '')
            password_mt = str(s.get('password', '') or '').strip() # Password dari API MikroTik
            service_mt  = s.get('service', 'pppoe')
            disabled_mt = 1 if s.get('disabled') == 'true' else 0

            # 1. CEK DATA LAMA DI DATABASE LOKAL TERLEBIH DAHULU
            row_lama = conn.execute(
                'SELECT password, nama, hp, no_hp FROM pelanggan WHERE username = ?',
                (username,)
            ).fetchone()

            password_saved = ''
            if row_lama:
                password_saved = row_lama['password'] if row_lama['password'] else ''

            # Tentukan password final yang akan disimpan ke DB: 
            # Jika dari MikroTik dapet password (tidak kosong), pakai dari MikroTik.
            # Jika dari MikroTik kosong, amankan dengan memakai password yang sudah ada di DB lokal sebelumnya.
            password_ke_db = password_mt if password_mt else password_saved

            # 2. AUTO-SAVE / UPSERT KE TABEL PELANGGAN LOKAL
            try:
                conn.execute('''
                    INSERT INTO pelanggan (
                        username, nama, password, profil, service, aktif,
                        olt_id, slot_port, vlan, sn
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        profil    = excluded.profil,
                        service   = excluded.service,
                        aktif     = excluded.aktif,
                        password  = excluded.password,
                        nama      = CASE WHEN nama IS NULL OR nama = '' THEN excluded.nama ELSE nama END,
                        olt_id    = CASE WHEN olt_id IS NULL OR olt_id = 0 THEN excluded.olt_id ELSE olt_id END,
                        slot_port = CASE WHEN slot_port IS NULL OR slot_port = '' THEN excluded.slot_port ELSE slot_port END,
                        vlan      = CASE WHEN vlan IS NULL OR vlan = 0 THEN excluded.vlan ELSE vlan END,
                        sn        = CASE WHEN sn IS NULL OR sn = '' THEN excluded.sn ELSE sn END
                ''', (
                    username,
                    comment_mt if comment_mt else username,
                    password_ke_db,
                    profile_mt,
                    service_mt,
                    1 if disabled_mt == 0 else 0,
                    onu.get('olt_id'),
                    onu.get('slot_port'),
                    onu.get('vlan'),
                    onu.get('sn')
                ))
                conn.commit()
            except Exception:
                pass

            # 3. TARIK KEMBALI DATA RESMI SETELAH SINKRONISASI
            row_lokal = conn.execute(
                'SELECT id, username, nama, password, profil, no_hp, hp, service, aktif, tgl_pasang, tgl_jatuh, titik_koordinat, kolektor, odp_id, port_odp FROM pelanggan WHERE username = ?',
                (username,)
            ).fetchone()

            if row_lokal:
                id_pelanggan   = row_lokal['id']
                hp_pelanggan   = row_lokal['hp'] if row_lokal['hp'] else (row_lokal['no_hp'] if row_lokal['no_hp'] else '')
                nama_pelanggan = row_lokal['nama'] or comment_mt or username
                password_fix   = row_lokal['password'] # Menggunakan password fix database
            else:
                id_pelanggan   = s.get('id') or s.get('.id')
                hp_pelanggan   = ''
                nama_pelanggan = comment_mt or username
                password_fix   = password_mt

            # Ambil detail koneksi aktif untuk username ini
            # caller-id = MAC address modem, address = IP yang di-assign
            _sesi = active_detail.get(username, {})

            hasil.append({
                'id':          id_pelanggan,  # ID database lokal (dipakai openDetail/openEdit)
                'mikrotik_id': s.get('.id'),  # ID asli MikroTik — disimpan terpisah
                'device_id':   device_id,
                'username':    username,
                'password':    password_fix,   # ← FIX: kirim password real dari DB/MikroTik
                'profil':      s.get('profile', 'default'),
                'service':     s.get('service', 'pppoe'),
                'comment':     s.get('comment', ''),
                'disabled':    s.get('disabled', 'false'),
                'status':      'Online' if username in active_names else 'Offline',

                # IP Address & MAC Address modem dari active session MikroTik
                # Hanya terisi saat pelanggan sedang Online
                'ip_modem':    _sesi.get('address',   ''),
                'mac_address': _sesi.get('caller-id', ''),

                # Data lokal database
                'hp':          row_lokal['hp'] if row_lokal else '',

                # Data ONU OLT hasil sync
                'slot_port':   onu['slot_port'],
                'vlan':        onu['vlan'],
                'sn':          onu['sn'],
                'tcont_profile': onu.get('tcont_profile', ''),
                'olt_id':      onu['olt_id'],
                'titik_koordinat': row_lokal['titik_koordinat'] if row_lokal else '',
                'tgl_pasang':  row_lokal['tgl_pasang'] if row_lokal else '',
                'tgl_jatuh':   row_lokal['tgl_jatuh'] if row_lokal else '',
                'nama':        row_lokal['nama'] if row_lokal else '',
                'kolektor':    row_lokal['kolektor'] if row_lokal else '',
                'odp_id':      row_lokal['odp_id'] if row_lokal else None,
                'port_odp':    row_lokal['port_odp'] if row_lokal else None,
                'harga':       _harga_dari_profil(conn, device_id, s.get('profile', '')),
                'rx_power':    onu['rx_power'],
                'tx_power':    onu['tx_power'],
            })

            # ── AUTO-SAVE (UPSERT) ──────────────────────────────────────
            # Pastikan setiap pelanggan dari MikroTik selalu tercatat di DB
            # lokal dengan device_id valid. Tanpa ini, tombol Isolir/Enable
            # akan gagal dengan "Perangkat MikroTik tidak ditemukan".
            try:
                if row_lokal:
                    # Update device_id jika sebelumnya null/berbeda
                    conn.execute(
                        '''UPDATE pelanggan
                           SET device_id = ?, password = ?, profil = ?, service = ?
                           WHERE id = ?''',
                        (device_id, password_ke_db, profile_mt, service_mt, row_lokal['id'])
                    )
                else:
                    # Pelanggan baru dari MikroTik — insert ke DB lokal
                    conn.execute(
                        '''INSERT INTO pelanggan
                           (device_id, username, password, profil, service, nama, aktif)
                           VALUES (?, ?, ?, ?, ?, ?, 1)''',
                        (device_id, username, password_ke_db, profile_mt, service_mt, nama_pelanggan)
                    )
                conn.commit()
            except Exception as upsert_err:
                logging.warning(f'[get_pelanggan] Auto-save gagal untuk {username}: {upsert_err}')

        conn.close()

        # Filter kolektor — hanya tampilkan pelanggan yang ditugaskan ke dia
        if current and current.get('role') == 'kolektor':
            kol_usr = current.get('username', '')
            hasil = [p for p in hasil if (p.get('kolektor') or '') == kol_usr]

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': f'Terjadi kesalahan internal: {str(e)}'}), 500



@api_bp.route('/pelanggan', methods=['POST'])
def tambah_pelanggan():
    """
    Tambah pelanggan baru:
      1. Buat PPP Secret di MikroTik
      2. Simpan ke tabel pelanggan lokal
      3. Provisioning ONU ke OLT (opsional, jika olt_id & sn & slot_port ada)
    """
    body      = request.get_json() or {}
    device_id = body.get('device_id')
    username  = str(body.get('username', '') or '').strip()
    password  = str(body.get('password', '') or '').strip()
    profil    = str(body.get('profil', 'default') or 'default').strip()
    hp        = str(body.get('hp', '') or body.get('no_hp', '') or '').strip()
    nama      = str(body.get('nama', '') or username).strip()
    olt_id    = body.get('olt_id')
    slot_port = str(body.get('slot_port', '') or '').strip()
    vlan      = str(body.get('vlan', '') or '').strip()
    sn        = str(body.get('sn', '') or '').strip()
    tcont_profile = str(body.get('tcont_profile', '') or '').strip()
    koordinat = str(body.get('titik_koordinat', '') or body.get('koordinat', '') or '').strip()
    tgl_pasang = str(body.get('tgl_pasang', '') or '').strip()
    tgl_jatuh  = str(body.get('tgl_jatuh', '') or '').strip()
    kolektor   = str(body.get('kolektor', '') or '').strip()
    odp_id     = body.get('odp_id') or None
    if odp_id is not None:
        try: odp_id = int(odp_id)
        except (TypeError, ValueError): odp_id = None
    port_odp   = body.get('port_odp') or None
    if port_odp is not None:
        try: port_odp = int(port_odp)
        except (TypeError, ValueError): port_odp = None

    if not username:
        return jsonify({'error': 'Username wajib diisi'}), 400
    if not password:
        return jsonify({'error': 'Password wajib diisi'}), 400
    if not device_id:
        return jsonify({'error': 'Perangkat MikroTik wajib dipilih'}), 400

    # ── Cek batas paket owner DULUAN (fail-fast) ──────────
    try:
        from utils import get_pelanggan_limit
        limit = get_pelanggan_limit(g.network_id)
        if limit is not None:
            conn_chk = get_db()
            jml = conn_chk.execute('SELECT COUNT(*) FROM pelanggan').fetchone()[0]
            conn_chk.close()
            if jml >= limit:
                return jsonify({
                    'error': 'Batas paket tercapai ({}/{} pelanggan). '
                             'Upgrade paket untuk menambah pelanggan lagi.'.format(jml, limit)
                }), 403
    except Exception as e:
        logging.warning('[Paket] cek batas gagal: %s', e)

    device = cari_device(int(device_id))
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    steps    = {}
    warnings = []

    # ── 1. Tambah PPP Secret ke MikroTik ──────────────────
    try:
        with MikroTikClient(device) as mt:
            mt.tambah_secret({
                'name':     username,
                'password': password,
                'profile':  profil,
                'service':  'pppoe',
            })
        steps['mikrotik'] = 'success'
    except MikroTikError as e:
        return jsonify({'error': f'Gagal tambah ke MikroTik: {e}'}), 502

    # ── 2. Simpan ke DB lokal ──────────────────────────────
    try:
        conn = get_db()
        existing = conn.execute(
            'SELECT id FROM pelanggan WHERE username = ?', (username,)
        ).fetchone()

        if existing:
            conn.execute('''
                UPDATE pelanggan
                SET device_id=?, password=?, profil=?, hp=?, no_hp=?, nama=?,
                    slot_port_onu=?, vlan=?, sn=?, titik_koordinat=?,
                    tgl_pasang=?, tgl_jatuh=?, kolektor=?, odp_id=?, port_odp=?, aktif=1
                WHERE username=?
            ''', (device_id, password, profil, hp, hp, nama,
                   slot_port, vlan, sn, koordinat,
                   tgl_pasang, tgl_jatuh, kolektor, odp_id, port_odp, username))
        else:
            conn.execute('''
                INSERT INTO pelanggan
                  (device_id, username, password, profil, hp, no_hp, nama,
                   slot_port_onu, vlan, sn, titik_koordinat,
                   tgl_pasang, tgl_jatuh, kolektor, odp_id, port_odp, aktif, service)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pppoe')
            ''', (device_id, username, password, profil, hp, hp, nama,
                   slot_port, vlan, sn, koordinat,
                   tgl_pasang, tgl_jatuh, kolektor, odp_id, port_odp))
        conn.commit()
        conn.close()
        steps['database'] = 'success'
        # Auto-link device ke GenieACS (background, senyap)
        if sn:
            try:
                from genieacs import link_device_by_serial
                link_device_by_serial(sn, g.network_id)
            except Exception:
                pass
        # Auto-update port_terpakai ODP jika pelanggan pilih port
        if odp_id:
            try:
                from odp import _update_odp_port_terpakai
                c2 = get_db()
                cnt = c2.execute('SELECT COUNT(*) FROM pelanggan WHERE odp_id=? AND aktif=1', (odp_id,)).fetchone()[0]
                c2.close()
                _update_odp_port_terpakai(odp_id, cnt)
            except Exception:
                pass
    except Exception as e:
        warnings.append(f'DB lokal: {e}')
        steps['database'] = 'warning'

    # ── 3. Update onu_mapping jika ada data ONU ────────────
    if olt_id and (sn or slot_port):
        try:
            conn = get_db()
            conn.execute('''
                INSERT INTO onu_mapping (username, olt_id, slot_port, vlan, sn, tcont_profile)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    olt_id=excluded.olt_id, slot_port=excluded.slot_port,
                    vlan=excluded.vlan, sn=excluded.sn,
                    tcont_profile=excluded.tcont_profile
            ''', (username, olt_id, slot_port, vlan, sn, tcont_profile))
            conn.commit()
            conn.close()
            steps['onu_mapping'] = 'success'
        except Exception as e:
            warnings.append(f'ONU mapping: {e}')

    # ── 4. Provisioning ONU ke OLT (otomatis) ──────────────
    # Hanya jalan jika data OLT lengkap (olt_id + sn + slot_port).
    # Pakai helper _build_olt_cli yang sama dengan endpoint /provision,
    # dengan password PPPoE ASLI pelanggan.
    if olt_id and sn and slot_port:
        olt = cari_olt(int(olt_id))
        if olt:
            tipe_olt = (olt.get('tipe') or '').lower()
            if 'huawei' in tipe_olt:
                cli_type = 'huawei'
            elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
                cli_type = 'epon'
            else:
                cli_type = 'zte'
            commands = _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password, tcont_profile)
            ok, msg, _out = _kirim_olt_cli(olt, commands)
            steps['olt'] = 'success' if ok else 'warning'
            if not ok:
                warnings.append(f'OLT: {msg}')
        else:
            steps['olt'] = 'warning'
            warnings.append('OLT tidak ditemukan — registrasi ONU dilewati')
    else:
        steps['olt'] = 'skipped'
        if olt_id and (not sn or not slot_port):
            missing = []
            if not sn:        missing.append('SN')
            if not slot_port: missing.append('Slot/Port')
            warnings.append(f'Registrasi OLT dilewati — {", ".join(missing)} belum diisi')

    status_code = 207 if warnings else 201
    return jsonify({
        'status':   'success',
        'message':  f'{username} berhasil ditambahkan',
        'steps':    steps,
        'warnings': warnings,
    }), status_code


@api_bp.route('/pelanggan/<string:id_pelanggan>', methods=['PUT'])
def update_pelanggan(id_pelanggan):
    """
    Edit pelanggan:
      1. Update data lokal di DB (hp, nama, slot_port, sn, tgl, koordinat, profil)
      2. Update PPP Secret di MikroTik (password, profil, comment) jika device_id tersedia
      3. Update onu_mapping jika ada perubahan OLT data
    """
    try:
        body     = request.get_json() or {}
        username = body.get('username', '').strip()
        hp       = body.get('hp', '') or body.get('no_hp', '') or ''
        nama     = body.get('nama', '') or body.get('name', '') or ''
        password = body.get('password', '').strip()   # ← BARU: password bisa diupdate
        profil   = str(body.get('profil', '') or '').strip()
        device_id = body.get('device_id')
 
        if not username:
            return jsonify({'error': 'Username tidak boleh kosong'}), 400
 
        conn = get_db()
 
        koordinat  = str(body.get('titik_koordinat', '') or body.get('koordinat', '') or '').strip()
        tgl_pasang = str(body.get('tgl_pasang', '') or '').strip()
        tgl_jatuh  = str(body.get('tgl_jatuh',  '') or '').strip()
        slot_port  = str(body.get('slot_port',   '') or '').strip()
        vlan       = str(body.get('vlan',        '') or '').strip()
        sn         = str(body.get('sn',          '') or '').strip()
        olt_id     = body.get('olt_id')
        kolektor   = str(body.get('kolektor', '') or '').strip()
        odp_id_upd = body.get('odp_id') or None
        if odp_id_upd is not None:
            try: odp_id_upd = int(odp_id_upd)
            except (TypeError, ValueError): odp_id_upd = None
        port_odp_upd = body.get('port_odp') or None
        if port_odp_upd is not None:
            try: port_odp_upd = int(port_odp_upd)
            except (TypeError, ValueError): port_odp_upd = None

        # 1. Update DB lokal
        user_lokal = conn.execute('SELECT id, password FROM pelanggan WHERE username = ?', (username,)).fetchone()

        # Password: pakai yang baru jika dikirim, fallback ke yang sudah ada di DB
        password_db = password if password else (user_lokal['password'] if user_lokal else '')

        if user_lokal:
            conn.execute('''
                UPDATE pelanggan
                SET hp=?, no_hp=?, nama=?, password=?,
                    slot_port_onu=?, vlan=?, sn=?,
                    titik_koordinat=?, tgl_pasang=?, tgl_jatuh=?,
                    kolektor=?, odp_id=?, port_odp=?,
                    profil=CASE WHEN ? != '' THEN ? ELSE profil END
                WHERE username=?
            ''', (
                hp, hp, nama, password_db,
                slot_port, vlan, sn,
                koordinat, tgl_pasang, tgl_jatuh,
                kolektor, odp_id_upd, port_odp_upd,
                profil, profil,
                username
            ))
        else:
            conn.execute('''
                INSERT INTO pelanggan
                  (username, nama, hp, no_hp, password, slot_port_onu, vlan, sn,
                   titik_koordinat, tgl_pasang, tgl_jatuh)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                username, nama, hp, hp, password_db,
                slot_port, vlan, sn,
                koordinat, tgl_pasang, tgl_jatuh
            ))
 
        conn.commit()
        conn.close()
 
        # 2. Update ke MikroTik (jika device_id tersedia)
        mikrotik_updated = False
        mikrotik_warning = None
        if device_id:
            device = cari_device(int(device_id))
            if device:
                update_mt = {}
                if password:
                    update_mt['password'] = password
                if profil:
                    update_mt['profile'] = profil
                if nama:
                    update_mt['comment'] = nama
 
                if update_mt:
                    try:
                        with MikroTikClient(device) as mt:
                            mt.edit_secret(username, update_mt)
                        mikrotik_updated = True
                    except MikroTikError as e:
                        mikrotik_warning = str(e)
                    except Exception as e:
                        mikrotik_warning = str(e)
 
        # 3. Update onu_mapping jika ada data OLT
        if olt_id and (sn or slot_port):
            try:
                conn2 = get_db()
                conn2.execute('''
                    INSERT INTO onu_mapping (username, olt_id, slot_port, vlan, sn)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        olt_id=excluded.olt_id, slot_port=excluded.slot_port,
                        vlan=excluded.vlan, sn=excluded.sn
                ''', (username, olt_id, slot_port, vlan, sn))
                conn2.commit()
                conn2.close()
            except Exception:
                pass
 
        resp = {
            'status':           'success',
            'message':          f'Data {username} berhasil diperbarui',
            'mikrotik_updated': mikrotik_updated,
        }
        if mikrotik_warning:
            resp['warning'] = mikrotik_warning
            return jsonify(resp), 207
 
        return jsonify(resp), 200
 
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': f'Gagal menyimpan data: {str(e)}'}), 500
    
@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['DELETE'])
def delete_pelanggan(pelanggan_id):
    """Hapus PPP Secret dari MikroTik + hapus dari DB lokal."""
    body      = request.get_json(silent=True) or {}
    device_id = body.get('device_id')
    username  = (body.get('username') or '').strip()

    if not device_id or not username:
        return jsonify({'error': 'device_id dan username wajib'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            mt.hapus_secret(username)

        conn = get_db()
        conn.execute('DELETE FROM pelanggan WHERE id = ?', (pelanggan_id,))
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil dihapus'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:device_id>/rx-tx', methods=['GET'])
def get_rx_tx(device_id):
    """
    Ambil data RX/TX power (dBm) untuk semua pelanggan di device_id.

    Query params:
      ?realtime=1  → langsung tembak OLT via Scrapli (lebih lambat)
      (default)    → baca dari cache DB (tabel onu_mapping)
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    realtime = request.args.get('realtime', '0') == '1'

    try:
        with MikroTikClient(device) as mt:
            secrets = mt.get_ppp_secrets()

        hasil = []
        for s in secrets:
            username = str(s.get('name', '') or '')
            if not username:
                continue

            onu      = get_onu_data(username)
            rx_power = onu['rx_power']
            tx_power = onu['tx_power']
            source   = 'db'

            if realtime and SCRAPLI_OK and onu['olt_id']:
                olt = cari_olt(onu['olt_id'])
                if olt and onu['slot_port']:
                    try:
                        rt = _get_rx_tx_realtime(olt, onu['slot_port'])
                        if rt['rx_power'] is not None:
                            rx_power = rt['rx_power']
                            tx_power = rt['tx_power']
                            source   = 'realtime'
                            _update_rx_tx_cache(username, rx_power, tx_power)
                    except Exception:
                        pass

            hasil.append({
                'username':  username,
                'rx_power':  rx_power,
                'tx_power':  tx_power,
                'slot_port': onu['slot_port'],
                'vlan':      onu['vlan'],
                'sn':        onu['sn'],
                'olt_id':    onu['olt_id'],
                'source':    source,
            })

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


def _get_rx_tx_realtime(olt: dict, slot_port: str) -> dict:
    """Ambil nilai RX/TX power langsung dari OLT via SSH/Telnet."""
    from utils import parse_huawei_rx, parse_zte_rx, parse_generic_rx

    result = {'rx_power': None, 'tx_power': None}
    if not SCRAPLI_OK:
        return result

    tipe = (olt.get('tipe') or '').lower()

    if 'zte' in tipe:
        cmd = f'show pon onu optical-info gpon-onu_{slot_port}'
    elif 'huawei' in tipe:
        parts = slot_port.split(':')
        port  = parts[0] if parts else slot_port
        ont   = parts[1] if len(parts) > 1 else '0'
        cmd   = f'display ont optical-info {port} {ont}'
    else:
        cmd = f'show onu optical-info {slot_port}'

    device_cfg = {
        'host':                 olt['ip'],
        'port':                 int(olt.get('port', 23)),
        'auth_username':        olt['username'],
        'auth_password':        olt['password'],
        'auth_strict_key':      False,
        'transport':            'telnet',
        'timeout_ops':          15,
        'comms_prompt_pattern': r'.*[>#\$]',
    }

    with GenericDriver(**device_cfg) as conn:
        output = conn.send_command(cmd).result

    if 'zte' in tipe:
        return parse_zte_rx(output)
    elif 'huawei' in tipe:
        return parse_huawei_rx(output)
    else:
        return parse_generic_rx(output)


def _update_rx_tx_cache(username: str, rx_power, tx_power):
    """Update kolom rx_power & tx_power di tabel onu_mapping."""
    conn = get_db()
    conn.execute(
        'UPDATE onu_mapping SET rx_power = ?, tx_power = ? WHERE username = ?',
        (rx_power, tx_power, username)
    )
    conn.commit()
    conn.close()


@api_bp.route('/onu-mapping', methods=['POST'])
def save_onu_mapping():
    """
    Simpan/update data ONU untuk satu username.

    Body JSON:
    {
        "username"  : "pelanggan01",
        "olt_id"    : 1,
        "slot_port" : "0/1/1:1",
        "vlan"      : "100",
        "sn"        : "HWTC1A2B3C4D",
        "rx_power"  : -24.5,
        "tx_power"  : 2.1
    }
    """
    body      = request.get_json(silent=True) or {}
    username  = body.get('username', '').strip()
    olt_id    = body.get('olt_id')
    slot_port = body.get('slot_port', '').strip()
    vlan      = body.get('vlan', '').strip()
    sn        = body.get('sn', '').strip()
    rx_power  = body.get('rx_power')
    tx_power  = body.get('tx_power')

    if not username:
        return jsonify({'error': 'username wajib'}), 400

    conn = get_db()
    conn.execute(
        '''INSERT INTO onu_mapping
           (username, olt_id, slot_port, vlan, sn, rx_power, tx_power)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(username) DO UPDATE SET
             olt_id    = excluded.olt_id,
             slot_port = excluded.slot_port,
             vlan      = excluded.vlan,
             sn        = excluded.sn,
             rx_power  = COALESCE(excluded.rx_power, onu_mapping.rx_power),
             tx_power  = COALESCE(excluded.tx_power, onu_mapping.tx_power)
        ''',
        (username, olt_id, slot_port, vlan, sn, rx_power, tx_power)
    )
    conn.commit()
    conn.close()

    return jsonify({'message': f'Data ONU untuk {username} berhasil disimpan'}), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 2 — ACTION PELANGGAN
# [DIPINDAHKAN DARI DUPLIKAT KEDUA — sebelumnya hanya ada di sana]
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/<int:device_id>/action', methods=['POST'])
def action_pelanggan(device_id):
    """
    Aksi langsung ke PPP Secret MikroTik:
    enable, disable, reboot (putus sesi aktif).

    Body JSON:
    { "username": "pelanggan01", "action": "enable|disable|reboot" }
    """
    body     = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip()
    action   = (body.get('action')   or '').strip().lower()

    if not username:
        return jsonify({'error': 'username wajib'}), 400
    if action not in ('enable', 'disable', 'reboot'):
        return jsonify({'error': 'action harus: enable | disable | reboot'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        from librouteros.query import Key

        with MikroTikClient(device) as mt:
            api = mt._get_api()

            if action in ('enable', 'disable'):
                path   = api.path('/ppp/secret')
                target = next(
                    (r for r in path.select(Key('.id'), Key('name'))
                     if r.get('name') == username),
                    None
                )
                if not target:
                    return jsonify({'error': f'Pelanggan {username} tidak ditemukan di MikroTik'}), 404

                path.update(**{
                    '.id':      target['.id'],
                    'disabled': 'yes' if action == 'disable' else 'no',
                })
                label = 'dinonaktifkan' if action == 'disable' else 'diaktifkan kembali'

            else:  # reboot — putus sesi aktif
                active_path = api.path('/ppp/active')
                active = next(
                    (r for r in active_path.select(Key('.id'), Key('name'))
                     if r.get('name') == username),
                    None
                )
                if active:
                    active_path.remove(active['.id'])
                    label = 'sesi aktif diputus (akan reconnect otomatis)'
                else:
                    label = 'tidak ada sesi aktif untuk diputus'

        return jsonify({'message': f'{username}: {label}'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


    return jsonify({"nodes": nodes, "links": links}), 200

def _resolve_device_with_hint(pelanggan, device_id_hint=None):
    """
    Resolusi device dengan 3 strategi (untuk action endpoints):
      1. device_id_hint dari body request (paling cepat, frontend sudah tahu)
      2. device_id tercatat di pelanggan row
      3. scan semua devices cari yang punya PPPoE secret username ini

    Return: device_dict atau None
    """
    # Strategi 1: hint dari body
    if device_id_hint:
        dev = cari_device(int(device_id_hint))
        if dev:
            # Update DB agar konsisten
            try:
                conn = get_db()
                conn.execute('UPDATE pelanggan SET device_id = ? WHERE id = ?',
                             (dev['id'], pelanggan['id']))
                conn.commit()
                conn.close()
            except Exception:
                pass
            return dev

    # Strategi 2: device_id dari pelanggan row
    if pelanggan.get('device_id'):
        dev = cari_device(pelanggan['device_id'])
        if dev:
            return dev

    # Strategi 3: scan semua devices
    conn = get_db()
    all_devices = conn.execute(
        'SELECT id, name, ip, port, username, password, koordinat, public_ip FROM devices'
    ).fetchall()
    conn.close()
    for dev_row in all_devices:
        dev = dict(dev_row)
        try:
            with MikroTikClient(dev) as mt:
                secrets = mt.get_ppp_secrets()
                if any(s.get('name') == pelanggan['username'] for s in secrets):
                    conn = get_db()
                    conn.execute('UPDATE pelanggan SET device_id = ? WHERE id = ?',
                                 (dev['id'], pelanggan['id']))
                    conn.commit()
                    conn.close()
                    return dev
        except Exception:
            continue
    return None


def _get_pelanggan_device(pelanggan_id: int):
    """
    Helper: cari pelanggan + device dari DB lokal berdasarkan pelanggan_id.

    Strategi fallback (3 lapis):
      1. Cari pelanggan by ID, gunakan device_id-nya
      2. Jika device_id null/invalid, scan semua devices untuk cari yang punya
         PPPoE secret dengan username ini (active discovery)
      3. Return None, None jika semua gagal

    Return: (pelanggan_row, device_dict) atau (None, None)
    """
    conn = get_db()
    row  = conn.execute(
        'SELECT id, username, profil, device_id FROM pelanggan WHERE id = ?',
        (pelanggan_id,)
    ).fetchone()
    conn.close()
    if not row:
        return None, None

    pelanggan = dict(row)

    # Lapis 1: coba device_id yang tercatat
    device = cari_device(pelanggan['device_id']) if pelanggan.get('device_id') else None
    if device:
        return pelanggan, device

    # Lapis 2: fallback — scan semua devices, cari yang punya secret ini
    logging.info(f'[_get_pelanggan_device] device_id null untuk {pelanggan["username"]}, scanning all devices...')
    conn = get_db()
    all_devices = conn.execute(
        'SELECT id, name, ip, port, username, password, koordinat, public_ip FROM devices'
    ).fetchall()
    conn.close()

    for dev_row in all_devices:
        dev = dict(dev_row)
        try:
            with MikroTikClient(dev) as mt:
                secrets = mt.get_ppp_secrets()
                if any(s.get('name') == pelanggan['username'] for s in secrets):
                    # Ketemu! Update DB lokal supaya next time langsung pakai
                    conn = get_db()
                    conn.execute(
                        'UPDATE pelanggan SET device_id = ? WHERE id = ?',
                        (dev['id'], pelanggan['id'])
                    )
                    conn.commit()
                    conn.close()
                    logging.info(f'[_get_pelanggan_device] Found {pelanggan["username"]} on device {dev["name"]} (id={dev["id"]})')
                    return pelanggan, dev
        except Exception as e:
            logging.debug(f'[_get_pelanggan_device] Skip device {dev["name"]}: {e}')
            continue

    # Lapis 3: tidak ketemu di device manapun
    return pelanggan, None


@api_bp.route('/pelanggan/<int:pelanggan_id>/enable', methods=['POST'])
def enable_pelanggan(pelanggan_id):
    """Aktifkan (enable) PPP Secret pelanggan di MikroTik."""
    body     = request.get_json(silent=True) or {}
    # Bisa juga pakai username dari body jika dikirim dari frontend
    username_override = (body.get('username') or '').strip()

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    username = username_override or pelanggan['username']

    try:
        with MikroTikClient(device) as mt:
            mt.edit_secret(username, {'disabled': 'no'})
        return jsonify({'message': f'{username} berhasil di-enable'}), 200
    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/disable', methods=['POST'])
def disable_pelanggan(pelanggan_id):
    """Nonaktifkan (disable) PPP Secret pelanggan di MikroTik."""
    body              = request.get_json(silent=True) or {}
    username_override = (body.get('username') or '').strip()

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    username = username_override or pelanggan['username']

    try:
        with MikroTikClient(device) as mt:
            mt.edit_secret(username, {'disabled': 'yes'})
        return jsonify({'message': f'{username} berhasil di-disable'}), 200
    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


def _resolve_isolir_profile(mt, body=None):
    """
    Tentukan nama profil isolir yang VALID di MikroTik.

    Strategi:
      1. Kalau body kirim 'profil_isolir', pakai itu (kalau ada di MikroTik)
      2. Cari profil existing yang namanya mengandung 'isolir'/'blokir'/'suspend'
         (case-insensitive) — pakai nama persisnya
      3. Kalau tidak ada, BUAT profil 'Isolir' baru dengan rate-limit minimal
         (1k/1k) agar pelanggan praktis tidak bisa browsing

    Return: nama profil isolir yang valid (string)
    Raise: MikroTikError kalau gagal total
    """
    body = body or {}
    profiles = mt.get_ppp_profiles()
    names    = [p.get('name', '') for p in profiles]

    # Strategi 1: hint dari body
    hint = (body.get('profil_isolir') or '').strip()
    if hint and hint in names:
        return hint

    # Strategi 2: cari yang mirip 'isolir' (case-insensitive)
    keywords = ('isolir', 'blokir', 'suspend', 'block', 'isolasi')
    for name in names:
        low = name.lower()
        if any(kw in low for kw in keywords):
            logging.info(f'[isolir] Pakai profil existing: {name}')
            return name

    # Strategi 3: buat profil Isolir baru
    logging.info('[isolir] Profil isolir tidak ada — membuat profil "Isolir" baru')
    try:
        mt.tambah_profile({
            'name':        'Isolir',
            'rate-limit':  '1k/1k',          # praktis tidak bisa browsing
            'comment':     'Auto-created by TechnoFix untuk isolir pelanggan',
        })
        return 'Isolir'
    except MikroTikError as e:
        # Kalau gagal buat (mungkin sudah ada tapi case beda), coba sekali lagi cari
        try:
            profiles2 = mt.get_ppp_profiles()
            for p in profiles2:
                if 'isolir' in p.get('name', '').lower():
                    return p['name']
        except Exception:
            pass
        raise MikroTikError(f'Tidak bisa menyiapkan profil Isolir: {e}')


@api_bp.route('/pelanggan/<int:pelanggan_id>/isolir', methods=['POST'])
def isolir_pelanggan(pelanggan_id):
    """
    Isolir pelanggan:
      1. Ubah profil PPP Secret ke "Isolir" di MikroTik
      2. Kick sesi aktif agar reconnect dengan profil baru (kecepatan 0)
      3. Simpan profil_sebelum ke DB lokal (untuk restore saat bayar)
    """
    body              = request.get_json(silent=True) or {}
    username_override = (body.get('username') or '').strip()

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    username       = username_override or pelanggan['username']
    profil_lama    = pelanggan['profil'] or 'default'

    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()

            # 0. Tentukan profil isolir yang valid (cari existing / buat baru)
            profil_isolir = _resolve_isolir_profile(mt, body)

            # Jangan timpa profil_sebelum kalau pelanggan sudah isolir
            if profil_lama.lower() == profil_isolir.lower():
                return jsonify({
                    'message':     f'{username} sudah dalam status isolir',
                    'profil_baru': profil_isolir,
                }), 200

            # 1. Update profil ke "Isolir"
            mt.edit_secret(username, {'profile': profil_isolir})

            # 2. Kick sesi aktif (agar modem reconnect dengan profil baru)
            from librouteros.query import Key
            active_path = api.path('/ppp/active')
            active = next(
                (r for r in active_path.select(Key('.id'), Key('name'))
                 if r.get('name') == username),
                None
            )
            if active:
                active_path.remove(active['.id'])

        # 3. Simpan profil_sebelum di DB lokal (untuk keperluan bayar/restore)
        conn = get_db()
        conn.execute(
            'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = ? WHERE id = ?',
            (profil_isolir, profil_lama, pelanggan_id)
        )
        conn.commit()
        conn.close()

        return jsonify({
            'message':       f'{username} berhasil diisolir. Profil: {profil_lama} → {profil_isolir}',
            'profil_lama':   profil_lama,
            'profil_baru':   profil_isolir,
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/bayar', methods=['POST'])
def bayar_pelanggan(pelanggan_id):
    """
    Tandai pelanggan lunas & restore profil ke profil sebelum isolir.
      1. Ambil profil_sebelum_isolir dari DB
      2. Update profil PPP Secret di MikroTik kembali ke profil asal
      3. Kick sesi aktif agar reconnect dengan profil baru (kecepatan normal)
      4. Update profil di DB lokal
    """
    body              = request.get_json(silent=True) or {}
    username_override = (body.get('username') or '').strip()

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    username = username_override or pelanggan['username']

    # Ambil profil_sebelum_isolir dari DB
    conn = get_db()
    row  = conn.execute(
        'SELECT profil, profil_sebelum_isolir FROM pelanggan WHERE id = ?',
        (pelanggan_id,)
    ).fetchone()
    conn.close()

    profil_restore = None
    if row:
        profil_restore = row['profil_sebelum_isolir'] or row['profil']

    # Jika profil saat ini bukan "Isolir" dan tidak ada profil_sebelum, 
    # berarti sudah aktif → anggap sukses
    if not profil_restore or 'isolir' in profil_restore.lower():
        profil_restore = body.get('profil') or 'default'

    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()

            # 1. Update profil kembali ke semula
            mt.edit_secret(username, {'profile': profil_restore, 'disabled': 'no'})

            # 2. Kick sesi aktif agar reconnect dengan profil baru
            from librouteros.query import Key
            active_path = api.path('/ppp/active')
            active = next(
                (r for r in active_path.select(Key('.id'), Key('name'))
                 if r.get('name') == username),
                None
            )
            if active:
                active_path.remove(active['.id'])

        # 3. Update DB lokal
        conn = get_db()
        conn.execute(
            'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = NULL WHERE id = ?',
            (profil_restore, pelanggan_id)
        )
        conn.commit()
        conn.close()

        return jsonify({
            'message':     f'{username} berhasil diaktifkan kembali. Profil: {profil_restore}',
            'profil_baru': profil_restore,
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/reboot', methods=['POST'])
def reboot_pelanggan(pelanggan_id):
    """
    "Reboot modem" = putus sesi PPPoE aktif → modem reconnect otomatis.
    Body JSON opsional: { "username": "..." }
    """
    body              = request.get_json(silent=True) or {}
    username_override = (body.get('username') or '').strip()

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    username = username_override or pelanggan['username']

    try:
        from librouteros.query import Key
        with MikroTikClient(device) as mt:
            api = mt._get_api()
            active_path = api.path('/ppp/active')
            active = next(
                (r for r in active_path.select(Key('.id'), Key('name'))
                 if r.get('name') == username),
                None
            )
            if active:
                active_path.remove(active['.id'])
                label = 'Sesi PPPoE diputus — modem akan reconnect otomatis'
            else:
                label = 'Tidak ada sesi aktif untuk diputus'

        return jsonify({'message': f'{username}: {label}'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/credentials', methods=['GET'])
def get_pelanggan_credentials(pelanggan_id):
    """
    Ambil username + password REAL dari MikroTik PPPoE secret untuk pelanggan ini.

    Dipakai oleh detail_pelanggan.js untuk membangun CLI script registrasi
    OLT dengan password asli (bukan placeholder ●●●●●●).

    Response:
    {
      "username": "jakipetang",
      "password": "rahasiabanget"
    }

    SECURITY: endpoint ini sensitif — hanya admin yang sudah login.
    Password tidak pernah disimpan di log.
    """
    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    # Strategi 1: ambil dari MikroTik langsung (paling akurat)
    if device:
        try:
            with MikroTikClient(device) as mt:
                secrets = mt.get_ppp_secrets()
                for s in secrets:
                    if s.get('name') == pelanggan['username']:
                        mt_pwd = str(s.get('password', '') or '').strip()
                        if mt_pwd:
                            return jsonify({
                                'username': pelanggan['username'],
                                'password': mt_pwd,
                                'source':   'mikrotik',
                            }), 200
        except MikroTikError as e:
            logging.warning(f'[credentials] MikroTik {device["name"]} gagal: {e}')

    # Strategi 2: fallback ke password yang tersimpan di DB lokal
    conn = get_db()
    row  = conn.execute(
        'SELECT password FROM pelanggan WHERE id = ?', (pelanggan_id,)
    ).fetchone()
    conn.close()
    db_pwd = (row['password'] if row and row['password'] else '').strip()
    if db_pwd:
        return jsonify({
            'username': pelanggan['username'],
            'password': db_pwd,
            'source':   'db',
        }), 200

    return jsonify({'error': 'Password tidak ditemukan di MikroTik maupun DB'}), 404


# ══════════════════════════════════════════════════════════════
# REMOTE MODEM — NAT Port Forwarding
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/<int:pelanggan_id>/remote-on', methods=['POST'])
def remote_modem_on(pelanggan_id):
    """
    Buat NAT rule (dst-nat) di MikroTik untuk forward port publik ke IP modem
    pelanggan, sehingga modem bisa diakses dari internet untuk diagnostik.

    Body JSON:
    {
      "public_ip":  "103.194.175.54",   # opsional, default: WAN IP MikroTik
      "public_port": 8001,              # opsional, default: random 8000-8999
      "modem_port": 80                  # opsional, default: 80 (Web modem)
    }

    Response:
    {
      "url":         "http://103.194.175.54:8001",
      "modem_ip":    "10.10.10.5",
      "public_port": 8001,
      "expires_in":  3600
    }
    """
    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    body        = request.get_json(silent=True) or {}
    public_ip   = (body.get('public_ip')   or '').strip()
    public_port = int(body.get('public_port') or 0)
    modem_port  = int(body.get('modem_port')  or 80)

    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    if not public_port:
        # Generate port random dari range 8001-8999
        import random
        public_port = random.randint(8001, 8999)

    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()

            # 1. Cari IP modem dari /ppp/active
            active = mt.get_active_connections()
            modem_ip = None
            for a in active:
                if a.get('name') == pelanggan['username']:
                    modem_ip = a.get('address')
                    break
            if not modem_ip:
                return jsonify({
                    'error': f'Pelanggan {pelanggan["username"]} sedang offline. Remote tidak bisa dibuat.'
                }), 400

            # 2. Tentukan public IP dengan prioritas:
            #    a. public_ip dari body request (override manual)
            #    b. public_ip tersimpan di device (dari halaman input mikrotik) ← UTAMA
            #    c. auto-detect dari WAN MikroTik (fallback terakhir)
            if not public_ip:
                public_ip = (device.get('public_ip') or '').strip()
            if not public_ip:
                try:
                    addrs = list(api.path('/ip/address'))
                    for a in addrs:
                        addr = str(a.get('address') or '')
                        if addr and not addr.startswith(('10.', '192.168.', '172.')):
                            public_ip = addr.split('/')[0]
                            break
                except Exception:
                    pass
                if not public_ip:
                    return jsonify({
                        'error': 'IP Publik belum di-set. Atur di halaman Input MikroTik (field IP Publik), '
                                 'atau isi manual saat remote.'
                    }), 400

            # 3. Hapus NAT rule lama dengan comment yang sama (jika ada)
            tag     = f'remote-modem:{pelanggan["username"]}'
            nat_path = api.path('/ip/firewall/nat')
            for r in list(nat_path):
                if (r.get('comment') or '') == tag:
                    try:
                        nat_path.remove(r['.id'])
                    except Exception:
                        pass

            # 4. Buat NAT rule baru: dst-nat port publik → modem
            #    Parameter lengkap agar rule presisi & aman:
            #    - dst-address : hanya match trafik ke IP publik ini
            #    - in-interface: hanya dari WAN (kalau di-set di device)
            #    - protocol/dst-port → to-addresses/to-ports
            nat_params = {
                'chain':    'dstnat',
                'action':   'dst-nat',
                'protocol': 'tcp',
                'dst-port':     str(public_port),
                'to-addresses': modem_ip,
                'to-ports':     str(modem_port),
                'dst-address':  public_ip,
                'comment':  tag,
            }
            # in-interface hanya ditambahkan jika WAN interface di-set di device
            wan_iface = (device.get('wan_interface') or '').strip()
            if wan_iface:
                nat_params['in-interface'] = wan_iface

            nat_path.add(**nat_params)

            logging.info(f'[remote-modem] {pelanggan["username"]}: {public_ip}:{public_port} '
                         f'→ {modem_ip}:{modem_port} (wan={wan_iface or "any"})')

        return jsonify({
            'url':         f'http://{public_ip}:{public_port}',
            'modem_ip':    modem_ip,
            'public_ip':   public_ip,
            'public_port': public_port,
            'modem_port':  modem_port,
            'message':     f'Remote aktif. Buka link di tab baru untuk akses modem {pelanggan["username"]}.',
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/remote-off', methods=['POST'])
def remote_modem_off(pelanggan_id):
    """Hapus NAT rule remote untuk pelanggan ini."""
    body              = request.get_json(silent=True) or {}
    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404
    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    try:
        with MikroTikClient(device) as mt:
            api      = mt._get_api()
            tag      = f'remote-modem:{pelanggan["username"]}'
            nat_path = api.path('/ip/firewall/nat')
            removed  = 0
            for r in list(nat_path):
                if (r.get('comment') or '') == tag:
                    nat_path.remove(r['.id'])
                    removed += 1

        return jsonify({
            'message': f'Remote modem {pelanggan["username"]} dimatikan ({removed} rule dihapus)',
            'removed': removed,
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502


@api_bp.route('/pelanggan/<int:pelanggan_id>/provision', methods=['POST'])
def provision_pelanggan(pelanggan_id):
    """
    Registrasi ulang ONU ke OLT via SSH/Telnet (auto-provisioning).

    Body JSON:
    {
        "olt_id"    : 1,
        "slot_port" : "0/1/1:3",
        "vlan"      : "100",
        "sn"        : "ZTEG1A2B3C4D",
        "username"  : "pelanggan01",
        "profil"    : "PAKET20M",
        "cli_type"  : "zte" | "huawei",   ← dari tab yang aktif di halaman detail
        "re_provision": true
    }
    """
    body      = request.get_json(silent=True) or {}
    olt_id    = body.get('olt_id')
    slot_port = (body.get('slot_port') or '').strip()
    vlan      = str(body.get('vlan') or '').strip()
    sn        = (body.get('sn')       or '').strip()
    username  = (body.get('username') or '').strip()
    profil    = (body.get('profil')   or 'PAKET1').strip().upper()
    cli_type  = (body.get('cli_type') or 'zte').lower()
    tcont_profile = (body.get('tcont_profile') or '').strip()

    if not olt_id:
        return jsonify({'error': 'olt_id wajib diisi'}), 400
    if not sn:
        return jsonify({'error': 'Serial Number (SN) ONU wajib diisi'}), 400
    if not slot_port:
        return jsonify({'error': 'Slot/Port wajib diisi (format: 0/1/1:3)'}), 400

    olt = cari_olt(int(olt_id))
    if not olt:
        return jsonify({'error': 'Perangkat OLT tidak ditemukan'}), 404

    # Ambil password PPPoE ASLI pelanggan dari DB (untuk wan-ip pppoe di CLI)
    password_pel = ''
    try:
        conn = get_db()
        row  = conn.execute(
            'SELECT password FROM pelanggan WHERE id = ?', (pelanggan_id,)
        ).fetchone()
        conn.close()
        if row and row['password']:
            password_pel = row['password']
    except Exception:
        pass

    # Tentukan cli_type dari tipe OLT jika tidak di-override
    if not cli_type:
        tipe_olt = (olt.get('tipe') or '').lower()
        if 'huawei' in tipe_olt:
            cli_type = 'huawei'
        elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
            cli_type = 'epon'
        else:
            cli_type = 'zte'

    # Build CLI script via helper bersama (password real, bukan sn[-8:])
    commands = _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password_pel, tcont_profile)

    # Kirim via SSH/Telnet (Scrapli) — jika tidak tersedia, return script saja
    if not SCRAPLI_OK:
        return jsonify({
            'status':  'warning',
            'message': 'Scrapli tidak terinstall — script CLI berhasil di-generate tapi tidak dikirim otomatis',
            'cli_script': '\n'.join(commands),
            'warnings': ['Pasang scrapli: pip install scrapli untuk kirim otomatis ke OLT'],
        }), 207

    try:
        from scrapli.driver.generic import GenericDriver

        device_cfg = {
            'host':                 olt['ip'],
            'port':                 int(olt.get('port', 23)),
            'auth_username':        olt['username'],
            'auth_password':        olt['password'],
            'auth_strict_key':      False,
            'transport':            'telnet',
            'timeout_ops':          20,
            'comms_prompt_pattern': r'.*[>#\$]',
        }

        with GenericDriver(**device_cfg) as conn_olt:
            results = []
            for cmd in commands:
                r = conn_olt.send_command(cmd)
                results.append(r.result)

        return jsonify({
            'status':  'success',
            'message': f'Registrasi ulang ONU "{username}" berhasil dikirim ke OLT "{olt["name"]}"',
            'cli_type': cli_type.upper(),
            'commands_sent': len(commands),
        }), 200

    except Exception as e:
        logging.error(f'[provision] OLT {olt_id}: {e}')
        return jsonify({
            'status':  'warning',
            'message': f'Script di-generate tapi gagal kirim ke OLT: {str(e)}',
            'cli_script': '\n'.join(commands),
            'warnings': [str(e)],
        }), 207



@api_bp.route('/maps/legend', methods=['GET'])
def get_legend():
    """Keterangan warna dan simbol peta."""
    return jsonify({
        "device_types": [
            {"type": "router", "label": "Router/Core",     "color": "#0040a1"},
            {"type": "olt",    "label": "OLT",             "color": "#7c3aed"},
            {"type": "odp",    "label": "ODP",             "color": "#b45309"},
            {"type": "onu",    "label": "ONU (Pelanggan)", "color": "#006c47"},
        ],
        "rx_power_levels": [
            {"label": "Normal",         "range": "> -20 dBm",       "color": "#16a34a"},
            {"label": "Redaman Tinggi", "range": "-20 s/d -25 dBm", "color": "#d97706"},
            {"label": "LOS / Kritis",   "range": "< -25 dBm",       "color": "#dc2626"},
        ],
        "link_colors": [
            {"label": "Online",  "color": "#22c55e"},
            {"label": "Offline", "color": "#ef4444"},
        ]
    }), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 4 — KEUANGAN
# ══════════════════════════════════════════════════════════════

def keuangan_to_dict(row) -> dict:
    """Ubah sqlite3.Row tabel 'keuangan' → dict JSON-serializable."""
    return {
        'id':          row['id'],
        'tanggal':     row['tanggal'],
        'keterangan':  row['keterangan'],
        'tipe':        row['tipe'],
        'nominal':     row['nominal'],
        'status':      row['status'],
        'metode':      row['metode'],
        'device_id':   row['device_id'],
        'username':    row['username']   or '',
        'catatan':     row['catatan']    or '',
        'created_at':  row['created_at'] or '',
    }


def _bulan_ini():
    """Kembalikan (awal_bulan, akhir_bulan) dalam format YYYY-MM-DD."""
    today = date.today()
    awal  = today.replace(day=1).isoformat()
    akhir = today.replace(
        day=calendar.monthrange(today.year, today.month)[1]
    ).isoformat()
    return awal, akhir


@api_bp.route('/keuangan', methods=['GET'])
def get_keuangan():
    """
    Ringkasan statistik + daftar transaksi dengan filter & paginasi.

    Query params:
      q, tipe, status, bulan (YYYY-MM), limit, offset
    """
    q       = request.args.get('q',      '').strip()
    tipe    = request.args.get('tipe',   '').strip().lower()
    status  = request.args.get('status', '').strip()
    bulan   = request.args.get('bulan',  '').strip()
    limit   = int(request.args.get('limit',  100))
    offset  = int(request.args.get('offset', 0))

    if bulan:
        try:
            y, m  = map(int, bulan.split('-'))
            awal  = date(y, m, 1).isoformat()
            akhir = date(y, m, calendar.monthrange(y, m)[1]).isoformat()
        except Exception:
            awal, akhir = _bulan_ini()
    else:
        awal, akhir = _bulan_ini()

    try:
        bulan_label = datetime.strptime(awal, '%Y-%m-%d').strftime('%B %Y')
    except Exception:
        bulan_label = ''

    conn = get_db()

    stat_rows = conn.execute('''
        SELECT tipe, status, SUM(nominal) AS total
        FROM keuangan
        WHERE tanggal BETWEEN ? AND ?
        GROUP BY tipe, status
    ''', (awal, akhir)).fetchall()

    total_pemasukan = total_piutang = total_pengeluaran = 0
    for r in stat_rows:
        if r['tipe'] == 'pemasukan':
            if r['status'] == 'Lunas':
                total_pemasukan += r['total']
            elif r['status'] == 'Pending':
                total_piutang   += r['total']
        elif r['tipe'] == 'pengeluaran' and r['status'] in ('Lunas', 'Pending'):
            total_pengeluaran += r['total']

    where  = ['tanggal BETWEEN ? AND ?']
    params = [awal, akhir]

    if tipe in ('pemasukan', 'pengeluaran'):
        where.append('tipe = ?')
        params.append(tipe)
    if status:
        where.append('status = ?')
        params.append(status)
    if q:
        where.append('(keterangan LIKE ? OR username LIKE ? OR catatan LIKE ?)')
        like = f'%{q}%'
        params.extend([like, like, like])

    where_sql  = 'WHERE ' + ' AND '.join(where)
    total_rows = conn.execute(
        f'SELECT COUNT(*) FROM keuangan {where_sql}', params
    ).fetchone()[0]

    rows = conn.execute(
        f'SELECT * FROM keuangan {where_sql} ORDER BY tanggal DESC, id DESC LIMIT ? OFFSET ?',
        params + [limit, offset]
    ).fetchall()
    conn.close()

    return jsonify({
        'stats': {
            'total_pemasukan':   total_pemasukan,
            'total_piutang':     total_piutang,
            'total_pengeluaran': total_pengeluaran,
            'saldo_bersih':      total_pemasukan - total_pengeluaran,
            'bulan_label':       bulan_label,
            'range':             {'awal': awal, 'akhir': akhir},
        },
        'transaksi':  [keuangan_to_dict(r) for r in rows],
        'total_rows': total_rows,
    }), 200


@api_bp.route('/keuangan/export', methods=['GET'])
def export_keuangan():
    """
    Ekspor transaksi keuangan ke CSV — mengikuti filter yang sama
    dengan GET /api/keuangan (q, tipe, status, bulan), tanpa paginasi.
    """
    q      = request.args.get('q',      '').strip()
    tipe   = request.args.get('tipe',   '').strip().lower()
    status = request.args.get('status', '').strip()
    bulan  = request.args.get('bulan',  '').strip()

    if bulan:
        try:
            y, m  = map(int, bulan.split('-'))
            awal  = date(y, m, 1).isoformat()
            akhir = date(y, m, calendar.monthrange(y, m)[1]).isoformat()
        except Exception:
            awal, akhir = _bulan_ini()
    else:
        awal, akhir = _bulan_ini()

    where  = ['tanggal BETWEEN ? AND ?']
    params = [awal, akhir]

    if tipe in ('pemasukan', 'pengeluaran'):
        where.append('tipe = ?')
        params.append(tipe)
    if status:
        where.append('status = ?')
        params.append(status)
    if q:
        where.append('(keterangan LIKE ? OR username LIKE ? OR catatan LIKE ?)')
        like = f'%{q}%'
        params.extend([like, like, like])

    where_sql = 'WHERE ' + ' AND '.join(where)
    conn = get_db()
    rows = conn.execute(
        f'SELECT * FROM keuangan {where_sql} ORDER BY tanggal DESC, id DESC', params
    ).fetchall()
    conn.close()

    buf = io.StringIO()
    buf.write('﻿')  # BOM agar Excel membaca UTF-8 dengan benar
    writer = csv.writer(buf)
    writer.writerow(['Tanggal', 'Keterangan', 'Tipe', 'Nominal', 'Status', 'Metode', 'Username', 'Catatan'])
    for r in rows:
        d = keuangan_to_dict(r)
        writer.writerow([
            d['tanggal'],
            d['keterangan'],
            'Pemasukan' if d['tipe'] == 'pemasukan' else 'Pengeluaran',
            d['nominal'],
            d['status'],
            d['metode'] or '',
            d['username'],
            d['catatan'],
        ])

    filename = f"keuangan_{bulan or awal[:7]}.csv"
    return Response(
        buf.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@api_bp.route('/keuangan', methods=['POST'])
def tambah_keuangan():
    """Catat transaksi baru."""
    data = request.get_json() or {}

    keterangan = data.get('keterangan', '').strip()
    tipe       = data.get('tipe',       '').strip().lower()
    nominal    = data.get('nominal',    0)
    tanggal    = data.get('tanggal',    date.today().isoformat()).strip()
    status     = data.get('status',     'Pending').strip()
    metode     = data.get('metode',     'Transfer').strip()
    device_id  = data.get('device_id',  None)
    username   = data.get('username',   '').strip()
    catatan    = data.get('catatan',    '').strip()

    if not keterangan:
        return jsonify({'status': 'error', 'message': 'Keterangan wajib diisi'}), 400
    if tipe not in ('pemasukan', 'pengeluaran'):
        return jsonify({'status': 'error', 'message': 'Tipe harus pemasukan atau pengeluaran'}), 400
    try:
        nominal = int(nominal)
        if nominal < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'status': 'error', 'message': 'Nominal harus berupa angka positif'}), 400
    if status not in ('Lunas', 'Pending', 'Gagal'):
        status = 'Pending'

    conn   = get_db()
    cursor = conn.execute('''
        INSERT INTO keuangan
          (tanggal, keterangan, tipe, nominal, status, metode,
           device_id, username, catatan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (tanggal, keterangan, tipe, nominal, status, metode,
          device_id, username, catatan))
    new_id = cursor.lastrowid
    conn.commit()

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   'Transaksi berhasil dicatat',
        'transaksi': keuangan_to_dict(row),
    }), 201


@api_bp.route('/keuangan/<int:trx_id>', methods=['PUT'])
def update_keuangan(trx_id):
    """Edit data transaksi berdasarkan ID."""
    conn    = get_db()
    current = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    data = request.get_json() or {}

    keterangan = data.get('keterangan', current['keterangan']).strip()
    tipe       = data.get('tipe',       current['tipe']).strip().lower()
    tanggal    = data.get('tanggal',    current['tanggal']).strip()
    metode     = data.get('metode',     current['metode']).strip()
    status     = data.get('status',     current['status']).strip()
    username   = data.get('username',   current['username'] or '').strip()
    catatan    = data.get('catatan',    current['catatan']  or '').strip()
    device_id  = data.get('device_id',  current['device_id'])

    try:
        nominal = int(data.get('nominal', current['nominal']))
    except (ValueError, TypeError):
        nominal = current['nominal']

    if tipe   not in ('pemasukan', 'pengeluaran'): tipe   = current['tipe']
    if status not in ('Lunas', 'Pending', 'Gagal'): status = current['status']

    conn.execute('''
        UPDATE keuangan
        SET tanggal=?, keterangan=?, tipe=?, nominal=?, status=?,
            metode=?, device_id=?, username=?, catatan=?
        WHERE id=?
    ''', (tanggal, keterangan, tipe, nominal, status,
          metode, device_id, username, catatan, trx_id))
    conn.commit()

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   'Transaksi berhasil diperbarui',
        'transaksi': keuangan_to_dict(row),
    }), 200


@api_bp.route('/keuangan/<int:trx_id>', methods=['DELETE'])
def hapus_keuangan(trx_id):
    """Hapus satu transaksi berdasarkan ID."""
    conn     = get_db()
    affected = conn.execute('DELETE FROM keuangan WHERE id = ?', (trx_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    return jsonify({'status': 'success', 'message': 'Transaksi berhasil dihapus'}), 200


@api_bp.route('/keuangan/<int:trx_id>/lunas', methods=['POST'])
def set_lunas(trx_id):
    """
    Ubah status transaksi menjadi 'Lunas'.

    TODO Fase 4: Tambahkan logika auto-buka blokir MikroTik di sini.
    Skeleton tersedia di komentar — uncomment dan sesuaikan.
    """
    conn = get_db()
    row  = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()

    if not row:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    if row['status'] == 'Lunas':
        conn.close()
        return jsonify({'status': 'info', 'message': 'Transaksi sudah berstatus Lunas'}), 200

    conn.execute("UPDATE keuangan SET status = 'Lunas' WHERE id = ?", (trx_id,))
    conn.commit()

    # TODO Fase 4: auto-buka blokir MikroTik
    # if row['device_id'] and row['username']:
    #     device = get_db().execute(
    #         'SELECT * FROM devices WHERE id = ?', (row['device_id'],)
    #     ).fetchone()
    #     if device:
    #         try:
    #             with MikroTikClient(dict(device)) as mt:
    #                 mt.edit_secret(row['username'], {'disabled': 'no'})
    #         except MikroTikError as e:
    #             logging.warning(f'[Lunas] Gagal buka blokir: {e}')

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   f'Transaksi #{trx_id} berhasil ditandai Lunas',
        'transaksi': keuangan_to_dict(row),
    }), 200


@api_bp.route('/keuangan/metode', methods=['GET'])
def get_metode():
    """Daftar metode pembayaran yang tersedia."""
    return jsonify([
        'Transfer', 'Tunai', 'QRIS', 'GoPay', 'OVO',
        'Dana', 'ShopeePay', 'Debit', 'Kredit',
    ]), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 5 — PPPoE PROFILE
# [DIPINDAHKAN DARI DUPLIKAT KEDUA — sebelumnya hanya ada di sana]
# ══════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════
# BAGIAN 5 — PPPoE PROFILE
# ✅ v2.0 UPDATE: tambah field bandwidth_note, profile-count endpoint
# ══════════════════════════════════════════════════════════════

def _get_harga_map(device_id: int) -> dict:
    """
    Ambil semua data harga dari tabel profil_harga untuk device ini.
    Return: { nama_profile: {harga, deskripsi, bandwidth_note} }
    """
    conn = get_db()
    rows = conn.execute(
        '''SELECT nama_profile, harga, deskripsi, bandwidth_note
           FROM profil_harga WHERE device_id = ?''',
        (device_id,)
    ).fetchall()
    conn.close()
    return {
        r['nama_profile']: {
            'harga':          r['harga']          or 0,
            'deskripsi':      r['deskripsi']       or '',
            'bandwidth_note': r['bandwidth_note']  or '',
        }
        for r in rows
    }


def _build_rate_limit(body: dict) -> str:
    """
    Bangun string rate-limit MikroTik dari data form.

    Input: { rate_down: "10", rate_unit_d: "M", rate_up: "10", rate_unit_u: "M" }
           atau { rate_limit: "10M/10M" }
    Output: "10M/10M" atau "" jika kosong
    """
    raw = (body.get('rate_limit') or '').strip()
    if raw:
        return raw

    down = str(body.get('rate_down') or '').strip()
    up   = str(body.get('rate_up')   or '').strip()
    ud   = (body.get('rate_unit_d') or 'M').strip().upper()
    uu   = (body.get('rate_unit_u') or 'M').strip().upper()

    if not down or not up:
        return ''

    return f'{down}{ud}/{up}{uu}'


@api_bp.route('/profile/<int:device_id>', methods=['GET'])
def get_profiles(device_id):
    """
    Ambil semua PPP Profile dari MikroTik + data lokal (harga,
    bandwidth_note, deskripsi) dari DB.

    Response per item:
    {
        "id", "name", "rate_limit", "rate_down", "rate_up",
        "harga", "bandwidth_note", "deskripsi", "comment", "total_user"
    }
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            profiles = mt.get_ppp_profiles()
            secrets  = mt.get_ppp_secrets()

        user_count = {}
        for s in secrets:
            p = s.get('profile', 'default')
            user_count[p] = user_count.get(p, 0) + 1

        harga_map = _get_harga_map(device_id)

        hasil = []
        for p in profiles:
            nama       = p.get('name', '')
            harga_data = harga_map.get(nama, {})
            hasil.append({
                'id':             p.get('.id', ''),
                'name':           nama,
                'rate_limit':     p.get('rate_limit_raw', ''),
                'rate_down':      p.get('rate_down', 'unlimited'),
                'rate_up':        p.get('rate_up',   'unlimited'),
                'local_addr':     p.get('local-address', ''),
                'remote_addr':    p.get('remote-address', ''),
                'comment':        p.get('comment', ''),
                'harga':          harga_data.get('harga', 0),
                'deskripsi':      harga_data.get('deskripsi', ''),
                'bandwidth_note': harga_data.get('bandwidth_note', ''),
                'total_user':     user_count.get(nama, 0),
            })

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/profile/<int:device_id>', methods=['POST'])
def add_profile(device_id):
    """
    Tambah PPP Profile baru — OPERASI ATOMIK:
      1. Tulis ke MikroTik terlebih dahulu.
      2. Jika berhasil → simpan harga & catatan lokal ke profil_harga.
      3. Jika MikroTik gagal (502) → tidak ada yang tersimpan (rollback otomatis).

    Body JSON:
      name, rate_down, rate_unit_d, rate_up, rate_unit_u,
      harga, bandwidth_note, deskripsi, comment
    """
    body           = request.get_json(silent=True) or {}
    nama           = (body.get('name')           or '').strip()
    harga          = int(body.get('harga')        or 0)
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()

    if not nama:
        return jsonify({'error': 'Nama profile wajib diisi'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    rate_limit = _build_rate_limit(body)
    if not rate_limit:
        return jsonify({'error': 'Kecepatan download dan upload wajib diisi'}), 400

    # ── STEP 1: Tulis ke MikroTik (jika gagal → 502, tidak ada yang disimpan) ──
    try:
        with MikroTikClient(device) as mt:
            mt.tambah_profile({
                'name':       nama,
                'rate-limit': rate_limit,
                'comment':    body.get('comment', ''),
            })

    except MikroTikError as e:
        return jsonify({'error': str(e), 'rollback': True}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500

    # ── STEP 2: Simpan data lokal (MikroTik sudah berhasil) ────────────────────
    try:
        conn = get_db()
        conn.execute(
            '''INSERT INTO profil_harga
               (device_id, nama_profile, harga, bandwidth_note, deskripsi)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(device_id, nama_profile) DO UPDATE SET
                 harga          = excluded.harga,
                 bandwidth_note = excluded.bandwidth_note,
                 deskripsi      = excluded.deskripsi''',
            (device_id, nama, harga, bandwidth_note, deskripsi)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logging.warning(
            f'[profile] Profile "{nama}" sudah ada di MikroTik '
            f'tapi gagal simpan ke DB lokal: {e}'
        )

    return jsonify({'message': f'Profile {nama} ({rate_limit}) berhasil ditambahkan'}), 201


@api_bp.route('/profile/<int:device_id>/<string:nama_profile>', methods=['PUT'])
def update_profile(device_id, nama_profile):
    """
    Edit PPP Profile — OPERASI ATOMIK (support rename):
      1. Update di MikroTik via RouterOS API.
      2. Jika berhasil → update profil_harga lokal.
      3. Jika MikroTik gagal (502) → tidak ada perubahan di DB.
    """
    body           = request.get_json(silent=True) or {}
    nama_baru      = (body.get('name') or nama_profile).strip()
    harga          = int(body.get('harga')        or 0)
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    rate_limit = _build_rate_limit(body)

    # ── STEP 1: Update di MikroTik ─────────────────────────────────────────────
    try:
        with MikroTikClient(device) as mt:
            mt.edit_profile(nama_profile, {
                'name':       nama_baru,
                'rate-limit': rate_limit,
                'comment':    body.get('comment', ''),
            })

    except MikroTikError as e:
        return jsonify({'error': str(e), 'rollback': True}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500

    # ── STEP 2: Update DB lokal ─────────────────────────────────────────────────
    try:
        conn = get_db()
        if nama_baru != nama_profile:
            conn.execute(
                'DELETE FROM profil_harga WHERE device_id=? AND nama_profile=?',
                (device_id, nama_profile)
            )
        conn.execute(
            '''INSERT INTO profil_harga
               (device_id, nama_profile, harga, bandwidth_note, deskripsi)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(device_id, nama_profile) DO UPDATE SET
                 harga          = excluded.harga,
                 bandwidth_note = excluded.bandwidth_note,
                 deskripsi      = excluded.deskripsi''',
            (device_id, nama_baru, harga, bandwidth_note, deskripsi)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logging.warning(f'[profile] Update MikroTik OK tapi DB lokal gagal: {e}')

    return jsonify({'message': f'Profile {nama_baru} berhasil diperbarui'}), 200




@api_bp.route('/profile/<int:device_id>/<string:nama_profile>/local', methods=['PATCH'])
def patch_profile_local(device_id, nama_profile):
    """
    Update data lokal saja (harga, bandwidth_note, deskripsi)
    TANPA menyentuh MikroTik sama sekali.

    Dipakai oleh inline edit di tabel profile_pppoe —
    pengguna edit langsung di sel tabel, simpan otomatis onchange.

    Body JSON:
      harga          int
      bandwidth_note str
      deskripsi      str
    """
    body           = request.get_json(silent=True) or {}
    harga          = int(body.get('harga', 0) or 0)
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()

    try:
        conn = get_db()
        conn.execute(
            """INSERT INTO profil_harga
               (device_id, nama_profile, harga, bandwidth_note, deskripsi)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(device_id, nama_profile) DO UPDATE SET
                 harga          = excluded.harga,
                 bandwidth_note = excluded.bandwidth_note,
                 deskripsi      = excluded.deskripsi""",
            (device_id, nama_profile, harga, bandwidth_note, deskripsi)
        )
        conn.commit()
        conn.close()
        return jsonify({'message': 'Data lokal tersimpan'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/profile/<int:device_id>/<string:nama_profile>', methods=['DELETE'])
def delete_profile(device_id, nama_profile):
    """Hapus PPP Profile dari MikroTik + hapus harga dari DB."""
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            mt.hapus_profile(nama_profile)

        conn = get_db()
        conn.execute(
            'DELETE FROM profil_harga WHERE device_id=? AND nama_profile=?',
            (device_id, nama_profile)
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'Profile {nama_profile} berhasil dihapus'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500

# Endpoint maps dipindahkan ke maps.py (blueprint maps_bp, prefix /api/maps)

# ══════════════════════════════════════════════════════════════
# ENDPOINT BARU — DASHBOARD v4.2
# Pola mengikuti get_ppp_secrets() di mikrotik.py:
#   api.path('/xxx') tanpa .select() → dapat semua field
# ══════════════════════════════════════════════════════════════

@api_bp.route('/keuangan/ringkasan', methods=['GET'])
def get_keuangan_ringkasan():
    awal, akhir = _bulan_ini()
    conn = get_db()
    try:
        rows = conn.execute('''
            SELECT tipe, status, SUM(nominal) AS total
            FROM keuangan WHERE tanggal BETWEEN ? AND ?
            GROUP BY tipe, status
        ''', (awal, akhir)).fetchall()

        pendapatan = piutang = pengeluaran = 0
        for r in rows:
            t, s, v = r['tipe'] or '', r['status'] or '', r['total'] or 0
            if t == 'pemasukan':
                if s == 'Lunas':    pendapatan += v
                elif s == 'Pending': piutang   += v
            elif t == 'pengeluaran':
                pengeluaran += v

        jt = conn.execute('''
            SELECT COUNT(*) as cnt FROM keuangan
            WHERE tipe='pemasukan' AND status='Pending'
              AND tanggal BETWEEN ? AND ?
        ''', (awal, akhir)).fetchone()

        return jsonify({
            'pendapatan_bulan':  pendapatan,
            'total_piutang':     piutang,
            'total_pengeluaran': pengeluaran,
            'saldo_bersih':      pendapatan - pengeluaran,
            'jatuh_tempo':       jt['cnt'] if jt else 0,
            'periode':           {'awal': awal, 'akhir': akhir},
        }), 200
    except Exception as e:
        logging.error(f'[keuangan/ringkasan] {e}')
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@api_bp.route('/mikrotik/<int:device_id>/interfaces', methods=['GET'])
def get_interfaces(device_id):
    """
    Daftar interface dari MikroTik.
    Pakai api.path('/interface') tanpa .select() — identik pola mikrotik.py.
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            api  = mt._get_api()
            # Identik pola get_ppp_secrets(): path tanpa .select()
            rows = list(api.path('/interface'))

        result = []
        for r in rows:
            row = dict(r)
            if str(row.get('disabled', 'false')).lower() in ('true', 'yes'):
                continue
            result.append({
                'name':    row.get('name',    ''),
                'type':    row.get('type',    ''),
                'comment': row.get('comment', ''),
                'running': str(row.get('running', 'false')).lower() in ('true', 'yes'),
                'mtu': int(str(row.get('mtu', 1500) or 1500).split('M')[0]) if row.get('mtu') else 1500,
            })

        # Urutkan: ether/sfp duluan
        _order = {'ether': 0, 'sfp': 0, 'sfp-sfpplus': 0, 'vlan': 1}
        result.sort(key=lambda x: (_order.get(x["type"], 2), str(x["name"])))

        return jsonify(result), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[interfaces] device {device_id}: {e}')
        return jsonify({'error': str(e)}), 500


@api_bp.route('/mikrotik/<int:device_id>/vlans', methods=['GET'])
def get_vlans(device_id):
    """
    Daftar VLAN ID yang dikonfigurasi di MikroTik (dari /interface/vlan),
    dipakai untuk saran field VLAN di form pelanggan.
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            vlan_map = mt.get_vlan_map()

        seen, result = set(), []
        for iface, vid in vlan_map.items():
            if vid in seen:
                continue
            seen.add(vid)
            result.append({'vlan_id': vid, 'interface': iface})

        result.sort(key=lambda x: (len(x['vlan_id']), x['vlan_id']))
        return jsonify(result), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[vlans] device {device_id}: {e}')
        return jsonify({'error': str(e)}), 500


@api_bp.route('/mikrotik/<int:device_id>/bandwidth', methods=['GET'])
def get_bandwidth(device_id):
    """
    Traffic realtime satu interface. ?iface=ether1
    Coba monitor-traffic → fallback selisih rx-byte/tx-byte.
    """
    iface = request.args.get('iface', '').strip()
    if not iface:
        return jsonify({'error': 'Parameter iface wajib ada'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    import time as _time

    try:
        with MikroTikClient(device) as mt:
            api     = mt._get_api()
            rx_mbps = 0.0
            tx_mbps = 0.0

            # Coba monitor-traffic
            try:
                samples = list(api.path('/interface/monitor-traffic')(
                    **{'interface': iface, 'duration': '1', 'once': ''}
                ))
                if samples:
                    s       = dict(samples[0])
                    rx_mbps = round(float(s.get('rx-bits-per-second', 0) or 0) / 1_000_000, 3)
                    tx_mbps = round(float(s.get('tx-bits-per-second', 0) or 0) / 1_000_000, 3)
            except Exception:
                # Fallback: selisih rx-byte/tx-byte selang 1 detik
                try:
                    def _snap():
                        for r in api.path('/interface'):
                            rd = dict(r)
                            if rd.get('name') == iface:
                                return rd
                        return {}
                    s1 = _snap(); _time.sleep(1); s2 = _snap()
                    if s1 and s2:
                        rx_mbps = round(max(int(s2.get('rx-byte',0)) - int(s1.get('rx-byte',0)), 0) * 8 / 1_000_000, 3)
                        tx_mbps = round(max(int(s2.get('tx-byte',0)) - int(s1.get('tx-byte',0)), 0) * 8 / 1_000_000, 3)
                except Exception:
                    pass

        return jsonify({
            'iface': iface, 'rx_mbps': rx_mbps, 'tx_mbps': tx_mbps,
            'ts': datetime.now().isoformat(),
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[bandwidth] device {device_id} iface {iface}: {e}')
        return jsonify({'error': str(e)}), 500



# ── Status sinkron per device (in-memory) ────────────────────
_sync_status = {}


@api_bp.route('/stats/<int:device_id>', methods=['GET'])
def get_stats(device_id):
    """
    Endpoint RINGAN — baca DB lokal saja, tidak sentuh MikroTik.
    Catatan: kolom 'aktif' = akun tidak di-disabled di MikroTik,
    BUKAN berarti sedang online. Angka realtime online/offline
    tersedia setelah sync selesai via /api/pelanggan/<id>.
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    conn = get_db()
    try:
        row = conn.execute(
            'SELECT COUNT(*) as total, '
            'SUM(CASE WHEN aktif=1 THEN 1 ELSE 0 END) as aktif '
            'FROM pelanggan'
        ).fetchone()
        total   = row['total'] or 0
        aktif   = row['aktif'] or 0
        nonaktif = total - aktif
        sync_info = _sync_status.get(device_id, {'status': 'idle', 'msg': '', 'ts': ''})
        return jsonify({
            'total':    total,
            'online':   aktif,    # sementara: aktif = tidak disabled
            'offline':  nonaktif,
            'realtime': False,    # flag: angka ini BUKAN realtime online
            'sync':     sync_info,
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@api_bp.route('/sync/<int:device_id>', methods=['POST'])
def trigger_sync(device_id):
    """Jalankan sinkron MikroTik di background thread."""
    import threading

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    if _sync_status.get(device_id, {}).get('status') == 'running':
        return jsonify({'status': 'running', 'msg': 'Sinkron sedang berjalan'}), 202

    def _do_sync():
        _sync_status[device_id] = {'status': 'running', 'msg': 'Mengambil data...', 'ts': datetime.now().isoformat()}
        try:
            # Dua koneksi terpisah — MikroTikClient tidak thread-safe dalam 1 instance
            with MikroTikClient(device) as mt:
                secrets = mt.get_ppp_secrets()

            with MikroTikClient(device) as mt:
                active_conns = mt.get_active_connections()

            active_names = {a.get('name') for a in active_conns}
            conn = get_db()

            rows_lokal = {r['username']: r['password'] for r in conn.execute(
                'SELECT username, password FROM pelanggan').fetchall()}
            onu_map = {r['username']: dict(r) for r in conn.execute(
                'SELECT username, olt_id, slot_port, vlan, sn FROM onu_mapping').fetchall()}

            _empty = {'olt_id': None, 'slot_port': '', 'vlan': None, 'sn': ''}
            params = []
            for s in secrets:
                u = str(s.get('name', '') or '').strip()
                if not u:
                    continue
                pw_mt   = str(s.get('password', '') or '').strip()
                pw_save = rows_lokal.get(u) or ''
                onu     = onu_map.get(u, _empty)
                params.append((
                    u, s.get('comment') or u, pw_mt or pw_save,
                    s.get('profile', 'default'), s.get('service', 'pppoe'),
                    0 if s.get('disabled') == 'true' else 1,
                    onu.get('olt_id'), onu.get('slot_port') or '',
                    onu.get('vlan'), onu.get('sn') or '',
                ))

            if params:
                # Cek kolom yang tersedia — support row_factory maupun tuple
                def _get_col_names(conn):
                    rows = conn.execute("PRAGMA table_info(pelanggan)").fetchall()
                    try:
                        return {r['name'] for r in rows}
                    except (TypeError, IndexError):
                        return {r[1] for r in rows}  # fallback: index numerik

                col_names = _get_col_names(conn)
                logging.info(f'[sync] kolom pelanggan: {col_names}')

                # Tambah kolom yang belum ada
                for col_def in [
                    ('olt_id',   'INTEGER'),
                    ('slot_port', "TEXT DEFAULT ''"),
                    ('vlan',     'INTEGER'),
                    ('sn',       "TEXT DEFAULT ''"),
                ]:
                    if col_def[0] not in col_names:
                        try:
                            conn.execute(f"ALTER TABLE pelanggan ADD COLUMN {col_def[0]} {col_def[1]}")
                            logging.info(f'[sync] ALTER TABLE: tambah kolom {col_def[0]}')
                        except Exception as ae:
                            logging.warning(f'[sync] ALTER TABLE {col_def[0]}: {ae}')

                # Pisahkan username yang sudah ada vs baru
                existing = {r[0] for r in conn.execute(
                    'SELECT username FROM pelanggan').fetchall()}

                to_insert = [(u,n,p,pr,sv,ak,oi,sp,vl,sn)
                             for (u,n,p,pr,sv,ak,oi,sp,vl,sn) in params
                             if u not in existing]
                to_update = [(pr,sv,ak,p,n,oi,sp,sp,vl,sn,sn,u)
                             for (u,n,p,pr,sv,ak,oi,sp,vl,sn) in params
                             if u in existing]

                if to_insert:
                    conn.executemany(
                        'INSERT OR IGNORE INTO pelanggan '
                        '(username,nama,password,profil,service,aktif,olt_id,slot_port,vlan,sn) '
                        'VALUES (?,?,?,?,?,?,?,?,?,?)',
                        to_insert)

                if to_update:
                    # olt_id/slot_port/vlan/sn ikut dipatch dari onu_mapping (mis. saat
                    # OLT-CANTUK disinkronkan, data ONU pelanggan Cantuk1 ikut terisi) —
                    # pakai COALESCE/CASE supaya tidak menimpa data manual dgn nilai kosong.
                    conn.executemany(
                        'UPDATE pelanggan SET profil=?,service=?,aktif=?,password=?,'
                        'nama=CASE WHEN nama IS NULL OR nama="" THEN ? ELSE nama END,'
                        'olt_id=COALESCE(?, olt_id),'
                        "slot_port=CASE WHEN ? != '' THEN ? ELSE slot_port END,"
                        'vlan=COALESCE(?, vlan),'
                        "sn=CASE WHEN ? != '' THEN ? ELSE sn END "
                        'WHERE username=?',
                        to_update)

                conn.commit()
            conn.close()

            _sync_status[device_id] = {
                'status': 'done',
                'msg': f'Selesai · {len(params)} pelanggan',
                'ts': datetime.now().isoformat(),
            }
            logging.info(f'[sync] device {device_id} done — {len(params)} rows')

        except Exception as e:
            logging.error(f'[sync] device {device_id} error: {e}')
            _sync_status[device_id] = {'status': 'error', 'msg': str(e), 'ts': datetime.now().isoformat()}

    threading.Thread(target=_do_sync, daemon=True).start()
    return jsonify({'status': 'running', 'msg': 'Sinkron dimulai'}), 202


@api_bp.route('/mikrotik/<int:device_id>/resource', methods=['GET'])
def get_mikrotik_resource(device_id):
    """CPU, memory, uptime, suhu, board name, version dari /system/resource."""
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404
    try:
        with MikroTikClient(device) as mt:
            api  = mt._get_api()
            rows = list(api.path('/system/resource'))
            if not rows:
                return jsonify({'error': 'Tidak ada data resource'}), 502
            r = dict(rows[0])

        mem_total = int(r.get('total-memory', 0) or 0)
        mem_free  = int(r.get('free-memory',  0) or 0)
        mem_used  = mem_total - mem_free
        mem_pct   = round(mem_used / mem_total * 100) if mem_total else 0
        cpu_load  = int(r.get('cpu-load', 0) or 0)

        suhu = r.get('board-temp') or r.get('temperature') or None
        if suhu is not None:
            try: suhu = int(suhu)
            except Exception: suhu = None

        return jsonify({
            'cpu_load':     cpu_load,
            'mem_total':    mem_total,
            'mem_free':     mem_free,
            'mem_used':     mem_used,
            'mem_pct':      mem_pct,
            'uptime':       r.get('uptime', ''),
            'board_name':   r.get('board-name', ''),
            'architecture': r.get('architecture-name', r.get('cpu', '')),
            'version':      r.get('version', ''),
            'suhu':         suhu,
            'ts':           datetime.now().isoformat(),
        }), 200
    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[resource] device {device_id}: {e}')
        return jsonify({'error': str(e)}), 500


@api_bp.route('/mikrotik/<int:device_id>/log', methods=['GET'])
def get_mikrotik_log(device_id):
    """Log terbaru dari RouterOS /log."""
    limit  = min(int(request.args.get('limit', 50)), 200)
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            api  = mt._get_api()
            rows = list(api.path('/log'))

        rows = rows[-limit:]
        rows.reverse()
        result = [{
            'topic':   dict(r).get('topics',  'info'),
            'message': dict(r).get('message', ''),
            'time':    dict(r).get('time',    ''),
            'ts':      dict(r).get('time',    ''),
        } for r in rows]

        return jsonify(result), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[mikrotik/log] device {device_id}: {e}')
        return jsonify({'error': str(e)}), 500


@api_bp.route('/log/aktivitas', methods=['GET'])
def get_log_aktivitas():
    device_id = request.args.get('device_id')
    limit     = min(int(request.args.get('limit', 40)), 100)
    conn      = get_db()
    try:
        logs = []
        for r in conn.execute(
            'SELECT tanggal, keterangan, tipe, status, nominal, username, created_at '
            'FROM keuangan ORDER BY id DESC LIMIT ?', (limit,)
        ).fetchall():
            tipe, status = r['tipe'] or '', r['status'] or ''
            topic = 'sukses' if status == 'Lunas' else ('warning' if status == 'Pending' else 'info')
            msg   = f"[{tipe.upper()}] {r['keterangan'] or ''}"
            if r['username']: msg += f" — {r['username']}"
            if r['nominal']:  msg += f" Rp {r['nominal']:,}".replace(',', '.')
            logs.append({'topic': topic, 'message': msg,
                         'time': r['tanggal'] or '', 'ts': r['created_at'] or r['tanggal'] or ''})

        if device_id:
            for r in conn.execute(
                'SELECT username, profil, tgl_pasang FROM pelanggan '
                'WHERE device_id=? ORDER BY id DESC LIMIT 20', (device_id,)
            ).fetchall():
                if r['tgl_pasang']:
                    logs.append({'topic': 'tambah',
                                 'message': f"[PPPoE] {r['username']} — {r['profil'] or 'default'}",
                                 'time': r['tgl_pasang'], 'ts': r['tgl_pasang']})

        logs.sort(key=lambda x: x.get('ts','') or '', reverse=True)
        return jsonify(logs[:limit]), 200
    except Exception as e:
        logging.error(f'[log/aktivitas] {e}')
        return jsonify([]), 200
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════
# BULK — Isolir & Aktifkan Massal
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/bulk-isolir', methods=['POST'])
def bulk_isolir():
    """
    Isolir banyak pelanggan sekaligus dalam 1 koneksi MikroTik.
    Body: { ids: [1,2,3], device_id: 1 }
    """
    data      = request.get_json(silent=True) or {}
    ids       = data.get('ids', [])
    device_id = data.get('device_id')

    if not ids:
        return jsonify({'error': 'Tidak ada pelanggan yang dipilih'}), 400
    if not device_id:
        return jsonify({'error': 'device_id wajib diisi'}), 400

    device = cari_device(int(device_id))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan'}), 404

    results = []
    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()
            from librouteros.query import Key

            # Tentukan profil isolir sekali saja (buat kalau belum ada)
            profil_isolir = _resolve_isolir_profile(mt, data)

            # Ambil semua sesi aktif sekaligus
            active_map = {}
            try:
                for r in api.path('/ppp/active').select(Key('.id'), Key('name')):
                    active_map[(r.get('name') or '').lower()] = r['.id']
            except Exception:
                pass

            for pel_id in ids:
                conn = get_db()
                row  = conn.execute(
                    'SELECT id, username, profil FROM pelanggan WHERE id = ?', (pel_id,)
                ).fetchone()
                conn.close()
                if not row:
                    results.append({'id': pel_id, 'status': 'not_found'})
                    continue

                username    = row['username']
                profil_lama = row['profil'] or 'default'

                if 'isolir' in profil_lama.lower():
                    results.append({'id': pel_id, 'username': username, 'status': 'already_isolir'})
                    continue

                try:
                    mt.edit_secret(username, {'profile': profil_isolir})
                    aid = active_map.get(username.lower())
                    if aid:
                        try: api.path('/ppp/active').remove(aid)
                        except Exception: pass

                    conn = get_db()
                    conn.execute(
                        'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = ? WHERE id = ?',
                        (profil_isolir, profil_lama, pel_id)
                    )
                    conn.commit()
                    conn.close()
                    results.append({'id': pel_id, 'username': username, 'status': 'ok'})
                except Exception as e:
                    results.append({'id': pel_id, 'username': username, 'status': 'error', 'message': str(e)})

    except MikroTikError as e:
        return jsonify({'error': f'Koneksi MikroTik gagal: {e}'}), 502

    ok  = sum(1 for r in results if r['status'] == 'ok')
    err = sum(1 for r in results if r['status'] == 'error')
    return jsonify({
        'message': f'{ok} pelanggan diisolir, {err} gagal',
        'results': results,
    }), 200 if err == 0 else 207


@api_bp.route('/pelanggan/bulk-aktifkan', methods=['POST'])
def bulk_aktifkan():
    """
    Aktifkan banyak pelanggan sekaligus (bayar massal).
    Body: { ids: [1,2,3], device_id: 1 }
    """
    data      = request.get_json(silent=True) or {}
    ids       = data.get('ids', [])
    device_id = data.get('device_id')

    if not ids:
        return jsonify({'error': 'Tidak ada pelanggan yang dipilih'}), 400
    if not device_id:
        return jsonify({'error': 'device_id wajib diisi'}), 400

    device = cari_device(int(device_id))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan'}), 404

    results = []
    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()
            from librouteros.query import Key

            for pel_id in ids:
                conn = get_db()
                row  = conn.execute(
                    'SELECT id, username, profil, profil_sebelum_isolir FROM pelanggan WHERE id = ?',
                    (pel_id,)
                ).fetchone()
                conn.close()
                if not row:
                    results.append({'id': pel_id, 'status': 'not_found'})
                    continue

                username       = row['username']
                profil_restore = row['profil_sebelum_isolir'] or ''

                if not profil_restore or 'isolir' in profil_restore.lower():
                    results.append({
                        'id': pel_id, 'username': username, 'status': 'error',
                        'message': 'Profil sebelum isolir tidak ditemukan',
                    })
                    continue

                try:
                    mt.edit_secret(username, {'profile': profil_restore, 'disabled': 'no'})
                    try:
                        active = next(
                            (r for r in api.path('/ppp/active').select(Key('.id'), Key('name'))
                             if r.get('name') == username), None)
                        if active:
                            api.path('/ppp/active').remove(active['.id'])
                    except Exception:
                        pass

                    conn = get_db()
                    conn.execute(
                        'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = NULL WHERE id = ?',
                        (profil_restore, pel_id)
                    )
                    conn.commit()
                    conn.close()
                    results.append({'id': pel_id, 'username': username, 'status': 'ok', 'profil': profil_restore})
                except Exception as e:
                    results.append({'id': pel_id, 'username': username, 'status': 'error', 'message': str(e)})

    except MikroTikError as e:
        return jsonify({'error': f'Koneksi MikroTik gagal: {e}'}), 502

    ok  = sum(1 for r in results if r['status'] == 'ok')
    err = sum(1 for r in results if r['status'] == 'error')
    return jsonify({
        'message': f'{ok} pelanggan diaktifkan, {err} gagal',
        'results': results,
    }), 200 if err == 0 else 207