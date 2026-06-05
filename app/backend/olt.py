"""
olt.py — TechnoFix · Blueprint OLT
====================================
CRUD endpoint untuk perangkat OLT (Optical Line Terminal).

Menggunakan utils.py untuk helper terpusat:
  - get_db(), olt_to_dict(), try_connect_olt()
"""

import logging
from flask import Blueprint, request, jsonify, g

# ── Shared helpers ─────────────────────────────────────────────
from utils import get_db, olt_to_dict, try_connect_olt

# ── Blueprint ──────────────────────────────────────────────────
olt_bp = Blueprint('olt', __name__)


# ── Guard multi-tenant: login + cek lock langganan ─────────────
@olt_bp.before_request
def _olt_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    perm = 'perangkat_manage' if request.method in ('POST','PUT','DELETE') else 'perangkat'
    return guard_request(perm=perm)

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
            status      TEXT    NOT NULL DEFAULT 'pending',
            koordinat   TEXT    DEFAULT ''
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

    name             = data.get('name',             '').strip()
    tipe             = data.get('tipe',             '').strip()
    ip               = data.get('ip',               '').strip()
    port             = data.get('port',             23)
    username         = data.get('username',         '').strip()
    password         = data.get('password',         '').strip()
    snmp             = data.get('snmp',             '').strip()
    lokasi           = data.get('lokasi',           '').strip()
    koordinat        = data.get('koordinat',        '').strip()
    keterangan       = data.get('keterangan',       '').strip()
    epon_ports       = int(data.get('epon_ports') or 4)
    router_id        = data.get('router_id')        or None
    router_interface = data.get('router_interface', '').strip()
    olt_uplink_port  = data.get('olt_uplink_port',  '').strip()

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
           (name, tipe, ip, port, username, password, snmp, lokasi, koordinat, keterangan, status,
            router_id, router_interface, olt_uplink_port, epon_ports)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (name, tipe, ip, port, username, password, snmp, lokasi, koordinat, keterangan, status,
         router_id, router_interface, olt_uplink_port, epon_ports)
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

    name             = data.get('name',             '').strip()
    tipe             = data.get('tipe',             '').strip()
    ip               = data.get('ip',               '').strip()
    port             = data.get('port',             23)
    username         = data.get('username',         '').strip()
    password         = data.get('password',         '').strip()
    snmp             = data.get('snmp',             '').strip()
    lokasi           = data.get('lokasi',           '').strip()
    koordinat        = data.get('koordinat',        '').strip()
    keterangan       = data.get('keterangan',       '').strip()
    epon_ports       = int(data.get('epon_ports') or 4)
    router_id        = data.get('router_id')        or None
    router_interface = data.get('router_interface', '').strip()
    olt_uplink_port  = data.get('olt_uplink_port',  '').strip()

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
               snmp=?, lokasi=?, koordinat=?, keterangan=?, status=?,
               router_id=?, router_interface=?, olt_uplink_port=?, epon_ports=?
           WHERE id=?''',
        (name, tipe, ip, port, username, final_password,
         snmp, lokasi, koordinat, keterangan, 'pending',
         router_id, router_interface, olt_uplink_port, epon_ports, olt_id)
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

# ── POST /olt/<id>/sync-onu ────────────────────────────────────
@olt_bp.route('/<int:olt_id>/sync-onu', methods=['POST'])
def sync_onu_data(olt_id):
    """
    Sinkronisasi data ONU dari OLT ke tabel onu_mapping.
    Jalankan olt_sync.sync_all_olts() hanya untuk OLT ini.
    """
    conn = get_db()
    olt  = conn.execute('SELECT * FROM olt WHERE id = ?', (olt_id,)).fetchone()
    conn.close()

    if not olt:
        return jsonify({'status': 'error', 'message': 'OLT tidak ditemukan'}), 404
    if olt['status'] != 'connected':
        return jsonify({'status': 'error', 'message': 'OLT belum terhubung. Lakukan sync koneksi dulu.'}), 400

    network_id = getattr(g, 'network_id', None)
    if not network_id:
        return jsonify({'status': 'error', 'message': 'Sesi tidak valid'}), 401

    import threading
    def _run(nid):
        try:
            from olt_sync import sync_all_olts
            sync_all_olts(network_id=nid)
        except Exception as e:
            logging.warning('[OLT sync-onu] error: %s', e)

    threading.Thread(target=_run, args=(network_id,), daemon=True).start()

    return jsonify({
        'status':  'success',
        'message': 'Sinkronisasi ONU dimulai di background. Tunggu ~30 detik lalu refresh halaman Pelanggan.',
    }), 202


# ── POST /olt/<id>/scan-sn ────────────────────────────────
@olt_bp.route('/<int:olt_id>/scan-sn', methods=['POST'])
def scan_sn(olt_id):
    """
    Scan SN ONU yang terdeteksi di OLT tapi BELUM terdaftar sebagai pelanggan.
    Juga kembalikan slot/port yang ada ONU kosong (slot sudah ada tapi belum ada pelanggan).
    Menggunakan Scrapli — butuh koneksi ke OLT.
    Response: {
      unregistered: [{sn, slot_port, tipe}],
      registered:   [{sn, slot_port, username}],
      empty_slots:  {slot_port: [onu_id_kosong, ...]}
    }
    """
    try:
        from scrapli.driver.generic import GenericDriver
        SCRAPLI_OK = True
    except ImportError:
        SCRAPLI_OK = False

    conn = get_db()
    olt = conn.execute('SELECT * FROM olt WHERE id=?', (olt_id,)).fetchone()
    if not olt:
        conn.close()
        return jsonify({'error': 'OLT tidak ditemukan'}), 404
    if olt['status'] != 'connected':
        conn.close()
        return jsonify({'error': 'OLT belum terhubung. Lakukan sync koneksi dulu.'}), 400

    if not SCRAPLI_OK:
        conn.close()
        return jsonify({'error': 'scrapli tidak terpasang (pip install scrapli)'}), 500

    # Ambil SN yang sudah terdaftar di onu_mapping
    registered_map = {r['sn']: r['username'] for r in
                      conn.execute('SELECT sn, username FROM onu_mapping WHERE sn != ""').fetchall()
                      if r['sn']}
    conn.close()

    tipe = (olt['tipe'] or '').lower()
    device_cfg = {
        'host': olt['ip'], 'port': int(olt['port']),
        'auth_username': olt['username'], 'auth_password': olt['password'],
        'auth_strict_key': False, 'transport': 'telnet',
        'timeout_socket': 20, 'timeout_transport': 60, 'timeout_ops': 90,
        'comms_prompt_pattern': r'.*[>#\$]',
        'transport_options': {'telnet': {
            'auth_username_pattern': r'(?i)(?:user\s?name|login|user)\s*?:',
            'auth_password_pattern': r'(?i)password\s*?:',
        }},
    }

    unregistered = []
    registered_found = []
    import re as _re

    try:
        with GenericDriver(**device_cfg) as ssh:
            prompt = ''
            try: prompt = ssh.get_prompt() or ''
            except Exception: pass

            is_zte     = 'zte' in tipe or 'zxan' in prompt.lower() or 'c300' in tipe or 'c600' in tipe
            is_huawei  = 'huawei' in tipe or 'ma5' in tipe
            is_vsol    = 'vsol' in tipe or 'v-sol' in tipe or 'v1600' in tipe
            is_hsgq    = 'hsgq' in tipe or 'epon' in tipe

            if is_zte:
                # ── ZTE GPON: gunakan show gpon onu uncfg per port ──
                # Matikan paginasi dulu
                try: ssh.send_command('terminal length 0', timeout_ops=10)
                except Exception: pass

                # Masuk privileged mode
                try:
                    from olt_sync import _enter_privileged_zte
                    _enter_privileged_zte(ssh, dict(olt))
                except Exception: pass

                # Coba show gpon onu uncfg (lebih cepat dari running-config)
                try:
                    out = ssh.send_command('show gpon onu uncfg', timeout_ops=45).result
                    # Format: gpon-onu_X/Y/Z:N SN:XXXXXX Type:XXXX
                    for m in _re.finditer(r'gpon-onu_(\d+/\d+/\d+):(\d+)\s+SN:([\w]+)', out, _re.IGNORECASE):
                        sn = m.group(3)
                        slot_port = m.group(1) + ':' + m.group(2)
                        if sn not in registered_map:
                            unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'gpon-uncfg'})
                        else:
                            registered_found.append({'sn': sn, 'slot_port': slot_port, 'username': registered_map[sn]})
                except Exception:
                    pass

                # Fallback: show onu unreg all (beberapa versi firmware)
                try:
                    out2 = ssh.send_command('show onu unreg all', timeout_ops=45).result
                    for m in _re.finditer(r'([\d]+/[\d]+/[\d]+)\s+([\d]+)\s+([\w]{4,})', out2):
                        sn = m.group(3)
                        slot_port = m.group(1) + ':' + m.group(2)
                        if len(sn) >= 8 and not any(u.get('sn') == sn for u in unregistered):
                            if sn not in registered_map:
                                unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'gpon-unreg'})
                except Exception:
                    pass

            elif is_huawei:
                try: ssh.send_command('enable', timeout_ops=10)
                except Exception: pass
                try: ssh.send_command('config', timeout_ops=10)
                except Exception: pass
                out = ssh.send_command('display ont autofind all', timeout_ops=60).result
                # Format: SN : HWTC12345678  F/S/P : 0/1/0  Ont-index: 1
                for m in _re.finditer(r'SN\s*:\s*([\w]+).*?F/S/P\s*:\s*([\d/]+)', out, _re.DOTALL):
                    sn, slot_port = m.group(1), m.group(2)
                    if sn not in registered_map:
                        unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'gpon-autofind'})
                    else:
                        registered_found.append({'sn': sn, 'slot_port': slot_port, 'username': registered_map[sn]})

            elif is_vsol:
                try: ssh.send_command('enable', timeout_ops=10)
                except Exception: pass
                try:
                    out = ssh.send_command('show onu auto-find', timeout_ops=45).result
                    for m in _re.finditer(r'([\w]{8,})\s+([\d]+/[\d]+/[\d]+)', out):
                        sn, slot_port = m.group(1), m.group(2)
                        if sn not in registered_map:
                            unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'gpon-autofind'})
                except Exception:
                    pass

            elif is_hsgq:
                # HSGQ EPON — belum ada perintah standar yang universal
                # Coba beberapa kemungkinan
                cmds = ['show onu unauthorized all', 'show onu unregistered all', 'show onu unreg all']
                for cmd in cmds:
                    try:
                        out = ssh.send_command(cmd, timeout_ops=30).result
                        for m in _re.finditer(r'((?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|[\w]{8,})\s+([\d]+/[\d]+)', out):
                            sn, slot_port = m.group(1), m.group(2)
                            if sn not in registered_map:
                                unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'epon-unreg'})
                        if unregistered:
                            break
                    except Exception:
                        continue

    except Exception as e:
        return jsonify({'error': 'Gagal konek ke OLT: {}'.format(str(e))}), 502

    return jsonify({
        'status': 'success',
        'unregistered': unregistered,
        'registered': registered_found,
        'total_unregistered': len(unregistered),
        'olt_id': olt_id,
        'olt_name': olt['name'],
    }), 200
