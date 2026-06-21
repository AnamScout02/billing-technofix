"""
input.py — TechnoFix-Bill · Entry Point Flask
=========================================
Server utama. Register semua Blueprint, inisialisasi DB,
dan sediakan endpoint CRUD untuk perangkat MikroTik.

Menggunakan utils.py untuk fungsi helper terpusat:
  - get_db(), device_to_dict(), try_connect_mikrotik()

✅ FASE 1 — CLEANUP:
   - Hapus seluruh duplikat entry point (baris ~259–526 asli).
   - Tambahkan tabel profil_harga ke init_db() — sebelumnya hanya
     ada di duplikat kedua yang harus dihapus.
   - Tambahkan registrasi auth_bp — sebelumnya hilang sama sekali.
   - Tambahkan migrasi kolom 'service' di tabel pelanggan.
"""

from flask import Flask, request, jsonify, g
from flask_cors import CORS
import logging
import os
import sqlite3

# ── Shared helpers ─────────────────────────────────────────────
from utils import get_db, device_to_dict, try_connect_mikrotik, catat_aktivitas

# ── Blueprints ─────────────────────────────────────────────────
from api    import api_bp
from olt    import olt_bp
from auth   import auth_bp
from odc    import odc_bp
from odp    import odp_bp
from portal import portal_bp
from maps   import maps_bp
from tagihan import tagihan_bp
from loket import loket_bp
from wa import wa_bp
from payment import payment_bp
from setting import setting_bp
from diagnostik import diagnostik_bp

# ── Setup ──────────────────────────────────────────────────────
app = Flask(__name__)

# CORS — wajib supports_credentials=True agar session cookie terkirim
# dari frontend di domain berbeda.
# Origins "*" tidak boleh dipakai bersamaan dengan credentials=True
# (browser akan tolak), jadi kita pakai list eksplisit.
ALLOWED_ORIGINS = [
    'http://localhost',
    'http://localhost:5000',
    'http://127.0.0.1',
    'http://127.0.0.1:5000',
    'http://192.168.70.7',
    'http://192.168.70.7:5000',
    # ── Akses dari IP publik ──
    'http://103.194.175.54',
    'http://103.194.175.54:5000',
    'https://103.194.175.54',
    # ── Server Proxmox (LAN lokal) ──
    'http://172.15.0.11',
    'http://172.15.0.11:5000',
    # ── Domain produksi (technofix-bill.com) ──
    'http://technofix-bill.com',
    'https://technofix-bill.com',
    'https://www.technofix-bill.com',
]
CORS(
    app,
    supports_credentials=True,
    origins=ALLOWED_ORIGINS,
    allow_headers=['Content-Type', 'Authorization', 'X-Network-Id'],
    expose_headers=['Content-Type', 'Authorization', 'X-Mikrotik-Connected', 'X-Fallback-Reason'],
)
# [DITAMBAHKAN] Secret key wajib ada agar Flask session berfungsi
# Gunakan environment variable di produksi; fallback ke nilai statis
# untuk development agar session tidak reset tiap restart.
app.secret_key = os.environ.get('SECRET_KEY', 'technofix-dev-secret-ganti-di-produksi')

# [DITAMBAHKAN] Durasi session 7 hari
from datetime import timedelta
app.permanent_session_lifetime = timedelta(days=7)

# ── Register Blueprints ────────────────────────────────────────
app.register_blueprint(api_bp,    url_prefix='/api')
app.register_blueprint(olt_bp,    url_prefix='/olt')
app.register_blueprint(auth_bp,   url_prefix='/api/auth')
app.register_blueprint(odc_bp,    url_prefix='/api/odc')
app.register_blueprint(odp_bp,    url_prefix='/api/odp')
app.register_blueprint(portal_bp, url_prefix='/api/portal')
app.register_blueprint(maps_bp,   url_prefix='/api/maps')
app.register_blueprint(tagihan_bp, url_prefix='/api/tagihan')
app.register_blueprint(loket_bp, url_prefix='/api/loket')
app.register_blueprint(wa_bp, url_prefix='/api/wa')
app.register_blueprint(payment_bp, url_prefix='/api/payment')
app.register_blueprint(setting_bp, url_prefix='/api/setting')
app.register_blueprint(diagnostik_bp, url_prefix='/api/diagnostik')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')


