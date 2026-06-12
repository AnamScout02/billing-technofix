"""
loket.py — TechnoFix · Blueprint Loket / Kasir + Komisi (unified kolektor page)
================================================================================
Halaman kasir terpadu untuk kolektor. Kolektor hanya melihat tagihan
pelanggan yang ditugaskan ke mereka (field kolektor di tabel pelanggan).
Owner/admin melihat semua tagihan dengan opsi filter per kolektor.

Config komisi (app_settings KV, per-owner):
  komisi_tipe  = 'persen' | 'flat'
  komisi_nilai = angka (persen 0-100, atau rupiah flat)

Endpoint (prefix /api/loket):
  GET  /config                         → config komisi
  POST /config {tipe,nilai}            → simpan config (perm keuangan)
  GET  /stats?kolektor=                → stat cards (total,lunas,belum,tung,setoran)
  GET  /tagihan?q=&periode=&kolektor=  → tagihan belum bayar
  GET  /kolektor-list                  → daftar username kolektor (owner/admin)
  POST /bayar {tagihan_id,metode}      → terima pembayaran + komisi
  GET  /rekap?periode=                 → rekap setoran & komisi per kolektor
"""

import logging
from datetime import date, datetime
from flask import Blueprint, request, jsonify, g
from utils import get_db, is_isolir_profil

log = logging.getLogger(__name__)
loket_bp = Blueprint('loket', __name__)


# ── Guard ──────────────────────────────────────────────────────
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


def _is_tagihan_milik_kolektor(conn, username, kolektor_username):
    """True jika pelanggan dgn `username` ditugaskan ke `kolektor_username`."""
    pel = conn.execute(
        'SELECT kolektor FROM pelanggan WHERE username = ?', (username,)
    ).fetchone()
    return bool(pel) and (pel['kolektor'] or '') == kolektor_username


# ── Helper: filter kolektor ────────────────────────────────────
def _kol_condition():
    """
    Kembalikan (join_clause, where_clause, params) berdasarkan role user saat ini.
    - kolektor: JOIN pelanggan, filter WHERE p.kolektor = username
    - owner/admin + ?kolektor=X: JOIN pelanggan, filter by X
    - owner/admin tanpa filter: tanpa join (semua tagihan)
    """
    user = g.current_user or {}
    role = user.get('role', '')
    username = user.get('username', '')
    kol_filter = (request.args.get('kolektor') or '').strip()

    if role == 'kolektor':
        join  = ' JOIN pelanggan p ON p.username = t.username AND p.aktif = 1'
        where = ' AND p.kolektor = ?'
        return join, where, [username]
    if kol_filter:
        join  = ' JOIN pelanggan p ON p.username = t.username AND p.aktif = 1'
        where = ' AND p.kolektor = ?'
        return join, where, [kol_filter]
    return '', '', []


# ── Config komisi ──────────────────────────────────────────────
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


# ── Stat cards ─────────────────────────────────────────────────
@loket_bp.route('/stats', methods=['GET'])
def stats():
    join, where, params = _kol_condition()
    periode = _periode_now()
    today   = date.today().isoformat()
    conn    = get_db()

    def _q(extra_where, extra_params):
        sql = 'SELECT COUNT(*), COALESCE(SUM(t.nominal),0) FROM tagihan t' + join
        sql += ' WHERE 1=1' + where + extra_where
        return conn.execute(sql, params + extra_params).fetchone()

    lunas  = _q(" AND t.status='lunas'  AND t.periode=?", [periode])
    belum  = _q(" AND t.status IN ('belum_bayar','piutang') AND t.periode=?", [periode])
    tung   = _q(" AND t.status IN ('belum_bayar','piutang') AND t.periode<?", [periode])
    setor  = _q(" AND t.status='lunas'  AND DATE(t.paid_at)=?", [today])

    # Total pelanggan (aktif, sesuai filter kolektor)
    user = g.current_user or {}
    role = user.get('role', '')
    kol_filter = (request.args.get('kolektor') or '').strip()
    if role == 'kolektor':
        total_p = conn.execute(
            'SELECT COUNT(*) FROM pelanggan WHERE aktif=1 AND kolektor=?',
            [user.get('username', '')]
        ).fetchone()[0]
    elif kol_filter:
        total_p = conn.execute(
            'SELECT COUNT(*) FROM pelanggan WHERE aktif=1 AND kolektor=?',
            [kol_filter]
        ).fetchone()[0]
    else:
        total_p = conn.execute('SELECT COUNT(*) FROM pelanggan WHERE aktif=1').fetchone()[0]

    conn.close()
    return jsonify({
        'status': 'success',
        'stats': {
            'total_pelanggan':  total_p,
            'lunas_ini':        lunas[0],  'nominal_lunas':   lunas[1],
            'belum_bayar':      belum[0],  'nominal_belum':   belum[1],
            'tunggakan':        tung[0],   'nominal_tung':    tung[1],
            'setoran_hari_ini': setor[0],  'nominal_setoran': setor[1],
        }
    }), 200


