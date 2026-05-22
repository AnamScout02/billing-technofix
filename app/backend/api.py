"""
api.py — TechnoFix Backend
============================
Blueprint Flask yang mencakup semua endpoint API:
  1. Pelanggan (PPP Secrets MikroTik + ONU mapping)
  2. Peta Topologi Jaringan
  3. Keuangan (transaksi, statistik)
  4. PPPoE Profile (MikroTik + harga lokal)

Menggunakan utils.py untuk helper terpusat.

✅ FASE 1 — CLEANUP:
   - Hapus Blueprint duplikat (api_bp dideklarasikan 2x → crash AssertionError).
   - Hapus semua docstring artefak instruksi copy-paste
     ("maps_api_snippet.py", "keuangan_api_snippet.py", dll).
   - Selamatkan endpoint action_pelanggan & PPPoE Profile yang
     sebelumnya hanya ada di duplikat kedua — dipindah ke sini.
   - Pindahkan init_keuangan_table() agar dipanggil dari init_db()
     di input.py, bukan auto-run saat import (side-effect berbahaya).
"""

import os
import logging
from datetime import datetime, date
import calendar

from flask import Blueprint, jsonify, request

# ── Shared helpers ────────────────────────────────────────────
from utils import get_db, get_onu_data

# ── MikroTik client ───────────────────────────────────────────
from mikrotik import MikroTikClient, MikroTikError

# ── Scrapli untuk RX/TX real-time dari OLT (opsional) ────────
try:
    from scrapli.driver.generic import GenericDriver
    SCRAPLI_OK = True
except ImportError:
    SCRAPLI_OK = False

