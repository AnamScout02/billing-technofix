"""
utils.py — TechnoFix · Backend Helpers Terpusat
================================================
Semua fungsi helper yang dipakai bersama oleh:
  api.py, input.py, olt.py, olt_sync.py

Import dari sini agar tidak ada redudansi kode:
  from utils import get_db, try_connect_mikrotik, try_connect_olt,
                    parse_rx_power, olt_to_dict, device_to_dict

Isi:
  1.  DB_PATH & get_db()
  2.  device_to_dict()
  3.  olt_to_dict()
  4.  try_connect_mikrotik()
  5.  try_connect_olt()
  6.  parse_rx_power()       ← NEW: parsing nilai dBm dari string CLI OLT
  7.  parse_huawei_rx()      ← NEW: regex parser khusus Huawei
  8.  parse_zte_rx()         ← NEW: regex parser khusus ZTE
"""

import os
import re
import socket
import logging
import sqlite3

import routeros_api

# ── Setup Logging ──────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════
# 1. PATH DATABASE
# ══════════════════════════════════════════════════════════════

# Lokasi file utils.py ini — diasumsikan ada di folder 'backend/'
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Satu tingkat ke atas → folder 'database/'
DB_PATH = os.path.join(_BASE_DIR, '..', 'database', 'devices.db')


