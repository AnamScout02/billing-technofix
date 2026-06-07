"""
auth.py — TechnoFix · Blueprint Autentikasi Multi-Tenant
============================================================
Menyediakan endpoint Login & Registrasi ISP (SaaS Multi-Tenant).

Fitur:
  - POST /api/auth/register  → Daftarkan ISP baru (Owner)
  - POST /api/auth/login     → Login Owner / Teknisi
  - POST /api/auth/logout    → Hapus session
  - POST /api/auth/invite    → Owner undang Teknisi (invite-only)
  - GET  /api/auth/me        → Info user yang sedang login
  - GET  /api/auth/team      → Daftar anggota tim (Owner only)
  - DELETE /api/auth/team/<id> → Hapus anggota tim (Owner only)

Keamanan:
  - Password di-hash dengan werkzeug.security (pbkdf2:sha256)
  - Session Flask (server-side) dengan HttpOnly cookie
  - Setiap data (devices, olt, pelanggan) difilter berdasarkan network_id
  - Decorator @login_required dan @owner_required untuk proteksi endpoint

Penggunaan Decorator:
  from auth import login_required, owner_required

  @some_bp.route('/data')
  @login_required
  def protected_route():
      user = g.current_user   ← dict: {id, username, role, network_id, isp_name}
      ...

  @some_bp.route('/admin')
  @owner_required
  def owner_only_route():
      ...
"""

import uuid
import secrets
import logging
from functools import wraps

from flask import Blueprint, request, jsonify, session, g
from werkzeug.security import generate_password_hash, check_password_hash

# auth.py HANYA menyentuh tabel master (networks, users, superadmins).
# Alias get_master_db sebagai get_db → semua query di file ini otomatis
# ke master.db, tanpa perlu ubah tiap pemanggilan.
from utils import get_master_db as get_db, get_owner_db

# ── Blueprint ──────────────────────────────────────────────────
auth_bp = Blueprint('auth', __name__)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Batas durasi sesi sejak login pertama (bukan sejak request terakhir).
# Lewat batas ini user harus login ulang meski masih aktif.
SESSION_LEASE_HOURS = 1


# ══════════════════════════════════════════════════════════════
# INISIALISASI TABEL
# ══════════════════════════════════════════════════════════════

def init_auth_tables():
    """
    Buat tabel 'networks' dan 'users' jika belum ada.

    Tabel networks: menyimpan informasi ISP/jaringan
    Tabel users   : menyimpan akun Owner & Teknisi
    """
    conn = get_db()

    # Tabel ISP / Jaringan
    conn.execute('''
        CREATE TABLE IF NOT EXISTS networks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            network_id TEXT    NOT NULL UNIQUE,
            isp_name   TEXT    NOT NULL,
            paket      TEXT    DEFAULT 'trial',
            status     TEXT    DEFAULT 'trial',   -- trial | active | locked | suspended
            trial_end  TEXT    DEFAULT '',        -- ISO datetime akhir trial
            expired_at TEXT    DEFAULT '',         -- ISO datetime akhir langganan berbayar
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # Migrasi: tambah kolom baru bila tabel sudah ada sebelumnya
    for sql in (
        "ALTER TABLE networks ADD COLUMN paket TEXT DEFAULT 'trial'",
        "ALTER TABLE networks ADD COLUMN status TEXT DEFAULT 'trial'",
        "ALTER TABLE networks ADD COLUMN trial_end TEXT DEFAULT ''",
        "ALTER TABLE networks ADD COLUMN expired_at TEXT DEFAULT ''",
    ):
        try:
            conn.execute(sql)
        except Exception:
            pass

    # Tabel User (Owner & Teknisi)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            network_id    TEXT    NOT NULL,
            username      TEXT    NOT NULL,
            password_hash TEXT    NOT NULL,
            role          TEXT    NOT NULL DEFAULT 'teknisi',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(network_id, username),
            FOREIGN KEY(network_id) REFERENCES networks(network_id)
        )
    ''')
    # Migrasi: token sesi aktif — dipakai untuk batasi login ke 1 perangkat.
    # Login baru menulis token baru ke sini; sesi lama (token berbeda) ditolak.
    try:
        conn.execute("ALTER TABLE users ADD COLUMN session_token TEXT DEFAULT ''")
    except Exception:
        pass

    # Tabel permintaan upgrade paket (owner → superadmin approve)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS upgrade_requests (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            network_id  TEXT    NOT NULL,
            isp_name    TEXT    DEFAULT '',
            paket       TEXT    NOT NULL,
            bulan       INTEGER DEFAULT 1,
            status      TEXT    DEFAULT 'pending',   -- pending | approved | rejected
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            handled_at  TEXT    DEFAULT ''
        )
    ''')

    conn.commit()
    conn.close()
    logger.info('[Auth] Tabel auth siap.')


# Inisialisasi saat modul diimport
init_auth_tables()


def init_superadmin_table():
    """
    Buat tabel 'superadmins' jika belum ada.
    Superadmin adalah akun pengelola website — terpisah total
    dari tabel users (Owner/Teknisi ISP).
    """
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS superadmins (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login    DATETIME
        )
    ''')
    conn.commit()
    conn.close()
    logger.info('[Auth] Tabel superadmins siap.')


init_superadmin_table()


