"""
mikrotik.py — TechnoFix MikroTik Client
Wrapper di atas librouteros untuk komunikasi ke RouterOS API
"""

import librouteros
from librouteros import connect
from librouteros.query import Key
import logging


# ── Setup Logging ──
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class MikroTikError(Exception):
    """Exception khusus untuk error koneksi / perintah MikroTik."""
    pass


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

    # ── PPP Secrets ──
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
            rows = api.path('/ppp/active').select(
                Key('name'), Key('service'), Key('address'),
                Key('uptime'), Key('caller-id'),
            )
            result = [dict(r) for r in rows]
            logger.info(f"Berhasil mengambil {len(result)} koneksi aktif dari MikroTik {self.ip}")
            return result
        except MikroTikError:
            raise
        except Exception as e:
            raise MikroTikError(f'Gagal membaca koneksi aktif: {e}')

    def tambah_secret(self, data: dict):
        """Menambahkan PPP Secret baru ke MikroTik."""
        try:
            api = self._get_api()
            api.path('/ppp/secret').add(**data)
            logger.info(f"PPP Secret '{data.get('name')}' berhasil ditambahkan ke MikroTik {self.ip}")
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
