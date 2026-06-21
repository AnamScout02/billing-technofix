"""
diagnostik.py — TechnoFix-Bill · Blueprint Diagnostik Jaringan
==========================================================
Endpoint diagnostik (ping) yang dijalankan dari MikroTik milik owner
lewat librouteros (MikroTikClient), bukan dari server pusat — supaya
hasil ping mencerminkan jalur jaringan ISP yang sebenarnya.

Daftarkan di input.py:
  from diagnostik import diagnostik_bp
  app.register_blueprint(diagnostik_bp, url_prefix='/api/diagnostik')
"""

import logging
import threading
import time
import uuid
from flask import Blueprint, request, jsonify, g
from utils import get_db
from mikrotik import MikroTikClient, MikroTikError

diagnostik_bp = Blueprint('diagnostik', __name__)
logger = logging.getLogger(__name__)


# ── Guard multi-tenant: login + cek lock langganan + permission ───
@diagnostik_bp.before_request
def _diagnostik_guard():
    if request.method == 'OPTIONS':
        return
    from auth import guard_request
    return guard_request(perm='perangkat')


# ══════════════════════════════════════════════════════════════
# PING — via MikroTik owner
# ══════════════════════════════════════════════════════════════

@diagnostik_bp.route('/ping', methods=['POST'])
def ping_target():
    data = request.get_json(force=True) or {}
    device_id = data.get('device_id')
    target = (data.get('target') or '').strip()
    count = max(1, min(int(data.get('count', 4)), 10))
    size = max(1, min(int(data.get('size', 64)), 1500))

    if not device_id or not target or len(target) > 255:
        return jsonify({'error': 'device_id dan target wajib diisi'}), 400

    conn = get_db()
    device = conn.execute(
        'SELECT id, name, ip, port, username, password FROM devices WHERE id=?',
        (device_id,)
    ).fetchone()
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    try:
        with MikroTikClient(dict(device)) as mt:
            rows = mt.ping(target, count=count, size=size)
    except MikroTikError as e:
        return jsonify({'error': str(e)}), 502

    packets = [r for r in rows if 'seq' in r]
    summary_raw = rows[-1] if rows and 'seq' not in rows[-1] else {}
    sent = int(summary_raw.get('sent', count))
    received = int(summary_raw.get('received', len(packets)))
    summary = {
        'sent': sent,
        'received': received,
        'lost': sent - received,
        'loss_pct': round((sent - received) / sent * 100, 1) if sent else 0,
        'min_rtt': summary_raw.get('min-rtt'),
        'avg_rtt': summary_raw.get('avg-rtt'),
        'max_rtt': summary_raw.get('max-rtt'),
    }
    return jsonify({
        'device': device['name'],
        'target': target,
        'size': size,
        'packets': packets,
        'summary': summary,
    })


# ══════════════════════════════════════════════════════════════
# TRACEROUTE — live per-hop via MikroTik owner
# Traceroute di RouterOS adalah 1 command yang terus mengirim update
# per-hop sampai selesai (bukan request-response sekali jadi seperti
# ping), jadi dijalankan di background thread + di-poll statusnya oleh
# frontend lewat job_id. State job disimpan in-memory saja (bukan DB) —
# cukup untuk skala 1 server, sesuai gaya project ini (hindari
# over-engineering dengan queue/Redis untuk kebutuhan sesederhana ini).
# ══════════════════════════════════════════════════════════════

_tr_jobs: dict = {}
_tr_lock = threading.Lock()
_TR_JOB_TTL = 600          # detik — bersihkan job selesai yang sudah lama
_TR_ROUND_COUNT = 1        # probe per hop tiap putaran (mirip ping count=1 — supaya tiap putaran cepat & sering refresh)
_TR_ROUND_PAUSE = 1        # detik, jeda antar putaran supaya tidak membanjiri MikroTik
_TR_MAX_SESSION = 1800     # detik (30 menit) — jaga2 kalau user lupa klik Hentikan / tab ditutup tanpa stop


def _tr_cleanup():
    cutoff = time.time() - _TR_JOB_TTL
    with _tr_lock:
        stale = [jid for jid, v in _tr_jobs.items()
                  if v.get('finished_at') and v['finished_at'] < cutoff]
        for jid in stale:
            del _tr_jobs[jid]