def init_platform_tables():
    """Tabel platform-level di master DB: platform_settings, genieacs_devices."""
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS platform_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS genieacs_devices (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id  TEXT NOT NULL UNIQUE,
            serial     TEXT DEFAULT '',
            network_id TEXT NOT NULL,
            linked_at  TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()


init_platform_tables()


# ══════════════════════════════════════════════════════════════
# HELPER — Ambil user dari session
# ══════════════════════════════════════════════════════════════

def get_current_user() -> dict | None:
    """
    Baca session aktif dan kembalikan data user dari database.
    Return None jika tidak ada session valid.

    Termasuk cek single-device login: token sesi yang tersimpan di
    cookie harus cocok dengan token aktif di DB (`users.session_token`).
    Token beda berarti akun sudah login ulang di perangkat/browser lain
    — sesi ini otomatis dianggap habis (lihat g._session_replaced).
    """
    user_id    = session.get('user_id')
    network_id = session.get('network_id')

    if not user_id or not network_id:
        return None

    conn = get_db()
    row  = conn.execute(
        '''SELECT u.id, u.username, u.role, u.network_id, u.session_token, n.isp_name
           FROM users u
           JOIN networks n ON n.network_id = u.network_id
           WHERE u.id = ? AND u.network_id = ?''',
        (user_id, network_id)
    ).fetchone()
    conn.close()

    if not row:
        return None

    if row['session_token'] and session.get('session_token') != row['session_token']:
        session.clear()
        g._session_replaced = True
        return None

    return {
        'id':         row['id'],
        'username':   row['username'],
        'role':       row['role'],
        'network_id': row['network_id'],
        'isp_name':   row['isp_name'],
    }


def _sesi_habis_response():
    """
    401 standar untuk sesi tidak valid — pesan disesuaikan bila
    penyebabnya akun login ulang di perangkat lain (lihat g._session_replaced
    yang diset get_current_user saat token sesi tidak cocok dengan DB).
    """
    if getattr(g, '_session_replaced', False):
        return jsonify({
            'status':  'error',
            'code':    'session_replaced',
            'message': 'Akun ini baru saja login di perangkat/browser lain. Silakan login kembali.',
        }), 401
    return jsonify({'status': 'error', 'message': 'Sesi habis, silakan login kembali'}), 401


# ══════════════════════════════════════════════════════════════
# DECORATOR — Proteksi Endpoint
# ══════════════════════════════════════════════════════════════

def login_required(f):
    """
    Decorator: pastikan user sudah login.
    Menyimpan data user ke g.current_user.

    Contoh pemakaian:
        @api_bp.route('/data')
        @login_required
        def get_data():
            network_id = g.current_user['network_id']
            ...
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return _sesi_habis_response()
        g.current_user = user
        g.network_id   = user['network_id']   # → dipakai get_db() owner-aware
        return f(*args, **kwargs)
    return decorated


def guard_request(allow_locked: bool = False, perm: str = None):
    """
    Guard terpusat untuk before_request blueprint data.
      - Wajib login (set g.current_user, g.network_id)
      - Tolak jika sesi melebihi SESSION_LEASE_HOURS sejak login (paksa login ulang)
      - Tolak jika langganan terkunci (trial habis / expired), kecuali
        allow_locked=True.
      - Jika `perm` diberikan: tolak bila peran user tidak punya permission
        tersebut (owner selalu lolos).
    Return None jika lolos, atau tuple (response, status) jika ditolak.
    """
    from datetime import datetime, timedelta
    user = get_current_user()
    if not user:
        return _sesi_habis_response()

    login_at = session.get('login_at')
    if login_at:
        try:
            if datetime.now() - datetime.fromisoformat(login_at) > timedelta(hours=SESSION_LEASE_HOURS):
                session.clear()
                return jsonify({'status': 'error', 'code': 'session_expired',
                                'message': 'Sesi login telah berakhir, silakan login kembali'}), 401
        except (ValueError, TypeError):
            session.clear()
            return jsonify({'status': 'error', 'message': 'Sesi tidak valid, silakan login kembali'}), 401
    g.current_user = user
    g.network_id   = user['network_id']

    if not allow_locked:
        from utils import get_effective_status
        st = get_effective_status(user['network_id'])
        if st in ('locked', 'suspended'):
            return jsonify({
                'status':  'error',
                'code':    'subscription_locked',
                'message': 'Masa trial / langganan telah berakhir. '
                           'Silakan pilih atau perpanjang paket untuk melanjutkan.',
            }), 402

    if perm:
        from roles import role_has
        if not role_has(user['role'], perm):
            return jsonify({
                'status':  'error',
                'code':    'permission_denied',
                'message': 'Akses ditolak untuk peran Anda.',
            }), 403
    return None


def owner_required(f):
    """
    Decorator: hanya Owner yang boleh akses.
    Otomatis mencakup @login_required.

    Contoh pemakaian:
        @api_bp.route('/keuangan')
        @owner_required
        def keuangan():
            ...
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return _sesi_habis_response()
        if user['role'] != 'owner':
            return jsonify({'status': 'error', 'message': 'Akses ditolak. Hanya Owner yang diizinkan'}), 403
        g.current_user = user
        g.network_id   = user['network_id']   # → dipakai get_db() owner-aware
        return f(*args, **kwargs)
    return decorated


# ══════════════════════════════════════════════════════════════
# ENDPOINT 1 — POST /api/auth/register
# Daftarkan ISP baru (Owner pertama)
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/register', methods=['POST'])
def register():
    """
    Pendaftaran ISP baru. Membuat:
      - Satu network baru (dengan UUID unik sebagai network_id)
      - Satu akun Owner untuk ISP tersebut

    Body JSON:
    {
      "isp_name"  : "ISP Maju Jaya",
      "username"  : "admin_maju",
      "password"  : "rahasia123"
    }

    Response sukses:
    {
      "status"     : "success",
      "message"    : "ISP berhasil didaftarkan",
      "network_id" : "uuid-...",
      "username"   : "admin_maju",
      "role"       : "owner"
    }
    """
    data = request.get_json(silent=True) or {}

    from packages import PACKAGES, DEFAULT_PACKAGE, TRIAL_DAYS

    isp_name = data.get('isp_name', '').strip()
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    paket    = (data.get('paket', '') or DEFAULT_PACKAGE).strip().lower()
    if paket not in PACKAGES:
        paket = DEFAULT_PACKAGE

    # Validasi input
    if not isp_name:
        return jsonify({'status': 'error', 'message': 'Nama ISP wajib diisi'}), 400
    if not username:
        return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password or len(password) < 6:
        return jsonify({'status': 'error', 'message': 'Password minimal 6 karakter'}), 400

    conn = get_db()

    # Cek apakah username sudah dipakai di seluruh sistem (opsional, bisa per-ISP)
    existing = conn.execute(
        'SELECT id FROM users WHERE username = ?', (username,)
    ).fetchone()
    if existing:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Username sudah digunakan'}), 409

    # Buat network_id unik
    network_id    = str(uuid.uuid4())
    password_hash = generate_password_hash(password)

    try:
        from datetime import datetime, timedelta
        trial_end = (datetime.now() + timedelta(days=TRIAL_DAYS)).isoformat()
        conn.execute(
            '''INSERT INTO networks (network_id, isp_name, paket, status, trial_end)
               VALUES (?, ?, ?, 'trial', ?)''',
            (network_id, isp_name, paket, trial_end)
        )
        conn.execute(
            '''INSERT INTO users (network_id, username, password_hash, role)
               VALUES (?, ?, ?, 'owner')''',
            (network_id, username, password_hash)
        )
        conn.commit()
        logger.info(f'[Auth] ISP baru: "{isp_name}" (network_id={network_id}, owner={username})')

    except Exception as e:
        conn.rollback()
        conn.close()
        logger.error(f'[Auth] Registrasi gagal: {e}')
        return jsonify({'status': 'error', 'message': 'Gagal menyimpan data. Coba lagi.'}), 500

    conn.close()

    # ── Buat file DB owner baru + init skema operasional ──
    # Tiap owner punya file DB terpisah (isolasi penuh Opsi B).
    try:
        owner_conn = get_owner_db(network_id)
        owner_conn.close()
        logger.info(f'[Auth] File DB owner dibuat: {network_id}.db')
    except Exception as e:
        logger.error(f'[Auth] Gagal buat DB owner {network_id}: {e}')
        # Tidak fatal untuk registrasi — file akan dibuat lazy saat login
    return jsonify({
        'status':     'success',
        'message':    f'ISP "{isp_name}" berhasil didaftarkan',
        'network_id': network_id,
        'username':   username,
        'role':       'owner',
        'paket':      paket,
    }), 201


# ══════════════════════════════════════════════════════════════
# ENDPOINT 2 — POST /api/auth/login
# Login untuk Owner dan Teknisi
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/login', methods=['POST'])
def login():
    """
    Login user (Owner maupun Teknisi).

    Body JSON:
    {
      "username" : "admin_maju",
      "password" : "rahasia123"
    }

    Response sukses:
    {
      "status"     : "success",
      "message"    : "Selamat datang, admin_maju",
      "user"       : {
        "id"        : 1,
        "username"  : "admin_maju",
        "role"      : "owner",
        "network_id": "uuid-...",
        "isp_name"  : "ISP Maju Jaya"
      }
    }
    """
    data = request.get_json(silent=True) or {}

    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    if not username or not password:
        return jsonify({'status': 'error', 'message': 'Username dan password wajib diisi'}), 400

    conn = get_db()
    row  = conn.execute(
        '''SELECT u.id, u.username, u.password_hash, u.role, u.network_id,
                  u.nama, u.permissions, u.aktif,
                  n.isp_name
           FROM users u
           JOIN networks n ON n.network_id = u.network_id
           WHERE u.username = ?''',
        (username,)
    ).fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({'status': 'error', 'message': 'Username atau password salah'}), 401

    # Cek akun aktif (kolom aktif bisa NULL pada akun lama — anggap aktif)
    if row['aktif'] is not None and row['aktif'] == 0:
        return jsonify({'status': 'error', 'message': 'Akun tidak aktif. Hubungi Owner.'}), 403

    # Parse permissions (disimpan sebagai JSON string di DB)
    import json as _json
    try:
        permissions = _json.loads(row['permissions'] or '[]')
        if not isinstance(permissions, list):
            permissions = []
    except Exception:
        permissions = []

    # Single-device login: buat token sesi baru & simpan ke DB.
    # Sesi lama (di perangkat/browser lain) otomatis ditolak pada
    # request berikutnya karena token-nya sudah tidak cocok lagi.
    new_token = secrets.token_hex(32)
    conn = get_db()
    conn.execute('UPDATE users SET session_token = ? WHERE id = ?', (new_token, row['id']))
    conn.commit()
    conn.close()

    # Simpan ke session Flask (server-side, HttpOnly cookie otomatis)
    session.clear()
    session['user_id']       = row['id']
    session['network_id']    = row['network_id']
    session['session_token'] = new_token
    from datetime import datetime as _dt
    session['login_at']      = _dt.now().isoformat()
    session.permanent        = True   # Durasi diatur di app.py via PERMANENT_SESSION_LIFETIME

    user_data = {
        'id':          row['id'],
        'username':    row['username'],
        'nama':        row['nama']     or row['username'],
        'role':        row['role'],
        'network_id':  row['network_id'],
        'isp_name':    row['isp_name'],
        'permissions': permissions,   # ← dipakai applyUIPermissions() di frontend
    }

    logger.info(f'[Auth] Login: {username} ({row["role"]}) @ {row["network_id"]}')
    return jsonify({
        'status':  'success',
        'message': f'Selamat datang, {username}',
        'user':    user_data,
    }), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 3 — POST /api/auth/logout
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/logout', methods=['POST'])
def logout():
    """Hapus session, kosongkan token sesi di DB, lalu kembalikan response sukses."""
    user_id = session.get('user_id', 'unknown')
    if isinstance(user_id, int):
        try:
            conn = get_db()
            conn.execute("UPDATE users SET session_token = '' WHERE id = ?", (user_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass
    session.clear()
    logger.info(f'[Auth] Logout: user_id={user_id}')
    return jsonify({'status': 'success', 'message': 'Berhasil logout'}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 4 — GET /api/auth/me
# Cek session aktif & kembalikan data user
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/me', methods=['GET'])
@login_required
def me():
    """Kembalikan data lengkap user yang sedang login."""
    conn = get_db()
    row = conn.execute(
        'SELECT id, username, role, network_id, nama, hp, aktif FROM users WHERE id=?',
        (g.current_user['id'],)
    ).fetchone()
    # Info ISP dari networks
    net = conn.execute(
        'SELECT isp_name, paket, status FROM networks WHERE network_id=?',
        (g.current_user['network_id'],)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({'status': 'error', 'message': 'User tidak ditemukan'}), 404
    return jsonify({
        'status': 'success',
        'user': {
            'id':         row['id'],
            'username':   row['username'],
            'role':       row['role'],
            'network_id': row['network_id'],
            'nama':       row['nama'] or row['username'],
            'hp':         row['hp'] or '',
            'isp_name':   net['isp_name'] if net else '',
            'paket':      net['paket'] if net else '',
        },
    }), 200


@auth_bp.route('/me', methods=['PUT'])
@login_required
def update_me():
    """Update data profil user yang sedang login (nama, hp, password)."""
    data     = request.get_json(silent=True) or {}
    nama     = (data.get('nama') or '').strip()
    hp       = (data.get('hp') or '').strip()
    password_baru = (data.get('password_baru') or '').strip()
    password_lama = (data.get('password_lama') or '').strip()

    conn = get_db()
    row  = conn.execute('SELECT * FROM users WHERE id=?', (g.current_user['id'],)).fetchone()
    if not row:
        conn.close(); return jsonify({'status': 'error', 'message': 'User tidak ditemukan'}), 404

    # Update nama dan hp
    if nama:
        conn.execute('UPDATE users SET nama=? WHERE id=?', (nama, row['id']))
    if hp is not None:
        conn.execute('UPDATE users SET hp=? WHERE id=?', (hp, row['id']))

    # Ganti password jika dikirim
    if password_baru:
        if not password_lama:
            conn.close(); return jsonify({'status': 'error', 'message': 'Password lama wajib diisi'}), 400
        from werkzeug.security import check_password_hash, generate_password_hash
        if not check_password_hash(row['password_hash'], password_lama):
            conn.close(); return jsonify({'status': 'error', 'message': 'Password lama salah'}), 400
        if len(password_baru) < 6:
            conn.close(); return jsonify({'status': 'error', 'message': 'Password baru minimal 6 karakter'}), 400
        conn.execute('UPDATE users SET password_hash=? WHERE id=?',
                     (generate_password_hash(password_baru), row['id']))

    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Profil berhasil diperbarui'}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 5 — POST /api/auth/invite
# Owner mengundang Teknisi (invite-only)
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/invite', methods=['POST'])
@owner_required
def invite_teknisi():
    """
    Owner membuat akun Teknisi baru dalam jaringannya.
    Hanya bisa diakses oleh Owner.

    Body JSON:
    {
      "username" : "teknisi_budi",
      "password" : "pass123"
    }
    """
    import json as _json
    from roles import ALLOWED_ROLES, default_permissions, ROLE_LABEL

    data = request.get_json(silent=True) or {}

    username   = data.get('username', '').strip()
    password   = data.get('password', '').strip()
    nama       = data.get('nama', '').strip() or username
    role       = (data.get('role', 'teknisi') or 'teknisi').strip().lower()
    network_id = g.current_user['network_id']

    # Owner tidak bisa dibuat lewat invite (hanya 1 owner = pendaftar)
    if role not in ('admin', 'teknisi', 'kolektor'):
        return jsonify({'status': 'error',
                        'message': 'Peran harus admin, teknisi, atau kolektor'}), 400
    if not username:
        return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password or len(password) < 6:
        return jsonify({'status': 'error', 'message': 'Password minimal 6 karakter'}), 400

    # ── Batas anggota tim sesuai paket ──
    from utils import get_network_package
    from packages import package_limit
    conn = get_db()
    team_limit = package_limit(get_network_package(network_id), 'team')
    if team_limit is not None:
        jml = conn.execute(
            'SELECT COUNT(*) FROM users WHERE network_id = ?', (network_id,)
        ).fetchone()[0]
        if jml >= team_limit:
            conn.close()
            return jsonify({'status': 'error',
                            'message': f'Batas anggota tim paket tercapai ({jml}/{team_limit}). Upgrade paket.'}), 403

    existing = conn.execute(
        'SELECT id FROM users WHERE username = ?', (username,)
    ).fetchone()
    if existing:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Username sudah digunakan'}), 409

    password_hash = generate_password_hash(password)
    perms_json    = _json.dumps(default_permissions(role))
    try:
        conn.execute(
            '''INSERT INTO users (network_id, username, password_hash, role, nama, permissions)
               VALUES (?, ?, ?, ?, ?, ?)''',
            (network_id, username, password_hash, role, nama, perms_json)
        )
        conn.commit()
        logger.info(f'[Auth] {role} baru: {username} @ {network_id} (oleh {g.current_user["username"]})')
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'status': 'error', 'message': f'Gagal membuat akun: {e}'}), 500

    conn.close()
    return jsonify({
        'status':  'success',
        'message': f'Akun {ROLE_LABEL.get(role, role)} "{username}" berhasil dibuat',
        'username': username,
        'role':    role,
    }), 201


# ══════════════════════════════════════════════════════════════
# ENDPOINT 6 — GET /api/auth/team
# Daftar anggota tim dalam satu network (Owner only)
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/team', methods=['GET'])
@owner_required
def get_team():
    """
    Kembalikan daftar semua user dalam jaringan milik Owner.
    Hanya Owner yang bisa melihat daftar ini.
    """
    import json as _json
    network_id = g.current_user['network_id']
    conn = get_db()
    rows = conn.execute(
        '''SELECT id, username, role, nama, permissions, aktif, created_at
           FROM users
           WHERE network_id = ?
           ORDER BY role DESC, username''',
        (network_id,)
    ).fetchall()
    conn.close()

    members = []
    for r in rows:
        try:
            perms = _json.loads(r['permissions'] or '[]')
            if not isinstance(perms, list):
                perms = []
        except Exception:
            perms = []
        members.append({
            'id':          r['id'],
            'username':    r['username'],
            'nama':        (r['nama'] if 'nama' in r.keys() else '') or r['username'],
            'role':        r['role'],
            'permissions': perms,
            'aktif':       1 if (r['aktif'] is None or r['aktif'] == 1) else 0,
            'created_at':  r['created_at'],
        })

    return jsonify({'status': 'success', 'members': members}), 200


# ── POST /api/auth/team/<id>/toggle — aktif/nonaktif anggota ────
@auth_bp.route('/team/<int:target_id>/toggle', methods=['POST'])
@owner_required
def toggle_team_member(target_id):
    """Aktifkan / nonaktifkan anggota tim (Owner only, bukan diri sendiri)."""
    network_id = g.current_user['network_id']
    if target_id == g.current_user['id']:
        return jsonify({'status': 'error', 'message': 'Tidak bisa menonaktifkan akun sendiri'}), 400
    conn = get_db()
    row = conn.execute(
        'SELECT aktif, role FROM users WHERE id = ? AND network_id = ?',
        (target_id, network_id)
    ).fetchone()
    if not row:
        conn.close()
        return jsonify({'status': 'error', 'message': 'User tidak ditemukan'}), 404
    if row['role'] == 'owner':
        conn.close()
        return jsonify({'status': 'error', 'message': 'Owner tidak bisa dinonaktifkan'}), 400
    baru = 0 if (row['aktif'] is None or row['aktif'] == 1) else 1
    conn.execute('UPDATE users SET aktif = ? WHERE id = ?', (baru, target_id))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'aktif': baru,
                    'message': 'User diaktifkan' if baru else 'User dinonaktifkan'}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 7 — DELETE /api/auth/team/<user_id>
# Hapus anggota tim (Owner only, tidak bisa hapus diri sendiri)
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/team/<int:target_id>', methods=['DELETE'])
@owner_required
def remove_team_member(target_id):
    """
    Hapus akun Teknisi dari jaringan.
    Owner tidak bisa menghapus akunnya sendiri.
    """
    owner = g.current_user

    if target_id == owner['id']:
        return jsonify({'status': 'error', 'message': 'Tidak bisa menghapus akun sendiri'}), 400

    conn    = get_db()
    target  = conn.execute(
        'SELECT id, username, role, network_id FROM users WHERE id = ?',
        (target_id,)
    ).fetchone()

    if not target:
        conn.close()
        return jsonify({'status': 'error', 'message': 'User tidak ditemukan'}), 404

    # Pastikan target berada di jaringan yang sama
    if target['network_id'] != owner['network_id']:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Akses ditolak'}), 403

    # Tidak bisa hapus Owner lain
    if target['role'] == 'owner':
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tidak bisa menghapus akun Owner lain'}), 403

    conn.execute('DELETE FROM users WHERE id = ?', (target_id,))
    conn.commit()
    conn.close()

    logger.info(f'[Auth] Hapus user: {target["username"]} oleh {owner["username"]}')
    return jsonify({'status': 'success', 'message': f'Akun {target["username"]} berhasil dihapus'}), 200


# ══════════════════════════════════════════════════════════════
# UPGRADE PAKET — owner ajukan, superadmin setujui
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/upgrade-request', methods=['POST'])
@owner_required
def upgrade_request():
    """
    Owner mengajukan upgrade/perpanjangan paket.
    Body: { "paket": "pro", "bulan": 1 }
    Dibuat sebagai permintaan 'pending' → superadmin menyetujui.
    (Boleh diakses meski langganan locked — owner_required tidak cek lock.)
    """
    from packages import PACKAGES
    data  = request.get_json(silent=True) or {}
    paket = (data.get('paket', '') or '').strip().lower()
    bulan = int(data.get('bulan', 1) or 1)
    if paket not in PACKAGES or paket == 'trial':
        return jsonify({'status': 'error', 'message': 'Paket tidak valid'}), 400

    nid  = g.current_user['network_id']
    isp  = g.current_user.get('isp_name', '')
    conn = get_db()
    # Hindari duplikat pending untuk paket sama
    dup = conn.execute(
        "SELECT id FROM upgrade_requests WHERE network_id=? AND status='pending'",
        (nid,)
    ).fetchone()
    if dup:
        conn.execute(
            "UPDATE upgrade_requests SET paket=?, bulan=?, created_at=CURRENT_TIMESTAMP WHERE id=?",
            (paket, bulan, dup['id'])
        )
    else:
        conn.execute(
            "INSERT INTO upgrade_requests (network_id, isp_name, paket, bulan) VALUES (?, ?, ?, ?)",
            (nid, isp, paket, bulan)
        )
    conn.commit(); conn.close()
    logger.info(f'[Upgrade] {isp} ajukan {paket} ({bulan} bln)')
    return jsonify({'status': 'success',
                    'message': 'Permintaan upgrade terkirim. Admin akan mengkonfirmasi pembayaran & mengaktifkan paket Anda.'}), 201


# ══════════════════════════════════════════════════════════════
# SUPERADMIN — Decorator & Endpoints
# Session superadmin disimpan di session['superadmin_id'],
# TERPISAH dari session user ISP biasa.
# ══════════════════════════════════════════════════════════════

def superadmin_required(f):
    """
    Decorator: pastikan yang mengakses adalah superadmin aktif.

    Contoh pemakaian:
        @auth_bp.route('/admin/networks')
        @superadmin_required
        def list_networks():
            ...
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('superadmin_id'):
            return jsonify({'status': 'error', 'message': 'Akses ditolak. Login sebagai superadmin.'}), 403
        return f(*args, **kwargs)
    return decorated


# ── POST /api/auth/admin/login ────────────────────────────────
@auth_bp.route('/admin/login', methods=['POST'])
def superadmin_login():
    """
    Login khusus superadmin. Menggunakan session key berbeda
    ('superadmin_id') agar tidak tumpang tindih dengan session ISP.

    Body JSON:
    { "username": "...", "password": "..." }
    """
    data     = request.get_json(silent=True) or {}
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    if not username or not password:
        return jsonify({'status': 'error', 'message': 'Username dan password wajib diisi'}), 400

    conn = get_db()
    row  = conn.execute(
        'SELECT id, username, password_hash FROM superadmins WHERE username = ?',
        (username,)
    ).fetchone()

    if not row or not check_password_hash(row['password_hash'], password):
        logger.warning(f'[SuperAdmin] Gagal login: {username}')
        conn.close()
        return jsonify({'status': 'error', 'message': 'Username atau password salah'}), 401

    # Update last_login
    conn.execute(
        'UPDATE superadmins SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
        (row['id'],)
    )
    conn.commit()
    conn.close()

    # Hapus sesi owner/user yang mungkin masih aktif agar tidak tumpang tindih
    session.clear()
    session['superadmin_id']       = row['id']
    session['superadmin_username'] = row['username']
    session.permanent = True

    logger.info(f'[SuperAdmin] Login: {username}')
    return jsonify({
        'status':   'success',
        'message':  f'Selamat datang, {username}',
        'username': row['username'],
    }), 200


# ── POST /api/auth/admin/logout ───────────────────────────────
@auth_bp.route('/admin/logout', methods=['POST'])
def superadmin_logout():
    """Hapus seluruh session (termasuk sisa sesi user biasa)."""
    username = session.get('superadmin_username', 'unknown')
    session.clear()
    logger.info(f'[SuperAdmin] Logout: {username}')
    return jsonify({'status': 'success', 'message': 'Berhasil logout'}), 200


# ── GET /api/auth/admin/me ────────────────────────────────────
@auth_bp.route('/admin/me', methods=['GET'])
@superadmin_required
def superadmin_me():
    """Cek session superadmin aktif (dipakai frontend saat load halaman)."""
    return jsonify({
        'status':   'success',
        'username': session.get('superadmin_username'),
    }), 200


# ── GET /api/auth/admin/networks ─────────────────────────────
@auth_bp.route('/admin/networks', methods=['GET'])
@superadmin_required
def admin_list_networks():
    """Daftar semua ISP/jaringan + info paket & status langganan."""
    from utils import get_effective_status
    from packages import get_package
    conn  = get_db()
    rows  = conn.execute(
        '''SELECT n.network_id, n.isp_name, n.created_at,
                  n.paket, n.status, n.trial_end, n.expired_at,
                  COUNT(u.id) AS jumlah_user
           FROM networks n
           LEFT JOIN users u ON u.network_id = n.network_id
           GROUP BY n.network_id
           ORDER BY n.created_at DESC'''
    ).fetchall()
    conn.close()

    out = []
    for r in rows:
        paket = r['paket'] or 'trial'
        out.append({
            'network_id':  r['network_id'],
            'isp_name':    r['isp_name'],
            'created_at':  r['created_at'],
            'jumlah_user': r['jumlah_user'],
            'paket':       paket,
            'paket_nama':  get_package(paket)['name'],
            'status':      r['status'] or 'trial',
            'status_efektif': get_effective_status(r['network_id']),
            'trial_end':   r['trial_end'] or '',
            'expired_at':  r['expired_at'] or '',
        })

    return jsonify({'status': 'success', 'networks': out}), 200


# ── POST /admin/networks/<id>/activate — aktifkan paket berbayar ──
@auth_bp.route('/admin/networks/<network_id>/activate', methods=['POST'])
@superadmin_required
def admin_activate(network_id):
    """
    Aktifkan langganan owner setelah bayar.
    Body: { "paket": "pro", "bulan": 1 }  → status active, expired +N bulan.
    """
    from packages import PACKAGES
    from datetime import datetime, timedelta
    data  = request.get_json(silent=True) or {}
    paket = (data.get('paket', '') or '').strip().lower()
    bulan = int(data.get('bulan', 1) or 1)
    if paket not in PACKAGES or paket == 'trial':
        return jsonify({'status': 'error', 'message': 'Paket tidak valid'}), 400

    conn = get_db()
    net  = conn.execute('SELECT isp_name FROM networks WHERE network_id=?', (network_id,)).fetchone()
    if not net:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Jaringan tidak ditemukan'}), 404

    expired = (datetime.now() + timedelta(days=30 * bulan)).isoformat()
    conn.execute(
        "UPDATE networks SET paket=?, status='active', expired_at=? WHERE network_id=?",
        (paket, expired, network_id)
    )
    conn.commit(); conn.close()
    logger.info(f'[SuperAdmin] Aktivasi {net["isp_name"]} → {paket} ({bulan} bln)')
    return jsonify({'status': 'success', 'message': f'{net["isp_name"]} aktif paket {paket} ({bulan} bulan)',
                    'expired_at': expired}), 200


# ── POST /admin/networks/<id>/suspend & unsuspend ────────────────
@auth_bp.route('/admin/networks/<network_id>/suspend', methods=['POST'])
@superadmin_required
def admin_suspend(network_id):
    conn = get_db()
    if not conn.execute('SELECT 1 FROM networks WHERE network_id=?', (network_id,)).fetchone():
        conn.close(); return jsonify({'status': 'error', 'message': 'Tidak ditemukan'}), 404
    conn.execute("UPDATE networks SET status='suspended' WHERE network_id=?", (network_id,))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Owner disuspend'}), 200


@auth_bp.route('/admin/networks/<network_id>/unsuspend', methods=['POST'])
@superadmin_required
def admin_unsuspend(network_id):
    """Kembalikan dari suspend → active (jika punya expired valid) / locked."""
    conn = get_db()
    row = conn.execute('SELECT expired_at FROM networks WHERE network_id=?', (network_id,)).fetchone()
    if not row:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tidak ditemukan'}), 404
    new_status = 'active' if (row['expired_at'] or '') else 'locked'
    conn.execute("UPDATE networks SET status=? WHERE network_id=?", (new_status, network_id))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Suspend dicabut', 'status_baru': new_status}), 200


# ── POST /admin/networks/<id>/extend-trial — perpanjang trial ────
@auth_bp.route('/admin/networks/<network_id>/extend-trial', methods=['POST'])
@superadmin_required
def admin_extend_trial(network_id):
    """Body: { "hari": 7 } → perpanjang trial_end + N hari, status trial."""
    from datetime import datetime, timedelta
    data = request.get_json(silent=True) or {}
    hari = int(data.get('hari', 7) or 7)
    conn = get_db()
    row = conn.execute('SELECT trial_end FROM networks WHERE network_id=?', (network_id,)).fetchone()
    if not row:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tidak ditemukan'}), 404
    base = datetime.now()
    try:
        if row['trial_end']:
            te = datetime.fromisoformat(row['trial_end'])
            if te > base:
                base = te
    except Exception:
        pass
    new_end = (base + timedelta(days=hari)).isoformat()
    conn.execute("UPDATE networks SET status='trial', trial_end=? WHERE network_id=?", (new_end, network_id))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': f'Trial diperpanjang {hari} hari', 'trial_end': new_end}), 200


# ── Permintaan Upgrade (superadmin) — list / approve / reject ──
@auth_bp.route('/admin/requests', methods=['GET'])
@superadmin_required
def admin_list_requests():
    """Daftar permintaan upgrade (default: pending)."""
    from packages import get_package
    status = request.args.get('status', 'pending')
    conn = get_db()
    if status == 'all':
        rows = conn.execute('SELECT * FROM upgrade_requests ORDER BY created_at DESC').fetchall()
    else:
        rows = conn.execute('SELECT * FROM upgrade_requests WHERE status=? ORDER BY created_at DESC', (status,)).fetchall()
    conn.close()
    out = [{
        'id': r['id'], 'network_id': r['network_id'], 'isp_name': r['isp_name'],
        'paket': r['paket'], 'paket_nama': get_package(r['paket'])['name'],
        'bulan': r['bulan'], 'status': r['status'], 'created_at': r['created_at'],
    } for r in rows]
    return jsonify({'status': 'success', 'requests': out}), 200


@auth_bp.route('/admin/requests/<int:req_id>/approve', methods=['POST'])
@superadmin_required
def admin_approve_request(req_id):
    """Setujui → aktifkan paket owner + tandai approved."""
    from datetime import datetime, timedelta
    conn = get_db()
    r = conn.execute('SELECT * FROM upgrade_requests WHERE id=?', (req_id,)).fetchone()
    if not r:
        conn.close(); return jsonify({'status': 'error', 'message': 'Permintaan tidak ditemukan'}), 404
    expired = (datetime.now() + timedelta(days=30 * int(r['bulan'] or 1))).isoformat()
    conn.execute("UPDATE networks SET paket=?, status='active', expired_at=? WHERE network_id=?",
                 (r['paket'], expired, r['network_id']))
    conn.execute("UPDATE upgrade_requests SET status='approved', handled_at=? WHERE id=?",
                 (datetime.now().isoformat(), req_id))
    conn.commit(); conn.close()
    logger.info(f'[Upgrade] APPROVE {r["isp_name"]} -> {r["paket"]}')
    return jsonify({'status': 'success', 'message': f'{r["isp_name"]} diaktifkan paket {r["paket"]}'}), 200


@auth_bp.route('/admin/requests/<int:req_id>/reject', methods=['POST'])
@superadmin_required
def admin_reject_request(req_id):
    from datetime import datetime
    conn = get_db()
    if not conn.execute('SELECT 1 FROM upgrade_requests WHERE id=?', (req_id,)).fetchone():
        conn.close(); return jsonify({'status': 'error', 'message': 'Tidak ditemukan'}), 404
    conn.execute("UPDATE upgrade_requests SET status='rejected', handled_at=? WHERE id=?",
                 (datetime.now().isoformat(), req_id))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Permintaan ditolak'}), 200


# ── DELETE /api/auth/admin/networks/<network_id> ──────────────
@auth_bp.route('/admin/networks/<network_id>', methods=['DELETE'])
@superadmin_required
def admin_delete_network(network_id):
    """Hapus ISP beserta seluruh usernya (permanen)."""
    conn = get_db()
    net  = conn.execute(
        'SELECT isp_name FROM networks WHERE network_id = ?', (network_id,)
    ).fetchone()

    if not net:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Jaringan tidak ditemukan'}), 404

    conn.execute('DELETE FROM users    WHERE network_id = ?', (network_id,))
    conn.execute('DELETE FROM networks WHERE network_id = ?', (network_id,))
    conn.commit()
    conn.close()

    # Hapus file DB owner (data operasional) juga
    try:
        import os
        from utils import _owner_db_path
        f = _owner_db_path(network_id)
        if os.path.exists(f):
            os.remove(f)
    except Exception as e:
        logger.warning(f'[SuperAdmin] Gagal hapus file DB owner {network_id}: {e}')

    logger.info(f'[SuperAdmin] Hapus network: {net["isp_name"]} ({network_id})')
    return jsonify({'status': 'success', 'message': f'ISP "{net["isp_name"]}" berhasil dihapus'}), 200


# ── POST /api/auth/admin/setup ────────────────────────────────
@auth_bp.route('/admin/setup', methods=['POST'])
def superadmin_setup():
    """
    Buat akun superadmin PERTAMA.
    Endpoint ini otomatis DINONAKTIFKAN setelah superadmin pertama
    berhasil dibuat — tidak bisa dipakai lagi.

    Body JSON:
    { "username": "...", "password": "..." }
    """
    conn     = get_db()
    existing = conn.execute('SELECT id FROM superadmins LIMIT 1').fetchone()
    if existing:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Setup sudah pernah dilakukan'}), 403

    data     = request.get_json(silent=True) or {}
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    if not username:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password or len(password) < 8:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Password minimal 8 karakter'}), 400

    conn.execute(
        'INSERT INTO superadmins (username, password_hash) VALUES (?, ?)',
        (username, generate_password_hash(password))
    )
    conn.commit()
    conn.close()

    logger.info(f'[SuperAdmin] Akun pertama dibuat: {username}')
    return jsonify({'status': 'success', 'message': 'Superadmin berhasil dibuat. Setup endpoint telah dinonaktifkan.'}), 201


# ── GET/POST /api/auth/admin/genieacs-config ──────────────────
@auth_bp.route('/admin/genieacs-config', methods=['GET'])
def admin_genieacs_get():
    """Ambil config GenieACS platform (superadmin only)."""
    if not session.get('superadmin_id'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    conn = get_db()
    rows = conn.execute(
        "SELECT key, value FROM platform_settings WHERE key IN (?,?,?,?)",
        ('genieacs_url', 'genieacs_user', 'genieacs_pass', 'genieacs_enabled')
    ).fetchall()
    conn.close()
    d = {r['key']: r['value'] for r in rows}
    return jsonify({
        'url':          d.get('genieacs_url', ''),
        'username':     d.get('genieacs_user', ''),
        'has_password': bool(d.get('genieacs_pass', '')),
        'enabled':      d.get('genieacs_enabled', '0') == '1',
    }), 200


@auth_bp.route('/admin/genieacs-config', methods=['POST'])
def admin_genieacs_save():
    """Simpan config GenieACS platform (superadmin only)."""
    if not session.get('superadmin_id'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    data = request.get_json(silent=True) or {}
    now  = __import__('datetime').datetime.now().isoformat()
    conn = get_db()
    for key, val in [
        ('genieacs_url',     (data.get('url') or '').strip().rstrip('/')),
        ('genieacs_user',    (data.get('username') or '').strip()),
        ('genieacs_enabled', '1' if data.get('enabled') else '0'),
    ]:
        conn.execute(
            '''INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
            (key, val, now)
        )
    if data.get('password'):
        conn.execute(
            '''INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
            ('genieacs_pass', str(data['password']), now)
        )
    conn.commit()
    conn.close()
    logger.info('[SuperAdmin] GenieACS config diperbarui')
    return jsonify({'status': 'success', 'message': 'Konfigurasi GenieACS tersimpan'}), 200


@auth_bp.route('/admin/genieacs-devices', methods=['GET'])
def admin_genieacs_devices():
    """Daftar semua device yang sudah di-link ke owner (superadmin only)."""
    if not session.get('superadmin_id'):
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401
    conn = get_db()
    rows = conn.execute(
        '''SELECT gd.device_id, gd.serial, gd.network_id, gd.linked_at, n.isp_name
           FROM genieacs_devices gd
           LEFT JOIN networks n ON n.network_id = gd.network_id
           ORDER BY gd.linked_at DESC'''
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows]), 200


# ══════════════════════════════════════════════════════════════
# PANDUAN INTEGRASI KE app.py
# ══════════════════════════════════════════════════════════════
"""
Tambahkan ke app.py (file utama Flask):

  import secrets
  from datetime import timedelta
  from auth import auth_bp

  app = Flask(__name__)

  # WAJIB: secret key acak untuk session & cookie
  app.secret_key = secrets.token_hex(32)
  # atau ambil dari environment:
  # app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))

  # Session berlaku 7 hari
  app.permanent_session_lifetime = timedelta(days=7)

  # Daftarkan Blueprint auth dengan prefix /api/auth
  app.register_blueprint(auth_bp, url_prefix='/api/auth')

  # Contoh proteksi endpoint lain:
  from auth import login_required, owner_required

  @app.route('/api/keuangan')
  @owner_required
  def keuangan():
      # g.current_user['network_id'] sudah tersedia
      ...

Proteksi endpoint di blueprint lain (mis. api.py, olt.py):
  from auth import login_required, owner_required, g

  @api_bp.route('/pelanggan/<int:device_id>')
  @login_required
  def get_pelanggan(device_id):
      network_id = g.current_user['network_id']
      # Filter data berdasarkan network_id ...
"""