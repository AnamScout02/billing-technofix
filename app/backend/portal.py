"""
portal.py — TechnoFix · Blueprint Portal Pelanggan
====================================================
Portal self-service untuk pelanggan ISP:
  - Login dengan username PPPoE + nomor telepon
  - Lihat status koneksi realtime
  - Lihat riwayat tagihan
  - Lapor gangguan (tiket)
  - Request perpanjangan paket

Session pelanggan TERPISAH dari session admin/owner.
Pelanggan hanya melihat data miliknya sendiri.

Fix multi-tenant: semua query ke owner DB, bukan master.
"""

import logging
import json as _json
import glob
import os
from functools import wraps
from datetime import date
from flask import Blueprint, request, jsonify, session

from utils import get_owner_db, OWNER_DB_DIR

portal_bp = Blueprint('portal', __name__)
logger    = logging.getLogger(__name__)

# Key session khusus portal
PORTAL_USERNAME_KEY   = 'portal_username'
PORTAL_NETWORK_ID_KEY = 'portal_network_id'


# ══════════════════════════════════════════════════════════════
# DECORATOR
# ══════════════════════════════════════════════════════════════

def portal_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get(PORTAL_USERNAME_KEY) or not session.get(PORTAL_NETWORK_ID_KEY):
            return jsonify({'error': 'Sesi tidak valid. Silakan login kembali.', 'logged_in': False}), 401
        return f(*args, **kwargs)
    return decorated


def _portal_db():
    """Koneksi ke owner DB berdasarkan session portal."""
    nid = session.get(PORTAL_NETWORK_ID_KEY)
    if not nid:
        raise ValueError('Portal network_id tidak ada di session')
    return get_owner_db(nid)


# ══════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════

def _normalize_phone(p: str) -> str:
    p = (p or '').strip().replace(' ', '').replace('-', '').replace('(', '').replace(')', '')
    if p.startswith('+62'):
        p = '0' + p[3:]
    if p.startswith('62') and len(p) > 10:
        p = '0' + p[2:]
    return p


def _search_pelanggan_all_owners(username: str, password: str):
    """
    Cari pelanggan di semua owner DB.
    Cocokkan password dengan kolom hp / no_hp (nomor telepon).
    Return (network_id, row_dict) atau (None, None).
    """
    pwd_norm = _normalize_phone(password)
    owner_dbs = glob.glob(os.path.join(OWNER_DB_DIR, '*.db'))

    for db_path in owner_dbs:
        nid = os.path.splitext(os.path.basename(db_path))[0]
        try:
            conn = get_owner_db(nid)
            row = conn.execute(
                'SELECT * FROM pelanggan WHERE LOWER(username) = ? LIMIT 1',
                (username.lower(),)
            ).fetchone()
            conn.close()

            if not row:
                continue

            hp_db    = _normalize_phone(row['hp']    or '')
            no_hp_db = _normalize_phone(row['no_hp'] if 'no_hp' in row.keys() else '')

            # Cek password cocok dengan salah satu nomor
            if pwd_norm and pwd_norm in (hp_db, no_hp_db):
                return nid, dict(row)

        except Exception as e:
            logger.warning(f'[Portal] Error saat cari di {nid[:8]}: {e}')
            continue

    return None, None


def _get_pelanggan(username: str) -> dict | None:
    nid = session.get(PORTAL_NETWORK_ID_KEY)
    if not nid:
        return None
    try:
        conn = get_owner_db(nid)
        row = conn.execute(
            '''SELECT p.*, d.ip AS device_ip, d.port AS device_port,
                      d.username AS device_user, d.password AS device_pass,
                      d.name AS device_name, d.status AS device_status,
                      d.id AS device_id_real
               FROM pelanggan p
               LEFT JOIN devices d ON d.id = p.device_id
               WHERE LOWER(p.username) = ? LIMIT 1''',
            (username.lower(),)
        ).fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        logger.warning(f'[Portal] _get_pelanggan error: {e}')
        return None