# ── Blueprint ─────────────────────────────────────────────────
# [SATU DEFINISI — duplikat di baris ~1389 asli dihapus]
api_bp = Blueprint('api', __name__)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


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
# BAGIAN 1 — PELANGGAN (PPP Secrets + ONU Mapping)
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/<int:device_id>', methods=['GET'])
def get_pelanggan(device_id):
    """
    Gabungkan data PPP Secret dari MikroTik dengan data ONU
    (slot_port, vlan, sn, rx_power, tx_power) dari tabel onu_mapping.

    Response per item:
    {
        "id":        ".1",
        "username":  "pelanggan01",
        "profil":    "10Mbps",
        "hp":        "08123456789",
        "status":    "Online" | "Offline",
        "slot_port": "0/1/1:3",
        "vlan":      "100",
        "sn":        "HWTC1A2B3C4D",
        "rx_power":  -24.5,
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

            secrets      = list(api.path('/ppp/secret'))
            active_conns = list(api.path('/ppp/active'))
            active_names = {a.get('name') for a in active_conns}

        hasil = []
        conn  = get_db()
        for s in secrets:
            username = str(s.get('name', '') or '')
            onu      = get_onu_data(username)

            # Ambil hp & tgl dari tabel pelanggan lokal
            row_lokal = conn.execute(
                'SELECT hp, tgl_pasang, tgl_jatuh, titik_koordinat FROM pelanggan WHERE username = ?',
                (username,)
            ).fetchone()

            hasil.append({
                'id':          s.get('.id'),
                'username':    username,
                'password':    s.get('password', ''),
                'profil':      s.get('profile', 'default'),
                'service':     s.get('service', 'pppoe'),
                'comment':     s.get('comment', ''),
                'disabled':    s.get('disabled', 'false'),
                'status':      'Online' if username in active_names else 'Offline',
                # Data dari tabel lokal
                'hp':          row_lokal['hp']            if row_lokal else '',
                'tgl_pasang':  row_lokal['tgl_pasang']    if row_lokal else '',
                'tgl_jatuh':   row_lokal['tgl_jatuh']     if row_lokal else '',
                'koordinat':   row_lokal['titik_koordinat'] if row_lokal else '',
                # Data ONU dari onu_mapping
                'slot_port':   onu['slot_port'],
                'vlan':        onu['vlan'],
                'sn':          onu['sn'],
                'olt_id':      onu['olt_id'],
                'rx_power':    onu['rx_power'],
                'tx_power':    onu['tx_power'],
            })
        conn.close()

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Terjadi kesalahan internal: {str(e)}'}), 500


@api_bp.route('/pelanggan', methods=['POST'])
def add_pelanggan():
    """Tambah PPP Secret baru ke MikroTik + simpan ke DB lokal."""
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
        # [DIPERBAIKI] tambahkan kolom service, tgl_pasang, tgl_jatuh
        conn = get_db()
        conn.execute(
            '''INSERT INTO pelanggan
               (device_id, username, password, profil, service,
                hp, sn, slot_port_onu, vlan, titik_koordinat,
                tgl_pasang, tgl_jatuh)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                device_id, username, password,
                body.get('profil', 'default'),
                body.get('service', 'pppoe'),
                body.get('hp', ''),
                body.get('sn', ''),
                body.get('slot_port', ''),
                body.get('vlan', ''),
                body.get('koordinat', ''),
                body.get('tgl_pasang', ''),
                body.get('tgl_jatuh', ''),
            )
        )
        # Simpan/update onu_mapping jika ada data OLT
        if body.get('olt_id') or body.get('sn') or body.get('slot_port'):
            conn.execute(
                '''INSERT INTO onu_mapping
                   (username, olt_id, slot_port, vlan, sn)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     olt_id    = excluded.olt_id,
                     slot_port = excluded.slot_port,
                     vlan      = excluded.vlan,
                     sn        = excluded.sn''',
                (username, body.get('olt_id'), body.get('slot_port', ''),
                 body.get('vlan', ''), body.get('sn', ''))
            )
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil ditambahkan ke MikroTik'}), 201

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['PUT'])
def update_pelanggan(pelanggan_id):
    """Edit PPP Secret di MikroTik + perbarui DB lokal."""
    body = request.get_json(silent=True) or {}

    device_id = body.get('device_id')
    username  = (body.get('username') or '').strip()

    if not device_id: return jsonify({'error': 'device_id wajib'}), 400
    if not username:  return jsonify({'error': 'username wajib'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    update_mt = {}
    if body.get('password'):
        update_mt['password'] = body['password']
    if body.get('profil'):
        update_mt['profile'] = body['profil']
    if body.get('service'):
        update_mt['service'] = body['service']
    if 'disabled' in body:
        update_mt['disabled'] = 'yes' if body['disabled'] else 'no'

    try:
        if update_mt:
            with MikroTikClient(device) as mt:
                mt.edit_secret(username, update_mt)

        # [DIPERBAIKI] tambahkan tgl_pasang, tgl_jatuh ke UPDATE
        conn = get_db()
        conn.execute(
            '''UPDATE pelanggan
               SET profil = ?, hp = ?, sn = ?,
                   slot_port_onu = ?, vlan = ?, titik_koordinat = ?,
                   tgl_pasang = ?, tgl_jatuh = ?
               WHERE id = ?''',
            (
                body.get('profil', ''),
                body.get('hp', ''),
                body.get('sn', ''),
                body.get('slot_port', ''),
                body.get('vlan', ''),
                body.get('koordinat', ''),
                body.get('tgl_pasang', ''),
                body.get('tgl_jatuh', ''),
                pelanggan_id,
            )
        )
        # Update onu_mapping juga
        if body.get('olt_id') or body.get('sn') or body.get('slot_port'):
            conn.execute(
                '''INSERT INTO onu_mapping
                   (username, olt_id, slot_port, vlan, sn)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     olt_id    = excluded.olt_id,
                     slot_port = excluded.slot_port,
                     vlan      = excluded.vlan,
                     sn        = excluded.sn''',
                (username, body.get('olt_id'), body.get('slot_port', ''),
                 body.get('vlan', ''), body.get('sn', ''))
            )
        conn.commit()
        conn.close()

        return jsonify({'message': f'{username} berhasil diperbarui'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/pelanggan/<int:pelanggan_id>', methods=['DELETE'])
def delete_pelanggan(pelanggan_id):
    """Hapus PPP Secret dari MikroTik + hapus dari DB lokal."""
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


@api_bp.route('/pelanggan/<int:device_id>/rx-tx', methods=['GET'])
def get_rx_tx(device_id):
    """
    Ambil data RX/TX power (dBm) untuk semua pelanggan di device_id.

    Query params:
      ?realtime=1  → langsung tembak OLT via Scrapli (lebih lambat)
      (default)    → baca dari cache DB (tabel onu_mapping)
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    realtime = request.args.get('realtime', '0') == '1'

    try:
        with MikroTikClient(device) as mt:
            api     = mt._get_api()
            secrets = list(api.path('/ppp/secret'))

        hasil = []
        for s in secrets:
            username = str(s.get('name', '') or '')
            if not username:
                continue

            onu      = get_onu_data(username)
            rx_power = onu['rx_power']
            tx_power = onu['tx_power']
            source   = 'db'

            if realtime and SCRAPLI_OK and onu['olt_id']:
                olt = cari_olt(onu['olt_id'])
                if olt and onu['slot_port']:
                    try:
                        rt = _get_rx_tx_realtime(olt, onu['slot_port'])
                        if rt['rx_power'] is not None:
                            rx_power = rt['rx_power']
                            tx_power = rt['tx_power']
                            source   = 'realtime'
                            _update_rx_tx_cache(username, rx_power, tx_power)
                    except Exception:
                        pass

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
    """Ambil nilai RX/TX power langsung dari OLT via SSH/Telnet."""
    from utils import parse_huawei_rx, parse_zte_rx, parse_generic_rx

    result = {'rx_power': None, 'tx_power': None}
    if not SCRAPLI_OK:
        return result

    tipe = (olt.get('tipe') or '').lower()

    if 'zte' in tipe:
        cmd = f'show pon onu optical-info gpon-onu_{slot_port}'
    elif 'huawei' in tipe:
        parts = slot_port.split(':')
        port  = parts[0] if parts else slot_port
        ont   = parts[1] if len(parts) > 1 else '0'
        cmd   = f'display ont optical-info {port} {ont}'
    else:
        cmd = f'show onu optical-info {slot_port}'

    device_cfg = {
        'host':                 olt['ip'],
        'port':                 int(olt.get('port', 23)),
        'auth_username':        olt['username'],
        'auth_password':        olt['password'],
        'auth_strict_key':      False,
        'transport':            'telnet',
        'timeout_ops':          15,
        'comms_prompt_pattern': r'.*[>#\$]',
    }

    with GenericDriver(**device_cfg) as conn:
        output = conn.send_command(cmd).result

    if 'zte' in tipe:
        return parse_zte_rx(output)
    elif 'huawei' in tipe:
        return parse_huawei_rx(output)
    else:
        return parse_generic_rx(output)


