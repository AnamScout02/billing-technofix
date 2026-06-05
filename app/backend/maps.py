"""
maps.py — TechnoFix · Blueprint API Peta Topologi
===================================================
Endpoint khusus untuk halaman Maps.
Blueprint: maps_bp  →  didaftarkan di input.py dengan prefix /api/maps

Endpoint:
  GET /api/maps/topology
      → Semua node berkoordinat: MikroTik, OLT, ODC, ODP, Pelanggan (ONU)

Format node:
  {
    "id":       "onu-123",
    "name":     "budi.santoso",
    "type":     "onu",        // router | olt | odc | odp | onu
    "lat":      -7.467,
    "lng":      112.431,
    "status":   "online",     // online | offline
    "rx_power": -21.5,        // null kecuali ONU
    "detail":   { ... }       // field spesifik per tipe
  }
"""

import logging
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, jsonify, request, g
from utils  import get_db

log = logging.getLogger(__name__)

maps_bp = Blueprint('maps', __name__)


# ── Guard multi-tenant: login + cek lock langganan ─────────────
@maps_bp.before_request
def _maps_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    return guard_request(perm='maps')


# ══════════════════════════════════════════════════════════════
# TCP STATUS CHECK — cek via RouterOS API port (sama dengan
# port yang dipakai saat daftar MikroTik / OLT)
#
# Cache per (ip, port) selama 3 menit agar maps tidak lambat
# saat banyak perangkat. Parallel check untuk efisiensi.
# ══════════════════════════════════════════════════════════════

_status_cache: dict = {}   # {(ip, port): (is_online, checked_at)}
_CACHE_TTL    = 180        # detik — hasil disimpan 3 menit
_TCP_TIMEOUT  = 2.0        # detik — timeout per koneksi TCP


def _tcp_check(ip: str, port: int) -> tuple:
    """
    Coba buka koneksi TCP ke ip:port.
    Return (is_online: bool, error_msg: str)
    """
    try:
        with socket.create_connection((ip, int(port)), timeout=_TCP_TIMEOUT):
            pass
        return True, ''
    except socket.timeout:
        return False, 'timeout'
    except ConnectionRefusedError:
        return False, 'connection_refused'
    except OSError as e:
        return False, str(e)
    except Exception as e:
        return False, str(e)


def _bulk_status_check(targets: list) -> dict:
    """
    Cek banyak perangkat secara parallel.
    targets = [{'ip': str, 'port': int, 'key': any}, ...]
    Kembalikan {key: is_online}
    """
    results = {}
    # Pisahkan yang sudah ada di cache vs yang perlu dicek
    now      = time.monotonic()
    to_check = []
    for t in targets:
        key    = (t['ip'], int(t['port']))
        cached = _status_cache.get(key)
        if cached and (now - cached[1]) < _CACHE_TTL:
            results[t['key']] = cached[0]
        else:
            to_check.append(t)

    if not to_check:
        return results

    # Parallel TCP check untuk semua yang belum di-cache
    max_workers = min(len(to_check), 10)
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        future_map = {
            ex.submit(_tcp_check, t['ip'], t['port']): t
            for t in to_check
        }
        for future in as_completed(future_map):
            t = future_map[future]
            try:
                online, err = future.result()
            except Exception as e:
                online, err = False, str(e)
            if err:
                log.debug('[TCP] %s:%s → %s (%s)', t['ip'], t['port'],
                          'online' if online else 'offline', err)
            cache_k = (t['ip'], int(t['port']))
            _status_cache[cache_k] = (online, time.monotonic())
            results[t['key']] = online

    return results


# ══════════════════════════════════════════════════════════════
# HELPER — parse string koordinat
# ══════════════════════════════════════════════════════════════

def _parse_coord(raw: str):
    """
    'lat, lng' atau 'lat,lng'  →  (float, float)
    Format Google Maps: '-7.4678, 112.4312'
    Kembalikan (None, None) jika gagal.
    """
    if not raw or not raw.strip():
        return None, None
    try:
        parts = raw.replace(';', ',').split(',')
        if len(parts) < 2:
            return None, None
        lat = float(parts[0].strip())
        lng = float(parts[1].strip())
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return lat, lng
    except (ValueError, AttributeError):
        pass
    return None, None


# ══════════════════════════════════════════════════════════════
# GET /api/maps/topology
# ══════════════════════════════════════════════════════════════

