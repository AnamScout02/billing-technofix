"""
olt_sync.py — TechnoFix · Background Worker Sinkronisasi OLT
=============================================================
Worker ini berjalan terus-menerus (loop setiap 3 menit) dan
menyinkronkan data ONU dari semua OLT yang berstatus 'connected'
ke dalam tabel onu_mapping di database lokal.

Data yang disinkronkan per ONU:
  - slot_port   : identitas port ONU di OLT
  - sn          : serial number ONU
  - vlan        : VLAN yang dipakai
  - rx_power    : ← BARU: daya terima ONU dalam dBm
  - tx_power    : ← BARU: daya kirim ONU dalam dBm
  - synced_at   : timestamp sinkronisasi terakhir

Menggunakan utils.py untuk fungsi terpusat:
  - get_db(), parse_huawei_rx(), parse_zte_rx(), parse_generic_rx()
"""

import logging
import re
import time
from datetime import datetime

from scrapli.driver.generic import GenericDriver

# ── Shared helpers ─────────────────────────────────────────────
from utils import (
    get_db,
    parse_rx_power,
    parse_huawei_rx,
    parse_zte_rx,
    parse_generic_rx,
)

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)


# ══════════════════════════════════════════════════════════════
# MODUL 1: SINKRONISASI ZTE (C300 / C600 / C650)
# ══════════════════════════════════════════════════════════════

