"""
payment.py — TechnoFix-Bill · Blueprint Payment Gateway
==================================================
Buat link pembayaran online untuk tagihan (Midtrans / Xendit).
MODE MANUAL: bila gateway belum diaktifkan, dibuat order_id +
payment_url dummy dan tombol "Konfirmasi Bayar Manual" untuk
menutup alur tanpa akun merchant.

Config (app_settings KV, per-owner):
  pay_provider   = 'midtrans' | 'xendit'
  pay_server_key = server/secret key
  pay_client_key = client key (midtrans)
  pay_mode       = 'sandbox' | 'production'
  pay_enabled    = '1' | '0'

Daftarkan di input.py:
  from payment import payment_bp
  app.register_blueprint(payment_bp, url_prefix='/api/payment')

Endpoint (prefix /api/payment):
  GET  /config                    → config gateway (key disamarkan)
  POST /config                    → simpan config
  POST /create {tagihan_id}       → buat transaksi + payment_url
  GET  /transactions?periode=     → daftar transaksi pembayaran
  POST /mark-paid {order_id}       → konfirmasi bayar manual
  POST /webhook?network_id=       → callback gateway (real)
"""

import json
import base64
import hashlib
import hmac
import logging
import urllib.request
import urllib.parse
from datetime import date, datetime
from flask import Blueprint, request, jsonify, g
from utils import get_db, get_owner_db, get_master_db, catat_aktivitas

log = logging.getLogger(__name__)
payment_bp = Blueprint('payment', __name__)

PAY_TIMEOUT = 8


@payment_bp.before_request
def _pay_guard():
    if request.method == 'OPTIONS':
        return
    # webhook publik (dipanggil server gateway) — tanpa guard login
    if request.path.rstrip('/').endswith('/webhook'):
        return
    from auth import guard_request
    p = request.path.rstrip('/')
    # Ubah rekening bank tujuan pembayaran = aksi finansial sensitif —
    # wajib 'keuangan' (kolektor punya 'bayar' tapi TIDAK boleh ganti
    # rekening tujuan transfer pelanggan). Lihat rekening tetap boleh
    # 'bayar' karena kolektor perlu memberi info rekening ke pelanggan.
    is_rekening_write = p.endswith('/rekening') and request.method == 'POST'
    perm = 'keuangan' if (p.endswith('/config') or p.endswith('/mark-paid') or is_rekening_write) else 'bayar'
    return guard_request(perm=perm)


# ── Config ─────────────────────────────────────────────────────
_KEYS = ('pay_provider', 'pay_server_key', 'pay_client_key', 'pay_mode', 'pay_enabled', 'pay_callback_token')


def _load_config(conn):
    rows = conn.execute(
        "SELECT key, value FROM app_settings WHERE key IN (%s)" % ','.join('?' * len(_KEYS)),
        _KEYS,
    ).fetchall()
    d = {r['key']: r['value'] for r in rows}
    return {
        'provider':       d.get('pay_provider') or 'midtrans',
        'server_key':     d.get('pay_server_key') or '',
        'client_key':     d.get('pay_client_key') or '',
        'mode':           d.get('pay_mode') or 'sandbox',
        'enabled':        (d.get('pay_enabled') or '0') == '1',
        'callback_token': d.get('pay_callback_token') or '',
    }


def _save_setting(conn, key, value):
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (key, value, datetime.now().isoformat()),
    )


@payment_bp.route('/config', methods=['GET'])
def get_config():
    conn = get_db(); cfg = _load_config(conn); conn.close()
    return jsonify({'status': 'success', 'config': {
        'provider': cfg['provider'], 'mode': cfg['mode'], 'enabled': cfg['enabled'],
        'client_key': cfg['client_key'], 'has_server_key': bool(cfg['server_key']),
        'has_callback_token': bool(cfg['callback_token']),
    }}), 200


