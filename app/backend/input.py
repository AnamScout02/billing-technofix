from flask import Flask, request, jsonify
from flask_cors import CORS
import routeros_api
import sqlite3
import logging
import os

# ── SETUP ─────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

from api import api_bp
app.register_blueprint(api_bp, url_prefix='/api') # <--- Pastikan ada url_prefix
# terhubung ke olt.py
from olt import olt_bp
app.register_blueprint(olt_bp, url_prefix='/olt')



BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, '..', 'database', 'devices.db')

# ── DATABASE ──────────────────────────────────────────────────

def get_db():
    """
    Buka koneksi ke SQLite.
    row_factory = sqlite3.Row agar hasil query bisa diakses seperti dict,
    contoh: row['ip'] bukan row[1]
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """
    Buat tabel 'devices' jika belum ada.
    Dipanggil sekali saat server pertama kali dijalankan.
    """
    conn = get_db()
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

    conn.execute('''
        CREATE TABLE IF NOT EXISTS pelanggan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER,
            username TEXT,
            password TEXT,
            sn TEXT,
            hp TEXT,
            profil TEXT,
            slot_port_onu TEXT,
            vlan TEXT,
            titik_koordinat TEXT,
            FOREIGN KEY (device_id) REFERENCES devices(id)
        )
    ''')
    conn.execute('''
    CREATE TABLE IF NOT EXISTS onu_mapping (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        username     TEXT    NOT NULL UNIQUE,
        olt_id       INTEGER,
        slot_port    TEXT    DEFAULT '',
        vlan         TEXT    DEFAULT '',
        sn           TEXT    DEFAULT '',
        FOREIGN KEY (olt_id) REFERENCES olt(id)
        )
    ''')

    conn.commit()
    conn.close()

def row_to_dict(row):
    """
    Ubah sqlite3.Row menjadi dict biasa agar bisa di-serialize ke JSON.
    Password TIDAK dikirim ke frontend (keamanan).
    """
    return {
        'id':       row['id'],
        'name':     row['name'],
        'ip':       row['ip'],
        'port':     row['port'],
        'username': row['username'],
        'status':   row['status'],
    }


# ── HELPER KONEKSI MIKROTIK ───────────────────────────────────

def try_connect(ip, port, username, password):
    """
    Coba koneksi ke MikroTik via RouterOS API.
    Mengembalikan (True, nama_router) jika berhasil,
    atau (False, pesan_error) jika gagal.
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
        api = connection.get_api()
        system_id   = api.get_resource('/system/identity').get()
        router_name = system_id[0]['name']
        connection.disconnect()

        return True, router_name

    except Exception as e:
        logging.error(f"Koneksi gagal ke {ip}:{port} — {e}")
        return False, "Gagal terhubung. Periksa IP, port, username, dan password."

# ── ENDPOINTS ─────────────────────────────────────────────────

# 1. GET /devices — Ambil semua perangkat
@app.route('/devices', methods=['GET'])
def get_devices():
    """
    Mengembalikan daftar semua perangkat dari database.
    """
    conn = get_db()
    rows = conn.execute('SELECT * FROM devices ORDER BY id').fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows]), 200


# 2. POST /devices — Tambah perangkat baru + langsung tes koneksi
@app.route('/devices', methods=['POST'])
def add_device():
    """
    Terima data perangkat baru, simpan ke DB, lalu langsung tes koneksi.
    """
    data     = request.json
    name     = data.get('name', '').strip()
    ip       = data.get('ip', '').strip()
    port     = data.get('port', '8728')
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()

    # Validasi field wajib
    if not all([name, ip, username, password]):
        return jsonify({'status': 'error', 'message': 'Semua field wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    # Tes koneksi dulu sebelum simpan
    ok, msg = try_connect(ip, port, username, password)
    status  = 'connected' if ok else 'failed'

    # Simpan ke database
    conn = get_db()
    cursor = conn.execute(
        'INSERT INTO devices (name, ip, port, username, password, status) VALUES (?, ?, ?, ?, ?, ?)',
        (name, ip, port, username, password, status)
    )
    new_id = cursor.lastrowid  # Ambil ID yang baru dibuat
    conn.commit()

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':  'success' if ok else 'warning',
        'message': msg,
        'device':  row_to_dict(row)
    }), 201


# 3. PUT /devices/<id> — Edit perangkat
@app.route('/devices/<int:device_id>', methods=['PUT'])
def update_device(device_id):
    """
    Update data perangkat berdasarkan ID.
    Password boleh kosong (tidak berubah).
    """
    data     = request.json
    name     = data.get('name', '').strip()
    ip       = data.get('ip', '').strip()
    port     = data.get('port', '8728')
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()  # Boleh kosong

    if not all([name, ip, username]):
        return jsonify({'status': 'error', 'message': 'Name, IP, dan username wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    conn    = get_db()
    current = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    # Jika password dikosongkan, pakai password lama
    final_password = password if password else current['password']

    conn.execute(
        'UPDATE devices SET name=?, ip=?, port=?, username=?, password=?, status=? WHERE id=?',
        (name, ip, port, username, final_password, 'pending', device_id)
    )
    conn.commit()

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
    conn.close()

    return jsonify({'status': 'success', 'device': row_to_dict(row)}), 200


# 4. DELETE /devices/<id> — Hapus perangkat
@app.route('/devices/<int:device_id>', methods=['DELETE'])
def delete_device(device_id):
    """
    Hapus perangkat dari database berdasarkan ID.
    """
    conn = get_db()
    affected = conn.execute('DELETE FROM devices WHERE id = ?', (device_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    return jsonify({'status': 'success', 'message': 'Perangkat berhasil dihapus.'}), 200


# 5. POST /devices/<id>/sync — Tes koneksi ulang
@app.route('/devices/<int:device_id>/sync', methods=['POST'])
def sync_device(device_id):
    """
    Coba koneksi ke MikroTik dan update status di database.
    """
    conn   = get_db()
    device = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not device:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    ok, msg = try_connect(device['ip'], device['port'], device['username'], device['password'])
    status  = 'connected' if ok else 'failed'

    conn.execute('UPDATE devices SET status=? WHERE id=?', (status, device_id))
    conn.commit()
    conn.close()

    return jsonify({
        'status':   'success' if ok else 'error',
        'message':  msg,
        'connected': ok
    }), 200



# ── JALANKAN SERVER ───────────────────────────────────────────
if __name__ == '__main__':
    init_db()  # Buat tabel jika belum ada
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
