"""
tagihan.py — TechnoFix · Blueprint Tagihan Bulanan
====================================================
Tagihan langganan pelanggan per bulan. Nominal diambil dari
profil_harga (harga profil PPPoE pelanggan). Saat dibayar →
catat ke tabel keuangan (pemasukan).

Endpoint (prefix /api/tagihan, di input.py):
  GET  /api/tagihan?periode=YYYY-MM&status=   → daftar + ringkasan
  POST /api/tagihan/generate {periode}        → buat tagihan pelanggan aktif
  POST /api/tagihan/<id>/bayar {metode}       → tandai lunas + catat keuangan
"""

import logging
from datetime import date
from flask import Blueprint, request, jsonify, g
from utils import get_db

log = logging.getLogger(__name__)
tagihan_bp = Blueprint('tagihan', __name__)


# ── Guard: login + lock + permission per-aksi ──────────────────
@tagihan_bp.before_request
def _tagihan_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    p = request.path.rstrip('/')
    if p.endswith('/generate'):
        perm = 'keuangan'      # generate tagihan = aksi billing (owner/admin)
    elif p.endswith('/bayar'):
        perm = 'bayar'         # terima pembayaran (owner/admin/kolektor)
    else:
        perm = 'pelanggan'     # lihat daftar tagihan
    return guard_request(perm=perm)


def _periode_now():
    return date.today().strftime('%Y-%m')


def _harga_profil(conn, device_id, profil):
    """Harga dari profil_harga sesuai device + nama profil. 0 bila tak ada."""
    if not profil:
        return 0
    row = conn.execute(
        'SELECT harga FROM profil_harga WHERE device_id = ? AND nama_profile = ?',
        (device_id, profil)
    ).fetchone()
    if row:
        return int(row['harga'] or 0)
    # fallback: cocokkan nama profil saja (device mana pun)
    row = conn.execute(
        'SELECT harga FROM profil_harga WHERE nama_profile = ? ORDER BY id LIMIT 1',
        (profil,)
    ).fetchone()
    return int(row['harga'] or 0) if row else 0


# ── GET daftar tagihan + ringkasan ─────────────────────────────
@tagihan_bp.route('', methods=['GET'])
def list_tagihan():
    periode = (request.args.get('periode') or _periode_now()).strip()
    status  = (request.args.get('status') or '').strip()

    conn = get_db()
    q = 'SELECT * FROM tagihan WHERE periode = ?'
    params = [periode]
    if status in ('belum_bayar', 'lunas'):
        q += ' AND status = ?'
        params.append(status)
    q += ' ORDER BY status ASC, nama ASC, username ASC'
    rows = conn.execute(q, params).fetchall()

    # ringkasan periode (tanpa filter status)
    summ = conn.execute(
        '''SELECT
             COUNT(*) AS total,
             COALESCE(SUM(nominal),0) AS nominal_total,
             COALESCE(SUM(CASE WHEN status='lunas' THEN 1 ELSE 0 END),0) AS lunas,
             COALESCE(SUM(CASE WHEN status='lunas' THEN nominal ELSE 0 END),0) AS nominal_lunas
           FROM tagihan WHERE periode = ?''',
        (periode,)
    ).fetchone()
    conn.close()

    items = [{
        'id': r['id'], 'pelanggan_id': r['pelanggan_id'],
        'username': r['username'], 'nama': r['nama'] or r['username'],
        'profil': r['profil'], 'periode': r['periode'],
        'nominal': r['nominal'], 'status': r['status'],
        'jatuh_tempo': r['jatuh_tempo'] or '', 'paid_at': r['paid_at'] or '',
        'metode': r['metode'] or '',
    } for r in rows]

    total = summ['total'] or 0
    return jsonify({
        'status': 'success',
        'periode': periode,
        'tagihan': items,
        'ringkasan': {
            'total':         total,
            'lunas':         summ['lunas'] or 0,
            'belum':         total - (summ['lunas'] or 0),
            'nominal_total': summ['nominal_total'] or 0,
            'nominal_lunas': summ['nominal_lunas'] or 0,
            'nominal_belum': (summ['nominal_total'] or 0) - (summ['nominal_lunas'] or 0),
        },
    }), 200


