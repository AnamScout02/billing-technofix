"""
odp.py — TechnoFix-Bill · Blueprint ODP
=====================================
CRUD endpoint untuk ODP (Optical Distribution Point).

Daftarkan di input.py:
  from odp import odp_bp
  app.register_blueprint(odp_bp, url_prefix='/api/odp')

Tabel: odp
  id, nama, lokasi, koordinat, jumlah_port,
  port_terpakai, odc_id, keterangan
"""

import logging
from flask import Blueprint, request, jsonify, g
from utils import get_db

odp_bp = Blueprint('odp', __name__)
logger = logging.getLogger(__name__)


# ── Guard multi-tenant: login + cek lock langganan ─────────────
@odp_bp.before_request
def _odp_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    perm = 'perangkat_manage' if request.method in ('POST','PUT','DELETE') else 'perangkat'
    return guard_request(perm=perm)


# ══════════════════════════════════════════════════════════════
# INIT TABEL
# ══════════════════════════════════════════════════════════════

def init_odp_table():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS odp (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            nama          TEXT    NOT NULL,
            lokasi        TEXT    DEFAULT '',
            koordinat     TEXT    DEFAULT '',
            jumlah_port   INTEGER DEFAULT 0,
            port_terpakai INTEGER DEFAULT 0,
            odc_id        INTEGER,
            keterangan    TEXT    DEFAULT '',
            FOREIGN KEY (odc_id) REFERENCES odc(id)
        )
    ''')
    conn.commit()
    conn.close()
    logger.info('[ODP] Tabel odp siap.')


init_odp_table()


# ══════════════════════════════════════════════════════════════
# HELPER
# ══════════════════════════════════════════════════════════════

def odp_to_dict(row) -> dict:
    d = dict(row)

    if d.get('odc_id'):
        conn    = get_db()
        odc_row = conn.execute('SELECT nama FROM odc WHERE id = ?', (d['odc_id'],)).fetchone()
        conn.close()
        d['odc_nama'] = odc_row['nama'] if odc_row else ''
    else:
        d['odc_nama'] = ''

    if d.get('olt_id'):
        conn    = get_db()
        olt_row = conn.execute('SELECT name FROM olt WHERE id = ?', (d['olt_id'],)).fetchone()
        conn.close()
        d['olt_nama'] = olt_row['name'] if olt_row else ''
    else:
        d['olt_nama'] = ''

    return d


# ══════════════════════════════════════════════════════════════
# GET /api/odp
# ══════════════════════════════════════════════════════════════

@odp_bp.route('', methods=['GET'])
def get_odp():
    # Filter opsional ?odc_id=1
    odc_id = request.args.get('odc_id', '').strip()

    conn = get_db()
    if odc_id:
        rows = conn.execute(
            'SELECT * FROM odp WHERE odc_id = ? ORDER BY id', (odc_id,)
        ).fetchall()
    else:
        rows = conn.execute('SELECT * FROM odp ORDER BY id').fetchall()
    conn.close()

    return jsonify([odp_to_dict(r) for r in rows]), 200


# ══════════════════════════════════════════════════════════════
# POST /api/odp
# ══════════════════════════════════════════════════════════════

def _parse_odp_body(body):
    """Extract dan validasi field ODP dari request body."""
    nama          = (body.get('nama') or '').strip()
    lokasi        = (body.get('lokasi')    or '').strip()
    koordinat     = (body.get('koordinat') or '').strip()
    try:
        jumlah_port = int(body.get('jumlah_port') or 0)
    except (TypeError, ValueError):
        jumlah_port = 0
    keterangan    = (body.get('keterangan') or '').strip()
    # Relasi: parent_odp_id > odc_id > olt_id (prioritas turun)
    odc_id        = body.get('odc_id') or None
    parent_odp_id = body.get('parent_odp_id') or None
    olt_id        = body.get('olt_id') or None
    port_odc      = body.get('port_odc') or None
    port_parent_odp = body.get('port_parent_odp') or None
    if odc_id is not None:
        try: odc_id = int(odc_id)
        except: odc_id = None
    if parent_odp_id is not None:
        try: parent_odp_id = int(parent_odp_id)
        except: parent_odp_id = None
    if olt_id is not None:
        try: olt_id = int(olt_id)
        except: olt_id = None
    if port_odc is not None:
        try: port_odc = int(port_odc)
        except: port_odc = None
    if port_parent_odp is not None:
        try: port_parent_odp = int(port_parent_odp)
        except: port_parent_odp = None
    # Prioritas: parent_odp_id > odc_id > olt_id
    if parent_odp_id:
        odc_id = None; olt_id = None
    elif odc_id:
        olt_id = None
    return nama, lokasi, koordinat, jumlah_port, keterangan, odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp


@odp_bp.route('', methods=['POST'])
def add_odp():
    body = request.get_json(silent=True) or {}
    nama, lokasi, koordinat, jumlah_port, keterangan, odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp = _parse_odp_body(body)
    if not nama:
        return jsonify({'error': 'Nama ODP wajib diisi'}), 400

    conn   = get_db()
    cursor = conn.execute(
        '''INSERT INTO odp (nama, lokasi, koordinat, jumlah_port, port_terpakai,
           odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp, keterangan)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)''',
        (nama, lokasi, koordinat, jumlah_port, odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp, keterangan)
    )
    new_id = cursor.lastrowid
    conn.commit()
    row = conn.execute('SELECT * FROM odp WHERE id = ?', (new_id,)).fetchone()
    conn.close()

    if odc_id:        _update_odc_usage(odc_id)
    if parent_odp_id: _update_odp_usage_from_children(parent_odp_id)

    return jsonify({'message': f'ODP {nama} berhasil ditambahkan', 'odp': odp_to_dict(row)}), 201


# ══════════════════════════════════════════════════════════════
# PUT /api/odp/<id>
# ══════════════════════════════════════════════════════════════

@odp_bp.route('/<int:odp_id>', methods=['PUT'])
def update_odp(odp_id):
    conn = get_db()
    existing = conn.execute('SELECT * FROM odp WHERE id = ?', (odp_id,)).fetchone()
    if not existing:
        conn.close()
        return jsonify({'error': 'ODP tidak ditemukan'}), 404

    body = request.get_json(silent=True) or {}
    nama, lokasi, koordinat, jumlah_port, keterangan, odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp = _parse_odp_body(body)
    if not nama:
        conn.close()
        return jsonify({'error': 'Nama ODP wajib diisi'}), 400

    old_odc_id        = existing['odc_id']
    old_parent_odp_id = existing['parent_odp_id'] if 'parent_odp_id' in existing.keys() else None

    conn.execute(
        '''UPDATE odp SET nama=?, lokasi=?, koordinat=?, jumlah_port=?,
           odc_id=?, parent_odp_id=?, olt_id=?, port_odc=?, port_parent_odp=?, keterangan=?
           WHERE id=?''',
        (nama, lokasi, koordinat, jumlah_port,
         odc_id, parent_odp_id, olt_id, port_odc, port_parent_odp, keterangan,
         odp_id)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM odp WHERE id = ?', (odp_id,)).fetchone()
    conn.close()

    for old in [old_odc_id]:
        if old: _update_odc_usage(old)
    if odc_id: _update_odc_usage(odc_id)
    for old in [old_parent_odp_id]:
        if old: _update_odp_usage_from_children(old)
    if parent_odp_id: _update_odp_usage_from_children(parent_odp_id)

    return jsonify({'message': 'ODP berhasil diperbarui', 'odp': odp_to_dict(row)}), 200


# ══════════════════════════════════════════════════════════════
# DELETE /api/odp/<id>
# ══════════════════════════════════════════════════════════════

@odp_bp.route('/<int:odp_id>', methods=['DELETE'])
def delete_odp(odp_id):
    conn     = get_db()
    existing = conn.execute('SELECT odc_id, parent_odp_id FROM odp WHERE id = ?', (odp_id,)).fetchone()
    affected = conn.execute('DELETE FROM odp WHERE id = ?', (odp_id,)).rowcount
    conn.commit()
    conn.close()

    if not affected:
        return jsonify({'error': 'ODP tidak ditemukan'}), 404

    # Update jumlah ODP di ODC induk
    if existing and existing['odc_id']:
        _update_odc_usage(existing['odc_id'])

    # Update port_terpakai di ODP induk (kalau ODP ini adalah child cascade)
    if existing and existing['parent_odp_id']:
        _update_odp_usage_from_children(existing['parent_odp_id'])

    return jsonify({'message': 'ODP berhasil dihapus'}), 200


# ══════════════════════════════════════════════════════════════
# HELPER — update jumlah ODP di ODC induk (tidak ada kolom ini,
# dihitung realtime di odc_to_dict — jadi ini no-op, reserved)
# ══════════════════════════════════════════════════════════════

def _update_odc_usage(odc_id):
    """Update port_terpakai di ODC berdasarkan slot port_odc yang sudah ditetapkan."""
    try:
        conn = get_db()
        cnt = conn.execute(
            'SELECT COUNT(*) FROM odp WHERE odc_id=? AND port_odc IS NOT NULL', (odc_id,)
        ).fetchone()[0]
        conn.execute('UPDATE odc SET port_terpakai=? WHERE id=?', (cnt, odc_id))
        conn.commit(); conn.close()
    except Exception: pass


def _update_odp_usage_from_children(parent_odp_id):
    """Update port_terpakai di ODP parent berdasarkan slot port (child + pelanggan) yang sudah ditetapkan."""
    try:
        conn = get_db()
        cnt_child = conn.execute(
            'SELECT COUNT(*) FROM odp WHERE parent_odp_id=? AND port_parent_odp IS NOT NULL', (parent_odp_id,)
        ).fetchone()[0]
        cnt_pel = conn.execute(
            'SELECT COUNT(*) FROM pelanggan WHERE odp_id=? AND port_odp IS NOT NULL', (parent_odp_id,)
        ).fetchone()[0]
        conn.execute('UPDATE odp SET port_terpakai=? WHERE id=?', (cnt_child + cnt_pel, parent_odp_id))
        conn.commit(); conn.close()
    except Exception: pass

# ── GET port tersedia di ODP ──────────────────────────────
@odp_bp.route('/<int:odp_id>/ports', methods=['GET'])
def get_odp_ports(odp_id):
    """
    Kembalikan list port ODP yang KOSONG (belum dipakai pelanggan manapun).
    Response: { total: N, terpakai: M, tersedia: [1,2,...], pelanggan_per_port: {1: 'username', ...} }
    """
    conn = get_db()
    odp = conn.execute('SELECT * FROM odp WHERE id=?', (odp_id,)).fetchone()
    if not odp:
        conn.close()
        return jsonify({'error': 'ODP tidak ditemukan'}), 404

    jumlah = int(odp['jumlah_port'] or 0)
    # Cari pelanggan yang sudah pakai port di ODP ini
    # (TANPA filter aktif=1 — pelanggan yang di-disable di MikroTik tetap
    # menempati port fisik ODP selama record & port_odp-nya masih ada)
    rows = conn.execute(
        'SELECT username, nama, port_odp FROM pelanggan WHERE odp_id=? AND port_odp IS NOT NULL',
        (odp_id,)
    ).fetchall()
    conn.close()

    used = {int(r['port_odp']): (r['username'] or '') for r in rows if r['port_odp']}
    tersedia = [p for p in range(1, jumlah + 1) if p not in used]

    # Auto-update port_terpakai (samakan definisi dengan get_odp_child_ports)
    _update_odp_usage_from_children(odp_id)

    return jsonify({
        'odp_id': odp_id,
        'nama': odp['nama'],
        'total': jumlah,
        'terpakai': len(used),
        'tersedia': tersedia,
        'pelanggan_per_port': {str(k): v for k, v in used.items()},
    }), 200


# ── GET port tersedia di ODP parent (untuk cascade ODP→ODP) ──
@odp_bp.route('/<int:odp_id>/child-ports', methods=['GET'])
def get_odp_child_ports(odp_id):
    """
    Port ODP yang kosong untuk disambungkan ke ODP child (cascade).
    Mirip get_odp_ports tapi cek ODP child bukan pelanggan.
    """
    conn = get_db()
    odp = conn.execute('SELECT * FROM odp WHERE id=?', (odp_id,)).fetchone()
    if not odp:
        conn.close()
        return jsonify({'error': 'ODP tidak ditemukan'}), 404

    jumlah = int(odp['jumlah_port'] or 0)
    # Port yang dipakai oleh ODP child
    rows_child = conn.execute(
        'SELECT id, nama, port_parent_odp FROM odp WHERE parent_odp_id=? AND port_parent_odp IS NOT NULL',
        (odp_id,)
    ).fetchall()
    # Port yang dipakai oleh pelanggan
    # (TANPA filter aktif=1 — pelanggan yang di-disable di MikroTik tetap
    # menempati port fisik ODP selama record & port_odp-nya masih ada)
    rows_pel = conn.execute(
        'SELECT username, nama, port_odp FROM pelanggan WHERE odp_id=? AND port_odp IS NOT NULL',
        (odp_id,)
    ).fetchall()
    conn.close()

    used = {}
    for r in rows_child:
        if r['port_parent_odp']:
            used[int(r['port_parent_odp'])] = 'ODP: ' + (r['nama'] or '')
    for r in rows_pel:
        if r['port_odp']:
            used[int(r['port_odp'])] = (r['nama'] or r['username'] or '')

    tersedia = [p for p in range(1, jumlah + 1) if p not in used]
    _update_odp_usage_from_children(odp_id)

    return jsonify({
        'odp_id': odp_id,
        'nama': odp['nama'],
        'total': jumlah,
        'terpakai': len(used),
        'tersedia': tersedia,
        'terhubung_per_port': {str(k): v for k, v in used.items()},
    }), 200
