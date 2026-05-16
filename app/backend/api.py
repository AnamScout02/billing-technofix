"""
api.py — TechnoFix Backend (Pelanggan / PPP Secret)
Membaca daftar perangkat dari devices.db (SQLite) yang dikelola input.py
"""

import os
import sqlite3
from flask import Blueprint, jsonify, request

# JANGAN SAMPAI TERHAPUS: Import mikrotik client buatan Anda
from mikrotik import MikroTikClient, MikroTikError

# 1. DEFINISIKAN BLUEPRINT DI SINI (Ini yang menyebabkan error NameError sebelumnya)
api_bp = Blueprint('api', __name__)

# 2. PENGATURAN LOKASI DATABASE ABSOLUT
# Ambil lokasi folder 'backend'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Arahkan ke file yang sama dengan input.py (keluar satu tingkat ke 'database')
DB_PATH = os.path.join(BASE_DIR, '..', 'database', 'devices.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cari_device(device_id):
    """Cari device di tabel `devices` berdasarkan ID."""
    conn = get_db()
    row = conn.execute(
        'SELECT id, name, ip, port, username, password FROM devices WHERE id = ?',
        (device_id,)
    ).fetchone()
    conn.close()
    if row:
        return dict(row)
    return None
def get_onu_data(username: str) -> dict:
    """
    Ambil data ONU (slot, VLAN, SN) dari tabel onu_mapping
    berdasarkan username pelanggan.
    Return dict kosong jika tidak ada.
    """
    conn = get_db()
    row = conn.execute(
        'SELECT slot_port, vlan, sn, olt_id FROM onu_mapping WHERE username = ?',
        (username,)
    ).fetchone()
    conn.close()
    return dict(row) if row else {'slot_port': '', 'vlan': '', 'sn': '', 'olt_id': None}
    


# ══════════════════════════════════════════════════════════
# 1. GET /api/mikrotik-pelanggan?device_id=X
#    → Ambil PPP Secrets langsung dari MikroTik (BUKAN dari DB lokal)
# ══════════════════════════════════════════════════════════
# Rute ini akan otomatis menangkap angka '8' di URL dan memasukkannya ke variabel device_id
@api_bp.route('/pelanggan/<int:device_id>', methods=['GET'])
def get_pelanggan(device_id):
    # HAPUS BARIS INI JIKA MASIH ADA: 
    # device_id = request.args.get('device_id')
    # if not device_id: return jsonify({'error': 'device_id wajib'}), 400
    
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        # Menarik data dari MikroTik menggunakan client yang sudah Anda buat
        with MikroTikClient(device) as mt:
            api = mt._get_api()
            secrets = list(api.path('/ppp/secret'))
            
            # --- Jika Anda ingin menggabungkan dengan status active (online) ---
            active_conns = list(api.path('/ppp/active'))
            active_names = {a.get('name') for a in active_conns}

            hasil = []
            for s in secrets:
                username = str(s.get('name', '') or '')
                onu      = get_onu_data(username)  # ← ambil data ONU

                hasil.append({
                    'id':        s.get('.id'),
                    'username':  username,
                    'password':  s.get('password', ''),
                    'profil':    s.get('profile', 'default'),
                    'service':   s.get('service', 'pppoe'),
                    'comment':   s.get('comment', ''),
                    'disabled':  s.get('disabled', 'false'),
                    'status':    'Online' if username in active_names else 'Offline',
                    # ← data dari OLT/onu_mapping
                    'slot_port': onu.get('slot_port', ''),
                    'vlan':      onu.get('vlan', ''),
                    'sn':        onu.get('sn', ''),
                    'olt_id':    onu.get('olt_id'),
                })
      
        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Terjadi kesalahan internal: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════
# 2. POST /api/mikrotik-pelanggan
#    → Tambah PPP Secret BARU langsung ke MikroTik
# ══════════════════════════════════════════════════════════
@api_bp.route('/pelanggan', methods=['POST'])
def add_pelanggan():
    body = request.get_json(silent=True) or {}

    device_id = body.get('device_id')
    username  = (body.get('name') or body.get('username') or '').strip()
    password  = (body.get('password') or '').strip()

    if not device_id: return jsonify({'error': 'device_id wajib'}), 400
    if not username:  return jsonify({'error': 'username wajib'}), 400
    if not password:  return jsonify({'error': 'password wajib'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        # Tambahkan pelanggan ke MikroTik
        with MikroTikClient(device) as mt:
            mt.tambah_secret({
                'name':     username,
                'password': password,
                'profile':  body.get('profil') or body.get('profile') or 'default',
                'service':  body.get('service', 'pppoe'),
                'comment':  body.get('comment', ''),
                'disabled': 'yes' if body.get('disabled', False) else 'no',
            })

        # Simpan pelanggan ke database lokal
        conn = get_db()
        conn.execute('''
            INSERT INTO pelanggan (device_id, username, password, profile, service)
            VALUES (?, ?, ?, ?, ?)
        ''', (device_id, username, password, body.get('profil', 'default'), body.get('service', 'pppoe')))
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil ditambahkan ke MikroTik'}), 201

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500

@api_bp.route('/onu-mapping', methods=['POST'])
def save_onu_mapping():
    """
    Simpan / update data ONU untuk satu username.
    Dipanggil saat user klik Simpan di modal pelanggan.

    Body JSON:
    {
        "username"  : "pelanggan01",
        "olt_id"    : 1,
        "slot_port" : "0/1/1:1",
        "vlan"      : "100",
        "sn"        : "HWTC1A2B3C4D"
    }
    """
    body      = request.get_json(silent=True) or {}
    username  = body.get('username', '').strip()
    olt_id    = body.get('olt_id')
    slot_port = body.get('slot_port', '').strip()
    vlan      = body.get('vlan', '').strip()
    sn        = body.get('sn', '').strip()

    if not username:
        return jsonify({'error': 'username wajib'}), 400

    conn = get_db()
    # INSERT OR REPLACE — update jika sudah ada, insert jika belum
    conn.execute("""
    INSERT INTO onu_mapping
    (username, olt_id, slot_port, vlan, sn)
    INSERT INTO onu_mapping
    (username, olt_id, slot_port, vlan, sn)
    VALUES (?, ?, ?, ?, ?)
    """, (username, olt_id, slot_port, vlan, sn))
    conn.commit()
    conn.close()

    return jsonify({'message': f'Data ONU untuk {username} berhasil disimpan'}), 200