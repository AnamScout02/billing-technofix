"""
mikrotik.py — TechnoFix MikroTik Client
========================================
Wrapper di atas librouteros untuk komunikasi ke RouterOS API.

✅ PEMBARUAN:
   - get_vlan_map()    → ambil semua VLAN interface dari /interface/vlan
   - get_active_vlan() → join /ppp/active + /interface/vlan
                         → { username: vlan_id }
   Dipakai oleh olt_sync.py untuk mengisi kolom 'vlan' di onu_mapping
   ketika OLT tidak menyediakan info VLAN (mis. HSGQ EPON).

✅ FASE 1 — CLEANUP:
   - Hapus deklarasi class MikroTikError & MikroTikClient yang duplikat.
   - Tambahkan helper _parse_rate_limit() yang sebelumnya hanya ada
     di duplikat kedua — diperlukan oleh get_ppp_profiles().
   - Gabungkan method VLAN (versi pertama) + PPP Profile & _parse_rate_limit
     (versi kedua) ke dalam satu class tunggal yang lengkap.
"""

import librouteros
from librouteros import connect
from librouteros.query import Key
import logging


# ── Setup Logging ──────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
# HELPER: parse rate-limit string MikroTik
# [DIPINDAH DARI DUPLIKAT KEDUA — sebelumnya tidak ada di sini]
# ══════════════════════════════════════════════════════════════

def _parse_rate_limit(rl: str):
    """
    Parse string rate-limit MikroTik menjadi (download, upload).

    Format yang didukung:
      "10M/10M"          → ("10M", "10M")
      "10240k/5120k"     → ("10M", "5M")   ← konversi kbps ke Mbps
      "10M/10M 20M/20M …"→ ambil bagian pertama saja
      ""                 → ("unlimited", "unlimited")
    """
    if not rl or not rl.strip():
        return 'unlimited', 'unlimited'

    # Ambil bagian pertama (sebelum spasi — abaikan burst)
    part = rl.strip().split()[0]

    if '/' not in part:
        return part, part

    down_raw, up_raw = part.split('/', 1)

    def normalize(val: str) -> str:
        val = val.strip().upper()
        if val.endswith('M'):
            return val
        if val.endswith('K'):
            try:
                k = float(val[:-1])
                m = k / 1024
                return f'{int(m)}M' if m == int(m) else f'{m:.1f}M'
            except ValueError:
                return val
        if val.endswith('G'):
            return val
        return val

    return normalize(down_raw), normalize(up_raw)


# ══════════════════════════════════════════════════════════════
# EXCEPTION
# [SATU DEFINISI — duplikat di baris ~380 dihapus]
# ══════════════════════════════════════════════════════════════

class MikroTikError(Exception):
    """Exception khusus untuk error koneksi / perintah MikroTik."""
    pass


# ══════════════════════════════════════════════════════════════
# CLIENT
# [SATU DEFINISI — duplikat di baris ~385 dihapus]
# Berisi semua method: PPP Secrets, VLAN, PPP Profiles
# ══════════════════════════════════════════════════════════════

