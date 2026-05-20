"""
olt.py — TechnoFix · Blueprint OLT
====================================
CRUD endpoint untuk perangkat OLT (Optical Line Terminal).

Menggunakan utils.py untuk helper terpusat:
  - get_db(), olt_to_dict(), try_connect_olt()
"""

import logging
from flask import Blueprint, request, jsonify

# ── Shared helpers ─────────────────────────────────────────────
from utils import get_db, olt_to_dict, try_connect_olt

# ── Blueprint ──────────────────────────────────────────────────
olt_bp = Blueprint('olt', __name__)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# ══════════════════════════════════════════════════════════════
# INISIALISASI TABEL OLT
# ══════════════════════════════════════════════════════════════

def init_olt_table():
    """
    Buat tabel 'olt' jika belum ada.
    Dipanggil otomatis saat Blueprint diload.

    Kolom:
      - tipe        : merek/tipe OLT (Huawei, ZTE, dll)
      - rx_power / tx_power : cache nilai daya ONU terakhir (global per OLT)
    """
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS olt (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            tipe        TEXT    DEFAULT '',
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

    # Migrasi: tambah kolom 'tipe' jika belum ada
    try:
        conn.execute("ALTER TABLE olt ADD COLUMN tipe TEXT DEFAULT ''")
    except Exception:
        pass

    conn.commit()
    conn.close()
    logging.info('[OLT] Tabel olt siap.')


# Inisialisasi tabel saat modul diimport
init_olt_table()


# ══════════════════════════════════════════════════════════════
# ENDPOINT 1 — GET /olt
# Ambil semua perangkat OLT dari database
# ══════════════════════════════════════════════════════════════
@olt_bp.route('', methods=['GET'])
def get_olt():
    """
    Mengembalikan daftar semua OLT.

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
    Body JSON:
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

    if not name:     return jsonify({'status': 'error', 'message': 'Nama OLT wajib diisi'}), 400
    if not ip:       return jsonify({'status': 'error', 'message': 'IP Address wajib diisi'}), 400
    if not username: return jsonify({'status': 'error', 'message': 'Username wajib diisi'}), 400
    if not password: return jsonify({'status': 'error', 'message': 'Password wajib diisi'}), 400

    port = int(port) if str(port).strip().isdigit() else 23

    ok, msg = try_connect_olt(ip, port, username, password)
    status  = 'connected' if ok else 'failed'

    conn   = get_db()
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
# Edit data OLT, password boleh dikosongkan
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>', methods=['PUT'])
def update_olt(olt_id):
    """
    Password boleh dikosongkan → pakai password lama.
    Status direset ke 'pending' (perlu sinkron ulang).
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
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>', methods=['DELETE'])
def delete_olt(olt_id):
    """Hapus perangkat OLT dari database."""
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
    Tes koneksi ke OLT. Update status di DB.

    Response:
    {
      "status"    : "success" | "error",
      "message"   : "...",
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