# ── Guard multi-tenant untuk endpoint /devices (level app) ─────
# Endpoint /devices* memakai get_db() owner-aware, jadi wajib login
# agar g.network_id ter-set → mengarah ke file DB owner yang benar.
@app.before_request
def _devices_guard():
    if request.method == 'OPTIONS':
        return
    if request.path.startswith('/devices'):
        from auth import guard_request
        # GET /devices (list) + GET /devices/<id>/profile-count → kolektor boleh
        # PUT/POST/DELETE + sync → butuh perm 'perangkat'
        if request.method == 'GET':
            if 'profile-count' in request.path or '/sync' in request.path:
                return guard_request(perm='perangkat')
            return guard_request(perm='pelanggan')
        # Sync koneksi boleh teknisi (POST /devices/<id>/sync)
        if '/sync' in request.path and request.method == 'POST':
            return guard_request(perm='perangkat')
        # Mutasi perangkat (tambah/edit/hapus): butuh perangkat_manage (owner saja)
        return guard_request(perm='perangkat_manage')


# ══════════════════════════════════════════════════════════════
# INISIALISASI DATABASE
# ══════════════════════════════════════════════════════════════

def init_db():
    """
    Buat semua tabel yang diperlukan jika belum ada.
    Dipanggil sekali saat server pertama kali dijalankan.
    """
    conn = get_db()

    # ── Tabel perangkat MikroTik ──────────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS devices (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            ip         TEXT    NOT NULL,
            port       INTEGER NOT NULL DEFAULT 8728,
            username   TEXT    NOT NULL,
            password   TEXT    NOT NULL,
            status     TEXT    NOT NULL DEFAULT 'pending',
            koordinat  TEXT    DEFAULT ''
        )
    ''')

    # ── Tabel pelanggan lokal (mirror dari MikroTik PPP Secret) ──
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pelanggan (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id       INTEGER,
            username        TEXT,
            password        TEXT,
            sn              TEXT    DEFAULT '',
            hp              TEXT    DEFAULT '',
            profil          TEXT    DEFAULT '',
            service         TEXT    DEFAULT 'pppoe',
            slot_port_onu   TEXT    DEFAULT '',
            vlan            TEXT    DEFAULT '',
            titik_koordinat TEXT    DEFAULT '',
            tgl_pasang      TEXT    DEFAULT '',
            tgl_jatuh       TEXT    DEFAULT '',
            FOREIGN KEY (device_id) REFERENCES devices(id)
        )
    ''')

    # ── Tabel pemetaan ONU — cache data OLT side per pelanggan ──
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

    # ── Tabel harga PPPoE Profile ─────────────────────────────
    # [DIPINDAHKAN DARI DUPLIKAT KEDUA — sebelumnya tidak ada di sini]
    # MikroTik tidak punya kolom harga; disimpan di DB lokal.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS profil_harga (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id     INTEGER NOT NULL,
            nama_profile  TEXT    NOT NULL,
            harga         INTEGER NOT NULL DEFAULT 0,
            deskripsi     TEXT    DEFAULT '',
            UNIQUE(device_id, nama_profile),
            FOREIGN KEY (device_id) REFERENCES devices(id)
        )
    ''')

    # ── Migrasi: tambah kolom baru ke tabel yang sudah ada ───
    # (aman dijalankan berulang — ALTER TABLE gagal diam-diam jika kolom sudah ada)

    migrasi = [
        # onu_mapping
        'ALTER TABLE onu_mapping ADD COLUMN rx_power  REAL',
        'ALTER TABLE onu_mapping ADD COLUMN tx_power  REAL',
        'ALTER TABLE onu_mapping ADD COLUMN synced_at TEXT DEFAULT ""',
        # ✅ v2.5: TCONT/bandwidth profile di OLT (beda dengan profil PPPoE MikroTik)
        "ALTER TABLE onu_mapping ADD COLUMN tcont_profile TEXT DEFAULT ''",
        # olt
        'ALTER TABLE olt ADD COLUMN epon_ports INTEGER DEFAULT 4',
        # ✅ kata kunci tipe ONU di perintah registrasi CLI ZTE — sebagian
        # firmware/model pakai "ALL-ONT", sebagian lain "ALL". Kalau salah,
        # OLT menolak perintah registrasi (ONU tidak nambah meski "sukses").
        "ALTER TABLE olt ADD COLUMN onu_type_keyword TEXT DEFAULT 'ALL'",
        # kolom service di pelanggan
        "ALTER TABLE pelanggan ADD COLUMN service TEXT DEFAULT 'pppoe'",
        # ✅ v2.0: kolom bandwidth_note di profil_harga (untuk catatan kustom lokal)
        "ALTER TABLE profil_harga ADD COLUMN bandwidth_note TEXT DEFAULT ''",
        # ✅ v2.1: kolom koordinat di devices (untuk halaman Maps)
        "ALTER TABLE devices ADD COLUMN koordinat TEXT DEFAULT ''",
        # ✅ v2.4: IP Publik MikroTik — dipakai fitur Remote Modem (NAT forwarding)
        # Diisi di halaman input mikrotik, dipakai detail_pelanggan saat Remote Modem
        "ALTER TABLE devices ADD COLUMN public_ip TEXT DEFAULT ''",
        # ✅ v2.4: WAN interface — agar NAT rule remote hanya nangkap trafik dari internet
        "ALTER TABLE devices ADD COLUMN wan_interface TEXT DEFAULT ''",

        # ✅ v2.2: kolom koordinat di OLT, ODC, ODP (untuk halaman Maps)
        # Tabel OLT sudah ada sejak awal — tinggal tambah kolom koordinat
        "ALTER TABLE olt ADD COLUMN koordinat TEXT DEFAULT ''",
        # ODC & ODP — graceful: jika tabel belum ada, ALTER TABLE gagal diam-diam
        "ALTER TABLE odc ADD COLUMN koordinat TEXT DEFAULT ''",
        "ALTER TABLE odp ADD COLUMN koordinat TEXT DEFAULT ''",
        # ✅ v2.3: kolom profil_sebelum — simpan profil sebelum isolir agar bisa dikembalikan
        "ALTER TABLE pelanggan ADD COLUMN profil_sebelum TEXT DEFAULT ''",
        # ✅ v2.3: kolom nama di pelanggan
        "ALTER TABLE pelanggan ADD COLUMN nama TEXT DEFAULT ''",
        # ✅ v2.3: kolom aktif di pelanggan
        "ALTER TABLE pelanggan ADD COLUMN aktif INTEGER DEFAULT 1",

        # ✅ v3.0: TOPOLOGI JARINGAN — relasi antar perangkat untuk garis di Maps
        # OLT → Router: OLT mana terhubung ke router mana, via interface apa
        "ALTER TABLE olt ADD COLUMN router_id INTEGER DEFAULT NULL",
        "ALTER TABLE olt ADD COLUMN router_interface TEXT DEFAULT ''",  # misal: ether1, sfp1
        "ALTER TABLE olt ADD COLUMN olt_uplink_port TEXT DEFAULT ''",   # misal: ge-0/0/1

        # Pelanggan/ONU → ODP: ONU ini terhubung ke ODP mana
        "ALTER TABLE pelanggan ADD COLUMN odp_id INTEGER DEFAULT NULL",
    ]

    for sql in migrasi:
        try:
            conn.execute(sql)
        except Exception:
            pass  # Kolom sudah ada — abaikan

    conn.commit()
    conn.close()
    logging.info('[DB] Semua tabel siap.')


# ══════════════════════════════════════════════════════════════
# ENDPOINTS — MikroTik Devices CRUD
# ══════════════════════════════════════════════════════════════

@app.route('/devices', methods=['GET'])
def get_devices():
    """Mengembalikan daftar semua perangkat dari database."""
    conn = get_db()
    rows = conn.execute('SELECT * FROM devices ORDER BY id').fetchall()
    conn.close()
    return jsonify([device_to_dict(r) for r in rows]), 200


@app.route('/devices', methods=['POST'])
def add_device():
    """
    Terima data perangkat baru, tes koneksi ke MikroTik,
    lalu simpan ke database.
    """
    data     = request.json or {}
    name      = data.get('name', '').strip()
    ip        = data.get('ip', '').strip()
    port      = data.get('port', '8728')
    username  = data.get('username', '').strip()
    password  = data.get('password', '').strip()
    koordinat = data.get('koordinat', '').strip()
    public_ip = data.get('public_ip', '').strip()
    wan_interface = data.get('wan_interface', '').strip()

    if not all([name, ip, username, password]):
        return jsonify({'status': 'error', 'message': 'Semua field wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    ok, msg = try_connect_mikrotik(ip, port, username, password)
    status  = 'connected' if ok else 'failed'

    conn = get_db()

    # Cek apakah ip+port sudah ada (hindari duplikat)
    existing = conn.execute('SELECT id FROM devices WHERE ip=? AND port=?', (ip, port)).fetchone()
    if existing:
        row = conn.execute('SELECT * FROM devices WHERE id=?', (existing['id'],)).fetchone()
        # Update data yang mungkin berubah (nama, kredensial, status)
        conn.execute(
            'UPDATE devices SET name=?, username=?, password=?, status=?, koordinat=?, public_ip=?, wan_interface=? WHERE id=?',
            (name, username, password, status, koordinat, public_ip, wan_interface, existing['id'])
        )
        conn.commit()
        row = conn.execute('SELECT * FROM devices WHERE id=?', (existing['id'],)).fetchone()
        conn.close()

        catat_aktivitas('perangkat', 'edit', target=name,
                        pesan=f'Edit perangkat: {name} ({ip}:{port})')

        return jsonify({
            'status':  'success' if ok else 'warning',
            'message': msg + ' (perangkat sudah ada, data diperbarui)',
            'device':  device_to_dict(row)
        }), 200

    cursor = conn.execute(
        'INSERT INTO devices (name, ip, port, username, password, status, koordinat, public_ip, wan_interface) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (name, ip, port, username, password, status, koordinat, public_ip, wan_interface)
    )
    new_id = cursor.lastrowid
    conn.commit()

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    catat_aktivitas('perangkat', 'tambah', target=name,
                    pesan=f'Perangkat baru: {name} ({ip}:{port})')

    return jsonify({
        'status':  'success' if ok else 'warning',
        'message': msg,
        'device':  device_to_dict(row)
    }), 201


@app.route('/devices/<int:device_id>', methods=['PUT'])
def update_device(device_id):
    """
    Update data perangkat berdasarkan ID.
    Password boleh kosong (tidak berubah).
    """
    data     = request.json or {}
    name      = data.get('name', '').strip()
    ip        = data.get('ip', '').strip()
    port      = data.get('port', '8728')
    username  = data.get('username', '').strip()
    password  = data.get('password', '').strip()
    koordinat = data.get('koordinat', '').strip()
    public_ip = data.get('public_ip', '').strip()
    wan_interface = data.get('wan_interface', '').strip()

    if not all([name, ip, username]):
        return jsonify({'status': 'error', 'message': 'Name, IP, dan username wajib diisi.'}), 400

    port = int(port) if str(port).strip().isdigit() else 8728

    conn    = get_db()
    current = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not current:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    final_password = password if password else current['password']

    try:
        conn.execute(
            'UPDATE devices SET name=?, ip=?, port=?, username=?, password=?, status=?, koordinat=?, public_ip=?, wan_interface=? WHERE id=?',
            (name, ip, port, username, final_password, 'pending', koordinat, public_ip, wan_interface, device_id)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({
            'status': 'error',
            'message': f'IP {ip} dengan port {port} sudah dipakai perangkat lain.'
        }), 400

    row = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
    conn.close()

    catat_aktivitas('perangkat', 'edit', target=name,
                    pesan=f'Edit perangkat: {name} ({ip}:{port})')

    return jsonify({'status': 'success', 'device': device_to_dict(row)}), 200


@app.route('/devices/<int:device_id>', methods=['DELETE'])
def delete_device(device_id):
    """Hapus perangkat dari database berdasarkan ID."""
    conn   = get_db()
    device = conn.execute('SELECT name FROM devices WHERE id = ?', (device_id,)).fetchone()
    affected = conn.execute('DELETE FROM devices WHERE id = ?', (device_id,)).rowcount
    conn.commit()
    conn.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    catat_aktivitas('perangkat', 'hapus', target=device['name'] if device else '',
                    pesan=f"Hapus perangkat: {device['name'] if device else device_id}")

    return jsonify({'status': 'success', 'message': 'Perangkat berhasil dihapus.'}), 200


@app.route('/devices/<int:device_id>/sync', methods=['POST'])
def sync_device(device_id):
    """
    Coba koneksi ke MikroTik, update status di database, DAN sekaligus
    ambil jumlah PPP Profile dalam satu koneksi live yang sama.

    Sebelumnya halaman Perangkat memanggil endpoint ini DAN
    /profile-count secara terpisah untuk tiap perangkat saat dimuat —
    masing-masing membuka koneksi RouterOS API sendiri (2x koneksi live
    per perangkat). Digabung di sini jadi 1x koneksi agar halaman
    Perangkat tidak "muter-muter" lama saat dimuat.
    """
    conn   = get_db()
    device = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()

    if not device:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    profile_count  = None
    profile_source = None
    try:
        from mikrotik import MikroTikClient
        with MikroTikClient(dict(device)) as mt:
            profile_count = len(mt.get_ppp_profiles())
        ok, msg, profile_source = True, 'Koneksi berhasil.', 'mikrotik'
    except Exception as e:
        ok, msg = False, 'Gagal terhubung. Periksa IP, port, username, dan password.'
        logging.error(f"[MikroTik] Sync gagal ke {device['ip']}:{device['port']} — {e}")

    status     = 'connected' if ok else 'failed'
    status_lama = device['status']
    conn.execute('UPDATE devices SET status=? WHERE id=?', (status, device_id))
    conn.commit()

    if status != status_lama and status_lama in ('connected', 'failed'):
        if status == 'connected':
            catat_aktivitas('perangkat', 'connect', target=device['name'],
                            pesan=f"Perangkat {device['name']} ({device['ip']}) terhubung kembali")
        elif status == 'failed':
            catat_aktivitas('perangkat', 'disconnect', target=device['name'],
                            pesan=f"Perangkat {device['name']} ({device['ip']}) terputus")

    # Gagal konek live → fallback hitung profil dari DB lokal (sama seperti /profile-count)
    if profile_count is None:
        row = conn.execute(
            'SELECT COUNT(*) as cnt FROM profil_harga WHERE device_id = ?', (device_id,)
        ).fetchone()
        profile_count, profile_source = (row['cnt'] if row else 0), 'local'

    conn.close()

    return jsonify({
        'status':         'success' if ok else 'error',
        'message':        msg,
        'connected':      ok,
        'profile_count':  profile_count,
        'profile_source': profile_source,
    }), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT — POST /devices/<id>/remote-onu
# Atur slot NAT "Remote ONU" (port forwarding tetap) di MikroTik.
# Dipakai oleh fitur Remote Modem (lihat api.py: remote_modem_on) —
# to-addresses rule ini direpoint ke IP modem pelanggan saat dipakai.
# ══════════════════════════════════════════════════════════════

@app.route('/devices/<int:device_id>/remote-onu', methods=['POST'])
def set_remote_onu(device_id):
    """
    Body JSON: { "ip": "103.194.175.174", "port": 1234, "comment": "Remote-Onu", "local_ip": "172.100.1.2" }

    Membuat/memperbarui NAT rule dst-nat di MikroTik perangkat ini:
      chain=dstnat action=dst-nat protocol=tcp
      dst-address=<local_ip atau ip> dst-port=<port> to-addresses=0.0.0.0 to-ports=80
      comment=<comment>

    "local_ip" (opsional) dipakai untuk topologi 2 router: router ini
    ("Cantuk") adalah router DISTRIBUSI di belakang router utama/gateway
    ("Gendoh") yang punya IP publik. Gateway sudah di-set manual sekali oleh
    owner: dst-nat <ip>:<port> → <local_ip>:<port>. Rule di perangkat ini
    harus menangkap paket yang sudah di-dst-nat oleh gateway tsb, jadi
    dst-address-nya = local_ip (IP perangkat ini dari sudut pandang gateway),
    bukan IP publik.

    Jika "local_ip" dikosongkan (kasus 1 router yang juga punya IP publik
    langsung), dst-address = "ip" (IP publik) seperti semula.

    Rule lama dicari berdasarkan comment yang TERSIMPAN sebelumnya
    (remote_onu_comment) — jika ditemukan, di-update (termasuk comment
    barunya bila diganti). Jika tidak ada, dibuat rule baru.

    to-addresses akan direpoint otomatis ke IP modem pelanggan saat
    tombol "Remote Modem" ditekan di halaman detail pelanggan
    (lihat api.py: remote_modem_on, dicari berdasarkan remote_onu_comment).
    """
    import re
    from mikrotik import MikroTikClient, MikroTikError, REMOTE_ONU_COMMENT
    from utils import get_network_package
    from packages import package_has_feature

    pkg = get_network_package(g.network_id)
    if not package_has_feature(pkg, 'remote_modem'):
        return jsonify({
            'status': 'error',
            'message': 'Fitur Remote Akses Modem tidak tersedia di paket Anda. Upgrade ke paket Lanjutan atau lebih tinggi untuk mengaktifkan.',
            'code': 'feature_locked',
        }), 403

    data     = request.json or {}
    ip       = (data.get('ip') or '').strip()
    port     = data.get('port')
    comment  = (data.get('comment') or '').strip() or REMOTE_ONU_COMMENT
    local_ip = (data.get('local_ip') or '').strip()

    if not re.match(r'^(\d{1,3}\.){3}\d{1,3}$', ip):
        return jsonify({'status': 'error', 'message': 'IP publik tidak valid.'}), 400
    if local_ip and not re.match(r'^(\d{1,3}\.){3}\d{1,3}$', local_ip):
        return jsonify({'status': 'error', 'message': 'IP lokal router tidak valid.'}), 400
    try:
        port = int(port)
        if not (1 <= port <= 65535):
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'Port harus angka 1-65535.'}), 400

    conn   = get_db()
    device = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
    if not device:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Perangkat tidak ditemukan.'}), 404

    old_comment = (device['remote_onu_comment'] if 'remote_onu_comment' in device.keys() else '') or REMOTE_ONU_COMMENT
    dst_address = local_ip or ip

    try:
        with MikroTikClient(dict(device)) as mt:
            api      = mt._get_api()
            nat_path = api.path('/ip/firewall/nat')
            existing = next(
                (r for r in nat_path if (r.get('comment') or '') == old_comment),
                None
            )
            params = {
                'dst-address':  dst_address,
                'dst-port':     str(port),
                'to-addresses': '0.0.0.0',
                'to-ports':     '80',
                'comment':      comment,
            }
            if existing:
                nat_path.update(**{'.id': existing['.id'], **params})
            else:
                nat_path.add(
                    chain='dstnat', action='dst-nat', protocol='tcp', **params,
                )
    except MikroTikError as e:
        conn.close()
        return jsonify({'status': 'error', 'message': str(e)}), 502
    except Exception as e:
        conn.close()
        logging.error(f"[Remote ONU] Gagal set slot di {device['ip']}:{device['port']} — {e}")
        return jsonify({'status': 'error', 'message': f'Gagal mengatur Remote ONU: {e}'}), 500

    conn.execute('UPDATE devices SET remote_onu_ip=?, remote_onu_port=?, remote_onu_comment=?, remote_onu_local_ip=? WHERE id=?', (ip, port, comment, local_ip, device_id))
    conn.commit()
    row = conn.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
    conn.close()

    catat_aktivitas('perangkat', 'edit', target=device['name'],
                    pesan=f'Atur Remote ONU {device["name"]}: {ip}:{port} (comment={comment})')

    return jsonify({'status': 'success', 'message': 'Slot Remote ONU berhasil diatur.', 'device': device_to_dict(row)}), 200


# ══════════════════════════════════════════════════════════════
# ENDPOINT — GET /devices/<id>/profile-count
# Badge jumlah PPPoE Profile di halaman input_mikrotik.
# Ringan: hanya count, tidak fetch detail profile.
# ✅ v2.0: endpoint baru untuk integrasi dengan profile_pppoe.html
# ══════════════════════════════════════════════════════════════

@app.route('/devices/<int:device_id>/profile-count', methods=['GET'])
def profile_count(device_id):
    """
    Mengembalikan jumlah PPPoE Profile untuk badge di input_mikrotik.

    Strategi:
      - Coba ambil realtime dari MikroTik via RouterOS API.
      - Jika gagal konek → fallback ke COUNT(*) dari profil_harga DB lokal.

    Response: { "count": 12, "source": "mikrotik" | "local" }
    """
    conn = get_db()
    device = conn.execute(
        'SELECT id, ip, port, username, password, status FROM devices WHERE id = ?',
        (device_id,)
    ).fetchone()
    conn.close()

    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    # Coba realtime dari MikroTik
    if device['status'] == 'connected':
        try:
            from mikrotik import MikroTikClient, MikroTikError
            with MikroTikClient(dict(device)) as mt:
                profiles = mt.get_ppp_profiles()
                count    = len(profiles)
            return jsonify({'count': count, 'source': 'mikrotik'}), 200
        except Exception as e:
            logging.warning(f'[profile-count] Device {device_id} gagal konek MikroTik: {e}')

    # Fallback: hitung dari DB lokal
    conn  = get_db()
    row   = conn.execute(
        'SELECT COUNT(*) as cnt FROM profil_harga WHERE device_id = ?',
        (device_id,)
    ).fetchone()
    conn.close()
    count = row['cnt'] if row else 0

    return jsonify({'count': count, 'source': 'local'}), 200

# ── JALANKAN SERVER ───────────────────────────────────────────
# host='0.0.0.0' → server listen di semua interface,
#   bisa diakses dari LAN maupun dari IP publik (jika port 5000
#   sudah di-forward di router).
# Akses dari luar: http://103.194.175.54:5000
#
# Persiapan agar bisa diakses dari IP publik 103.194.175.54:
#   1. Di router/modem: port forwarding TCP 5000 → IP server lokal
#   2. Di Windows Firewall: izinkan inbound port 5000
#   3. Pastikan ISP tidak block port 5000 (kalau block, ganti ke 80/8080)
def _start_olt_sync_worker():
    """
    Background thread: sinkronisasi OLT semua owner setiap 5 menit.
    Mulai setelah 30 detik delay agar Flask sudah siap sepenuhnya.
    """
    import time, threading
    try:
        from olt_sync import sync_all_olts
    except ImportError as e:
        logging.warning('[OLT Worker] olt_sync tidak tersedia: %s', e)
        return

    def _loop():
        time.sleep(30)  # tunggu Flask siap
        logging.info('[OLT Worker] Sinkronisasi ONU otomatis dimulai (interval 5 menit).')
        while True:
            try:
                sync_all_olts()  # iterasi semua owner
            except Exception as e:
                logging.error('[OLT Worker] Error: %s', e)
            time.sleep(5 * 60)  # 5 menit

    t = threading.Thread(target=_loop, daemon=True, name='olt-sync-worker')
    t.start()
    logging.info('[OLT Worker] Thread sinkronisasi ONU berjalan di background.')


def _start_wa_reminder_worker():
    """
    Background thread: kirim pengingat tagihan WA otomatis (H-3/H/H+3)
    untuk semua owner yang mengaktifkan wa_auto_enabled & punya fitur
    'broadcast'. Dicek tiap 1 jam — aman dijalankan berulang karena
    wa_reminder_log mencegah pengingat dobel per tagihan+tipe.
    Mulai setelah 60 detik delay agar Flask sudah siap sepenuhnya.
    """
    import time, threading
    try:
        from wa import run_auto_reminders
    except ImportError as e:
        logging.warning('[WA Reminder Worker] wa tidak tersedia: %s', e)
        return

    def _loop():
        time.sleep(60)  # tunggu Flask siap
        logging.info('[WA Reminder Worker] Pengingat otomatis dimulai (cek tiap 1 jam).')
        while True:
            try:
                run_auto_reminders()  # iterasi semua owner
            except Exception as e:
                logging.error('[WA Reminder Worker] Error: %s', e)
            time.sleep(60 * 60)  # 1 jam

    t = threading.Thread(target=_loop, daemon=True, name='wa-reminder-worker')
    t.start()
    logging.info('[WA Reminder Worker] Thread pengingat WA berjalan di background.')


def _start_problem_alert_worker():
    """
    Background thread: kirim alert WA ke nomor admin/teknisi (wa_alert_hp)
    saat ada gangguan baru (router/OLT/ONU offline, redaman kritis/lemah)
    untuk owner yang mengaktifkan wa_alert_enabled. Dicek tiap 5 menit —
    aman dijalankan berulang karena wa_problem_alert_log mencegah alert
    dobel utk problem yg sama (dibersihkan otomatis begitu problem hilang
    dari live list, supaya kalau muncul lagi nanti alert dikirim ulang).
    Mulai setelah 60 detik delay agar Flask sudah siap sepenuhnya.
    """
    import time, threading
    try:
        from wa import run_problem_alerts
    except ImportError as e:
        logging.warning('[WA Problem Alert Worker] wa tidak tersedia: %s', e)
        return

    def _loop():
        time.sleep(60)  # tunggu Flask siap
        logging.info('[WA Problem Alert Worker] Alert gangguan dimulai (cek tiap 5 menit).')
        while True:
            try:
                run_problem_alerts()  # iterasi semua owner
            except Exception as e:
                logging.error('[WA Problem Alert Worker] Error: %s', e)
            time.sleep(5 * 60)  # 5 menit

    t = threading.Thread(target=_loop, daemon=True, name='wa-problem-alert-worker')
    t.start()
    logging.info('[WA Problem Alert Worker] Thread alert gangguan berjalan di background.')


def _start_auto_isolir_worker():
    """
    Background thread: isolir otomatis pelanggan yang tagihannya sudah lewat
    jatuh tempo & belum dibayar, untuk semua owner. Dicek tiap 1 jam — aman
    dijalankan berulang karena pelanggan yang sudah berstatus isolir dilewati.
    Mulai setelah 90 detik delay agar Flask sudah siap sepenuhnya.
    """
    import time, threading
    try:
        from tagihan import run_auto_isolir
    except ImportError as e:
        logging.warning('[Auto-Isolir Worker] tagihan tidak tersedia: %s', e)
        return

    def _loop():
        time.sleep(90)  # tunggu Flask siap
        logging.info('[Auto-Isolir Worker] Isolir otomatis dimulai (cek tiap 1 jam).')
        while True:
            try:
                run_auto_isolir()  # iterasi semua owner
            except Exception as e:
                logging.error('[Auto-Isolir Worker] Error: %s', e)
            time.sleep(60 * 60)  # 1 jam

    t = threading.Thread(target=_loop, daemon=True, name='auto-isolir-worker')
    t.start()
    logging.info('[Auto-Isolir Worker] Thread isolir otomatis berjalan di background.')


def _start_bandwidth_worker():
    """
    Background thread: rekam riwayat bandwidth WAN semua MikroTik (yang
    sudah diisi wan_interface) di semua owner, tiap 5 menit — sama
    interval dengan OLT Worker supaya granularitas grafik konsisten.
    Mulai setelah 45 detik delay agar Flask sudah siap sepenuhnya.
    """
    import time, threading
    try:
        from mikrotik import record_bandwidth_all_owners
    except ImportError as e:
        logging.warning('[Bandwidth Worker] mikrotik tidak tersedia: %s', e)
        return

    def _loop():
        time.sleep(45)  # tunggu Flask siap
        logging.info('[Bandwidth Worker] Rekam riwayat bandwidth dimulai (interval 5 menit).')
        while True:
            try:
                record_bandwidth_all_owners()  # iterasi semua owner
            except Exception as e:
                logging.error('[Bandwidth Worker] Error: %s', e)
            time.sleep(5 * 60)  # 5 menit

    t = threading.Thread(target=_loop, daemon=True, name='bandwidth-worker')
    t.start()
    logging.info('[Bandwidth Worker] Thread riwayat bandwidth berjalan di background.')


if __name__ == '__main__':
    init_db()
    _start_olt_sync_worker()
    _start_wa_reminder_worker()
    _start_problem_alert_worker()
    _start_auto_isolir_worker()
    _start_bandwidth_worker()
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)