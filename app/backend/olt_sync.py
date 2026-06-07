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
import socket
from datetime import datetime

from scrapli.driver.generic import GenericDriver

# ── Shared helpers ─────────────────────────────────────────────
from utils import (
    get_db,
    get_owner_db,
    get_master_db,
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
        ], timeout_ops=15)
        prompt_after = ssh_conn.get_prompt()
        if '#' in prompt_after:
            logger.info(f"[{olt['name']}] enable interactive berhasil")
            return True
    except Exception as e:
        logger.warning(f"[{olt['name']}] enable interactive gagal: {e} — melanjutkan tanpa enable")

    # ── Langkah 4: fallback — send_command tanpa password ──
    # Untuk OLT ZTE yang tidak memerlukan password enable (konfigurasi khusus).
    try:
        ssh_conn.send_command('enable', timeout_ops=10)
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
        ssh_conn.send_command('terminal length 0', timeout_ops=30)

        # ── 1. Tarik config — coba running-config, fallback ke startup-config ──
        # ZTE C300/C600: pakai show running-config
        # ZTE C320/beberapa model lain: pakai show startup-config
        config_text = ''
        for cfg_cmd in ('show running-config', 'show startup-config'):
            try:
                result = ssh_conn.send_command(cfg_cmd, timeout_ops=120).result
                if result and len(result.strip()) > 100:
                    config_text = result
                    logger.info(f'[{olt["name"]}] Config via: {cfg_cmd} ({len(config_text)} chars)')
                    break
                logger.warning(f'[{olt["name"]}] {cfg_cmd} output pendek ({len(result)} chars), coba berikutnya...')
            except Exception as e:
                logger.warning(f'[{olt["name"]}] {cfg_cmd} gagal: {e}, coba berikutnya...')

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

        # ── 4. Bulk fetch per port: RX, TX, phase state, ONU liar ──
        unique_ports = {iface.rsplit(':', 1)[0] for iface, *_ in onu_list}
        rx_cache    = {}
        tx_cache    = {}
        state_cache = {}
        unauth_all  = []

        for port in unique_ports:
            rx_cache[port]    = _fetch_zte_rx_bulk(ssh_conn, port)
            tx_cache[port]    = _fetch_zte_tx_bulk(ssh_conn, port)
            state_cache[port] = _fetch_zte_onu_state_bulk(ssh_conn, port)
            unauth_all.extend(_fetch_zte_unauthorized(ssh_conn, port))

        # ── 5. Simpan ONU ke DB ──
        for iface, username, vlan, sn in onu_list:
            port     = iface.rsplit(':', 1)[0]
            rx_power = rx_cache.get(port, {}).get(iface)
            tx_power = tx_cache.get(port, {}).get(iface)
            _upsert_onu(conn, username, olt['id'], iface, sn, vlan,
                        rx_power, tx_power)
            match_count += 1

        # ── 6. Update is_online dari phase state OLT ──
        for port, state_map in state_cache.items():
            for iface, online in state_map.items():
                conn.execute(
                    'UPDATE onu_mapping SET is_online=? WHERE olt_id=? AND slot_port=?',
                    (online, olt['id'], iface)
                )

        # ── 7. Simpan ONU liar (unauthorized) ke tabel onu_liar ──
        now = datetime.now().isoformat()
        for port in unique_ports:
            conn.execute(
                'DELETE FROM onu_liar WHERE olt_id=? AND port=?',
                (olt['id'], port)
            )
        for u in unauth_all:
            conn.execute(
                'INSERT OR IGNORE INTO onu_liar (olt_id, sn, port, detected_at) VALUES (?,?,?,?)',
                (olt['id'], u['sn'], u['port'], now)
            )
        if unauth_all:
            logger.info(f'[{olt_name}] {len(unauth_all)} ONU liar disimpan ke onu_liar.')

        conn.commit()
        logger.info(
            f'[{olt_name}] ZTE GPON: {match_count} ONU tersinkronisasi '
            f'(RX+TX+phase state). ONU liar: {len(unauth_all)}.'
        )

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ Error ZTE GPON: {e}')


def _fetch_zte_rx_bulk(ssh_conn, port: str) -> dict:
    """
    Ambil RX power semua ONU dalam satu port sekaligus.
    Perintah: sh pon power onu-rx gpon-olt_<port>
    Return: { 'iface': rx_power_float_or_None }
    """
    result = {}
    try:
        out = ssh_conn.send_command(
            f'sh pon power onu-rx gpon-olt_{port}', timeout_ops=15
        ).result
        for m in re.finditer(
            r'gpon-onu_([\d/]+:\d+)\s+([-\d.]+)\s*\(dbm\)',
            out, re.IGNORECASE
        ):
            iface, val = m.group(1), m.group(2)
            try:
                result[iface] = float(val)
            except ValueError:
                result[iface] = None
        if not result:
            logger.debug(f'[ZTE RX bulk] port {port} — tidak ada match, raw:\n{out[:300]}')
    except Exception as e:
        logger.debug(f'[ZTE RX bulk] port {port} error: {e}')
    return result


def _fetch_zte_tx_bulk(ssh_conn, port: str) -> dict:
    """
    Ambil TX power semua ONU dalam satu port sekaligus.
    Perintah: sh pon power onu-tx gpon-olt_<port>
    Return: { 'iface': tx_power_float_or_None }
    """
    result = {}
    try:
        out = ssh_conn.send_command(
            f'sh pon power onu-tx gpon-olt_{port}', timeout_ops=15
        ).result
        for m in re.finditer(
            r'gpon-onu_([\d/]+:\d+)\s+([-\d.]+)\s*\(dbm\)',
            out, re.IGNORECASE
        ):
            iface, val = m.group(1), m.group(2)
            try:
                result[iface] = float(val)
            except ValueError:
                result[iface] = None
        if not result:
            logger.debug(f'[ZTE TX bulk] port {port} — tidak ada match')
    except Exception as e:
        logger.debug(f'[ZTE TX bulk] port {port} error: {e}')
    return result


