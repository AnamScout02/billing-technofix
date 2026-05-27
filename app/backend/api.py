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
# MIGRASI DB — jalankan otomatis saat modul di-import
# Tambahkan kolom baru ke tabel pelanggan jika belum ada.
# Aman dipanggil berulang kali (cek PRAGMA table_info dulu).
# ══════════════════════════════════════════════════════════════

def migrate_pelanggan_table():
    """Tambahkan kolom tgl_pasang, tgl_jatuh, titik_koordinat
    ke tabel pelanggan jika belum ada."""
    conn  = get_db()
    cols  = {r[1] for r in conn.execute('PRAGMA table_info(pelanggan)').fetchall()}
    added = []

    if 'tgl_pasang' not in cols:
        conn.execute("ALTER TABLE pelanggan ADD COLUMN tgl_pasang TEXT DEFAULT ''")
        added.append('tgl_pasang')
    if 'tgl_jatuh' not in cols:
        conn.execute("ALTER TABLE pelanggan ADD COLUMN tgl_jatuh TEXT DEFAULT ''")
        added.append('tgl_jatuh')
    if 'titik_koordinat' not in cols:
        conn.execute("ALTER TABLE pelanggan ADD COLUMN titik_koordinat TEXT DEFAULT ''")
        added.append('titik_koordinat')

    if added:
        conn.commit()
        logging.info(f'[migrate] Kolom ditambahkan ke tabel pelanggan: {added}')
    conn.close()

# Jalankan migrasi saat modul di-import
try:
    migrate_pelanggan_table()