def _update_rx_tx_cache(username: str, rx_power, tx_power):
    """Update kolom rx_power & tx_power di tabel onu_mapping."""
    conn = get_db()
    conn.execute(
        'UPDATE onu_mapping SET rx_power = ?, tx_power = ? WHERE username = ?',
        (rx_power, tx_power, username)
    )
    conn.commit()
    conn.close()


@api_bp.route('/onu-mapping', methods=['POST'])
def save_onu_mapping():
    """
    Simpan/update data ONU untuk satu username.

    Body JSON:
    {
        "username"  : "pelanggan01",
        "olt_id"    : 1,
        "slot_port" : "0/1/1:1",
        "vlan"      : "100",
        "sn"        : "HWTC1A2B3C4D",
        "rx_power"  : -24.5,
        "tx_power"  : 2.1
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


# ══════════════════════════════════════════════════════════════
# BAGIAN 2 — ACTION PELANGGAN
# [DIPINDAHKAN DARI DUPLIKAT KEDUA — sebelumnya hanya ada di sana]
# ══════════════════════════════════════════════════════════════

@api_bp.route('/pelanggan/<int:device_id>/action', methods=['POST'])
def action_pelanggan(device_id):
    """
    Aksi langsung ke PPP Secret MikroTik:
    enable, disable, reboot (putus sesi aktif).

    Body JSON:
    { "username": "pelanggan01", "action": "enable|disable|reboot" }
    """
    body     = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip()
    action   = (body.get('action')   or '').strip().lower()

    if not username:
        return jsonify({'error': 'username wajib'}), 400
    if action not in ('enable', 'disable', 'reboot'):
        return jsonify({'error': 'action harus: enable | disable | reboot'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        from librouteros.query import Key

        with MikroTikClient(device) as mt:
            api = mt._get_api()

            if action in ('enable', 'disable'):
                path   = api.path('/ppp/secret')
                target = next(
                    (r for r in path.select(Key('.id'), Key('name'))
                     if r.get('name') == username),
                    None
                )
                if not target:
                    return jsonify({'error': f'Pelanggan {username} tidak ditemukan di MikroTik'}), 404

                path.update(**{
                    '.id':      target['.id'],
                    'disabled': 'yes' if action == 'disable' else 'no',
                })
                label = 'dinonaktifkan' if action == 'disable' else 'diaktifkan kembali'

            else:  # reboot — putus sesi aktif
                active_path = api.path('/ppp/active')
                active = next(
                    (r for r in active_path.select(Key('.id'), Key('name'))
                     if r.get('name') == username),
                    None
                )
                if active:
                    active_path.remove(active['.id'])
                    label = 'sesi aktif diputus (akan reconnect otomatis)'
                else:
                    label = 'tidak ada sesi aktif untuk diputus'

        return jsonify({'message': f'{username}: {label}'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


# ══════════════════════════════════════════════════════════════
# BAGIAN 3 — PETA TOPOLOGI
# ══════════════════════════════════════════════════════════════

@api_bp.route('/maps/topology', methods=['GET'])
def get_topology():
    """
    Mengembalikan data node & link topologi jaringan untuk Leaflet.js.

    ⚠ Catatan: data di bawah masih hardcoded sebagai placeholder.
    TODO Fase 4: ganti dengan query dari tabel devices, olt, odp, onu_mapping.
    """
    nodes = [
        {
            "id": "router-1", "type": "router", "name": "Router Core Banyuwangi",
            "lat": -8.2192, "lng": 114.3691, "status": "online",
            "detail": {"ip": "192.168.1.1", "model": "MikroTik CCR1036",
                       "uptime": "47d 12h 33m", "lokasi": "NOC Pusat, Jl. A. Yani Banyuwangi"}
        },
        {
            "id": "router-2", "type": "router", "name": "Router Core Genteng",
            "lat": -8.3731, "lng": 114.1567, "status": "online",
            "detail": {"ip": "192.168.1.2", "model": "MikroTik CCR1009",
                       "uptime": "12d 8h 15m", "lokasi": "NOC Genteng, Jl. PB Sudirman"}
        },
        {
            "id": "olt-1", "type": "olt", "name": "OLT-Banyuwangi-1",
            "lat": -8.2305, "lng": 114.3788, "status": "online",
            "detail": {"ip": "10.10.1.10", "tipe": "Huawei MA5800",
                       "port": "16 PON Port", "lokasi": "Ruko Brawijaya, Banyuwangi Kota"}
        },
        {
            "id": "olt-2", "type": "olt", "name": "OLT-Rogojampi",
            "lat": -8.2988, "lng": 114.2854, "status": "online",
            "detail": {"ip": "10.10.1.11", "tipe": "ZTE C300",
                       "port": "8 PON Port", "lokasi": "Jl. Raya Rogojampi"}
        },
        {
            "id": "olt-3", "type": "olt", "name": "OLT-Srono",
            "lat": -8.3512, "lng": 114.2134, "status": "offline",
            "detail": {"ip": "10.10.1.12", "tipe": "Huawei MA5600",
                       "port": "8 PON Port", "lokasi": "Jl. Raya Srono"}
        },
        {
            "id": "olt-4", "type": "olt", "name": "OLT-Genteng",
            "lat": -8.3641, "lng": 114.1478, "status": "online",
            "detail": {"ip": "10.10.1.13", "tipe": "ZTE C600",
                       "port": "16 PON Port", "lokasi": "Kawasan Industri Genteng"}
        },
        {
            "id": "odp-1", "type": "odp", "name": "ODP-BWI-A1",
            "lat": -8.2245, "lng": 114.3853, "status": "online",
            "detail": {"kapasitas": "16 port", "terisi": "12 port",
                       "lokasi": "Tiang JTM, Jl. Veteran No.12"}
        },
        {
            "id": "odp-2", "type": "odp", "name": "ODP-BWI-A2",
            "lat": -8.2178, "lng": 114.3915, "status": "online",
            "detail": {"kapasitas": "8 port", "terisi": "7 port",
                       "lokasi": "Tiang JTM, Jl. Ikan Tongkol"}
        },
        {
            "id": "odp-3", "type": "odp", "name": "ODP-RGJ-B1",
            "lat": -8.2920, "lng": 114.2945, "status": "online",
            "detail": {"kapasitas": "16 port", "terisi": "9 port",
                       "lokasi": "Tiang JTM, Jl. Ahmad Dahlan"}
        },
        {
            "id": "odp-4", "type": "odp", "name": "ODP-SRN-C1",
            "lat": -8.3488, "lng": 114.2202, "status": "offline",
            "detail": {"kapasitas": "8 port", "terisi": "5 port",
                       "lokasi": "Tiang JTM, Jl. Raya Srono Km.3"}
        },
        {
            "id": "odp-5", "type": "odp", "name": "ODP-GTG-D1",
            "lat": -8.3598, "lng": 114.1555, "status": "online",
            "detail": {"kapasitas": "16 port", "terisi": "11 port",
                       "lokasi": "Tiang JTM, Jl. PB Sudirman Genteng"}
        },
        {
            "id": "odp-6", "type": "odp", "name": "ODP-GTG-D2",
            "lat": -8.3721, "lng": 114.1622, "status": "online",
            "detail": {"kapasitas": "8 port", "terisi": "6 port",
                       "lokasi": "Tiang JTM, Jl. Raya Glenmore"}
        },
        {
            "id": "onu-1", "type": "onu", "name": "pelanggan.budi",
            "lat": -8.2260, "lng": 114.3878, "status": "online", "rx_power": -18.5,
            "detail": {"profil": "FTTH-10Mbps", "sn": "HWTC1A2B3C4D",
                       "vlan": "100", "slot_port": "0/0/1", "hp": "08123456789"}
        },
        {
            "id": "onu-2", "type": "onu", "name": "pelanggan.sari",
            "lat": -8.2195, "lng": 114.3932, "status": "online", "rx_power": -22.8,
            "detail": {"profil": "FTTH-20Mbps", "sn": "ZTEG5E6F7G8H",
                       "vlan": "101", "slot_port": "0/0/2", "hp": "08234567890"}
        },
        {
            "id": "onu-3", "type": "onu", "name": "pelanggan.wawan",
            "lat": -8.2930, "lng": 114.2965, "status": "online", "rx_power": -19.2,
            "detail": {"profil": "FTTH-10Mbps", "sn": "HWTCA1B2C3D4",
                       "vlan": "200", "slot_port": "0/1/1", "hp": "08345678901"}
        },
        {
            "id": "onu-4", "type": "onu", "name": "pelanggan.dewi",
            "lat": -8.2905, "lng": 114.2925, "status": "online", "rx_power": -26.4,
            "detail": {"profil": "FTTH-30Mbps", "sn": "ZTEGE5F6G7H8",
                       "vlan": "201", "slot_port": "0/1/2", "hp": "08456789012"}
        },
        {
            "id": "onu-5", "type": "onu", "name": "pelanggan.rizal",
            "lat": -8.3502, "lng": 114.2218, "status": "offline", "rx_power": -30.1,
            "detail": {"profil": "FTTH-10Mbps", "sn": "HWTC9I0J1K2L",
                       "vlan": "300", "slot_port": "0/2/1", "hp": "08567890123"}
        },
        {
            "id": "onu-6", "type": "onu", "name": "pelanggan.andi",
            "lat": -8.3615, "lng": 114.1572, "status": "online", "rx_power": -20.9,
            "detail": {"profil": "FTTH-20Mbps", "sn": "ZTEGM3N4O5P6",
                       "vlan": "400", "slot_port": "0/3/1", "hp": "08678901234"}
        },
        {
            "id": "onu-7", "type": "onu", "name": "pelanggan.fitri",
            "lat": -8.3738, "lng": 114.1640, "status": "online", "rx_power": -17.3,
            "detail": {"profil": "FTTH-50Mbps", "sn": "HWTCQ7R8S9T0",
                       "vlan": "401", "slot_port": "0/3/2", "hp": "08789012345"}
        },
        {
            "id": "onu-8", "type": "onu", "name": "pelanggan.hendra",
            "lat": -8.2158, "lng": 114.3950, "status": "online", "rx_power": -23.5,
            "detail": {"profil": "FTTH-10Mbps", "sn": "ZTEGU1V2W3X4",
                       "vlan": "102", "slot_port": "0/0/3", "hp": "08890123456"}
        },
    ]

    links = [
        {"source": "router-1", "target": "olt-1"},
        {"source": "router-1", "target": "olt-2"},
        {"source": "router-1", "target": "olt-3"},
        {"source": "router-2", "target": "olt-4"},
        {"source": "router-1", "target": "router-2"},
        {"source": "olt-1", "target": "odp-1"},
        {"source": "olt-1", "target": "odp-2"},
        {"source": "olt-2", "target": "odp-3"},
        {"source": "olt-3", "target": "odp-4"},
        {"source": "olt-4", "target": "odp-5"},
        {"source": "olt-4", "target": "odp-6"},
        {"source": "odp-1", "target": "onu-1"},
        {"source": "odp-2", "target": "onu-2"},
        {"source": "odp-2", "target": "onu-8"},
        {"source": "odp-3", "target": "onu-3"},
        {"source": "odp-3", "target": "onu-4"},
        {"source": "odp-4", "target": "onu-5"},
        {"source": "odp-5", "target": "onu-6"},
        {"source": "odp-6", "target": "onu-7"},
    ]

    return jsonify({"nodes": nodes, "links": links}), 200


@api_bp.route('/maps/legend', methods=['GET'])
def get_legend():
    """Keterangan warna dan simbol peta."""
    return jsonify({
        "device_types": [
            {"type": "router", "label": "Router/Core",     "color": "#0040a1"},
            {"type": "olt",    "label": "OLT",             "color": "#7c3aed"},
            {"type": "odp",    "label": "ODP",             "color": "#b45309"},
            {"type": "onu",    "label": "ONU (Pelanggan)", "color": "#006c47"},
        ],
        "rx_power_levels": [
            {"label": "Normal",         "range": "> -20 dBm",       "color": "#16a34a"},
            {"label": "Redaman Tinggi", "range": "-20 s/d -25 dBm", "color": "#d97706"},
            {"label": "LOS / Kritis",   "range": "< -25 dBm",       "color": "#dc2626"},
        ],
        "link_colors": [
            {"label": "Online",  "color": "#22c55e"},
            {"label": "Offline", "color": "#ef4444"},
        ]
    }), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 4 — KEUANGAN
# ══════════════════════════════════════════════════════════════

def keuangan_to_dict(row) -> dict:
    """Ubah sqlite3.Row tabel 'keuangan' → dict JSON-serializable."""
    return {
        'id':          row['id'],
        'tanggal':     row['tanggal'],
        'keterangan':  row['keterangan'],
        'tipe':        row['tipe'],
        'nominal':     row['nominal'],
        'status':      row['status'],
        'metode':      row['metode'],
        'device_id':   row['device_id'],
        'username':    row['username']   or '',
        'catatan':     row['catatan']    or '',
        'created_at':  row['created_at'] or '',
    }


def _bulan_ini():
    """Kembalikan (awal_bulan, akhir_bulan) dalam format YYYY-MM-DD."""
    today = date.today()
    awal  = today.replace(day=1).isoformat()
    akhir = today.replace(
        day=calendar.monthrange(today.year, today.month)[1]
    ).isoformat()
    return awal, akhir


@api_bp.route('/keuangan', methods=['GET'])
def get_keuangan():
    """
    Ringkasan statistik + daftar transaksi dengan filter & paginasi.

    Query params:
      q, tipe, status, bulan (YYYY-MM), limit, offset
    """
    q       = request.args.get('q',      '').strip()
    tipe    = request.args.get('tipe',   '').strip().lower()
    status  = request.args.get('status', '').strip()
    bulan   = request.args.get('bulan',  '').strip()
    limit   = int(request.args.get('limit',  100))
    offset  = int(request.args.get('offset', 0))

    if bulan:
        try:
            y, m  = map(int, bulan.split('-'))
            awal  = date(y, m, 1).isoformat()
            akhir = date(y, m, calendar.monthrange(y, m)[1]).isoformat()
        except Exception:
            awal, akhir = _bulan_ini()
    else:
        awal, akhir = _bulan_ini()

    try:
        bulan_label = datetime.strptime(awal, '%Y-%m-%d').strftime('%B %Y')
    except Exception:
        bulan_label = ''

    conn = get_db()

    stat_rows = conn.execute('''
        SELECT tipe, status, SUM(nominal) AS total
        FROM keuangan
        WHERE tanggal BETWEEN ? AND ?
        GROUP BY tipe, status
    ''', (awal, akhir)).fetchall()

    total_pemasukan = total_piutang = total_pengeluaran = 0
    for r in stat_rows:
        if r['tipe'] == 'pemasukan':
            if r['status'] == 'Lunas':
                total_pemasukan += r['total']
            elif r['status'] == 'Pending':
                total_piutang   += r['total']
        elif r['tipe'] == 'pengeluaran' and r['status'] in ('Lunas', 'Pending'):
            total_pengeluaran += r['total']

    where  = ['tanggal BETWEEN ? AND ?']
    params = [awal, akhir]

    if tipe in ('pemasukan', 'pengeluaran'):
        where.append('tipe = ?')
        params.append(tipe)
    if status:
        where.append('status = ?')
        params.append(status)
    if q:
        where.append('(keterangan LIKE ? OR username LIKE ? OR catatan LIKE ?)')
        like = f'%{q}%'
        params.extend([like, like, like])

    where_sql  = 'WHERE ' + ' AND '.join(where)
    total_rows = conn.execute(
        f'SELECT COUNT(*) FROM keuangan {where_sql}', params
    ).fetchone()[0]

    rows = conn.execute(
        f'SELECT * FROM keuangan {where_sql} ORDER BY tanggal DESC, id DESC LIMIT ? OFFSET ?',
        params + [limit, offset]
    ).fetchall()
    conn.close()

    return jsonify({
        'stats': {
            'total_pemasukan':   total_pemasukan,
            'total_piutang':     total_piutang,
            'total_pengeluaran': total_pengeluaran,
            'saldo_bersih':      total_pemasukan - total_pengeluaran,
            'bulan_label':       bulan_label,
            'range':             {'awal': awal, 'akhir': akhir},
        },
        'transaksi':  [keuangan_to_dict(r) for r in rows],
        'total_rows': total_rows,
    }), 200


@api_bp.route('/keuangan', methods=['POST'])
def tambah_keuangan():
    """Catat transaksi baru."""
    data = request.get_json() or {}

    keterangan = data.get('keterangan', '').strip()
    tipe       = data.get('tipe',       '').strip().lower()
    nominal    = data.get('nominal',    0)
    tanggal    = data.get('tanggal',    date.today().isoformat()).strip()
    status     = data.get('status',     'Pending').strip()
    metode     = data.get('metode',     'Transfer').strip()
    device_id  = data.get('device_id',  None)
    username   = data.get('username',   '').strip()
    catatan    = data.get('catatan',    '').strip()

    if not keterangan:
        return jsonify({'status': 'error', 'message': 'Keterangan wajib diisi'}), 400
    if tipe not in ('pemasukan', 'pengeluaran'):
        return jsonify({'status': 'error', 'message': 'Tipe harus pemasukan atau pengeluaran'}), 400
    try:
        nominal = int(nominal)
        if nominal < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({'status': 'error', 'message': 'Nominal harus berupa angka positif'}), 400
    if status not in ('Lunas', 'Pending', 'Gagal'):
        status = 'Pending'

    conn   = get_db()
    cursor = conn.execute('''
        INSERT INTO keuangan
          (tanggal, keterangan, tipe, nominal, status, metode,
           device_id, username, catatan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (tanggal, keterangan, tipe, nominal, status, metode,
          device_id, username, catatan))
    new_id = cursor.lastrowid
    conn.commit()

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   'Transaksi berhasil dicatat',
        'transaksi': keuangan_to_dict(row),
    }), 201


@api_bp.route('/keuangan/<int:trx_id>', methods=['PUT'])
def update_keuangan(trx_id):
    """Edit data transaksi berdasarkan ID."""
    conn    = get_db()
    current = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    data = request.get_json() or {}

    keterangan = data.get('keterangan', current['keterangan']).strip()
    tipe       = data.get('tipe',       current['tipe']).strip().lower()
    tanggal    = data.get('tanggal',    current['tanggal']).strip()
    metode     = data.get('metode',     current['metode']).strip()
    status     = data.get('status',     current['status']).strip()
    username   = data.get('username',   current['username'] or '').strip()
    catatan    = data.get('catatan',    current['catatan']  or '').strip()
    device_id  = data.get('device_id',  current['device_id'])

    try:
        nominal = int(data.get('nominal', current['nominal']))
    except (ValueError, TypeError):
        nominal = current['nominal']

    if tipe   not in ('pemasukan', 'pengeluaran'): tipe   = current['tipe']
    if status not in ('Lunas', 'Pending', 'Gagal'): status = current['status']

    conn.execute('''
        UPDATE keuangan
        SET tanggal=?, keterangan=?, tipe=?, nominal=?, status=?,
            metode=?, device_id=?, username=?, catatan=?
        WHERE id=?
    ''', (tanggal, keterangan, tipe, nominal, status,
          metode, device_id, username, catatan, trx_id))
    conn.commit()

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   'Transaksi berhasil diperbarui',
        'transaksi': keuangan_to_dict(row),
    }), 200


@api_bp.route('/keuangan/<int:trx_id>', methods=['DELETE'])
def hapus_keuangan(trx_id):
    """Hapus satu transaksi berdasarkan ID."""
    conn     = get_db()
    affected = conn.execute('DELETE FROM keuangan WHERE id = ?', (trx_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    return jsonify({'status': 'success', 'message': 'Transaksi berhasil dihapus'}), 200


@api_bp.route('/keuangan/<int:trx_id>/lunas', methods=['POST'])
def set_lunas(trx_id):
    """
    Ubah status transaksi menjadi 'Lunas'.

    TODO Fase 4: Tambahkan logika auto-buka blokir MikroTik di sini.
    Skeleton tersedia di komentar — uncomment dan sesuaikan.
    """
    conn = get_db()
    row  = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()

    if not row:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404

    if row['status'] == 'Lunas':
        conn.close()
        return jsonify({'status': 'info', 'message': 'Transaksi sudah berstatus Lunas'}), 200

    conn.execute("UPDATE keuangan SET status = 'Lunas' WHERE id = ?", (trx_id,))
    conn.commit()

    # TODO Fase 4: auto-buka blokir MikroTik
    # if row['device_id'] and row['username']:
    #     device = get_db().execute(
    #         'SELECT * FROM devices WHERE id = ?', (row['device_id'],)
    #     ).fetchone()
    #     if device:
    #         try:
    #             with MikroTikClient(dict(device)) as mt:
    #                 mt.edit_secret(row['username'], {'disabled': 'no'})
    #         except MikroTikError as e:
    #             logging.warning(f'[Lunas] Gagal buka blokir: {e}')

    row = conn.execute('SELECT * FROM keuangan WHERE id = ?', (trx_id,)).fetchone()
    conn.close()

    return jsonify({
        'status':    'success',
        'message':   f'Transaksi #{trx_id} berhasil ditandai Lunas',
        'transaksi': keuangan_to_dict(row),
    }), 200


@api_bp.route('/keuangan/metode', methods=['GET'])
def get_metode():
    """Daftar metode pembayaran yang tersedia."""
    return jsonify([
        'Transfer', 'Tunai', 'QRIS', 'GoPay', 'OVO',
        'Dana', 'ShopeePay', 'Debit', 'Kredit',
    ]), 200


# ══════════════════════════════════════════════════════════════
# BAGIAN 5 — PPPoE PROFILE
# [DIPINDAHKAN DARI DUPLIKAT KEDUA — sebelumnya hanya ada di sana]
# ══════════════════════════════════════════════════════════════

def _get_harga_map(device_id: int) -> dict:
    """
    Ambil semua data harga dari tabel profil_harga untuk device ini.
    Return: { nama_profile: {harga, deskripsi} }
    """
    conn = get_db()
    rows = conn.execute(
        'SELECT nama_profile, harga, deskripsi FROM profil_harga WHERE device_id = ?',
        (device_id,)
    ).fetchall()
    conn.close()
    return {r['nama_profile']: {'harga': r['harga'], 'deskripsi': r['deskripsi']} for r in rows}


def _build_rate_limit(body: dict) -> str:
    """
    Bangun string rate-limit MikroTik dari data form.

    Input: { rate_down: "10", rate_unit_d: "M", rate_up: "10", rate_unit_u: "M" }
           atau { rate_limit: "10M/10M" }
    Output: "10M/10M" atau "" jika kosong
    """
    raw = (body.get('rate_limit') or '').strip()
    if raw:
        return raw

    down = str(body.get('rate_down') or '').strip()
    up   = str(body.get('rate_up')   or '').strip()
    ud   = (body.get('rate_unit_d') or 'M').strip().upper()
    uu   = (body.get('rate_unit_u') or 'M').strip().upper()

    if not down or not up:
        return ''

    return f'{down}{ud}/{up}{uu}'


@api_bp.route('/profile/<int:device_id>', methods=['GET'])
def get_profiles(device_id):
    """
    Ambil semua PPP Profile dari MikroTik + data harga dari DB lokal.

    Response per item:
    {
        "id", "name", "rate_limit", "rate_down", "rate_up",
        "harga", "deskripsi", "comment", "total_user"
    }
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            profiles = mt.get_ppp_profiles()
            api      = mt._get_api()
            secrets  = list(api.path('/ppp/secret'))

        user_count = {}
        for s in secrets:
            p = s.get('profile', 'default')
            user_count[p] = user_count.get(p, 0) + 1

        harga_map = _get_harga_map(device_id)

        hasil = []
        for p in profiles:
            nama       = p.get('name', '')
            harga_data = harga_map.get(nama, {})
            hasil.append({
                'id':          p.get('.id', ''),
                'name':        nama,
                'rate_limit':  p.get('rate_limit_raw', ''),
                'rate_down':   p.get('rate_down', 'unlimited'),
                'rate_up':     p.get('rate_up',   'unlimited'),
                'local_addr':  p.get('local-address', ''),
                'remote_addr': p.get('remote-address', ''),
                'comment':     p.get('comment', ''),
                'harga':       harga_data.get('harga', 0),
                'deskripsi':   harga_data.get('deskripsi', ''),
                'total_user':  user_count.get(nama, 0),
            })

        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/profile/<int:device_id>', methods=['POST'])
