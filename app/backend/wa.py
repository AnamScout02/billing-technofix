"""
wa.py — TechnoFix · Blueprint Notifikasi WhatsApp
=================================================
Kirim pengingat tagihan & notifikasi ke pelanggan lewat WA
gateway (Fonnte / Wablas). MODE MOCK: bila gateway belum
diaktifkan, pesan tidak benar-benar dikirim tetapi tetap
dicatat di wa_log (status='mock') agar alur bisa dites.

Config (app_settings KV, per-owner):
  wa_provider  = 'fonnte' | 'wablas'
  wa_url       = base URL gateway (wablas) / kosong (fonnte default)
  wa_token     = token API
  wa_enabled   = '1' | '0'
  wa_auto_enabled = '1' | '0'  → pengingat tagihan otomatis (worker background)
  wa_tpl_reminder = template pesan (placeholder {nama}{nominal}{periode}{jatuh_tempo}{isp})

Pengingat otomatis (lihat run_auto_reminders / _run_owner_auto_reminder):
  Dijalankan dari worker background (pola _start_olt_sync_worker di input.py).
  Untuk tiap tagihan belum_bayar dengan jatuh_tempo H-3, H (hari-H), atau H+3
  (telat), kirim 1x pengingat — dicatat di wa_reminder_log (UNIQUE tagihan_id+
  tipe) supaya tidak dobel walau worker jalan berkali-kali. Hanya aktif kalau
  paket owner punya fitur 'broadcast', gateway live (enabled+token terisi),
  DAN wa_auto_enabled='1'.

Daftarkan di input.py:
  from wa import wa_bp
  app.register_blueprint(wa_bp, url_prefix='/api/wa')

Endpoint (prefix /api/wa):
  GET  /config                 → config gateway (token disamarkan)
  POST /config                 → simpan config + template
  POST /send {to,message,nama} → kirim 1 pesan (uji)
  POST /reminder {periode}     → blast pengingat ke tagihan belum_bayar
  GET  /log?limit=             → riwayat kirim
"""

import json
import logging
import sqlite3
import urllib.request
import urllib.parse
from datetime import date, datetime, timedelta
from flask import Blueprint, request, jsonify, g
from utils import get_db, get_network_row

log = logging.getLogger(__name__)
wa_bp = Blueprint('wa', __name__)

WA_TIMEOUT = 8
DEFAULT_TPL = ('Halo {nama}, tagihan internet Anda periode {periode} sebesar '
               'Rp{nominal} jatuh tempo {jatuh_tempo}. Mohon segera melakukan '
               'pembayaran. Terima kasih - {isp}')


@wa_bp.before_request
def _wa_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    p = request.path.rstrip('/')
    # Kirim pesan/blast WA pakai gateway & kuota milik ISP — jangan biarkan
    # peran terbatas (mis. kolektor, yang cuma butuh 'pelanggan'+'bayar')
    # memakainya untuk kirim pesan bebas. Minimal 'pelanggan_manage'.
    perm = 'keuangan' if p.endswith('/config') else 'pelanggan_manage'
    return guard_request(perm=perm)


# ── Config ─────────────────────────────────────────────────────
_KEYS = ('wa_provider', 'wa_url', 'wa_token', 'wa_enabled', 'wa_auto_enabled', 'wa_tpl_reminder')


def _load_config(conn):
    rows = conn.execute(
        "SELECT key, value FROM app_settings WHERE key IN (%s)" % ','.join('?' * len(_KEYS)),
        _KEYS,
    ).fetchall()
    d = {r['key']: r['value'] for r in rows}
    return {
        'provider':     d.get('wa_provider') or 'fonnte',
        'url':          (d.get('wa_url') or '').rstrip('/'),
        'token':        d.get('wa_token') or '',
        'enabled':      (d.get('wa_enabled') or '0') == '1',
        'auto_enabled': (d.get('wa_auto_enabled') or '0') == '1',
        'template':     d.get('wa_tpl_reminder') or DEFAULT_TPL,
    }


def _save_setting(conn, key, value):
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (key, value, datetime.now().isoformat()),
    )


@wa_bp.route('/config', methods=['GET'])
def get_config():
    conn = get_db(); cfg = _load_config(conn); conn.close()
    return jsonify({'status': 'success', 'config': {
        'provider': cfg['provider'], 'url': cfg['url'],
        'enabled': cfg['enabled'], 'has_token': bool(cfg['token']),
        'auto_enabled': cfg['auto_enabled'],
        'template': cfg['template'],
    }}), 200


@wa_bp.route('/config', methods=['POST'])
def save_config():
    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'fonnte').strip()
    if provider not in ('fonnte', 'wablas'):
        return jsonify({'status': 'error', 'message': 'Provider tidak didukung'}), 400
    conn = get_db()
    _save_setting(conn, 'wa_provider', provider)
    _save_setting(conn, 'wa_url', (data.get('url') or '').strip().rstrip('/'))
    if 'token' in data and data.get('token') is not None and data.get('token') != '':
        _save_setting(conn, 'wa_token', str(data.get('token')))
    _save_setting(conn, 'wa_enabled', '1' if data.get('enabled') else '0')
    if 'auto_enabled' in data:
        _save_setting(conn, 'wa_auto_enabled', '1' if data.get('auto_enabled') else '0')
    if data.get('template'):
        _save_setting(conn, 'wa_tpl_reminder', str(data.get('template')))
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Pengaturan WhatsApp tersimpan'}), 200


