"""
portal_api.py — Portal Pelanggan TechnoFix
============================================
Blueprint Flask khusus untuk self-service pelanggan.

Endpoint:
  POST /api/portal/login       — Login dengan username PPPoE + nomor HP
  POST /api/portal/logout      — Logout
  GET  /api/portal/check       — Cek status session
  GET  /api/portal/detail      — Detail langganan + ONU milik pelanggan
  GET  /api/portal/status      — Status koneksi realtime dari MikroTik
  GET  /api/portal/tagihan     — Riwayat pembayaran / tagihan
  POST /api/portal/tiket       — Kirim laporan gangguan
  GET  /api/portal/tiket       — Riwayat tiket pelanggan
  POST /api/portal/ganti-password  — Ganti password PPPoE
  POST /api/portal/perpanjang  — Request perpanjangan paket (manual konfirmasi)

Autentikasi:
  - Login: username = PPPoE username, password = nomor HP (kolom hp/no_hp)
  - Session disimpan di Flask session (cookie httponly)
  - Setiap endpoint (kecuali /login & /check) wajib session valid

Daftar tabel DB yang dipakai:
  - pelanggan   : data utama pelanggan
  - onu_mapping : data ONU (rx_power, tx_power, sn, slot_port, vlan)
  - keuangan    : riwayat transaksi/tagihan
  - devices     : daftar MikroTik router
  - tiket       : laporan gangguan (dibuat otomatis saat pertama kali dipakai)
"""

import logging
from datetime import datetime, date, timedelta
from functools import wraps

from flask import Blueprint, jsonify, request, session

from utils import get_db, get_onu_data
from mikrotik import MikroTikClient, MikroTikError

portal_bp = Blueprint('portal', __name__, url_prefix='/api/portal')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# ══════════════════════════════════════════════════════════════
# INIT — Buat tabel tiket jika belum ada
# ══════════════════════════════════════════════════════════════