def _get_onu_data(username: str) -> dict:
    nid = session.get(PORTAL_NETWORK_ID_KEY)
    if not nid:
        return _empty_onu()
    try:
        conn = get_owner_db(nid)
        row = conn.execute(
            '''SELECT m.slot_port, m.vlan, m.sn, m.rx_power, m.tx_power,
                      o.name AS olt_name, o.tipe AS olt_tipe, o.ip AS olt_ip
               FROM onu_mapping m
               LEFT JOIN olt o ON o.id = m.olt_id
               WHERE m.username = ?''',
            (username,)
        ).fetchone()
        conn.close()
        if row:
            return {
                'slot_port': row['slot_port'] or '',
                'vlan':      row['vlan']      or '',
                'sn':        row['sn']        or '',
                'rx_power':  _safe_float(row['rx_power']),
                'tx_power':  _safe_float(row['tx_power']),
                'olt_name':  row['olt_name']  or '',
                'olt_tipe':  row['olt_tipe']  or '',
                'olt_ip':    row['olt_ip']    or '',
            }
    except Exception as e:
        logger.warning(f'[Portal] _get_onu_data error: {e}')
    return _empty_onu()


def _empty_onu():
    return {'slot_port':'','vlan':'','sn':'','rx_power':None,'tx_power':None,'olt_name':'','olt_tipe':'','olt_ip':''}


def _get_harga_profil(device_id, profil: str) -> int:
    nid = session.get(PORTAL_NETWORK_ID_KEY)
    if not nid or not device_id or not profil:
        return 0
    try:
        conn = get_owner_db(nid)
        row = conn.execute(
            'SELECT harga FROM profil_harga WHERE device_id=? AND nama_profile=?',
            (device_id, profil)
        ).fetchone()
        if not row:
            row = conn.execute(
                'SELECT harga FROM profil_harga WHERE nama_profile=? ORDER BY id LIMIT 1',
                (profil,)
            ).fetchone()
        conn.close()
        return int(row['harga'] or 0) if row else 0
    except Exception:
        return 0


def _safe_float(val):
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _rekening_info():
    """Ambil info rekening dari app_settings owner."""
    nid = session.get(PORTAL_NETWORK_ID_KEY)
    if not nid:
        return []
    try:
        conn = get_owner_db(nid)
        row = conn.execute("SELECT value FROM app_settings WHERE key='rekening_bank'").fetchone()
        conn.close()
        if row and row['value']:
            return _json.loads(row['value'])
    except Exception:
        pass
    return []


# ══════════════════════════════════════════════════════════════
# 1. CHECK SESSION
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/check', methods=['GET'])
def portal_check():
    username = session.get(PORTAL_USERNAME_KEY)
    return jsonify({'logged_in': bool(username), 'username': username or ''}), 200


# ══════════════════════════════════════════════════════════════
# 2. LOGIN
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/login', methods=['POST'])
def portal_login():
    body     = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip().lower()
    password = (body.get('password') or '').strip()

    if not username or not password:
        return jsonify({'success': False, 'message': 'Username dan nomor telepon wajib diisi.'}), 400

    nid, row = _search_pelanggan_all_owners(username, password)

    if not nid or not row:
        logger.warning(f'[Portal] Login gagal: {username}')
        return jsonify({'success': False, 'message': 'Username atau nomor telepon salah.'}), 401

    if not row.get('aktif', 1):
        return jsonify({'success': False, 'message': 'Akun Anda tidak aktif. Hubungi ISP Anda.'}), 403

    session[PORTAL_USERNAME_KEY]   = row['username']
    session[PORTAL_NETWORK_ID_KEY] = nid
    session.permanent = True

    logger.info(f'[Portal] Login: {row["username"]} @ {nid[:8]}')
    return jsonify({'success': True, 'username': row['username']}), 200


