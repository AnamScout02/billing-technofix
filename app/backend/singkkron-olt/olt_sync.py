import os
import sqlite3
import logging
import time
import re
from scrapli.driver.generic import GenericDriver

# ── SETUP LOGGING ───────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s - [%(levelname)s] %(message)s')

# ── PATH DATABASE ───────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.abspath(os.path.join(BASE_DIR, '..', '..', 'database', 'devices.db'))

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ══════════════════════════════════════════════════════════════════════
# MODUL 1: FUNGSI KHUSUS ZTE
# ══════════════════════════════════════════════════════════════════════
def sync_zte(ssh_conn, conn, olt):
    olt_name = olt['name']
    logging.info(f"[{olt_name}] Menjalankan sinkronisasi ZTE (Mode Ultra-Fast)...")
    match_count = 0
    
    try:
        ssh_conn.send_interactive([("enable", "Password:", False), ("zxr10", "ZXAN", True)])
        ssh_conn.send_command("terminal length 0") 
        
        # 1. TARIK SEMUA KONFIGURASI DALAM SATU PERINTAH
        config_resp = ssh_conn.send_command("show running-config")
        config_text = config_resp.result

        # 2. PETAKAN SN (Dari blok interface gpon-olt)
        # Menghasilkan list: [('1/1/3', '1', 'HWTCA9083210'), ...]
        sn_map = {}
        olt_blocks = re.findall(r"interface gpon-olt_(\d+/\d+/\d+)(.*?)!", config_text, re.DOTALL)
        for port, block in olt_blocks:
            onus = re.findall(r"onu (\d+) type .*? sn ([\w\d]+)", block)
            for onu_id, sn in onus:
                sn_map[f"{port}:{onu_id}"] = sn

        # 3. PETAKAN NAME & VLAN (Dari blok interface gpon-onu)
        # Mencari blok interface gpon-onu_1/1/3:1 sampai tanda '!'
        onu_blocks = re.findall(r"interface gpon-onu_(\d+/\d+/\d+:\d+)(.*?)!", config_text, re.DOTALL)
        
        for iface, block in onu_blocks:
            name_match = re.search(r"name\s+([^\r\n]+)", block)
            # Mencari 'vlan 100' di bagian service-port
            vlan_match = re.search(r"vlan\s+(\d+)", block)
            
            if name_match:
                username = name_match.group(1).strip()
                vlan = vlan_match.group(1) if vlan_match else ""
                sn = sn_map.get(iface, "") # Ambil SN dari map yang kita buat di langkah 2
                
                if username and username.lower() != "n/a":
                    # UPDATE DATABASE (Termasuk VLAN)
                    conn.execute("""
                        INSERT OR REPLACE INTO onu_mapping (username, olt_id, slot_port, sn, vlan)
                        VALUES (?, ?, ?, ?, ?)
                    """, (username, olt['id'], iface, sn, vlan))
                    match_count += 1
                        
        conn.commit()
        logging.info(f"[{olt_name}] ✅ Selesai! {match_count} ONU tersinkronisasi (SN + Nama + VLAN).")
    except Exception as e:
        logging.error(f"[{olt_name}] ❌ Error: {e}")

# ══════════════════════════════════════════════════════════════════════
# MODUL 2: FUNGSI KHUSUS HUAWEI
# ══════════════════════════════════════════════════════════════════════
def sync_huawei(ssh_conn, conn, olt):
    olt_name = olt['name']
    logging.info(f"[{olt_name}] Menjalankan sinkronisasi HUAWEI (Mode Ultra-Fast)...")
    match_count = 0
    
    try:
        ssh_conn.send_command("enable")
        ssh_conn.send_command("config")
        ssh_conn.send_command("undo smart") 
        
        # Tarik semua konfigurasi
        config_resp = ssh_conn.send_command("display current-configuration")
        config_text = config_resp.result

        # 1. Map SN: ont add 0 1 sn 48575443...
        sn_map = {}
        sn_list = re.findall(r"ont add (\d+/\d+/\d+) (\d+) sn ([A-Z0-9]+)", config_text)
        for port, ont_id, sn in sn_list:
            sn_map[f"{port}:{ont_id}"] = sn

        # 2. Map Name: ont description 0 1 2 "PELANGGAN_A"
        name_map = {}
        desc_list = re.findall(r"ont description (\d+/\d+/\d+) (\d+) \"?([^\r\n\"]+)\"?", config_text)
        for port, ont_id, name in desc_list:
            name_map[f"{port}:{ont_id}"] = name

        # 3. Map VLAN & Final Sync: service-port ... vlan 100 ... gpon 0/1/1 ont 2
        # Kita gunakan service-port sebagai trigger utama sinkronisasi
        svc_ports = re.findall(r"service-port.*?vlan (\d+).*?gpon (\d+/\d+/\d+) ont (\d+)", config_text)
        
        for vlan, port, ont_id in svc_ports:
            iface = f"{port}:{ont_id}"
            username = name_map.get(iface, "")
            sn = sn_map.get(iface, "")

            if username and username.lower() != "n/a":
                conn.execute("""
                    INSERT OR REPLACE INTO onu_mapping (username, olt_id, slot_port, sn, vlan)
                    VALUES (?, ?, ?, ?, ?)
                """, (username, olt['id'], iface, sn, vlan))
                match_count += 1
                    
        conn.commit()
        logging.info(f"[{olt_name}] ✅ Selesai! {match_count} ONU Huawei tersinkronisasi.")
    except Exception as e:
        logging.error(f"[{olt_name}] ❌ Error Huawei: {e}")

