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
import logging
from functools import wraps

from flask import Blueprint, request, jsonify, session, g
from werkzeug.security import generate_password_hash, check_password_hash

from utils import get_db

# ── Blueprint ──────────────────────────────────────────────────
auth_bp = Blueprint('auth', __name__)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)


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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

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

    conn.commit()
    conn.close()
    logger.info('[Auth] Tabel auth siap.')


# Inisialisasi saat modul diimport
init_auth_tables()


# ══════════════════════════════════════════════════════════════
# HELPER — Ambil user dari session
# ══════════════════════════════════════════════════════════════

def get_current_user() -> dict | None:
    """
    Baca session aktif dan kembalikan data user dari database.
    Return None jika tidak ada session valid.
    """
    user_id    = session.get('user_id')
    network_id = session.get('network_id')

    if not user_id or not network_id:
        return None

    conn = get_db()
    row  = conn.execute(
        '''SELECT u.id, u.username, u.role, u.network_id, n.isp_name
           FROM users u
           JOIN networks n ON n.network_id = u.network_id
           WHERE u.id = ? AND u.network_id = ?''',
        (user_id, network_id)
    ).fetchone()
    conn.close()

    if row:
        return {
            'id':         row['id'],
            'username':   row['username'],
            'role':       row['role'],
            'network_id': row['network_id'],
            'isp_name':   row['isp_name'],
        }
    return None


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
            return jsonify({'status': 'error', 'message': 'Sesi habis, silakan login kembali'}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


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
            return jsonify({'status': 'error', 'message': 'Sesi habis, silakan login kembali'}), 401
        if user['role'] != 'owner':
            return jsonify({'status': 'error', 'message': 'Akses ditolak. Hanya Owner yang diizinkan'}), 403
        g.current_user = user
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

    isp_name = data.get('isp_name', '').strip()
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

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
        conn.execute(
            'INSERT INTO networks (network_id, isp_name) VALUES (?, ?)',
            (network_id, isp_name)
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
    return jsonify({
        'status':     'success',
        'message':    f'ISP "{isp_name}" berhasil didaftarkan',
        'network_id': network_id,
        'username':   username,
        'role':       'owner',
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
        '''SELECT u.id, u.username, u.password_hash, u.role, u.network_id, n.isp_name
           FROM users u
           JOIN networks n ON n.network_id = u.network_id
           WHERE u.username = ?''',
        (username,)
    ).fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({'status': 'error', 'message': 'Username atau password salah'}), 401

    # Simpan ke session Flask (server-side, HttpOnly cookie otomatis)
    session.clear()
    session['user_id']    = row['id']
    session['network_id'] = row['network_id']
    session.permanent     = True   # Durasi diatur di app.py via PERMANENT_SESSION_LIFETIME

    user_data = {
        'id':         row['id'],
        'username':   row['username'],
        'role':       row['role'],
        'network_id': row['network_id'],
        'isp_name':   row['isp_name'],
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
    """Hapus session dan kembalikan response sukses."""
    username = session.get('user_id', 'unknown')
    session.clear()
    logger.info(f'[Auth] Logout: user_id={username}')
    return jsonify({'status': 'success', 'message': 'Berhasil logout'}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 4 — GET /api/auth/me
# Cek session aktif & kembalikan data user
# ══════════════════════════════════════════════════════════════

@auth_bp.route('/me', methods=['GET'])
@login_required
def me():
    """
    Kembalikan data user yang sedang login.
    Dipakai oleh frontend saat halaman pertama kali dimuat.
    """
    return jsonify({
        'status': 'success',
        'user':   g.current_user,
    }), 200


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
    data = request.get_json(silent=True) or {}

    username   = data.get('username', '').strip()
    password   = data.get('password', '').strip()
    network_id = g.current_user['network_id']

    if not username:
        return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password or len(password) < 6:
        return jsonify({'status': 'error', 'message': 'Password minimal 6 karakter'}), 400

    conn = get_db()
    existing = conn.execute(
        'SELECT id FROM users WHERE username = ?', (username,)
    ).fetchone()
    if existing:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Username sudah digunakan'}), 409

    password_hash = generate_password_hash(password)
    try:
        conn.execute(
            '''INSERT INTO users (network_id, username, password_hash, role)
               VALUES (?, ?, ?, 'teknisi')''',
            (network_id, username, password_hash)
        )
        conn.commit()
        logger.info(f'[Auth] Teknisi baru: {username} @ {network_id} (dibuat oleh {g.current_user["username"]})')
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'status': 'error', 'message': f'Gagal membuat akun: {e}'}), 500

    conn.close()
    return jsonify({
        'status':  'success',
        'message': f'Akun teknisi "{username}" berhasil dibuat',
        'username': username,
        'role':    'teknisi',
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
    network_id = g.current_user['network_id']
    conn = get_db()
    rows = conn.execute(
        '''SELECT id, username, role, created_at
           FROM users
           WHERE network_id = ?
           ORDER BY role DESC, username''',
        (network_id,)
    ).fetchall()
    conn.close()

    members = [
        {
            'id':         r['id'],
            'username':   r['username'],
            'role':       r['role'],
            'created_at': r['created_at'],
        }
        for r in rows
    ]

    return jsonify({'status': 'success', 'members': members}), 200


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