# ══════════════════════════════════════════════════════════════
# 3. LOGOUT
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/logout', methods=['POST'])
def portal_logout():
    username = session.pop(PORTAL_USERNAME_KEY, None)
    session.pop(PORTAL_NETWORK_ID_KEY, None)
    logger.info(f'[Portal] Logout: {username}')
    return jsonify({'success': True}), 200


# ══════════════════════════════════════════════════════════════
# 4. DETAIL PELANGGAN
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/detail', methods=['GET'])
@portal_required
def portal_detail():
    username = session[PORTAL_USERNAME_KEY]
    p = _get_pelanggan(username)
    if not p:
        return jsonify({'error': 'Data pelanggan tidak ditemukan.'}), 404

    onu         = _get_onu_data(username)
    profil_name = p.get('profil') or ''
    device_id   = p.get('device_id') or p.get('device_id_real')
    harga       = _get_harga_profil(device_id, profil_name)

    # Kecepatan dari profil — coba MikroTik jika connected
    rate_down, rate_up = 'unlimited', 'unlimited'
    try:
        if p.get('device_status') == 'connected' and p.get('device_ip'):
            from mikrotik import MikroTikClient, MikroTikError
            device = {
                'ip':       p['device_ip'],
                'port':     int(p.get('device_port') or 8728),
                'username': p['device_user'],
                'password': p['device_pass'],
            }
            with MikroTikClient(device) as mt:
                for pr in (mt.get_ppp_profiles() or []):
                    if pr.get('name') == profil_name:
                        rate_down = pr.get('rate_down') or pr.get('max-limit','').split('/')[0] or 'unlimited'
                        rate_up   = pr.get('rate_up')   or (pr.get('max-limit','').split('/')[-1] if '/' in pr.get('max-limit','') else 'unlimited')
                        break
    except Exception as e:
        logger.debug(f'[Portal] Gagal ambil kecepatan: {e}')

    # Tagihan belum bayar bulan ini
    from datetime import date as _dt
    periode_ini = _dt.today().strftime('%Y-%m')
    tagihan_aktif = []
    try:
        conn = _portal_db()
        rows = conn.execute(
            "SELECT id, periode, nominal, status, jatuh_tempo FROM tagihan WHERE username=? AND status='belum_bayar' ORDER BY periode DESC LIMIT 5",
            (username,)
        ).fetchall()
        conn.close()
        tagihan_aktif = [dict(r) for r in rows]
    except Exception as e:
        logger.debug(f'[Portal] Tagihan aktif error: {e}')

    # Ambil info ISP dari tabel networks
    isp_name = ''
    isp_wa   = ''
    try:
        from utils import get_master_db
        mconn = get_master_db()
        net = mconn.execute(
            'SELECT isp_name FROM networks WHERE network_id=?',
            (session.get('portal_network_id',''),)
        ).fetchone()
        mconn.close()
        if net:
            isp_name = net['isp_name'] or ''
    except Exception:
        pass

    return jsonify({
        'username':      p.get('username')  or '',
        'nama':          p.get('nama')      or p.get('username') or '',
        'hp':            p.get('hp')        or p.get('no_hp') or '',
        'profil':        profil_name,
        'tgl_pasang':    p.get('tgl_pasang')  or '',
        'tgl_jatuh':     p.get('tgl_jatuh')   or '',
        'aktif':         bool(p.get('aktif', 1)),
        'isp_name':      isp_name,
        'harga':         harga,
        'harga_fmt':     f'Rp {harga:,}'.replace(',', '.') if harga else 'Belum diset',
        'rate_down':     rate_down,
        'rate_up':       rate_up,
        'rx_power':      onu['rx_power'],
        'tx_power':      onu['tx_power'],
        'sn':            onu['sn'],
        'slot_port':     onu['slot_port'],
        'vlan':          onu['vlan'],
        'olt_name':      onu['olt_name'],
        'olt_tipe':      onu['olt_tipe'],
        'router_name':   p.get('device_name') or '',
        'tagihan_aktif': tagihan_aktif,
    }), 200


