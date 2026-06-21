"""
olt.py — TechnoFix-Bill · Blueprint OLT
====================================
CRUD endpoint untuk perangkat OLT (Optical Line Terminal).

Menggunakan utils.py untuk helper terpusat:
  - get_db(), olt_to_dict(), try_connect_olt()
"""

import logging
import re
import time
from flask import Blueprint, request, jsonify, g

# ── Shared helpers ─────────────────────────────────────────────
from utils import get_db, olt_to_dict, try_connect_olt, get_olt_uplinks

# ── Blueprint ──────────────────────────────────────────────────
olt_bp = Blueprint('olt', __name__)


# ── Guard multi-tenant: login + cek lock langganan ─────────────
@olt_bp.before_request
def _olt_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    # sync, sync-onu, scan-sn boleh teknisi (perm 'perangkat')
    # tambah/edit/hapus OLT hanya perangkat_manage (owner saja)
    if request.method in ('PUT', 'DELETE'):
        perm = 'perangkat_manage'
    elif request.method == 'POST' and not any(
        request.path.endswith(s) for s in ('/sync', '/sync-onu', '/scan-sn')
    ):
        perm = 'perangkat_manage'
    else:
        perm = 'perangkat'
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
    result = []
    for r in rows:
        d = olt_to_dict(r)
        d['uplinks'] = get_olt_uplinks(conn, r['id'])
        result.append(d)
    conn.close()
    return jsonify(result), 200


# ── Helper: validasi keyword tipe ONU di perintah registrasi CLI ──
# Selain "ALL"/"ALL-ONT" bawaan, terima keyword custom (mis. firmware lain
# yang pakai 'ONT', 'GPON-ONU', dll) — asal alfanumerik + dash/underscore,
# supaya tidak bisa menyuntik karakter aneh ke dalam perintah CLI yang dikirim.
_ONU_TYPE_RE = re.compile(r'^[A-Z0-9_-]{1,32}$')


def _sanitize_onu_type_keyword(raw) -> str:
    val = (raw or '').strip().upper()
    if val and _ONU_TYPE_RE.match(val):
        return val
    return 'ALL'


# ── Helper: parse & simpan daftar uplink (router_id, interface, port) ──
def _parse_uplinks(data: dict) -> list:
    """
    Body bisa kirim 'uplinks': [{router_id, router_interface, uplink_port, keterangan}, ...]
    (form baru — multi uplink), atau field tunggal 'router_id'/'router_interface'/
    'olt_uplink_port' (form lama — kompatibilitas selama transisi).
    """
    raw = data.get('uplinks')
    if isinstance(raw, list):
        out = []
        for u in raw:
            if not isinstance(u, dict):
                continue
            rid = u.get('router_id') or None
            if not rid:
                continue
            out.append({
                'router_id':        rid,
                'router_interface': (u.get('router_interface') or '').strip(),
                'uplink_port':      (u.get('uplink_port') or '').strip(),
                'keterangan':       (u.get('keterangan') or '').strip(),
            })
        return out

    rid = data.get('router_id') or None
    if not rid:
        return []
    return [{
        'router_id':        rid,
        'router_interface': (data.get('router_interface') or '').strip(),
        'uplink_port':      (data.get('olt_uplink_port') or '').strip(),
        'keterangan':       '',
    }]