# ── POST generate tagihan untuk pelanggan aktif ────────────────
@tagihan_bp.route('/generate', methods=['POST'])
def generate_tagihan():
    data    = request.get_json(silent=True) or {}
    periode = (data.get('periode') or _periode_now()).strip()
    jt_hari = int(data.get('jatuh_tempo_hari', 20) or 20)
    jatuh_tempo = '{}-{:02d}'.format(periode, jt_hari)

    conn = get_db()
    # pelanggan aktif
    try:
        pels = conn.execute(
            "SELECT id, username, nama, profil, device_id FROM pelanggan WHERE aktif = 1"
        ).fetchall()
    except Exception:
        pels = conn.execute(
            "SELECT id, username, nama, profil, device_id FROM pelanggan"
        ).fetchall()

    dibuat = 0
    dilewati = 0
    for p in pels:
        nominal = _harga_profil(conn, p['device_id'], p['profil'])
        try:
            conn.execute(
                '''INSERT INTO tagihan (pelanggan_id, username, nama, profil, periode, nominal, jatuh_tempo)
                   VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (p['id'], p['username'] or '', p['nama'] or p['username'] or '',
                 p['profil'] or '', periode, nominal, jatuh_tempo)
            )
            dibuat += 1
        except Exception:
            dilewati += 1  # sudah ada (UNIQUE pelanggan_id+periode)
    conn.commit(); conn.close()

    return jsonify({
        'status': 'success',
        'message': 'Tagihan periode {} dibuat: {} baru, {} sudah ada.'.format(periode, dibuat, dilewati),
        'dibuat': dibuat, 'dilewati': dilewati, 'periode': periode,
    }), 201


def _restore_isolir_if_needed(conn, username):
    """
    Jika pelanggan sedang diisolir (profil mengandung 'isolir'),
    kembalikan profil ke profil_sebelum_isolir via MikroTik.
    Dipanggil setelah tagihan dibayar lunas.
    Gagal senyap — tidak menghentikan proses pembayaran.
    """
    try:
        row = conn.execute(
            'SELECT id, profil, profil_sebelum_isolir, device_id FROM pelanggan WHERE username = ?',
            (username,)
        ).fetchone()
        if not row:
            return
        profil_now = (row['profil'] or '').lower()
        if 'isolir' not in profil_now and 'blokir' not in profil_now and 'suspend' not in profil_now:
            return  # tidak sedang diisolir

        profil_restore = row['profil_sebelum_isolir'] or 'default'
        if not profil_restore or 'isolir' in profil_restore.lower():
            profil_restore = 'default'

        # Restore via MikroTik
        import sys, os
        sys.path.insert(0, os.path.dirname(__file__))
        from mikrotik import MikroTikClient, MikroTikError
        from utils import get_db as _get_db

        # Cari device
        _conn = _get_db()
        dev_row = _conn.execute('SELECT * FROM devices WHERE id = ?', (row['device_id'],)).fetchone()
        _conn.close()
        if not dev_row:
            return

        device = dict(dev_row)
        with MikroTikClient(device) as mt:
            mt.edit_secret(username, {'profile': profil_restore, 'disabled': 'no'})
            # Kick sesi aktif
            try:
                from librouteros.query import Key
                api = mt._get_api()
                active_path = api.path('/ppp/active')
                active = next((r for r in active_path.select(Key('.id'), Key('name')) if r.get('name') == username), None)
                if active:
                    active_path.remove(active['.id'])
            except Exception:
                pass

        # Update DB
        conn.execute(
            'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = NULL WHERE username = ?',
            (profil_restore, username)
        )
        log.info('[Tagihan] Restore isolir %s: %s -> %s', username, row['profil'], profil_restore)
    except Exception as e:
        log.warning('[Tagihan] Restore isolir gagal untuk %s: %s', username, e)


# ── POST bayar tagihan → lunas + catat keuangan ────────────────
@tagihan_bp.route('/<int:tagihan_id>/bayar', methods=['POST'])
def bayar_tagihan(tagihan_id):
    from datetime import datetime
    data   = request.get_json(silent=True) or {}
    metode = (data.get('metode') or 'Cash').strip()

    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tagihan_id,)).fetchone()
    if not t:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    if t['status'] == 'lunas':
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan sudah lunas'}), 400

    now = datetime.now().isoformat()
    conn.execute(
        "UPDATE tagihan SET status='lunas', paid_at=?, metode=? WHERE id=?",
        (now, metode, tagihan_id)
    )
    conn.execute(
        '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
           VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
        (date.today().isoformat(),
         'Tagihan {} - {}'.format(t['periode'], t['username'] or t['nama']),
         t['nominal'], metode, t['username'] or '',
         'Pembayaran tagihan periode {}'.format(t['periode']))
    )
    # Restore profil jika sedang diisolir
    _restore_isolir_if_needed(conn, t['username'] or '')
    conn.commit(); conn.close()
    log.info('[Tagihan] Bayar #%s (%s) %s', tagihan_id, t['username'], t['nominal'])
    return jsonify({'status': 'success', 'message': 'Tagihan lunas & profil dipulihkan jika diisolir'}), 200


# ── GET riwayat tagihan per pelanggan ──────────────────────────
@tagihan_bp.route('/pelanggan/<string:username>', methods=['GET'])
def riwayat_pelanggan(username):
    """Riwayat semua tagihan milik satu username, terbaru di atas."""
    conn = get_db()
    rows = conn.execute(
        '''SELECT * FROM tagihan WHERE username = ?
           ORDER BY periode DESC''',
        (username,)
    ).fetchall()
    conn.close()
    items = [{
        'id': r['id'], 'username': r['username'],
        'nama': r['nama'] or r['username'],
        'profil': r['profil'] or '-',
        'periode': r['periode'],
        'nominal': r['nominal'],
        'status': r['status'],
        'jatuh_tempo': r['jatuh_tempo'] or '',
        'paid_at': r['paid_at'] or '',
        'metode': r['metode'] or '',
        'kolektor': r['kolektor'] if 'kolektor' in r.keys() else '',
    } for r in rows]
    return jsonify({'status': 'success', 'tagihan': items}), 200


# ── POST bayar beberapa tagihan sekaligus (multi-bulan) ────────
@tagihan_bp.route('/bayar-multi', methods=['POST'])
def bayar_multi():
    """Bayar beberapa tagihan sekaligus. Body: {tagihan_ids:[1,2,3], metode:'Cash'}"""
    from datetime import datetime
    data = request.get_json(silent=True) or {}
    ids = [int(x) for x in (data.get('tagihan_ids') or []) if str(x).isdigit()]
    metode = (data.get('metode') or 'Cash').strip()
    kolektor = (g.current_user or {}).get('username', '')

    if not ids:
        return jsonify({'status': 'error', 'message': 'Pilih minimal 1 tagihan'}), 400

    conn = get_db()
    berhasil = []
    gagal = []
    total = 0

    now = datetime.now().isoformat()
    for tid in ids:
        t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tid,)).fetchone()
        if not t or t['status'] == 'lunas':
            gagal.append(tid)
            continue
        conn.execute(
            "UPDATE tagihan SET status='lunas', paid_at=?, metode=?, kolektor=? WHERE id=?",
            (now, metode, kolektor, tid)
        )
        conn.execute(
            '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
               VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
            (date.today().isoformat(),
             'Tagihan {} - {}'.format(t['periode'], t['username'] or t['nama']),
             t['nominal'], metode, t['username'] or '',
             'Pembayaran tagihan periode {} via kolektor {}'.format(t['periode'], kolektor or '-'))
        )
        berhasil.append(tid)
        total += int(t['nominal'] or 0)

    # Restore isolir untuk semua username yang berhasil dibayar
    usernames_bayar = list({conn.execute('SELECT username FROM tagihan WHERE id=?',(tid,)).fetchone()['username']
                            for tid in berhasil if conn.execute('SELECT username FROM tagihan WHERE id=?',(tid,)).fetchone()})
    for uname in usernames_bayar:
        _restore_isolir_if_needed(conn, uname)

    conn.commit(); conn.close()
    return jsonify({
        'status': 'success',
        'message': '{} tagihan lunas, total Rp{:,}'.format(len(berhasil), total).replace(',', '.'),
        'berhasil': berhasil, 'gagal': gagal, 'total': total,
    }), 200


# ── GET dashboard stats untuk kolektor ────────────────────────
@tagihan_bp.route('/kolektor-stats', methods=['GET'])
def kolektor_stats():
    """Statistik dashboard kolektor: jumlah belum bayar bulan ini, tunggakan, dll."""
    from datetime import date as _date
    periode_ini = _date.today().strftime('%Y-%m')
    kolektor_username = (g.current_user or {}).get('username', '')

    conn = get_db()
    # Ambil semua pelanggan yang ditugaskan ke kolektor ini
    pels = conn.execute(
        "SELECT username FROM pelanggan WHERE kolektor=? AND aktif=1",
        (kolektor_username,)
    ).fetchall()
    usernames = [r['username'] for r in pels]

    if not usernames:
        # Tetap hitung setoran hari ini meski tidak ada pelanggan ditugaskan
        today = _date.today().isoformat()
        r4 = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(nominal),0) FROM tagihan WHERE kolektor=? AND status='lunas' AND DATE(paid_at)=?",
            (kolektor_username, today)
        ).fetchone()
        conn.close()
        return jsonify({'status': 'success',
                        'total_pelanggan': 0, 'belum_bayar': 0,
                        'tunggakan': 0, 'lunas_bulan_ini': 0,
                        'nominal_belum': 0, 'nominal_tunggakan': 0,
                        'setoran_hari_ini': r4[0] or 0,
                        'nominal_setoran_hari_ini': r4[1] or 0,
                        'periode_ini': periode_ini}), 200

    ph = ','.join('?' * len(usernames))

    # Tagihan belum bayar bulan ini
    r1 = conn.execute(
        f"SELECT COUNT(*), COALESCE(SUM(nominal),0) FROM tagihan WHERE username IN ({ph}) AND periode=? AND status='belum_bayar'",
        usernames + [periode_ini]
    ).fetchone()

    # Tagihan belum bayar bulan sebelumnya (tunggakan)
    r2 = conn.execute(
        f"SELECT COUNT(*), COALESCE(SUM(nominal),0) FROM tagihan WHERE username IN ({ph}) AND periode<? AND status='belum_bayar'",
        usernames + [periode_ini]
    ).fetchone()

    # Lunas bulan ini
    r3 = conn.execute(
        f"SELECT COUNT(*) FROM tagihan WHERE username IN ({ph}) AND periode=? AND status='lunas'",
        usernames + [periode_ini]
    ).fetchone()

    # Setoran hari ini (tagihan yang dibayar kolektor ini hari ini)
    today = _date.today().isoformat()
    r4 = conn.execute(
        f"SELECT COUNT(*), COALESCE(SUM(nominal),0) FROM tagihan WHERE kolektor=? AND status='lunas' AND DATE(paid_at)=?",
        (kolektor_username, today)
    ).fetchone()

    conn.close()
    return jsonify({
        'status': 'success',
        'total_pelanggan': len(usernames),
        'belum_bayar': r1[0] or 0,
        'nominal_belum': r1[1] or 0,
        'tunggakan': r2[0] or 0,
        'nominal_tunggakan': r2[1] or 0,
        'lunas_bulan_ini': r3[0] or 0,
        'setoran_hari_ini': r4[0] or 0,
        'nominal_setoran_hari_ini': r4[1] or 0,
        'periode_ini': periode_ini,
    }), 200