# ══════════════════════════════════════════════════════════════
# 5. STATUS REALTIME
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/status', methods=['GET'])
@portal_required
def portal_status():
    username = session[PORTAL_USERNAME_KEY]
    p = _get_pelanggan(username)
    if not p:
        return jsonify({'online': False}), 404

    if p.get('device_status') != 'connected' or not p.get('device_ip'):
        return jsonify({'online': False, 'ip': None, 'mac': None, 'uptime': None,
                        'router_name': p.get('device_name') or None}), 200
    try:
        from mikrotik import MikroTikClient, MikroTikError
        device = {
            'ip':       p['device_ip'],
            'port':     int(p.get('device_port') or 8728),
            'username': p['device_user'],
            'password': p['device_pass'],
        }
        with MikroTikClient(device) as mt:
            active = mt.get_active_connections()

        sess = next((c for c in active if (c.get('name') or '').lower() == username.lower()), None)
        if not sess:
            return jsonify({'online': False, 'ip': None, 'mac': None, 'uptime': None,
                            'router_name': p.get('device_name') or None}), 200

        return jsonify({
            'online':      True,
            'ip':          sess.get('address')   or None,
            'mac':         sess.get('caller-id') or None,
            'uptime':      sess.get('uptime')    or None,
            'router_name': p.get('device_name') or None,
            'bytes_in':    sess.get('bytes-in')  or None,
            'bytes_out':   sess.get('bytes-out') or None,
        }), 200

    except Exception as e:
        logger.warning(f'[Portal] Status error {username}: {e}')
        return jsonify({'online': False, 'ip': None, 'mac': None, 'uptime': None,
                        'router_name': p.get('device_name') or None}), 200


# ══════════════════════════════════════════════════════════════
# 6. RIWAYAT TAGIHAN (dari tabel tagihan)
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/tagihan', methods=['GET'])
@portal_required
def portal_tagihan():
    username = session[PORTAL_USERNAME_KEY]
    try:
        conn = _portal_db()
        rows = conn.execute(
            '''SELECT id, periode, profil, nominal, status, jatuh_tempo, paid_at, metode
               FROM tagihan WHERE username = ?
               ORDER BY periode DESC, id DESC LIMIT 24''',
            (username,)
        ).fetchall()
        conn.close()
    except Exception as e:
        logger.warning(f'[Portal] tagihan error: {e}')
        return jsonify({'tagihan': [], 'ringkasan': {}}), 200

    tagihan = [dict(r) for r in rows]
    lunas   = [t for t in tagihan if t['status'] == 'lunas']
    belum   = [t for t in tagihan if t['status'] == 'belum_bayar']

    return jsonify({
        'tagihan':   tagihan,
        'ringkasan': {
            'total_lunas':    sum(t['nominal'] for t in lunas),
            'jumlah_lunas':   len(lunas),
            'total_belum':    sum(t['nominal'] for t in belum),
            'jumlah_belum':   len(belum),
        }
    }), 200


# ══════════════════════════════════════════════════════════════
# 7. TIKET LAPORAN GANGGUAN
# ══════════════════════════════════════════════════════════════