@payment_bp.route('/config', methods=['POST'])
def save_config():
    data = request.get_json(silent=True) or {}
    provider = (data.get('provider') or 'midtrans').strip()
    if provider not in ('midtrans', 'xendit'):
        return jsonify({'status': 'error', 'message': 'Provider tidak didukung'}), 400
    mode = (data.get('mode') or 'sandbox').strip()
    if mode not in ('sandbox', 'production'):
        return jsonify({'status': 'error', 'message': 'Mode tidak valid'}), 400
    conn = get_db()
    _save_setting(conn, 'pay_provider', provider)
    _save_setting(conn, 'pay_mode', mode)
    _save_setting(conn, 'pay_client_key', (data.get('client_key') or '').strip())
    if data.get('server_key'):
        _save_setting(conn, 'pay_server_key', str(data.get('server_key')))
    if data.get('callback_token'):
        _save_setting(conn, 'pay_callback_token', str(data.get('callback_token')).strip())
    _save_setting(conn, 'pay_enabled', '1' if data.get('enabled') else '0')
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Pengaturan payment gateway tersimpan'}), 200


# ── Buat transaksi ─────────────────────────────────────────────
def _midtrans_snap(cfg, order_id, amount, nama):
    base = ('https://app.sandbox.midtrans.com' if cfg['mode'] == 'sandbox'
            else 'https://app.midtrans.com') + '/snap/v1/transactions'
    payload = {
        'transaction_details': {'order_id': order_id, 'gross_amount': int(amount)},
        'customer_details': {'first_name': (nama or 'Pelanggan')[:40]},
    }
    auth = base64.b64encode((cfg['server_key'] + ':').encode()).decode()
    req = urllib.request.Request(
        base, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Authorization': 'Basic ' + auth}, method='POST')
    with urllib.request.urlopen(req, timeout=PAY_TIMEOUT) as resp:
        d = json.loads(resp.read().decode('utf-8'))
    return d.get('redirect_url') or ''


def _xendit_invoice(cfg, order_id, amount, nama):
    url = 'https://api.xendit.co/v2/invoices'
    payload = {
        'external_id': order_id,
        'amount': int(amount),
        'description': 'Pembayaran tagihan - {}'.format(nama or 'Pelanggan'),
        'currency': 'IDR',
    }
    auth = base64.b64encode((cfg['server_key'] + ':').encode()).decode()
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Authorization': 'Basic ' + auth}, method='POST')
    with urllib.request.urlopen(req, timeout=PAY_TIMEOUT) as resp:
        d = json.loads(resp.read().decode('utf-8'))
    return d.get('invoice_url') or ''


@payment_bp.route('/create', methods=['POST'])
def create_tx():
    data = request.get_json(silent=True) or {}
    try:
        tid = int(data.get('tagihan_id'))
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'tagihan_id wajib'}), 400

    conn = get_db()
    t = conn.execute('SELECT * FROM tagihan WHERE id=?', (tid,)).fetchone()
    if not t:
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan tidak ditemukan'}), 404
    if t['status'] == 'lunas':
        conn.close(); return jsonify({'status': 'error', 'message': 'Tagihan sudah lunas'}), 400

    # reuse transaksi pending yang masih ada
    existing = conn.execute(
        "SELECT * FROM pembayaran WHERE tagihan_id=? AND status='pending' ORDER BY id DESC LIMIT 1", (tid,)
    ).fetchone()
    if existing:
        conn.close()
        return jsonify({'status': 'success', 'message': 'Link pembayaran sudah ada',
                        'order_id': existing['order_id'], 'payment_url': existing['payment_url'],
                        'amount': existing['amount'], 'mock': not (existing['payment_url'] or '').startswith('http')}), 200

    cfg = _load_config(conn)
    order_id = 'TF-{}-{}'.format(tid, datetime.now().strftime('%Y%m%d%H%M%S'))
    amount = int(t['nominal'] or 0)
    if amount <= 0:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Harga paket belum diset'}), 400
    payment_url = ''
    mock = True
    if cfg['enabled'] and cfg['server_key'] and cfg['provider'] in ('midtrans', 'xendit'):
        try:
            if cfg['provider'] == 'midtrans':
                payment_url = _midtrans_snap(cfg, order_id, amount, t['nama'] or t['username'])
            else:
                payment_url = _xendit_invoice(cfg, order_id, amount, t['nama'] or t['username'])
            mock = False
        except Exception as e:
            log.warning('[Payment] %s gagal: %s', cfg['provider'], e)
            conn.close()
            return jsonify({'status': 'error', 'message': 'Gagal membuat transaksi: %s' % e}), 502
    if mock:
        payment_url = '#simulasi:' + order_id  # placeholder mock

    conn.execute(
        '''INSERT INTO pembayaran (tagihan_id, order_id, provider, amount, status, payment_url, username, periode)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)''',
        (tid, order_id, cfg['provider'], amount, payment_url, t['username'] or '', t['periode'])
    )
    conn.commit(); conn.close()
    return jsonify({'status': 'success',
                    'message': ('Link pembayaran dibuat' if not mock else 'Transaksi dibuat (gateway belum aktif — konfirmasi manual)'),
                    'order_id': order_id, 'payment_url': payment_url, 'amount': amount, 'mock': mock}), 201


