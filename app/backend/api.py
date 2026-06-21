"""
api.py — TechnoFix-Bill Backend
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
import time
from datetime import datetime, date, timedelta
import calendar

from flask import Blueprint, jsonify, request, g, Response

# ── Shared helpers ────────────────────────────────────────────
from utils import get_db, get_onu_data, catat_aktivitas

# ── MikroTik client ───────────────────────────────────────────
from mikrotik import MikroTikClient, MikroTikError, REMOTE_ONU_COMMENT

# ── Scrapli untuk RX/TX real-time dari OLT (opsional) ────────
try:
    from scrapli.driver.generic import GenericDriver
    SCRAPLI_OK = True
except ImportError:
    SCRAPLI_OK = False

# ── Blueprint ─────────────────────────────────────────────────
# [SATU DEFINISI — duplikat di baris ~1389 asli dihapus]
api_bp = Blueprint('api', __name__)


# ── Cache singkat (TTL) untuk data live MikroTik ────────────────
# GET /pelanggan/<id> & /rx-tx connect langsung ke router setiap
# kali dipanggil (1-5 detik untuk ratusan secret). Cache in-memory
# dengan TTL pendek bikin load berikutnya nyaris instan, dengan
# data "telat" maks beberapa detik — cukup untuk status pelanggan.
_PELANGGAN_CACHE     = {}   # (network_id, device_id[, 'rxtx']) -> (timestamp, data)
_PELANGGAN_CACHE_TTL = 15   # detik


def _filter_kolektor(hasil, current):
    """Filter daftar pelanggan agar kolektor hanya melihat yang ditugaskan ke dia."""
    if current and current.get('role') == 'kolektor':
        kol_usr = current.get('username', '')
        return [p for p in hasil if (p.get('kolektor') or '') == kol_usr]
    return hasil


def _invalidate_pelanggan_cache(network_id=None):
    """Hapus cache pelanggan/rx-tx milik network_id (atau semua jika None)."""
    if network_id is None:
        _PELANGGAN_CACHE.clear()
        return
    for key in list(_PELANGGAN_CACHE.keys()):
        if key[0] == network_id:
            del _PELANGGAN_CACHE[key]


@api_bp.after_request
def _invalidate_cache_on_write(resp):
    """Setiap perubahan data pelanggan (POST/PUT/DELETE/PATCH) langsung
    membersihkan cache supaya load berikutnya tidak menampilkan data basi."""
    if request.method in ('POST', 'PUT', 'DELETE', 'PATCH') and '/pelanggan' in request.path:
        nid = getattr(g, 'network_id', None)
        if nid:
            _invalidate_pelanggan_cache(nid)
    return resp


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
    elif p.endswith('/credentials') or p.endswith('/cli-preview'):
        # Password PPPoE asli & script registrasi OLT — sensitif, kolektor
        # (yang hanya punya 'pelanggan'+'bayar') TIDAK boleh akses.
        perm = 'pelanggan_manage'
    elif p.endswith('/bayar') or p.endswith('/enable') or p.endswith('/isolir') or p.endswith('/disable'):
        perm = 'bayar'                             # aksi pembayaran/aktivasi (kolektor boleh)
    elif p.startswith('/api/profile/'):
        # PPP Profile MikroTik: lihat butuh 'perangkat', tambah/edit/hapus/harga
        # butuh 'perangkat_manage' (kolektor TIDAK boleh sentuh konfigurasi perangkat)
        perm = 'perangkat_manage' if method in ('POST', 'PUT', 'PATCH', 'DELETE') else 'perangkat'
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




def _validasi_hp_ringan(hp: str) -> str | None:
    """Validasi ringan nomor HP — TOLAK yang jelas sampah, TIDAK reformat
    nilai yang valid (format simpan dibiarkan apa adanya, krn tabel
    pelanggan & tel: link menampilkan nilai mentah, sementara titik kirim
    WA/klik-hubungi sudah masing2 normalize sendiri saat dipakai).
    Return pesan error kalau invalid, None kalau OK/kosong (opsional)."""
    if not hp:
        return None
    digit_count = sum(1 for ch in hp if ch.isdigit())
    if digit_count == 0:
        return 'Nomor HP harus berisi angka'
    if digit_count < 8 or digit_count > 15:
        return 'Nomor HP tidak valid (panjang tidak wajar)'
    return None


def _validasi_sn_ringan(sn: str) -> str | None:
    """Validasi ringan SN ONU — format beda2 per vendor (ZTE/Huawei/dst),
    jadi TIDAK dipaksa 1 pola regex. Cukup tolak yang jelas bukan SN asli:
    terlalu pendek, terlalu panjang, atau ada karakter markup/kontrol."""
    if not sn:
        return None
    if len(sn) < 4 or len(sn) > 64:
        return 'SN ONU tidak valid (panjang tidak wajar)'
    if any(ch in sn for ch in '<>{}'):
        return 'SN ONU tidak boleh mengandung karakter <, >, {, }'
    return None


def _validasi_koordinat_ringan(koordinat: str) -> str | None:
    """Validasi ringan koordinat GPS — format 'lat,lng' (sesuai cara
    Maps/pelanggan.js mem-parsing). Tolak yang jelas bukan koordinat,
    TIDAK reformat (presisi/jumlah desimal dibiarkan apa adanya)."""
    if not koordinat:
        return None
    parts = koordinat.replace(';', ',').split(',')
    if len(parts) != 2:
        return 'Koordinat harus format "lat,lng" (mis. -7.123,112.456)'
    try:
        lat, lng = float(parts[0].strip()), float(parts[1].strip())
    except ValueError:
        return 'Koordinat harus berupa angka desimal "lat,lng"'
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return 'Koordinat di luar rentang valid (lat -90..90, lng -180..180)'
    return None


def cari_device(device_id: int) -> dict | None:
    """Cari device di tabel 'devices' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password, koordinat, public_ip, remote_onu_ip, remote_onu_port, remote_onu_comment FROM devices WHERE id = ?',
        (device_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def cari_olt(olt_id: int) -> dict | None:
    """Cari OLT di tabel 'olt' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password, tipe, onu_type_keyword FROM olt WHERE id = ?',
        (olt_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# ══════════════════════════════════════════════════════════════
# HELPER — CLI Builder + Pengirim ke OLT (dipakai bersama oleh
#          /provision DAN tambah_pelanggan agar konsisten)
# ══════════════════════════════════════════════════════════════

def _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password, tcont_profile=None, onu_type_keyword='ALL'):
    """
    Bangun daftar perintah CLI registrasi ONU untuk OLT.

    Identik dengan yang ditampilkan di detail_pelanggan (Script CLI OLT).
    Password memakai password PPPoE ASLI (bukan potongan SN).

    PENTING — beda 2 jenis "profil":
      - profil         : nama profil PPPoE di MikroTik (cth: "100RB") — TIDAK dipakai di OLT
      - tcont_profile  : nama TCONT/bandwidth profile yang SUDAH ADA di OLT
                         (cth: "100M", "TCONT_100M"). Inilah yang dipakai di
                         perintah `tcont 1 profile <X>`.

      Pengisian otomatis `tcont_profile` (saat tambah pelanggan baru,
      sebelum ONU disinkron dari OLT) dilakukan oleh `_resolve_tcont_profile`
      — TIDAK dengan menebak dari nama `profil` (penamaan profil PPPoE di
      MikroTik dan TCONT profile di OLT memang konvensinya berbeda).

    Return: list[str] perintah CLI
    """
    parts     = (slot_port or '').split(':')
    gpon_path = parts[0] if parts else slot_port
    onu_id    = parts[1] if len(parts) > 1 else '1'
    vlan_val  = vlan or '200'
    pwd       = password or ''   # password PPPoE asli
    # TCONT profile di OLT — kalau masih kosong di sini berarti belum ada
    # riwayat ONU lain yang cocok (lihat _resolve_tcont_profile); pakai
    # 'default' sebagai pilihan teraman (hampir semua OLT punya profile ini).
    tcont     = (tcont_profile or '').strip() or 'default'
    # Kata kunci tipe ONU — beda firmware/model ZTE pakai "ALL-ONT" atau "ALL"
    onu_type  = (onu_type_keyword or 'ALL').strip() or 'ALL'

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
        f'onu {onu_id} type {onu_type} sn {sn} vport-mode gemport',
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


def _build_olt_remove_cli(cli_type, slot_port, onu_type_keyword='ALL'):
    """
    Kebalikan dari _build_olt_cli — lepas/hapus registrasi ONU dari OLT.
    Dipakai saat hapus pelanggan dengan target "OLT" dicentang.

    Return: list[str] perintah CLI
    """
    parts     = (slot_port or '').split(':')
    gpon_path = parts[0] if parts else slot_port
    onu_id    = parts[1] if len(parts) > 1 else '1'

    if 'huawei' in (cli_type or '').lower():
        return [
            'enable',
            'config',
            f'interface gpon 0/{gpon_path}',
            f'ont delete {onu_id}',
            'quit',
            'save',
        ]

    if any(k in (cli_type or '').lower() for k in ('epon', 'hsgq', 'e04', 'e08')):
        epon_parts = (slot_port or '1/1').split('/')
        epon_port  = epon_parts[0] if epon_parts else '1'
        epon_onu   = epon_parts[1] if len(epon_parts) > 1 else '1'
        return [
            'enable',
            'configure',
            f'interface epon {epon_port}',
            f'no onu {epon_onu}',
            'exit',
            'write',
        ]

    # ZTE (default)
    return [
        'con t',
        f'interface gpon-olt_{gpon_path}',
        f'no onu {onu_id}',
        'exit',
        'end',
        'wr',
    ]


def _resolve_tcont_profile(olt_id, profil) -> str:
    """
    Tebak otomatis nama TCONT profile di OLT untuk pelanggan baru, TANPA
    dropdown manual dan TANPA asumsi penamaan (nama profil PPPoE di MikroTik
    vs nama TCONT profile di OLT memang konvensinya beda-beda per ISP/OLT).

    Caranya: lihat riwayat pelanggan LAIN di OLT yang sama dengan paket
    PPPoE (`profil`) yang sama, lalu pakai `tcont_profile` yang paling
    sering dipakai mereka. Nilai itu berasal dari kolom `onu_mapping.tcont_profile`
    yang diisi oleh `olt_sync.py` langsung dari config ASLI di OLT — jadi
    bukan tebakan, melainkan data nyata yang sudah terbukti benar.

    Kalau belum ada riwayat (paket/OLT kombinasi baru), kembalikan '' —
    `_build_olt_cli` akan pakai 'default' sebagai fallback teraman, dan
    sinkronisasi OLT berikutnya akan mengoreksi `tcont_profile` di
    `onu_mapping` begitu ONU pelanggan ini terdeteksi di OLT.
    """
    olt_id = olt_id or None
    profil = (profil or '').strip()
    if not olt_id or not profil:
        return ''
    try:
        conn = get_db()
        row = conn.execute('''
            SELECT om.tcont_profile, COUNT(*) AS cnt
              FROM onu_mapping om
              JOIN pelanggan p ON p.username = om.username
             WHERE om.olt_id = ? AND p.profil = ?
               AND om.tcont_profile IS NOT NULL AND TRIM(om.tcont_profile) != ''
             GROUP BY om.tcont_profile
             ORDER BY cnt DESC
             LIMIT 1
        ''', (olt_id, profil)).fetchone()
        conn.close()
        if row and row['tcont_profile']:
            return str(row['tcont_profile']).strip()
    except Exception as e:
        logging.warning(f'[tcont-resolve] gagal cari riwayat profil="{profil}" olt_id={olt_id}: {e}')
    return ''


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
        # Pola pesan penolakan umum di CLI OLT (ZTE/Huawei/EPON) — kalau OLT
        # menolak satu perintah (mis. "type ALL-ONT" tidak dikenali firmware),
        # ia membalas pesan ini, BUKAN exception — harus dideteksi manual,
        # supaya sistem tidak melapor "berhasil" padahal OLT menolak.
        _err_patterns = (
            'invalid input', 'unrecognized command', 'incomplete command',
            'ambiguous command', 'unknown command', 'syntax error',
            'error:', '% error', 'failure', 'command not found',
            'not support',
        )
        # Perintah ZTE/V-Sol/generic (default _build_olt_cli) diawali 'con t'
        # dan ASUMSI sudah di mode privileged ('#'). Sebagian OLT (C300/C600/
        # V-Sol) login langsung ke user mode ('>') dan butuh 'enable' + password
        # dulu — kalau tidak, 'con t' ditolak ("Invalid input"). OLT lain (C320,
        # dsb) sudah langsung '#' setelah login. Deteksi & masuk privileged mode
        # dulu pakai helper yang sama dengan worker sync (_enter_privileged_zte),
        # supaya kedua kondisi sama-sama jalan tanpa perlu pilih manual.
        tipe_olt = (olt.get('tipe') or '').lower()
        is_zte_like = not any(k in tipe_olt for k in ('huawei', 'epon', 'hsgq', 'e04', 'e08'))

        outputs   = []
        rejected  = []
        with GenericDriver(**device_cfg) as conn:
            if is_zte_like:
                try:
                    from olt_sync import _enter_privileged_zte
                    _enter_privileged_zte(conn, dict(olt))
                except Exception:
                    pass

            for cmd in commands:
                r = conn.send_command(cmd)
                outputs.append(r.result)
                low = (r.result or '').lower()
                if any(p in low for p in _err_patterns):
                    rejected.append((cmd, r.result.strip().splitlines()[-1] if r.result.strip() else ''))

        full_output = '\n'.join(outputs)
        if rejected:
            cmd, pesan = rejected[0]
            return False, (f'OLT menolak perintah "{cmd}" — {pesan or "lihat detail output"} '
                           f'(kemungkinan sintaks tidak cocok dengan firmware/model OLT ini)'), full_output

        return True, 'Registrasi ONU berhasil dikirim ke OLT', full_output
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
        onu = get_onu_data(username, conn)
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
            'is_prioritas':    int(row['is_prioritas'] or 0) if 'is_prioritas' in row.keys() else 0,
            'catatan_khusus':  row['catatan_khusus'] if 'catatan_khusus' in row.keys() else '',
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

    # ── Cache hit: skip MikroTik & langsung balas (data maks ~15 detik) ──
    cache_key = (g.network_id, device_id)
    cached = _PELANGGAN_CACHE.get(cache_key)
    if cached and (time.time() - cached[0]) < _PELANGGAN_CACHE_TTL:
        resp = jsonify(_filter_kolektor(cached[1], current))
        resp.headers['X-Cache'] = 'HIT'
        return resp, 200

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

            onu = get_onu_data(username, conn)

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
            except Exception:
                pass

            # 3. TARIK KEMBALI DATA RESMI SETELAH SINKRONISASI
            row_lokal = conn.execute(
                'SELECT id, username, nama, password, profil, no_hp, hp, service, aktif, tgl_pasang, tgl_jatuh, titik_koordinat, kolektor, odp_id, port_odp, is_prioritas, catatan_khusus FROM pelanggan WHERE username = ?',
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
                'kolektor':       row_lokal['kolektor'] if row_lokal else '',
                'odp_id':         row_lokal['odp_id'] if row_lokal else None,
                'port_odp':       row_lokal['port_odp'] if row_lokal else None,
                'is_prioritas':   int(row_lokal['is_prioritas'] or 0) if row_lokal else 0,
                'catatan_khusus': row_lokal['catatan_khusus'] if row_lokal else '',
                'harga':          _harga_dari_profil(conn, device_id, s.get('profile', '')),
                'rx_power':       onu['rx_power'],
                'tx_power':       onu['tx_power'],
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
            except Exception as upsert_err:
                logging.warning(f'[get_pelanggan] Auto-save gagal untuk {username}: {upsert_err}')

        # ── Commit sekali untuk semua perubahan loop di atas ──
        # (sebelumnya commit per-pelanggan = banyak fsync untuk N pelanggan)
        conn.commit()
        conn.close()

        # Simpan ke cache (sebelum filter kolektor, agar bisa dipakai semua peran)
        _PELANGGAN_CACHE[cache_key] = (time.time(), hasil)

        return jsonify(_filter_kolektor(hasil, current)), 200

    except MikroTikError as e:
        # Koneksi ke MikroTik gagal (mis. perangkat mati lampu / tak terjangkau).
        # Jangan biarkan halaman gagal total — sajikan data terakhir dari DB
        # lokal, tapi status semua pelanggan dipaksa "Offline" karena status
        # realtime tidak bisa dipastikan tanpa sesi PPPoE aktif dari MikroTik.
        logging.warning(f'[get_pelanggan] Koneksi MikroTik gagal (device #{device_id}): {e}')
        try:
            kolektor_filter = (current.get('username')
                               if (current and current.get('role') == 'kolektor') else None)
            hasil = _get_pelanggan_dari_db(device_id, kolektor_filter)
            for p in hasil:
                p['status'] = 'Offline'
            resp = jsonify(hasil)
            resp.headers['X-Mikrotik-Connected'] = '0'
            resp.headers['X-Fallback-Reason'] = str(e)
            return resp, 200
        except Exception as fallback_err:
            logging.error(f'[get_pelanggan] Fallback DB lokal gagal juga: {fallback_err}')
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
    if not tcont_profile and olt_id:
        # Belum diisi manual → tebak otomatis dari riwayat ONU lain dengan
        # paket sama di OLT yang sama (lihat _resolve_tcont_profile)
        tcont_profile = _resolve_tcont_profile(olt_id, profil)
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
    hp_err = _validasi_hp_ringan(hp)
    if hp_err:
        return jsonify({'error': hp_err}), 400
    sn_err = _validasi_sn_ringan(sn)
    if sn_err:
        return jsonify({'error': sn_err}), 400
    koor_err = _validasi_koordinat_ringan(koordinat)
    if koor_err:
        return jsonify({'error': koor_err}), 400
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

    try:
        device_id = int(device_id)
    except (ValueError, TypeError):
        return jsonify({'error': 'ID perangkat tidak valid'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    # Target operasi (checklist Billing/MikroTik/OLT di form Tambah Pelanggan)
    # — Billing selalu jalan (record utama); MikroTik & OLT bisa dilewati
    # kalau pengguna belum mau push ke sana sekarang.
    targets = [str(t).strip().lower() for t in (body.get('targets') or ['billing', 'mikrotik', 'olt']) if str(t).strip()]
    do_mikrotik = 'mikrotik' in targets
    do_olt      = 'olt' in targets

    steps    = {}
    warnings = []

    # ── 1. Tambah PPP Secret ke MikroTik ──────────────────
    if do_mikrotik:
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
    else:
        steps['mikrotik'] = 'skipped'

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
        # Auto-update port_terpakai ODP jika pelanggan pilih port
        if odp_id:
            try:
                from odp import _update_odp_usage_from_children
                _update_odp_usage_from_children(odp_id)
            except Exception:
                pass
    except Exception as e:
        warnings.append(f'DB lokal: {e}')
        steps['database'] = 'warning'

    # ── 3. Update onu_mapping jika ada data ONU (target OLT dicentang) ──
    if do_olt and olt_id and (sn or slot_port):
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

    # ── 4. Provisioning ONU ke OLT (otomatis, kalau target OLT dicentang) ──
    # Hanya jalan jika data OLT lengkap (olt_id + sn + slot_port).
    # Pakai helper _build_olt_cli yang sama dengan endpoint /provision,
    # dengan password PPPoE ASLI pelanggan.
    if not do_olt:
        steps['olt'] = 'skipped'
    elif olt_id and sn and slot_port:
        try:
            olt = cari_olt(int(olt_id))
        except (TypeError, ValueError):
            olt = None
        if olt:
            tipe_olt = (olt.get('tipe') or '').lower()
            if 'huawei' in tipe_olt:
                cli_type = 'huawei'
            elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
                cli_type = 'epon'
            else:
                cli_type = 'zte'
            commands = _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password, tcont_profile,
                                      onu_type_keyword=olt.get('onu_type_keyword') or 'ALL')
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

    catat_aktivitas('pelanggan', 'tambah', target=username,
                    pesan=f'Pelanggan baru: {nama} ({username}) — profil {profil}')

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
    Edit pelanggan — target ditentukan checklist Billing/MikroTik/OLT (sama
    seperti modal hapus, frontend kirim `targets`):
      1. Update data lokal di DB — selalu jalan (record utama / Billing)
      2. Update PPP Secret di MikroTik (kalau target 'mikrotik' dicentang)
      3. Sinkronkan onu_mapping + (kalau SN/slot-port/VLAN/OLT berubah —
         mis. ganti modem atau pindah jalur ONU) kirim ulang CLI registrasi
         ke OLT supaya konfigurasi fisik ikut sinkron dengan sistem
         (kalau target 'olt' dicentang)
    """
    try:
        body     = request.get_json() or {}
        username = str(body.get('username') or '').strip()
        hp       = body.get('hp', '') or body.get('no_hp', '') or ''
        nama     = body.get('nama', '') or body.get('name', '') or ''
        password = str(body.get('password') or '').strip()   # ← BARU: password bisa diupdate
        profil   = str(body.get('profil', '') or '').strip()
        device_id = body.get('device_id')

        targets = [str(t).strip().lower() for t in (body.get('targets') or ['billing', 'mikrotik', 'olt']) if str(t).strip()]
        do_mikrotik = 'mikrotik' in targets
        do_olt      = 'olt' in targets

        if not username:
            return jsonify({'error': 'Username tidak boleh kosong'}), 400
        hp_err = _validasi_hp_ringan(hp)
        if hp_err:
            return jsonify({'error': hp_err}), 400

        conn = get_db()
 
        koordinat  = str(body.get('titik_koordinat', '') or body.get('koordinat', '') or '').strip()
        tgl_pasang = str(body.get('tgl_pasang', '') or '').strip()
        tgl_jatuh  = str(body.get('tgl_jatuh',  '') or '').strip()
        slot_port  = str(body.get('slot_port',   '') or '').strip()
        vlan       = str(body.get('vlan',        '') or '').strip()
        sn         = str(body.get('sn',          '') or '').strip()
        olt_id     = body.get('olt_id')
        kolektor      = str(body.get('kolektor', '') or '').strip()
        is_prioritas  = 1 if body.get('is_prioritas') else 0
        catatan_khusus = str(body.get('catatan_khusus', '') or '').strip()
        sn_err = _validasi_sn_ringan(sn)
        if sn_err:
            conn.close()
            return jsonify({'error': sn_err}), 400
        koor_err = _validasi_koordinat_ringan(koordinat)
        if koor_err:
            conn.close()
            return jsonify({'error': koor_err}), 400

        odp_id_upd = body.get('odp_id') or None
        if odp_id_upd is not None:
            try: odp_id_upd = int(odp_id_upd)
            except (TypeError, ValueError): odp_id_upd = None
        port_odp_upd = body.get('port_odp') or None
        if port_odp_upd is not None:
            try: port_odp_upd = int(port_odp_upd)
            except (TypeError, ValueError): port_odp_upd = None

        # 1. Cari baris yang akan diedit BERDASARKAN ID dari URL — bukan
        # username dari body. Mencari via username keliru: kalau staff
        # mengubah/mengoreksi username pelanggan, pencarian by-username-baru
        # tidak akan menemukan baris lama, sehingga kode lama membuat baris
        # BARU (tanpa device_id) dan baris lama jadi yatim → data ganda di
        # peta, marker offline tanpa redaman, hapus pelanggan tidak tuntas.
        try:
            id_int = int(id_pelanggan)
        except (TypeError, ValueError):
            return jsonify({'error': 'ID pelanggan tidak valid'}), 400

        user_lokal = conn.execute(
            'SELECT id, username, password, profil, slot_port_onu, vlan, sn, device_id, odp_id FROM pelanggan WHERE id = ?', (id_int,)
        ).fetchone()
        if not user_lokal:
            conn.close()
            return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

        old_device_id = user_lokal['device_id']
        old_odp_id   = user_lokal['odp_id']
        old_username = user_lokal['username'] or ''
        old_slot     = user_lokal['slot_port_onu'] or ''
        old_vlan     = user_lokal['vlan'] or ''
        old_sn       = user_lokal['sn'] or ''
        old_profil   = user_lokal['profil'] or ''

        old_mapping = conn.execute(
            'SELECT olt_id, tcont_profile FROM onu_mapping WHERE username = ?', (old_username,)
        ).fetchone()
        old_olt_id = old_mapping['olt_id'] if old_mapping else None
        old_tcont  = (old_mapping['tcont_profile'] if old_mapping else '') or ''

        # Password: pakai yang baru jika dikirim, fallback ke yang sudah ada di DB
        password_db = password if password else (user_lokal['password'] or '')
        effective_profil = profil if profil else old_profil

        # device_id ikut di-update kalau dikirim & valid — sebelumnya kolom ini
        # tidak pernah ditulis ulang saat edit, sehingga memindahkan pelanggan
        # ke MikroTik lain di form edit tidak benar-benar memindahkan record-nya
        # (data lokal tetap menunjuk perangkat lama, secret lama jadi yatim).
        try:
            device_id_db = int(device_id) if device_id else old_device_id
        except (TypeError, ValueError):
            device_id_db = old_device_id

        conn.execute('''
            UPDATE pelanggan
            SET username=?, hp=?, no_hp=?, nama=?, password=?, device_id=?,
                slot_port_onu=?, vlan=?, sn=?,
                titik_koordinat=?, tgl_pasang=?, tgl_jatuh=?,
                kolektor=?, odp_id=?, port_odp=?,
                is_prioritas=?, catatan_khusus=?,
                profil=CASE WHEN ? != '' THEN ? ELSE profil END
            WHERE id=?
        ''', (
            username, hp, hp, nama, password_db, device_id_db,
            slot_port, vlan, sn,
            koordinat, tgl_pasang, tgl_jatuh,
            kolektor, odp_id_upd, port_odp_upd,
            is_prioritas, catatan_khusus,
            profil, profil,
            id_int
        ))

        conn.commit()
        conn.close()

        # Auto-update port_terpakai ODP lama & baru jika pelanggan pindah/lepas ODP
        if old_odp_id != odp_id_upd:
            try:
                from odp import _update_odp_usage_from_children
                if old_odp_id: _update_odp_usage_from_children(old_odp_id)
                if odp_id_upd: _update_odp_usage_from_children(odp_id_upd)
            except Exception:
                pass

        steps    = {'billing': 'success'}
        warnings = []

        # 2. Update ke MikroTik — hanya kalau target 'mikrotik' dicentang
        mikrotik_updated = False
        pindah_perangkat = bool(
            do_mikrotik and device_id and old_device_id and
            int(device_id) != int(old_device_id)
        )
        if do_mikrotik and device_id:
            device = cari_device(int(device_id))
            if device:
                if pindah_perangkat:
                    # ── Pelanggan dipindah ke MikroTik lain ──
                    # Secret lama HARUS dihapus dari perangkat lama, baru dibuat
                    # di perangkat baru — kalau tidak, secret lama jadi yatim di
                    # router lama dan akan ditarik ulang oleh sinkron berikutnya
                    # (terlihat seolah "secret lama muncul lagi").
                    device_lama = cari_device(int(old_device_id))
                    if device_lama and old_username:
                        try:
                            with MikroTikClient(device_lama) as mt_lama:
                                mt_lama.hapus_secret(old_username)
                        except MikroTikError as e:
                            warnings.append(f'MikroTik (perangkat lama): gagal hapus secret lama — {e}')
                    try:
                        with MikroTikClient(device) as mt:
                            mt.tambah_secret({
                                'name':     username,
                                'password': password_db,
                                'profile':  effective_profil or 'default',
                                'service':  'pppoe',
                                'comment':  nama or username,
                            })
                        mikrotik_updated = True
                        steps['mikrotik'] = 'success'
                    except MikroTikError as e:
                        steps['mikrotik'] = 'warning'
                        warnings.append(f'MikroTik: gagal pindahkan secret ke perangkat baru — {e}')
                else:
                    update_mt = {}
                    if password:
                        update_mt['password'] = password
                    if profil:
                        update_mt['profile'] = profil
                    if nama:
                        update_mt['comment'] = nama
                    # Username diubah → ikut rename PPP Secret di MikroTik agar
                    # tidak jadi tidak sinkron (DB pakai nama baru, MikroTik nama lama)
                    if username != old_username:
                        update_mt['name'] = username

                    if update_mt:
                        # Field yang butuh sesi aktif diputus supaya berlaku —
                        # MikroTik TIDAK menerapkan password/profile/name baru ke
                        # koneksi yang sedang jalan; modem harus reconnect dulu.
                        perlu_putus_sesi = any(k in update_mt for k in ('password', 'profile', 'name'))
                        try:
                            with MikroTikClient(device) as mt:
                                mt.edit_secret(old_username or username, update_mt)
                                if perlu_putus_sesi:
                                    try:
                                        from librouteros.query import Key
                                        api = mt._get_api()
                                        active_path = api.path('/ppp/active')
                                        active = next(
                                            (r for r in active_path.select(Key('.id'), Key('name'))
                                             if r.get('name') == old_username),
                                            None
                                        )
                                        if active:
                                            active_path.remove(active['.id'])
                                    except Exception:
                                        pass
                            mikrotik_updated = True
                            steps['mikrotik'] = 'success'
                        except MikroTikError as e:
                            steps['mikrotik'] = 'warning'
                            warnings.append(f'MikroTik: {e}')
                        except Exception as e:
                            steps['mikrotik'] = 'warning'
                            warnings.append(f'MikroTik: {e}')
                    else:
                        steps['mikrotik'] = 'skipped'
            else:
                steps['mikrotik'] = 'warning'
                warnings.append('MikroTik: perangkat tidak ditemukan')
        else:
            steps['mikrotik'] = 'skipped'

        # 3. Sinkronkan onu_mapping + push CLI ke OLT — hanya kalau target 'olt' dicentang
        if do_olt and olt_id and (sn or slot_port):
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
            except Exception as e:
                warnings.append(f'ONU mapping: {e}')

            # Modem diganti / pindah jalur ONU / ganti VLAN / pindah OLT →
            # konfigurasi fisik di OLT jadi basi kalau cuma diubah di sini.
            # Deteksi perubahan & kirim ulang CLI registrasi otomatis supaya
            # OLT ikut sinkron — pakai helper yang sama dengan /provision.
            data_lengkap = bool(sn and slot_port)
            berubah = (
                str(olt_id) != str(old_olt_id or '') or
                slot_port != old_slot or
                vlan      != old_vlan or
                sn        != old_sn
            )
            if data_lengkap and berubah:
                try:
                    olt = cari_olt(int(olt_id))
                except (TypeError, ValueError):
                    olt = None
                if olt:
                    tipe_olt = (olt.get('tipe') or '').lower()
                    if 'huawei' in tipe_olt:
                        cli_type = 'huawei'
                    elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
                        cli_type = 'epon'
                    else:
                        cli_type = 'zte'
                    commands = _build_olt_cli(cli_type, slot_port, vlan, sn, username,
                                              effective_profil, password_db, old_tcont,
                                              onu_type_keyword=olt.get('onu_type_keyword') or 'ALL')
                    ok, msg, _out = _kirim_olt_cli(olt, commands)
                    steps['olt'] = 'success' if ok else 'warning'
                    if not ok:
                        warnings.append(f'OLT: {msg}')
                else:
                    steps['olt'] = 'warning'
                    warnings.append('OLT: perangkat tidak ditemukan — perubahan tidak dikirim ke OLT')
            else:
                steps['olt'] = 'success'
        else:
            steps['olt'] = 'skipped'

        catat_aktivitas('pelanggan', 'edit', target=username,
                        pesan=f'Edit pelanggan: {nama or username} ({username})')

        resp = {
            'status':           'success',
            'message':          f'Data {username} berhasil diperbarui',
            'mikrotik_updated': mikrotik_updated,
            'steps':            steps,
            'warnings':         warnings,
        }
        if warnings:
            return jsonify(resp), 207

        return jsonify(resp), 200

    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': f'Gagal menyimpan data: {str(e)}'}), 500
    
@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['DELETE'])
def delete_pelanggan(pelanggan_id):
    """
    Hapus pelanggan — target ditentukan checklist di modal hapus (frontend
    kirim `targets`: kombinasi 'billing' / 'mikrotik' / 'olt').

    Body JSON:
    {
        "device_id": 1, "username": "...", "targets": ["billing","mikrotik","olt"],
        "olt_id": 1, "slot_port": "0/1/1:3"
    }
    """
    body      = request.get_json(silent=True) or {}
    device_id = body.get('device_id')
    username  = (body.get('username') or '').strip()
    olt_id    = body.get('olt_id')
    slot_port = (body.get('slot_port') or '').strip()
    targets   = [str(t).strip().lower() for t in (body.get('targets') or ['billing']) if str(t).strip()]

    if not username:
        return jsonify({'error': 'username wajib'}), 400
    if not targets:
        return jsonify({'error': 'Pilih minimal satu target penghapusan'}), 400

    steps    = {}
    warnings = []

    # ── MikroTik: hapus PPP Secret + putus sesi aktif ──
    if 'mikrotik' in targets:
        device = cari_device(device_id) if device_id else None
        if not device:
            steps['mikrotik'] = 'warning'
            warnings.append('MikroTik: perangkat tidak ditemukan — secret tidak dihapus')
        else:
            try:
                with MikroTikClient(device) as mt:
                    mt.hapus_secret(username)
                    # Putus sesi aktif juga — tanpa ini, modem yang sedang online
                    # tetap nyangkut di /ppp/active sampai timeout meski secret-nya
                    # sudah tidak ada (sama seperti pola di isolir/bayar/reboot)
                    try:
                        from librouteros.query import Key
                        api = mt._get_api()
                        active_path = api.path('/ppp/active')
                        active = next(
                            (r for r in active_path.select(Key('.id'), Key('name'))
                             if r.get('name') == username),
                            None
                        )
                        if active:
                            active_path.remove(active['.id'])
                    except Exception:
                        pass
                steps['mikrotik'] = 'success'
            except MikroTikError as e:
                steps['mikrotik'] = 'warning'
                warnings.append(f'MikroTik: {e}')
            except Exception as e:
                steps['mikrotik'] = 'warning'
                warnings.append(f'MikroTik: {e}')

    # ── OLT: lepas registrasi ONU via SSH + bersihkan cache onu_mapping ──
    if 'olt' in targets:
        if not olt_id or not slot_port:
            steps['olt'] = 'skipped'
            warnings.append('OLT: data olt_id/slot_port tidak tersedia — pelepasan ONU dilewati')
        else:
            try:
                olt = cari_olt(int(olt_id))
            except (TypeError, ValueError):
                olt = None
            if not olt:
                steps['olt'] = 'warning'
                warnings.append('OLT: perangkat tidak ditemukan')
            else:
                tipe_olt = (olt.get('tipe') or '').lower()
                if 'huawei' in tipe_olt:
                    cli_type = 'huawei'
                elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
                    cli_type = 'epon'
                else:
                    cli_type = 'zte'
                commands = _build_olt_remove_cli(cli_type, slot_port,
                                                  onu_type_keyword=olt.get('onu_type_keyword') or 'ALL')
                ok, msg, _out = _kirim_olt_cli(olt, commands)
                steps['olt'] = 'success' if ok else 'warning'
                if not ok:
                    warnings.append(f'OLT: {msg}')

        try:
            conn = get_db()
            conn.execute('DELETE FROM onu_mapping WHERE username = ?', (username,))
            conn.commit()
            conn.close()
        except Exception:
            pass

    # ── Billing: hapus dari DB lokal ──
    if 'billing' in targets:
        try:
            conn = get_db()
            row = conn.execute('SELECT odp_id FROM pelanggan WHERE id = ?', (pelanggan_id,)).fetchone()
            old_odp_id = row['odp_id'] if row else None
            conn.execute('DELETE FROM pelanggan WHERE id = ?', (pelanggan_id,))
            conn.commit()
            conn.close()
            steps['billing'] = 'success'
            # Auto-update port_terpakai ODP setelah pelanggan dihapus
            if old_odp_id:
                try:
                    from odp import _update_odp_usage_from_children
                    _update_odp_usage_from_children(old_odp_id)
                except Exception:
                    pass
        except Exception as e:
            steps['billing'] = 'warning'
            warnings.append(f'Billing: {e}')

    catat_aktivitas('pelanggan', 'hapus', target=username,
                    pesan=f'Hapus pelanggan: {username}')

    resp = {
        'message':  f'{username} — proses hapus selesai',
        'steps':    steps,
        'warnings': warnings,
    }
    return jsonify(resp), 207 if warnings else 200


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

    # ── Cache hit (hanya untuk mode non-realtime) ──
    cache_key = (g.network_id, device_id, 'rxtx')
    if not realtime:
        cached = _PELANGGAN_CACHE.get(cache_key)
        if cached and (time.time() - cached[0]) < _PELANGGAN_CACHE_TTL:
            resp = jsonify(cached[1])
            resp.headers['X-Cache'] = 'HIT'
            return resp, 200

    try:
        with MikroTikClient(device) as mt:
            secrets = mt.get_ppp_secrets()

        hasil = []
        conn = get_db()
        for s in secrets:
            username = str(s.get('name', '') or '')
            if not username:
                continue

            onu      = get_onu_data(username, conn)
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

        conn.commit()
        conn.close()

        if not realtime:
            _PELANGGAN_CACHE[cache_key] = (time.time(), hasil)

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
            parsed = parse_zte_rx(output)
            # Fallback — beberapa firmware ZTE (mis. C320) tidak kenal
            # 'optical-info', tapi punya 'show pon power attenuation'
            # dengan format tabel OLT/ONU/Attenuation.
            if parsed['rx_power'] is None and parsed['tx_power'] is None:
                cmd2    = f'show pon power attenuation gpon-onu_{slot_port}'
                output2 = conn.send_command(cmd2).result
                parsed  = parse_zte_rx(output2)
            return parsed
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