def _tr_worker(job_id, device_row, target, max_hops):
    """Traceroute LIVE seperti ping: jalankan satu putaran (count=1),
    perbarui tabel hop yang terakumulasi, lalu putaran baru lagi — terus
    sampai status job diubah jadi 'stopping' (lewat endpoint stop) atau
    kena batas waktu sesi maksimum."""
    job = _tr_jobs[job_id]
    order = []           # urutan kemunculan host pertama kali (= hop order)
    hops_by_host = {}
    t0 = time.time()
    try:
        with MikroTikClient(device_row) as mt:
            job['client'] = mt
            while job['status'] == 'running':
                if time.time() - t0 > _TR_MAX_SESSION:
                    job['status'] = 'timeout'
                    break
                for row in mt.traceroute_stream(target, max_hops=max_hops, count=_TR_ROUND_COUNT):
                    if job['status'] != 'running':
                        break
                    host = row.get('address') or row.get('host') or row.get('status')
                    if not host:
                        continue
                    if host not in hops_by_host:
                        order.append(host)
                    hops_by_host[host] = row
                    with _tr_lock:
                        job['hops'] = [
                            dict(hops_by_host[h], hop=i + 1) for i, h in enumerate(order)
                        ]
                if job['status'] != 'running':
                    break
                time.sleep(_TR_ROUND_PAUSE)
        with _tr_lock:
            if job['status'] == 'stopping':
                job['status'] = 'stopped'
            elif job['status'] == 'running':
                job['status'] = 'done'
    except MikroTikError as e:
        with _tr_lock:
            # Kalau lagi proses stop, koneksi yang ditutup paksa (abort())
            # juga memunculkan MikroTikError di sini — itu bukan error
            # sungguhan, cuma efek dari permintaan stop.
            if job['status'] == 'stopping':
                job['status'] = 'stopped'
            else:
                job['status'] = 'error'
                job['error'] = str(e)
    finally:
        with _tr_lock:
            job['client'] = None
            job['finished_at'] = time.time()


@diagnostik_bp.route('/traceroute/start', methods=['POST'])
def traceroute_start():
    data = request.get_json(force=True) or {}
    device_id = data.get('device_id')
    target = (data.get('target') or '').strip()
    max_hops = max(1, min(int(data.get('max_hops', 15)), 30))

    if not device_id or not target or len(target) > 255:
        return jsonify({'error': 'device_id dan target wajib diisi'}), 400

    conn = get_db()
    device = conn.execute(
        'SELECT id, name, ip, port, username, password FROM devices WHERE id=?',
        (device_id,)
    ).fetchone()
    if not device:
        return jsonify({'error': 'Perangkat tidak ditemukan'}), 404

    _tr_cleanup()

    job_id = uuid.uuid4().hex
    with _tr_lock:
        _tr_jobs[job_id] = {
            'status': 'running',
            'hops': [],
            'error': None,
            'client': None,
            'network_id': g.network_id,
            'finished_at': None,
        }

    threading.Thread(
        target=_tr_worker,
        args=(job_id, dict(device), target, max_hops),
        daemon=True,
        name=f'traceroute-{job_id[:8]}',
    ).start()

    return jsonify({'job_id': job_id, 'device': device['name'], 'target': target})


@diagnostik_bp.route('/traceroute/status/<job_id>', methods=['GET'])
def traceroute_status(job_id):
    job = _tr_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job tidak ditemukan'}), 404
    if job['network_id'] != g.network_id:
        return jsonify({'error': 'Job tidak ditemukan'}), 404

    return jsonify({
        'status': job['status'],
        'hops': job['hops'],
        'error': job['error'],
    })


@diagnostik_bp.route('/traceroute/stop/<job_id>', methods=['POST'])
def traceroute_stop(job_id):
    job = _tr_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job tidak ditemukan'}), 404
    if job['network_id'] != g.network_id:
        return jsonify({'error': 'Job tidak ditemukan'}), 404

    with _tr_lock:
        if job['status'] == 'running':
            job['status'] = 'stopping'
        client = job.get('client')
    if client is not None:
        client.abort()

    return jsonify({'status': job['status']})