# ── Daftar transaksi ───────────────────────────────────────────
@payment_bp.route('/transactions', methods=['GET'])
def transactions():
    periode = (request.args.get('periode') or '').strip()
    conn = get_db()
    sql = '''SELECT p.*, t.nama AS nama FROM pembayaran p
             LEFT JOIN tagihan t ON t.id = p.tagihan_id'''
    params = []
    if periode:
        sql += ' WHERE p.periode = ?'; params.append(periode)
    sql += ' ORDER BY p.id DESC LIMIT 300'
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    items = [{
        'id': r['id'], 'tagihan_id': r['tagihan_id'], 'order_id': r['order_id'],
        'nama': r['nama'] or r['username'], 'username': r['username'],
        'provider': r['provider'], 'amount': r['amount'], 'status': r['status'],
        'payment_url': r['payment_url'], 'periode': r['periode'],
        'created_at': r['created_at'], 'paid_at': r['paid_at'] or '',
    } for r in rows]
    return jsonify({'status': 'success', 'transactions': items}), 200


# ── Tandai lunas (dipakai mark-paid & webhook) ─────────────────
def _mark_paid(conn, pay_row, channel='online'):
    if pay_row['status'] == 'paid':
        return
    now = datetime.now().isoformat()
    conn.execute("UPDATE pembayaran SET status='paid', paid_at=?, channel=? WHERE id=?",
                 (now, channel, pay_row['id']))
    t = conn.execute('SELECT * FROM tagihan WHERE id=?', (pay_row['tagihan_id'],)).fetchone()
    if t and t['status'] != 'lunas':
        keterangan_prefix = 'Pelunasan piutang online' if t['status'] == 'piutang' else 'Pembayaran online'
        conn.execute("UPDATE tagihan SET status='lunas', paid_at=?, metode=? WHERE id=?",
                     (now, pay_row['provider'] or 'online', t['id']))
        conn.execute(
            '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
               VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
            (date.today().isoformat(),
             '{} {} - {}'.format(keterangan_prefix, t['periode'], t['username'] or t['nama']),
             t['nominal'], pay_row['provider'] or 'online', t['username'] or '',
             'Order {} via {}'.format(pay_row['order_id'], pay_row['provider'] or '-'))
        )
        # Pelanggan langsung hidup lagi kalau sedang diisolir krn nunggak
        # (pembayaran online/webhook tidak melalui alur loket/tagihan manual)
        from tagihan import _restore_isolir_if_needed
        _restore_isolir_if_needed(conn, t['username'] or '')

        catat_aktivitas('tagihan', 'lunas', target=t['username'] or '',
                        pesan='{} {} - {}'.format(keterangan_prefix, t['periode'], t['username'] or t['nama']),
                        nominal=t['nominal'], conn=conn)


@payment_bp.route('/mark-paid', methods=['POST'])
def mark_paid():
    data = request.get_json(silent=True) or {}
    order_id = (data.get('order_id') or '').strip()
    if not order_id:
        return jsonify({'status': 'error', 'message': 'order_id wajib'}), 400
    conn = get_db()
    p = conn.execute('SELECT * FROM pembayaran WHERE order_id=?', (order_id,)).fetchone()
    if not p:
        conn.close(); return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404
    _mark_paid(conn, p, channel='manual')
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Transaksi dikonfirmasi lunas (manual)'}), 200