def sync_zte(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT ZTE.

    Data yang diambil:
      - SN: dari blok interface gpon-olt (running-config)
      - Name (username): dari blok interface gpon-onu
      - VLAN: dari blok service-port
      - RX/TX power: ← BARU dari perintah 'show pon onu optical-info'

    Strategi: ambil running-config satu kali → parse dengan regex
    (Mode Ultra-Fast, minimal perintah CLI).
    """
    olt_name    = olt['name']
    match_count = 0

    logging.info(f'[{olt_name}] Sinkronisasi ZTE dimulai...')

    try:
        # Login ke enable mode
        ssh_conn.send_interactive([
            ("enable", "Password:", False),
            ("zxr10",  "ZXAN",     True),
        ])
        ssh_conn.send_command("terminal length 0")

        # ── 1. Tarik running-config ──
        config_text = ssh_conn.send_command("show running-config").result

        # ── 2. Peta SN dari blok gpon-olt ──
        sn_map = {}
        olt_blocks = re.findall(
            r"interface gpon-olt_(\d+/\d+/\d+)(.*?)!",
            config_text, re.DOTALL
        )
        for port, block in olt_blocks:
            for onu_id, sn in re.findall(r"onu (\d+) type .*? sn ([\w\d]+)", block):
                sn_map[f"{port}:{onu_id}"] = sn

        # ── 3. Peta Name & VLAN dari blok gpon-onu ──
        onu_blocks = re.findall(
            r"interface gpon-onu_(\d+/\d+/\d+:\d+)(.*?)!",
            config_text, re.DOTALL
        )

        for iface, block in onu_blocks:
            name_match = re.search(r"name\s+([^\r\n]+)", block)
            vlan_match = re.search(r"vlan\s+(\d+)", block)

            if not name_match:
                continue

            username = name_match.group(1).strip()
            vlan     = vlan_match.group(1) if vlan_match else ''
            sn       = sn_map.get(iface, '')

            if not username or username.lower() == 'n/a':
                continue

            # ── 4. Ambil RX/TX power per ONU ──
            rx_power, tx_power = _get_zte_optical(ssh_conn, iface)

            conn.execute(
                '''INSERT INTO onu_mapping
                   (username, olt_id, slot_port, sn, vlan, rx_power, tx_power, synced_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     olt_id    = excluded.olt_id,
                     slot_port = excluded.slot_port,
                     sn        = excluded.sn,
                     vlan      = excluded.vlan,
                     rx_power  = excluded.rx_power,
                     tx_power  = excluded.tx_power,
                     synced_at = excluded.synced_at
                ''',
                (username, olt['id'], iface, sn, vlan,
                 rx_power, tx_power, datetime.now().isoformat())
            )
            match_count += 1

        conn.commit()
        logging.info(f'[{olt_name}] ✅ ZTE: {match_count} ONU tersinkronisasi (SN + Nama + VLAN + RX/TX).')

    except Exception as e:
        logging.error(f'[{olt_name}] ❌ Error ZTE: {e}')


def _get_zte_optical(ssh_conn, iface: str):
    """
    Ambil nilai RX/TX power dari ONU ZTE berdasarkan interface.

    Contoh perintah:
      show pon onu optical-info gpon-onu_0/1/1:3

    Return: (rx_power: float|None, tx_power: float|None)
    """
    try:
        out    = ssh_conn.send_command(f'show pon onu optical-info gpon-onu_{iface}').result
        parsed = parse_zte_rx(out)
        return parsed.get('rx_power'), parsed.get('tx_power')
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════
# MODUL 2: SINKRONISASI HUAWEI (MA5600 / MA5800)
# ══════════════════════════════════════════════════════════════

def sync_huawei(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT Huawei.

    Data yang diambil:
      - SN: 'ont add <port> <id> sn <SN>'
      - Name: 'ont description <port> <id> "<name>"'
      - VLAN: 'service-port ... vlan <X> ... gpon <port> ont <id>'
      - RX/TX: 'display ont optical-info <port> <id>'
    """
    olt_name    = olt['name']
    match_count = 0

    logging.info(f'[{olt_name}] Sinkronisasi Huawei dimulai...')

    try:
        ssh_conn.send_command("enable")
        ssh_conn.send_command("config")
        ssh_conn.send_command("undo smart")

        config_text = ssh_conn.send_command("display current-configuration").result

        # ── Peta SN ──
        sn_map = {}
        for port, ont_id, sn in re.findall(
            r"ont add (\d+/\d+/\d+) (\d+) sn ([A-Z0-9]+)", config_text
        ):
            sn_map[f"{port}:{ont_id}"] = sn

        # ── Peta Name ──
        name_map = {}
        for port, ont_id, name in re.findall(
            r'ont description (\d+/\d+/\d+) (\d+) "?([^\r\n"]+)"?', config_text
        ):
            name_map[f"{port}:{ont_id}"] = name.strip()

        # ── Sinkronisasi via service-port ──
        for vlan, port, ont_id in re.findall(
            r"service-port.*?vlan (\d+).*?gpon (\d+/\d+/\d+) ont (\d+)", config_text
        ):
            iface    = f"{port}:{ont_id}"
            username = name_map.get(iface, '')
            sn       = sn_map.get(iface, '')

            if not username or username.lower() == 'n/a':
                continue

            # ── Ambil RX/TX power ──
            rx_power, tx_power = _get_huawei_optical(ssh_conn, port, ont_id)

            conn.execute(
                '''INSERT INTO onu_mapping
                   (username, olt_id, slot_port, sn, vlan, rx_power, tx_power, synced_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     olt_id    = excluded.olt_id,
                     slot_port = excluded.slot_port,
                     sn        = excluded.sn,
                     vlan      = excluded.vlan,
                     rx_power  = excluded.rx_power,
                     tx_power  = excluded.tx_power,
                     synced_at = excluded.synced_at
                ''',
                (username, olt['id'], iface, sn, vlan,
                 rx_power, tx_power, datetime.now().isoformat())
            )
            match_count += 1

        conn.commit()
        logging.info(f'[{olt_name}] ✅ Huawei: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logging.error(f'[{olt_name}] ❌ Error Huawei: {e}')


def _get_huawei_optical(ssh_conn, port: str, ont_id: str):
    """
    Ambil RX/TX power dari ONU Huawei.

    Contoh perintah:
      display ont optical-info 0/1/1 3

    Return: (rx_power: float|None, tx_power: float|None)
    """
    try:
        out    = ssh_conn.send_command(f'display ont optical-info {port} {ont_id}').result
        parsed = parse_huawei_rx(out)
        return parsed.get('rx_power'), parsed.get('tx_power')
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════
# MODUL 3: SINKRONISASI GENERIC (V-Sol, HSGQ, Hioso, dll)
# ══════════════════════════════════════════════════════════════

def sync_generic_olt(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi universal untuk merk OLT yang belum dikenal.
    Regex lebih fleksibel, cocok untuk V-Sol / HSGQ / Hioso.
    """
    olt_name    = olt['name']
    match_count = 0

    logging.info(f'[{olt_name}] Sinkronisasi Universal dimulai...')

    try:
        ssh_conn.send_command("enable")
        ssh_conn.send_command("terminal length 0")

        config_text = ssh_conn.send_command("show running-config").result

        onu_blocks = re.findall(
            r"interface (?:gpon|epon)-onu_(\d+/\d+:\d+)(.*?)!",
            config_text, re.DOTALL
        )

        for iface, block in onu_blocks:
            name_match = re.search(r"name\s+([^\r\n]+)", block)
            sn_match   = re.search(r"sn\s+([A-Z0-9]+)", block)
            vlan_match = re.search(r"vlan\s+(\d+)", block)

            if not (name_match and sn_match):
                continue

            username = name_match.group(1).strip()
            sn       = sn_match.group(1).strip()
            vlan     = vlan_match.group(1) if vlan_match else ''

            if not username or username.lower() == 'n/a':
                continue

            # Coba ambil RX/TX (generic)
            rx_power, tx_power = _get_generic_optical(ssh_conn, iface)

            conn.execute(
                '''INSERT INTO onu_mapping
                   (username, olt_id, slot_port, sn, vlan, rx_power, tx_power, synced_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET
                     olt_id    = excluded.olt_id,
                     slot_port = excluded.slot_port,
                     sn        = excluded.sn,
                     vlan      = excluded.vlan,
                     rx_power  = excluded.rx_power,
                     tx_power  = excluded.tx_power,
                     synced_at = excluded.synced_at
                ''',
                (username, olt['id'], iface, sn, vlan,
                 rx_power, tx_power, datetime.now().isoformat())
            )
            match_count += 1

        conn.commit()
        logging.info(f'[{olt_name}] ✅ Universal: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logging.error(f'[{olt_name}] ❌ Error Universal: {e}')


def _get_generic_optical(ssh_conn, iface: str):
    """
    Ambil RX/TX power generic.

    Return: (rx_power: float|None, tx_power: float|None)
    """
    try:
        out    = ssh_conn.send_command(f'show onu optical-info {iface}').result
        parsed = parse_generic_rx(out)
        return parsed.get('rx_power'), parsed.get('tx_power')
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════
# FUNGSI UTAMA: SINKRONISASI SEMUA OLT
# ══════════════════════════════════════════════════════════════

def sync_all_olts():
    """
    Iterasi semua OLT yang berstatus 'connected',
    login via Scrapli, deteksi merk, jalankan fungsi sinkronisasi
    yang sesuai.
    """
    logging.info('═' * 60)
    logging.info('Memulai siklus sinkronisasi masal OLT...')

    conn = get_db()
    olts = conn.execute("SELECT * FROM olt WHERE status = 'connected'").fetchall()

    if not olts:
        logging.info('Tidak ada perangkat OLT yang online. Skip.')
        conn.close()
        return

    for olt in olts:
        olt_dict = dict(olt)
        logging.info(f"Mencoba login ke: {olt['name']} ({olt['ip']}:{olt['port']})")

        device_cfg = {
            'host':                  olt['ip'],
            'port':                  int(olt['port']),
            'auth_username':         olt['username'],
            'auth_password':         olt['password'],
            'auth_strict_key':       False,
            'transport':             'telnet',
            'timeout_ops':           20,
            'comms_prompt_pattern':  r'.*[>#\$]',
            'transport_options': {
                'telnet': {
                    'auth_username_pattern': r'(?i)(?:user\s?name|login|user)\s*?:',
                    'auth_password_pattern': r'(?i)password\s*?:',
                }
            },
        }

        try:
            with GenericDriver(**device_cfg) as ssh_conn:
                # Deteksi otomatis merk OLT dari prompt CLI
                prompt = ssh_conn.get_prompt().lower()
                logging.info(f"Prompt terdeteksi: '{prompt}'")

                tipe = (olt['tipe'] or '').lower()

                # Prioritas: field 'tipe' di DB, fallback ke prompt
                if 'zte' in tipe or 'zxan' in prompt:
                    sync_zte(ssh_conn, conn, olt_dict)
                elif 'huawei' in tipe or 'huawei' in prompt or 'ma56' in prompt:
                    sync_huawei(ssh_conn, conn, olt_dict)
                else:
                    sync_generic_olt(ssh_conn, conn, olt_dict)

        except Exception as e:
            logging.error(f"❌ Gagal login ke OLT {olt['name']}: {e}")

    conn.close()
    logging.info('Siklus sinkronisasi selesai.')
    logging.info('═' * 60)


# ── BACKGROUND LOOP ────────────────────────────────────────────
if __name__ == '__main__':
    logging.info('TechnoFix OLT Sync Worker dimulai.')
    while True:
        try:
            sync_all_olts()
        except Exception as e:
            logging.error(f'Worker error: {e}')

        logging.info('Menunggu 3 menit sebelum sinkronisasi berikutnya...\n')
        time.sleep(180)