def _ensure_tiket_table(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS tiket (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT NOT NULL, network_id TEXT DEFAULT '',
        kategori   TEXT DEFAULT 'Umum', judul TEXT NOT NULL,
        deskripsi  TEXT DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'Baru',
        catatan_cs TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    )''')
    conn.commit()


@portal_bp.route('/tiket', methods=['GET'])
@portal_required
def portal_tiket_list():
    username = session[PORTAL_USERNAME_KEY]
    try:
        conn = _portal_db()
        _ensure_tiket_table(conn)
        rows = conn.execute(
            '''SELECT id, kategori, judul, deskripsi, status, catatan_cs, created_at
               FROM tiket WHERE username = ? ORDER BY created_at DESC LIMIT 20''',
            (username,)
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows]), 200
    except Exception as e:
        logger.warning(f'[Portal] tiket list error: {e}')
        return jsonify([]), 200


@portal_bp.route('/tiket', methods=['POST'])
@portal_required
def portal_tiket_create():
    username = session[PORTAL_USERNAME_KEY]
    body     = request.get_json(silent=True) or {}
    judul     = (body.get('judul')     or '').strip()
    kategori  = (body.get('kategori')  or 'Umum').strip()
    deskripsi = (body.get('deskripsi') or '').strip()

    if not judul:
        return jsonify({'success': False, 'error': 'Judul laporan wajib diisi.'}), 400

    try:
        conn = _portal_db()
        _ensure_tiket_table(conn)

        aktif = conn.execute(
            "SELECT COUNT(*) FROM tiket WHERE username=? AND status IN ('Baru','Diproses')",
            (username,)
        ).fetchone()[0]
        if aktif >= 3:
            conn.close()
            return jsonify({'success': False, 'error': 'Anda sudah punya 3 laporan aktif. Tunggu hingga selesai.'}), 400

        conn.execute(
            'INSERT INTO tiket (username, kategori, judul, deskripsi) VALUES (?,?,?,?)',
            (username, kategori, judul, deskripsi)
        )
        conn.commit(); conn.close()
        logger.info(f'[Portal] Tiket baru: {username} — {judul}')
        return jsonify({'success': True, 'message': 'Laporan berhasil dikirim.'}), 201
    except Exception as e:
        logger.error(f'[Portal] tiket create error: {e}')
        return jsonify({'success': False, 'error': 'Gagal menyimpan laporan.'}), 500


# ══════════════════════════════════════════════════════════════
# 8. PERPANJANG PAKET — catat ke keuangan
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/perpanjang', methods=['POST'])
@portal_required
def portal_perpanjang():
    username = session[PORTAL_USERNAME_KEY]
    body     = request.get_json(silent=True) or {}
    metode   = (body.get('metode')  or 'Transfer').strip()
    catatan  = (body.get('catatan') or '').strip()

    p = _get_pelanggan(username)
    if not p:
        return jsonify({'success': False, 'error': 'Data pelanggan tidak ditemukan.'}), 404

    device_id   = p.get('device_id') or p.get('device_id_real')
    profil_name = p.get('profil') or ''
    harga       = _get_harga_profil(device_id, profil_name)
    if harga <= 0:
        return jsonify({'success': False, 'error': 'Harga paket belum diset. Hubungi admin.'}), 400

    try:
        conn = _portal_db()
        # Catat ke tabel keuangan sebagai Pending
        conn.execute(
            '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
               VALUES (?, ?, 'pemasukan', ?, 'Pending', ?, ?, ?)''',
            (
                date.today().isoformat(),
                f'Request perpanjang paket {profil_name} - {username}',
                harga, metode, username,
                catatan or f'Perpanjangan paket via portal pelanggan',
            )
        )
        trx_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        conn.commit(); conn.close()
    except Exception as e:
        logger.error(f'[Portal] perpanjang error: {e}')
        return jsonify({'success': False, 'error': 'Gagal menyimpan transaksi.'}), 500

    # Info rekening
    rekening_list = _rekening_info()
    info_bayar = rekening_list[0] if rekening_list else {
        'bank': '', 'nomor': '', 'nama': '',
        'ket': f'Transfer untuk {username} - paket {profil_name}'
    }

    logger.info(f'[Portal] Perpanjang: {username} Rp{harga:,} trx_id={trx_id}')

    # ── Notifikasi WA ke admin ISP ────────────────────────────
    try:
        import json as _json
        from wa import _load_config, _send_via_gateway
        from utils import get_db as get_owner_db

        _oconn     = get_owner_db()
        wa_cfg     = _load_config(_oconn)
        profil_row = _oconn.execute(
            "SELECT value FROM app_settings WHERE key='profil_isp'"
        ).fetchone()
        _oconn.close()

        profil_isp = {}
        if profil_row and profil_row['value']:
            profil_isp = _json.loads(profil_row['value'])

        wa_admin = (profil_isp.get('wa_admin') or '').strip()
        if wa_admin and wa_cfg.get('enabled') and wa_cfg.get('token'):
            nama_pelanggan = p.get('nama') or username
            harga_fmt      = f"Rp {harga:,}".replace(',', '.')
            pesan = (
                f"📩 *Request Perpanjang*\n"
                f"Pelanggan: *{nama_pelanggan}* ({username})\n"
                f"Paket: {profil_name}\n"
                f"Nominal: {harga_fmt}\n"
                f"Metode: {metode}\n"
                f"No. Ref: #{trx_id}"
                + (f"\nCatatan: {catatan}" if catatan else "") +
                f"\n\nSegera konfirmasi di halaman Keuangan."
            )
            _send_via_gateway(wa_cfg, wa_admin, pesan)
    except Exception as e_wa:
        logger.warning(f'[Portal] Notif WA admin gagal: {e_wa}')

    return jsonify({
        'success':     True,
        'trx_id':      trx_id,
        'nominal':     harga,
        'nominal_fmt': f'Rp {harga:,}'.replace(',', '.'),
        'info_bayar':  info_bayar,
        'rekening':    rekening_list,
    }), 201