_METRICS_RANGE_HOURS = {'24h': 24, '7d': 24 * 7, '14d': 24 * 14}


@api_bp.route('/pelanggan/<int:pelanggan_id>/metrics-history', methods=['GET'])
def get_pelanggan_metrics_history(pelanggan_id):
    """Riwayat sinyal ONU (RX/TX power + status online) untuk grafik tren.
    Data direkam tiap siklus sync OLT (~5 menit) oleh
    olt_sync._record_onu_metrics_snapshot, retensi 14 hari."""
    conn = get_db()
    pelanggan = conn.execute(
        'SELECT username FROM pelanggan WHERE id = ?', (pelanggan_id,)
    ).fetchone()
    if not pelanggan:
        conn.close()
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    hours  = _METRICS_RANGE_HOURS.get(request.args.get('range', '24h'), 24)
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat(timespec='seconds')
    rows = conn.execute('''
        SELECT rx_power, tx_power, is_online, recorded_at
        FROM onu_metrics_history
        WHERE username = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
    ''', (pelanggan['username'], cutoff)).fetchall()
    conn.close()
    # recorded_at disimpan naive-UTC (server jalan di UTC) — tandai 'Z' eksplisit
    # supaya Date() di browser parse sebagai UTC, bukan dikira sudah waktu lokal.
    out = [dict(r) for r in rows]
    for o in out:
        o['recorded_at'] = o['recorded_at'] + 'Z'
    return jsonify(out)


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
        try:
            dev = cari_device(int(device_id_hint))
        except (TypeError, ValueError):
            dev = None
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
        'SELECT id, name, ip, port, username, password, koordinat, public_ip, remote_onu_ip, remote_onu_port, remote_onu_comment FROM devices'
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
        'SELECT id, username, nama, profil, device_id FROM pelanggan WHERE id = ?',
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
        'SELECT id, name, ip, port, username, password, koordinat, public_ip, remote_onu_ip, remote_onu_port, remote_onu_comment FROM devices'
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
        catat_aktivitas('pelanggan', 'aktifkan', target=username,
                        pesan=f'Aktifkan PPPoE: {username}')
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
        catat_aktivitas('pelanggan', 'nonaktif', target=username,
                        pesan=f'Nonaktifkan PPPoE: {username}')
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
            'comment':     'Auto-created by TechnoFix-Bill untuk isolir pelanggan',
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

            # 1. Update profil ke "Isolir" + tandai status di comment
            #    (supaya kelihatan langsung dari MikroTik siapa yang nunggak)
            from utils import status_secret_comment
            nama_asli = pelanggan['nama'] or username
            mt.edit_secret(username, {
                'profile': profil_isolir,
                'comment': status_secret_comment(nama_asli, 'isolir'),
            })

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

        catat_aktivitas('pelanggan', 'isolir', target=username,
                        pesan=f'Isolir: {username} ({profil_lama} → {profil_isolir})')

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

        catat_aktivitas('keuangan', 'lunas', target=username,
                        pesan=f'Lunas — layanan {username} diaktifkan kembali (profil {profil_restore})')

        return jsonify({
            'message':     f'{username} berhasil diaktifkan kembali. Profil: {profil_restore}',
            'profil_baru': profil_restore,
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>/bandwidth', methods=['GET'])
def get_pelanggan_bandwidth(pelanggan_id):
    """
    Bandwidth realtime per-pelanggan PPPoE.
    Membaca bytes-in / bytes-out dari /ppp/active (sesi aktif PPPoE),
    lalu hitung selisih selama 1 detik untuk mendapat Mbps.
    Response: { rx_mbps, tx_mbps, online, ts }
    """
    import time as _time

    conn = get_db()
    row  = conn.execute('SELECT * FROM pelanggan WHERE id = ?', (pelanggan_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    username  = row['username']
    device_id = row['device_id']
    device    = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()

            def _snap_bytes():
                for r in api.path('/ppp/active'):
                    rd = dict(r)
                    if (rd.get('name') or '').lower() == username.lower():
                        return rd
                return None

            s1 = _snap_bytes()
            if s1 is None:
                return jsonify({'rx_mbps': 0.0, 'tx_mbps': 0.0, 'online': False, 'ts': datetime.now().isoformat()}), 200

            _time.sleep(1)
            s2 = _snap_bytes()
            if s2 is None:
                return jsonify({'rx_mbps': 0.0, 'tx_mbps': 0.0, 'online': False, 'ts': datetime.now().isoformat()}), 200

            rx_mbps = round(max(int(s2.get('bytes-in',  0) or 0) - int(s1.get('bytes-in',  0) or 0), 0) * 8 / 1_000_000, 3)
            tx_mbps = round(max(int(s2.get('bytes-out', 0) or 0) - int(s1.get('bytes-out', 0) or 0), 0) * 8 / 1_000_000, 3)

        return jsonify({'rx_mbps': rx_mbps, 'tx_mbps': tx_mbps, 'online': True, 'ts': datetime.now().isoformat()}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[bw_pelanggan] id={pelanggan_id} user={username}: {e}')
        return jsonify({'error': str(e)}), 500


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


@api_bp.route('/pelanggan/<int:pelanggan_id>/cli-preview', methods=['GET'])
def get_pelanggan_cli_preview(pelanggan_id):
    """
    Generate PREVIEW script CLI registrasi ONU untuk pelanggan ini —
    read-only, TIDAK mengirim apa pun ke OLT.

    Dipakai detail_pelanggan.js sebagai satu-satunya sumber generator script
    (menggantikan _buildCliScript() di frontend yang dulu duplikat dengan
    _build_olt_cli() di sini — supaya perubahan format CLI / keyword tipe ONU
    cukup diubah di satu tempat).

    Query: ?cli_type=zte|huawei|epon (opsional — default ditentukan dari tipe OLT)

    Response: { script, cli_type, olt_name }
    """
    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    onu = get_onu_data(pelanggan['username'])
    olt_id = onu.get('olt_id') if onu else None
    if not olt_id:
        return jsonify({'error': 'Pelanggan belum terhubung ke OLT'}), 404

    try:
        olt = cari_olt(int(olt_id))
    except (TypeError, ValueError):
        olt = None
    if not olt:
        return jsonify({'error': 'Perangkat OLT tidak ditemukan'}), 404

    cli_type = (request.args.get('cli_type') or '').strip().lower()
    if cli_type not in ('zte', 'huawei', 'epon'):
        tipe_olt = (olt.get('tipe') or '').lower()
        if 'huawei' in tipe_olt:
            cli_type = 'huawei'
        elif any(k in tipe_olt for k in ('epon', 'hsgq', 'e04', 'e08')):
            cli_type = 'epon'
        else:
            cli_type = 'zte'

    # Password real — strategi sama seperti /credentials (MikroTik lalu DB)
    password = ''
    if device:
        try:
            with MikroTikClient(device) as mt:
                for s in mt.get_ppp_secrets():
                    if s.get('name') == pelanggan['username']:
                        mt_pwd = str(s.get('password', '') or '').strip()
                        if mt_pwd:
                            password = mt_pwd
                        break
        except MikroTikError as e:
            logging.warning(f'[cli-preview] MikroTik {device["name"]} gagal: {e}')

    if not password:
        conn = get_db()
        row = conn.execute(
            'SELECT password FROM pelanggan WHERE id = ?', (pelanggan_id,)
        ).fetchone()
        conn.close()
        password = (row['password'] if row and row['password'] else '').strip()

    pwd_note = ''
    if not password:
        password = '••••••'
        pwd_note = (
            '! CATATAN: Password belum ditemukan di MikroTik maupun DB.\n'
            '! Klik "Regis Ulang" untuk generate ulang dengan password asli.\n\n'
        )

    commands = _build_olt_cli(
        cli_type, onu.get('slot_port', ''), onu.get('vlan', ''), onu.get('sn', ''),
        pelanggan['username'], pelanggan.get('profil', ''), password,
        onu.get('tcont_profile', ''),
        onu_type_keyword=olt.get('onu_type_keyword') or 'ALL'
    )

    return jsonify({
        'script':     pwd_note + '\n'.join(commands),
        'cli_type':   cli_type,
        'olt_name':   olt.get('name') or 'OLT',
        'catatan_onu': olt.get('keterangan') or '',
    }), 200


# ══════════════════════════════════════════════════════════════
# REMOTE MODEM — NAT Port Forwarding
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/<int:pelanggan_id>/remote-on', methods=['POST'])
def remote_modem_on(pelanggan_id):
    """
    Arahkan slot NAT "Remote ONU" (rule dst-nat ber-comment 'Remote-Onu',
    sudah dikonfigurasi sebelumnya di halaman Input MikroTik) ke IP modem
    pelanggan ini, sehingga modem bisa diakses dari internet untuk diagnostik.

    Body JSON (opsional): { "device_id": <id> }  — hint kalau device_id pelanggan belum tercatat

    Response:
    {
      "url":      "http://103.194.175.174:1234",
      "modem_ip": "10.10.10.5"
    }
    """
    from utils import get_network_package
    from packages import package_has_feature
    pkg = get_network_package(g.network_id)
    if not package_has_feature(pkg, 'remote_modem'):
        return jsonify({
            'error': 'Fitur Remote Akses Modem tidak tersedia di paket Anda. Upgrade ke paket Lanjutan atau lebih tinggi untuk mengaktifkan.',
            'code':  'feature_locked',
        }), 403

    pelanggan, device = _get_pelanggan_device(pelanggan_id)
    if not pelanggan:
        return jsonify({'error': 'Pelanggan tidak ditemukan'}), 404

    body = request.get_json(silent=True) or {}

    if not device:
        # Fallback: coba resolve device pakai hint device_id dari body
        device = _resolve_device_with_hint(pelanggan, body.get('device_id'))
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan. Pastikan pelanggan terdaftar di salah satu MikroTik.'}), 404

    remote_ip      = (device.get('remote_onu_ip') or '').strip()
    remote_port    = device.get('remote_onu_port')
    remote_comment = (device.get('remote_onu_comment') or '').strip() or REMOTE_ONU_COMMENT
    if not remote_ip or not remote_port:
        return jsonify({
            'error': 'Remote ONU belum dikonfigurasi untuk MikroTik ini. '
                     'Atur dulu di halaman Input MikroTik (tombol "Remote ONU").'
        }), 400

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

            # 2. Repoint slot NAT Remote ONU (dicari berdasarkan comment yang dikonfigurasi) ke IP modem pelanggan ini
            nat_path = api.path('/ip/firewall/nat')
            rule = next(
                (r for r in nat_path if (r.get('comment') or '') == remote_comment),
                None
            )
            if not rule:
                return jsonify({
                    'error': f'Rule NAT dengan comment "{remote_comment}" tidak ditemukan di MikroTik. '
                             'Konfigurasi ulang di halaman Input MikroTik (tombol "Remote ONU").'
                }), 400

            nat_path.update(**{'.id': rule['.id'], 'to-addresses': modem_ip, 'to-ports': '80'})

            logging.info(f'[remote-modem] {pelanggan["username"]}: {remote_ip}:{remote_port} → {modem_ip}:80')

        return jsonify({
            'url':      f'http://{remote_ip}:{remote_port}',
            'modem_ip': modem_ip,
            'message':  f'Remote aktif. Buka link di tab baru untuk akses modem {pelanggan["username"]}.',
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


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

    try:
        olt = cari_olt(int(olt_id))
    except (TypeError, ValueError):
        return jsonify({'error': 'olt_id tidak valid'}), 400
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
    commands = _build_olt_cli(cli_type, slot_port, vlan, sn, username, profil, password_pel, tcont_profile,
                              onu_type_keyword=olt.get('onu_type_keyword') or 'ALL')

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
    try:
        limit = int(request.args.get('limit', 100))
    except (ValueError, TypeError):
        limit = 100
    try:
        offset = int(request.args.get('offset', 0))
    except (ValueError, TypeError):
        offset = 0

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


@api_bp.route('/keuangan/trend', methods=['GET'])
def get_keuangan_trend():
    """
    Tren keuangan N bulan terakhir (default 6, maks 12) — dipakai grafik
    garis pemasukan vs pengeluaran di halaman Keuangan.

    Query params:
      bulan (YYYY-MM, bulan terakhir rentang; default bulan ini)
      n     (jumlah bulan, default 6, maks 12)
    """
    bulan = request.args.get('bulan', '').strip()
    try:
        n = max(1, min(int(request.args.get('n', 6)), 12))
    except (TypeError, ValueError):
        n = 6

    try:
        y, m = map(int, bulan.split('-'))
        y, m = date(y, m, 1).year, date(y, m, 1).month
    except Exception:
        today = date.today()
        y, m = today.year, today.month

    # Bangun daftar n bulan menaik (dari yang tertua ke terbaru)
    bulan_list = []
    for _ in range(n):
        bulan_list.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    bulan_list.reverse()

    conn = get_db()
    labels = []
    pemasukan_list   = []
    pengeluaran_list = []
    saldo_list       = []
    for (yy, mm) in bulan_list:
        awal  = date(yy, mm, 1).isoformat()
        akhir = date(yy, mm, calendar.monthrange(yy, mm)[1]).isoformat()
        rows = conn.execute('''
            SELECT tipe, status, SUM(nominal) AS total
            FROM keuangan
            WHERE tanggal BETWEEN ? AND ?
            GROUP BY tipe, status
        ''', (awal, akhir)).fetchall()
        pemasukan = pengeluaran = 0
        for r in rows:
            if r['tipe'] == 'pemasukan' and r['status'] == 'Lunas':
                pemasukan += r['total']
            elif r['tipe'] == 'pengeluaran' and r['status'] in ('Lunas', 'Pending'):
                pengeluaran += r['total']
        labels.append(date(yy, mm, 1).strftime('%b %Y'))
        pemasukan_list.append(pemasukan)
        pengeluaran_list.append(pengeluaran)
        saldo_list.append(pemasukan - pengeluaran)
    conn.close()

    return jsonify({
        'status':      'success',
        'labels':      labels,
        'pemasukan':   pemasukan_list,
        'pengeluaran': pengeluaran_list,
        'saldo':       saldo_list,
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

    if request.args.get('format') == 'json':
        from utils import get_isp_profile
        profil = get_isp_profile(conn, g.network_id)
        conn.close()
        data = [keuangan_to_dict(r) for r in rows]
        total_masuk  = sum(d['nominal'] for d in data if d['tipe'] == 'pemasukan')
        total_keluar = sum(d['nominal'] for d in data if d['tipe'] == 'pengeluaran')
        return jsonify({
            'status': 'success',
            'isp_name': profil['isp_name'],
            'isp_logo': profil['isp_logo'],
            'periode': bulan or awal[:7],
            'rows': data,
            'totals': {
                'pemasukan': total_masuk,
                'pengeluaran': total_keluar,
                'saldo': total_masuk - total_keluar,
            },
        }), 200

    conn.close()

    buf = io.StringIO()
    buf.write('﻿')  # BOM agar Excel membaca UTF-8 dengan benar
    buf.write('sep=,\r\n')  # paksa Excel pakai koma sbg pemisah kolom (locale ID pakai ;)
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

    keterangan = str(data.get('keterangan') or '').strip()
    tipe       = str(data.get('tipe')       or '').strip().lower()
    nominal    = data.get('nominal',    0)
    tanggal    = str(data.get('tanggal') or date.today().isoformat()).strip()
    status     = str(data.get('status')  or 'Pending').strip()
    metode     = str(data.get('metode')  or 'Transfer').strip()
    device_id  = data.get('device_id',  None)
    username   = str(data.get('username') or '').strip()
    catatan    = str(data.get('catatan')  or '').strip()

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

    conn = get_db()
    try:
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
    finally:
        conn.close()

    catat_aktivitas('keuangan', tipe, target=username,
                    pesan=f'{keterangan}', nominal=nominal)

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

    keterangan = str(data.get('keterangan') if data.get('keterangan') is not None else current['keterangan']).strip()
    tipe       = str(data.get('tipe')       if data.get('tipe')       is not None else current['tipe']).strip().lower()
    tanggal    = str(data.get('tanggal')    if data.get('tanggal')    is not None else current['tanggal']).strip()
    metode     = str(data.get('metode')     if data.get('metode')     is not None else current['metode']).strip()
    status     = str(data.get('status')     if data.get('status')     is not None else current['status']).strip()
    username   = str(data.get('username')   if data.get('username')   is not None else (current['username'] or '')).strip()
    catatan    = str(data.get('catatan')    if data.get('catatan')    is not None else (current['catatan']  or '')).strip()
    device_id  = data.get('device_id',  current['device_id'])

    try:
        nominal = int(data.get('nominal', current['nominal']))
        if nominal < 0:
            raise ValueError
    except (ValueError, TypeError):
        nominal = current['nominal']

    if tipe   not in ('pemasukan', 'pengeluaran'): tipe   = current['tipe']
    if status not in ('Lunas', 'Pending', 'Gagal'): status = current['status']

    try:
        conn.execute('''
            UPDATE keuangan
            SET tanggal=?, keterangan=?, tipe=?, nominal=?, status=?,
                metode=?, device_id=?, username=?, catatan=?
            WHERE id=?
        ''', (tanggal, keterangan, tipe, nominal, status,
              metode, device_id, username, catatan, trx_id))
        conn.commit()
        row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    finally:
        conn.close()

    catat_aktivitas('keuangan', 'edit', target=username,
                    pesan=f'Edit transaksi: {keterangan}', nominal=nominal)

    return jsonify({
        'status':    'success',
        'message':   'Transaksi berhasil diperbarui',
        'transaksi': keuangan_to_dict(row),
    }), 200


@api_bp.route('/keuangan/<int:trx_id>', methods=['DELETE'])
def hapus_keuangan(trx_id):
    """Hapus satu transaksi berdasarkan ID."""
    conn = get_db()
    row  = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    affected = conn.execute('DELETE FROM keuangan WHERE id = ?', (trx_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    catat_aktivitas('keuangan', 'hapus', target=(row['username'] or '') if row else '',
                    pesan=f"Hapus transaksi: {row['keterangan'] if row else trx_id}",
                    nominal=row['nominal'] if row else None)

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

    # Auto-aktifkan MikroTik jika pelanggan sedang diisolir
    username = (row['username'] or '').strip()
    mt_msg   = ''
    if username:
        try:
            from tagihan import _restore_isolir_if_needed
            _restore_isolir_if_needed(conn, username)
            mt_msg = ' Internet pelanggan dipulihkan otomatis.'
        except Exception as e:
            logging.warning(f'[Lunas] Gagal restore isolir untuk {username}: {e}')

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    conn.close()

    catat_aktivitas('keuangan', 'lunas', target=username,
                    pesan=f"Lunas: {row['keterangan']}", nominal=row['nominal'])

    return jsonify({
        'status':    'success',
        'message':   f'Transaksi #{trx_id} berhasil ditandai Lunas.{mt_msg}',
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
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()
    try:
        harga = int(body.get('harga') or 0)
        if harga < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'error': 'Harga harus berupa angka positif'}), 400

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
    # TIDAK rollback ke MikroTik kalau step ini gagal — itu nambah operasi
    # jaringan baru yg bisa gagal juga (2 titik gagal independen, lebih ruwet).
    # Cukup kasih tahu user jujur lewat field 'warning' supaya dia tahu harus
    # sync manual, bukan diam2 cuma masuk log yg tidak pernah dia lihat.
    local_save_failed = False
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
        local_save_failed = True
        logging.warning(
            f'[profile] Profile "{nama}" sudah ada di MikroTik '
            f'tapi gagal simpan ke DB lokal: {e}'
        )

    resp = {'message': f'Profile {nama} ({rate_limit}) berhasil ditambahkan di MikroTik'}
    if local_save_failed:
        resp['warning'] = (
            f'Profile berhasil dibuat di MikroTik, TAPI gagal disimpan ke data lokal '
            f'(harga/catatan). Buka halaman ini lagi & edit profile "{nama}" manual untuk sinkronkan.'
        )
    return jsonify(resp), 201


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
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()
    try:
        harga = int(body.get('harga') or 0)
        if harga < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'error': 'Harga harus berupa angka positif'}), 400

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
    bandwidth_note = (body.get('bandwidth_note') or '').strip()
    deskripsi      = (body.get('deskripsi')      or '').strip()
    try:
        harga = int(body.get('harga', 0) or 0)
        if harga < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'error': 'Harga harus berupa angka positif'}), 400

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
            # MTU bisa berupa angka, string angka ("1500M"), atau "auto"
            # (umum di interface bridge) — fallback ke 1500 kalau tidak bisa di-parse.
            try:
                mtu = int(str(row.get('mtu') or 1500).split('M')[0])
            except ValueError:
                mtu = 1500
            result.append({
                'name':    row.get('name',    ''),
                'type':    row.get('type',    ''),
                'comment': row.get('comment', ''),
                'running': str(row.get('running', 'false')).lower() in ('true', 'yes'),
                'mtu':     mtu,
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


# ── Snapshot rx-byte/tx-byte terakhir per (owner, device, interface) ──
# Dipakai untuk menghitung bandwidth VLAN dari SELISIH antar polling
# (frontend polling tiap 4 detik), supaya get_bandwidth tidak perlu
# time.sleep(1) di setiap request — itu yang sebelumnya membuat tiap
# polling bandwidth selalu lambat 1 detik + overhead koneksi.
_IFACE_SNAP_CACHE = {}  # (network_id, device_id, iface) -> (monotonic_ts, rx_byte, tx_byte)


@api_bp.route('/mikrotik/<int:device_id>/bandwidth', methods=['GET'])
def get_bandwidth(device_id):
    """
    Traffic realtime satu interface. ?iface=ether1

    Catatan VLAN: pada interface bertipe 'vlan' dengan hardware-switch
    offloading, /interface/monitor-traffic sering melaporkan rate AGREGAT
    port fisik induknya (gabungan semua VLAN), bukan rate VLAN itu sendiri.
    Counter rx-byte/tx-byte di /interface/print dihitung per-interface
    (software, akurat per-VLAN) — sumber yang sama dengan Tx/Rx Rate &
    Byte Graph di WinBox. Maka untuk interface VLAN, pakai selisih byte
    terhadap snapshot polling SEBELUMNYA (_IFACE_SNAP_CACHE), bukan
    monitor-traffic dan bukan sampel 1 detik dalam request ini.
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

            def _snap():
                for r in api.path('/interface'):
                    rd = dict(r)
                    if rd.get('name') == iface:
                        return rd
                return {}

            s1      = _snap()
            is_vlan = s1.get('type') == 'vlan'

            got_monitor = False
            if not is_vlan:
                # Interface fisik/non-VLAN → monitor-traffic akurat & instan
                try:
                    samples = list(api.path('/interface/monitor-traffic')(
                        **{'interface': iface, 'duration': '1', 'once': ''}
                    ))
                    if samples:
                        s       = dict(samples[0])
                        rx_mbps = round(float(s.get('rx-bits-per-second', 0) or 0) / 1_000_000, 3)
                        tx_mbps = round(float(s.get('tx-bits-per-second', 0) or 0) / 1_000_000, 3)
                        got_monitor = True
                except Exception:
                    pass

            if not got_monitor and s1:
                # VLAN (atau monitor-traffic gagal) → selisih rx-byte/tx-byte
                # terhadap polling sebelumnya. Polling pertama (belum ada
                # snapshot sebelumnya) balas 0 — sample berikutnya (~4 detik
                # kemudian dari frontend) sudah punya selisih yang valid.
                now      = _time.monotonic()
                rx_now   = int(s1.get('rx-byte', 0) or 0)
                tx_now   = int(s1.get('tx-byte', 0) or 0)
                snap_key = (g.network_id, device_id, iface)
                prev     = _IFACE_SNAP_CACHE.get(snap_key)

                if prev:
                    prev_ts, prev_rx, prev_tx = prev
                    elapsed = now - prev_ts
                    if elapsed >= 0.5:
                        rx_mbps = round(max(rx_now - prev_rx, 0) * 8 / elapsed / 1_000_000, 3)
                        tx_mbps = round(max(tx_now - prev_tx, 0) * 8 / elapsed / 1_000_000, 3)

                _IFACE_SNAP_CACHE[snap_key] = (now, rx_now, tx_now)

        return jsonify({
            'iface': iface, 'rx_mbps': rx_mbps, 'tx_mbps': tx_mbps,
            'ts': datetime.now().isoformat(),
        }), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        logging.error(f'[bandwidth] device {device_id} iface {iface}: {e}')
        return jsonify({'error': str(e)}), 500


_BW_RANGE_HOURS = {'24h': 24, '7d': 24 * 7, '14d': 24 * 14}


@api_bp.route('/mikrotik/<int:device_id>/bandwidth-history', methods=['GET'])
def get_bandwidth_history(device_id):
    """Riwayat bandwidth WAN device ini (direkam worker background tiap
    5 menit dari devices.wan_interface). Kosong kalau wan_interface belum
    diisi di form MikroTik."""
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    hours  = _BW_RANGE_HOURS.get(request.args.get('range', '24h'), 24)
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat(timespec='seconds')

    conn = get_db()
    rows = conn.execute('''
        SELECT rx_mbps, tx_mbps, recorded_at
        FROM bandwidth_history
        WHERE device_id = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
    ''', (device_id, cutoff)).fetchall()
    conn.close()
    # recorded_at disimpan naive-UTC (server jalan di UTC) — tandai 'Z' eksplisit
    # supaya Date() di browser parse sebagai UTC, bukan dikira sudah waktu lokal.
    out = [dict(r) for r in rows]
    for o in out:
        o['recorded_at'] = o['recorded_at'] + 'Z'
    return jsonify(out)


@api_bp.route('/stats/<int:device_id>', methods=['GET'])
def get_stats(device_id):
    """
    Endpoint RINGAN — baca DB lokal saja, tidak sentuh MikroTik.
    Catatan: kolom 'aktif' = akun tidak di-disabled di MikroTik,
    BUKAN berarti sedang online. Angka realtime online/offline
    tersedia via /api/pelanggan/<id>.
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
        return jsonify({
            'total':    total,
            'online':   aktif,    # sementara: aktif = tidak disabled
            'offline':  nonaktif,
            'realtime': False,    # flag: angka ini BUKAN realtime online
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


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

        hdd_total = int(r.get('total-hdd-space', 0) or 0)
        hdd_free  = int(r.get('free-hdd-space',  0) or 0)
        hdd_used  = hdd_total - hdd_free
        hdd_pct   = round(hdd_used / hdd_total * 100) if hdd_total else 0

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
            'hdd_total':    hdd_total,
            'hdd_free':     hdd_free,
            'hdd_used':     hdd_used,
            'hdd_pct':      hdd_pct,
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
    try:
        limit = min(int(request.args.get('limit', 50)), 200)
    except (ValueError, TypeError):
        limit = 50
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
    """
    Feed "Live Aktivitas" dashboard — semua aksi penting (pelanggan,
    perangkat, keuangan, tagihan) dari tabel aktivitas_log milik owner.
    """
    try:
        limit = min(int(request.args.get('limit', 40)), 100)
    except (ValueError, TypeError):
        limit = 40
    conn = get_db()
    try:
        logs = []
        for r in conn.execute(
            'SELECT id, tipe, aksi, target, pesan, nominal, aktor, created_at '
            'FROM aktivitas_log ORDER BY id DESC LIMIT ?', (limit,)
        ).fetchall():
            logs.append({
                'id':      r['id'],
                'tipe':    r['tipe'] or '',
                'aksi':    r['aksi'] or '',
                'target':  r['target'] or '',
                'pesan':   r['pesan'] or '',
                'nominal': r['nominal'],
                'aktor':   r['aktor'] or '',
                'time':    r['created_at'] or '',
                'ts':      r['created_at'] or '',
            })
        return jsonify(logs), 200
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

    try:
        device_id = int(device_id)
    except (ValueError, TypeError):
        return jsonify({'error': 'device_id tidak valid'}), 400

    device = cari_device(device_id)
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

    if ok:
        catat_aktivitas('pelanggan', 'isolir',
                        pesan=f'Isolir massal: {ok} pelanggan diisolir' + (f', {err} gagal' if err else ''))

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

    try:
        device_id = int(device_id)
    except (ValueError, TypeError):
        return jsonify({'error': 'device_id tidak valid'}), 400

    device = cari_device(device_id)
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

    if ok:
        catat_aktivitas('pelanggan', 'aktifkan',
                        pesan=f'Aktifkan massal: {ok} pelanggan diaktifkan' + (f', {err} gagal' if err else ''))

    return jsonify({
        'message': f'{ok} pelanggan diaktifkan, {err} gagal',
        'results': results,
    }), 200 if err == 0 else 207


# ══════════════════════════════════════════════════════════════════════
# TIKET — manajemen laporan gangguan dari pelanggan (ISP side)
# ══════════════════════════════════════════════════════════════════════

def _ensure_tiket_table_isp(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS tiket (
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
    conn.commit()


@api_bp.route('/tiket', methods=['GET'])
def tiket_list():
    conn = get_db()
    _ensure_tiket_table_isp(conn)
    status_filter = request.args.get('status', '')
    search        = request.args.get('q', '').strip()
    params = []
    where  = []
    if status_filter and status_filter != 'semua':
        where.append('status = ?'); params.append(status_filter)
    if search:
        where.append('(username LIKE ? OR judul LIKE ?)')
        params += [f'%{search}%', f'%{search}%']
    sql = 'SELECT * FROM tiket'
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY created_at DESC LIMIT 200'
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows]), 200


@api_bp.route('/tiket/count', methods=['GET'])
def tiket_count():
    conn = get_db()
    _ensure_tiket_table_isp(conn)
    baru = conn.execute("SELECT COUNT(*) FROM tiket WHERE status='Baru'").fetchone()[0]
    conn.close()
    return jsonify({'baru': baru}), 200


@api_bp.route('/tiket/<int:tiket_id>', methods=['PATCH'])
def tiket_update(tiket_id):
    body      = request.get_json(silent=True) or {}
    status    = (body.get('status') or '').strip()
    catatan   = (body.get('catatan_cs') or '').strip()
    valid_st  = ['Baru', 'Diproses', 'Selesai']
    if status and status not in valid_st:
        return jsonify({'error': 'Status tidak valid'}), 400
    conn = get_db()
    _ensure_tiket_table_isp(conn)
    updates, params = [], []
    if status:
        updates.append('status = ?'); params.append(status)
    if catatan is not None:
        updates.append('catatan_cs = ?'); params.append(catatan)
    updates.append("updated_at = datetime('now','localtime')")
    params.append(tiket_id)
    conn.execute(f"UPDATE tiket SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute('SELECT * FROM tiket WHERE id = ?', (tiket_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Tiket tidak ditemukan'}), 404
    return jsonify(dict(row)), 200