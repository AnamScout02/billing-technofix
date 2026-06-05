"""
loket.py — TechnoFix · Blueprint Loket / Kasir + Komisi
=======================================================
Halaman kasir: kolektor/admin menerima pembayaran tagihan
pelanggan secara langsung. Saat dibayar lewat loket:
  - tagihan ditandai lunas (kolektor & komisi dicatat),
  - transaksi masuk ke tabel keuangan (pemasukan),
  - komisi kolektor dihitung dari config app_settings.

Config komisi (app_settings KV, per-owner):
  komisi_tipe  = 'persen' | 'flat'
  komisi_nilai = angka (persen 0-100, atau rupiah flat)

Daftarkan di input.py:
  from loket import loket_bp
  app.register_blueprint(loket_bp, url_prefix='/api/loket')

Endpoint (prefix /api/loket):
  GET  /config                  → config komisi
  POST /config {tipe,nilai}     → simpan config komisi (perm keuangan)
  GET  /tagihan?q=&periode=     → tagihan belum_bayar untuk ditagih
  POST /bayar {tagihan_id,metode}  → terima pembayaran + komisi
  GET  /rekap?periode=          → rekap setoran & komisi per kolektor
"""

import logging
from datetime import date, datetime
from flask import Blueprint, request, jsonify, g
from utils import get_db

log = logging.getLogger(__name__)
loket_bp = Blueprint('loket', __name__)


# ── Guard: config = keuangan; aksi loket = bayar ───────────────
@loket_bp.before_request
def _loket_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    p = request.path.rstrip('/')
    perm = 'keuangan' if p.endswith('/config') else 'bayar'
    return guard_request(perm=perm)


def _periode_now():
    return date.today().strftime('%Y-%m')


# ── Config komisi (app_settings) ───────────────────────────────
def _load_komisi(conn):
    rows = conn.execute(
        "SELECT key, value FROM app_settings WHERE key IN ('komisi_tipe','komisi_nilai')"
    ).fetchall()
    d = {r['key']: r['value'] for r in rows}
    tipe = d.get('komisi_tipe') or 'persen'
    try:
        nilai = int(float(d.get('komisi_nilai') or 0))
    except (TypeError, ValueError):
        nilai = 0
    return {'tipe': tipe if tipe in ('persen', 'flat') else 'persen', 'nilai': nilai}


def _hitung_komisi(cfg, nominal):
    if cfg['tipe'] == 'flat':
        return max(0, int(cfg['nilai']))
    return max(0, int(int(nominal) * int(cfg['nilai']) // 100))


def _save_setting(conn, key, value):
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (key, value, datetime.now().isoformat()),
    )


@loket_bp.route('/config', methods=['GET'])
def get_config():
    conn = get_db()
    cfg = _load_komisi(conn)
    conn.close()
    return jsonify({'status': 'success', 'config': cfg}), 200


@loket_bp.route('/config', methods=['POST'])
def save_config():
    data = request.get_json(silent=True) or {}
    tipe = (data.get('tipe') or 'persen').strip()
    if tipe not in ('persen', 'flat'):
        return jsonify({'status': 'error', 'message': 'Tipe komisi tidak valid'}), 400
    try:
        nilai = int(float(data.get('nilai') or 0))
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'Nilai komisi harus angka'}), 400
    if nilai < 0 or (tipe == 'persen' and nilai > 100):
        return jsonify({'status': 'error', 'message': 'Nilai komisi di luar batas'}), 400

    conn = get_db()
    _save_setting(conn, 'komisi_tipe', tipe)
    _save_setting(conn, 'komisi_nilai', str(nilai))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Pengaturan komisi tersimpan'}), 200