def _save_uplinks(conn, olt_id: int, uplinks: list) -> None:
    """Ganti seluruh daftar uplink milik 1 OLT (hapus lalu tulis ulang)."""
    conn.execute('DELETE FROM olt_uplink WHERE olt_id = ?', (olt_id,))
    for u in uplinks:
        conn.execute(
            'INSERT INTO olt_uplink (olt_id, router_id, router_interface, uplink_port, keterangan) '
            'VALUES (?, ?, ?, ?, ?)',
            (olt_id, u['router_id'], u['router_interface'], u['uplink_port'], u['keterangan'])
        )


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
    try:
        epon_ports = int(data.get('epon_ports') or 4)
    except (TypeError, ValueError):
        epon_ports = 4
    # Kata kunci tipe ONU di perintah registrasi CLI ZTE — beda firmware/model
    # pakai "ALL-ONT", "ALL", atau keyword custom lain. Salah pilih → OLT
    # menolak perintah registrasi (lihat _kirim_olt_cli di api.py).
    onu_type_keyword = _sanitize_onu_type_keyword(data.get('onu_type_keyword'))
    uplinks          = _parse_uplinks(data)
    # Kolom legacy di 'olt' diisi dari uplink pertama — dipakai maps.py &
    # monitoring bandwidth selama belum dipindah sepenuhnya ke tabel olt_uplink.
    primary          = uplinks[0] if uplinks else {}
    router_id        = primary.get('router_id')
    router_interface = primary.get('router_interface', '')
    olt_uplink_port  = primary.get('uplink_port', '')

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
            router_id, router_interface, olt_uplink_port, epon_ports, onu_type_keyword)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
        (name, tipe, ip, port, username, password, snmp, lokasi, koordinat, keterangan, status,
         router_id, router_interface, olt_uplink_port, epon_ports, onu_type_keyword)
    )
    new_id = cursor.lastrowid
    _save_uplinks(conn, new_id, uplinks)
    conn.commit()

    row = conn.execute('SELECT * FROM olt WHERE id = ?', (new_id,)).fetchone()
    device = olt_to_dict(row)
    device['uplinks'] = get_olt_uplinks(conn, new_id)
    conn.close()

    return jsonify({
        'status':  'success' if ok else 'warning',
        'message': msg,
        'device':  device
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
    try:
        epon_ports = int(data.get('epon_ports') or 4)
    except (TypeError, ValueError):
        epon_ports = 4
    onu_type_keyword = _sanitize_onu_type_keyword(data.get('onu_type_keyword'))
    uplinks          = _parse_uplinks(data)
    primary          = uplinks[0] if uplinks else {}
    router_id        = primary.get('router_id')
    router_interface = primary.get('router_interface', '')
    olt_uplink_port  = primary.get('uplink_port', '')

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
               router_id=?, router_interface=?, olt_uplink_port=?, epon_ports=?,
               onu_type_keyword=?
           WHERE id=?''',
        (name, tipe, ip, port, username, final_password,
         snmp, lokasi, koordinat, keterangan, 'pending',
         router_id, router_interface, olt_uplink_port, epon_ports, onu_type_keyword, olt_id)
    )
    _save_uplinks(conn, olt_id, uplinks)
    conn.commit()

    row = conn.execute('SELECT * FROM olt WHERE id = ?', (olt_id,)).fetchone()
    device = olt_to_dict(row)
    device['uplinks'] = get_olt_uplinks(conn, olt_id)
    conn.close()

    return jsonify({
        'status':  'success',
        'message': f'{name} berhasil diperbarui. Lakukan sinkronisasi untuk cek koneksi.',
        'device':  device
    }), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT 4 — DELETE /olt/<id>
# ══════════════════════════════════════════════════════════════
@olt_bp.route('/<int:olt_id>', methods=['DELETE'])
def delete_olt(olt_id):
    """Hapus perangkat OLT dari database."""
    conn     = get_db()
    affected = conn.execute('DELETE FROM olt WHERE id = ?', (olt_id,)).rowcount
    conn.execute('DELETE FROM olt_uplink WHERE olt_id = ?', (olt_id,))
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
    def _run(nid, oid):
        try:
            from olt_sync import sync_single_olt
            sync_single_olt(network_id=nid, olt_id=oid)
        except Exception as e:
            logging.warning('[OLT sync-onu] error: %s', e)

    threading.Thread(target=_run, args=(network_id, olt_id), daemon=True).start()

    return jsonify({
        'status':  'success',
        'message': 'Sinkronisasi ONU dimulai di background. Tunggu ~30 detik lalu refresh halaman Pelanggan.',
    }), 202


# ── GET /olt/<id>/unauthorized ────────────────────────────
@olt_bp.route('/<int:olt_id>/unauthorized', methods=['GET'])
def get_unauthorized_onus(olt_id):
    """
    Ambil daftar ONU yang konek ke OLT tapi belum diprovisi (dari tabel onu_liar).
    Data diisi saat background sync ZTE GPON berjalan.
    Response: [ { sn, port, detected_at }, ... ]
    """
    conn = get_db()
    rows = conn.execute(
        'SELECT sn, port, detected_at FROM onu_liar WHERE olt_id=? ORDER BY detected_at DESC',
        (olt_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows]), 200


def _zte_busy_onu_ids(ssh, port: str) -> set:
    """
    Ambil set onu-id yang phase state-nya 'working' (sudah aktif terpakai)
    di 1 PON port ZTE, via 'sh gpon onu state gpon-olt_<port>'.

    PENTING: di firmware ZXAN/C300 tertentu, command ini TIDAK terpengaruh
    'terminal length 0' kalau ONU di port itu banyak (>20-an) — tetap
    memicu pagination '--More--' yang membuat send_command() biasa MACET
    selamanya (comms_prompt_pattern tidak pernah match '--More--', jadi
    nunggu sampai timeout tanpa hasil). Solusinya: tulis command & baca
    langsung dari transport, kirim spasi tiap kali '--More--' terdeteksi
    utk lanjut ke halaman berikutnya — gaya pager Cisco/ZTE klasik.

    Parsing baris dibuat agnostik jumlah kolom (beberapa firmware ZTE
    tidak punya kolom 'O7 State') — cukup cek token 'working' di baris
    yang sama dengan OnuIndex, bukan posisi kolom tetap.
    """
    busy = set()
    try:
        ssh.channel.write(channel_input=f'sh gpon onu state gpon-olt_{port}')
        ssh.channel.send_return()

        buf = b''
        deadline   = time.time() + 25
        idle_since = time.time()
        while time.time() < deadline:
            try:
                chunk = ssh.transport.read()
            except Exception:
                # Socket recv timeout (tidak ada data SAAT INI) — bukan
                # tanda command selesai, tetap lanjut polling sampai
                # deadline atau prompt akhir terdeteksi.
                chunk = None
            if chunk:
                buf += chunk
                idle_since = time.time()
                if b'--More--' in buf[-80:]:
                    ssh.channel.write(channel_input=' ')
            else:
                idle = time.time() - idle_since
                tail = buf.decode(errors='ignore').strip()
                if idle > 1.0 and re.search(r'[>#]\s*$', tail):
                    break
                time.sleep(0.15)

        out = re.sub(r'\s*--More--\s*', '\n', buf.decode(errors='ignore'))
        for line in out.splitlines():
            m = re.match(r'\s*(?:gpon-onu_)?\d+/\d+/\d+:(\d+)\s+(.*)', line)
            if m and 'working' in m.group(2).lower():
                busy.add(int(m.group(1)))
    except Exception:
        pass
    return busy


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
    conn = get_db()
    olt = conn.execute('SELECT * FROM olt WHERE id=?', (olt_id,)).fetchone()
    if not olt:
        conn.close()
        return jsonify({'error': 'OLT tidak ditemukan'}), 404
    if olt['status'] != 'connected':
        conn.close()
        return jsonify({'error': 'OLT belum terhubung. Lakukan sync koneksi dulu.'}), 400

    # Ambil SN yang sudah terdaftar di onu_mapping
    registered_map = {r['sn']: r['username'] for r in
                      conn.execute('SELECT sn, username FROM onu_mapping WHERE sn != ""').fetchall()
                      if r['sn']}
    conn.close()

    tipe = (olt['tipe'] or '').lower()
    is_hsgq = 'hsgq' in tipe or 'epon' in tipe

    # ── HSGQ EPON: jalur telnet terpisah (sama seperti sync background) ──
    # Scrapli/GenericDriver kurang cocok untuk negosiasi telnet (IAC) HSGQ —
    # alasan yang sama kenapa sync_hsgq_epon_telnet() di olt_sync.py memakai
    # SimpleTelnet (telnetlib). Pakai ulang alur & helper yang sudah terbukti.
    if is_hsgq:
        return _scan_hsgq_epon(olt, olt_id, registered_map)

    try:
        from scrapli.driver.generic import GenericDriver
        SCRAPLI_OK = True
    except ImportError:
        SCRAPLI_OK = False

    if not SCRAPLI_OK:
        return jsonify({'error': 'scrapli tidak terpasang (pip install scrapli)'}), 500

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
                    # Format C300 (terverifikasi): "gpon-onu_1/3/7:1   ZICGCCF20855   unknown"
                    # — kolom Sn TANPA label "SN:". Beberapa firmware lain memakai
                    # label "SN:XXXX Type:XXXX" — keduanya ditangkap regex ini.
                    for m in _re.finditer(r'gpon-onu_(\d+/\d+/\d+):(\d+)\s+(?:SN:)?([A-Z0-9]{8,})', out, _re.IGNORECASE):
                        sn = m.group(3).upper()
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

                # ── Cross-check vs 'sh gpon onu state' ──
                # Kuirk firmware ZTE tertentu: 'show gpon onu uncfg' kadang
                # menyarankan onu-id yang TERNYATA sudah 'working' (dipakai
                # pelanggan aktif) — onu-id di kolom OnuIndex uncfg cuma
                # saran OLT, bukan kepastian slot kosong. Kalau dibiarkan,
                # admin bisa salah pakai slot itu utk registrasi baru dan
                # menabrak pelanggan yang sedang aktif. Verifikasi tiap
                # port yang muncul di hasil unregistered, cari onu-id
                # kosong terdekat kalau yang disarankan ternyata bentrok.
                ports_to_check = {u['slot_port'].split(':')[0] for u in unregistered if ':' in u['slot_port']}
                for port in ports_to_check:
                    busy = _zte_busy_onu_ids(ssh, port)
                    if not busy:
                        continue
                    for u in unregistered:
                        if not u['slot_port'].startswith(port + ':'):
                            continue
                        onu_id = int(u['slot_port'].split(':')[1])
                        if onu_id in busy:
                            free_id = 1
                            while free_id in busy:
                                free_id += 1
                            u['slot_port_disarankan_olt'] = u['slot_port']
                            u['slot_port'] = f'{port}:{free_id}'
                            u['catatan'] = f"Slot {port}:{onu_id} sudah dipakai — dialihkan ke {port}:{free_id}."

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


# ── Helper: scan ONU EPON belum terotorisasi via telnet (HSGQ) ────
def _scan_hsgq_epon(olt, olt_id, registered_map):
    """
    Scan ONU EPON yang belum diotorisasi pada OLT HSGQ, memakai alur yang
    sama persis dengan sync_hsgq_epon_telnet() di olt_sync.py (terbukti jalan):
      login → enable (OLT#) → configure ((config)#)
      → per port: interface epon <N> → show onu-info all
    Kolom 'Auth' (TRUE/FALSE) pada output menentukan status registrasi ONU —
    analog dengan 'show gpon onu uncfg' di ZTE. Auth: FALSE → belum terdaftar.
    """
    import re as _re
    try:
        from olt_sync import SimpleTelnet, _hsgq_read
    except ImportError:
        return jsonify({'error': 'Modul olt_sync tidak tersedia untuk scan EPON'}), 500

    epon_ports = int(olt['epon_ports'] or 8)
    unregistered = []
    registered_found = []
    tn = None
    try:
        tn = SimpleTelnet(olt['ip'], int(olt['port']), timeout=20)
        tn.read_until(b'username:', timeout=30)
        tn.write(olt['username'].encode('ascii') + b'\r\n')
        tn.read_until(b'password:', timeout=10)
        tn.write(olt['password'].encode('ascii') + b'\r\n')
        tn.read_until(b'OLT>', timeout=15)

        tn.write(b'enable\r\n')
        _hsgq_read(tn, b'OLT#', timeout=15)

        tn.write(b'configure\r\n')
        cfg_resp = _hsgq_read(tn, b'(config)#', timeout=20)
        if '(config)#' not in cfg_resp:
            return jsonify({'error': 'Gagal masuk mode config pada OLT EPON'}), 502

        for port_num in range(1, epon_ports + 1):
            port_prompt = f'epon-{port_num})#'.encode()
            cfg_prompt  = b'(config)#'
            try:
                tn.write(f'interface epon {port_num}\r\n'.encode('ascii'))
                iface_resp = _hsgq_read(tn, port_prompt, timeout=10)
                if port_prompt.decode() not in iface_resp:
                    continue

                tn.write(b'show onu-info all\r\n')
                port_info = _hsgq_read(tn, port_prompt, timeout=30)

                # Format: PON/ONU  Mac-Address  Status  Auth  Cfg  Reg-time  ONU-Name
                # Contoh: 1/1  0c:37:47:77:a4:10  Online  TRUE  TRUE  2026/05/24 11:41:54  wiwik_tegaly
                for m in _re.finditer(
                    r'(\d+/\d+)\s+'
                    r'((?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2})\s+'
                    r'(?:Online|Offline)\s+'
                    r'(TRUE|FALSE)\s+\w+\s+'   # Auth (ditangkap) + Cfg (diabaikan)
                    r'[\d/\s:]+\s+'            # Reg-time
                    r'(\S+)',                  # ONU-Name
                    port_info, _re.IGNORECASE
                ):
                    pon_onu = m.group(1).strip()
                    mac     = m.group(2).strip().lower()
                    auth    = m.group(3).strip().upper()
                    parts   = pon_onu.split('/')
                    onu_id  = parts[1] if len(parts) > 1 else parts[0]
                    slot_port = f'{port_num}/{onu_id}'
                    sn = mac  # EPON: SN = MAC address (sama seperti sync)

                    if auth == 'FALSE':
                        if sn not in registered_map:
                            unregistered.append({'sn': sn, 'slot_port': slot_port, 'tipe': 'epon-unauth'})
                    elif sn in registered_map:
                        registered_found.append({'sn': sn, 'slot_port': slot_port, 'username': registered_map[sn]})

                tn.write(b'exit\r\n')
                _hsgq_read(tn, cfg_prompt, timeout=8)
            except Exception:
                try:
                    tn.write(b'exit\r\n')
                    _hsgq_read(tn, cfg_prompt, timeout=5)
                except Exception:
                    pass

    except Exception as e:
        return jsonify({'error': 'Gagal konek ke OLT: {}'.format(str(e))}), 502
    finally:
        if tn is not None:
            tn.close()

    return jsonify({
        'status': 'success',
        'unregistered': unregistered,
        'registered': registered_found,
        'total_unregistered': len(unregistered),
        'olt_id': olt_id,
        'olt_name': olt['name'],
    }), 200