except Exception as _me:
    logging.warning(f'[migrate] Gagal migrasi tabel pelanggan: {_me}')




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
    Gabungkan data PPP Secret dari MikroTik dengan data ONU dari onu_mapping,
    serta lakukan AUTO-SAVE (Upsert) ke database lokal.
    Jika password dari MikroTik disembunyikan (kosong), gunakan password dari DB lokal.
    """
    device = cari_device(device_id)
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(device) as mt:
            secrets      = mt.get_ppp_secrets()
            active_conns = mt.get_active_connections()
            active_names = {a.get('name') for a in active_conns}
            # Mapping username → raw dict active session (IP & MAC)
            active_detail = {
                a.get('name'): a
                for a in active_conns if a.get('name')
            }
            # Debug: log sample active session untuk verifikasi field tersedia
            if active_conns:
                sample = active_conns[0]
                logging.info(f"[active sample] keys={list(sample.keys())} "
                             f"address={sample.get('address')} "
                             f"caller-id={sample.get('caller-id')}")

        hasil = []
        conn  = get_db()
        
        for s in secrets:
            username = str(s.get('name', '') or '').strip()
            if not username:
                continue
                
            onu = get_onu_data(username)

            profile_mt  = s.get('profile', 'default')
            comment_mt  = s.get('comment', '')
            password_mt = str(s.get('password', '') or '').strip() # Password dari API MikroTik
            service_mt  = s.get('service', 'pppoe')
            disabled_mt = 1 if s.get('disabled') == 'true' else 0

            # 1. CEK DATA LAMA DI DATABASE LOKAL TERLEBIH DAHULU
            row_lama = conn.execute(
                'SELECT password, nama, hp, no_hp FROM pelanggan WHERE username = ?',
                (username,)
            ).fetchone()

            password_saved = ''
            if row_lama:
                password_saved = row_lama['password'] if row_lama['password'] else ''

            # Tentukan password final yang akan disimpan ke DB: 
            # Jika dari MikroTik dapet password (tidak kosong), pakai dari MikroTik.
            # Jika dari MikroTik kosong, amankan dengan memakai password yang sudah ada di DB lokal sebelumnya.
            password_ke_db = password_mt if password_mt else password_saved

            # 2. AUTO-SAVE / UPSERT KE TABEL PELANGGAN LOKAL
            try:
                conn.execute('''
                    INSERT INTO pelanggan (
                        username, nama, password, profil, service, aktif,
                        olt_id, slot_port, vlan, sn
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        profil    = excluded.profil,
                        service   = excluded.service,
                        aktif     = excluded.aktif,
                        password  = excluded.password,
                        nama      = CASE WHEN nama IS NULL OR nama = '' THEN excluded.nama ELSE nama END,
                        olt_id    = CASE WHEN olt_id IS NULL OR olt_id = 0 THEN excluded.olt_id ELSE olt_id END,
                        slot_port = CASE WHEN slot_port IS NULL OR slot_port = '' THEN excluded.slot_port ELSE slot_port END,
                        vlan      = CASE WHEN vlan IS NULL OR vlan = 0 THEN excluded.vlan ELSE vlan END,
                        sn        = CASE WHEN sn IS NULL OR sn = '' THEN excluded.sn ELSE sn END
                ''', (
                    username,
                    comment_mt if comment_mt else username,
                    password_ke_db,
                    profile_mt,
                    service_mt,
                    1 if disabled_mt == 0 else 0,
                    onu.get('olt_id'),
                    onu.get('slot_port'),
                    onu.get('vlan'),
                    onu.get('sn')
                ))
                conn.commit()
            except Exception:
                pass

            # 3. TARIK KEMBALI DATA RESMI SETELAH SINKRONISASI
            row_lokal = conn.execute(
                'SELECT id, username, nama, password, profil, no_hp, hp, service, aktif, tgl_pasang, tgl_jatuh, titik_koordinat FROM pelanggan WHERE username = ?',
                (username,)
            ).fetchone()

            if row_lokal:
                id_pelanggan   = row_lokal['id']
                hp_pelanggan   = row_lokal['hp'] if row_lokal['hp'] else (row_lokal['no_hp'] if row_lokal['no_hp'] else '')
                nama_pelanggan = row_lokal['nama'] or comment_mt or username
                password_fix   = row_lokal['password'] # Menggunakan password fix database
            else:
                id_pelanggan   = s.get('id') or s.get('.id')
                hp_pelanggan   = ''
                nama_pelanggan = comment_mt or username
                password_fix   = password_mt

            # Ambil detail koneksi aktif untuk username ini
            # caller-id = MAC address modem, address = IP yang di-assign
            _sesi = active_detail.get(username, {})

            hasil.append({
                'id':          id_pelanggan,  # ID database lokal (dipakai openDetail/openEdit)
                'mikrotik_id': s.get('.id'),  # ID asli MikroTik — disimpan terpisah
                'device_id':   device_id,
                'username':    username,
                'password':    s.get('password', ''),
                'profil':      s.get('profile', 'default'),
                'service':     s.get('service', 'pppoe'),
                'comment':     s.get('comment', ''),
                'disabled':    s.get('disabled', 'false'),
                'status':      'Online' if username in active_names else 'Offline',

                # IP Address & MAC Address modem dari active session MikroTik
                # Hanya terisi saat pelanggan sedang Online
                'ip_modem':    _sesi.get('address',   ''),
                'mac_address': _sesi.get('caller-id', ''),

                # Data lokal database
                'hp':          row_lokal['hp'] if row_lokal else '',

                # Data ONU OLT hasil sync
                'slot_port':   onu['slot_port'],
                'vlan':        onu['vlan'],
                'sn':          onu['sn'],
                'olt_id':      onu['olt_id'],
                'titik_koordinat': row_lokal['titik_koordinat'] if row_lokal else '',
                'tgl_pasang':  row_lokal['tgl_pasang'] if row_lokal else '',
                'tgl_jatuh':   row_lokal['tgl_jatuh'] if row_lokal else '',
                'nama':        row_lokal['nama'] if row_lokal else '',
                'rx_power':    onu['rx_power'],
                'tx_power':    onu['tx_power'],
            })
            
        conn.close()
        return jsonify(hasil), 200

    except MikroTikError as e:
        return jsonify({'error': str(e)}), 500
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': f'Terjadi kesalahan internal: {str(e)}'}), 500



@api_bp.route('/pelanggan', methods=['POST'])
def tambah_pelanggan():
    """
    Tambah pelanggan baru:
      1. Buat PPP Secret di MikroTik
      2. Simpan ke tabel pelanggan lokal
      3. Provisioning ONU ke OLT (opsional, jika olt_id & sn & slot_port ada)
    """
    body      = request.get_json() or {}
    device_id = body.get('device_id')
    username  = str(body.get('username', '') or '').strip()
    password  = str(body.get('password', '') or '').strip()
    profil    = str(body.get('profil', 'default') or 'default').strip()
    hp        = str(body.get('hp', '') or body.get('no_hp', '') or '').strip()
    nama      = str(body.get('nama', '') or username).strip()
    olt_id    = body.get('olt_id')
    slot_port = str(body.get('slot_port', '') or '').strip()
    vlan      = str(body.get('vlan', '') or '').strip()
    sn        = str(body.get('sn', '') or '').strip()
    koordinat = str(body.get('titik_koordinat', '') or body.get('koordinat', '') or '').strip()
    tgl_pasang = str(body.get('tgl_pasang', '') or '').strip()
    tgl_jatuh  = str(body.get('tgl_jatuh', '') or '').strip()

    if not username:
        return jsonify({'error': 'Username wajib diisi'}), 400
    if not password:
        return jsonify({'error': 'Password wajib diisi'}), 400
    if not device_id:
        return jsonify({'error': 'Perangkat MikroTik wajib dipilih'}), 400

    device = cari_device(int(device_id))
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    steps    = {}
    warnings = []

    # ── 1. Tambah PPP Secret ke MikroTik ──────────────────
    try:
        with MikroTikClient(device) as mt:
            mt.tambah_secret({
                'name':     username,
                'password': password,
                'profile':  profil,
                'service':  'pppoe',
                'comment':  nama,
            })
        steps['mikrotik'] = 'success'
    except MikroTikError as e:
        return jsonify({'error': f'Gagal tambah ke MikroTik: {e}'}), 502

    # ── 2. Simpan ke DB lokal ──────────────────────────────
    try:
        conn = get_db()
        existing = conn.execute(
            'SELECT id FROM pelanggan WHERE username = ?', (username,)
        ).fetchone()

        if existing:
            conn.execute('''
                UPDATE pelanggan
                SET device_id=?, password=?, profil=?, hp=?, no_hp=?, nama=?,
                    slot_port_onu=?, vlan=?, sn=?, titik_koordinat=?,
                    tgl_pasang=?, tgl_jatuh=?, aktif=1
                WHERE username=?
            ''', (device_id, password, profil, hp, hp, nama,
                   slot_port, vlan, sn, koordinat,
                   tgl_pasang, tgl_jatuh, username))
        else:
            conn.execute('''
                INSERT INTO pelanggan
                  (device_id, username, password, profil, hp, no_hp, nama,
                   slot_port_onu, vlan, sn, titik_koordinat,
                   tgl_pasang, tgl_jatuh, aktif, service)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pppoe')
            ''', (device_id, username, password, profil, hp, hp, nama,
                   slot_port, vlan, sn, koordinat,
                   tgl_pasang, tgl_jatuh))
        conn.commit()
        conn.close()
        steps['database'] = 'success'
    except Exception as e:
        warnings.append(f'DB lokal: {e}')
        steps['database'] = 'warning'

    # ── 3. Update onu_mapping jika ada data ONU ────────────
    if olt_id and (sn or slot_port):
        try:
            conn = get_db()
            conn.execute('''
                INSERT INTO onu_mapping (username, olt_id, slot_port, vlan, sn)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    olt_id=excluded.olt_id, slot_port=excluded.slot_port,
                    vlan=excluded.vlan, sn=excluded.sn
            ''', (username, olt_id, slot_port, vlan, sn))
            conn.commit()
            conn.close()
            steps['onu_mapping'] = 'success'
        except Exception as e:
            warnings.append(f'ONU mapping: {e}')

    status_code = 207 if warnings else 201
    return jsonify({
        'status':   'success',
        'message':  f'{username} berhasil ditambahkan',
        'steps':    steps,
        'warnings': warnings,
    }), status_code


@api_bp.route('/pelanggan/<string:id_pelanggan>', methods=['PUT'])
def update_pelanggan(id_pelanggan):
    """
    Endpoint untuk menyimpan perubahan edit pelanggan (termasuk Nomor HP/Telepon)
    """
    try:
        body = request.get_json() or {}
        username = body.get('username', '').strip()
        hp = body.get('hp', '') or body.get('no_hp', '') or ''
        nama = body.get('nama', '') or body.get('name', '') or ''
        
        if not username:
            return jsonify({'error': 'Username tidak boleh kosong'}), 400

        conn = get_db()

        # 1. Cek apakah user sudah ada di database lokal berdasarkan username
        user_lokal = conn.execute('SELECT id FROM pelanggan WHERE username = ?', (username,)).fetchone()

        koordinat  = str(body.get('titik_koordinat', '') or body.get('koordinat', '') or '').strip()
        tgl_pasang = str(body.get('tgl_pasang', '') or '').strip()
        tgl_jatuh  = str(body.get('tgl_jatuh', '') or '').strip()
        profil     = str(body.get('profil', '') or '').strip()
        slot_port  = str(body.get('slot_port', '') or '').strip()
        vlan       = str(body.get('vlan', '') or '').strip()
        sn         = str(body.get('sn', '') or '').strip()

        if user_lokal:
            conn.execute('''
                UPDATE pelanggan
                SET hp=?, no_hp=?, nama=?,
                    slot_port_onu=?, vlan=?, sn=?,
                    titik_koordinat=?, tgl_pasang=?, tgl_jatuh=?,
                    profil=CASE WHEN ?!=\'\' THEN ? ELSE profil END
                WHERE username=?
            ''', (
                hp, hp, nama,
                slot_port, vlan, sn,
                koordinat, tgl_pasang, tgl_jatuh,
                profil, profil,
                username
            ))
        else:
            conn.execute('''
                INSERT INTO pelanggan
                  (username, nama, hp, no_hp, slot_port_onu, vlan, sn,
                   titik_koordinat, tgl_pasang, tgl_jatuh)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            ''', (
                username, nama, hp, hp,
                slot_port, vlan, sn,
                koordinat, tgl_pasang, tgl_jatuh
            ))

        conn.commit()
        conn.close()

        return jsonify({'status': 'success', 'message': 'Data pelanggan berhasil diperbarui lokal'}), 200

    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': f'Gagal menyimpan data: {str(e)}'}), 500

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
            secrets = mt.get_ppp_secrets()

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
            secrets  = mt.get_ppp_secrets()

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

# ══════════════════════════════════════════════════════════════
# ENDPOINT — GET /api/maps/topology
# Data untuk halaman peta: node perangkat + ONU pelanggan
# ══════════════════════════════════════════════════════════════

@api_bp.route('/maps/topology', methods=['GET'])
def maps_topology():
    """
    Mengembalikan semua node (MikroTik, OLT, ONU/pelanggan)
    yang punya titik_koordinat untuk ditampilkan di peta Leaflet.

    Format response:
    {
      "nodes": [
        {
          "id":       "onu-123",
          "name":     "budi.santoso",
          "type":     "onu",          // router | olt | onu
          "lat":      -8.267,
          "lng":      114.369,
          "status":   "online",       // online | offline
          "rx_power": -21.5,          // null jika tidak ada
          "detail": {
            "profil": "10MB",
            "sn":     "ZTEG...",
            "vlan":   "200",
            "slot_port": "1/1/1:5",
            "hp":     "08123456789"
          }
        }
      ],
      "links": []   // dikembangkan nanti (OLT→ONU)
    }
    """
    conn  = get_db()
    nodes = []

    # ── 1. MikroTik devices ────────────────────────────────
    devices = conn.execute('SELECT * FROM devices').fetchall()
    for d in devices:
        coord = ''  # devices tabel belum punya titik_koordinat
        # skip jika tidak ada koordinat
        if not coord:
            continue
        lat, lng = _parse_coord(coord)
        if lat is None:
            continue
        nodes.append({
            'id':       f'router-{d["id"]}',
            'name':     d['name'],
            'type':     'router',
            'lat':      lat,
            'lng':      lng,
            'status':   'online' if d['status'] == 'connected' else 'offline',
            'rx_power': None,
            'detail':   {'ip': d['ip']},
        })

    # ── 2. OLT ────────────────────────────────────────────
    olts = conn.execute('SELECT * FROM olt').fetchall()
    for o in olts:
        coord = (o['lokasi'] or '').strip()
        lat, lng = _parse_coord(coord)
        if lat is None:
            # coba field keterangan juga
            lat, lng = _parse_coord((o['keterangan'] or '').strip())
        if lat is None:
            continue
        nodes.append({
            'id':       f'olt-{o["id"]}',
            'name':     o['name'],
            'type':     'olt',
            'lat':      lat,
            'lng':      lng,
            'status':   'online' if o['status'] == 'connected' else 'offline',
            'rx_power': None,
            'detail':   {
                'ip':    o['ip'],
                'tipe':  o['tipe'] or '',
                'lokasi': o['lokasi'] or '',
            },
        })

    # ── 3. Pelanggan (ONU) — yang punya titik_koordinat ──
    # Join dengan onu_mapping untuk rx_power & active status
    rows = conn.execute('''
        SELECT p.id, p.username, p.profil, p.hp, p.no_hp,
               p.titik_koordinat, p.aktif,
               m.rx_power, m.tx_power, m.sn, m.vlan, m.slot_port,
               m.olt_id
        FROM pelanggan p
        LEFT JOIN onu_mapping m ON m.username = p.username
        WHERE p.titik_koordinat IS NOT NULL
          AND p.titik_koordinat != ''
    ''').fetchall()

    # Ambil daftar username yang sedang online dari semua MikroTik
    online_set = set()
    try:
        active_rows = conn.execute('''
            SELECT DISTINCT username FROM pelanggan
        ''').fetchall()
        # Cek via tabel — online_set diisi dari /api/pelanggan live check
        # Fallback: anggap semua aktif=1 sebagai online
        for r in rows:
            if r['aktif']:
                online_set.add(r['username'])
    except Exception:
        pass

    for r in rows:
        lat, lng = _parse_coord(r['titik_koordinat'])
        if lat is None:
            continue

        username = r['username'] or ''
        status   = 'online' if username in online_set else 'offline'
        rx       = r['rx_power']
        try:
            rx = float(rx) if rx is not None else None
        except (TypeError, ValueError):
            rx = None

        nodes.append({
            'id':       f'onu-{r["id"]}',
            'name':     username,
            'type':     'onu',
            'lat':      lat,
            'lng':      lng,
            'status':   status,
            'rx_power': rx,
            'detail':   {
                'profil':    r['profil'] or '',
                'sn':        r['sn'] or '',
                'vlan':      r['vlan'] or '',
                'slot_port': r['slot_port'] or '',
                'hp':        r['hp'] or r['no_hp'] or '',
            },
        })

    conn.close()

    return jsonify({'nodes': nodes, 'links': []}), 200


def _parse_coord(coord_str: str):
    """
    Parse string koordinat 'lat, lng' → (float, float) atau (None, None).
    Mendukung: '-8.2678707, 114.3692840' atau '-8.2678707,114.3692840'
    """
    if not coord_str:
        return None, None
    try:
        parts = coord_str.replace(';', ',').split(',')
        if len(parts) >= 2:
            lat = float(parts[0].strip())
            lng = float(parts[1].strip())
            # Validasi range
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                return lat, lng
    except (ValueError, AttributeError):
        pass
    return None, None