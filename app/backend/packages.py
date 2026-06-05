"""
packages.py — TechnoFix · Definisi Paket Langganan (SaaS)
==========================================================
Satu sumber kebenaran untuk semua paket: harga, batas, fitur.

Struktur:
  KEY    → ID paket (DIPAKAI DI DB, JANGAN diubah)
  name   → nama tampilan (boleh diganti bebas)
  price  → harga per bulan (Rupiah)
  limits → batas yang DI-ENFORCE backend
  feature→ flag fitur (dikunci per paket; sebagian masih roadmap)

Cara ganti nama paket: cukup ubah 'name' di sini.
Cara ganti harga/batas: ubah 'price' / 'limits'.
"""

# None = tanpa batas
PACKAGES = {
    # ── TRIAL ──────────────────────────────────────────────
    'trial': {
        'name':  'Trial',
        'tagline': 'Eksplorasi seluruh fitur',
        'price': 0,
        'trial_days': 7,
        'limits': {'pelanggan': 50, 'mikrotik': None, 'olt': None, 'team': 3, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': False, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── STARTER ────────────────────────────────────────────
    'starter': {
        'name':  'Pemula',
        'tagline': 'Cocok untuk ISP baru',
        'price': 150_000,
        'limits': {'pelanggan': 500, 'mikrotik': None, 'olt': None, 'team': 3, 'loket': 2},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': False, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── ESSENTIAL ──────────────────────────────────────────
    'essential': {
        'name':  'Esensial',
        'tagline': 'Cocok untuk ISP bertumbuh',
        'price': 200_000,
        'limits': {'pelanggan': 200, 'mikrotik': None, 'olt': None, 'team': 4, 'loket': 2},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── STANDART ───────────────────────────────────────────
    'standar': {
        'name':  'Standar',
        'tagline': 'Pilihan terbaik ISP menengah',
        'price': 300_000,
        'limits': {'pelanggan': 1000, 'mikrotik': None, 'olt': None, 'team': 6, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── PRO ────────────────────────────────────────────────
    'pro': {
        'name':  'Pro',
        'tagline': 'Untuk ISP yang siap scale-up',
        'price': 600_000,
        'limits': {'pelanggan': 2500, 'mikrotik': None, 'olt': None, 'team': 10, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── ADVANCED ───────────────────────────────────────────
    'advanced': {
        'name':  'Lanjutan',
        'tagline': 'Cocok untuk fase ekspansi',
        'price': 900_000,
        'limits': {'pelanggan': 4000, 'mikrotik': None, 'olt': None, 'team': 15, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── BUSINESS ───────────────────────────────────────────
    'business': {
        'name':  'Bisnis',
        'tagline': 'ISP penguasa wilayah',
        'price': 1_500_000,
        'limits': {'pelanggan': 7000, 'mikrotik': None, 'olt': None, 'team': 30, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': False, 'dedicated': False,
        },
    },

    # ── ENTERPRISE ─────────────────────────────────────────
    'enterprise': {
        'name':  'Enterprise',
        'tagline': 'Untuk ISP multi cabang',
        'price': 3_000_000,
        'limits': {'pelanggan': 15000, 'mikrotik': None, 'olt': None, 'team': None, 'loket': None},
        'features': {
            'mikrotik_api': True, 'odp_map': True, 'billing': True, 'broadcast': True,
            'loket': True, 'komisi_loket': True, 'payment_gateway': True, 'tiket': True,
            'bandwidth_on_demand': True, 'spk': True, 'absensi': True, 'mobile_app': True,
            'remote_modem': True, 'monitoring_redaman': True, 'export': True,
            'genieacs': True, 'whitelabel': True, 'dedicated': True,
        },
    },
}

# Urutan tampil (kecil → besar)
PACKAGE_ORDER = ['trial', 'starter', 'essential', 'standar',
                 'pro', 'advanced', 'business', 'enterprise']

DEFAULT_PACKAGE = 'trial'
TRIAL_DAYS = 7


def get_package(key: str) -> dict:
    """Ambil definisi paket. Fallback ke trial jika key tak dikenal."""
    return PACKAGES.get(key, PACKAGES[DEFAULT_PACKAGE])


def package_limit(key: str, what: str):
    """Batas tertentu (pelanggan/mikrotik/olt/team/loket). None = unlimited."""
    return get_package(key)['limits'].get(what)


def package_has_feature(key: str, feature: str) -> bool:
    """Apakah paket punya fitur tertentu."""
    return bool(get_package(key)['features'].get(feature, False))


def public_packages() -> list:
    """Daftar paket untuk ditampilkan di landing/UI (tanpa flag internal)."""
    out = []
    for k in PACKAGE_ORDER:
        p = PACKAGES[k]
        out.append({
            'key':      k,
            'name':     p['name'],
            'tagline':  p.get('tagline', ''),
            'price':    p['price'],
            'limits':   p['limits'],
            'features': p['features'],
        })
    return out