# ══════════════════════════════════════════════════════════════
# 9. GANTI PASSWORD (nomor HP)
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/ganti-password', methods=['POST'])
@portal_required
def portal_ganti_password():
    username = session[PORTAL_USERNAME_KEY]
    body     = request.get_json(silent=True) or {}
    pwd_lama   = (body.get('password_lama') or '').strip()
    pwd_baru   = (body.get('password_baru') or '').strip()
    konfirmasi = (body.get('konfirmasi')    or '').strip()

    if not pwd_lama: return jsonify({'success': False, 'error': 'Nomor HP lama wajib diisi.'}), 400
    if not pwd_baru: return jsonify({'success': False, 'error': 'Nomor HP baru wajib diisi.'}), 400
    if len(pwd_baru) < 6: return jsonify({'success': False, 'error': 'Nomor HP baru minimal 6 digit.'}), 400
    if pwd_baru != konfirmasi: return jsonify({'success': False, 'error': 'Konfirmasi nomor tidak cocok.'}), 400

    try:
        conn = _portal_db()
        row = conn.execute(
            'SELECT id, hp, no_hp FROM pelanggan WHERE LOWER(username)=?',
            (username.lower(),)
        ).fetchone()
        if not row:
            conn.close()
            return jsonify({'success': False, 'error': 'Data pelanggan tidak ditemukan.'}), 404

        hp_db    = _normalize_phone(row['hp']    or '')
        no_hp_db = _normalize_phone(row['no_hp'] if 'no_hp' in row.keys() else '')
        pwd_norm = _normalize_phone(pwd_lama)

        if pwd_norm not in (hp_db, no_hp_db):
            conn.close()
            return jsonify({'success': False, 'error': 'Nomor HP lama tidak cocok.'}), 401

        conn.execute('UPDATE pelanggan SET hp=?, no_hp=? WHERE id=?',
                     (pwd_baru, pwd_baru, row['id']))
        conn.commit(); conn.close()
        logger.info(f'[Portal] Ganti HP: {username}')
        return jsonify({'success': True, 'message': 'Nomor HP berhasil diperbarui.'}), 200
    except Exception as e:
        logger.error(f'[Portal] ganti-password error: {e}')
        return jsonify({'success': False, 'error': 'Gagal memperbarui data.'}), 500


# ══════════════════════════════════════════════════════════════
# 10. REKENING — info pembayaran untuk pelanggan
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/rekening', methods=['GET'])
@portal_required
def portal_rekening():
    """Kembalikan info rekening bank owner untuk transfer manual."""
    return jsonify({'rekening': _rekening_info()}), 200