# ══════════════════════════════════════════════════════════════════════
# MODUL 3: FUNGSI UNIVERSAL (V-SOL, HSGQ, HIOSO, dll)
# ══════════════════════════════════════════════════════════════════════
def sync_generic_olt(ssh_conn, conn, olt):
    olt_name = olt['name']
    logging.info(f"[{olt_name}] Menjalankan sinkronisasi UNIVERSAL (Mode Ultra-Fast)...")
    match_count = 0
    
    try:
        ssh_conn.send_command("enable")
        ssh_conn.send_command("terminal length 0")
        
        # Tarik running-config
        config_resp = ssh_conn.send_command("show running-config")
        config_text = config_resp.result

        # Regex Universal untuk blok ONU (Sering digunakan di V-Sol/HSGQ/Hioso)
        # Mencari: interface (1/1:1), name, sn, dan vlan
        # Pola ini mungkin perlu sedikit modifikasi sesuai merk spesifiknya
        onu_blocks = re.findall(r"interface (?:gpon|epon)-onu_(\d+/\d+:\d+)(.*?)!", config_text, re.DOTALL)
        
        for iface, block in onu_blocks:
            name_match = re.search(r"name\s+([^\r\n]+)", block)
            sn_match = re.search(r"sn\s+([A-Z0-9]+)", block)
            vlan_match = re.search(r"vlan\s+(\d+)", block)
            
            if name_match and sn_match:
                username = name_match.group(1).strip()
                sn = sn_match.group(1).strip()
                vlan = vlan_match.group(1) if vlan_match else ""
                
                if username and username.lower() != "n/a":
                    conn.execute("""
                        INSERT OR REPLACE INTO onu_mapping (username, olt_id, slot_port, sn, vlan)
                        VALUES (?, ?, ?, ?, ?)
                    """, (username, olt['id'], iface, sn, vlan))
                    match_count += 1
                
        conn.commit()
        logging.info(f"[{olt_name}] ✅ Selesai! {match_count} ONU Universal tersinkronisasi.")
    except Exception as e:
        logging.error(f"[{olt_name}] ❌ Error Universal: {e}")


# ══════════════════════════════════════════════════════════════════════
# FUNGSI PENGATUR LALU LINTAS (ROUTER UTAMA)
# ══════════════════════════════════════════════════════════════════════
def sync_all_olts():
    logging.info("Memulai siklus sinkronisasi masal OLT...")
    conn = get_db()
    olts = conn.execute("SELECT * FROM olt WHERE status = 'connected'").fetchall()
    
    if not olts:
        logging.info("Tidak ada perangkat OLT yang online.")
        conn.close()
        return

    for olt in olts:
        logging.info(f"Mencoba login ke: {olt['name']} ({olt['ip']})")
        
        device_config = {
            "host": olt['ip'],
            "port": olt['port'], 
            "auth_username": olt['username'],
            "auth_password": olt['password'],
            "auth_strict_key": False,
            "transport": "telnet",
            "timeout_ops": 20,
            
            # Pattern universal untuk menangkap karakter akhir (>, #, atau $) merk apapun
            "comms_prompt_pattern": r".*[>#\$]", 
            
            "transport_options": {
                "telnet": {
                    "auth_username_pattern": r"(?i)(?:user\s?name|login|user)\s*?:",
                    "auth_password_pattern": r"(?i)password\s*?:"
                }
            }
        }

        try:
            with GenericDriver(**device_config) as ssh_conn:
                
                # Gunakan fitur bawaan Scrapli untuk membaca prompt asli (misal: "ZXAN>")
                current_prompt = ssh_conn.get_prompt().lower()
                logging.info(f"Mendeteksi tipe OLT dari prompt: '{current_prompt}'")
                
                # -- DETEKSI OTOMATIS MERK OLT --
                if "zxan" in current_prompt or "zte" in current_prompt:
                    sync_zte(ssh_conn, conn, olt)
                    
                elif "huawei" in current_prompt or "ma56" in current_prompt:
                    sync_huawei(ssh_conn, conn, olt)
                    
                else:
                    # Jika merk tidak diketahui (V-Sol, Hioso, dll)
                    sync_generic_olt(ssh_conn, conn, olt)

        except Exception as e:
            logging.error(f"❌ Gagal login ke OLT {olt['name']}: {e}")

    conn.close()

# ── BACKGROUND WORKER LOOP ──────────────────────────────────────
if __name__ == "__main__":
    while True:
        try:
            sync_all_olts()
        except Exception as e:
            logging.error(f"Worker System Error: {e}")
            
        logging.info("Menunggu 3 menit...\n")
        time.sleep(180)