def add_profile(device_id):
    """Tambah PPP Profile baru ke MikroTik + simpan harga ke DB."""
    body  = request.get_json(silent=True) or {}
    nama  = (body.get('name') or '').strip()
    harga = int(body.get('harga') or 0)

    if not nama:
        return jsonify({'error': 'Nama profile wajib diisi'}), 400

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    rate_limit = _build_rate_limit(body)

    try:
        with MikroTikClient(device) as mt:
            mt.tambah_profile({
                'name':       nama,
                'rate-limit': rate_limit,
                'comment':    body.get('comment', ''),
            })

        conn = get_db()
        conn.execute(
            '''INSERT INTO profil_harga (device_id, nama_profile, harga, deskripsi)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(device_id, nama_profile) DO UPDATE SET
                 harga     = excluded.harga,
                 deskripsi = excluded.deskripsi''',
            (device_id, nama, harga, body.get('deskripsi', ''))
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'Profile {nama} berhasil ditambahkan'}), 201

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/profile/<int:device_id>/<string:nama_profile>', methods=['PUT'])
def update_profile(device_id, nama_profile):
    """Edit PPP Profile di MikroTik + update harga di DB."""
    body      = request.get_json(silent=True) or {}
    nama_baru = (body.get('name') or nama_profile).strip()
    harga     = int(body.get('harga') or 0)

    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    rate_limit = _build_rate_limit(body)

    try:
        with MikroTikClient(device) as mt:
            mt.edit_profile(nama_profile, {
                'name':       nama_baru,
                'rate-limit': rate_limit,
                'comment':    body.get('comment', ''),
            })

        conn = get_db()
        if nama_baru != nama_profile:
            conn.execute(
                'DELETE FROM profil_harga WHERE device_id=? AND nama_profile=?',
                (device_id, nama_profile)
            )
        conn.execute(
            '''INSERT INTO profil_harga (device_id, nama_profile, harga, deskripsi)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(device_id, nama_profile) DO UPDATE SET
                 harga     = excluded.harga,
                 deskripsi = excluded.deskripsi''',
            (device_id, nama_baru, harga, body.get('deskripsi', ''))
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'Profile {nama_baru} berhasil diperbarui'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500


@api_bp.route('/profile/<int:device_id>/<string:nama_profile>', methods=['DELETE'])
def delete_profile(device_id, nama_profile):
    """Hapus PPP Profile dari MikroTik + hapus harga dari DB."""
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            mt.hapus_profile(nama_profile)

        conn = get_db()
        conn.execute(
            'DELETE FROM profil_harga WHERE device_id=? AND nama_profile=?',
            (device_id, nama_profile)
        )
        conn.commit()
        conn.close()

        return jsonify({'message': f'Profile {nama_profile} berhasil dihapus'}), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502
    except Exception as e:
        return jsonify({'error': f'Kesalahan server: {str(e)}'}), 500