@maps_bp.route('/topology', methods=['GET'])
def maps_topology():
    """
    Mengembalikan semua node yang memiliki koordinat valid.
    Digunakan halaman maps.html (MapLibre GL JS).
    """
    conn  = get_db()
    nodes = []

    try:
        # ── 1. MikroTik / Router — TCP check ke API port ────
        try:
            devices = conn.execute(
                'SELECT id, name, ip, port, status, koordinat FROM devices'
            ).fetchall()
        except Exception:
            devices = conn.execute(
                'SELECT id, name, ip, port, status FROM devices'
            ).fetchall()

        # Kumpulkan router yang punya koordinat valid
        router_cands = []
        for d in devices:
            coord = (d['koordinat'] if 'koordinat' in d.keys() else '') or ''
            lat, lng = _parse_coord(coord.strip())
            if lat is None:
                continue
            router_cands.append({
                'key': d['id'], 'row': d,
                'ip': d['ip'], 'port': int(d['port'] or 8728),
                'lat': lat, 'lng': lng,
            })

        # Parallel TCP check ke API port — satu round trip untuk semua router
        router_status = _bulk_status_check([
            {'ip': r['ip'], 'port': r['port'], 'key': r['key']}
            for r in router_cands
        ])

        for r in router_cands:
            tcp_online = router_status.get(r['key'], False)
            db_online  = (r['row']['status'] == 'connected')
            # TCP check primer; jika TCP gagal (misal NAT hairpin) fallback ke DB status
            is_online  = tcp_online or db_online
            nodes.append({
                'id':       'router-{}'.format(r['row']['id']),
                'name':     r['row']['name'],
                'type':     'router',
                'lat':      r['lat'],
                'lng':      r['lng'],
                'status':   'online' if is_online else 'offline',
                'rx_power': None,
                'detail':   {'ip': r['row']['ip'] or ''},
            })

        # ── 2. OLT — TCP check ke port Telnet/SSH OLT ───────
        olts = conn.execute('SELECT * FROM olt').fetchall()

        olt_cands = []
        for o in olts:
            lat, lng = _parse_coord((o['koordinat'] or '').strip())
            if lat is None:
                continue
            olt_cands.append({
                'key': o['id'], 'row': o,
                'ip': o['ip'], 'port': int(o['port'] or 23),
                'lat': lat, 'lng': lng,
            })

        olt_status = _bulk_status_check([
            {'ip': c['ip'], 'port': c['port'], 'key': c['key']}
            for c in olt_cands
        ])

        for c in olt_cands:
            o       = c['row']
            is_online = olt_status.get(c['key'], False)
            detail  = {'ip': o['ip'] or '', 'tipe': o['tipe'] or ''}
            if o['lokasi']:
                detail['lokasi'] = o['lokasi']
            nodes.append({
                'id':       'olt-{}'.format(o['id']),
                'name':     o['name'],
                'type':     'olt',
                'lat':      c['lat'],
                'lng':      c['lng'],
                'status':   'online' if is_online else 'offline',
                'rx_power': None,
                'detail':   detail,
            })

        # ── 3. ODC ───────────────────────────────────────────
        try:
            odcs = conn.execute(
                'SELECT id, nama, lokasi, koordinat, tipe_kabel, jumlah_port, olt_id FROM odc'
            ).fetchall()
            for c in odcs:
                lat, lng = _parse_coord((c['koordinat'] or '').strip())
                if lat is None:
                    lat, lng = _parse_coord((c['lokasi'] or '').strip())
                if lat is None:
                    continue
                nodes.append({
                    'id':       'odc-{}'.format(c['id']),
                    'name':     c['nama'],
                    'type':     'odc',
                    'lat':      lat,
                    'lng':      lng,
                    'status':   'online',   # ODC tidak punya status realtime
                    'rx_power': None,
                    'detail': {
                        'lokasi':      c['lokasi']      or '',
                        'tipe':        c['tipe_kabel']  or '',
                        'jumlah_port': str(c['jumlah_port'] or ''),
                        'olt_id':      str(c['olt_id']  or ''),
                    },
                })
        except Exception as e:
            log.warning('maps ODC error: %s', e)

        # ── 4. ODP ───────────────────────────────────────────
        try:
            odps = conn.execute(
                'SELECT id, nama, lokasi, koordinat, jumlah_port, port_terpakai, odc_id FROM odp'
            ).fetchall()
            for p in odps:
                lat, lng = _parse_coord((p['koordinat'] or '').strip())
                if lat is None:
                    lat, lng = _parse_coord((p['lokasi'] or '').strip())
                if lat is None:
                    continue
                nodes.append({
                    'id':       'odp-{}'.format(p['id']),
                    'name':     p['nama'],
                    'type':     'odp',
                    'lat':      lat,
                    'lng':      lng,
                    'status':   'online',
                    'rx_power': None,
                    'detail': {
                        'lokasi':        p['lokasi']       or '',
                        'jumlah_port':   str(p['jumlah_port']   or ''),
                        'port_terpakai': str(p['port_terpakai'] or ''),
                        'odc_id':        str(p['odc_id']   or ''),
                    },
                })
        except Exception as e:
            log.warning('maps ODP error: %s', e)

        # ── 5. Pelanggan / ONU ───────────────────────────────
        # Role kolektor → hanya pelanggan yang ditugaskan ke dia
        current = getattr(g, 'current_user', None)
        is_kolektor = current and current.get('role') == 'kolektor'
        kolektor_username = current.get('username', '') if is_kolektor else None

        # Tagihan belum bayar bulan ini → untuk warna marker
        from datetime import date as _date
        periode_ini = _date.today().strftime('%Y-%m')
        belum_bayar_set = set()
        try:
            bb_rows = conn.execute(
                "SELECT DISTINCT username FROM tagihan WHERE periode=? AND status='belum_bayar'",
                (periode_ini,)
            ).fetchall()
            belum_bayar_set = {r['username'] for r in bb_rows}
        except Exception:
            pass

        # Hitung pelanggan kolektor tanpa koordinat (untuk info)
        koordinat_kosong = 0
        if is_kolektor:
            try:
                koordinat_kosong = conn.execute(
                    "SELECT COUNT(*) FROM pelanggan WHERE kolektor=? AND aktif=1 AND (titik_koordinat IS NULL OR titik_koordinat='')",
                    (kolektor_username,)
                ).fetchone()[0]
            except Exception:
                pass

        try:
            if is_kolektor:
                rows = conn.execute('''
                    SELECT p.id, p.username, p.nama, p.profil, p.hp,
                           p.titik_koordinat, p.aktif, p.kolektor,
                           m.rx_power, m.sn, m.vlan, m.slot_port, m.olt_id,
                           d.ip AS device_ip
                    FROM pelanggan p
                    LEFT JOIN onu_mapping m ON m.username = p.username
                    LEFT JOIN devices d     ON d.id = p.device_id
                    WHERE p.titik_koordinat IS NOT NULL
                      AND p.titik_koordinat != ''
                      AND p.kolektor = ?
                ''', (kolektor_username,)).fetchall()
            else:
                rows = conn.execute('''
                    SELECT p.id, p.username, p.nama, p.profil, p.hp,
                           p.titik_koordinat, p.aktif,
                           COALESCE(p.kolektor,'') AS kolektor,
                           m.rx_power, m.sn, m.vlan, m.slot_port, m.olt_id,
                           d.ip AS device_ip
                    FROM pelanggan p
                    LEFT JOIN onu_mapping m ON m.username = p.username
                    LEFT JOIN devices d     ON d.id = p.device_id
                    WHERE p.titik_koordinat IS NOT NULL
                      AND p.titik_koordinat != ''
                ''').fetchall()
        except Exception:
            # Fallback: tanpa join (misal onu_mapping belum ada)
            try:
                rows = conn.execute('''
                    SELECT id, username, nama, profil, hp,
                           titik_koordinat, aktif
                    FROM pelanggan
                    WHERE titik_koordinat IS NOT NULL
                      AND titik_koordinat != ''
                ''').fetchall()
            except Exception:
                # Fallback minimal: tanpa kolom nama
                rows = conn.execute('''
                    SELECT id, username, profil, hp,
                           titik_koordinat, aktif
                    FROM pelanggan
                    WHERE titik_koordinat IS NOT NULL
                      AND titik_koordinat != ''
                ''').fetchall()

        # Bangun set username aktif sebagai proxy "online"
        online_set = set()
        for r in rows:
            if r['aktif']:
                online_set.add(r['username'])

        for r in rows:
            lat, lng = _parse_coord(r['titik_koordinat'])
            if lat is None:
                continue

            rx = None
            try:
                raw_rx = r['rx_power'] if 'rx_power' in r.keys() else None
                rx = float(raw_rx) if raw_rx is not None else None
            except (TypeError, ValueError, IndexError):
                pass

            username  = r['username'] or ''
            nama      = (r['nama'] if 'nama' in r.keys() else '') or ''
            # Tampilkan nama asli jika ada, fallback ke username
            display   = nama if nama else username
            hp = (r['hp'] if 'hp' in r.keys() else '') or ''
            belum_bayar = username in belum_bayar_set
            nodes.append({
                'id':              'onu-{}'.format(r['id']),
                'name':            display,
                'type':            'onu',
                'lat':             lat,
                'lng':             lng,
                'status':          'online' if username in online_set else 'offline',
                'tagihan_status':  'belum_bayar' if belum_bayar else 'lunas',
                'rx_power':        rx,
                'detail': {
                    'username':    username,
                    'profil':      (r['profil']    or ''),
                    'sn':          (r['sn']        if 'sn'        in r.keys() else '') or '',
                    'vlan':        (r['vlan']      if 'vlan'      in r.keys() else '') or '',
                    'slot_port':   (r['slot_port'] if 'slot_port' in r.keys() else '') or '',
                    'hp':          hp,
                    'ip':          (r['device_ip'] if 'device_ip' in r.keys() else '') or '',
                    'pelanggan_id': r['id'],
                },
            })

    except Exception as e:
        log.error('maps_topology error: %s', e)
        conn.close()
        return jsonify({'error': str(e)}), 500

    # ══════════════════════════════════════════════════════════
    # BANGUN LINKS — relasi antar perangkat untuk garis di Maps
    # ══════════════════════════════════════════════════════════
    links = []
    conn2 = get_db()
    try:
        # ── A. Router → OLT ──────────────────────────────────
        # OLT yang punya router_id → gambar garis ke router tsb
        try:
            olt_links = conn2.execute(
                'SELECT id, name, router_id, router_interface, olt_uplink_port, status FROM olt '
                'WHERE router_id IS NOT NULL AND koordinat IS NOT NULL AND koordinat != ""'
            ).fetchall()
            for o in olt_links:
                # Cek apakah source router punya koordinat
                r_coord = conn2.execute(
                    'SELECT koordinat FROM devices WHERE id = ?', (o['router_id'],)
                ).fetchone()
                if not r_coord or not r_coord['koordinat']:
                    continue
                is_online = olt_status.get(o['id'], False)
                label = ''
                if o['router_interface']:
                    label += o['router_interface']
                if o['olt_uplink_port']:
                    label += (' → ' if label else '') + o['olt_uplink_port']
                links.append({
                    'id':      'link-router{}-olt{}'.format(o['router_id'], o['id']),
                    'source':  'router-{}'.format(o['router_id']),
                    'target':  'olt-{}'.format(o['id']),
                    'type':    'uplink',
                    'status':  'online' if is_online else 'offline',
                    'quality': 'good' if is_online else 'bad',
                    'label':   label,
                })
        except Exception as e:
            log.warning('links router-olt error: %s', e)

        # ── B. OLT → ODC ─────────────────────────────────────
        try:
            odc_list = conn2.execute(
                'SELECT id, nama, olt_id, koordinat FROM odc '
                'WHERE olt_id IS NOT NULL AND koordinat IS NOT NULL AND koordinat != ""'
            ).fetchall()
            for c in odc_list:
                # Cek apakah OLT parent punya koordinat
                olt_row = conn2.execute(
                    'SELECT koordinat, status FROM olt WHERE id = ?', (c['olt_id'],)
                ).fetchone()
                if not olt_row or not olt_row['koordinat']:
                    continue
                olt_online = olt_status.get(c['olt_id'], False)
                links.append({
                    'id':      'link-olt{}-odc{}'.format(c['olt_id'], c['id']),
                    'source':  'olt-{}'.format(c['olt_id']),
                    'target':  'odc-{}'.format(c['id']),
                    'type':    'fiber',
                    'status':  'online' if olt_online else 'offline',
                    'quality': 'good' if olt_online else 'bad',
                    'label':   '',
                })
        except Exception as e:
            log.warning('links olt-odc error: %s', e)

        # ── C. ODC → ODP (direct) + ODP → ODP (cascade, max 3 level) ────
        try:
            all_odp = conn2.execute(
                '''SELECT id, nama, koordinat,
                          COALESCE(odc_id, NULL) AS odc_id,
                          COALESCE(parent_odp_id, NULL) AS parent_odp_id,
                          COALESCE(port_odc, NULL) AS port_odc,
                          COALESCE(port_parent_odp, NULL) AS port_parent_odp
                   FROM odp WHERE koordinat IS NOT NULL AND koordinat != ""'''
            ).fetchall()

            for p in all_odp:
                pd = dict(p)
                if pd.get('odc_id'):
                    # Direct: ODC → ODP
                    src_row = conn2.execute('SELECT koordinat FROM odc WHERE id=?', (pd['odc_id'],)).fetchone()
                    if src_row and src_row['koordinat']:
                        port_lbl = 'Port {}'.format(pd['port_odc']) if pd.get('port_odc') else ''
                        links.append({
                            'id':      'link-odc{}-odp{}'.format(pd['odc_id'], pd['id']),
                            'source':  'odc-{}'.format(pd['odc_id']),
                            'target':  'odp-{}'.format(pd['id']),
                            'type':    'fiber', 'status': 'online', 'quality': 'good',
                            'label':   port_lbl,
                        })
                elif pd.get('parent_odp_id'):
                    # Cascade: ODP → ODP
                    src_row = conn2.execute('SELECT koordinat FROM odp WHERE id=?', (pd['parent_odp_id'],)).fetchone()
                    if src_row and src_row['koordinat']:
                        port_lbl = 'Port {}'.format(pd['port_parent_odp']) if pd.get('port_parent_odp') else ''
                        links.append({
                            'id':      'link-odp{}-odp{}'.format(pd['parent_odp_id'], pd['id']),
                            'source':  'odp-{}'.format(pd['parent_odp_id']),
                            'target':  'odp-{}'.format(pd['id']),
                            'type':    'fiber-cascade', 'status': 'online', 'quality': 'good',
                            'label':   port_lbl,
                        })
        except Exception as e:
            log.warning('links odc/odp-odp cascade error: %s', e)

        # ── D. ODP → ONU (Pelanggan) ─────────────────────────
        try:
            onu_links = conn2.execute('''
                SELECT p.id, p.username, p.titik_koordinat, p.odp_id,
                       m.rx_power
                FROM pelanggan p
                LEFT JOIN onu_mapping m ON m.username = p.username
                WHERE p.odp_id IS NOT NULL
                  AND p.titik_koordinat IS NOT NULL AND p.titik_koordinat != ""
            ''').fetchall()
            for r in onu_links:
                odp_row = conn2.execute(
                    'SELECT koordinat FROM odp WHERE id = ?', (r['odp_id'],)
                ).fetchone()
                if not odp_row or not odp_row['koordinat']:
                    continue
                # Kualitas berdasarkan rx_power ONU
                rx = None
                try:
                    rx = float(r['rx_power']) if r['rx_power'] is not None else None
                except Exception:
                    pass
                if rx is None:
                    quality, status = 'bad', 'offline'
                elif rx >= -20:
                    quality, status = 'good', 'online'
                elif rx >= -26:
                    quality, status = 'warning', 'online'
                else:
                    quality, status = 'bad', 'online'
                links.append({
                    'id':      'link-odp{}-onu{}'.format(r['odp_id'], r['id']),
                    'source':  'odp-{}'.format(r['odp_id']),
                    'target':  'onu-{}'.format(r['id']),
                    'type':    'drop',
                    'status':  status,
                    'quality': quality,
                    'label':   '',
                })
        except Exception as e:
            log.warning('links odp-onu error: %s', e)

    except Exception as e:
        log.error('links build error: %s', e)
    finally:
        conn2.close()

    log.info('maps_topology: %d nodes, %d links', len(nodes), len(links))
    return jsonify({
        'nodes': nodes,
        'links': links,
        'total': len(nodes),
        'is_kolektor': locals().get('is_kolektor', False),
        'koordinat_kosong': locals().get('koordinat_kosong', 0),
    }), 200


