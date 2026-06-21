"""
roles.py — TechnoFix-Bill · Definisi Peran & Hak Akses (per workspace)
==================================================================
Peran dalam SATU workspace ISP (selain Super Admin yang global):

  owner     → pemilik ISP. Akses penuh + kelola tim + langganan/upgrade.
  admin     → operasional penuh (termasuk Keuangan). TANPA langganan SaaS.
  teknisi   → perangkat, maps, monitoring, provisioning. TANPA Keuangan.
  kolektor  → lihat pelanggan + klik "Bayar" (aktifkan kembali). TANPA
              perangkat/konfigurasi/keuangan.

Token permission (dipakai frontend data-perm & backend):
  pelanggan, perangkat, maps, keuangan, manajemen_user, bayar
"""

ALLOWED_ROLES = ('owner', 'admin', 'teknisi', 'kolektor')

# Token permission:
#   pelanggan         → lihat daftar pelanggan
#   pelanggan_manage  → tambah/edit/hapus pelanggan
#   perangkat         → MikroTik/OLT/ODC/ODP
#   maps              → peta topologi
#   keuangan          → modul keuangan
#   bayar             → catat pembayaran / aktifkan kembali pelanggan
#   manajemen_user    → kelola tim
#   langganan         → upgrade/perpanjang paket SaaS (owner saja)
ROLE_PERMISSIONS = {
    'owner':    ['pelanggan', 'pelanggan_manage', 'perangkat', 'perangkat_manage', 'maps',
                 'keuangan', 'manajemen_user', 'bayar', 'langganan'],
    'admin':    ['pelanggan', 'pelanggan_manage', 'perangkat', 'perangkat_manage', 'maps',
                 'keuangan', 'manajemen_user', 'bayar'],
    'teknisi':  ['pelanggan', 'pelanggan_manage', 'perangkat', 'maps'],
    # teknisi: bisa LIHAT perangkat tapi tidak bisa tambah/edit/delete perangkat
    'kolektor': ['pelanggan', 'bayar', 'maps'],
}

# Label tampilan peran
ROLE_LABEL = {
    'owner':    'Owner',
    'admin':    'Admin',
    'teknisi':  'Teknisi',
    'kolektor': 'Kolektor',
}


def default_permissions(role: str) -> list:
    """Permission default untuk sebuah peran."""
    return list(ROLE_PERMISSIONS.get(role, []))


def role_has(role: str, perm: str) -> bool:
    """Apakah peran punya permission tertentu (owner selalu True)."""
    if role == 'owner':
        return True
    return perm in ROLE_PERMISSIONS.get(role, [])
