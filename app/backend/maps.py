"""
maps.py — TechnoFix-Bill · Blueprint API Peta Topologi
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
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, jsonify, request, g
from utils  import get_db, get_olt_uplinks

log = logging.getLogger(__name__)

maps_bp = Blueprint('maps', __name__)


# ══════════════════════════════════════════════════════════════
# CACHE SESI PPPOE AKTIF — sumber kebenaran online/offline maps
# Query semua MikroTik connected, gabungkan hasilnya, cache 60 detik.
# ══════════════════════════════════════════════════════════════
_mt_cache: dict = {}   # network_id -> (timestamp, {username: ip})
_MT_TTL   = 60


def _fetch_pppoe_active(conn, network_id=None):
    """
    Kembalikan dict {username: ip} dari sesi PPPoE aktif di semua MikroTik.
    Jika semua MikroTik gagal atau tidak ada → kembalikan None (sinyal: pakai p.aktif).
    Cache 60 detik per owner.

    network_id dipakai sbg cache key — kalau tidak diberikan (dipanggil dari
    luar request Flask, mis. worker background), coba ambil dari g.network_id;
    kalau tidak ada app context sama sekali (worker thread), pakai '' (aman,
    cuma berarti cache dibagi antar-pemanggil tanpa network_id eksplisit).
    """
    nid = network_id
    if nid is None:
        try:
            from flask import g as _g
            nid = getattr(_g, 'network_id', '')
        except RuntimeError:
            nid = ''
    now = time.time()

    cached = _mt_cache.get(nid)
    if cached and (now - cached[0]) < _MT_TTL:
        return cached[1]   # bisa dict atau None

    active: dict = {}
    any_success  = False
    devs = []
    try:
        from mikrotik import MikroTikClient
        # TIDAK filter by status='connected' — kolom itu cuma hasil tes
        # koneksi TERAKHIR (bisa basi/'pending' walau device sebenarnya
        # online), bukan status realtime. Device dgn status basi yg
        # ternyata punya banyak pelanggan akan membuat SEMUA pelanggannya
        # salah ditandai offline kalau di-skip di sini. Coba konek
        # langsung & lewati per-device kalau gagal (sudah ditangani
        # try/except di loop bawah).
        devs = conn.execute(
            'SELECT id, name, ip, port, username, password FROM devices'
        ).fetchall()

        for dev in devs:
            try:
                with MikroTikClient(dict(dev)) as mt:
                    for s in mt._get_api().path('/ppp/active'):
                        name = s.get('name', '')
                        addr = s.get('address', '')
                        if name:
                            active[name] = addr
                    any_success = True
                    log.info('[Maps PPPoE] MikroTik %s: %d sesi aktif', dev['name'], len(active))
            except Exception as e:
                log.debug('[Maps PPPoE] MikroTik %s gagal: %s', dev['name'], e)
    except Exception as e:
        log.warning('[Maps PPPoE] fetch error: %s', e)

    if not devs:
        # Tidak ada MikroTik yang terdaftar/terhubung sama sekali → tidak ada
        # sumber realtime, pakai p.aktif sebagai estimasi terbaik (sinyal None).
        result = None
    elif any_success:
        # Minimal satu MikroTik berhasil dihubungi → data sesi PPPoE akurat.
        result = active
    else:
        # Semua MikroTik terdaftar GAGAL dihubungi (mis. mati lampu/listrik padam).
        # JANGAN fallback ke p.aktif (itu cuma flag "secret tidak di-disable",
        # bukan status realtime) — itu menyebabkan "online semu". Anggap semua
        # pelanggan offline karena status realtime memang tidak bisa dipastikan.
        result = {}
        log.warning('[Maps PPPoE] Semua MikroTik (%d) gagal dihubungi — anggap semua pelanggan offline', len(devs))

    _mt_cache[nid] = (now, result)
    return result




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
                'SELECT id, name, ip, port, status, koordinat, public_ip, wan_interface FROM devices'
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

        # Hitung OLT per router untuk detail card
        olt_count_by_router = {}
        olt_names_by_router = {}
        try:
            for row in conn.execute(
                'SELECT DISTINCT u.olt_id, u.router_id, o.name FROM olt_uplink u '
                'JOIN olt o ON o.id = u.olt_id'
            ).fetchall():
                rid = row['router_id']
                olt_count_by_router[rid] = olt_count_by_router.get(rid, 0) + 1
                olt_names_by_router.setdefault(rid, []).append(row['name'] or '')
        except Exception:
            pass

        for r in router_cands:
            # Pakai hasil TCP check LANGSUNG (live) sebagai sumber kebenaran —
            # JANGAN di-OR dengan status cache DB (`devices.status`, hanya
            # ter-update saat sync manual). Kalau di-OR, router yang terakhir
            # tersinkron "connected" lalu mati listrik akan tetap tampil
            # "online" walau TCP check langsung sudah membuktikan offline
            # ("online semu").
            is_online  = router_status.get(r['key'], False)
            row        = r['row']
            rid        = row['id']
            detail = {
                'ip':            row['ip']           or '',
                'wan_interface': row['wan_interface'] if 'wan_interface' in row.keys() else '',
                'public_ip':     row['public_ip']    if 'public_ip'    in row.keys() else '',
                'olt_count':     olt_count_by_router.get(rid, 0),
                'olt_names':     olt_names_by_router.get(rid, []),
            }
            nodes.append({
                'id':       'router-{}'.format(rid),
                'name':     row['name'],
                'type':     'router',
                'lat':      r['lat'],
                'lng':      r['lng'],
                'status':   'online' if is_online else 'offline',
                'rx_power': None,
                'detail':   detail,
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

        # Hitung ODC, ODP, ONU per OLT untuk detail card
        odc_by_olt = {}; odp_by_olt = {}; onu_by_olt = {}
        try:
            for row in conn.execute('SELECT id, olt_id FROM odc WHERE olt_id IS NOT NULL').fetchall():
                odc_by_olt[row['olt_id']] = odc_by_olt.get(row['olt_id'], 0) + 1
        except Exception: pass
        try:
            for row in conn.execute('SELECT id, olt_id FROM odp WHERE olt_id IS NOT NULL').fetchall():
                odp_by_olt[row['olt_id']] = odp_by_olt.get(row['olt_id'], 0) + 1
        except Exception: pass
        try:
            for row in conn.execute('SELECT olt_id, COUNT(*) AS cnt FROM onu_mapping GROUP BY olt_id').fetchall():
                onu_by_olt[row['olt_id']] = row['cnt']
        except Exception: pass

        # Nama router untuk OLT
        router_name_by_id = {r['key']: r['row']['name'] for r in router_cands}

        for c in olt_cands:
            o         = c['row']
            is_online = olt_status.get(c['key'], False)
            oid       = o['id']
            uplinks_detail = [{
                'router_id':        up['router_id'],
                'router_nama':      router_name_by_id.get(up['router_id'], ''),
                'router_interface': up['router_interface'],
                'uplink_port':      up['uplink_port'],
                'keterangan':       up['keterangan'],
            } for up in get_olt_uplinks(conn, oid)]
            primary_up = uplinks_detail[0] if uplinks_detail else {}
            detail = {
                'ip':               o['ip']               or '',
                'tipe':             o['tipe']             or '',
                'lokasi':           o['lokasi']           or '',
                'keterangan':       o['keterangan']       or '',
                'uplinks':          uplinks_detail,
                # Field lama dipertahankan utk kompatibilitas FE yg belum baca 'uplinks'
                'router_nama':      primary_up.get('router_nama', ''),
                'router_interface': primary_up.get('router_interface', ''),
                'olt_uplink_port':  primary_up.get('uplink_port', ''),
                'odc_count':        odc_by_olt.get(oid, 0),
                'odp_direct':       odp_by_olt.get(oid, 0),
                'onu_count':        onu_by_olt.get(oid, 0),
            }
            nodes.append({
                'id':       'olt-{}'.format(oid),
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
                'SELECT id, nama, lokasi, koordinat, tipe_kabel, jumlah_port, port_terpakai, olt_id, keterangan FROM odc'
            ).fetchall()
            # ODP per ODC untuk daftar port
            odp_by_odc = {}
            try:
                for row in conn.execute(
                    'SELECT id, nama, odc_id, jumlah_port, port_terpakai, port_odc FROM odp'
                ).fetchall():
                    odc_id = row['odc_id']
                    if odc_id not in odp_by_odc:
                        odp_by_odc[odc_id] = []
                    odp_by_odc[odc_id].append({
                        'id':          row['id'],
                        'nama':        row['nama']         or '',
                        'port_odc':    row['port_odc']     or '',
                        'jumlah_port': row['jumlah_port']  or 0,
                        'terpakai':    row['port_terpakai'] or 0,
                    })
            except Exception:
                pass

            for c in odcs:
                lat, lng = _parse_coord((c['koordinat'] or '').strip())
                if lat is None:
                    lat, lng = _parse_coord((c['lokasi'] or '').strip())
                if lat is None:
                    continue
                odp_list  = odp_by_odc.get(c['id'], [])
                jp        = int(c['jumlah_port']   or 0)
                terpakai  = int(c['port_terpakai'] or 0)
                nodes.append({
                    'id':       'odc-{}'.format(c['id']),
                    'name':     c['nama'],
                    'type':     'odc',
                    'lat':      lat,
                    'lng':      lng,
                    'status':   'online',
                    'rx_power': None,
                    'detail': {
                        'lokasi':      c['lokasi']  or '',
                        'jumlah_port': jp,
                        'terpakai':    terpakai,
                        'sisa':        max(jp - terpakai, 0),
                        'keterangan':  c['keterangan']  or '',
                        'ports':       odp_list,   # [{nama, port_odc, jumlah_port, terpakai}]
                    },
                })
        except Exception as e:
            log.warning('maps ODC error: %s', e)

        # ── 4. ODP ───────────────────────────────────────────
        try:
            odps = conn.execute(
                'SELECT id, nama, lokasi, koordinat, jumlah_port, port_terpakai, odc_id, keterangan FROM odp'
            ).fetchall()
            # Pelanggan per ODP
            pel_by_odp = {}
            try:
                for row in conn.execute(
                    'SELECT id, nama, username, port_odp, odp_id FROM pelanggan WHERE odp_id IS NOT NULL'
                ).fetchall():
                    odp_id = row['odp_id']
                    if odp_id not in pel_by_odp:
                        pel_by_odp[odp_id] = []
                    pel_by_odp[odp_id].append({
                        'nama':      row['nama']     or row['username'] or '',
                        'username':  row['username'] or '',
                        'slot_port': row['port_odp'] or '',
                    })
            except Exception:
                pass

            # ODP anak (cascade) per ODP induk — port-nya dipakai ODP lain, bukan pelanggan
            anak_by_odp = {}
            try:
                for row in conn.execute(
                    'SELECT id, nama, parent_odp_id, port_parent_odp FROM odp '
                    'WHERE parent_odp_id IS NOT NULL'
                ).fetchall():
                    induk_id = row['parent_odp_id']
                    if induk_id not in anak_by_odp:
                        anak_by_odp[induk_id] = []
                    anak_by_odp[induk_id].append({
                        'nama':      row['nama'] or '',
                        'slot_port': row['port_parent_odp'] or '',
                    })
            except Exception:
                pass

            for p in odps:
                lat, lng = _parse_coord((p['koordinat'] or '').strip())
                if lat is None:
                    lat, lng = _parse_coord((p['lokasi'] or '').strip())
                if lat is None:
                    continue
                jp       = int(p['jumlah_port']   or 0)
                terpakai = int(p['port_terpakai'] or 0)
                pel_list  = pel_by_odp.get(p['id'], [])
                anak_list = anak_by_odp.get(p['id'], [])
                nodes.append({
                    'id':       'odp-{}'.format(p['id']),
                    'name':     p['nama'],
                    'type':     'odp',
                    'lat':      lat,
                    'lng':      lng,
                    'status':   'online',
                    'rx_power': None,
                    'detail': {
                        'lokasi':      p['lokasi']     or '',
                        'jumlah_port': jp,
                        'terpakai':    terpakai,
                        'sisa':        max(jp - terpakai, 0),
                        'keterangan':  p['keterangan'] or '',
                        'pelanggan':   pel_list,   # [{nama, username, slot_port}]
                        'odp_anak':    anak_list,  # [{nama, slot_port}] — port dipakai ODP turunan
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
                           COALESCE(m.ip_address, '') AS pppoe_ip,
                           COALESCE(m.is_online, -1)  AS mt_online
                    FROM pelanggan p
                    LEFT JOIN onu_mapping m ON m.username = p.username
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
                           COALESCE(m.ip_address, '') AS pppoe_ip,
                           COALESCE(m.is_online, -1)  AS mt_online
                    FROM pelanggan p
                    LEFT JOIN onu_mapping m ON m.username = p.username
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

        # Online/offline realtime dari MikroTik (semua device, cache 60 detik)
        # Fallback ke p.aktif jika tidak ada MikroTik connected / semua gagal
        pppoe = _fetch_pppoe_active(conn)
        if pppoe is not None:
            online_set = set(pppoe.keys())
            log.info('[Maps] online dari MikroTik: %d user', len(online_set))
        else:
            online_set = {r['username'] for r in rows if r['aktif']}
            log.info('[Maps] online dari p.aktif (fallback): %d user', len(online_set))

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
                    'ip':          (pppoe or {}).get(username, '') or (r['pppoe_ip'] if 'pppoe_ip' in r.keys() else '') or '',
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
        # Satu OLT bisa punya beberapa jalur uplink (ke router berbeda) →
        # gambar satu garis per baris di tabel olt_uplink, bukan cuma satu.
        try:
            olt_rows = conn2.execute(
                "SELECT id, name, status FROM olt "
                "WHERE koordinat IS NOT NULL AND koordinat != ''"
            ).fetchall()
            for o in olt_rows:
                is_online = olt_status.get(o['id'], False)
                for up in get_olt_uplinks(conn2, o['id']):
                    rid = up['router_id']
                    # Cek apakah source router punya koordinat
                    r_coord = conn2.execute(
                        'SELECT koordinat FROM devices WHERE id = ?', (rid,)
                    ).fetchone()
                    if not r_coord or not r_coord['koordinat']:
                        continue
                    label = ''
                    if up['router_interface']:
                        label += up['router_interface']
                    if up['uplink_port']:
                        label += (' → ' if label else '') + up['uplink_port']
                    links.append({
                        'id':      'link-router{}-olt{}-{}'.format(rid, o['id'], up['id']),
                        'source':  'router-{}'.format(rid),
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
                          COALESCE(odc_id, NULL)        AS odc_id,
                          COALESCE(parent_odp_id, NULL) AS parent_odp_id,
                          COALESCE(olt_id, NULL)        AS olt_id,
                          COALESCE(port_odc, NULL)      AS port_odc,
                          COALESCE(port_parent_odp, NULL) AS port_parent_odp
                   FROM odp WHERE koordinat IS NOT NULL AND koordinat != ""'''
            ).fetchall()

            for p in all_odp:
                pd = dict(p)
                if pd.get('odc_id'):
                    # ODC → ODP
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
                    # ODP → ODP (cascade splitter)
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
                elif pd.get('olt_id'):
                    # OLT → ODP langsung (tanpa ODC)
                    src_row = conn2.execute('SELECT koordinat FROM olt WHERE id=?', (pd['olt_id'],)).fetchone()
                    if src_row and src_row['koordinat']:
                        links.append({
                            'id':      'link-olt{}-odp{}'.format(pd['olt_id'], pd['id']),
                            'source':  'olt-{}'.format(pd['olt_id']),
                            'target':  'odp-{}'.format(pd['id']),
                            'type':    'fiber', 'status': 'online', 'quality': 'good',
                            'label':   '',
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
                # Status link ikut status ONU sebenarnya (online_set), bukan
                # cuma dari ada/tidaknya rx_power — kalau tidak, ONU yang
                # masih online tapi belum sync redaman akan tergambar
                # "Terputus" (merah, kedip) padahal markernya online (abu2).
                rx = None
                try:
                    rx = float(r['rx_power']) if r['rx_power'] is not None else None
                except Exception:
                    pass
                if r['username'] not in online_set:
                    quality, status = 'bad', 'offline'
                elif rx is None:
                    quality, status = 'warning', 'online'   # online, redaman belum sync
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
# GET /api/maps/problems
# Daftar live semua gangguan aktif (router/OLT offline, ONU offline atau
# redaman jelek) — beda dari /topology yang HANYA mengambil node dengan
# koordinat valid. Problems mengambil SEMUA, tanpa syarat koordinat,
# karena perangkat yang belum diplot di peta tetap perlu dipantau.
# Reuse _bulk_status_check() & _fetch_pppoe_active() yang sudah ada,
# TIDAK menyalin/menulis ulang query topology yang besar & berisiko.
# ══════════════════════════════════════════════════════════════

RX_CRIT_DBM = -27   # konsisten dengan threshold di dashboard.js
RX_WARN_DBM = -24

def _compute_problems(conn, network_id=None):
    """Hitung daftar problems (router/OLT/ONU offline + redaman) untuk 1 owner.
    Dipakai endpoint /api/maps/problems DAN worker alert WA (lihat wa.py) —
    satu sumber kebenaran, jangan duplikasi logic ini di tempat lain.

    network_id: wajib diisi kalau dipanggil dari luar request Flask (worker
    background, tidak ada g.network_id) — diteruskan ke _fetch_pppoe_active
    sbg cache key. Endpoint Flask boleh biarkan None (auto dari g)."""
    problems = []

    # ── Router (MikroTik) ──
    try:
        devices = conn.execute('SELECT id, name, ip, port FROM devices').fetchall()
    except Exception:
        devices = []
    router_status = _bulk_status_check([
        {'ip': d['ip'], 'port': int(d['port'] or 8728), 'key': d['id']} for d in devices
    ])
    for d in devices:
        if not router_status.get(d['id'], False):
            problems.append({
                'id': 'router-{}'.format(d['id']), 'name': d['name'], 'type': 'router',
                'severity': 'critical', 'reason': 'offline', 'detail': '',
            })

    # ── OLT ──
    try:
        olts = conn.execute('SELECT id, name, ip, port FROM olt').fetchall()
    except Exception:
        olts = []
    olt_status = _bulk_status_check([
        {'ip': o['ip'], 'port': int(o['port'] or 23), 'key': o['id']} for o in olts
    ])
    for o in olts:
        if not olt_status.get(o['id'], False):
            problems.append({
                'id': 'olt-{}'.format(o['id']), 'name': o['name'], 'type': 'olt',
                'severity': 'critical', 'reason': 'offline', 'detail': '',
            })

    # ── ONU / Pelanggan ──
    try:
        rows = conn.execute('''
            SELECT p.id, p.username, p.nama, m.rx_power
            FROM pelanggan p
            LEFT JOIN onu_mapping m ON m.username = p.username
            WHERE p.aktif = 1
        ''').fetchall()
    except Exception:
        rows = []

    pppoe = _fetch_pppoe_active(conn, network_id)
    if pppoe is not None:
        online_set = set(pppoe.keys())
    else:
        online_set = {r['username'] for r in rows}  # tanpa MikroTik, anggap semua aktif online

    # Data nama pelanggan di sebagian besar owner ternyata berisi status
    # billing ("Lunas"/"Belum Lunas") bukan nama asli — bug data lama,
    # bukan dibuat di sini. Jangan tampilkan junk itu sebagai "nama" di
    # Problems — fallback ke username (tidak mengubah data di DB).
    _NAMA_JUNK = {'lunas', 'belum lunas', 'sudah lunas'}
    for r in rows:
        username = r['username'] or ''
        raw_nama = (r['nama'] if 'nama' in r.keys() else '') or ''
        display  = username if raw_nama.strip().lower() in _NAMA_JUNK else (raw_nama or username)
        if username not in online_set:
            problems.append({
                'id': 'onu-{}'.format(r['id']), 'name': display, 'type': 'onu',
                'severity': 'critical', 'reason': 'offline', 'detail': '',
            })
            continue
        try:
            rx = float(r['rx_power']) if r['rx_power'] is not None else None
        except (TypeError, ValueError):
            rx = None
        if rx is None:
            continue
        if rx < RX_CRIT_DBM:
            problems.append({
                'id': 'onu-{}'.format(r['id']), 'name': display, 'type': 'onu',
                'severity': 'critical', 'reason': 'redaman_kritis', 'detail': '{:.1f} dBm'.format(rx),
            })
        elif rx < RX_WARN_DBM:
            problems.append({
                'id': 'onu-{}'.format(r['id']), 'name': display, 'type': 'onu',
                'severity': 'warning', 'reason': 'redaman_lemah', 'detail': '{:.1f} dBm'.format(rx),
            })

    # ── Acknowledge: tempel status ack ke problem yg masih aktif, lalu
    # bersihkan ack utk problem yg sudah TIDAK muncul lagi (sudah
    # online/normal) — supaya ack lama tidak menumpuk selamanya. ──
    live_ids = {p['id'] for p in problems}
    ack_rows = conn.execute('SELECT problem_id, acked_by, acked_at FROM problem_ack').fetchall()
    ack_map  = {r['problem_id']: r for r in ack_rows}
    stale_ids = [r['problem_id'] for r in ack_rows if r['problem_id'] not in live_ids]
    if stale_ids:
        conn.executemany('DELETE FROM problem_ack WHERE problem_id = ?', [(sid,) for sid in stale_ids])
        conn.commit()
    for p in problems:
        ack = ack_map.get(p['id'])
        p['acked']    = bool(ack)
        p['acked_by'] = ack['acked_by'] if ack else None
        p['acked_at'] = ack['acked_at'] if ack else None

    problems.sort(key=lambda p: 0 if p['severity'] == 'critical' else 1)
    return problems


@maps_bp.route('/problems', methods=['GET'])
def maps_problems():
    conn = get_db()
    try:
        problems = _compute_problems(conn)
    finally:
        conn.close()

    return jsonify({
        'problems': problems,
        'total':    len(problems),
        'critical': sum(1 for p in problems if p['severity'] == 'critical'),
        'warning':  sum(1 for p in problems if p['severity'] == 'warning'),
    }), 200


# ══════════════════════════════════════════════════════════════
# POST/DELETE /api/maps/problems/<problem_id>/ack
# Acknowledge / batalkan acknowledge 1 problem. problem_id = id stabil
# dari hasil /api/maps/problems (mis. 'onu-15').
# ══════════════════════════════════════════════════════════════

@maps_bp.route('/problems/<problem_id>/ack', methods=['POST'])
def maps_ack_problem(problem_id):
    conn = get_db()
    acted_by = g.current_user.get('username', 'unknown')
    conn.execute('''
        INSERT INTO problem_ack (problem_id, acked_by, acked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(problem_id) DO UPDATE SET acked_by=excluded.acked_by, acked_at=excluded.acked_at
    ''', (problem_id, acted_by, datetime.now().isoformat(timespec='seconds')))
    conn.commit()
    conn.close()
    return jsonify({'status': 'ok', 'acked_by': acted_by}), 200


@maps_bp.route('/problems/<problem_id>/ack', methods=['DELETE'])
def maps_unack_problem(problem_id):
    conn = get_db()
    conn.execute('DELETE FROM problem_ack WHERE problem_id = ?', (problem_id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'ok'}), 200


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