def _fetch_zte_onu_state_bulk(ssh_conn, port: str) -> dict:
    """
    Ambil phase state semua ONU dalam satu port.
    Perintah: sh pon onu stat gpon-olt_<port>
    Output:
      OnuIndex               Admin State  OMCC State   O7 State     Phase State
      gpon-onu_1/1/1:1       enable       enable       operation    working
      gpon-onu_1/1/1:2       enable       enable       operation    dying-gasp
    Return: { 'iface': 1_atau_0 }  (1=working/online di level optik)
    """
    result = {}
    try:
        out = ssh_conn.send_command(
            f'sh pon onu stat gpon-olt_{port}', timeout_ops=15
        ).result
        for m in re.finditer(
            r'gpon-onu_([\d/]+:\d+)\s+\S+\s+\S+\s+\S+\s+(\S+)',
            out, re.IGNORECASE
        ):
            iface = m.group(1)
            phase = m.group(2).lower()
            result[iface] = 1 if phase == 'working' else 0
        if not result:
            logger.debug(f'[ZTE state bulk] port {port} — tidak ada match')
    except Exception as e:
        logger.debug(f'[ZTE state bulk] port {port} error: {e}')
    return result


def _fetch_zte_unauthorized(ssh_conn, port: str) -> list:
    """
    Ambil ONU yang konek tapi belum diprovisi (unauthorized/liar).
    Perintah: show pon unauthorized-onu gpon-olt_<port>
    Output contoh:
      Onu               Sn              Vendor-Id  Model-Id
      gpon-onu_1/1/1:0  ZTEG12345678    ZTE        F609
    Return: list of { 'sn': str, 'port': str }
    """
    result = []
    try:
        out = ssh_conn.send_command(
            f'show pon unauthorized-onu gpon-olt_{port}', timeout_ops=15
        ).result
        # Format utama: gpon-onu_... diikuti SN 8+ char alphanum
        for m in re.finditer(
            r'gpon-onu_[\d/]+:\d+\s+([A-Z0-9]{8,})',
            out, re.IGNORECASE
        ):
            result.append({'sn': m.group(1).upper(), 'port': port})
        # Fallback: "SN: ZTEGXXXX" atau "sn ZTEGXXXX"
        if not result:
            for m in re.finditer(r'\bsn[:\s]+([A-Z0-9]{8,})', out, re.IGNORECASE):
                result.append({'sn': m.group(1).upper(), 'port': port})
        if result:
            logger.info(f'[ZTE unauthorized] port {port}: {len(result)} ONU liar terdeteksi')
    except Exception as e:
        logger.debug(f'[ZTE unauthorized] port {port} error: {e}')
    return result


def _get_zte_optical(ssh_conn, iface: str):
    """
    Ambil RX/TX power satu ONU ZTE per-interface (dipakai sync_vsol).
    Perintah: show pon onu optical-info gpon-onu_<iface>
    Return: (rx_power: float|None, tx_power: float|None)
    Catatan: gunakan _fetch_zte_rx_bulk/_fetch_zte_tx_bulk untuk ZTE asli
    karena lebih efisien (1 request per port, bukan per ONU).
    """
    try:
        out    = ssh_conn.send_command(
            f'show pon onu optical-info gpon-onu_{iface}', timeout_ops=10
        ).result
        parsed = parse_zte_rx(out)
        return parsed.get('rx_power'), parsed.get('tx_power')
    except Exception:
        return None, None


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

class SimpleTelnet:
    """Drop-in pengganti telnetlib.Telnet untuk Python 3.13+.
    Hanya expose method yang dipakai kode HSGQ: read_until, write,
    read_very_eager, sock (langsung), dan close.
    Handle IAC negotiation otomatis (DONT/WONT semua opsi)."""

    _IAC  = 255
    _DO   = 253
    _DONT = 254
    _WILL = 251
    _WONT = 252
    _SB   = 250
    _SE   = 240

    def __init__(self, host: str, port: int, timeout: float = 20):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self._buf = b''

    def _strip_iac(self, data: bytes) -> bytes:
        out = b''
        i = 0
        while i < len(data):
            b = data[i]
            if b == self._IAC and i + 1 < len(data):
                cmd = data[i + 1]
                if cmd in (self._DO, self._DONT, self._WILL, self._WONT) and i + 2 < len(data):
                    opt = data[i + 2]
                    reply = self._WONT if cmd == self._DO else self._DONT
                    try:
                        self.sock.sendall(bytes([self._IAC, reply, opt]))
                    except Exception:
                        pass
                    i += 3
                elif cmd == self._SB:
                    end = data.find(bytes([self._IAC, self._SE]), i + 2)
                    i = end + 2 if end != -1 else len(data)
                elif cmd == self._IAC:
                    out += bytes([self._IAC])
                    i += 2
                else:
                    i += 2
            else:
                out += bytes([b])
                i += 1
        return out

    def read_until(self, expected: bytes, timeout: float = None) -> bytes:
        import time
        deadline = time.monotonic() + (timeout if timeout is not None else 30)
        while True:
            if expected in self._buf:
                idx = self._buf.index(expected) + len(expected)
                result, self._buf = self._buf[:idx], self._buf[idx:]
                return result
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                result, self._buf = self._buf, b''
                return result
            self.sock.settimeout(min(remaining, 2.0))
            try:
                chunk = self.sock.recv(4096)
                if chunk:
                    self._buf += self._strip_iac(chunk)
            except (socket.timeout, OSError):
                pass

    def write(self, data: bytes):
        self.sock.sendall(data)

    def read_very_eager(self) -> bytes:
        saved = self.sock.gettimeout()
        self.sock.settimeout(0)
        raw = b''
        try:
            while True:
                chunk = self.sock.recv(4096)
                if not chunk:
                    break
                raw += self._strip_iac(chunk)
        except (BlockingIOError, socket.timeout, OSError):
            pass
        finally:
            self.sock.settimeout(saved)
        result = self._buf + raw
        self._buf = b''
        return result

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def _hsgq_cmd(tn, cmd: str, wait: float = 1.5, timeout: float = 20) -> str:
    """Kirim perintah ke OLT HSGQ via telnetlib dan kembalikan output."""
    tn.write(cmd.encode('ascii') + b'\r\n')
    time.sleep(wait)
    out = b''
    tn.sock.settimeout(timeout)
    try:
        while True:
            chunk = tn.read_very_eager()
            if not chunk:
                break
            out += chunk
            time.sleep(0.3)
    except Exception:
        pass
    return out.decode('latin-1', errors='replace')


