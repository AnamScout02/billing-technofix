"""
api.py — TechnoFix Backend (Pelanggan / PPP Secret)
=====================================================
Blueprint Flask untuk endpoint pelanggan (PPP Secrets) MikroTik
dan sinkronisasi data ONU dari OLT.

Import utils.py untuk helper terpusat (get_db, get_onu_data).
"""

import os
from flask import Blueprint, jsonify, request

# ── Shared helpers (dari utils.py) ────────────────────────────
from utils import get_db, get_onu_data

# ── MikroTik client buatan sendiri ────────────────────────────
from mikrotik import MikroTikClient, MikroTikError

# ── Scrapli untuk RX/TX real-time dari OLT ───────────────────
try:
    from scrapli.driver.generic import GenericDriver
    SCRAPLI_OK = True
except ImportError:
    SCRAPLI_OK = False


# ── Blueprint ─────────────────────────────────────────────────
api_bp = Blueprint('api', __name__)

# ══════════════════════════════════════════════════════════════
# HELPERS INTERNAL
# ══════════════════════════════════════════════════════════════

def cari_device(device_id: int) -> dict | None:
    """Cari device di tabel 'devices' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password FROM devices WHERE id = ?',
        (device_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def cari_olt(olt_id: int) -> dict | None:
    """Cari OLT di tabel 'olt' berdasarkan ID."""
    conn = get_db()
    row  = conn.execute(
        'SELECT id, name, ip, port, username, password, tipe FROM olt WHERE id = ?',
        (olt_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# ══════════════════════════════════════════════════════════════
# 1. GET /api/pelanggan/<device_id>
#    Ambil PPP Secrets langsung dari MikroTik + data ONU dari DB
# ══════════════════════════════════════════════════════════════
@api_bp.route('/pelanggan/<int:device_id>', methods=['GET'])
def get_pelanggan(device_id):
    """
    Menggabungkan data PPP Secret dari MikroTik dengan data ONU
    (slot_port, vlan, sn, rx_power, tx_power) dari tabel onu_mapping.

    Response per item:
    {
        "id":        ".1",
        "username":  "pelanggan01",
        "profil":    "10Mbps",
        "status":    "Online" | "Offline",
        "slot_port": "0/1/1:3",
        "vlan":      "100",
        "sn":        "HWTC1A2B3C4D",
        "rx_power":  -24.5,          ← float dBm, null jika belum ada
        "tx_power":  2.3,
        "olt_id":    1
    }
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            api = mt._get_api()

            # PPP Secrets
            secrets = list(api.path('/ppp/secret'))

            # Status aktif
            active_conns = list(api.path('/ppp/active'))
            active_names = {a.get('name') for a in active_conns}

            hasil = []
            for s in secrets:
                username = str(s.get('name', '') or '')
                onu      = get_onu_data(username)

                hasil.append({
                    'id':        s.get('.id'),
                    'username':  username,
                    'password':  s.get('password', ''),
                    'profil':    s.get('profile', 'default'),
                    'service':   s.get('service', 'pppoe'),
                    'comment':   s.get('comment', ''),
                    'disabled':  s.get('disabled', 'false'),
                    'status':    'Online' if username in active_names else 'Offline',
                    # ← data ONU dari onu_mapping + nilai RX/TX
                    'slot_port': onu['slot_port'],
                    'vlan':      onu['vlan'],
                    'sn':        onu['sn'],
                    'olt_id':    onu['olt_id'],
                    'rx_power':  onu['rx_power'],   # float dBm atau null
                    'tx_power':  onu['tx_power'],   # float dBm atau null
                })

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Terjadi kesalahan internal: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════════
# 2. POST /api/pelanggan
#    Tambah PPP Secret baru ke MikroTik + simpan ke DB lokal
# ══════════════════════════════════════════════════════════════
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
        with MikroTikClient(device) as mt:
            mt.tambah_secret({
                'name':     username,
                'password': password,
                'profile':  body.get('profil') or body.get('profile') or 'default',
                'service':  body.get('service', 'pppoe'),
                'comment':  body.get('comment', ''),
                'disabled': 'yes' if body.get('disabled', False) else 'no',
            })

        # Simpan ke tabel pelanggan lokal
        conn = get_db()
        conn.execute(
            '''INSERT INTO pelanggan
               (device_id, username, password, profil, service,
                hp, sn, slot_port_onu, vlan, titik_koordinat)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                device_id, username, password,
                body.get('profil', 'default'),
                body.get('service', 'pppoe'),
                body.get('hp', ''),
                body.get('sn', ''),
                body.get('slot_port', ''),
                body.get('vlan', ''),
                body.get('koordinat', ''),
            )
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil ditambahkan ke MikroTik'}), 201

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════════
# 3. PUT /api/pelanggan/<id>
#    Edit PPP Secret di MikroTik + perbarui DB lokal
# ══════════════════════════════════════════════════════════════
@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['PUT'])
def update_pelanggan(pelanggan_id):
    body = request.get_json(silent=True) or {}

    device_id = body.get('device_id')
    username  = (body.get('username') or '').strip()

    if not device_id: return jsonify({'error': 'device_id wajib'}), 400
    if not username:  return jsonify({'error': 'username wajib'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    update_data = {}
    if body.get('password'):
        update_data['password'] = body['password']
    if body.get('profil'):
        update_data['profile'] = body['profil']
    if body.get('service'):
        update_data['service'] = body['service']
    if 'disabled' in body:
        update_data['disabled'] = 'yes' if body['disabled'] else 'no'

    try:
        if update_data:
            with MikroTikClient(device) as mt:
                mt.edit_secret(username, update_data)

        # Update DB lokal
        conn = get_db()
        conn.execute(
            '''UPDATE pelanggan
               SET profil = ?, hp = ?, sn = ?,
                   slot_port_onu = ?, vlan = ?, titik_koordinat = ?
               WHERE id = ?''',
            (
                body.get('profil', ''),
                body.get('hp', ''),
                body.get('sn', ''),
                body.get('slot_port', ''),
                body.get('vlan', ''),
                body.get('koordinat', ''),
                pelanggan_id,
            )
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil diperbarui'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════════
# 4. DELETE /api/pelanggan/<id>
#    Hapus PPP Secret dari MikroTik + hapus dari DB lokal
# ══════════════════════════════════════════════════════════════
@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['DELETE'])
def delete_pelanggan(pelanggan_id):
    body      = request.get_json(silent=True) or {}
    device_id = body.get('device_id')
    username  = (body.get('username') or '').strip()

    if not device_id or not username:
        return jsonify({'error': 'device_id dan username wajib'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            mt.hapus_secret(username)

        conn = get_db()
        conn.execute('DELETE FROM pelanggan WHERE id = ?', (pelanggan_id,))
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil dihapus'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════════
# 5. GET /api/pelanggan/<device_id>/rx-tx
#    ← ENDPOINT BARU: Ambil nilai RX/TX real-time dari OLT
#      berdasarkan data onu_mapping setiap pelanggan.
#
#    Cara kerja:
#    1. Ambil daftar pelanggan dari DB (bukan dari MikroTik) → cepat
#    2. Per pelanggan: lookup onu_mapping → ambil rx_power & tx_power
#       yang sudah di-update oleh olt_sync.py
#    3. Jika ada ?realtime=1 DAN OLT terkoneksi → langsung ambil
#       dari OLT via SSH/Telnet (lebih lambat, lebih fresh)
#
#    Response:
#    [
#      { "username": "pelanggan01", "rx_power": -24.5,
#        "tx_power": 2.1, "slot_port": "0/1/1:3",
#        "source": "db" | "realtime" }
#    ]
# ══════════════════════════════════════════════════════════════
@api_bp.route('/pelanggan/<int:device_id>/rx-tx', methods=['GET'])
def get_rx_tx(device_id):
    """
    Ambil data RX/TX power (dBm) untuk semua pelanggan
    di perangkat device_id.

    Query params:
      ?realtime=1   → langsung tembak OLT (butuh Scrapli)
      (default)     → baca dari cache DB (tabel onu_mapping)
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    realtime = request.args.get('realtime', '0') == '1'

    try:
        # Ambil semua username pelanggan untuk device ini
        with MikroTikClient(device) as mt:
            api     = mt._get_api()
            secrets = list(api.path('/ppp/secret'))

        hasil = []
        for s in secrets:
            username = str(s.get('name', '') or '')
            if not username:
                continue

            onu = get_onu_data(username)

            rx_power = onu['rx_power']
            tx_power = onu['tx_power']
            source   = 'db'

            # Mode realtime: tembak OLT langsung
            if realtime and SCRAPLI_OK and onu['olt_id']:
                olt = cari_olt(onu['olt_id'])
                if olt and onu['slot_port']:
                    try:
                        rt = _get_rx_tx_realtime(olt, onu['slot_port'])
                        if rt['rx_power'] is not None:
                            rx_power = rt['rx_power']
                            tx_power = rt['tx_power']
                            source   = 'realtime'

                            # Update cache di DB
                            _update_rx_tx_cache(username, rx_power, tx_power)
                    except Exception:
                        pass  # Fallback ke cache DB

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

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


def _get_rx_tx_realtime(olt: dict, slot_port: str) -> dict:
    """
    Ambil nilai RX/TX power langsung dari OLT via SSH/Telnet.
    Mendukung ZTE dan Huawei secara otomatis.

    slot_port format: "0/1/1:3"  (contoh ZTE)
    """
    from utils import parse_huawei_rx, parse_zte_rx, parse_generic_rx

    result = {'rx_power': None, 'tx_power': None}
    if not SCRAPLI_OK:
        return result

    tipe = (olt.get('tipe') or '').lower()

    # Bangun perintah berdasarkan merk
    if 'zte' in tipe:
        # ZTE: "show pon onu optical-info gpon-onu_<slot>:<onu>"
        cmd = f'show pon onu optical-info gpon-onu_{slot_port}'
    elif 'huawei' in tipe:
        # Huawei: "display ont optical-info <frame/slot/port> <ont-id>"
        parts = slot_port.split(':')
        port  = parts[0] if parts else slot_port
        ont   = parts[1] if len(parts) > 1 else '0'
        cmd   = f'display ont optical-info {port} {ont}'
    else:
        cmd = f'show onu optical-info {slot_port}'

    device_cfg = {
        'host':                olt['ip'],
        'port':                int(olt.get('port', 23)),
        'auth_username':       olt['username'],
        'auth_password':       olt['password'],
        'auth_strict_key':     False,
        'transport':           'telnet',
        'timeout_ops':         15,
        'comms_prompt_pattern': r'.*[>#\$]',
    }

    with GenericDriver(**device_cfg) as conn:
        output = conn.send_command(cmd).result

    if 'zte' in tipe:
        parsed = parse_zte_rx(output)
    elif 'huawei' in tipe:
        parsed = parse_huawei_rx(output)
    else:
        parsed = parse_generic_rx(output)

    return parsed


def _update_rx_tx_cache(username: str, rx_power, tx_power):
    """Update kolom rx_power & tx_power di tabel onu_mapping."""
    conn = get_db()
    conn.execute(
        'UPDATE onu_mapping SET rx_power = ?, tx_power = ? WHERE username = ?',
        (rx_power, tx_power, username)
    )
    conn.commit()
    conn.close()


# ══════════════════════════════════════════════════════════════
# 6. POST /api/onu-mapping
#    Simpan/update data ONU untuk satu username
# ══════════════════════════════════════════════════════════════
@api_bp.route('/onu-mapping', methods=['POST'])
def save_onu_mapping():
    """
    Body JSON:
    {
        "username"  : "pelanggan01",
        "olt_id"    : 1,
        "slot_port" : "0/1/1:1",
        "vlan"      : "100",
        "sn"        : "HWTC1A2B3C4D",
        "rx_power"  : -24.5,     ← opsional
        "tx_power"  : 2.1        ← opsional
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