def get_db() -> sqlite3.Connection:
    """
    Buka koneksi SQLite ke devices.db.
    row_factory = sqlite3.Row → hasil query bisa diakses seperti dict.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ══════════════════════════════════════════════════════════════
# 2. DEVICE (MikroTik) → dict
# ══════════════════════════════════════════════════════════════

def device_to_dict(row) -> dict:
    """
    Ubah sqlite3.Row tabel 'devices' → dict.
    Password TIDAK disertakan untuk keamanan frontend.
    """
    return {
        'id':       row['id'],
        'name':     row['name'],
        'ip':       row['ip'],
        'port':     row['port'],
        'username': row['username'],
        'status':   row['status'],
    }


# ══════════════════════════════════════════════════════════════
# 3. OLT → dict
# ══════════════════════════════════════════════════════════════

def olt_to_dict(row) -> dict:
    """
    Ubah sqlite3.Row tabel 'olt' → dict.
    Password TIDAK disertakan untuk keamanan frontend.
    """
    return {
        'id':         row['id'],
        'name':       row['name'],
        'tipe':       row['tipe']        if row['tipe']        else '',
        'ip':         row['ip'],
        'port':       row['port'],
        'username':   row['username'],
        'snmp':       row['snmp']        if row['snmp']        else '',
        'lokasi':     row['lokasi']      if row['lokasi']      else '',
        'keterangan': row['keterangan']  if row['keterangan']  else '',
        'status':     row['status'],
    }


# ══════════════════════════════════════════════════════════════
# 4. KONEKSI MIKROTIK — RouterOS API
# ══════════════════════════════════════════════════════════════

def try_connect_mikrotik(ip: str, port, username: str, password: str):
    """
    Coba koneksi ke MikroTik via RouterOS API.
    Mengembalikan (True, nama_router) jika berhasil,
    atau (False, pesan_error) jika gagal.

    Dipakai oleh: input.py  (tambah/sync perangkat)
    """
    try:
        port_int = int(port) if str(port).strip().isdigit() else 8728

        connection = routeros_api.RouterOsApiPool(
            ip,
            username=username,
            password=password,
            port=port_int,
            plaintext_login=True
        )
        api         = connection.get_api()
        system_id   = api.get_resource('/system/identity').get()
        router_name = system_id[0]['name'] if system_id else ip
        connection.disconnect()

        logger.info(f'[MikroTik] Koneksi OK → {ip}:{port_int} ({router_name})')
        return True, router_name

    except Exception as e:
        msg = 'Gagal terhubung. Periksa IP, port, username, dan password.'
        logger.error(f'[MikroTik] Koneksi gagal ke {ip}:{port} — {e}')
        return False, msg


# ══════════════════════════════════════════════════════════════
# 5. KONEKSI OLT — TCP Socket
# ══════════════════════════════════════════════════════════════

def try_connect_olt(ip: str, port, username: str, password: str):
    """
    Tes koneksi ke OLT dengan membuka socket TCP ke ip:port.
    Jika port terbuka → status 'connected'.

    Untuk koneksi Telnet/SSH penuh, ganti implementasi ini dengan
    librari paramiko (SSH) atau telnetlib (Telnet).

    Dipakai oleh: olt.py  (tambah/sync OLT)
    """
    try:
        port_int = int(port) if str(port).strip().isdigit() else 23
        sock     = socket.create_connection((ip, port_int), timeout=8)
        sock.close()
        logger.info(f'[OLT] Koneksi OK → {ip}:{port_int}')
        return True, f'Berhasil terhubung ke {ip}:{port_int}'

    except socket.timeout:
        msg = f'Koneksi ke {ip}:{port} timeout (8 detik)'
        logger.warning(f'[OLT] {msg}')
        return False, msg

    except ConnectionRefusedError:
        msg = f'Port {port} di {ip} ditolak atau tidak aktif'
        logger.warning(f'[OLT] {msg}')
        return False, msg

    except OSError as e:
        msg = f'Tidak dapat menjangkau {ip}:{port} — {e}'
        logger.error(f'[OLT] {msg}')
        return False, msg


# ══════════════════════════════════════════════════════════════
# 6. PARSE RX POWER — nilai dBm dari string CLI/API
# ══════════════════════════════════════════════════════════════

def parse_rx_power(raw_value) -> float | None:
    """
    Parse nilai daya optik RX/TX dari string CLI OLT atau field API.

    Contoh input yang didukung:
      "-25.50 dBm"    → -25.5
      "-25.50"        → -25.5
      -25.50          → -25.5   (sudah float)
      "N/A"           → None
      ""              → None
      None            → None

    Return: float atau None jika tidak bisa di-parse.
    """
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        return float(raw_value)

    # Hapus satuan dan whitespace
    s = str(raw_value).replace('dBm', '').replace('DBM', '').strip()

    # Coba parse langsung
    try:
        return float(s)
    except ValueError:
        pass

    # Cari pola angka (positif atau negatif, opsional desimal)
    m = re.search(r'(-?\d+(?:\.\d+)?)', s)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass

    return None


# ══════════════════════════════════════════════════════════════
# 7. PARSE RX POWER — Huawei MA5600/MA5800 CLI
# ══════════════════════════════════════════════════════════════

def parse_huawei_rx(cli_output: str) -> dict:
    """
    Parse output perintah Huawei:
      'display ont optical-info <frame/slot/port> <ont-id>'
    atau
      'display pon onu optical-info <card/port> <onu-id>'

    Contoh output:
      Rx optical power(dBm)  : -24.50
      Tx optical power(dBm)  : 2.34

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    # Huawei biasanya pakai format "Rx optical power(dBm)  : -24.50"
    rx_match = re.search(
        r'[Rr]x\s+optical\s+power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )
    tx_match = re.search(
        r'[Tt]x\s+optical\s+power\s*\(?dBm\)?\s*[:\-]\s*(-?\d+(?:\.\d+)?)',
        cli_output
    )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 8. PARSE RX POWER — ZTE C300/C600 CLI
# ══════════════════════════════════════════════════════════════

def parse_zte_rx(cli_output: str) -> dict:
    """
    Parse output perintah ZTE:
      'show pon onu optical-info gpon-onu_<slot/port>:<onu>'
    atau perintah equivalen.

    Contoh output ZTE:
      Rx power   : -25.47 dBm
      Tx power   : 2.10 dBm

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    rx_match = re.search(
        r'[Rr]x\s+power\s*[:\-]\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )
    tx_match = re.search(
        r'[Tt]x\s+power\s*[:\-]\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 9. PARSE RX POWER — Generic / V-Sol / Hioso
# ══════════════════════════════════════════════════════════════

def parse_generic_rx(cli_output: str) -> dict:
    """
    Parser umum untuk merk OLT yang belum dikenal.
    Mencari pola angka dBm di output CLI mana saja.

    Return:
      { 'rx_power': float|None, 'tx_power': float|None }
    """
    result = {'rx_power': None, 'tx_power': None}

    # Cari RX dulu
    rx_match = re.search(
        r'(?:[Rr][Xx]|[Rr]eceive)\s*(?:power|level|signal)?\s*[:\-=]?\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )
    tx_match = re.search(
        r'(?:[Tt][Xx]|[Tt]ransmit)\s*(?:power|level|signal)?\s*[:\-=]?\s*(-?\d+(?:\.\d+)?)\s*dBm',
        cli_output
    )

    if rx_match:
        result['rx_power'] = float(rx_match.group(1))
    if tx_match:
        result['tx_power'] = float(tx_match.group(1))

    return result


# ══════════════════════════════════════════════════════════════
# 10. AMBIL DATA ONU DARI DATABASE
# ══════════════════════════════════════════════════════════════

def get_onu_data(username: str) -> dict:
    """
    Ambil data ONU (slot_port, vlan, sn, rx_power, tx_power, olt_id)
    dari tabel onu_mapping berdasarkan username pelanggan.

    Return dict kosong dengan default jika tidak ditemukan.
    """
    conn = get_db()
    row  = conn.execute(
        '''SELECT slot_port, vlan, sn, olt_id,
                  rx_power, tx_power
           FROM onu_mapping WHERE username = ?''',
        (username,)
    ).fetchone()
    conn.close()

    if row:
        return {
            'slot_port': row['slot_port'] or '',
            'vlan':      row['vlan']      or '',
            'sn':        row['sn']        or '',
            'olt_id':    row['olt_id'],
            'rx_power':  parse_rx_power(row['rx_power']),
            'tx_power':  parse_rx_power(row['tx_power']),
        }

    return {
        'slot_port': '',
        'vlan':      '',
        'sn':        '',
        'olt_id':    None,
        'rx_power':  None,
        'tx_power':  None,
    }