# ── Daftar tagihan belum bayar (untuk ditagih di loket) ────────
@loket_bp.route('/tagihan', methods=['GET'])
def list_tagihan():
    q = (request.args.get('q') or '').strip()
    periode = (request.args.get('periode') or '').strip()

    conn = get_db()
    cfg = _load_komisi(conn)
    sql = "SELECT * FROM tagihan WHERE status = 'belum_bayar'"
    params = []
    if periode:
        sql += ' AND periode = ?'; params.append(periode)
    if q:
        sql += ' AND (nama LIKE ? OR username LIKE ?)'
        params += ['%' + q + '%', '%' + q + '%']
    sql += ' ORDER BY jatuh_tempo ASC, nama ASC LIMIT 200'
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    items = [{
        'id': r['id'], 'username': r['username'], 'nama': r['nama'] or r['username'],
        'profil': r['profil'], 'periode': r['periode'], 'nominal': r['nominal'],
        'jatuh_tempo': r['jatuh_tempo'] or '',
        'komisi': _hitung_komisi(cfg, r['nominal']),
    } for r in rows]
    return jsonify({'status': 'success', 'tagihan': items, 'komisi_config': cfg}), 200


# ── Terima pembayaran di loket → lunas + keuangan + komisi ─────
@loket_bp.route('/bayar', methods=['POST'])
def bayar():
    data = request.get_json(silent=True) or {}
    try:
        tid = int(data.get('tagihan_id'))
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'tagihan_id wajib'}), 400
    metode = (data.get('metode') or 'Cash').strip()
    kolektor = (g.current_user or {}).get('username', '')

    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tid,)).fetchone()
    if not t:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    if t['status'] == 'lunas':
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan sudah lunas'}), 400

    cfg = _load_komisi(conn)
    komisi = _hitung_komisi(cfg, t['nominal'])
    now = datetime.now().isoformat()

    conn.execute(
        "UPDATE tagihan SET status='lunas', paid_at=?, metode=?, kolektor=?, komisi=? WHERE id=?",
        (now, metode, kolektor, komisi, tid)
    )
    conn.execute(
        '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
           VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
        (date.today().isoformat(),
         'Loket {} - {}'.format(t['periode'], t['username'] or t['nama']),
         t['nominal'], metode, t['username'] or '',
         'Pembayaran via loket oleh {} (komisi Rp{})'.format(kolektor or '-', komisi))
    )
    conn.commit(); conn.close()
    log.info('[Loket] Bayar tagihan #%s oleh %s, komisi %s', tid, kolektor, komisi)
    return jsonify({
        'status': 'success',
        'message': 'Pembayaran diterima. Komisi Rp{:,}'.format(komisi).replace(',', '.'),
        'komisi': komisi, 'nominal': t['nominal'], 'kolektor': kolektor,
    }), 200


# ── Rekap setoran & komisi per kolektor ────────────────────────
@loket_bp.route('/rekap', methods=['GET'])
def rekap():
    periode = (request.args.get('periode') or _periode_now()).strip()
    conn = get_db()
    rows = conn.execute(
        '''SELECT COALESCE(NULLIF(kolektor,''),'(tak tercatat)') AS kolektor,
                  COUNT(*) AS jumlah,
                  COALESCE(SUM(nominal),0) AS total_tagihan,
                  COALESCE(SUM(komisi),0)  AS total_komisi
           FROM tagihan
           WHERE status='lunas' AND periode=? AND kolektor IS NOT NULL AND kolektor <> ''
           GROUP BY kolektor ORDER BY total_tagihan DESC''',
        (periode,)
    ).fetchall()
    conn.close()

    per_kolektor = [{
        'kolektor': r['kolektor'], 'jumlah': r['jumlah'],
        'total_tagihan': r['total_tagihan'], 'total_komisi': r['total_komisi'],
    } for r in rows]
    total = {
        'jumlah': sum(x['jumlah'] for x in per_kolektor),
        'total_tagihan': sum(x['total_tagihan'] for x in per_kolektor),
        'total_komisi': sum(x['total_komisi'] for x in per_kolektor),
    }
    return jsonify({'status': 'success', 'periode': periode,
                    'rekap': per_kolektor, 'total': total}), 200