def _hsgq_read(tn, prompt: bytes, timeout: float = 40) -> str:
    """Baca output sampai prompt muncul, handle --More-- (paging OLT HSGQ).
    Kembalikan string latin-1.
    Toleransi 2x empty berturut sebelum break — menghindari putus prematur saat
    OLT sedang memproses perintah (jeda singkat antara data dan prompt)."""
    import time as _time
    deadline   = _time.monotonic() + timeout
    buf        = b''
    empty_runs = 0
    while _time.monotonic() < deadline:
        remaining = max(1.0, deadline - _time.monotonic())
        chunk = tn.read_until(
            prompt if b'More' not in buf[-20:] else b'--More--',
            timeout=min(remaining, 5.0)
        )
        buf += chunk
        if prompt in buf:
            break
        if b'--More--' in buf or b'-- More --' in buf:
            tn.write(b' ')
            buf = buf.replace(b'--More--', b'').replace(b'-- More --', b'')
            empty_runs = 0
        elif not chunk:
            empty_runs += 1
            if empty_runs >= 2:
                break  # 2x berturut kosong → OLT benar-benar diam
        else:
            empty_runs = 0
    return buf.decode('latin-1', errors='replace')


def sync_hsgq_epon_telnet(conn, olt: dict):
    """
    Sync HSGQ EPON menggunakan telnetlib (bukan Scrapli).
    Telnetlib handle IAC negotiation otomatis — cocok untuk HSGQ.

    Login: username → password → OLT> → enable → OLT# → configure → OLT(config)#
    Data:  show onu-info all (dari OLT(config)#)
    """
    olt_name   = olt['name']
    olt_id     = olt['id']
    epon_ports = int(olt.get('epon_ports') or 8)
    match_count = 0

    logger.info(f'[{olt_name}] HSGQ EPON telnetlib sync dimulai...')

    tn = None
    try:
        tn = SimpleTelnet(olt['ip'], int(olt['port']), timeout=20)

        # Baca banner + tunggu username prompt
        banner = tn.read_until(b'username:', timeout=30).decode('latin-1', errors='replace')
        logger.info(f'[{olt_name}] Banner terima, kirim username...')

        # Login
        tn.write(olt['username'].encode('ascii') + b'\r\n')
        tn.read_until(b'password:', timeout=10)
        tn.write(olt['password'].encode('ascii') + b'\r\n')

        # Tunggu prompt OLT>
        resp = tn.read_until(b'OLT>', timeout=15).decode('latin-1', errors='replace')
        logger.info(f'[{olt_name}] Login OK, prompt: OLT>')

        # Enable → privileged mode (OLT#)
        # Beberapa HSGQ langsung OLT# tanpa password
        tn.write(b'enable\r\n')
        en_resp = _hsgq_read(tn, b'OLT#', timeout=15)
        logger.info(f'[{olt_name}] enable resp tail: {repr(en_resp[-60:])}')
        if 'OLT#' not in en_resp:
            logger.warning(f'[{olt_name}] OLT# tidak muncul setelah enable, lanjut saja...')

        # ── VLAN dari "show vlan all" (saat OLT#, sebelum configure) ──
        # Pola: tiap PON port punya 1 VLAN eksklusif (muncul di 1 port saja)
        # Contoh output: VLAN ID: 701 → Tagged Ports: PON01,GE01
        #   → port 1 pakai VLAN 701 untuk semua ONU-nya (1/1, 1/2, dst)
        port_vlan_map = {}   # { '1': '701', '2': '702', ... }
        try:
            tn.write(b'show vlan all\r\n')
            vlan_out = _hsgq_read(tn, b'OLT#', timeout=15)
            logger.info(f'[{olt_name}] show vlan all: {len(vlan_out)}b')

            for m in re.finditer(
                r'VLAN\s+ID\s*:\s*(\d+)(.*?)(?=VLAN\s+ID|\Z)',
                vlan_out, re.DOTALL | re.I
            ):
                vlan_id  = m.group(1).strip()
                block    = m.group(2)
                # Coba pola "Tagged Ports: PONxx" dulu
                tagged_m = re.search(r'Tagged\s+Ports\s*:\s*([^\n]+)', block, re.I)
                if not tagged_m:
                    # Fallback: cari semua PON port di blok VLAN ini
                    tagged_m_alt = block
                    pon_ports = re.findall(r'PON0*(\d+)', tagged_m_alt, re.I)
                else:
                    pon_ports = re.findall(r'PON0*(\d+)', tagged_m.group(1), re.I)
                # Simpan VLAN ke semua port terkait (eksklusif atau tidak)
                # Port yang sudah ada entri tidak di-overwrite (prioritas VLAN pertama)
                for port_no in pon_ports:
                    if port_no not in port_vlan_map:
                        port_vlan_map[port_no] = vlan_id

            logger.info(f'[{olt_name}] Port-VLAN map: {port_vlan_map}')
        except Exception as e:
            logger.warning(f'[{olt_name}] show vlan all gagal: {e}')

        # Configure → mode config
        # Prompt bisa: OLT(config)# ATAU OLT-NAMA(config)# → cukup cari '(config)#'
        tn.write(b'configure\r\n')
        cfg_resp = _hsgq_read(tn, b'(config)#', timeout=20)
        logger.info(f'[{olt_name}] configure resp tail: {repr(cfg_resp[-80:])}')
        if '(config)#' not in cfg_resp:
            logger.error(f'[{olt_name}] Gagal masuk config mode! Abort EPON sync.')
            return
        logger.info(f'[{olt_name}] Masuk config mode OK')

        # ── Per EPON port: ONU list + optical ──
        # show onu-info all hanya valid dari OLT(config-epon-N)#
        # Format: PON/ONU  Mac-Address  Status  Auth  Cfg  Reg-time  ONU-Name  ONU-Desc
        # Contoh: 1/1   0c:37:47:77:a4:10 Online  TRUE  TRUE  2026/05/24 11:41:54  wiwik_tegaly NO-DESCRIPTI
        rx_map = {}
        for port_num in range(1, epon_ports + 1):
            # Prompt bisa: OLT(config-epon-1)# atau OLT-NAMA(config-epon-1)#
            # Cukup cari 'epon-N)#' agar fleksibel terhadap nama OLT apapun
            port_prompt = f'epon-{port_num})#'.encode()
            cfg_prompt  = b'(config)#'
            try:
                tn.write(f'interface epon {port_num}\r\n'.encode('ascii'))
                iface_resp = _hsgq_read(tn, port_prompt, timeout=10)
                logger.info(f'[{olt_name}] port{port_num} iface resp: {repr(iface_resp[-60:])}')
                if port_prompt.decode() not in iface_resp:
                    logger.warning(f'[{olt_name}] port{port_num}: prompt interface tidak muncul, skip')
                    continue

                # ── ONU list ──
                tn.write(b'show onu-info all\r\n')
                port_info = _hsgq_read(tn, port_prompt, timeout=30)
                logger.info(f'[{olt_name}] port{port_num} onu-info ({len(port_info)}b): {repr(port_info[:250])}')

                for m in re.finditer(
                    r'(\d+/\d+)\s+'
                    r'((?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2})\s+'
                    r'(Online|Offline)\s+'
                    r'\w+\s+\w+\s+'       # Auth + Cfg
                    r'[\d/\s:]+\s+'       # Reg-time
                    r'(\S+)',             # ONU-Name (kolom ke-7, sebelum ONU-Desc)
                    port_info
                ):
                    pon_onu  = m.group(1).strip()
                    mac      = m.group(2).strip().lower()
                    onu_name = m.group(4).strip()

                    if onu_name in ('NO-DESCRIPTI', 'NO-DESCRIPTION', 'NONE', '-', ''):
                        onu_name = ''

                    parts     = pon_onu.split('/')
                    onu_id    = parts[1] if len(parts) > 1 else parts[0]
                    slot_port = f'{port_num}/{onu_id}'
                    sn        = mac.lower()  # simpan MAC dengan titik dua (EPON)
                    vlan      = port_vlan_map.get(str(port_num), '')
                    username  = onu_name if onu_name else f'mac:{mac}'

                    _upsert_onu(conn, username, olt_id, slot_port, sn, vlan, None, None)
                    match_count += 1
                    logger.info(f'[{olt_name}] {slot_port} -> {username} MAC={mac} VLAN={vlan}')

                # ── Optical info ──
                # Format: "  1/1 nama  mac  suhu C  volt V  bias mA  Tx dBm  Rx dBm"
                # Ambil dua nilai dBm terakhir per baris → Tx (index 0) dan Rx (index 1)
                tn.write(b'show optical-info\r\n')
                opt_out = _hsgq_read(tn, port_prompt, timeout=30)
                logger.info(f'[{olt_name}] port{port_num} optical ({len(opt_out)}b)')
                for line in opt_out.splitlines():
                    # Format: "  1/N  onu-name  xx:xx:xx:xx:xx:xx  suhu...  Tx dBm  Rx dBm"
                    mp = re.match(
                        r'\s*(\d+)/(\d+)\s+'          # PON/ONU
                        r'(\S+)\s+'                    # ONU-Name
                        r'((?:[0-9a-f]{2}:){5}[0-9a-f]{2})',  # MAC
                        line, re.I
                    )
                    if not mp:
                        continue
                    onu_id   = mp.group(2)
                    onu_name = mp.group(3).strip()
                    mac      = mp.group(4).strip().lower()
                    sp_key   = f'{port_num}/{onu_id}'

                    # Upsert ONU dari optical-info (melengkapi data dari show onu-info all)
                    sn_opt   = mac
                    vlan_opt = port_vlan_map.get(str(port_num), '')
                    uname_opt = onu_name if onu_name and onu_name not in (
                        'NO-DESCRIPTI', 'NO-DESCRIPTION', 'NONE', '-') else f'mac:{mac}'
                    _upsert_onu(conn, uname_opt, olt_id, sp_key, sn_opt, vlan_opt, None, None)

                    dbm_vals = re.findall(r'(-?[\d.]+)\s+dBm', line)
                    if len(dbm_vals) >= 2:
                        rx_map[sp_key] = (
                            parse_rx_power(dbm_vals[1]),  # Rx power (kolom terakhir)
                            parse_rx_power(dbm_vals[0]),  # Tx power (sebelum Rx)
                        )

                tn.write(b'exit\r\n')
                _hsgq_read(tn, cfg_prompt, timeout=8)

            except Exception as ep:
                logger.warning(f'[{olt_name}] port {port_num}: {ep}')
                try:
                    tn.write(b'exit\r\n')
                    _hsgq_read(tn, cfg_prompt, timeout=5)
                except Exception:
                    pass

        # ── Update rx/tx ke onu_mapping ──
        for slot_port, (rx, tx) in rx_map.items():
            conn.execute(
                'UPDATE onu_mapping SET rx_power=?, tx_power=?, synced_at=? WHERE slot_port=? AND olt_id=?',
                (rx, tx, datetime.now().isoformat(), slot_port, olt_id)
            )

        conn.commit()
        logger.info(f'[{olt_name}] HSGQ EPON: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ HSGQ EPON telnetlib error: {e}', exc_info=True)
    finally:
        if tn is not None:
            tn.close()


