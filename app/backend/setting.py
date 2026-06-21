"""
setting.py — Endpoint /api/setting
Simpan & ambil konfigurasi ISP ke app_settings (per-owner DB).

Keys yang dikelola:
  profil_isp      → {isp_name, alamat, telepon, email, wa_admin}
  portal_setting  → {enabled, welcome_msg}
  preferensi      → {refresh_interval, rx_good, rx_bad, show_harga, auto_sync}
"""

import json, os
from datetime import datetime
from flask import Blueprint, request, jsonify, g
from utils import get_db

setting_bp = Blueprint('setting', __name__)


@setting_bp.before_request
def _guard():
    if request.method == 'OPTIONS':
        return   # biarkan CORS preflight lolos
    from auth import guard_request
    err = guard_request(perm='pelanggan')
    if err:
        return err
    # /branding dikecualikan dari batasan owner-only — semua role (admin/
    # teknisi/kolektor) perlu baca ini supaya header mereka ikut tampil
    # branding custom, bukan cuma owner yg login.
    if request.path.rstrip('/').endswith('/branding'):
        return
    # Halaman Setting bersifat owner-only di frontend — backend ikut
    # menegakkan ini supaya anggota tim tidak bisa mengubah profil/
    # logo/portal/preferensi ISP lewat panggilan API langsung.
    if g.current_user['role'] != 'owner':
        return jsonify({
            'status':  'error',
            'code':    'permission_denied',
            'message': 'Akses ditolak untuk peran Anda.',
        }), 403


def _save(conn, key: str, value):
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (key, json.dumps(value, ensure_ascii=False), datetime.now().isoformat())
    )
    conn.commit()


def _load(conn, key: str, default=None):
    row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    if row and row['value']:
        try:
            return json.loads(row['value'])
        except Exception:
            return default
    return default


# ── GET semua setting ──────────────────────────────────────────
@setting_bp.route('', methods=['GET'])
def get_settings():
    conn = get_db()
    profil = _load(conn, 'profil_isp', {})
    # Jika isp_name belum diset, ambil dari tabel networks (data saat daftar)
    if not profil.get('isp_name'):
        try:
            from utils import get_master_db
            mconn = get_master_db()
            net   = mconn.execute(
                'SELECT isp_name FROM networks WHERE network_id=?',
                (g.network_id,)
            ).fetchone()
            mconn.close()
            if net and net['isp_name']:
                profil['isp_name'] = net['isp_name']
        except Exception:
            pass

    from packages import package_has_feature
    from utils import get_network_row
    net_row = get_network_row(g.network_id)
    paket = net_row['paket'] if net_row else 'trial'

    data = {
        'profil':        profil,
        'portal':        _load(conn, 'portal_setting', {'enabled': True, 'welcome_msg': ''}),
        'logo':          _load(conn, 'isp_logo',       {'logo_base64': ''}),
        'whitelabel_ok': package_has_feature(paket, 'whitelabel'),
        'preferensi': _load(conn, 'preferensi',     {
            'refresh_interval': 60,
            'rx_good': -20,
            'rx_bad':  -27,
            'show_harga': True,
            'auto_sync':  True,
        }),
    }
    conn.close()
    return jsonify(data), 200


# ── POST simpan section ────────────────────────────────────────
@setting_bp.route('', methods=['POST'])
def save_settings():
    payload = request.get_json(silent=True) or {}
    section = payload.get('section', '')
    data    = payload.get('data', {})

    if not section or not isinstance(data, dict):
        return jsonify({'error': 'section dan data wajib diisi'}), 400

    key_map = {
        'profil':     'profil_isp',
        'portal':     'portal_setting',
        'preferensi': 'preferensi',
        'logo':       'isp_logo',
    }
    db_key = key_map.get(section)
    if not db_key:
        return jsonify({'error': f'Section tidak dikenal: {section}'}), 400

    # Catatan: isp_name (section 'profil') & isp_logo (section 'logo') TIDAK
    # digate di sini — field yg sama dipakai utk invoice/WA (semua paket)
    # MAUPUN ditampilkan di header app (kalau paket whitelabel, lihat
    # /api/setting/branding). Gating-nya di titik BACA/TAMPIL, bukan di
    # titik SIMPAN — supaya tidak ada 2 field nama/logo yg duplikat.

    conn = get_db()
    try:
        _save(conn, db_key, data)
    finally:
        conn.close()

    return jsonify({'success': True, 'section': section}), 200


# ── GET branding (logo+nama custom) — dipanggil tiap halaman utk header,
# TIDAK owner-only (lihat _guard di atas). Return aktif=False kalau paket
# tidak punya fitur whitelabel ATAU owner belum set nama/logo custom —
# frontend fallback ke "TechnoFix-Bill" + logo default kalau aktif=False.
@setting_bp.route('/branding', methods=['GET'])
def get_branding():
    from packages import package_has_feature
    from utils import get_network_row
    net = get_network_row(g.network_id)
    paket = net['paket'] if net else 'trial'
    whitelabel_ok = package_has_feature(paket, 'whitelabel')

    conn = get_db()
    try:
        profil = _load(conn, 'profil_isp', {})
        logo   = _load(conn, 'isp_logo', {})
    finally:
        conn.close()

    nama = (profil.get('isp_name') or '').strip()
    logo_base64 = (logo.get('logo_base64') or '').strip()
    aktif = whitelabel_ok and bool(nama or logo_base64)

    return jsonify({
        'aktif':       aktif,
        'brand_name':  nama if (whitelabel_ok and nama) else '',
        'logo_base64': logo_base64 if (whitelabel_ok and logo_base64) else '',
    }), 200


# ── GET info sistem ────────────────────────────────────────────
@setting_bp.route('/info', methods=['GET'])
def setting_info():
    from utils import get_master_db
    info = {'db_size_kb': 0, 'owner_db_size_kb': 0}
    try:
        # Master DB size
        master_path = os.path.join(
            os.path.dirname(__file__), '..', 'database', 'devices.db'
        )
        if os.path.exists(master_path):
            info['db_size_kb'] = round(os.path.getsize(master_path) / 1024, 1)

        # Owner DB size
        network_id = getattr(g, 'network_id', None)
        if network_id:
            owner_path = os.path.join(
                os.path.dirname(__file__), '..', 'database', 'owners',
                f'{network_id}.db'
            )
            if os.path.exists(owner_path):
                info['owner_db_size_kb'] = round(os.path.getsize(owner_path) / 1024, 1)
                # Tampilkan owner DB yang lebih relevan
                info['db_size_kb'] = info['owner_db_size_kb']
    except Exception:
        pass
    return jsonify(info), 200
