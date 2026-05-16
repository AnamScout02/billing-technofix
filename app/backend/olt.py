
import os
import socket
import logging
import re
from scrapli.driver.generic import GenericDriver
import sqlite3


from flask import Blueprint, request, jsonify

# ── Blueprint ─────────────────────────────────────────────────
olt_bp = Blueprint('olt', __name__)

# ── Path database (sama dengan input.py) ─────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH  = os.path.join(BASE_DIR, '..', 'database', 'devices.db')

logging.basicConfig(level=logging.INFO)


# ══════════════════════════════════════════════════════════════
# DATABASE HELPERS
# ══════════════════════════════════════════════════════════════

def get_db():
    """Buka koneksi SQLite, hasil query bisa diakses seperti dict."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_olt_table():
    """
    Buat tabel 'olt' jika belum ada.
    Dipanggil otomatis saat Blueprint pertama kali diload.

    Kolom:
    - id         : primary key otomatis
    - name       : nama perangkat OLT (wajib)
    - tipe        : merek/tipe OLT (Huawei, ZTE, dll)
    - ip         : IP address OLT (wajib)
    - port       : port koneksi (default 23 = Telnet)
    - username   : username login OLT (wajib)
    - password   : password login OLT (wajib)
    - snmp       : SNMP community string (opsional)
    - lokasi     : lokasi fisik perangkat (opsional)
    - keterangan : catatan tambahan (opsional)
    - status     : 'pending' | 'connected' | 'failed'
    """
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS olt (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            ip          TEXT    NOT NULL,
            port        INTEGER NOT NULL DEFAULT 23,
            username    TEXT    NOT NULL,
            password    TEXT    NOT NULL,
            snmp        TEXT    DEFAULT '',
            lokasi      TEXT    DEFAULT '',
            keterangan  TEXT    DEFAULT '',
            status      TEXT    NOT NULL DEFAULT 'pending'
        )
    ''')
    conn.commit()
    conn.close()
    logging.info('[OLT] Tabel olt siap.')


def olt_to_dict(row) -> dict:
    """
    Ubah sqlite3.Row → dict.
    Password TIDAK disertakan untuk keamanan.
    """
    return {
        'id':         row['id'],
        'name':       row['name'],
        'tipe':       row['tipe']        or '',
        'ip':         row['ip'],
        'port':       row['port'],
        'username':   row['username'],
        'snmp':       row['snmp']        or '',
        'lokasi':     row['lokasi']      or '',
        'keterangan': row['keterangan']  or '',
        'status':     row['status'],
    }


# ── Inisialisasi tabel saat modul diimport ────────────────────
init_olt_table()


# ══════════════════════════════════════════════════════════════
# KONEKSI KE OLT
# ══════════════════════════════════════════════════════════════

def try_connect_olt(ip: str, port: int, username: str, password: str):
    """
    Tes koneksi ke OLT dengan membuka socket TCP ke ip:port.
    Jika port terbuka → status 'connected'.

    Untuk koneksi Telnet / SSH penuh, ganti bagian ini dengan:
    - Telnet : library 'telnetlib' (bawaan Python)
    - SSH    : library 'paramiko'  (pip install paramiko)
    - SNMP   : library 'pysnmp'    (pip install pysnmp)

    Return:
        (True,  'pesan sukses')
        (False, 'pesan error')
    """
    try:
        port = int(port) if str(port).strip().isdigit() else 23
        sock = socket.create_connection((ip, port), timeout=8)
        sock.close()
        logging.info(f'[OLT] Koneksi berhasil ke {ip}:{port}')
        return True, f'Berhasil terhubung ke {ip}:{port}'

    except socket.timeout:
        msg = f'Koneksi ke {ip}:{port} timeout (8 detik)'
        logging.warning(f'[OLT] {msg}')
        return False, msg

    except ConnectionRefusedError:
        msg = f'Port {port} di {ip} ditolak atau tidak aktif'
        logging.warning(f'[OLT] {msg}')
        return False, msg

    except OSError as e:
        msg = f'Tidak dapat menjangkau {ip}:{port} — {e}'
        logging.error(f'[OLT] {msg}')
        return False, msg


# ══════════════════════════════════════════════════════════════
# ENDPOINT 1 — GET /olt
# Ambil semua perangkat OLT dari database
# ══════════════════════════════════════════════════════════════
@olt_bp.route('', methods=['GET'])
def get_olt():
    """
    Response contoh:
    [
      { "id":1, "name":"OLT-Pusat", "tipe":"Huawei",
        "ip":"192.168.1.100", "port":23, "username":"admin",
        "snmp":"public", "lokasi":"Gedung A", "keterangan":"",
        "status":"connected" }
    ]
    """
    conn = get_db()
    rows = conn.execute('SELECT * FROM olt ORDER BY id').fetchall()
    conn.close()
    return jsonify([olt_to_dict(r) for r in rows]), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 2 — POST /olt
# Tambah OLT baru, langsung tes koneksi, simpan status
# ══════════════════════════════════════════════════════════════
@olt_bp.route('', methods=['POST'])
def add_olt():
    """
    Body JSON yang diterima:
    {
      "name"       : "OLT-Pusat",
      "tipe"       : "Huawei",
      "ip"         : "192.168.1.100",
      "port"       : 23,
      "username"   : "admin",
      "password"   : "rahasia123",
      "snmp"       : "public",
      "lokasi"     : "Gedung A Lt.2",
      "keterangan" : "OLT utama area pusat"
    }
    """
    data = request.get_json()
    if not data:
        return jsonify({'status': 'error', 'message': 'Body JSON diperlukan'}), 400

    name       = data.get('name',       '').strip()
    tipe       = data.get('tipe',       '').strip()
    ip         = data.get('ip',         '').strip()
    port       = data.get('port',       23)
    username   = data.get('username',   '').strip()
    password   = data.get('password',   '').strip()
    snmp       = data.get('snmp',       '').strip()
    lokasi     = data.get('lokasi',     '').strip()
    keterangan = data.get('keterangan', '').strip()

    # Validasi field wajib
    if not name:
        return jsonify({'status': 'error', 'message': 'Nama OLT wajib diisi'}), 400
    if not ip:
        return jsonify({'status': 'error', 'message': 'IP Address wajib diisi'}), 400
    if not username:
        return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password:
        return jsonify({'status': 'error', 'message': 'Password wajib diisi'}), 400

    port = int(port) if str(port).strip().isdigit() else 23

    # Tes koneksi dulu sebelum simpan
    ok, msg = try_connect_olt(ip, port, username, password)
    status  = 'connected' if ok else 'failed'

    conn = get_db()
    cursor = conn.execute(
        '''INSERT INTO olt
           (name, tipe, ip, port, username, password, snmp, lokasi, keterangan, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (name, tipe, ip, port, username, password, snmp, lokasi, keterangan, status)
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM olt WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':  'success' if ok else 'warning',
        'message': msg,
        'device':  olt_to_dict(row)
    }), 201


# ══════════════════════════════════════════════════════════════
# ENDPOINT 3 — PUT /olt/<id>
# Edit data OLT, password boleh dikosongkan (pakai password lama)
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>', methods=['PUT'])
def update_olt(olt_id):
    """
    Contoh URL: PUT /olt/3
    Password boleh dikosongkan → sistem pakai password lama.
    Setelah edit, status direset ke 'pending' (perlu sinkron ulang).
    """
    data = request.get_json()
    if not data:
        return jsonify({'status': 'error', 'message': 'Body JSON diperlukan'}), 400

    name       = data.get('name',       '').strip()
    tipe       = data.get('tipe',       '').strip()
    ip         = data.get('ip',         '').strip()
    port       = data.get('port',       23)
    username   = data.get('username',   '').strip()
    password   = data.get('password',   '').strip()
    snmp       = data.get('snmp',       '').strip()
    lokasi     = data.get('lokasi',     '').strip()
    keterangan = data.get('keterangan', '').strip()

    if not name or not ip or not username:
        return jsonify({'status': 'error', 'message': 'Nama, IP, dan username wajib diisi'}), 400

    port = int(port) if str(port).strip().isdigit() else 23

    conn    = get_db()
    current = conn.execute('SELECT * FROM olt WHERE id = ?', (olt_id,)).fetchone()
    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat OLT tidak ditemukan'}), 404

    # Jika password dikosongkan → pakai password lama
    final_password = password if password else current['password']

    conn.execute(
        '''UPDATE olt
           SET name=?, tipe=?, ip=?, port=?, username=?, password=?,
               snmp=?, lokasi=?, keterangan=?, status=?
           WHERE id=?''',
        (name, tipe, ip, port, username, final_password,
         snmp, lokasi, keterangan, 'pending', olt_id)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM olt WHERE id = ?', (olt_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':  'success',
        'message': f'{name} berhasil diperbarui. Lakukan sinkronisasi untuk cek koneksi.',
        'device':  olt_to_dict(row)
    }), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 4 — DELETE /olt/<id>
# Hapus perangkat OLT dari database
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>', methods=['DELETE'])
def delete_olt(olt_id):
    """Contoh URL: DELETE /olt/3"""
    conn     = get_db()
    affected = conn.execute('DELETE FROM olt WHERE id = ?', (olt_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Perangkat OLT tidak ditemukan'}), 404

    return jsonify({'status': 'success', 'message': 'Perangkat OLT berhasil dihapus'}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 5 — POST /olt/<id>/sync
# Tes ulang koneksi ke OLT, perbarui status di database
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>/sync', methods=['POST'])
def sync_olt(olt_id):
    """
    Contoh URL: POST /olt/3/sync
    Response:
    {
      "status"    : "success" | "error",
      "message"   : "keterangan hasil koneksi",
      "connected" : true | false
    }
    """
    conn   = get_db()
    device = conn.execute('SELECT * FROM olt WHERE id = ?', (olt_id,)).fetchone()
    if not device:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat OLT tidak ditemukan'}), 404

    ok, msg = try_connect_olt(
        device['ip'], device['port'],
        device['username'], device['password']
    )
    status = 'connected' if ok else 'failed'

    conn.execute('UPDATE olt SET status = ? WHERE id = ?', (status, olt_id))
    conn.commit()
    conn.close()

    return jsonify({
        'status':    'success' if ok else 'error',
        'message':   msg,
        'connected': ok
    }), 200