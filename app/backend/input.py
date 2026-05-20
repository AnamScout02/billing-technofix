"""
input.py — TechnoFix · Entry Point Flask
=========================================
Server utama. Register semua Blueprint, inisialisasi DB,
dan sediakan endpoint CRUD untuk perangkat MikroTik.

Menggunakan utils.py untuk fungsi helper terpusat:
  - get_db(), device_to_dict(), try_connect_mikrotik()
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import logging
import os

# ── Shared helpers ─────────────────────────────────────────────
from utils import get_db, device_to_dict, try_connect_mikrotik

# ── Blueprint lain ─────────────────────────────────────────────
from api import api_bp
from olt import olt_bp

# ── Setup ──────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

app.register_blueprint(api_bp, url_prefix='/api')
app.register_blueprint(olt_bp, url_prefix='/olt')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# ══════════════════════════════════════════════════════════════
# INISIALISASI DATABASE
# ══════════════════════════════════════════════════════════════

def init_db():
    """
    Buat semua tabel yang diperlukan jika belum ada.
    Dipanggil sekali saat server pertama kali dijalankan.
    """
    conn = get_db()

    # Tabel perangkat MikroTik
    conn.execute('''
        CREATE TABLE IF NOT EXISTS devices (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            name     TEXT    NOT NULL,
            ip       TEXT    NOT NULL,
            port     INTEGER NOT NULL DEFAULT 8728,
            username TEXT    NOT NULL,
            password TEXT    NOT NULL,
            status   TEXT    NOT NULL DEFAULT 'pending'
        )
    ''')

    # Tabel pelanggan lokal (mirror dari MikroTik PPP Secret)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pelanggan (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id       INTEGER,
            username        TEXT,
            password        TEXT,
            sn              TEXT    DEFAULT '',
            hp              TEXT    DEFAULT '',
            profil          TEXT    DEFAULT '',
            slot_port_onu   TEXT    DEFAULT '',
            vlan            TEXT    DEFAULT '',
            titik_koordinat TEXT    DEFAULT '',
            tgl_pasang      TEXT    DEFAULT '',
            tgl_jatuh       TEXT    DEFAULT '',
            FOREIGN KEY (device_id) REFERENCES devices(id)
        )
    ''')

    # Tabel pemetaan ONU — berisi data OLT side per pelanggan
    # rx_power & tx_power ditambahkan di sini sebagai cache sinkronisasi
    conn.execute('''
        CREATE TABLE IF NOT EXISTS onu_mapping (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            username  TEXT    NOT NULL UNIQUE,
            olt_id    INTEGER,
            slot_port TEXT    DEFAULT '',
            vlan      TEXT    DEFAULT '',
            sn        TEXT    DEFAULT '',
            rx_power  REAL,
            tx_power  REAL,
            synced_at TEXT    DEFAULT '',
            FOREIGN KEY (olt_id) REFERENCES olt(id)
        )
    ''')

    # Migrasi: tambah kolom rx_power & tx_power jika belum ada
    # (untuk database yang sudah ada sebelum versi ini)
    try:
        conn.execute('ALTER TABLE onu_mapping ADD COLUMN rx_power REAL')
    except Exception:
        pass  # Kolom sudah ada
    try:
        conn.execute('ALTER TABLE onu_mapping ADD COLUMN tx_power REAL')
    except Exception:
        pass
    try:
        conn.execute('ALTER TABLE onu_mapping ADD COLUMN synced_at TEXT DEFAULT ""')
    except Exception:
        pass

    conn.commit()
    conn.close()
    logging.info('[DB] Semua tabel siap.')


# ══════════════════════════════════════════════════════════════
# ENDPOINTS — MikroTik Devices CRUD
# ══════════════════════════════════════════════════════════════

# 1. GET /devices — Ambil semua perangkat
@app.route('/devices', methods=['GET'])
def get_devices():
    """Mengembalikan daftar semua perangkat dari database."""
    conn = get_db()
    rows = conn.execute('SELECT * FROM devices ORDER BY id').fetchall()
    conn.close()
    return jsonify([device_to_dict(r) for r in rows]), 200


# 2. POST /devices — Tambah perangkat baru + langsung tes koneksi
@app.route('/devices', methods=['POST'])
def add_device():
    """
    Terima data perangkat baru, tes koneksi ke MikroTik,
    lalu simpan ke database.
    """
    data     = request.json or {}
    name     = data.get('name', '').strip()
    ip       = data.get('ip', '').strip()
    port     = data.get('port', '8728')
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    if not all([name, ip, username, password]):
        return jsonify({'status': 'error', 'message': 'Semua field wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    ok, msg = try_connect_mikrotik(ip, port, username, password)
    status  = 'connected' if ok else 'failed'

    conn   = get_db()
    cursor = conn.execute(
        'INSERT INTO devices (name, ip, port, username, password, status) VALUES (?, ?, ?, ?, ?, ?)',
        (name, ip, port, username, password, status)
    )
    new_id = cursor.lastrowid
    conn.commit()

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':  'success' if ok else 'warning',
        'message': msg,
        'device':  device_to_dict(row)
    }), 201


# 3. PUT /devices/<id> — Edit perangkat
@app.route('/devices/<int:device_id>', methods=['PUT'])
def update_device(device_id):
    """
    Update data perangkat berdasarkan ID.
    Password boleh kosong (tidak berubah).
    """
    data     = request.json or {}
    name     = data.get('name', '').strip()
    ip       = data.get('ip', '').strip()
    port     = data.get('port', '8728')
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    if not all([name, ip, username]):
        return jsonify({'status': 'error', 'message': 'Name, IP, dan username wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    conn    = get_db()
    current = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    final_password = password if password else current['password']

    conn.execute(
        'UPDATE devices SET name=?, ip=?, port=?, username=?, password=?, status=? WHERE id=?',
        (name, ip, port, username, final_password, 'pending', device_id)
    )
    conn.commit()

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
    conn.close()

    return jsonify({'status': 'success', 'device': device_to_dict(row)}), 200


# 4. DELETE /devices/<id> — Hapus perangkat
@app.route('/devices/<int:device_id>', methods=['DELETE'])
def delete_device(device_id):
    """Hapus perangkat dari database berdasarkan ID."""
    conn     = get_db()
    affected = conn.execute('DELETE FROM devices WHERE id = ?', (device_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    return jsonify({'status': 'success', 'message': 'Perangkat berhasil dihapus.'}), 200


# 5. POST /devices/<id>/sync — Tes koneksi ulang
@app.route('/devices/<int:device_id>/sync', methods=['POST'])
def sync_device(device_id):
    """Coba koneksi ke MikroTik dan update status di database."""
    conn   = get_db()
    device = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not device:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    ok, msg = try_connect_mikrotik(
        device['ip'], device['port'],
        device['username'], device['password']
    )
    status = 'connected' if ok else 'failed'

    conn.execute('UPDATE devices SET status=? WHERE id=?', (status, device_id))
    conn.commit()
    conn.close()

    return jsonify({
        'status':    'success' if ok else 'error',
        'message':   msg,
        'connected': ok
    }), 200


# ── JALANKAN SERVER ───────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)