# ── Daftar tagihan belum bayar ─────────────────────────────────
@loket_bp.route('/tagihan', methods=['GET'])
def list_tagihan():
    q       = (request.args.get('q') or '').strip()
    periode = (request.args.get('periode') or '').strip()
    join, where, params = _kol_condition()
    periode_now = _periode_now()

    conn = get_db()
    cfg  = _load_komisi(conn)

    # LEFT JOIN terpisah (alias pl) utk ambil profil LIVE pelanggan — beda dgn
    # t.profil yang cuma snapshot saat tagihan dibuat (tidak berubah saat diisolir)
    sql = ('SELECT t.*, pl.profil AS profil_live FROM tagihan t'
           ' LEFT JOIN pelanggan pl ON pl.username = t.username'
           + join + " WHERE t.status IN ('belum_bayar','piutang')" + where)
    p   = params[:]
    if periode:
        sql += ' AND t.periode = ?'; p.append(periode)
    if q:
        sql += ' AND (t.nama LIKE ? OR t.username LIKE ?)'
        p += ['%' + q + '%', '%' + q + '%']
    sql += ' ORDER BY t.periode ASC, t.jatuh_tempo ASC, t.nama ASC LIMIT 500'
    rows = conn.execute(sql, p).fetchall()
    conn.close()

    items = [{
        'id':          r['id'],
        'username':    r['username'],
        'nama':        r['nama'] or r['username'],
        'profil':      r['profil'],
        'periode':     r['periode'],
        'nominal':     r['nominal'],
        'jatuh_tempo': r['jatuh_tempo'] or '',
        'komisi':      _hitung_komisi(cfg, r['nominal']),
        'status':      r['status'],
        'tunggakan':   r['periode'] < periode_now,
        'isolir':      is_isolir_profil(r['profil_live']),
    } for r in rows]
    return jsonify({'status': 'success', 'tagihan': items, 'komisi_config': cfg}), 200


# ── Daftar kolektor (untuk dropdown owner/admin) ───────────────
@loket_bp.route('/kolektor-list', methods=['GET'])
def kolektor_list():
    conn  = get_db()
    rows  = conn.execute(
        "SELECT DISTINCT kolektor FROM pelanggan WHERE kolektor IS NOT NULL AND kolektor <> '' AND aktif=1 ORDER BY kolektor"
    ).fetchall()
    conn.close()
    return jsonify({'status': 'success', 'kolektor': [r['kolektor'] for r in rows]}), 200


# ── Terima pembayaran ──────────────────────────────────────────
@loket_bp.route('/bayar', methods=['POST'])
def bayar():
    data = request.get_json(silent=True) or {}
    try:
        tid = int(data.get('tagihan_id'))
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'tagihan_id wajib'}), 400
    metode   = (data.get('metode') or 'Cash').strip()
    kolektor = (g.current_user or {}).get('username', '')

    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tid,)).fetchone()
    if not t:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    if t['status'] == 'lunas':
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan sudah lunas'}), 400

    # Kolektor cuma boleh terima pembayaran tagihan pelanggan yang
    # ditugaskan padanya — cegah klaim komisi atas tagihan kolektor lain.
    if (g.current_user or {}).get('role') == 'kolektor' \
            and not _is_tagihan_milik_kolektor(conn, t['username'] or '', kolektor):
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tagihan ini bukan tanggung jawab Anda'}), 403

    cfg    = _load_komisi(conn)
    komisi = _hitung_komisi(cfg, t['nominal'])
    now    = datetime.now().isoformat()
    keterangan_prefix = 'Pelunasan piutang' if t['status'] == 'piutang' else 'Loket'

    conn.execute(
        "UPDATE tagihan SET status='lunas', paid_at=?, metode=?, kolektor=?, komisi=? WHERE id=?",
        (now, metode, kolektor, komisi, tid)
    )
    conn.execute(
        '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
           VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
        (date.today().isoformat(),
         '{} {} - {}'.format(keterangan_prefix, t['periode'], t['username'] or t['nama']),
         t['nominal'], metode, t['username'] or '',
         'Pembayaran via loket oleh {} (komisi Rp{})'.format(kolektor or '-', komisi))
    )
    # Pelanggan langsung hidup lagi kalau sedang diisolir krn nunggak
    # (piutang yang sudah disetujui sebelumnya biasanya sudah aktif lagi,
    # tapi pemanggilan ini aman & no-op kalau profil tidak sedang isolir)
    from tagihan import _restore_isolir_if_needed
    _restore_isolir_if_needed(conn, t['username'] or '')

    conn.commit(); conn.close()
    log.info('[Loket] Bayar tagihan #%s oleh %s, komisi %s', tid, kolektor, komisi)
    return jsonify({
        'status':  'success',
        'message': 'Pembayaran diterima. Komisi Rp{:,}'.format(komisi).replace(',', '.'),
        'komisi':  komisi, 'nominal': t['nominal'], 'kolektor': kolektor,
    }), 200


