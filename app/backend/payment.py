"""
payment.py — TechnoFix · Blueprint Payment Gateway
==================================================
Buat link pembayaran online untuk tagihan (Midtrans / Xendit).
MODE MOCK: bila gateway belum diaktifkan, dibuat order_id +
payment_url dummy dan tombol "Tandai Lunas (simulasi)" untuk
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
  POST /simulate-paid {order_id}  → (mock) tandai lunas utk demo
  POST /webhook?network_id=       → callback gateway (real)
"""

import json
import base64
import logging
import urllib.request
import urllib.parse
from datetime import date, datetime
from flask import Blueprint, request, jsonify, g
from utils import get_db, get_owner_db

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
    perm = 'keuangan' if (p.endswith('/config') or p.endswith('/simulate-paid')) else 'bayar'
    return guard_request(perm=perm)


# ── Config ─────────────────────────────────────────────────────
_KEYS = ('pay_provider', 'pay_server_key', 'pay_client_key', 'pay_mode', 'pay_enabled')


def _load_config(conn):
    rows = conn.execute(
        "SELECT key, value FROM app_settings WHERE key IN (%s)" % ','.join('?' * len(_KEYS)),
        _KEYS,
    ).fetchall()
    d = {r['key']: r['value'] for r in rows}
    return {
        'provider':   d.get('pay_provider') or 'midtrans',
        'server_key': d.get('pay_server_key') or '',
        'client_key': d.get('pay_client_key') or '',
        'mode':       d.get('pay_mode') or 'sandbox',
        'enabled':    (d.get('pay_enabled') or '0') == '1',
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
                        'amount': existing['amount'], 'mock': not existing['payment_url'].startswith('http')}), 200

    cfg = _load_config(conn)
    order_id = 'TF-{}-{}'.format(tid, datetime.now().strftime('%Y%m%d%H%M%S'))
    amount = int(t['nominal'] or 0)
    payment_url = ''
    mock = True
    if cfg['enabled'] and cfg['server_key'] and cfg['provider'] == 'midtrans':
        try:
            payment_url = _midtrans_snap(cfg, order_id, amount, t['nama'] or t['username'])
            mock = False
        except Exception as e:
            log.warning('[Payment] midtrans gagal: %s', e)
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
                    'message': ('Link pembayaran dibuat' if not mock else 'Transaksi simulasi dibuat (mode mock)'),
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


# ── Tandai lunas (dipakai simulate-paid & webhook) ─────────────
def _mark_paid(conn, pay_row, channel='online'):
    if pay_row['status'] == 'paid':
        return
    now = datetime.now().isoformat()
    conn.execute("UPDATE pembayaran SET status='paid', paid_at=?, channel=? WHERE id=?",
                 (now, channel, pay_row['id']))
    t = conn.execute('SELECT * FROM tagihan WHERE id=?', (pay_row['tagihan_id'],)).fetchone()
    if t and t['status'] != 'lunas':
        conn.execute("UPDATE tagihan SET status='lunas', paid_at=?, metode=? WHERE id=?",
                     (now, pay_row['provider'] or 'online', t['id']))
        conn.execute(
            '''INSERT INTO keuangan (tanggal, keterangan, tipe, nominal, status, metode, username, catatan)
               VALUES (?, ?, 'pemasukan', ?, 'Lunas', ?, ?, ?)''',
            (date.today().isoformat(),
             'Pembayaran online {} - {}'.format(t['periode'], t['username'] or t['nama']),
             t['nominal'], pay_row['provider'] or 'online', t['username'] or '',
             'Order {} via {}'.format(pay_row['order_id'], pay_row['provider'] or '-'))
        )


@payment_bp.route('/simulate-paid', methods=['POST'])
def simulate_paid():
    data = request.get_json(silent=True) or {}
    order_id = (data.get('order_id') or '').strip()
    if not order_id:
        return jsonify({'status': 'error', 'message': 'order_id wajib'}), 400
    conn = get_db()
    p = conn.execute('SELECT * FROM pembayaran WHERE order_id=?', (order_id,)).fetchone()
    if not p:
        conn.close(); return jsonify({'status': 'error', 'message': 'Transaksi tidak ditemukan'}), 404
    _mark_paid(conn, p, channel='simulasi')
    conn.commit(); conn.close()
    return jsonify({'status': 'success', 'message': 'Transaksi ditandai lunas (simulasi)'}), 200


# ── Webhook gateway (real, publik) ─────────────────────────────
@payment_bp.route('/webhook', methods=['POST'])
def webhook():
    # Multi-tenant: gateway harus diberi URL berisi ?network_id=<uuid>
    network_id = request.args.get('network_id', '')
    data = request.get_json(silent=True) or {}
    order_id = data.get('order_id') or ''
    status = (data.get('transaction_status') or data.get('status') or '').lower()
    if not network_id or not order_id:
        return jsonify({'status': 'error', 'message': 'network_id & order_id wajib'}), 400

    paid_states = ('settlement', 'capture', 'paid', 'success')
    conn = get_owner_db(network_id)
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