# ── Pengiriman ─────────────────────────────────────────────────
def _normalize_hp(hp):
    hp = ''.join(ch for ch in str(hp or '') if ch.isdigit() or ch == '+')
    hp = hp.lstrip('+')
    if hp.startswith('0'):
        hp = '62' + hp[1:]
    return hp


def _send_via_gateway(cfg, to, message):
    """Kirim ke gateway. Return (ok, keterangan). Raise tidak ditangkap di sini."""
    if cfg['provider'] == 'wablas':
        url = (cfg['url'] or 'https://wablas.com') + '/api/send-message'
        body = urllib.parse.urlencode({'phone': to, 'message': message}).encode()
        headers = {'Authorization': cfg['token'], 'Content-Type': 'application/x-www-form-urlencoded'}
    else:  # fonnte
        url = cfg['url'] or 'https://api.fonnte.com/send'
        body = urllib.parse.urlencode({'target': to, 'message': message}).encode()
        headers = {'Authorization': cfg['token'], 'Content-Type': 'application/x-www-form-urlencoded'}
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=WA_TIMEOUT) as resp:
        raw = resp.read().decode('utf-8', 'ignore')
    return True, raw[:300]


def _log(conn, tujuan, nama, pesan, status, provider, ket=''):
    conn.execute(
        '''INSERT INTO wa_log (tujuan, nama, pesan, status, provider, keterangan)
           VALUES (?, ?, ?, ?, ?, ?)''',
        (tujuan, nama, pesan, status, provider, ket),
    )


def _do_send(conn, cfg, to, message, nama=''):
    to = _normalize_hp(to)
    if not to:
        _log(conn, to, nama, message, 'gagal', cfg['provider'], 'Nomor HP kosong/invalid')
        return False, 'Nomor HP tidak valid'
    if not (cfg['enabled'] and cfg['token']):
        _log(conn, to, nama, message, 'mock', cfg['provider'], 'Gateway nonaktif (mock)')
        return True, 'mock'
    try:
        ok, ket = _send_via_gateway(cfg, to, message)
        _log(conn, to, nama, message, 'terkirim' if ok else 'gagal', cfg['provider'], ket)
        return ok, ket
    except Exception as e:
        _log(conn, to, nama, message, 'gagal', cfg['provider'], str(e)[:200])
        return False, str(e)


@wa_bp.route('/send', methods=['POST'])
def send_one():
    data = request.get_json(silent=True) or {}
    to = (data.get('to') or '').strip()
    message = (data.get('message') or '').strip()
    nama = (data.get('nama') or '').strip()
    if not to or not message:
        return jsonify({'status': 'error', 'message': 'Nomor & pesan wajib diisi'}), 400
    conn = get_db(); cfg = _load_config(conn)
    ok, ket = _do_send(conn, cfg, to, message, nama)
    conn.commit(); conn.close()
    mock = (ket == 'mock')
    return jsonify({'status': 'success' if ok else 'error',
                    'message': ('Pesan dicatat (mode mock — gateway nonaktif)' if mock
                                else ('Pesan terkirim' if ok else 'Gagal kirim: ' + ket)),
                    'mock': mock}), (200 if ok else 502)


def _render_tpl(tpl, isp, nama, nominal, periode, jatuh_tempo):
    def rp(n):
        return '{:,}'.format(int(n or 0)).replace(',', '.')
    return (tpl.replace('{nama}', nama or 'Pelanggan')
               .replace('{nominal}', rp(nominal))
               .replace('{periode}', periode or '')
               .replace('{jatuh_tempo}', jatuh_tempo or '-')
               .replace('{isp}', isp or 'TechnoFix'))