# ── Struk pembayaran ───────────────────────────────────────────
@loket_bp.route('/struk/<int:tagihan_id>', methods=['GET'])
def struk(tagihan_id):
    import re, json as _json
    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tagihan_id,)).fetchone()
    if not t:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404

    user = g.current_user or {}
    if user.get('role') == 'kolektor':
        kuser = user.get('username', '')
        # Boleh akses jika kolektor ini yang memproses pembayarannya, ATAU
        # pelanggannya memang ditugaskan ke kolektor ini.
        if (t['kolektor'] or '') != kuser and not _is_tagihan_milik_kolektor(conn, t['username'] or '', kuser):
            conn.close()
            return jsonify({'status': 'error', 'message': 'Tagihan ini bukan tanggung jawab Anda'}), 403

    # Nomor HP pelanggan dari tabel pelanggan
    pel = conn.execute(
        'SELECT hp, alamat FROM pelanggan WHERE username = ? LIMIT 1',
        (t['username'],)
    ).fetchone()
    hp      = (pel['hp']     if pel and pel['hp']     else '')
    alamat  = (pel['alamat'] if pel and pel['alamat'] else '')

    # Logo + profil ISP dari app_settings (per-owner)
    def _load_setting(key, default):
        row = conn.execute(
            'SELECT value FROM app_settings WHERE key = ?', (key,)
        ).fetchone()
        if not row:
            return default
        try:
            return _json.loads(row['value'])
        except Exception:
            return default

    logo_data  = _load_setting('isp_logo', {})
    profil_isp = _load_setting('profil_isp', {})
    logo_base64 = logo_data.get('logo_base64', '')

    # isp_name: prefer profil_isp, fallback ke networks master
    isp_name = profil_isp.get('isp_name', '')
    if not isp_name:
        from utils import get_master_db
        mdb = get_master_db()
        net = mdb.execute(
            'SELECT isp_name FROM networks WHERE network_id = ?', (g.network_id,)
        ).fetchone()
        mdb.close()
        isp_name = (net['isp_name'] if net else 'ISP')

    conn.close()

    # Nomor struk: format YYYYMMDD-ID
    paid_at   = t['paid_at'] or ''
    tgl_short = re.sub(r'[T ].*', '', paid_at).replace('-', '') if paid_at else ''
    no_struk  = '{}-{:04d}'.format(tgl_short or '00000000', tagihan_id)

    return jsonify({
        'status': 'success',
        'struk': {
            'no_struk':    no_struk,
            'tagihan_id':  tagihan_id,
            'isp_name':    isp_name,
            'isp_logo':    logo_base64,
            'isp_telepon': profil_isp.get('telepon', ''),
            'isp_alamat':  profil_isp.get('alamat', ''),
            'nama':        t['nama'] or t['username'],
            'username':    t['username'],
            'hp':          hp,
            'alamat':      alamat,
            'profil':      t['profil'] or '',
            'periode':     t['periode'] or '',
            'nominal':     t['nominal'],
            'metode':      t['metode'] or 'Cash',
            'kolektor':    t['kolektor'] or '',
            'komisi':      t['komisi'] or 0,
            'paid_at':     t['paid_at'] or '',
            'status':      t['status'],
        }
    }), 200


# ── Rekap setoran & komisi per kolektor ────────────────────────
@loket_bp.route('/rekap', methods=['GET'])
def rekap():
    periode = (request.args.get('periode') or _periode_now()).strip()
    conn    = get_db()

    user = g.current_user or {}
    role = user.get('role', '')
    username = user.get('username', '')

    if role == 'kolektor':
        rows = conn.execute(
            '''SELECT COALESCE(NULLIF(kolektor,''),'(tak tercatat)') AS kolektor,
                      COUNT(*) AS jumlah,
                      COALESCE(SUM(nominal),0) AS total_tagihan,
                      COALESCE(SUM(komisi),0)  AS total_komisi
               FROM tagihan
               WHERE status='lunas' AND periode=? AND kolektor=?
               GROUP BY kolektor''',
            (periode, username)
        ).fetchall()
    else:
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
        'jumlah':        sum(x['jumlah']        for x in per_kolektor),
        'total_tagihan': sum(x['total_tagihan'] for x in per_kolektor),
        'total_komisi':  sum(x['total_komisi']  for x in per_kolektor),
    }
    return jsonify({'status': 'success', 'periode': periode,
                    'rekap': per_kolektor, 'total': total}), 200