class MikroTikClient:
    def __init__(self, device: dict):
        self.ip       = device['ip']
        self.port     = int(device.get('port', 8728))
        self.username = device['username']
        self.password = device['password']
        self._api     = None

    # ── Context manager agar koneksi auto-close ──
    def __enter__(self):
        self._connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def _connect(self):
        """Membuka koneksi ke MikroTik."""
        try:
            logger.info(f"Menghubungkan ke MikroTik {self.ip}:{self.port}...")
            self._api = connect(
                host=self.ip, username=self.username,
                password=self.password, port=self.port, timeout=10,
            )
            logger.info(f"Koneksi berhasil ke MikroTik {self.ip}")
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'Login gagal: {e}')
        except OSError as e:
            raise MikroTikError(f'Tidak dapat terhubung ke {self.ip}:{self.port} — {e}')
        except Exception as e:
            raise MikroTikError(f'Koneksi error: {e}')

    def _get_api(self):
        """Mendapatkan instance API, membuka koneksi jika belum ada."""
        if self._api is None:
            self._connect()
        return self._api

    def close(self):
        """Tutup koneksi API jika ada."""
        try:
            if self._api is not None:
                self._api.close()
                logger.info(f"Koneksi ke MikroTik {self.ip} ditutup.")
        except Exception as e:
            logger.warning(f"Gagal menutup koneksi: {e}")
        finally:
            self._api = None

    # ══════════════════════════════════════════════════════════
    # PPP SECRETS
    # ══════════════════════════════════════════════════════════

    def get_ppp_secrets(self) -> list:
        """Mengambil daftar PPP Secrets dari MikroTik."""
        try:
            api  = self._get_api()
            rows = api.path('/ppp/secret').select(
                Key('.id'), Key('name'), Key('password'),
                Key('service'), Key('profile'), Key('comment'),
                Key('local-address'), Key('remote-address'),
                Key('disabled'), Key('last-logged-out'),
            )
            result = []
            for r in rows:
                d = dict(r)
                d['disabled'] = d.get('disabled', 'false') in ('true', 'yes', True)
                result.append(d)
            logger.info(f"Berhasil mengambil {len(result)} PPP Secrets dari MikroTik {self.ip}")
            return result
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca PPP Secrets: {e}')

    def get_active_connections(self) -> list:
        """Mengambil daftar koneksi aktif dari MikroTik."""
        try:
            api  = self._get_api()
            # Tanpa .select() agar SEMUA field dikembalikan,
            # termasuk 'address' dan 'caller-id' yang kadang hilang saat pakai .select()
            result = [dict(r) for r in api.path('/ppp/active')]
            if result:
                logger.info(f"[active] sample keys: {list(result[0].keys())}")
            logger.info(f"Berhasil mengambil {len(result)} koneksi aktif dari MikroTik {self.ip}")
            return result
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca koneksi aktif: {e}')

    def tambah_secret(self, data: dict):
        """
        Menambahkan PPP Secret baru ke MikroTik.

        RouterOS TIDAK mencegah nama PPP Secret duplikat (yang unik adalah
        '.id', bukan 'name') — kalau dipanggil dua kali dengan username yang
        sama, hasilnya dua baris secret dengan nama identik di router (terlihat
        seperti "secret lama muncul lagi"). Maka sebelum menambah, cek dulu
        apakah username sudah punya secret di router — kalau sudah, update
        secret yang ada itu saja, jangan buat baris baru.
        """
        name = data.get('name')
        try:
            api    = self._get_api()
            path   = api.path('/ppp/secret')
            target = next((r for r in path.select(Key('.id'), Key('name'))
                           if r.get('name') == name), None)
            if target:
                update = {k: v for k, v in data.items() if k != 'name' and v not in (None, '')}
                path.update(**{'.id': target['.id'], **update})
                logger.info(f"PPP Secret '{name}' sudah ada di MikroTik {self.ip} — diperbarui, bukan dibuat baru")
            else:
                path.add(**data)
                logger.info(f"PPP Secret '{name}' berhasil ditambahkan ke MikroTik {self.ip}")
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal menambah secret: {e}')

    def edit_secret(self, username: str, update: dict):
        """Mengedit PPP Secret berdasarkan username."""
        try:
            api  = self._get_api()
            path = api.path('/ppp/secret')
            target = next((r for r in path.select(Key('.id'), Key('name'))
                           if r.get('name') == username), None)
            if not target:
                raise MikroTikError(f'Pelanggan "{username}" tidak ditemukan di MikroTik')
            path.update(**{'.id': target['.id'], **update})
            logger.info(f"PPP Secret '{username}' berhasil diperbarui di MikroTik {self.ip}")
        except MikroTikError:
            raise
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal mengedit secret: {e}')

    def hapus_secret(self, username: str):
        """Menghapus PPP Secret berdasarkan username."""
        try:
            api  = self._get_api()
            path = api.path('/ppp/secret')
            target = next((r for r in path.select(Key('.id'), Key('name'))
                           if r.get('name') == username), None)
            if not target:
                raise MikroTikError(f'Pelanggan "{username}" tidak ditemukan di MikroTik')
            path.remove(target['.id'])
            logger.info(f"PPP Secret '{username}' berhasil dihapus dari MikroTik {self.ip}")
        except MikroTikError:
            raise
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal menghapus secret: {e}')

    def tes_koneksi(self) -> bool:
        """Menguji koneksi ke MikroTik."""
        try:
            api = self._get_api()
            list(api.path('/system/identity').select(Key('name')))
            logger.info(f"Tes koneksi ke MikroTik {self.ip} berhasil.")
            return True
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Tes koneksi gagal: {e}')

    # ══════════════════════════════════════════════════════════
    # PPP PROFILES
    # [DIPINDAH DARI DUPLIKAT KEDUA — sebelumnya tidak ada di sini]
    # Diperlukan oleh endpoint /api/profile di api.py
    # ══════════════════════════════════════════════════════════

    def get_ppp_profiles(self) -> list:
        """Mengambil daftar PPP Profile dari MikroTik."""
        try:
            api  = self._get_api()
            rows = api.path('/ppp/profile').select(
                Key('.id'), Key('name'), Key('rate-limit'),
                Key('local-address'), Key('remote-address'),
                Key('session-timeout'), Key('comment'),
            )
            result = []
            for r in rows:
                d = dict(r)
                rl = d.get('rate-limit', '') or ''
                d['rate_limit_raw'] = rl
                d['rate_down'], d['rate_up'] = _parse_rate_limit(rl)
                result.append(d)
            logger.info(f"Berhasil mengambil {len(result)} PPP Profile dari {self.ip}")
            return result
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca PPP Profile: {e}')

    def tambah_profile(self, data: dict):
        """Menambahkan PPP Profile baru ke MikroTik."""
        try:
            api = self._get_api()
            payload = {k: v for k, v in data.items()
                       if k in ('name', 'rate-limit', 'local-address',
                                'remote-address', 'session-timeout', 'comment')
                       and v not in (None, '')}
            api.path('/ppp/profile').add(**payload)
            logger.info(f"PPP Profile '{data.get('name')}' berhasil ditambahkan ke {self.ip}")
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal menambah profile: {e}')

    def edit_profile(self, nama: str, update: dict):
        """Mengedit PPP Profile berdasarkan nama."""
        try:
            api  = self._get_api()
            path = api.path('/ppp/profile')
            target = next((r for r in path.select(Key('.id'), Key('name'))
                           if r.get('name') == nama), None)
            if not target:
                raise MikroTikError(f'Profile "{nama}" tidak ditemukan di MikroTik')
            payload = {k: v for k, v in update.items()
                       if k in ('name', 'rate-limit', 'local-address',
                                'remote-address', 'session-timeout', 'comment')
                       and v is not None}
            path.update(**{'.id': target['.id'], **payload})
            logger.info(f"PPP Profile '{nama}' berhasil diperbarui di {self.ip}")
        except MikroTikError:
            raise
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal mengedit profile: {e}')

    def hapus_profile(self, nama: str):
        """Menghapus PPP Profile berdasarkan nama."""
        try:
            api  = self._get_api()
            path = api.path('/ppp/profile')
            target = next((r for r in path.select(Key('.id'), Key('name'))
                           if r.get('name') == nama), None)
            if not target:
                raise MikroTikError(f'Profile "{nama}" tidak ditemukan di MikroTik')
            path.remove(target['.id'])
            logger.info(f"PPP Profile '{nama}' berhasil dihapus dari {self.ip}")
        except MikroTikError:
            raise
        except librouteros.exceptions.TrapError as e:
            raise MikroTikError(f'MikroTik error: {e}')
        except Exception as e:
            raise MikroTikError(f'Gagal menghapus profile: {e}')

    # ══════════════════════════════════════════════════════════
    # VLAN MAP
    # Dipakai oleh olt_sync.py untuk mengisi kolom vlan di
    # onu_mapping ketika OLT tidak menyediakan info VLAN
    # (contoh: HSGQ EPON, V-Sol tanpa service-port config)
    # ══════════════════════════════════════════════════════════

    def get_vlan_map(self) -> dict:
        """
        Ambil semua VLAN interface dari /interface/vlan.

        Return:
          { interface_name: vlan_id_str }

        Contoh:
          {
            'vlan-sfp3-200': '200',
            'vlan-ether1-100': '100',
          }
        """
        try:
            api  = self._get_api()
            rows = api.path('/interface/vlan').select(
                Key('name'), Key('vlan-id'), Key('interface'), Key('disabled'),
            )
            result = {}
            for r in rows:
                row = dict(r)
                if row.get('disabled') in ('true', 'yes', True):
                    continue
                name    = str(row.get('name', '') or '').strip()
                vlan_id = str(row.get('vlan-id', '') or '').strip()
                if name and vlan_id:
                    result[name] = vlan_id
            logger.info(f"[VLAN Map] {len(result)} VLAN interface ditemukan di MikroTik {self.ip}")
            return result
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca VLAN interface: {e}')

    def get_active_vlan(self) -> dict:
        """
        Join /ppp/active + /interface/vlan untuk mendapat VLAN
        per username yang sedang aktif (online).

        Return:
          { username: vlan_id_str }
        """
        try:
            api = self._get_api()

            active_rows = list(api.path('/ppp/active').select(
                Key('name'), Key('caller-id'),
            ))

            vlan_map = self.get_vlan_map()

            result = {}
            for row in active_rows:
                r         = dict(row)
                username  = str(r.get('name', '') or '').strip()
                caller_id = str(r.get('caller-id', '') or '').strip()

                if not username:
                    continue

                if caller_id in vlan_map:
                    result[username] = vlan_map[caller_id]
                    continue

                for iface_name, vid in vlan_map.items():
                    if vid in caller_id or caller_id in iface_name:
                        result[username] = vid
                        break

            logger.info(
                f"[VLAN Active] {len(result)}/{len(active_rows)} "
                f"username berhasil di-map ke VLAN di MikroTik {self.ip}"
            )
            return result

        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca active VLAN: {e}')

    def get_all_vlan_by_secret(self) -> dict:
        """
        Resolve VLAN untuk SEMUA pelanggan (online maupun offline).

        Strategi (berurutan):
          1. Bangun peta subnet → VLAN dari /ip/address + /interface/vlan
          2. User ONLINE  (/ppp/active)  : IP aktif → cari di subnet_vlan → VLAN
          3. User OFFLINE (/ppp/secret)  : profile → local-address → cari di subnet_vlan → VLAN

        Return:
          { username: vlan_id_str }
        """
        import ipaddress as _ip

        api    = self._get_api()
        result = {}

        # ── 1. Peta interface → vlan_id ──────────────────────────
        vlan_by_iface = {}
        try:
            for r in api.path('/interface/vlan').select(
                Key('name'), Key('vlan-id'), Key('disabled')
            ):
                row = dict(r)
                if row.get('disabled') in ('true', 'yes', True):
                    continue
                name = str(row.get('name', '') or '').strip()
                vid  = str(row.get('vlan-id', '') or '').strip()
                if name and vid:
                    vlan_by_iface[name] = vid
        except Exception as e:
            logger.warning(f'[VLAN] /interface/vlan error: {e}')

        # ── 2. Peta subnet CIDR → vlan_id ────────────────────────
        # Contoh: vlan100 interface punya IP 192.168.100.1/24
        #   → subnet 192.168.100.0/24 → VLAN 100
        subnet_vlan = []  # list of (_ip.IPv4Network, vlan_id_str)
        try:
            for r in api.path('/ip/address').select(
                Key('address'), Key('interface'), Key('disabled')
            ):
                row = dict(r)
                if row.get('disabled') in ('true', 'yes', True):
                    continue
                iface = str(row.get('interface', '') or '').strip()
                addr  = str(row.get('address', '') or '').strip()
                if iface in vlan_by_iface and addr:
                    try:
                        net = _ip.ip_interface(addr).network
                        subnet_vlan.append((net, vlan_by_iface[iface]))
                    except ValueError:
                        pass
        except Exception as e:
            logger.warning(f'[VLAN] /ip/address error: {e}')

        def _ip_to_vlan(ip_str: str) -> str:
            """Cocokkan IP ke subnet → kembalikan VLAN ID."""
            if not ip_str:
                return ''
            try:
                addr = _ip.ip_address(ip_str.split('/')[0])
                for net, vid in subnet_vlan:
                    if addr in net:
                        return vid
            except ValueError:
                pass
            return ''

        # ── 3. User ONLINE: IP aktif dari /ppp/active ─────────────
        try:
            for r in api.path('/ppp/active').select(
                Key('name'), Key('address'), Key('caller-id')
            ):
                row      = dict(r)
                username = str(row.get('name', '') or '').strip()
                address  = str(row.get('address', '') or '').strip()
                if not username:
                    continue
                vlan = _ip_to_vlan(address)
                if vlan:
                    result[username] = vlan
        except Exception as e:
            logger.warning(f'[VLAN] /ppp/active error: {e}')

        logger.info(f'[VLAN] Online users resolved: {len(result)}')

        # ── 4. User OFFLINE: /ppp/secret → profile → local-address ─
        # Setiap PPP profile punya local-address (IP sisi MikroTik)
        # yang biasanya berada di subnet VLAN tertentu.
        try:
            profile_addr = {}
            for r in api.path('/ppp/profile').select(
                Key('name'), Key('local-address')
            ):
                row   = dict(r)
                pname = str(row.get('name', '') or '').strip()
                laddr = str(row.get('local-address', '') or '').strip()
                if pname and laddr and laddr not in ('0.0.0.0', ''):
                    profile_addr[pname] = laddr

            offline_resolved = 0
            for r in api.path('/ppp/secret').select(
                Key('name'), Key('profile'), Key('disabled')
            ):
                row      = dict(r)
                if row.get('disabled') in ('true', 'yes', True):
                    continue
                username = str(row.get('name', '') or '').strip()
                if not username or username in result:
                    continue
                profile   = str(row.get('profile', '') or '').strip()
                local_ip  = profile_addr.get(profile, '')
                vlan      = _ip_to_vlan(local_ip)
                if vlan:
                    result[username] = vlan
                    offline_resolved += 1

            logger.info(f'[VLAN] Offline users resolved via profile: {offline_resolved}')

        except Exception as e:
            logger.warning(f'[VLAN] /ppp/secret resolve error: {e}')

        logger.info(
            f'[VLAN] Total resolved: {len(result)} dari MikroTik {self.ip}'
        )
        return result