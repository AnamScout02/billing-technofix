"""
odc.py — TechnoFix · Blueprint ODC
=====================================
CRUD endpoint untuk ODC (Optical Distribution Cabinet).

Daftarkan di input.py:
  from odc import odc_bp
  app.register_blueprint(odc_bp, url_prefix='/api/odc')

Tabel: odc
  id, nama, lokasi, koordinat, tipe_kabel,
  jumlah_port, olt_id, keterangan
"""

import logging
from flask import Blueprint, request, jsonify, g
from utils import get_db

odc_bp = Blueprint('odc', __name__)
logger = logging.getLogger(__name__)


# ── Guard multi-tenant: login + cek lock langganan ─────────────
@odc_bp.before_request
def _odc_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    perm = 'perangkat_manage' if request.method in ('POST','PUT','DELETE') else 'perangkat'
    return guard_request(perm=perm)


# ══════════════════════════════════════════════════════════════
# INIT TABEL
# ══════════════════════════════════════════════════════════════

def init_odc_table():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS odc (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            nama        TEXT    NOT NULL,
            lokasi      TEXT    DEFAULT '',
            koordinat   TEXT    DEFAULT '',
            tipe_kabel  TEXT    DEFAULT '',
            jumlah_port INTEGER DEFAULT 0,
            olt_id      INTEGER,
            keterangan  TEXT    DEFAULT '',
            FOREIGN KEY (olt_id) REFERENCES olt(id)
        )
    ''')
    conn.commit()
    conn.close()
    logger.info('[ODC] Tabel odc siap.')


init_odc_table()


# ══════════════════════════════════════════════════════════════
# HELPER
# ══════════════════════════════════════════════════════════════

def odc_to_dict(row) -> dict:
    d = dict(row)
    # Hitung jumlah ODP yang terhubung ke ODC ini
    conn = get_db()
    r    = conn.execute(
        'SELECT COUNT(*) as cnt FROM odp WHERE odc_id = ?', (d['id'],)
    ).fetchone()
    conn.close()
    d['jumlah_odp'] = r['cnt'] if r else 0

    # Ambil nama OLT
    if d.get('olt_id'):
        conn    = get_db()
        olt_row = conn.execute(
            'SELECT name FROM olt WHERE id = ?', (d['olt_id'],)
        ).fetchone()
        conn.close()
        d['olt_nama'] = olt_row['name'] if olt_row else ''
    else:
        d['olt_nama'] = ''

    return d


# ══════════════════════════════════════════════════════════════
# GET /api/odc
# ══════════════════════════════════════════════════════════════

@odc_bp.route('', methods=['GET'])
def get_odc():
    conn = get_db()
    rows = conn.execute('SELECT * FROM odc ORDER BY id').fetchall()
    conn.close()
    return jsonify([odc_to_dict(r) for r in rows]), 200


# ══════════════════════════════════════════════════════════════
# POST /api/odc
# ══════════════════════════════════════════════════════════════

@odc_bp.route('', methods=['POST'])
def add_odc():
    body = request.get_json(silent=True) or {}
    nama = (body.get('nama') or '').strip()
    if not nama:
        return jsonify({'error': 'Nama ODC wajib diisi'}), 400

    lokasi      = (body.get('lokasi')     or '').strip()
    koordinat   = (body.get('koordinat')  or '').strip()
    tipe_kabel  = (body.get('tipe_kabel') or '').strip()
    jumlah_port = int(body.get('jumlah_port') or 0)
    olt_id      = body.get('olt_id') or None
    keterangan  = (body.get('keterangan') or '').strip()

    conn   = get_db()
    cursor = conn.execute(
        '''INSERT INTO odc (nama, lokasi, koordinat, tipe_kabel, jumlah_port, olt_id, keterangan)
           VALUES (?, ?, ?, ?, ?, ?, ?)''',
        (nama, lokasi, koordinat, tipe_kabel, jumlah_port, olt_id, keterangan)
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM odc WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    return jsonify({'message': f'ODC {nama} berhasil ditambahkan', 'odc': odc_to_dict(row)}), 201


# ══════════════════════════════════════════════════════════════
# PUT /api/odc/<id>
# ══════════════════════════════════════════════════════════════

@odc_bp.route('/<int:odc_id>', methods=['PUT'])
def update_odc(odc_id):
    conn = get_db()
    if not conn.execute('SELECT id FROM odc WHERE id = ?', (odc_id,)).fetchone():
        conn.close()
        return jsonify({'error': 'ODC tidak ditemukan'}), 404

    body = request.get_json(silent=True) or {}
    nama = (body.get('nama') or '').strip()
    if not nama:
        conn.close()
        return jsonify({'error': 'Nama ODC wajib diisi'}), 400

    conn.execute(
        '''UPDATE odc SET nama=?, lokasi=?, koordinat=?, tipe_kabel=?,
           jumlah_port=?, olt_id=?, keterangan=? WHERE id=?''',
        (
            nama,
            (body.get('lokasi')     or '').strip(),
            (body.get('koordinat')  or '').strip(),
            (body.get('tipe_kabel') or '').strip(),
            int(body.get('jumlah_port') or 0),
            body.get('olt_id') or None,
            (body.get('keterangan') or '').strip(),
            odc_id
        )
    )
    conn.commit()
    row = conn.execute('SELECT * FROM odc WHERE id = ?', (odc_id,)).fetchone()
    conn.close()

    return jsonify({'message': 'ODC berhasil diperbarui', 'odc': odc_to_dict(row)}), 200


# ══════════════════════════════════════════════════════════════
# DELETE /api/odc/<id>
# ══════════════════════════════════════════════════════════════

@odc_bp.route('/<int:odc_id>', methods=['DELETE'])
def delete_odc(odc_id):
    conn     = get_db()
    affected = conn.execute('DELETE FROM odc WHERE id = ?', (odc_id,)).rowcount
    conn.commit()
    conn.close()

    if not affected:
        return jsonify({'error': 'ODC tidak ditemukan'}), 404
    return jsonify({'message': 'ODC berhasil dihapus'}), 200

# ── GET port tersedia di ODC ──────────────────────────────
@odc_bp.route('/<int:odc_id>/ports', methods=['GET'])
def get_odc_ports(odc_id):
    """
    Kembalikan list port ODC yang KOSONG (belum dipakai ODP manapun).
    Response: { total, terpakai, tersedia, odp_per_port }
    """
    conn = get_db()
    odc = conn.execute('SELECT * FROM odc WHERE id=?', (odc_id,)).fetchone()
    if not odc:
        conn.close()
        return jsonify({'error': 'ODC tidak ditemukan'}), 404

    jumlah = int(odc['jumlah_port'] or 0)
    rows = conn.execute(
        'SELECT id, nama, port_odc FROM odp WHERE odc_id=? AND port_odc IS NOT NULL',
        (odc_id,)
    ).fetchall()
    conn.close()

    used = {int(r['port_odc']): (r['nama'] or '') for r in rows if r['port_odc']}
    tersedia = [p for p in range(1, jumlah + 1) if p not in used]

    _update_odc_port_terpakai(odc_id, len(used))

    return jsonify({
        'odc_id': odc_id,
        'nama': odc['nama'],
        'total': jumlah,
        'terpakai': len(used),
        'tersedia': tersedia,
        'odp_per_port': {str(k): v for k, v in used.items()},
    }), 200


def _update_odc_port_terpakai(odc_id, count):
    try:
        conn = get_db()
        conn.execute('UPDATE odc SET port_terpakai=? WHERE id=?', (count, odc_id))
        conn.commit()
        conn.close()
    except Exception:
        pass