def init_portal_tables():
    """
    Buat tabel tiket (laporan gangguan) jika belum ada.
    Dipanggil otomatis saat modul di-import.
    """
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tiket (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT    NOT NULL,
            kategori    TEXT    NOT NULL DEFAULT 'Umum',
            judul       TEXT    NOT NULL,
            deskripsi   TEXT    NOT NULL DEFAULT '',
            status      TEXT    NOT NULL DEFAULT 'Baru',
            prioritas   TEXT    NOT NULL DEFAULT 'Normal',
            catatan_cs  TEXT    DEFAULT '',
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        )
    ''')
    conn.commit()
    conn.close()

try:
    init_portal_tables()
except Exception as _e:
    logging.warning(f'[portal] Gagal init tabel tiket: {_e}')


# ══════════════════════════════════════════════════════════════
# HELPER — Session & Auth
# ══════════════════════════════════════════════════════════════

def get_session_username() -> str | None:
    """Ambil username dari session aktif, atau None jika belum login."""
    return session.get('portal_username')


def require_login(f):
    """
    Decorator: pastikan pelanggan sudah login.
    Jika belum, kembalikan 401.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not get_session_username():
            return jsonify({'error': 'Sesi tidak ditemukan. Silakan login kembali.'}), 401
        return f(*args, **kwargs)
    return decorated


def get_pelanggan_by_username(username: str) -> dict | None:
    """
    Ambil data pelanggan dari DB lokal berdasarkan username.
    Return dict atau None jika tidak ditemukan.
    """
    conn = get_db()
    row  = conn.execute(
        '''SELECT id, username, nama, password, profil, hp, no_hp,
                  service, aktif, tgl_pasang, tgl_jatuh, titik_koordinat
           FROM pelanggan WHERE username = ?''',
        (username,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def normalize_hp(hp: str) -> str:
    """
    Normalisasi nomor HP: hapus spasi/strip, ganti awalan +62 → 0.
    Contoh: '+6281234567890' → '081234567890'
    """
    hp = (hp or '').strip().replace(' ', '').replace('-', '')
    if hp.startswith('+62'):
        hp = '0' + hp[3:]
    elif hp.startswith('62') and len(hp) > 10:
        hp = '0' + hp[2:]
    return hp


def cek_hp_cocok(input_hp: str, stored_hp: str, stored_no_hp: str) -> bool:
    """
    Cek apakah nomor HP yang diinput cocok dengan yang tersimpan di DB.
    Normalisasi keduanya sebelum dibandingkan.
    """
    inp = normalize_hp(input_hp)
    for stored in [stored_hp, stored_no_hp]:
        if stored and normalize_hp(stored) == inp:
            return True
    return False


def get_device_for_pelanggan(username: str) -> dict | None:
    """
    Cari device MikroTik yang menangani pelanggan ini.
    Prioritas: kolom device_id di tabel pelanggan, fallback ke device pertama.
    """
    conn = get_db()

    # Coba ambil device_id dari kolom pelanggan
    row = conn.execute(
        'SELECT device_id FROM pelanggan WHERE username = ?', (username,)
    ).fetchone()

    device_id = row['device_id'] if row and row['device_id'] else None

    if device_id:
        dev = conn.execute(
            'SELECT id, name, ip, port, username, password FROM devices WHERE id = ?',
            (device_id,)
        ).fetchone()
    else:
        # Fallback: ambil device pertama yang aktif
        dev = conn.execute(
            'SELECT id, name, ip, port, username, password FROM devices LIMIT 1'
        ).fetchone()

    conn.close()
    return dict(dev) if dev else None


def format_rupiah(n) -> str:
    """Format angka ke format Rupiah. Contoh: 150000 → 'Rp 150.000'"""
    try:
        return f"Rp {int(n):,}".replace(',', '.')
    except Exception:
        return str(n)


def sisa_hari(tgl_str: str) -> int | None:
    """Hitung sisa hari dari hari ini ke tanggal jatuh tempo."""
    if not tgl_str:
        return None
    try:
        jatuh = datetime.strptime(tgl_str[:10], '%Y-%m-%d').date()
        return (jatuh - date.today()).days
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════
# 1. LOGIN
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/login', methods=['POST'])
def portal_login():
    """
    Login pelanggan.

    Body JSON:
        { "username": "budi.santoso", "password": "08123456789" }

    Logika autentikasi:
        - Cari username di tabel pelanggan
        - Bandingkan password input dengan kolom hp / no_hp (nomor telepon)
        - Jika cocok → set session
    """
    body     = request.get_json(silent=True) or {}
    username = str(body.get('username', '') or '').strip().lower()
    password = str(body.get('password', '') or '').strip()

    if not username or not password:
        return jsonify({'success': False, 'message': 'Username dan nomor telepon wajib diisi.'}), 400

    pelanggan = get_pelanggan_by_username(username)

    if not pelanggan:
        logging.info(f'[portal/login] Username tidak ditemukan: {username}')
        return jsonify({'success': False, 'message': 'Username atau nomor telepon salah.'}), 401

    # Cek apakah akun aktif
    if not pelanggan.get('aktif'):
        return jsonify({'success': False, 'message': 'Akun Anda sedang tidak aktif. Hubungi tim TechnoFix.'}), 403

    # Verifikasi password = nomor HP
    hp_db    = pelanggan.get('hp', '') or ''
    no_hp_db = pelanggan.get('no_hp', '') or ''

    if not cek_hp_cocok(password, hp_db, no_hp_db):
        logging.info(f'[portal/login] Password salah untuk username: {username}')
        return jsonify({'success': False, 'message': 'Username atau nomor telepon salah.'}), 401

    # Set session
    session.permanent = True
    session['portal_username'] = username
    session['portal_login_at'] = datetime.now().isoformat()

    logging.info(f'[portal/login] Login berhasil: {username}')
    return jsonify({'success': True, 'message': 'Login berhasil.', 'username': username}), 200


# ══════════════════════════════════════════════════════════════
# 2. LOGOUT
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/logout', methods=['POST'])
def portal_logout():
    """Hapus session pelanggan."""
    username = get_session_username()
    session.pop('portal_username', None)
    session.pop('portal_login_at', None)
    logging.info(f'[portal/logout] Logout: {username}')
    return jsonify({'success': True, 'message': 'Berhasil keluar.'}), 200


# ══════════════════════════════════════════════════════════════
# 3. CEK SESSION
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/check', methods=['GET'])
def portal_check():
    """
    Cek apakah pelanggan sudah login.
    Dipakai oleh portal_login.html (auto-redirect) dan
    portal_dashboard.js (guard sebelum load data).
    """
    username = get_session_username()
    if username:
        return jsonify({'logged_in': True, 'username': username}), 200
    return jsonify({'logged_in': False}), 200


# ══════════════════════════════════════════════════════════════
# 4. DETAIL PELANGGAN
#    GET /api/portal/detail
#    → info langganan, ONU, harga profil
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/detail', methods=['GET'])
@require_login
def portal_detail():
    """
    Kembalikan semua data yang dibutuhkan portal_dashboard.js:
      - Info langganan (username, hp, profil, kecepatan, harga, tanggal)
      - Data ONU/sinyal (rx_power, tx_power, sn, slot_port, vlan)

    Harga diambil dari tabel profil_harga berdasarkan nama profil.
    Kecepatan (rate_down/rate_up) diambil dari tabel profil_harga
    via kolom bandwidth_note, atau dari nama profil jika tidak ada.
    """
    username  = get_session_username()
    pelanggan = get_pelanggan_by_username(username)

    if not pelanggan:
        return jsonify({'error': 'Data pelanggan tidak ditemukan.'}), 404

    # Ambil data ONU
    onu = get_onu_data(username)

    # Ambil harga & kecepatan dari profil_harga
    profil_name = pelanggan.get('profil') or 'default'
    harga       = 0
    rate_down   = ''
    rate_up     = ''

    conn = get_db()
    profil_row = conn.execute(
        '''SELECT harga, bandwidth_note, deskripsi
           FROM profil_harga
           WHERE nama_profile = ?
           LIMIT 1''',
        (profil_name,)
    ).fetchone()
    conn.close()

    if profil_row:
        harga = profil_row['harga'] or 0
        # bandwidth_note biasanya "10 Mbps / 10 Mbps" atau "10M/10M"
        bw = profil_row['bandwidth_note'] or ''
        if '/' in bw:
            parts     = bw.split('/')
            rate_down = parts[0].strip()
            rate_up   = parts[1].strip()

    # Fallback: parse dari nama profil (mis. "10M", "20Mbps", "Paket20")
    if not rate_down and profil_name:
        import re
        m = re.search(r'(\d+)\s*[Mm]', profil_name)
        if m:
            rate_down = f"{m.group(1)} Mbps"
            rate_up   = f"{m.group(1)} Mbps"

    hp = pelanggan.get('hp') or pelanggan.get('no_hp') or ''

    return jsonify({
        'username':   username,
        'nama':       pelanggan.get('nama') or username,
        'hp':         hp,
        'profil':     profil_name,
        'rate_down':  rate_down,
        'rate_up':    rate_up,
        'harga':      harga,
        'tgl_pasang': pelanggan.get('tgl_pasang') or '',
        'tgl_jatuh':  pelanggan.get('tgl_jatuh')  or '',
        # ONU / Sinyal
        'rx_power':   onu.get('rx_power'),
        'tx_power':   onu.get('tx_power'),
        'sn':         onu.get('sn')        or '',
        'slot_port':  onu.get('slot_port') or '',
        'vlan':       onu.get('vlan')      or '',
    }), 200


# ══════════════════════════════════════════════════════════════
# 5. STATUS KONEKSI REALTIME
#    GET /api/portal/status
#    → cek PPP Active di MikroTik
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/status', methods=['GET'])
@require_login
def portal_status():
    """
    Cek apakah pelanggan sedang online di MikroTik (PPP Active).
    Kembalikan IP, MAC, uptime jika online.

    Response:
    {
        "online":      true/false,
        "ip":          "10.x.x.x" | "",
        "mac":         "AA:BB:CC:DD:EE:FF" | "",
        "uptime":      "2h30m" | "",
        "router_name": "MikroTik-01"
    }
    """
    username = get_session_username()
    device   = get_device_for_pelanggan(username)

    if not device:
        return jsonify({
            'online': False, 'ip': '', 'mac': '', 'uptime': '',
            'router_name': '', 'error': 'Perangkat tidak ditemukan.'
        }), 200  # 200 bukan 404 agar dashboard tetap bisa render

    try:
        with MikroTikClient(device) as mt:
            active_conns = mt.get_active_connections()

        # Cari sesi aktif untuk username ini
        sesi = next(
            (a for a in active_conns if a.get('name') == username),
            None
        )

        if sesi:
            return jsonify({
                'online':      True,
                'ip':          sesi.get('address', ''),
                'mac':         sesi.get('caller-id', ''),
                'uptime':      sesi.get('uptime', ''),
                'router_name': device.get('name', 'MikroTik'),
            }), 200
        else:
            return jsonify({
                'online':      False,
                'ip':          '',
                'mac':         '',
                'uptime':      '',
                'router_name': device.get('name', 'MikroTik'),
            }), 200

    except MikroTikError as e:
        logging.warning(f'[portal/status] MikroTik error untuk {username}: {e}')
        return jsonify({
            'online': False, 'ip': '', 'mac': '', 'uptime': '',
            'router_name': device.get('name', ''),
            'error': str(e)
        }), 200

    except Exception as e:
        logging.error(f'[portal/status] Error untuk {username}: {e}')
        return jsonify({
            'online': False, 'ip': '', 'mac': '', 'uptime': '',
            'router_name': '', 'error': 'Gagal mengambil status koneksi.'
        }), 200


# ══════════════════════════════════════════════════════════════
# 6. RIWAYAT TAGIHAN / PEMBAYARAN
#    GET /api/portal/tagihan
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/tagihan', methods=['GET'])
@require_login
def portal_tagihan():
    """
    Riwayat transaksi/tagihan pelanggan dari tabel keuangan.
    Filter by username session (hanya data milik pelanggan sendiri).

    Query params:
        limit  (default 12) — jumlah data
        offset (default 0)

    Response:
    {
        "tagihan": [...],
        "total":   int,
        "ringkasan": {
            "total_lunas":   int,
            "total_pending": int,
            "jumlah_lunas":  int,
            "jumlah_pending": int
        }
    }
    """
    username = get_session_username()
    limit    = min(int(request.args.get('limit',  12)), 50)
    offset   = int(request.args.get('offset', 0))

    conn = get_db()
    try:
        rows = conn.execute(
            '''SELECT id, tanggal, keterangan, tipe, nominal, status, metode, catatan, created_at
               FROM keuangan
               WHERE username = ? AND tipe = 'pemasukan'
               ORDER BY tanggal DESC, id DESC
               LIMIT ? OFFSET ?''',
            (username, limit, offset)
        ).fetchall()

        total = conn.execute(
            "SELECT COUNT(*) FROM keuangan WHERE username = ? AND tipe = 'pemasukan'",
            (username,)
        ).fetchone()[0]

        # Ringkasan
        ringkasan_rows = conn.execute(
            '''SELECT status, COUNT(*) AS jumlah, SUM(nominal) AS total
               FROM keuangan
               WHERE username = ? AND tipe = 'pemasukan'
               GROUP BY status''',
            (username,)
        ).fetchall()

        ringkasan = {
            'total_lunas':    0, 'total_pending': 0,
            'jumlah_lunas':   0, 'jumlah_pending': 0,
        }
        for r in ringkasan_rows:
            if r['status'] == 'Lunas':
                ringkasan['total_lunas']  = r['total']  or 0
                ringkasan['jumlah_lunas'] = r['jumlah'] or 0
            elif r['status'] == 'Pending':
                ringkasan['total_pending']  = r['total']  or 0
                ringkasan['jumlah_pending'] = r['jumlah'] or 0

        tagihan = [{
            'id':          r['id'],
            'tanggal':     r['tanggal']    or '',
            'keterangan':  r['keterangan'] or '',
            'nominal':     r['nominal']    or 0,
            'status':      r['status']     or '',
            'metode':      r['metode']     or '',
            'catatan':     r['catatan']    or '',
            'created_at':  r['created_at'] or '',
        } for r in rows]

        return jsonify({
            'tagihan':   tagihan,
            'total':     total,
            'ringkasan': ringkasan,
        }), 200

    except Exception as e:
        logging.error(f'[portal/tagihan] Error untuk {username}: {e}')
        return jsonify({'error': 'Gagal mengambil data tagihan.'}), 500
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════
# 7. LAPORAN GANGGUAN / TIKET
#    POST /api/portal/tiket  — Buat tiket baru
#    GET  /api/portal/tiket  — Riwayat tiket pelanggan
# ══════════════════════════════════════════════════════════════

KATEGORI_VALID = [
    'Koneksi Putus',
    'Internet Lambat',
    'Sinyal Lemah',
    'Modem Bermasalah',
    'Tagihan',
    'Ganti Paket',
    'Umum',
    'Lainnya',
]


@portal_bp.route('/tiket', methods=['POST'])
@require_login
def buat_tiket():
    """
    Buat laporan gangguan baru.

    Body JSON:
    {
        "kategori":  "Koneksi Putus",
        "judul":     "Internet mati sejak tadi malam",
        "deskripsi": "Lampu WAN modem merah, sudah coba restart tapi tetap."
    }
    """
    username = get_session_username()
    body     = request.get_json(silent=True) or {}

    kategori  = str(body.get('kategori',  'Umum') or 'Umum').strip()
    judul     = str(body.get('judul',     '')     or '').strip()
    deskripsi = str(body.get('deskripsi', '')     or '').strip()

    if not judul:
        return jsonify({'error': 'Judul laporan wajib diisi.'}), 400
    if len(judul) > 200:
        return jsonify({'error': 'Judul terlalu panjang (maks 200 karakter).'}), 400
    if kategori not in KATEGORI_VALID:
        kategori = 'Umum'

    now = datetime.now().isoformat(timespec='seconds')

    # Batasi: maks 3 tiket "Baru" sekaligus per pelanggan
    conn = get_db()
    try:
        jumlah_aktif = conn.execute(
            "SELECT COUNT(*) FROM tiket WHERE username = ? AND status IN ('Baru', 'Diproses')",
            (username,)
        ).fetchone()[0]

        if jumlah_aktif >= 3:
            return jsonify({
                'error': 'Anda sudah memiliki 3 laporan aktif. Tunggu tim kami menyelesaikannya.'
            }), 429

        cursor = conn.execute(
            '''INSERT INTO tiket (username, kategori, judul, deskripsi, status, prioritas, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'Baru', 'Normal', ?, ?)''',
            (username, kategori, judul, deskripsi, now, now)
        )
        tiket_id = cursor.lastrowid
        conn.commit()

        logging.info(f'[portal/tiket] Tiket #{tiket_id} dibuat oleh {username}: {judul}')

        return jsonify({
            'success':  True,
            'message':  'Laporan berhasil dikirim. Tim kami akan segera menghubungi Anda.',
            'tiket_id': tiket_id,
        }), 201

    except Exception as e:
        logging.error(f'[portal/tiket] Error buat tiket {username}: {e}')
        return jsonify({'error': 'Gagal mengirim laporan. Coba lagi.'}), 500
    finally:
        conn.close()


@portal_bp.route('/tiket', methods=['GET'])
@require_login
def get_tiket():
    """
    Riwayat tiket milik pelanggan yang sedang login.
    """
    username = get_session_username()
    conn     = get_db()
    try:
        rows = conn.execute(
            '''SELECT id, kategori, judul, deskripsi, status, prioritas,
                      catatan_cs, created_at, updated_at
               FROM tiket WHERE username = ?
               ORDER BY id DESC LIMIT 20''',
            (username,)
        ).fetchall()

        return jsonify([{
            'id':         r['id'],
            'kategori':   r['kategori']   or '',
            'judul':      r['judul']      or '',
            'deskripsi':  r['deskripsi']  or '',
            'status':     r['status']     or '',
            'prioritas':  r['prioritas']  or '',
            'catatan_cs': r['catatan_cs'] or '',
            'created_at': r['created_at'] or '',
            'updated_at': r['updated_at'] or '',
        } for r in rows]), 200

    except Exception as e:
        logging.error(f'[portal/tiket] Error get tiket {username}: {e}')
        return jsonify([]), 200
    finally:
        conn.close()


# ══════════════════════════════════════════════════════════════
# 8. GANTI PASSWORD PPPoE
#    POST /api/portal/ganti-password
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/ganti-password', methods=['POST'])
@require_login
def ganti_password():
    """
    Ganti password PPPoE pelanggan.
    Verifikasi dulu dengan nomor HP (password lama).

    Body JSON:
    {
        "password_lama":  "08123456789",   ← nomor HP sebagai verifikasi
        "password_baru":  "rahasia123",
        "konfirmasi":     "rahasia123"
    }

    Alur:
      1. Verifikasi password_lama = nomor HP di DB
      2. Validasi password_baru (min 6 karakter, tidak sama dengan nomor HP)
      3. Update ke MikroTik via API
      4. Update kolom password di DB lokal
    """
    username = get_session_username()
    body     = request.get_json(silent=True) or {}

    password_lama = str(body.get('password_lama', '') or '').strip()
    password_baru = str(body.get('password_baru', '') or '').strip()
    konfirmasi    = str(body.get('konfirmasi',    '') or '').strip()

    # Validasi input
    if not password_lama:
        return jsonify({'error': 'Nomor HP (verifikasi) wajib diisi.'}), 400
    if not password_baru:
        return jsonify({'error': 'Password baru wajib diisi.'}), 400
    if len(password_baru) < 6:
        return jsonify({'error': 'Password baru minimal 6 karakter.'}), 400
    if password_baru != konfirmasi:
        return jsonify({'error': 'Konfirmasi password tidak cocok.'}), 400

    # Ambil data pelanggan
    pelanggan = get_pelanggan_by_username(username)
    if not pelanggan:
        return jsonify({'error': 'Data pelanggan tidak ditemukan.'}), 404

    # Verifikasi dengan nomor HP
    hp_db    = pelanggan.get('hp', '') or ''
    no_hp_db = pelanggan.get('no_hp', '') or ''
    if not cek_hp_cocok(password_lama, hp_db, no_hp_db):
        return jsonify({'error': 'Nomor HP verifikasi tidak cocok.'}), 401

    # Jangan biarkan password baru = nomor HP
    if cek_hp_cocok(password_baru, hp_db, no_hp_db):
        return jsonify({'error': 'Password baru tidak boleh sama dengan nomor HP Anda.'}), 400

    # Update ke MikroTik
    device = get_device_for_pelanggan(username)
    if not device:
        return jsonify({'error': 'Perangkat MikroTik tidak ditemukan.'}), 500

    try:
        with MikroTikClient(device) as mt:
            api    = mt._get_api()
            from librouteros.query import Key
            path   = api.path('/ppp/secret')
            target = next(
                (r for r in path.select(Key('.id'), Key('name'))
                 if r.get('name') == username),
                None
            )
            if not target:
                return jsonify({'error': 'Akun PPPoE tidak ditemukan di router.'}), 404

            path.update(**{'.id': target['.id'], 'password': password_baru})

    except MikroTikError as e:
        logging.error(f'[portal/ganti-password] MikroTik error {username}: {e}')
        return jsonify({'error': f'Gagal update ke router: {e}'}), 502
    except Exception as e:
        logging.error(f'[portal/ganti-password] Error {username}: {e}')
        return jsonify({'error': 'Gagal mengganti password.'}), 500

    # Update DB lokal
    try:
        conn = get_db()
        conn.execute(
            'UPDATE pelanggan SET password = ? WHERE username = ?',
            (password_baru, username)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logging.warning(f'[portal/ganti-password] Gagal update DB lokal {username}: {e}')
        # Tidak fatal — MikroTik sudah berhasil

    logging.info(f'[portal/ganti-password] Password berhasil diganti: {username}')
    return jsonify({
        'success': True,
        'message': 'Password PPPoE berhasil diganti. Modem akan reconnect otomatis.'
    }), 200


# ══════════════════════════════════════════════════════════════
# 9. REQUEST PERPANJANGAN PAKET (Manual Konfirmasi)
#    POST /api/portal/perpanjang
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/perpanjang', methods=['POST'])
@require_login
def perpanjang_paket():
    """
    Pelanggan request perpanjangan paket.
    Sistem mencatat ke tabel keuangan dengan status 'Pending'.
    Admin akan konfirmasi secara manual, lalu ubah status ke 'Lunas'.

    Body JSON:
    {
        "metode":  "Transfer",   ← opsional, default Transfer
        "catatan": "BCA a.n. ..." ← opsional
    }

    Logika:
      - Ambil harga dari profil_harga berdasarkan profil aktif pelanggan
      - Buat record keuangan tipe='pemasukan', status='Pending'
      - Kembalikan info rekening/cara bayar ke pelanggan
    """
    username  = get_session_username()
    pelanggan = get_pelanggan_by_username(username)

    if not pelanggan:
        return jsonify({'error': 'Data pelanggan tidak ditemukan.'}), 404

    body    = request.get_json(silent=True) or {}
    metode  = str(body.get('metode',  'Transfer') or 'Transfer').strip()
    catatan = str(body.get('catatan', '') or '').strip()

    # Cek apakah sudah ada tagihan pending
    conn = get_db()
    try:
        pending = conn.execute(
            "SELECT id FROM keuangan WHERE username = ? AND status = 'Pending' AND tipe = 'pemasukan'",
            (username,)
        ).fetchone()

        if pending:
            conn.close()
            return jsonify({
                'error': 'Anda masih memiliki tagihan yang belum dibayar. '
                         'Selesaikan pembayaran sebelumnya atau hubungi tim kami.'
            }), 409

        # Ambil harga profil
        profil_name = pelanggan.get('profil') or 'default'
        profil_row  = conn.execute(
            'SELECT harga FROM profil_harga WHERE nama_profile = ? LIMIT 1',
            (profil_name,)
        ).fetchone()

        harga = profil_row['harga'] if profil_row and profil_row['harga'] else 0

        if harga <= 0:
            conn.close()
            return jsonify({
                'error': 'Harga paket belum dikonfigurasi. Hubungi tim TechnoFix.'
            }), 400

        # Hitung periode perpanjangan (1 bulan dari jatuh tempo atau hari ini)
        tgl_jatuh = pelanggan.get('tgl_jatuh') or ''
        try:
            base = datetime.strptime(tgl_jatuh[:10], '%Y-%m-%d').date()
            if base < date.today():
                base = date.today()
        except Exception:
            base = date.today()

        # Jatuh tempo baru = base + 30 hari
        tgl_jatuh_baru = (base + timedelta(days=30)).isoformat()

        tanggal    = date.today().isoformat()
        keterangan = f'Tagihan Bulanan — {profil_name} — {username}'

        cursor = conn.execute(
            '''INSERT INTO keuangan
                 (tanggal, keterangan, tipe, nominal, status, metode,
                  username, catatan, created_at)
               VALUES (?, ?, 'pemasukan', ?, 'Pending', ?, ?, ?, ?)''',
            (tanggal, keterangan, harga, metode, username, catatan,
             datetime.now().isoformat(timespec='seconds'))
        )
        trx_id = cursor.lastrowid
        conn.commit()
        conn.close()

        logging.info(f'[portal/perpanjang] Request perpanjangan #{trx_id} oleh {username}, Rp {harga}')

        return jsonify({
            'success':        True,
            'message':        'Request perpanjangan berhasil dikirim. Lakukan pembayaran dan tim kami akan mengaktifkan akun Anda.',
            'trx_id':         trx_id,
            'nominal':        harga,
            'nominal_fmt':    format_rupiah(harga),
            'profil':         profil_name,
            'tgl_jatuh_baru': tgl_jatuh_baru,
            'metode':         metode,
            # Info pembayaran — sesuaikan dengan rekening Anda
            'info_bayar': {
                'bank':      'BCA',
                'rekening':  '1234567890',
                'atas_nama': 'TechnoFix',
                'nominal':   harga,
                'keterangan': f'Pembayaran #{trx_id} - {username}',
            },
        }), 201

    except Exception as e:
        logging.error(f'[portal/perpanjang] Error {username}: {e}')
        conn.close()
        return jsonify({'error': 'Gagal membuat request perpanjangan.'}), 500


# ══════════════════════════════════════════════════════════════
# 10. INFO PROFIL PAKET
#     GET /api/portal/paket
#     → daftar paket tersedia (untuk halaman perpanjang/upgrade)
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/paket', methods=['GET'])
@require_login
def portal_paket():
    """
    Kembalikan daftar paket yang tersedia beserta harga.
    Dipakai saat pelanggan ingin ganti/upgrade paket.
    """
    conn = get_db()
    try:
        rows = conn.execute(
            '''SELECT nama_profile, harga, deskripsi, bandwidth_note
               FROM profil_harga
               ORDER BY harga ASC'''
        ).fetchall()

        return jsonify([{
            'nama':           r['nama_profile']  or '',
            'harga':          r['harga']          or 0,
            'harga_fmt':      format_rupiah(r['harga'] or 0),
            'deskripsi':      r['deskripsi']       or '',
            'bandwidth_note': r['bandwidth_note']  or '',
        } for r in rows]), 200

    except Exception as e:
        logging.error(f'[portal/paket] Error: {e}')
        return jsonify([]), 200
    finally:
        conn.close()