# ══════════════════════════════════════════════════════════════
# GET /api/maps/ping?id=<device_id>&type=router|olt
# Endpoint diagnostik — cek TCP ke API port perangkat tertentu
# Contoh: /api/maps/ping?id=1&type=router
# ══════════════════════════════════════════════════════════════

@maps_bp.route('/ping', methods=['GET'])
def maps_ping():
    """Diagnosa konektivitas TCP ke perangkat tertentu."""
    device_id   = request.args.get('id',   '').strip()
    device_type = request.args.get('type', 'router').strip()

    if not device_id:
        return jsonify({'error': 'parameter id wajib diisi'}), 400

    conn = get_db()
    try:
        if device_type == 'olt':
            row = conn.execute(
                'SELECT id, name, ip, port, status FROM olt WHERE id = ?', (device_id,)
            ).fetchone()
        else:
            row = conn.execute(
                'SELECT id, name, ip, port, status FROM devices WHERE id = ?', (device_id,)
            ).fetchone()
    finally:
        conn.close()

    if not row:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    ip, port = row['ip'], int(row['port'] or 8728)
    online, err = _tcp_check(ip, port)

    return jsonify({
        'device':    row['name'],
        'ip':        ip,
        'port':      port,
        'tcp_online': online,
        'tcp_error':  err or None,
        'db_status':  row['status'],
        'conclusion': (
            'TCP berhasil → perangkat online'
            if online else
            'TCP gagal ({}). Kemungkinan: API dinonaktifkan, firewall, atau NAT hairpin. '
            'DB status: {}'.format(err or '-', row['status'])
        ),
    }), 200
