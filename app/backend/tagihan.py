"""
tagihan.py — TechnoFix-Bill · Blueprint Tagihan Bulanan
====================================================
Tagihan langganan pelanggan per bulan. Nominal diambil dari
profil_harga (harga profil PPPoE pelanggan). Saat dibayar →
catat ke tabel keuangan (pemasukan).

Endpoint (prefix /api/tagihan, di input.py):
  GET  /api/tagihan?periode=YYYY-MM&status=   → daftar + ringkasan
  POST /api/tagihan/generate {periode}        → buat tagihan pelanggan aktif
  POST /api/tagihan/<id>/bayar {metode}       → tandai lunas + catat keuangan
"""

import calendar
import logging
from datetime import date
from flask import Blueprint, request, jsonify, g
from utils import get_db, catat_aktivitas

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
        perm = 'keuangan'
    elif p.endswith('/bayar') or p.endswith('/bayar-multi'):
        perm = 'bayar'
    elif p.endswith('/piutang'):
        perm = 'keuangan'      # setujui piutang = aksi billing (owner/admin)
    elif p.endswith('/auto-isolir/config'):
        perm = 'keuangan'      # konfigurasi isolir otomatis = setting billing (owner/admin)
    elif p.endswith('/export'):
        perm = 'keuangan'      # ekspor laporan tagihan = data finansial
    elif request.method == 'DELETE':
        perm = 'keuangan'
    elif p.endswith('/api/tagihan'):
        perm = 'keuangan'      # daftar tagihan + nominal seluruh pelanggan = data finansial
    else:
        perm = 'pelanggan'
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
    if status in ('belum_bayar', 'lunas', 'piutang'):
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
             COALESCE(SUM(CASE WHEN status='lunas' THEN nominal ELSE 0 END),0) AS nominal_lunas,
             COALESCE(SUM(CASE WHEN status='piutang' THEN 1 ELSE 0 END),0) AS piutang,
             COALESCE(SUM(CASE WHEN status='piutang' THEN nominal ELSE 0 END),0) AS nominal_piutang
           FROM tagihan WHERE periode = ?''',
        (periode,)
    ).fetchone()
    conn.close()

    def _safe(r, k): return r[k] if k in r.keys() else ''

    items = [{
        'id': r['id'], 'pelanggan_id': r['pelanggan_id'],
        'username': r['username'], 'nama': r['nama'] or r['username'],
        'profil': r['profil'], 'periode': r['periode'],
        'nominal': r['nominal'], 'status': r['status'],
        'jatuh_tempo': r['jatuh_tempo'] or '', 'paid_at': r['paid_at'] or '',
        'metode': r['metode'] or '',
        'piutang_at': _safe(r, 'piutang_at'), 'piutang_oleh': _safe(r, 'piutang_oleh'),
    } for r in rows]

    total  = summ['total'] or 0
    lunas  = summ['lunas'] or 0
    piutang = summ['piutang'] or 0
    return jsonify({
        'status': 'success',
        'periode': periode,
        'tagihan': items,
        'ringkasan': {
            'total':           total,
            'lunas':           lunas,
            'piutang':         piutang,
            'belum':           total - lunas - piutang,
            'nominal_total':   summ['nominal_total'] or 0,
            'nominal_lunas':   summ['nominal_lunas'] or 0,
            'nominal_piutang': summ['nominal_piutang'] or 0,
            'nominal_belum':   (summ['nominal_total'] or 0) - (summ['nominal_lunas'] or 0),
        },
    }), 200


# ── GET ekspor tagihan (untuk laporan PDF/cetak) ───────────────
@tagihan_bp.route('/export', methods=['GET'])
def export_tagihan():
    """
    Data tagihan satu periode (+ profil ISP) untuk laporan cetak/PDF.
    Mengikuti filter yang sama dengan GET /api/tagihan (periode, status).
    """
    periode = (request.args.get('periode') or _periode_now()).strip()
    status  = (request.args.get('status') or '').strip()

    conn = get_db()
    q = 'SELECT * FROM tagihan WHERE periode = ?'
    params = [periode]
    if status in ('belum_bayar', 'lunas', 'piutang'):
        q += ' AND status = ?'
        params.append(status)
    q += ' ORDER BY status ASC, nama ASC, username ASC'
    rows = conn.execute(q, params).fetchall()

    from utils import get_isp_profile
    profil = get_isp_profile(conn, g.network_id)
    conn.close()

    items = [{
        'username': r['username'], 'nama': r['nama'] or r['username'],
        'profil': r['profil'], 'periode': r['periode'],
        'nominal': r['nominal'], 'status': r['status'],
        'jatuh_tempo': r['jatuh_tempo'] or '', 'paid_at': r['paid_at'] or '',
        'metode': r['metode'] or '',
    } for r in rows]

    total_nominal = sum(it['nominal'] for it in items)
    total_lunas   = sum(it['nominal'] for it in items if it['status'] == 'lunas')

    return jsonify({
        'status': 'success',
        'isp_name': profil['isp_name'],
        'isp_logo': profil['isp_logo'],
        'periode': periode,
        'rows': items,
        'totals': {
            'nominal_total': total_nominal,
            'nominal_lunas': total_lunas,
            'nominal_belum': total_nominal - total_lunas,
        },
    }), 200


# ── POST generate tagihan untuk pelanggan aktif ────────────────
@tagihan_bp.route('/generate', methods=['POST'])
def generate_tagihan():
    data    = request.get_json(silent=True) or {}
    periode = (data.get('periode') or _periode_now()).strip()
    jt_hari_raw = data.get('jatuh_tempo_hari')
    try:
        jt_hari = int(jt_hari_raw) if jt_hari_raw not in (None, '', 0, '0') else None
    except (TypeError, ValueError):
        jt_hari = None
    if not jt_hari or jt_hari < 1 or jt_hari > 31:
        return jsonify({'status': 'error', 'message': 'Tanggal jatuh tempo harus diisi (1-31)'}), 400
    # Clamp ke hari terakhir bulan periode itu — supaya tanggal 29/30/31
    # tidak jadi invalid utk Februari/bulan 30-hari (mis. 2026-02-31 -> 2026-02-28).
    try:
        tahun, bulan = (int(x) for x in periode.split('-'))
        hari_terakhir = calendar.monthrange(tahun, bulan)[1]
    except (ValueError, IndexError):
        return jsonify({'status': 'error', 'message': 'Periode tidak valid'}), 400
    jt_hari_efektif = min(jt_hari, hari_terakhir)
    jatuh_tempo = '{}-{:02d}'.format(periode, jt_hari_efektif)

    conn = get_db()
    # pelanggan aktif, kecuali yang is_prioritas (bebas tagihan)
    try:
        pels = conn.execute(
            "SELECT id, username, nama, profil, device_id FROM pelanggan WHERE aktif = 1 AND (is_prioritas = 0 OR is_prioritas IS NULL)"
        ).fetchall()
    except Exception:
        pels = conn.execute(
            "SELECT id, username, nama, profil, device_id FROM pelanggan WHERE aktif = 1"
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
            'SELECT id, nama, profil, profil_sebelum_isolir, device_id FROM pelanggan WHERE username = ?',
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
        from utils import get_db as _get_db, status_secret_comment

        # Cari device
        _conn = _get_db()
        dev_row = _conn.execute('SELECT * FROM devices WHERE id = ?', (row['device_id'],)).fetchone()
        _conn.close()
        if not dev_row:
            return

        device   = dict(dev_row)
        nama_asli = row['nama'] or username
        with MikroTikClient(device) as mt:
            mt.edit_secret(username, {
                'profile': profil_restore,
                'disabled': 'no',
                'comment': status_secret_comment(nama_asli, ''),
            })
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


# ── Worker: auto-isolir pelanggan menunggak (tagihan lewat jatuh tempo) ──

def _is_auto_isolir_enabled(conn):
    """Baca toggle 'auto_isolir_enabled' dari app_settings owner. Default: nonaktif —
    fitur ini memutus koneksi pelanggan otomatis, jadi harus diaktifkan sengaja oleh owner."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'auto_isolir_enabled'").fetchone()
    return (row['value'] if row else '0') == '1'


@tagihan_bp.route('/auto-isolir/config', methods=['GET'])
def get_auto_isolir_config():
    conn = get_db()
    enabled = _is_auto_isolir_enabled(conn)
    conn.close()
    return jsonify({'status': 'success', 'enabled': enabled}), 200


@tagihan_bp.route('/auto-isolir/config', methods=['POST'])
def save_auto_isolir_config():
    data = request.get_json(silent=True) or {}
    conn = get_db()
    conn.execute(
        '''INSERT INTO app_settings (key, value) VALUES ('auto_isolir_enabled', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP''',
        ('1' if data.get('enabled') else '0',)
    )
    conn.commit(); conn.close()
    return jsonify({
        'status': 'success',
        'message': 'Isolir otomatis diaktifkan' if data.get('enabled') else 'Isolir otomatis dinonaktifkan',
    }), 200


def _auto_isolir_overdue(network_id):
    """
    Isolir otomatis pelanggan yang tagihannya sudah lewat jatuh tempo & belum
    dibayar. Dipanggil dari worker background (lihat _start_auto_isolir_worker
    di input.py). Aman dipanggil berulang — pelanggan yang profilnya sudah
    mengandung 'isolir/blokir/suspend' dilewati.
    """
    import sys, os
    sys.path.insert(0, os.path.dirname(__file__))
    from utils import get_owner_db, status_secret_comment
    from mikrotik import MikroTikClient, MikroTikError
    from api import _resolve_isolir_profile

    conn = get_owner_db(network_id)
    try:
        if not _is_auto_isolir_enabled(conn):
            return

        today = date.today().isoformat()
        rows = conn.execute(
            '''SELECT t.id AS tagihan_id, t.username, p.id AS pelanggan_id, p.nama,
                      p.profil, p.device_id, p.is_prioritas
               FROM tagihan t
               JOIN pelanggan p ON p.username = t.username
               WHERE t.status = 'belum_bayar' AND p.aktif = 1
                 AND (p.is_prioritas = 0 OR p.is_prioritas IS NULL)
                 AND t.jatuh_tempo <> '' AND t.jatuh_tempo < ?''',
            (today,)
        ).fetchall()

        for r in rows:
            username = r['username']
            profil_now = (r['profil'] or '').lower()
            if not username or 'isolir' in profil_now or 'blokir' in profil_now or 'suspend' in profil_now:
                continue  # tidak ada username atau sudah dalam status isolir

            dev_row = conn.execute('SELECT * FROM devices WHERE id = ?', (r['device_id'],)).fetchone()
            if not dev_row:
                continue

            try:
                device = dict(dev_row)
                with MikroTikClient(device) as mt:
                    profil_isolir = _resolve_isolir_profile(mt)
                    if profil_now == profil_isolir.lower():
                        continue

                    nama_asli = r['nama'] or username
                    mt.edit_secret(username, {
                        'profile': profil_isolir,
                        'comment': status_secret_comment(nama_asli, 'isolir'),
                    })
                    try:
                        from librouteros.query import Key
                        api_ros = mt._get_api()
                        active_path = api_ros.path('/ppp/active')
                        active = next(
                            (x for x in active_path.select(Key('.id'), Key('name'))
                             if x.get('name') == username),
                            None
                        )
                        if active:
                            active_path.remove(active['.id'])
                    except Exception:
                        pass

                conn.execute(
                    'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = ? WHERE id = ?',
                    (profil_isolir, r['profil'] or 'default', r['pelanggan_id'])
                )
                catat_aktivitas('pelanggan', 'isolir', target=username,
                                pesan=f'Isolir otomatis: {username} (tagihan #{r["tagihan_id"]} lewat jatuh tempo)',
                                aktor='system', conn=conn)
                conn.commit()
                log.info('[Auto-Isolir] %s diisolir otomatis (tagihan #%s lewat jatuh tempo %s)',
                         username, r['tagihan_id'], today)
            except MikroTikError as e:
                log.warning('[Auto-Isolir] Gagal isolir %s: %s', username, e)
            except Exception as e:
                log.warning('[Auto-Isolir] Error tak terduga saat isolir %s: %s', username, e)
    finally:
        conn.close()


def run_auto_isolir():
    """Iterasi semua owner & isolir otomatis pelanggan menunggak yang lewat
    jatuh tempo. Dipanggil dari worker background (lihat _start_auto_isolir_worker
    di input.py)."""
    from utils import get_master_db
    master = get_master_db()
    try:
        owners = master.execute('SELECT network_id FROM networks').fetchall()
    finally:
        master.close()

    for row in owners:
        nid = row['network_id']
        try:
            _auto_isolir_overdue(nid)
        except Exception as e:
            log.error('[Auto-Isolir] %s: %s', nid[:8], e)


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
    # Jika piutang yang dibayar, catat ke keuangan dengan keterangan piutang
    keterangan_prefix = 'Pelunasan piutang' if t['status'] == 'piutang' else 'Tagihan'
    conn.execute(
        '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
           VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
        (date.today().isoformat(),
         '{} {} - {}'.format(keterangan_prefix, t['periode'], t['username'] or t['nama']),
         t['nominal'], metode, t['username'] or '',
         'Pembayaran tagihan periode {}'.format(t['periode']))
    )
    # Restore profil jika sedang diisolir (untuk belum_bayar yang baru dibayar)
    if t['status'] == 'belum_bayar':
        _restore_isolir_if_needed(conn, t['username'] or '')
    conn.commit(); conn.close()
    log.info('[Tagihan] Bayar #%s (%s) %s', tagihan_id, t['username'], t['nominal'])

    catat_aktivitas('tagihan', 'lunas', target=t['username'] or '',
                    pesan='{} {} - {}'.format(keterangan_prefix, t['periode'], t['username'] or t['nama']),
                    nominal=t['nominal'])

    return jsonify({'status': 'success', 'message': 'Tagihan lunas'}), 200


# ── POST setujui piutang → re-aktivasi MikroTik ───────────────
@tagihan_bp.route('/<int:tagihan_id>/piutang', methods=['POST'])
def setujui_piutang(tagihan_id):
    """
    Owner setujui piutang:
      1. Ubah status tagihan → 'piutang'
      2. Restore profil MikroTik ke sebelum isolir
      3. Kick active connection (reconnect dengan profil baru)
      4. Set comment PPP Secret: 'Nama - PIUTANG (diaktifkan)'
      5. Update DB pelanggan (profil kembali normal)
    """
    from datetime import datetime
    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tagihan_id,)).fetchone()
    if not t:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    if t['status'] == 'lunas':
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tagihan sudah lunas'}), 400
    if t['status'] == 'piutang':
        conn.close()
        return jsonify({'status': 'error', 'message': 'Tagihan sudah berstatus piutang'}), 400

    username = t['username'] or ''
    now = datetime.now().isoformat()
    oleh = (g.current_user or {}).get('username', '') if hasattr(g, 'current_user') else ''

    # Cari data pelanggan
    row = conn.execute(
        'SELECT id, nama, profil, profil_sebelum_isolir, device_id FROM pelanggan WHERE username = ?',
        (username,)
    ).fetchone()

    mt_ok = False
    profil_restore = None

    if row:
        profil_now = (row['profil'] or '').lower()
        profil_sebelum = row['profil_sebelum_isolir'] or ''
        # Tentukan profil restore — kalau bukan isolir, pakai profil saat ini
        sedang_isolir = any(k in profil_now for k in ('isolir', 'blokir', 'suspend'))
        if sedang_isolir and profil_sebelum and 'isolir' not in profil_sebelum.lower():
            profil_restore = profil_sebelum
        elif not sedang_isolir:
            profil_restore = row['profil']  # sudah normal, tidak perlu ganti

        if profil_restore:
            try:
                import sys, os
                sys.path.insert(0, os.path.dirname(__file__))
                from mikrotik import MikroTikClient, MikroTikError
                from utils import status_secret_comment

                dev_row = conn.execute('SELECT * FROM devices WHERE id = ?', (row['device_id'],)).fetchone()
                if dev_row:
                    device = dict(dev_row)
                    nama_asli = row['nama'] or username
                    with MikroTikClient(device) as mt:
                        mt.edit_secret(username, {
                            'profile': profil_restore,
                            'disabled': 'no',
                            'comment': status_secret_comment(nama_asli, 'piutang'),
                        })
                        # Kick active connection → reconnect dengan profil baru
                        try:
                            from librouteros.query import Key
                            api = mt._get_api()
                            active_path = api.path('/ppp/active')
                            active = next(
                                (r for r in active_path.select(Key('.id'), Key('name'))
                                 if r.get('name') == username),
                                None
                            )
                            if active:
                                active_path.remove(active['.id'])
                        except Exception:
                            pass
                    mt_ok = True
                    # Update profil di DB
                    conn.execute(
                        'UPDATE pelanggan SET profil = ?, profil_sebelum_isolir = NULL WHERE username = ?',
                        (profil_restore, username)
                    )
                    log.info('[Piutang] %s diaktifkan ulang: %s -> %s', username, row['profil'], profil_restore)
            except Exception as e:
                log.warning('[Piutang] Gagal restore MikroTik %s: %s', username, e)

    # Tandai tagihan sebagai piutang
    conn.execute(
        "UPDATE tagihan SET status='piutang', piutang_at=?, piutang_oleh=? WHERE id=?",
        (now, oleh, tagihan_id)
    )
    conn.commit()
    conn.close()

    catat_aktivitas('tagihan', 'piutang', target=username,
                    pesan=f'Piutang disetujui: {username} ({t["periode"]})',
                    nominal=t['nominal'])

    msg = 'Piutang disetujui'
    if mt_ok:
        msg += ' & internet diaktifkan kembali'
    elif profil_restore is None and row:
        msg += ' (profil tidak perlu diganti)'
    else:
        msg += ' (catatan: MikroTik tidak terhubung, aktifkan manual)'

    return jsonify({'status': 'success', 'message': msg, 'mikrotik': mt_ok}), 200


# ── DELETE hapus tagihan ───────────────────────────────────────
@tagihan_bp.route('/<int:tagihan_id>', methods=['DELETE'])
def hapus_tagihan(tagihan_id):
    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tagihan_id,)).fetchone()
    if not t:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    conn.execute('DELETE FROM tagihan WHERE id = ?', (tagihan_id,))
    conn.commit(); conn.close()
    log.info('[Tagihan] Hapus #%s (%s) periode %s', tagihan_id, t['username'], t['periode'])
    return jsonify({'status': 'success', 'message': 'Tagihan berhasil dihapus'}), 200


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
    usernames_bayar = set()

    now = datetime.now().isoformat()
    for tid in ids:
        t = conn.execute('SELECT * FROM tagihan WHERE id = ?', (tid,)).fetchone()
        if not t or t['status'] == 'lunas':
            gagal.append(tid); continue
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
        # Restore isolir hanya utk yg sebelumnya 'belum_bayar' (piutang sudah direstore saat disetujui)
        if t['status'] != 'piutang' and t['username']:
            usernames_bayar.add(t['username'])

    for uname in usernames_bayar:
        _restore_isolir_if_needed(conn, uname)

    conn.commit(); conn.close()

    if berhasil:
        catat_aktivitas('tagihan', 'lunas',
                        pesan='{} tagihan lunas via kolektor {} — total Rp{:,}'.format(
                            len(berhasil), kolektor or '-', total).replace(',', '.'),
                        nominal=total)

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
