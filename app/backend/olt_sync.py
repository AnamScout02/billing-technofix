"""
olt_sync.py — TechnoFix · Background Worker Sinkronisasi OLT
=============================================================
Worker berjalan terus-menerus (loop setiap 3 menit) dan
menyinkronkan data ONU dari semua OLT yang berstatus 'connected'
ke dalam tabel onu_mapping di database lokal.

✅ PEMBARUAN LENGKAP:

  MODUL 1 — ZTE GPON (C300 / C600 / C650 / C320 / C610)
    • Deteksi otomatis prompt '#' vs '>' → skip enable jika sudah privileged
    • Flag 'no_enable' dari field tipe DB (zte_c320, c320, dsb)
    • Fallback: send_command("enable") tanpa interactive jika perlu

  MODUL 2 — Huawei GPON (MA5600 / MA5800 / MA5616)
    • Tidak berubah, sudah stabil

  MODUL 3 — HSGQ EPON (E04ID / E08ID / seri lain)
    • Login via Telnet ke port non-standar (2424, dsb)
    • enable → configure → interface epon 1..N
    • show onu-info all     → MAC + slot_port
    • show onu-version all  → SN (model number)
    • show optical-info     → Rx/Tx power
    • VLAN diambil dari MikroTik (/interface/vlan + /ppp/active)
    • Jumlah port EPON dari kolom 'epon_ports' di DB (default 4)

  MODUL 4 — V-Sol GPON (V1600D / V1600G / seri V)
    • enable → terminal length 0 → show running-config
    • Parse blok interface epon/gpon
    • VLAN fallback dari MikroTik

  MODUL 5 — Generic / Hioso / OLT tidak dikenal
    • Sama seperti sebelumnya, ditingkatkan dengan VLAN fallback MikroTik

  PATCH VLAN DARI MIKROTIK (semua modul)
    • Setelah sync OLT selesai, jalankan _patch_vlan_from_mikrotik()
    • Update kolom vlan di onu_mapping untuk baris yang vlan-nya masih kosong
    • Sumber: MikroTikClient.get_all_vlan_by_secret()

Menggunakan utils.py untuk helper terpusat:
  get_db(), parse_rx_power, parse_huawei_rx, parse_zte_rx, parse_generic_rx
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

# ── MikroTik client (untuk VLAN fallback) ─────────────────────
from mikrotik import MikroTikClient, MikroTikError

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
# HELPER INTERNAL — Upsert ONU Mapping
# ══════════════════════════════════════════════════════════════

def _upsert_onu(conn, username: str, olt_id: int, slot_port: str,
                sn: str, vlan: str, rx_power, tx_power):
    """
    Insert atau update satu baris di tabel onu_mapping.
    Jika vlan kosong string → pakai COALESCE agar tidak timpa nilai lama.
    rx_power / tx_power None → juga pakai COALESCE.
    """
    now = datetime.now().isoformat()
    if vlan:
        # Punya VLAN → update semua kolom termasuk vlan
        conn.execute(
            '''INSERT INTO onu_mapping
               (username, olt_id, slot_port, sn, vlan, rx_power, tx_power, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET
                 olt_id    = excluded.olt_id,
                 slot_port = excluded.slot_port,
                 sn        = excluded.sn,
                 vlan      = excluded.vlan,
                 rx_power  = COALESCE(excluded.rx_power,  onu_mapping.rx_power),
                 tx_power  = COALESCE(excluded.tx_power,  onu_mapping.tx_power),
                 synced_at = excluded.synced_at
            ''',
            (username, olt_id, slot_port, sn, vlan,
             rx_power, tx_power, now)
        )
    else:
        # VLAN kosong → pertahankan nilai vlan lama (COALESCE)
        conn.execute(
            '''INSERT INTO onu_mapping
               (username, olt_id, slot_port, sn, vlan, rx_power, tx_power, synced_at)
               VALUES (?, ?, ?, ?, '', ?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET
                 olt_id    = excluded.olt_id,
                 slot_port = excluded.slot_port,
                 sn        = excluded.sn,
                 rx_power  = COALESCE(excluded.rx_power,  onu_mapping.rx_power),
                 tx_power  = COALESCE(excluded.tx_power,  onu_mapping.tx_power),
                 synced_at = excluded.synced_at
            ''',
            (username, olt_id, slot_port, sn,
             rx_power, tx_power, now)
        )


# ══════════════════════════════════════════════════════════════
# HELPER — Masuk Mode Privileged (ZTE / Generic)
# ══════════════════════════════════════════════════════════════

def _enter_privileged_zte(ssh_conn, olt: dict) -> bool:
    """
    Masuk ke mode privileged di OLT ZTE.

    Logika (berurutan, berhenti di langkah pertama yang berhasil):
      1. Cek prompt saat ini:
         - Sudah '#' → langsung return True (C320, atau sudah di enable mode)
      2. Cek flag dari field 'tipe' di DB:
         - Mengandung 'c320', 'no_enable', 'noenable' → skip enable, return True
      3. Coba send_interactive dengan password (C300/C600/C650 standar):
         - Kirim 'enable', tunggu 'Password:', kirim password, tunggu 'ZXAN'
         - Ini cara yang benar untuk C300/C600 — jangan gunakan send_command('enable')
           karena ZTE menunggu password → deadlock → timeout → koneksi terputus.
      4. Fallback: send_command('enable') timeout singkat 5 detik
         - Untuk OLT ZTE yang tidak memerlukan password enable (konfigurasi khusus).
      5. Jika semua gagal → return False (sinkronisasi tetap dicoba)

    Selalu aman: tidak raise exception, hanya return bool.
    """
    tipe = (olt.get('tipe') or '').lower()

    # ── Langkah 1: cek prompt saat ini ──
    try:
        current_prompt = ssh_conn.get_prompt()
        logger.debug(f"[ZTE] Prompt awal: '{current_prompt}'")
        if '#' in current_prompt:
            logger.info(f"[{olt['name']}] Sudah di privileged mode (prompt: {current_prompt!r})")
            return True
    except Exception as e:
        logger.warning(f"[{olt['name']}] get_prompt() gagal: {e}")
        current_prompt = ''

    # ── Langkah 2: deteksi dari field tipe ──
    skip_keywords = ('c320', 'no_enable', 'noenable', 'privileged')
    if any(k in tipe for k in skip_keywords):
        logger.info(f"[{olt['name']}] Tipe '{tipe}' → skip enable mode")
        return True

    # ── Langkah 3: interactive enable dengan password (C300/C600/C650) ──
    # PENTING: Jangan gunakan send_command('enable') non-interactive di sini.
    # ZTE C300/C600 dengan prompt '>' membutuhkan password setelah 'enable'.
    # send_command() akan menunggu prompt kembali → deadlock → timeout 15 detik
    # → Scrapli menutup koneksi → semua perintah berikutnya gagal.
    # Solusi: langsung pakai send_interactive yang menangani challenge-response.
    enable_pwd = _extract_enable_pwd(olt)
    try:
        ssh_conn.send_interactive([
            ('enable',     'Password:', False),
            (enable_pwd,   'ZXAN',      True),
        ], timeout_ops=6)
        prompt_after = ssh_conn.get_prompt()
        if '#' in prompt_after:
            logger.info(f"[{olt['name']}] enable interactive berhasil")
            return True
    except Exception as e:
        logger.warning(f"[{olt['name']}] enable interactive gagal: {e} — melanjutkan tanpa enable")

    # ── Langkah 4: fallback — send_command tanpa password ──
    # Untuk OLT ZTE yang tidak memerlukan password enable (konfigurasi khusus).
    try:
        ssh_conn.send_command('enable', timeout_ops=3)
        prompt_after = ssh_conn.get_prompt()
        if '#' in prompt_after:
            logger.info(f"[{olt['name']}] enable tanpa password berhasil, prompt: {prompt_after!r}")
            return True
    except Exception as e:
        logger.debug(f"[{olt['name']}] enable non-interactive fallback: {e}")

    return False


def _extract_enable_pwd(olt: dict) -> str:
    """
    Ambil password enable ZTE dari field 'keterangan' atau 'snmp' di DB
    dengan format: 'enable_pwd=zxr10' atau 'ep=mypassword'.
    Default: 'zxr10'
    """
    for field in ('keterangan', 'snmp'):
        val = olt.get(field, '') or ''
        m   = re.search(r'(?:enable_pwd|ep)=(\S+)', val, re.I)
        if m:
            return m.group(1)
    return 'zxr10'


# ══════════════════════════════════════════════════════════════
# MODUL 1 — ZTE GPON (C300 / C600 / C650 / C320 / C610)
# ══════════════════════════════════════════════════════════════

def sync_zte(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT ZTE GPON.

    Perbaikan vs versi lama:
      • Tidak lagi hardcode send_interactive enable → tergantung prompt
      • Deteksi C320 (langsung # setelah login) → skip enable otomatis
      • Fallback password enable dari field keterangan/snmp di DB

    Data yang diambil:
      - SN        : dari blok interface gpon-olt (running-config)
      - Username  : dari blok interface gpon-onu (field 'name')
      - VLAN      : dari blok service-port (jika ada)
      - RX/TX     : show pon onu optical-info gpon-onu_<iface>
    """
    olt_name    = olt['name']
    match_count = 0

    logger.info(f'[{olt_name}] Sinkronisasi ZTE GPON dimulai...')

    try:
        # ── Masuk privileged mode (cerdas, tidak blocking) ──
        _enter_privileged_zte(ssh_conn, olt)

        # Matikan paginasi agar output tidak terpotong
        ssh_conn.send_command('terminal length 0', timeout_ops=15)

        # ── 1. Tarik running-config satu kali ──
        config_text = ssh_conn.send_command(
            'show running-config', timeout_ops=60
        ).result

        # ── 2. Peta SN dari blok gpon-olt ──
        sn_map = {}
        for port, block in re.findall(
            r'interface gpon-olt_(\d+/\d+/\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            for onu_id, sn in re.findall(
                r'onu\s+(\d+)\s+type\s+\S+\s+sn\s+([\w\d]+)', block
            ):
                sn_map[f'{port}:{onu_id}'] = sn

        # ── 3. Kumpulkan semua ONU dari blok gpon-onu ──
        onu_list = []  # list of (iface, username, vlan, sn)
        for iface, block in re.findall(
            r'interface gpon-onu_(\d+/\d+/\d+:\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            name_match = re.search(r'name\s+([^\r\n]+)', block)
            vlan_match = re.search(r'(?:user-vlan|vlan)\s+(\d+)', block)

            if not name_match:
                continue

            username = name_match.group(1).strip()
            if not username or username.lower() in ('n/a', '-', ''):
                continue

            vlan = vlan_match.group(1) if vlan_match else ''
            sn   = sn_map.get(iface, '')
            onu_list.append((iface, username, vlan, sn))

        # ── 4. Bulk fetch RX power per port (1 request per port, bukan per ONU) ──
        rx_cache = {}  # { port: { iface: rx_power } }
        for iface, *_ in onu_list:
            port = iface.rsplit(':', 1)[0]  # "1/1/1:2" -> "1/1/1"
            if port not in rx_cache:
                rx_cache[port] = _fetch_zte_rx_bulk(ssh_conn, port)

        # ── 5. Simpan ke DB ──
        for iface, username, vlan, sn in onu_list:
            port     = iface.rsplit(':', 1)[0]
            rx_power = rx_cache.get(port, {}).get(iface)
            _upsert_onu(conn, username, olt['id'], iface, sn, vlan,
                        rx_power, None)
            match_count += 1

        conn.commit()
        logger.info(
            f'[{olt_name}] ✅ ZTE GPON: {match_count} ONU tersinkronisasi '
            f'(SN + Nama + VLAN + RX/TX).'
        )

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error ZTE GPON: {e}')


def _fetch_zte_rx_bulk(ssh_conn, port: str) -> dict:
    """
    Ambil RX power semua ONU dalam satu port sekaligus (lebih cepat & stabil).

    Perintah: sh pon power onu-rx gpon-olt_<port>
    Contoh output:
      Onu              Rx power
      gpon-onu_1/1/1:1   -12.300(dbm)
      gpon-onu_1/1/1:2   -25.528(dbm)
      gpon-onu_1/1/1:7   N/A

    Return: dict  { '1/1/1:1': -12.300, '1/1/1:2': -25.528, '1/1/1:7': None, ... }
    """
    result = {}
    try:
        out = ssh_conn.send_command(
            f'sh pon power onu-rx gpon-olt_{port}', timeout_ops=15
        ).result

        # Format: "gpon-onu_1/1/1:1   -12.300(dbm)"
        for m in re.finditer(
            r'gpon-onu_([\d/]+:\d+)\s+([-\d.]+)\s*\(dbm\)',
            out, re.IGNORECASE
        ):
            iface, val = m.group(1), m.group(2)
            try:
                result[iface] = float(val)
            except ValueError:
                result[iface] = None

        # ONU dengan N/A → None (sudah default jika tidak ada di dict)
        if not result:
            logger.debug(f'[ZTE optical bulk] port {port} — tidak ada match, raw:\n{out[:300]}')

    except Exception as e:
        logger.debug(f'[ZTE optical bulk] port {port} error: {e}')

    return result


# ══════════════════════════════════════════════════════════════
# MODUL 2 — Huawei GPON (MA5600 / MA5800 / MA5616)
# ══════════════════════════════════════════════════════════════

def sync_huawei(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT Huawei.

    Data yang diambil:
      - SN   : 'ont add <port> <id> sn <SN>'
      - Name : 'ont description <port> <id> "<name>"'
      - VLAN : 'service-port ... vlan <X> ... gpon <port> ont <id>'
      - RX/TX: 'display ont optical-info <port> <id>'
    """
    olt_name    = olt['name']
    match_count = 0

    logger.info(f'[{olt_name}] Sinkronisasi Huawei GPON dimulai...')

    try:
        # Huawei: prompt sudah di user mode, perlu enable + config
        ssh_conn.send_command('enable',     timeout_ops=15)
        ssh_conn.send_command('config',     timeout_ops=15)
        ssh_conn.send_command('undo smart', timeout_ops=15)

        config_text = ssh_conn.send_command(
            'display current-configuration', timeout_ops=90
        ).result

        # ── Peta SN ──
        sn_map = {}
        for port, ont_id, sn in re.findall(
            r'ont add (\d+/\d+/\d+) (\d+) sn-auth ([A-Z0-9]+)', config_text
        ):
            sn_map[f'{port}:{ont_id}'] = sn
        # Fallback: format lama tanpa sn-auth
        for port, ont_id, sn in re.findall(
            r'ont add (\d+/\d+/\d+) (\d+) sn ([A-Z0-9]+)', config_text
        ):
            key = f'{port}:{ont_id}'
            if key not in sn_map:
                sn_map[key] = sn

        # ── Peta Name (description) ──
        name_map = {}
        for port, ont_id, name in re.findall(
            r'ont description (\d+/\d+/\d+) (\d+) "?([^\r\n"]+)"?', config_text
        ):
            name_map[f'{port}:{ont_id}'] = name.strip()

        # ── Sinkronisasi via service-port ──
        for vlan, port, ont_id in re.findall(
            r'service-port\s+\S+\s+vlan\s+(\d+)\s+.*?gpon\s+(\d+/\d+/\d+)\s+ont\s+(\d+)',
            config_text
        ):
            iface    = f'{port}:{ont_id}'
            username = name_map.get(iface, '')
            sn       = sn_map.get(iface, '')

            if not username or username.lower() in ('n/a', '-', ''):
                continue

            rx_power, tx_power = _get_huawei_optical(ssh_conn, port, ont_id)
            _upsert_onu(conn, username, olt['id'], iface, sn, vlan,
                        rx_power, tx_power)
            match_count += 1

        conn.commit()
        logger.info(f'[{olt_name}] ✅ Huawei GPON: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error Huawei GPON: {e}')


def _get_huawei_optical(ssh_conn, port: str, ont_id: str):
    """
    Ambil RX/TX power ONU Huawei.
    Perintah: display ont optical-info <0/slot/port> <ont-id>
    Return: (rx_power: float|None, tx_power: float|None)
    """
    try:
        out    = ssh_conn.send_command(
            f'display ont optical-info {port} {ont_id}', timeout_ops=10
        ).result
        parsed = parse_huawei_rx(out)
        return parsed.get('rx_power'), parsed.get('tx_power')
    except Exception:
        return None, None


# ══════════════════════════════════════════════════════════════
# MODUL 3 — HSGQ EPON (E04ID / E08ID / seri lain)
# ══════════════════════════════════════════════════════════════
#
# Karakteristik HSGQ EPON:
#   - Port default: 2424 (bukan 23)
#   - Prompt setelah login: HSGQ> (user mode), HSGQ# setelah enable
#   - Tidak ada running-config yang bisa di-parse untuk username
#   - Data ONU per port: show onu-info all
#   - SN (model/versi): show onu-version all
#   - RX/TX: show optical-info
#   - VLAN: TIDAK tersedia dari CLI OLT → ambil dari MikroTik
#   - Jumlah port EPON: dari kolom 'epon_ports' di tabel olt (default 4)
#
# Alur per port EPON:
#   enable → configure → interface epon 1
#   show onu-info all      → MAC + slot_port + link status
#   show onu-version all   → SN (model number sebagai SN)
#   show optical-info      → Rx/Tx power
#   join lewat MAC → { slot_port: { mac, sn, rx, tx } }
#   Loop ke port berikutnya (exit → interface epon 2, dst)
#
# Pemetaan username:
#   HSGQ tidak menyimpan PPPoE username di OLT.
#   Username didapat dari tabel onu_mapping yang sudah ada (join via slot_port
#   atau SN). Jika belum ada → simpan dengan key = MAC address sebagai username
#   sementara, ditandai prefix 'mac:'.
# ══════════════════════════════════════════════════════════════

def sync_hsgq_epon(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT HSGQ EPON (E04ID, E08ID, dsb).

    Karena HSGQ tidak menyimpan PPPoE username:
      - Jika slot_port sudah ada di onu_mapping (dari provisioning manual)
        → update rx_power, tx_power, sn
      - Jika belum ada → simpan dengan username = 'mac:<MAC>' sebagai
        placeholder, agar bisa di-map manual nanti
    """
    olt_name   = olt['name']
    epon_ports = int(olt.get('epon_ports') or 4)  # default 4 port
    match_count = 0

    logger.info(f'[{olt_name}] Sinkronisasi HSGQ EPON dimulai ({epon_ports} port)...')

    try:
        # ── Masuk privileged mode ──
        ssh_conn.send_command('enable',    timeout_ops=15)
        ssh_conn.send_command('configure', timeout_ops=15)

        for port_num in range(1, epon_ports + 1):
            logger.info(f'[{olt_name}] Memproses EPON port {port_num}...')

            try:
                # Masuk ke interface EPON
                ssh_conn.send_command(f'interface epon {port_num}', timeout_ops=5)

                # ── Ambil info ONU (MAC + ONU-ID + status) ──
                info_out = ssh_conn.send_command(
                    'show onu-info all', timeout_ops=15
                ).result

                # ── Ambil versi ONU (model sebagai SN) ──
                ver_out = ssh_conn.send_command(
                    'show onu-version all', timeout_ops=15
                ).result

                # ── Ambil optical info (RX/TX) ──
                opt_out = ssh_conn.send_command(
                    'show optical-info', timeout_ops=15
                ).result

                # ── Parse: MAC + ONU-ID ──
                # Format: ONU-ID  MAC              Status   ...
                #         1       a4:f3:c1:xx:xx:xx Online
                onu_info = {}  # { onu_id_str: { mac, slot_port } }
                for m in re.finditer(
                    r'(\d+)\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+(\w+)',
                    info_out, re.I
                ):
                    onu_id     = m.group(1).strip()
                    mac        = m.group(2).strip().lower()
                    slot_port  = f'{port_num}/{onu_id}'
                    onu_info[onu_id] = {'mac': mac, 'slot_port': slot_port}

                # ── Parse: SN dari show onu-version all ──
                # Format: ONU-ID  Model           Version  ...
                #         1       HG8310M         V3R016C...
                sn_map = {}  # { onu_id: sn_string }
                for m in re.finditer(
                    r'(\d+)\s+([\w\-\.]+)\s+([\w\.]+)', ver_out
                ):
                    onu_id   = m.group(1).strip()
                    model    = m.group(2).strip()
                    version  = m.group(3).strip()
                    # Gabung model+version sebagai SN identifier
                    sn_map[onu_id] = f'{model}-{version}'

                # ── Parse: RX/TX dari show optical-info ──
                # Format: ONU-ID  Rx(dBm)    Tx(dBm)   ...
                #         1       -24.50     2.34
                rx_map = {}  # { onu_id: (rx, tx) }
                for m in re.finditer(
                    r'(\d+)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)', opt_out
                ):
                    onu_id = m.group(1).strip()
                    rx     = parse_rx_power(m.group(2))
                    tx     = parse_rx_power(m.group(3))
                    rx_map[onu_id] = (rx, tx)

                # Fallback: parse dengan label Rx/Tx
                if not rx_map:
                    parsed_opt = parse_generic_rx(opt_out)
                    if parsed_opt.get('rx_power') is not None:
                        # Jika hanya satu nilai global, terapkan ke semua ONU di port ini
                        for onu_id in onu_info:
                            rx_map[onu_id] = (
                                parsed_opt['rx_power'], parsed_opt['tx_power']
                            )

                # ── Simpan ke onu_mapping ──
                for onu_id, info in onu_info.items():
                    mac       = info['mac']
                    slot_port = info['slot_port']
                    sn        = sn_map.get(onu_id, mac)  # fallback ke MAC
                    rx, tx    = rx_map.get(onu_id, (None, None))

                    # Cek apakah slot_port sudah ada di onu_mapping
                    existing = conn.execute(
                        'SELECT username FROM onu_mapping WHERE slot_port = ? AND olt_id = ?',
                        (slot_port, olt['id'])
                    ).fetchone()

                    if existing:
                        # Update data sinyal & SN saja, jangan ubah username
                        username = existing['username']
                    else:
                        # Cek via MAC (username sementara)
                        mac_existing = conn.execute(
                            "SELECT username FROM onu_mapping WHERE username = ?",
                            (f'mac:{mac}',)
                        ).fetchone()
                        username = f'mac:{mac}' if not mac_existing else mac_existing['username']

                    _upsert_onu(conn, username, olt['id'], slot_port,
                                sn, '', rx, tx)  # vlan kosong → MikroTik patch
                    match_count += 1

                # Keluar dari interface sebelum lanjut ke port berikutnya
                ssh_conn.send_command('exit', timeout_ops=5)

            except Exception as e:
                logger.warning(f'[{olt_name}] ⚠ Error di port EPON {port_num}: {e}')
                try:
                    ssh_conn.send_command('exit', timeout_ops=3)
                except Exception:
                    pass
                continue

        conn.commit()
        logger.info(
            f'[{olt_name}] ✅ HSGQ EPON: {match_count} ONU tersinkronisasi '
            f'(VLAN akan di-patch dari MikroTik).'
        )

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error HSGQ EPON: {e}')


# ══════════════════════════════════════════════════════════════
# MODUL 4 — V-Sol GPON (V1600D / V1600G / V1600D4L)
# ══════════════════════════════════════════════════════════════
#
# Karakteristik V-Sol:
#   - Prompt: V-SOL> (user) / V-SOL# (privileged)
#   - Syntax mendekati ZTE tapi ada perbedaan:
#     • Perintah running-config: 'show running-config'
#     • Interface: 'interface gpon-onu_0/1/1:1' (sama seperti ZTE)
#     • SN ada di blok gpon-olt, field 'sn'
#     • Optical: 'show pon onu optical-info gpon-onu_<iface>'
# ══════════════════════════════════════════════════════════════

def sync_vsol(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT V-Sol GPON.

    Syntax V-Sol sangat mirip ZTE, sehingga banyak regex yang sama.
    Perbedaan utama: enable mode tidak selalu butuh password.
    """
    olt_name    = olt['name']
    match_count = 0

    logger.info(f'[{olt_name}] Sinkronisasi V-Sol GPON dimulai...')

    try:
        # ── Masuk privileged mode (V-Sol mirip ZTE C320: langsung #) ──
        current_prompt = ''
        try:
            current_prompt = ssh_conn.get_prompt()
        except Exception:
            pass

        if '#' not in current_prompt:
            try:
                ssh_conn.send_command('enable', timeout_ops=15)
            except Exception:
                pass

        ssh_conn.send_command('terminal length 0', timeout_ops=15)

        config_text = ssh_conn.send_command(
            'show running-config', timeout_ops=60
        ).result

        # ── Peta SN dari blok gpon-olt ──
        sn_map = {}
        for port, block in re.findall(
            r'interface gpon-olt_(\d+/\d+/\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            for onu_id, sn in re.findall(
                r'onu\s+(\d+)\s+type\s+\S+\s+sn\s+([\w\d]+)', block
            ):
                sn_map[f'{port}:{onu_id}'] = sn

        # ── Peta Name & VLAN dari blok gpon-onu ──
        for iface, block in re.findall(
            r'interface gpon-onu_(\d+/\d+/\d+:\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            name_match = re.search(r'name\s+([^\r\n]+)', block)
            vlan_match = re.search(r'(?:user-vlan|vlan)\s+(\d+)', block)

            if not name_match:
                continue

            username = name_match.group(1).strip()
            vlan     = vlan_match.group(1) if vlan_match else ''
            sn       = sn_map.get(iface, '')

            if not username or username.lower() in ('n/a', '-', ''):
                continue

            # V-Sol optical: perintah sama dengan ZTE
            rx_power, tx_power = _get_zte_optical(ssh_conn, iface)

            _upsert_onu(conn, username, olt['id'], iface, sn, vlan,
                        rx_power, tx_power)
            match_count += 1

        conn.commit()
        logger.info(f'[{olt_name}] ✅ V-Sol GPON: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error V-Sol GPON: {e}')


# ══════════════════════════════════════════════════════════════
# MODUL 5 — Generic / Hioso / OLT tidak dikenal
# ══════════════════════════════════════════════════════════════

def sync_generic_olt(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi universal untuk merk OLT yang belum dikenal.
    Mencoba berbagai pola regex yang umum dipakai OLT GPON/EPON.
    Hioso, Cdata, DZS, BDCOM, dan lain-lain.
    """
    olt_name    = olt['name']
    match_count = 0

    logger.info(f'[{olt_name}] Sinkronisasi Generic/Universal dimulai...')

    try:
        # Coba masuk privileged — abaikan error
        try:
            current_prompt = ssh_conn.get_prompt()
            if '#' not in current_prompt:
                ssh_conn.send_command('enable', timeout_ops=15)
        except Exception:
            pass

        ssh_conn.send_command('terminal length 0', timeout_ops=15)

        config_text = ssh_conn.send_command(
            'show running-config', timeout_ops=60
        ).result

        # ── Pola GPON (ZTE-like): interface gpon-onu_ ──
        for iface, block in re.findall(
            r'interface gpon-onu_(\d+/\d+/\d+:\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            _parse_and_upsert_generic(conn, olt, ssh_conn, iface, block, 'gpon')
            match_count += 1

        # ── Pola EPON (ZTE-like): interface epon-onu_ ──
        for iface, block in re.findall(
            r'interface epon-onu_(\d+/\d+:\d+)(.*?)!',
            config_text, re.DOTALL
        ):
            _parse_and_upsert_generic(conn, olt, ssh_conn, iface, block, 'epon')
            match_count += 1

        # ── Pola Hioso / BDCOM: interface onu ──
        for iface, block in re.findall(
            r'interface [Oo][Nn][Uu]\s+(\S+)(.*?)!',
            config_text, re.DOTALL
        ):
            _parse_and_upsert_generic(conn, olt, ssh_conn, iface, block, 'generic')
            match_count += 1

        conn.commit()
        logger.info(f'[{olt_name}] ✅ Generic: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error Generic: {e}')


def _parse_and_upsert_generic(conn, olt, ssh_conn, iface, block, proto):
    """Parse satu blok interface → upsert ke onu_mapping."""
    name_match = re.search(r'(?:name|description|desc)\s+([^\r\n]+)', block)
    sn_match   = re.search(r'sn\s+([A-Z0-9]{8,})', block, re.I)
    vlan_match = re.search(r'(?:user-vlan|vlan)\s+(\d+)', block)

    if not name_match:
        return

    username = name_match.group(1).strip()
    sn       = sn_match.group(1).strip() if sn_match else ''
    vlan     = vlan_match.group(1) if vlan_match else ''

    if not username or username.lower() in ('n/a', '-', ''):
        return

    rx_power, tx_power = _get_generic_optical(ssh_conn, iface, proto)
    _upsert_onu(conn, username, olt['id'], iface, sn, vlan, rx_power, tx_power)


def _get_generic_optical(ssh_conn, iface: str, proto: str = 'gpon'):
    """
    Ambil RX/TX power generic.
    Coba beberapa variasi perintah berdasarkan protokol.
    Return: (rx_power: float|None, tx_power: float|None)
    """
    cmds = []
    if proto == 'gpon':
        cmds = [
            f'show pon onu optical-info gpon-onu_{iface}',
            f'show onu optical-info {iface}',
        ]
    elif proto == 'epon':
        cmds = [
            f'show pon onu optical-info epon-onu_{iface}',
            f'show onu optical-info {iface}',
            f'show optical-info epon-onu_{iface}',
        ]
    else:
        cmds = [
            f'show onu optical-info {iface}',
            f'show optical-info {iface}',
        ]

    for cmd in cmds:
        try:
            out    = ssh_conn.send_command(cmd, timeout_ops=10).result
            parsed = parse_generic_rx(out)
            if parsed.get('rx_power') is not None:
                return parsed.get('rx_power'), parsed.get('tx_power')
        except Exception:
            continue

    return None, None


# ══════════════════════════════════════════════════════════════
# PATCH VLAN DARI MIKROTIK
# ══════════════════════════════════════════════════════════════

def _patch_vlan_from_mikrotik(conn, olt_id: int):
    """
    Setelah sinkronisasi OLT selesai, update kolom 'vlan' di onu_mapping
    untuk baris yang vlan-nya masih kosong.

    Caranya:
      1. Ambil semua row onu_mapping dengan olt_id ini yang vlan = ''
      2. Untuk tiap username, cari di semua device MikroTik yang ada
         via MikroTikClient.get_all_vlan_by_secret()
      3. Jika ketemu → UPDATE onu_mapping SET vlan = ?

    Ini berjalan di background, error tidak menghentikan worker.
    """
    try:
        # Ambil username yang vlan-nya masih kosong
        rows = conn.execute(
            "SELECT username FROM onu_mapping WHERE olt_id = ? AND (vlan = '' OR vlan IS NULL)",
            (olt_id,)
        ).fetchall()

        if not rows:
            logger.info(f'[VLAN Patch] OLT #{olt_id}: semua vlan sudah terisi, skip.')
            return

        usernames_need_vlan = {r['username'] for r in rows
                               if not r['username'].startswith('mac:')}
        if not usernames_need_vlan:
            return

        logger.info(
            f'[VLAN Patch] OLT #{olt_id}: {len(usernames_need_vlan)} username '
            f'butuh VLAN dari MikroTik.'
        )

        # Ambil semua device MikroTik yang connected
        devices = conn.execute(
            "SELECT id, name, ip, port, username, password "
            "FROM devices WHERE status = 'connected'"
        ).fetchall()

        if not devices:
            logger.info('[VLAN Patch] Tidak ada perangkat MikroTik connected, skip.')
            return

        # Kumpulkan VLAN map dari semua device MikroTik
        combined_vlan = {}  # { username: vlan_id }
        for dev in devices:
            try:
                with MikroTikClient(dict(dev)) as mt:
                    vmap = mt.get_all_vlan_by_secret()
                    combined_vlan.update(vmap)
                logger.info(
                    f'[VLAN Patch] MikroTik {dev["name"]}: '
                    f'{len(vmap)} username ter-resolve VLAN'
                )
            except MikroTikError as e:
                logger.warning(f'[VLAN Patch] MikroTik {dev["name"]} gagal: {e}')
            except Exception as e:
                logger.warning(f'[VLAN Patch] MikroTik {dev["name"]} error: {e}')

        # Terapkan VLAN ke onu_mapping
        updated = 0
        for username in usernames_need_vlan:
            vlan = combined_vlan.get(username)
            if vlan:
                conn.execute(
                    'UPDATE onu_mapping SET vlan = ? WHERE username = ?',
                    (str(vlan), username)
                )
                updated += 1

        conn.commit()
        logger.info(
            f'[VLAN Patch] OLT #{olt_id}: {updated}/{len(usernames_need_vlan)} '
            f'username berhasil diperbarui VLAN-nya dari MikroTik.'
        )

    except Exception as e:
        logger.error(f'[VLAN Patch] Error: {e}')


# ══════════════════════════════════════════════════════════════
# FUNGSI UTAMA: SINKRONISASI SEMUA OLT
# ══════════════════════════════════════════════════════════════

# Tabel deteksi tipe OLT
# Format: { keyword_dalam_tipe_atau_prompt: fungsi_sync }
# Urutan penting: lebih spesifik dulu
_TIPE_MAP = [
    # ── ZTE GPON ──────────────────────────────────────────────
    # keyword 'zte', 'c300', 'c600', 'c650', 'c320', 'c610',
    # atau prompt mengandung 'zxan'
    ('zte',  sync_zte),
    ('c300', sync_zte),
    ('c600', sync_zte),
    ('c650', sync_zte),
    ('c320', sync_zte),
    ('c610', sync_zte),
    ('zxan', sync_zte),   # dari prompt

    # ── Huawei GPON ───────────────────────────────────────────
    ('huawei', sync_huawei),
    ('ma5600', sync_huawei),
    ('ma5800', sync_huawei),
    ('ma5616', sync_huawei),

    # ── HSGQ EPON ─────────────────────────────────────────────
    ('hsgq',  sync_hsgq_epon),
    ('epon',  sync_hsgq_epon),   # tipe generik EPON
    ('e04',   sync_hsgq_epon),
    ('e08',   sync_hsgq_epon),

    # ── V-Sol GPON ────────────────────────────────────────────
    ('vsol',   sync_vsol),
    ('v-sol',  sync_vsol),
    ('v1600',  sync_vsol),

    # ── Generic / Hioso / lainnya ─────────────────────────────
    # (fallback, selalu di akhir)
]


def _pilih_sync_func(tipe_db: str, prompt: str):
    """
    Pilih fungsi sinkronisasi berdasarkan field 'tipe' di DB
    dan prompt yang terdeteksi setelah login.

    Prioritas: tipe_db > prompt > generic
    """
    tipe_lower   = tipe_db.lower()
    prompt_lower = prompt.lower()

    for keyword, func in _TIPE_MAP:
        if keyword in tipe_lower or keyword in prompt_lower:
            return func

    return sync_generic_olt  # fallback


def sync_all_olts():
    """
    Iterasi semua OLT yang berstatus 'connected',
    login via Scrapli/Telnet, deteksi merk, jalankan fungsi
    sinkronisasi yang sesuai, lalu patch VLAN dari MikroTik.
    """
    logger.info('═' * 60)
    logger.info('Memulai siklus sinkronisasi masal OLT...')

    conn = get_db()
    olts = conn.execute("SELECT * FROM olt WHERE status = 'connected'").fetchall()

    if not olts:
        logger.info('Tidak ada perangkat OLT yang online. Skip.')
        conn.close()
        return

    for olt in olts:
        olt_dict = dict(olt)
        logger.info(f"Mencoba login ke: {olt['name']} ({olt['ip']}:{olt['port']})")

        # Konfigurasi Scrapli — timeout lebih besar untuk EPON di port non-standar
        device_cfg = {
            'host':                  olt['ip'],
            'port':                  int(olt['port']),
            'auth_username':         olt['username'],
            'auth_password':         olt['password'],
            'auth_strict_key':       False,
            'transport':             'telnet',
            'timeout_socket':        15,   # timeout membuka socket TCP
            'timeout_transport':     20,   # timeout negosiasi transport
            'timeout_ops':           30,   # timeout per perintah
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
                # Deteksi prompt untuk bantuan identifikasi merk
                try:
                    prompt = ssh_conn.get_prompt()
                except Exception:
                    prompt = ''
                logger.info(f"[{olt['name']}] Prompt terdeteksi: '{prompt}'")

                tipe = (olt['tipe'] or '').strip()

                # Pilih fungsi sinkronisasi yang tepat
                sync_func = _pilih_sync_func(tipe, prompt)
                logger.info(
                    f"[{olt['name']}] Menggunakan: {sync_func.__name__} "
                    f"(tipe='{tipe}', prompt='{prompt}')"
                )

                sync_func(ssh_conn, conn, olt_dict)

        except Exception as e:
            logger.error(f"❌ Gagal login ke OLT {olt['name']} ({olt['ip']}:{olt['port']}): {e}")
            continue

        # ── Patch VLAN dari MikroTik setelah setiap OLT selesai ──
        # Berjalan terpisah; error tidak menghentikan OLT berikutnya.
        _patch_vlan_from_mikrotik(conn, olt['id'])

    conn.close()
    logger.info('Siklus sinkronisasi selesai.')
    logger.info('═' * 60)


# ── BACKGROUND LOOP ────────────────────────────────────────────
if __name__ == '__main__':
    logger.info('TechnoFix OLT Sync Worker dimulai.')
    while True:
        try:
            sync_all_olts()
        except Exception as e:
            logger.error(f'Worker error: {e}')

        logger.info('Menunggu 3 menit sebelum sinkronisasi berikutnya...\n')
        time.sleep(180)