@wa_bp.route('/reminder', methods=['POST'])
def blast_reminder():
    data = request.get_json(silent=True) or {}
    periode = (data.get('periode') or date.today().strftime('%Y-%m')).strip()

    isp = ''
    try:
        row = get_network_row(g.current_user['network_id'])
        isp = (row['isp_name'] if row else '') or 'TechnoFix'
    except Exception:
        isp = 'TechnoFix'

    conn = get_db(); cfg = _load_config(conn)
    # gabung tagihan belum lunas (termasuk piutang yg sudah disetujui tapi
    # belum dibayar) dengan hp pelanggan
    rows = conn.execute(
        '''SELECT t.nama, t.username, t.nominal, t.periode, t.jatuh_tempo,
                  COALESCE(p.hp,'') AS hp
           FROM tagihan t
           LEFT JOIN pelanggan p ON p.username = t.username
           WHERE t.status IN ('belum_bayar','piutang') AND t.periode=?''',
        (periode,)
    ).fetchall()

    terkirim = gagal = mock = tanpa_hp = 0
    for r in rows:
        if not (r['hp'] or '').strip():
            tanpa_hp += 1
            continue
        msg = _render_tpl(cfg['template'], isp, r['nama'] or r['username'],
                          r['nominal'], r['periode'], r['jatuh_tempo'])
        ok, ket = _do_send(conn, cfg, r['hp'], msg, r['nama'] or r['username'])
        if ket == 'mock':
            mock += 1
        elif ok:
            terkirim += 1
        else:
            gagal += 1
    conn.commit(); conn.close()

    total = len(rows)
    if not (cfg['enabled'] and cfg['token']):
        pesan = 'Mode mock: {} pesan dicatat (gateway nonaktif). {} tanpa HP.'.format(mock, tanpa_hp)
    else:
        pesan = '{} terkirim, {} gagal, {} tanpa HP (dari {} tagihan).'.format(terkirim, gagal, tanpa_hp, total)
    return jsonify({'status': 'success', 'message': pesan,
                    'terkirim': terkirim, 'gagal': gagal, 'mock': mock,
                    'tanpa_hp': tanpa_hp, 'total': total}), 200


@wa_bp.route('/log', methods=['GET'])
def get_log():
    try:
        limit = min(int(request.args.get('limit', 100)), 500)
    except ValueError:
        limit = 100
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM wa_log ORDER BY id DESC LIMIT ?', (limit,)
    ).fetchall()
    conn.close()
    items = [{
        'id': r['id'], 'tujuan': r['tujuan'], 'nama': r['nama'],
        'pesan': r['pesan'], 'status': r['status'], 'provider': r['provider'],
        'keterangan': r['keterangan'], 'created_at': r['created_at'],
    } for r in rows]
    return jsonify({'status': 'success', 'log': items}), 200


# ── Pengingat otomatis (worker background) ─────────────────────
# Selisih hari (jatuh_tempo - hari ini) → tipe pengingat. Tiap kombinasi
# tagihan_id+tipe hanya dikirim sekali (dijaga UNIQUE di wa_reminder_log).
_AUTO_TIPE = {3: 'h3', 0: 'jatuh_tempo', -3: 'telat'}


def _run_owner_auto_reminder(network_id):
    """Kirim pengingat otomatis untuk satu owner. Aman dipanggil berulang —
    wa_reminder_log mencegah pengingat dobel untuk tagihan+tipe yang sama."""
    from packages import package_has_feature

    net = get_network_row(network_id)
    if not net or not package_has_feature(net['paket'], 'broadcast'):
        return

    from utils import get_owner_db, get_master_db

    conn = get_owner_db(network_id)
    try:
        cfg = _load_config(conn)
        if not (cfg['enabled'] and cfg['token'] and cfg['auto_enabled']):
            return

        isp = 'TechnoFix'
        try:
            master = get_master_db()
            r = master.execute('SELECT isp_name FROM networks WHERE network_id=?', (network_id,)).fetchone()
            master.close()
            isp = (r['isp_name'] if r else '') or 'TechnoFix'
        except Exception:
            pass

        today = date.today()
        rows = conn.execute(
            '''SELECT t.id, t.nama, t.username, t.nominal, t.periode, t.jatuh_tempo,
                      COALESCE(p.hp,'') AS hp
               FROM tagihan t
               LEFT JOIN pelanggan p ON p.username = t.username
               WHERE t.status IN ('belum_bayar','piutang') AND t.jatuh_tempo <> ''''',
        ).fetchall()

        for r in rows:
            try:
                jatuh = datetime.strptime(r['jatuh_tempo'][:10], '%Y-%m-%d').date()
            except (ValueError, TypeError):
                continue
            tipe = _AUTO_TIPE.get((jatuh - today).days)
            if not tipe or not (r['hp'] or '').strip():
                continue
            try:
                conn.execute(
                    'INSERT INTO wa_reminder_log (tagihan_id, tipe) VALUES (?, ?)',
                    (r['id'], tipe))
            except sqlite3.IntegrityError:
                continue  # sudah pernah dikirim untuk tagihan+tipe ini

            msg = _render_tpl(cfg['template'], isp, r['nama'] or r['username'],
                              r['nominal'], r['periode'], r['jatuh_tempo'])
            _do_send(conn, cfg, r['hp'], msg, r['nama'] or r['username'])
            conn.commit()
    finally:
        conn.close()


def run_auto_reminders():
    """Iterasi semua owner & kirim pengingat otomatis yang jatuh hari ini.
    Dipanggil dari worker background (lihat _start_wa_reminder_worker di input.py)."""
    from utils import get_master_db
    master = get_master_db()
    try:
        owners = master.execute('SELECT network_id FROM networks').fetchall()
    finally:
        master.close()

    for row in owners:
        nid = row['network_id']
        try:
            _run_owner_auto_reminder(nid)
        except Exception as e:
            log.error('[WA Auto Reminder] %s: %s', nid[:8], e)