def sync_hsgq_epon(ssh_conn, conn, olt: dict):
    """
    Sinkronisasi ONU dari OLT HSGQ EPON (E04ID, E08ID, dan sejenisnya).

    Alur berdasarkan referensi CLI HSGQ:
      1. configure terminal  → masuk config mode
      2. interface epon 0/{n} → masuk PON port
      3. show onu-info all    → MAC (=SN di EPON) + slot/port + status
      4. show onu optical-info / show onu opm-diag all → RX power
      5. show running-config (global) → VLAN per ONU
      6. interface onu {port}/{id} → detail ONU

    Catatan: di EPON, MAC address = SN (tidak ada SN 16-char seperti GPON)
    slot/port format: PON_port/ONU_ID (mis. 1/1 = PON port 1, ONU ID 1)
    """
    olt_name   = olt['name']
    olt_id     = olt['id']
    epon_ports = int(olt.get('epon_ports') or 8)
    match_count = 0

    logger.info(f'[{olt_name}] HSGQ EPON sync dimulai ({epon_ports} port)...')

    try:
        # ── Step 1: Masuk configure terminal (HSGQ butuh config mode) ──
        try:
            ssh_conn.send_command('configure terminal', timeout_ops=15)
            logger.info(f'[{olt_name}] Masuk configure terminal')
        except Exception:
            pass

        # ── Step 1b: Coba show onu-info all dari context global dulu ──
        # Pada HSGQ, command ini bisa dijalankan dari OLT(config)# tanpa masuk interface
        global_info_out = ''
        try:
            global_info_out = ssh_conn.send_command('show onu-info all', timeout_ops=30).result
            logger.info(f'[{olt_name}] Global show onu-info all: {len(global_info_out)}b')
        except Exception:
            pass

        # ── Step 2: Ambil VLAN dari running-config (sekali, global) ──
        vlan_map = {}  # { 'port/onu_id': vlan_str }
        try:
            run_cfg = ssh_conn.send_command('show running-config', timeout_ops=120).result
            # Parse blok konfigurasi ONU: cari PVID/VLAN per ONU
            # Format umum: interface onu {port}/{id} ... pvid {vlan} ...
            for m in re.finditer(
                r'interface\s+onu\s+(\d+/\d+)(.*?)(?=interface|\Z)',
                run_cfg, re.DOTALL | re.I
            ):
                slot = m.group(1).strip()
                block = m.group(2)
                # Cari PVID atau VLAN
                vlan_m = re.search(r'(?:pvid|vlan)\s+(\d+)', block, re.I)
                if vlan_m:
                    vlan_map[slot] = vlan_m.group(1)
            logger.info(f'[{olt_name}] VLAN dari running-config: {len(vlan_map)} ONU')
        except Exception as e:
            logger.warning(f'[{olt_name}] running-config gagal: {e}')

        # ── Step 3: Loop setiap PON port ──
        for port_num in range(1, epon_ports + 1):

            # Format interface HSGQ: 'interface epon 0/{n}'
            iface_entered = False
            for iface_cmd in [f'interface epon 0/{port_num}',
                               f'interface epon {port_num}']:
                try:
                    ssh_conn.send_command(iface_cmd, timeout_ops=10)
                    iface_entered = True
                    logger.info(f'[{olt_name}] Interface: {iface_cmd}')
                    break
                except Exception:
                    continue

            if not iface_entered:
                logger.warning(f'[{olt_name}] ⚠ Port {port_num} tidak bisa diakses')
                continue

            try:
                # ── Step 3a: show onu-info all ──
                # Format HSGQ EPON:
                # PON/ONU  MAC                Status   Auth  Cfg  Reg-time             ONU-Name
                # 4/18     40:62:ea:e1:4b:c7  Online   TRUE  TRUE 2026/06/03 20:31:24  nando_tegaly
                #
                # ONU-Name LANGSUNG = PPPoE username! Tidak perlu MAC matching.
                info_out = ''
                for cmd in ['show onu-info all', 'show onu info all', 'show epon onu']:
                    try:
                        info_out = ssh_conn.send_command(cmd, timeout_ops=20).result
                        if info_out and len(info_out) > 10:
                            logger.info(f'[{olt_name}] port {port_num} onu-info ({len(info_out)}b) via: {cmd}')
                            break
                    except Exception:
                        continue

                # ── Step 3b: RX power ──
                opt_out = ''
                for cmd in ['show onu optical-info', 'show onu opm-diag all',
                             'show onu optical-info all']:
                    try:
                        opt_out = ssh_conn.send_command(cmd, timeout_ops=20).result
                        if opt_out and len(opt_out) > 10:
                            logger.info(f'[{olt_name}] port {port_num} optical ({len(opt_out)}b) via: {cmd}')
                            break
                    except Exception:
                        continue

                # ── Parse: PON/ONU + MAC + Status + ONU-Name ──
                # Baris: "4/18  40:62:ea:e1:4b:c7  Online  TRUE  TRUE  2026/06/03 20:31:24  nando_tegaly  ..."
                onu_info = {}
                for m in re.finditer(
                    r'(\d+/\d+)\s+'                                      # PON/ONU
                    r'((?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2})\s+'  # MAC
                    r'(\w+)\s+'                                           # Status (Online/Offline)
                    r'\w+\s+\w+\s+'                                      # Auth TRUE/FALSE + Cfg TRUE/FALSE
                    r'[\d/\s:]+\s+'                                      # Reg-time
                    r'(\S+)',                                             # ONU-Name = PPPoE username
                    info_out
                ):
                    pon_onu  = m.group(1).strip()
                    raw_mac  = m.group(2).strip().lower()
                    status   = m.group(3).strip()
                    onu_name = m.group(4).strip()

                    onu_id    = pon_onu.split('/')[-1]
                    slot_port = f'{port_num}/{onu_id}'
                    onu_info[onu_id] = {
                        'mac':       raw_mac,
                        'slot_port': slot_port,
                        'status':    status,
                        'onu_name':  onu_name,   # ini PPPoE username langsung!
                    }
                    logger.debug(f'[{olt_name}] ONU {slot_port} MAC={raw_mac} '
                                 f'user={onu_name} {status}')

                # ── Parse: RX power dari optical-info ──
                # Format: ONU-ID  Rx-Power(dBm)  Tx-Power(dBm)
                #   atau: PON/ONU  Rx  Tx ...
                rx_map = {}
                for m in re.finditer(
                    r'(\d+/\d+|\d+)\s+(-?\d+\.?\d*)\s+(-?\d+\.?\d*)',
                    opt_out
                ):
                    key    = m.group(1).strip()
                    onu_id = key.split('/')[-1]
                    rx_map[onu_id] = (
                        parse_rx_power(m.group(2)),
                        parse_rx_power(m.group(3))
                    )

                logger.info(f'[{olt_name}] port {port_num}: {len(onu_info)} ONU, '
                            f'{len(rx_map)} RX data')

                # ── Simpan ke onu_mapping ──
                for onu_id, info in onu_info.items():
                    mac       = info['mac']
                    slot_port = info['slot_port']
                    onu_name  = info.get('onu_name', '')
                    # SN = MAC uppercase tanpa colon (format standar EPON)
                    sn        = mac.lower()  # simpan MAC dengan titik dua (EPON)
                    vlan      = vlan_map.get(slot_port, '')
                    rx, tx    = rx_map.get(onu_id, (None, None))

                    # ONU-Name dari HSGQ = PPPoE username langsung!
                    # Verifikasi: cek apakah username ini ada di tabel pelanggan
                    username = None

                    if onu_name and onu_name not in ('NO-DESCRIPTI', 'NO-DESCRIPTION', '-', ''):
                        # Cek apakah ada di pelanggan
                        row = conn.execute(
                            "SELECT username FROM pelanggan WHERE username=? LIMIT 1",
                            (onu_name,)
                        ).fetchone()
                        if row:
                            username = onu_name  # match sempurna!
                        else:
                            # Belum ada di DB, simpan dengan nama ONU sebagai username
                            # (akan cocok saat pelanggan ditambahkan)
                            username = onu_name

                    # Fallback jika nama ONU kosong/tidak valid
                    if not username:
                        row = conn.execute(
                            "SELECT username FROM onu_mapping WHERE slot_port=? AND olt_id=? "
                            "AND username NOT LIKE 'mac:%' LIMIT 1",
                            (slot_port, olt_id)
                        ).fetchone()
                        if row:
                            username = row['username']
                        else:
                            username = f'mac:{mac}'

                    _upsert_onu(conn, username, olt_id, slot_port, sn, vlan, rx, tx)
                    match_count += 1
                    logger.info(f'[{olt_name}] SAVE {slot_port} → {username} '
                                f'MAC={mac} VLAN={vlan} RX={rx}')

            except Exception as e:
                logger.warning(f'[{olt_name}] ⚠ port {port_num}: {e}')
            finally:
                try:
                    ssh_conn.send_command('exit', timeout_ops=5)
                except Exception:
                    pass

        conn.commit()
        logger.info(f'[{olt_name}] ✅ HSGQ EPON: {match_count} ONU tersinkronisasi.')

    except Exception as e:
        logger.error(f'[{olt_name}] ❌ HSGQ EPON error: {e}', exc_info=True)


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

        ssh_conn.send_command('terminal length 0', timeout_ops=30)

        config_text = ssh_conn.send_command(
            'show running-config', timeout_ops=120
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

        ssh_conn.send_command('terminal length 0', timeout_ops=30)

        config_text = ssh_conn.send_command(
            'show running-config', timeout_ops=120
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

def _patch_vlan_from_mikrotik_bulk(conn, olt_ids: list):
    """
    Patch VLAN + IP address PPPoE dari MikroTik untuk banyak OLT sekaligus.
    MikroTik di-query SATU KALI — cocok ketika 1 MikroTik melayani beberapa OLT.
    """
    if not olt_ids:
        return
    try:
        placeholders = ','.join('?' * len(olt_ids))
        rows = conn.execute(
            f"SELECT username FROM onu_mapping WHERE olt_id IN ({placeholders})",
            olt_ids
        ).fetchall()

        all_usernames = {r['username'] for r in rows
                         if not r['username'].startswith('mac:')}
        if not all_usernames:
            return

        usernames_need_vlan = {r['username'] for r in rows
                               if not r['username'].startswith('mac:')
                               and not (r['vlan'] if 'vlan' in r.keys() else False)}

        devices = conn.execute(
            "SELECT id, name, ip, port, username, password "
            "FROM devices WHERE status = 'connected'"
        ).fetchall()

        if not devices:
            logger.info('[VLAN Patch] Tidak ada MikroTik connected, skip.')
            return

        # Query semua MikroTik sekali — satu MikroTik bisa cover banyak OLT
        combined_vlan = {}
        combined_ip   = {}   # username -> IP PPPoE aktif
        for dev in devices:
            try:
                with MikroTikClient(dict(dev)) as mt:
                    vmap = mt.get_all_vlan_by_secret()
                    combined_vlan.update(vmap)
                    # Ambil IP dari sesi PPPoE aktif
                    try:
                        active = list(mt._get_api().path('/ppp/active'))
                        for sess in active:
                            name = sess.get('name', '')
                            addr = sess.get('address', '')
                            if name and addr:
                                combined_ip[name] = addr
                    except Exception:
                        pass
                logger.info('[VLAN Patch] MikroTik %s: %d VLAN, %d IP aktif',
                            dev['name'], len(vmap), len(combined_ip))
            except MikroTikError as e:
                logger.warning('[VLAN Patch] MikroTik %s gagal: %s', dev['name'], e)
            except Exception as e:
                logger.warning('[VLAN Patch] MikroTik %s error: %s', dev['name'], e)

        # Reset is_online semua ONU di OLT ini dulu, lalu set 1 yang aktif
        conn.execute(
            f'UPDATE onu_mapping SET is_online = 0 WHERE olt_id IN ({placeholders})',
            olt_ids
        )

        updated_vlan = 0
        for username in all_usernames:
            vlan      = combined_vlan.get(username)
            ip        = combined_ip.get(username, '')
            is_online = 1 if username in combined_ip else 0
            if vlan:
                conn.execute(
                    'UPDATE onu_mapping SET vlan=?, ip_address=?, is_online=? WHERE username=?',
                    (str(vlan), ip, is_online, username)
                )
                updated_vlan += 1
            else:
                conn.execute(
                    'UPDATE onu_mapping SET ip_address=?, is_online=? WHERE username=?',
                    (ip, is_online, username)
                )

        conn.commit()
        logger.info('[VLAN Patch] VLAN: %d updated, online: %d/%d (dari %d OLT).',
                    updated_vlan, len(combined_ip), len(all_usernames), len(olt_ids))

    except Exception as e:
        logger.error('[VLAN Patch] Error: %s', e)


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


import threading as _threading
from concurrent.futures import ThreadPoolExecutor as _ThreadPoolExecutor

# Lock per-owner: sync owner A tidak blokir owner B
_owner_locks: dict = {}
_owner_locks_mu = _threading.Lock()


def _get_owner_lock(network_id: str) -> _threading.Lock:
    with _owner_locks_mu:
        if network_id not in _owner_locks:
            _owner_locks[network_id] = _threading.Lock()
        return _owner_locks[network_id]


def _sync_owner_olts_safe(network_id: str):
    """Wrapper _sync_owner_olts dengan per-owner lock."""
    lock = _get_owner_lock(network_id)
    if not lock.acquire(blocking=False):
        logger.warning('[%s] Sync sedang berjalan, skip.', network_id[:8])
        return
    try:
        _sync_owner_olts(network_id)
    except Exception as e:
        logger.error('[%s] sync error: %s', network_id[:8], e)
    finally:
        lock.release()


def sync_all_olts(network_id: str = None):
    """
    Background: iterasi semua owner paralel (max 3 bersamaan).
    Manual (network_id diisi): langsung sync satu owner via _sync_owner_olts_safe.

    Per-owner lock memastikan tiap owner hanya punya 1 siklus sync aktif.
    Owner berbeda bisa sync bersamaan tanpa saling blokir.
    """
    logger.info('=' * 60)
    logger.info('Memulai siklus sinkronisasi OLT...')

    if network_id:
        _sync_owner_olts_safe(network_id)
    else:
        master = get_master_db()
        owners = master.execute("SELECT network_id FROM networks").fetchall()
        master.close()
        with _ThreadPoolExecutor(max_workers=3) as ex:
            for row in owners:
                ex.submit(_sync_owner_olts_safe, row['network_id'])

    logger.info('Siklus sinkronisasi selesai.')
    logger.info('=' * 60)


def _sync_owner_olts(network_id: str):
    """Jalankan sync OLT untuk satu owner."""
    conn = get_owner_db(network_id)
    olts = conn.execute("SELECT * FROM olt WHERE status = 'connected'").fetchall()

    if not olts:
        logger.info('[%s] Tidak ada OLT connected. Skip.', network_id[:8])
        conn.close()
        return

    synced_olt_ids = []

    for olt in olts:
        olt_dict = dict(olt)
        tipe_lower = (olt['tipe'] or '').lower()
        logger.info('[%s] Login ke: %s (%s:%s) tipe=%s',
                    network_id[:8], olt['name'], olt['ip'], olt['port'], olt['tipe'])

        # ── HSGQ EPON: gunakan telnetlib (bukan Scrapli) ──────────
        is_epon = any(k in tipe_lower for k in ['epon', 'hsgq', 'e04', 'e08'])
        if is_epon:
            logger.info('[%s] EPON terdeteksi → gunakan telnetlib', olt['name'])
            try:
                sync_hsgq_epon_telnet(conn, olt_dict)
                synced_olt_ids.append(olt['id'])
            except Exception as e:
                logger.error('Gagal sync EPON %s: %s', olt['name'], e)
            continue

        # ── GPON & lainnya: gunakan Scrapli ───────────────────────
        device_cfg = {
            'host':                  olt['ip'],
            'port':                  int(olt['port']),
            'auth_username':         olt['username'],
            'auth_password':         olt['password'],
            'auth_strict_key':       False,
            'transport':             'telnet',
            'timeout_socket':        20,
            'timeout_transport':     60,
            'timeout_ops':           60,
            'comms_prompt_pattern':  r'(?m)^.*[>#\$]\s*$',
            'transport_options': {
                'telnet': {
                    'auth_username_pattern': r'(?i)(user\s?name|login|user)\s*:',
                    'auth_password_pattern': r'(?i)password\s*:',
                }
            },
        }

        try:
            with GenericDriver(**device_cfg) as ssh_conn:
                try:
                    prompt = ssh_conn.get_prompt()
                except Exception:
                    prompt = ''
                logger.info("[%s] Prompt: '%s'", olt['name'], prompt)

                sync_func = _pilih_sync_func(tipe_lower, prompt)
                logger.info('[%s] Fungsi: %s', olt['name'], sync_func.__name__)

                sync_func(ssh_conn, conn, olt_dict)
                synced_olt_ids.append(olt['id'])

        except Exception as e:
            logger.error('Gagal login ke OLT %s (%s:%s): %s',
                         olt['name'], olt['ip'], olt['port'], e)
            continue

    # ── Patch VLAN dari MikroTik hanya untuk OLT non-EPON ──
    # EPON: semua user 1 pool IP → tidak bisa resolve VLAN dari MikroTik
    # GPON (ZTE/Huawei): VLAN sudah dari running-config, patch sebagai fallback
    gpon_olt_ids = [
        olt['id'] for olt in olts
        if not any(k in (olt['tipe'] or '').lower() for k in ['epon', 'hsgq', 'e04', 'e08'])
    ]
    if gpon_olt_ids:
        _patch_vlan_from_mikrotik_bulk(conn, gpon_olt_ids)

    conn.close()


def sync_single_olt(network_id: str, olt_id: int):
    """Sync satu OLT spesifik berdasarkan olt_id. Dipanggil dari tombol Sync ONU."""
    lock = _get_owner_lock(network_id)
    if not lock.acquire(blocking=False):
        logger.warning('[sync_single] Owner %s sedang sync, skip.', network_id[:8])
        return

    try:
        conn = get_owner_db(network_id)
        olt  = conn.execute("SELECT * FROM olt WHERE id=? AND status='connected'", (olt_id,)).fetchone()
        if not olt:
            logger.warning('[sync_single] OLT #%s tidak ditemukan atau belum connected.', olt_id)
            conn.close()
            return

        olt_dict   = dict(olt)
        tipe_lower = (olt['tipe'] or '').lower()
        logger.info('[sync_single] Sync OLT: %s (%s:%s) tipe=%s',
                    olt['name'], olt['ip'], olt['port'], olt['tipe'])

        is_epon = any(k in tipe_lower for k in ['epon', 'hsgq', 'e04', 'e08'])
        if is_epon:
            try:
                sync_hsgq_epon_telnet(conn, olt_dict)
            except Exception as e:
                logger.error('Gagal sync EPON %s: %s', olt['name'], e)
        else:
            device_cfg = {
                'host':                 olt['ip'],
                'port':                 int(olt['port']),
                'auth_username':        olt['username'],
                'auth_password':        olt['password'],
                'auth_strict_key':      False,
                'transport':            'telnet',
                'timeout_socket':       20,
                'timeout_transport':    60,
                'timeout_ops':          60,
                'comms_prompt_pattern': r'(?m)^.*[>#\$]\s*$',
                'transport_options': {
                    'telnet': {
                        'auth_username_pattern': r'(?i)(user\s?name|login|user)\s*:',
                        'auth_password_pattern': r'(?i)password\s*:',
                    }
                },
            }
            try:
                with GenericDriver(**device_cfg) as ssh_conn:
                    try:
                        prompt = ssh_conn.get_prompt()
                    except Exception:
                        prompt = ''
                    sync_func = _pilih_sync_func(tipe_lower, prompt)
                    logger.info('[%s] Fungsi: %s', olt['name'], sync_func.__name__)
                    sync_func(ssh_conn, conn, olt_dict)
            except Exception as e:
                logger.error('Gagal sync OLT %s: %s', olt['name'], e)

        # Patch VLAN dari MikroTik hanya untuk GPON (EPON: 1 pool, tidak resolve)
        if not is_epon:
            _patch_vlan_from_mikrotik_bulk(conn, [olt['id']])
        conn.close()
        logger.info('[sync_single] Selesai: %s', olt['name'])
    finally:
        lock.release()


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