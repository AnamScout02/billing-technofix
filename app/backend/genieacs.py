"""
genieacs.py — TechnoFix · Blueprint GenieACS (TR-069 / CWMP)
============================================================
Integrasi monitoring & remote-config ONU pelanggan lewat
GenieACS NBI API (default port 7557). Mendukung MODE MOCK:
bila config belum diisi / server tak terjangkau, endpoint
mengembalikan data contoh sehingga UI tetap bisa dibangun &
dites sebelum server GenieACS asli tersedia.

Config disimpan per-owner di tabel app_settings (key-value):
  genieacs_url, genieacs_user, genieacs_pass, genieacs_enabled

Daftarkan di input.py:
  from genieacs import genieacs_bp
  app.register_blueprint(genieacs_bp, url_prefix='/api/genieacs')

Endpoint (prefix /api/genieacs):
  GET  /config                      → config aktif (tanpa bocorkan password)
  POST /config {url,username,password,enabled}
  GET  /devices                     → daftar ONU (live / mock)
  GET  /devices/<id>                → detail parameter ONU
  POST /devices/<id>/reboot         → task reboot
  POST /devices/<id>/wifi {ssid,password}  → set SSID + key WLAN
"""

import json
import base64
import logging
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from utils import get_db

log = logging.getLogger(__name__)
genieacs_bp = Blueprint('genieacs', __name__)

NBI_TIMEOUT = 6  # detik


# ── Guard: login + lock + permission 'perangkat' ───────────────
@genieacs_bp.before_request
def _genieacs_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    return guard_request(perm='perangkat')


# ══════════════════════════════════════════════════════════════
# CONFIG (app_settings key-value)
# ══════════════════════════════════════════════════════════════
_KEYS = ('genieacs_url', 'genieacs_user', 'genieacs_pass', 'genieacs_enabled')


def _load_config(conn):
    rows = conn.execute(
        "SELECT key, value FROM app_settings WHERE key IN (%s)" % ','.join('?' * len(_KEYS)),
        _KEYS,
    ).fetchall()
    d = {r['key']: r['value'] for r in rows}
    return {
        'url':      (d.get('genieacs_url') or '').rstrip('/'),
        'username': d.get('genieacs_user') or '',
        'password': d.get('genieacs_pass') or '',
        'enabled':  (d.get('genieacs_enabled') or '0') == '1',
    }