# ── Webhook gateway (real, publik) ─────────────────────────────
def _verify_midtrans_signature(cfg, data):
    """
    Midtrans: signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
    https://docs.midtrans.com/docs/https-notification-webhooks
    """
    order_id     = str(data.get('order_id') or '')
    status_code  = str(data.get('status_code') or '')
    gross_amount = str(data.get('gross_amount') or '')
    signature    = str(data.get('signature_key') or '')
    if not (order_id and status_code and gross_amount and signature and cfg['server_key']):
        return False
    expected = hashlib.sha512(
        (order_id + status_code + gross_amount + cfg['server_key']).encode()
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _verify_xendit_token(cfg, token):
    """Xendit: header X-Callback-Token harus sama dengan token verifikasi di dashboard."""
    if not cfg['callback_token'] or not token:
        return False
    return hmac.compare_digest(cfg['callback_token'], token)


@payment_bp.route('/webhook', methods=['POST'])
def webhook():
    # Multi-tenant: gateway harus diberi URL berisi ?network_id=<uuid>
    network_id = request.args.get('network_id', '')
    data = request.get_json(silent=True) or {}
    order_id = data.get('order_id') or data.get('external_id') or ''
    status = (data.get('transaction_status') or data.get('status') or '').lower()
    if not network_id or not order_id:
        return jsonify({'status': 'error', 'message': 'network_id & order_id wajib'}), 400

    # Validasi network_id terdaftar di master sebelum buka/buat DB owner —
    # mencegah pihak luar memicu pembuatan file DB owner baru lewat
    # webhook publik dengan network_id sembarangan (DoS file system).
    mconn = get_master_db()
    net = mconn.execute('SELECT 1 FROM networks WHERE network_id=?', (network_id,)).fetchone()
    mconn.close()
    if not net:
        return jsonify({'status': 'error', 'message': 'network_id tidak dikenal'}), 404

    paid_states = ('settlement', 'capture', 'paid', 'success')
    conn = get_owner_db(network_id)
    cfg = _load_config(conn)

    # ── Verifikasi keaslian callback sebelum memproses apa pun ──
    if cfg['provider'] == 'midtrans':
        if not _verify_midtrans_signature(cfg, data):
            conn.close()
            log.warning('[Payment] webhook midtrans signature invalid (network=%s order=%s)', network_id, order_id)
            return jsonify({'status': 'error', 'message': 'Signature tidak valid'}), 401
    elif cfg['provider'] == 'xendit':
        token = request.headers.get('X-Callback-Token', '')
        if not _verify_xendit_token(cfg, token):
            conn.close()
            log.warning('[Payment] webhook xendit token invalid (network=%s order=%s)', network_id, order_id)
            return jsonify({'status': 'error', 'message': 'Token tidak valid'}), 401

    p = conn.execute('SELECT * FROM pembayaran WHERE order_id=?', (order_id,)).fetchone()
    if not p:
        conn.close(); return jsonify({'status': 'error', 'message': 'Order tidak ditemukan'}), 404
    if status in paid_states:
        _mark_paid(conn, p, channel='webhook')
    elif status in ('expire', 'expired', 'cancel', 'deny', 'failure'):
        conn.execute("UPDATE pembayaran SET status='expired' WHERE id=?", (p['id'],))
    conn.commit(); conn.close()
    return jsonify({'status': 'success'}), 200


# ══════════════════════════════════════════════════════════════
# REKENING BANK — simpan/ambil di app_settings (JSON)
# ══════════════════════════════════════════════════════════════
@payment_bp.route('/rekening', methods=['GET'])
def get_rekening():
    conn = get_db()
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='rekening_bank'"
    ).fetchone()
    conn.close()
    try:
        rekening = json.loads(row['value']) if row and row['value'] else []
    except Exception:
        rekening = []
    return jsonify({'status': 'success', 'rekening': rekening}), 200


@payment_bp.route('/rekening', methods=['POST'])
def save_rekening():
    data = request.get_json(silent=True) or {}
    rekening = data.get('rekening', [])
    if not isinstance(rekening, list):
        return jsonify({'status': 'error', 'message': 'Format rekening tidak valid'}), 400
    conn = get_db()
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at) VALUES ('rekening_bank', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (json.dumps(rekening, ensure_ascii=False), datetime.now().isoformat())
    )
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Rekening tersimpan'}), 200