# ══════════════════════════════════════════════════════════════
# 11. UBAH WIFI (via GenieACS) — pelanggan ganti SSID/password WiFi
# ══════════════════════════════════════════════════════════════

@portal_bp.route('/wifi', methods=['POST'])
@portal_required
def portal_wifi():
    """
    Pelanggan ubah SSID dan/atau password WiFi modem/ONU via GenieACS.
    Butuh SN modem terdaftar di onu_mapping.
    """
    username = session[PORTAL_USERNAME_KEY]
    body     = request.get_json(silent=True) or {}
    ssid     = (body.get('ssid')     or '').strip()
    password = (body.get('password') or '').strip()

    if not ssid and not password:
        return jsonify({'success': False, 'error': 'SSID atau password WiFi wajib diisi.'}), 400
    if password and len(password) < 8:
        return jsonify({'success': False, 'error': 'Password WiFi minimal 8 karakter.'}), 400

    # Ambil SN dari onu_mapping
    onu = _get_onu_data(username)
    sn  = onu.get('sn', '')
    if not sn:
        return jsonify({'success': False, 'error': 'Serial Number modem belum terdaftar. Hubungi admin.'}), 400

    # Panggil GenieACS wifi endpoint internal
    try:
        import urllib.request, urllib.parse, json as _jj
        from utils import get_owner_db

        nid  = session.get(PORTAL_NETWORK_ID_KEY)
        conn = get_owner_db(nid)
        row  = conn.execute(
            "SELECT value FROM app_settings WHERE key='genieacs_url'"
        ).fetchone()
        token_row = conn.execute(
            "SELECT value FROM app_settings WHERE key='genieacs_token'"
        ).fetchone()
        enabled_row = conn.execute(
            "SELECT value FROM app_settings WHERE key='genieacs_enabled'"
        ).fetchone()
        conn.close()

        gurl     = (row['value']         if row         else '').strip().rstrip('/')
        gtoken   = (token_row['value']   if token_row   else '').strip()
        genabled = (enabled_row['value'] if enabled_row else '0') == '1'

        if not (genabled and gurl and gtoken):
            # Mock mode — tidak ada GenieACS aktif
            logger.info(f'[Portal WiFi] Mock mode — SN={sn} SSID={ssid}')
            return jsonify({
                'success': True,
                'mock':    True,
                'message': 'Permintaan diterima. Pengaturan WiFi akan diperbarui dalam beberapa menit (mode simulasi).',
            }), 200

        # Kirim ke GenieACS NBI
        import base64
        dev_id    = urllib.parse.quote(sn)
        pv        = []
        base_path = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.'
        if ssid:
            pv.append([base_path + 'SSID', ssid, 'xsd:string'])
        if password:
            pv.append([base_path + 'PreSharedKey.1.PreSharedKey', password, 'xsd:string'])
            pv.append([base_path + 'KeyPassphrase', password, 'xsd:string'])

        path    = f'{gurl}/devices/{dev_id}/tasks?connection_request'
        payload = _jj.dumps({'name': 'setParameterValues', 'parameterValues': pv}).encode()
        tok     = base64.b64encode(f'{gtoken}:'.encode()).decode()
        req     = urllib.request.Request(path, data=payload,
                    headers={'Content-Type': 'application/json', 'Authorization': 'Basic ' + tok},
                    method='POST')
        urllib.request.urlopen(req, timeout=8)

        logger.info(f'[Portal WiFi] Berhasil kirim ke GenieACS — SN={sn}')
        return jsonify({'success': True, 'mock': False, 'message': 'Pengaturan WiFi berhasil dikirim ke modem.'}), 200

    except Exception as e:
        logger.warning(f'[Portal WiFi] Error: {e}')
        return jsonify({'success': True, 'mock': True,
                        'message': 'Permintaan diterima. Pengaturan WiFi akan diperbarui dalam beberapa menit.'}), 200