def _save_setting(conn, key, value):
    conn.execute(
        '''INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (key, value, datetime.now().isoformat()),
    )


@genieacs_bp.route('/config', methods=['GET'])
def get_config():
    conn = get_db()
    cfg = _load_config(conn)
    conn.close()
    return jsonify({
        'status': 'success',
        'config': {
            'url':           cfg['url'],
            'username':      cfg['username'],
            'enabled':       cfg['enabled'],
            'has_password':  bool(cfg['password']),
        },
    }), 200


@genieacs_bp.route('/config', methods=['POST'])
def save_config():
    data = request.get_json(silent=True) or {}
    conn = get_db()
    _save_setting(conn, 'genieacs_url', (data.get('url') or '').strip().rstrip('/'))
    _save_setting(conn, 'genieacs_user', (data.get('username') or '').strip())
    # Password hanya ditimpa bila dikirim (biar tak terhapus saat edit lain)
    if 'password' in data and data.get('password') is not None:
        _save_setting(conn, 'genieacs_pass', str(data.get('password')))
    _save_setting(conn, 'genieacs_enabled', '1' if data.get('enabled') else '0')
    conn.commit()
    conn.close()
    return jsonify({'status': 'success', 'message': 'Pengaturan GenieACS tersimpan'}), 200


# ══════════════════════════════════════════════════════════════
# NBI HTTP HELPERS
# ══════════════════════════════════════════════════════════════

def _nbi_request(cfg, path, method='GET', body=None):
    """Panggil GenieACS NBI. Raise urllib.error / OSError bila gagal."""
    url = cfg['url'] + path
    headers = {'Content-Type': 'application/json'}
    if cfg['username']:
        tok = base64.b64encode(f"{cfg['username']}:{cfg['password']}".encode()).decode()
        headers['Authorization'] = 'Basic ' + tok
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=NBI_TIMEOUT) as resp:
        raw = resp.read().decode('utf-8') or 'null'
        return json.loads(raw)


def _pv(dev, *paths):
    """Ambil _value parameter dari device JSON, coba beberapa path (TR-098/TR-181)."""
    for path in paths:
        node = dev
        ok = True
        for part in path.split('.'):
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                ok = False
                break
        if ok and isinstance(node, dict) and '_value' in node:
            return node['_value']
    return None


def _device_summary(dev):
    last = dev.get('_lastInform') or dev.get('_lastBoot')
    online = False
    if last:
        try:
            t = datetime.fromisoformat(str(last).replace('Z', '+00:00'))
            online = (datetime.now(timezone.utc) - t).total_seconds() < 600
        except Exception:
            pass
    pre = 'InternetGatewayDevice.'
    pre2 = 'Device.'
    return {
        'id':       dev.get('_id') or dev.get('_deviceId', {}).get('_SerialNumber', ''),
        'serial':   _pv(dev, pre + 'DeviceInfo.SerialNumber', pre2 + 'DeviceInfo.SerialNumber')
                    or dev.get('_deviceId', {}).get('_SerialNumber', ''),
        'manufacturer': dev.get('_deviceId', {}).get('_Manufacturer', '')
                    or _pv(dev, pre + 'DeviceInfo.Manufacturer'),
        'product':  dev.get('_deviceId', {}).get('_ProductClass', '')
                    or _pv(dev, pre + 'DeviceInfo.ProductClass'),
        'software': _pv(dev, pre + 'DeviceInfo.SoftwareVersion', pre2 + 'DeviceInfo.SoftwareVersion'),
        'ssid':     _pv(dev, pre + 'LANDevice.1.WLANConfiguration.1.SSID',
                        pre2 + 'WiFi.SSID.1.SSID'),
        'rx_power': _pv(dev, pre + 'WANDevice.1.X_GponInterfaceConfig.RXPower',
                        pre + 'WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower'),
        'ip':       _pv(dev, pre + 'WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
                        pre + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'),
        'last_inform': last or '',
        'online':   online,
    }


# ── Data mock (dipakai bila disabled / unreachable) ────────────
def _mock_devices():
    now = datetime.now(timezone.utc).isoformat()
    return [
        {'id': 'HWTC-ABC123', 'serial': 'ABC123', 'manufacturer': 'Huawei', 'product': 'EG8145V5',
         'software': 'V5R020', 'ssid': 'TechnoFix-Budi', 'rx_power': '-21.3', 'ip': '100.64.0.12',
         'last_inform': now, 'online': True},
        {'id': 'ZTEG-DEF456', 'serial': 'DEF456', 'manufacturer': 'ZTE', 'product': 'F609',
         'software': 'V3.0', 'ssid': 'TechnoFix-Sari', 'rx_power': '-24.8', 'ip': '100.64.0.27',
         'last_inform': now, 'online': True},
        {'id': 'FHTT-GHI789', 'serial': 'GHI789', 'manufacturer': 'Fiberhome', 'product': 'HG6243C',
         'software': 'RP2600', 'ssid': 'TechnoFix-Andi', 'rx_power': '-28.1', 'ip': '',
         'last_inform': '2026-05-30T08:14:00+00:00', 'online': False},
    ]


def _resp_meta(cfg, live, note=''):
    return {'mode': 'live' if live else 'mock', 'enabled': cfg['enabled'],
            'configured': bool(cfg['url']), 'note': note}


# ══════════════════════════════════════════════════════════════
# DEVICES
# ══════════════════════════════════════════════════════════════
@genieacs_bp.route('/devices', methods=['GET'])
def list_devices():
    conn = get_db()
    cfg = _load_config(conn)
    conn.close()

    if not (cfg['enabled'] and cfg['url']):
        return jsonify({'status': 'success', 'devices': _mock_devices(),
                        'meta': _resp_meta(cfg, False, 'GenieACS belum diaktifkan — menampilkan data contoh.')}), 200
    try:
        raw = _nbi_request(cfg, '/devices/')
        devices = [_device_summary(d) for d in (raw or [])]
        return jsonify({'status': 'success', 'devices': devices,
                        'meta': _resp_meta(cfg, True)}), 200
    except Exception as e:
        log.warning('[GenieACS] list gagal: %s', e)
        return jsonify({'status': 'success', 'devices': _mock_devices(),
                        'meta': _resp_meta(cfg, False, 'Tidak bisa menghubungi GenieACS: %s' % e)}), 200


@genieacs_bp.route('/devices/<path:device_id>', methods=['GET'])
def get_device(device_id):
    conn = get_db()
    cfg = _load_config(conn)
    conn.close()

    if not (cfg['enabled'] and cfg['url']):
        dev = next((d for d in _mock_devices() if d['id'] == device_id), None)
        if not dev:
            return jsonify({'status': 'error', 'message': 'ONU tidak ditemukan (mock)'}), 404
        return jsonify({'status': 'success', 'device': dev,
                        'meta': _resp_meta(cfg, False, 'Data contoh.')}), 200
    try:
        q = urllib.parse.quote(json.dumps({'_id': device_id}))
        raw = _nbi_request(cfg, '/devices/?query=' + q)
        if not raw:
            return jsonify({'status': 'error', 'message': 'ONU tidak ditemukan'}), 404
        return jsonify({'status': 'success', 'device': _device_summary(raw[0]),
                        'meta': _resp_meta(cfg, True)}), 200
    except Exception as e:
        log.warning('[GenieACS] detail gagal: %s', e)
        return jsonify({'status': 'error', 'message': 'Gagal menghubungi GenieACS: %s' % e}), 502


@genieacs_bp.route('/devices/<path:device_id>/reboot', methods=['POST'])
def reboot_device(device_id):
    conn = get_db()
    cfg = _load_config(conn)
    conn.close()
    if not (cfg['enabled'] and cfg['url']):
        return jsonify({'status': 'success', 'message': '[MOCK] Perintah reboot dikirim ke %s' % device_id}), 200
    try:
        path = '/devices/%s/tasks?connection_request' % urllib.parse.quote(device_id)
        _nbi_request(cfg, path, method='POST', body={'name': 'reboot'})
        return jsonify({'status': 'success', 'message': 'Perintah reboot terkirim'}), 200
    except Exception as e:
        log.warning('[GenieACS] reboot gagal: %s', e)
        return jsonify({'status': 'error', 'message': 'Gagal kirim reboot: %s' % e}), 502


@genieacs_bp.route('/devices/<path:device_id>/wifi', methods=['POST'])
def set_wifi(device_id):
    data = request.get_json(silent=True) or {}
    ssid = (data.get('ssid') or '').strip()
    pwd  = (data.get('password') or '').strip()
    if not ssid and not pwd:
        return jsonify({'status': 'error', 'message': 'SSID atau password harus diisi'}), 400

    conn = get_db()
    cfg = _load_config(conn)
    conn.close()
    if not (cfg['enabled'] and cfg['url']):
        return jsonify({'status': 'success',
                        'message': '[MOCK] WiFi %s diperbarui (SSID=%s)' % (device_id, ssid or '-')}), 200
    try:
        base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.'
        pv = []
        if ssid:
            pv.append([base + 'SSID', ssid, 'xsd:string'])
        if pwd:
            pv.append([base + 'PreSharedKey.1.PreSharedKey', pwd, 'xsd:string'])
            pv.append([base + 'KeyPassphrase', pwd, 'xsd:string'])
        path = '/devices/%s/tasks?connection_request' % urllib.parse.quote(device_id)
        _nbi_request(cfg, path, method='POST',
                     body={'name': 'setParameterValues', 'parameterValues': pv})
        return jsonify({'status': 'success', 'message': 'Pengaturan WiFi terkirim'}), 200
    except Exception as e:
        log.warning('[GenieACS] set wifi gagal: %s', e)
        return jsonify({'status': 'error', 'message': 'Gagal set WiFi: %s' % e}), 502
