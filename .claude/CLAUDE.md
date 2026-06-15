# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Apa ini

**TechnoFix** — aplikasi **SaaS billing & monitoring jaringan untuk ISP**. Multi-tenant: banyak owner ISP berbagi satu server pusat, tiap owner punya database terisolasi. Fitur: manajemen pelanggan PPPoE, perangkat (MikroTik/OLT/ODC/ODP), peta topologi realtime (MapLibre), keuangan, dan sistem langganan (paket + trial + peran).

Bahasa UI & komentar kode: **Indonesia**.

## Menjalankan

Backend Flask (Python) — jalankan dari `app/backend/`:
```
python input.py        # listen 0.0.0.0:5000, debug=True, use_reloader=False
```
`input.py` adalah entry point: bikin app Flask, register semua blueprint, `init_db()`. **Restart manual** tiap ubah backend (reloader mati).

Frontend = file statis HTML/CSS/JS di `app/frontend/`, dilayani **Apache (XAMPP)** di `http://localhost/...`, BUKAN oleh Flask. Frontend memanggil API Flask di port 5000 (lihat `API_BASE` di `statis/global.js` — pemetaan hostname→`http://...:5000`).

Tidak ada build step, test runner, atau linter. Verifikasi backend lewat skrip ad-hoc dengan `app.test_client()` (lihat pola di riwayat: `python -c "import input as m; c=m.app.test_client(); ..."`).

Dependencies utama (pip): `flask`, `flask_cors`, `routeros_api`, `werkzeug`; opsional `scrapli` (RX/TX OLT realtime).

## Arsitektur Multi-Tenant (PALING PENTING)

Pemisahan data pakai **Opsi B — satu file SQLite per owner**:

```
app/database/
  devices.db              ← MASTER: networks, users, superadmins, upgrade_requests
  owners/<network_id>.db  ← DATA per owner: devices, pelanggan, olt, odc, odp,
                            onu_mapping, profil_harga
```

`utils.py` adalah jantung routing DB:
- `get_master_db()` → `devices.db` (auth & owner).
- `get_owner_db(network_id)` → file owner; **auto-buat file + `init_owner_schema()`** kalau belum ada.
- `get_db()` → **owner-aware**: baca `g.network_id` (diset decorator) atau `session['network_id']`, kembalikan DB owner itu. Tanpa konteks → fallback master.

**`auth.py` memakai `from utils import get_master_db as get_db`** — jadi SEMUA query di auth.py otomatis ke master (networks/users/superadmins). Jangan ubah ini.

Setiap blueprint data (`api`, `olt`, `odc`, `odp`, `maps`, dan rute `/devices` di `input.py`) punya `@xxx_bp.before_request` yang memanggil **`auth.guard_request(perm=..., allow_locked=...)`**. Guard ini: cek login → set `g.current_user`/`g.network_id` → cek lock langganan (402 kalau locked) → cek permission peran (403 kalau kurang). Karena `g.network_id` diset di sini, `get_db()` otomatis menunjuk DB owner yang benar pada request itu.

Konsekuensi: **endpoint data TIDAK menulis filter `WHERE network_id`** — isolasi murni dari file fisik. Cukup pakai `get_db()`.

## Paket, Trial, Lock, Peran

- **`packages.py`** = satu sumber kebenaran 8 paket + trial: harga, batas (`pelanggan`/`team`/dll), flag fitur. Ubah nama paket = ubah `name` (key dipakai DB, jangan diubah). `package_limit()`, `package_has_feature()`.
- **`roles.py`** = matriks permission per peran workspace: `owner`, `admin`, `teknisi`, `kolektor`. Token: `pelanggan`, `pelanggan_manage`, `perangkat`, `maps`, `keuangan`, `manajemen_user`, `bayar`, `langganan`. `owner` selalu lolos. Superadmin terpisah (tabel `superadmins`, sesi `session['superadmin_id']`).
- **Status langganan** (`utils.get_effective_status`): `trial`/`active`/`locked`/`suspended`. Trial 7 hari sejak daftar (`networks.trial_end`); lewat → `locked`. `active` berakhir di `expired_at`. Locked → semua data 402 (kecuali `/api/usage` & `/api/subscription`).
- **Enforcement batas**: cek di `POST /api/pelanggan` (limit pelanggan) dan `/api/auth/invite` (limit tim), keduanya baca `get_pelanggan_limit`/`package_limit`.
- **Flow upgrade**: owner `POST /api/auth/upgrade-request` → superadmin `GET /api/auth/admin/requests` lalu `.../approve` (set `active` + `expired_at`) atau `.../reject`.

## Frontend

Tiap halaman = folder `app/frontend/<nama>/` dengan `.html` + `.css` + `.js`, semua memuat `statis/global.js` (definisikan `API_BASE`, `getAuthHeaders`, `toast`, modal helpers, RBAC).

RBAC UI di `global.js`:
- `applyUIPermissions()` — sembunyikan elemen `[data-perm="..."]` jika peran tak punya izin (owner lihat semua); `PAGE_PERM_MAP` redirect akses langsung via URL; menu profil (Manajemen User/Langganan) digate by href.
- `checkSubscriptionLock()` — kalau status `locked`/`suspended`: owner di-redirect ke `/langganan/`, anggota tim diberi toast (tanpa redirect, anti-loop).
- Login menyimpan `tf_token`/`tf_role`/`tf_permissions` ke localStorage (`auth.js`); gating membaca itu.

Panel **Super Admin** terpisah total: `frontend/auth/admin_login.html` (mandiri, API_BASE inline, TIDAK muat global.js) → `frontend/superadmin/`. Login superadmin pertama lewat mode setup di `admin_login.html`.

Landing publik: `frontend/landing/`. Tombol paket → `auth/auth.html?register=1&paket=<key>` → tab register + paket terpilih.

## Konvensi & Gotcha

- **Cache-busting**: tag `<script>`/`<link>` pakai `?v=N`. Setelah ubah JS/CSS, **naikkan `?v`** dan minta user hard-refresh (Ctrl+Shift+R). Perubahan `global.js` mempengaruhi banyak halaman → wajib hard-refresh.
- **Windows console** (cp1252): hindari karakter unicode (panah `→`, dll) di `print()` skrip Python test — error encoding. Pakai ASCII.
- Username **unik global** di `users` dan `superadmins` (tabel master) — tidak boleh kembar antar workspace.
- File `manajemen_user.js`/`.css` pernah ter-overwrite konten `maps` — kalau lihat kode peta di file non-maps, itu korup, tulis ulang.
- Geolocation (tombol "Deteksi" → `geoDetectKoordinat` di global.js) hanya jalan di **HTTPS atau localhost**; di `http://IP` diblokir browser.
- Marker MapLibre: JANGAN beri `transform`/`transition:transform` atau `position` (CSS) pada elemen marker root — MapLibre memakai `transform`/`position:absolute` untuk positioning; konflik = marker melompat/scatter. Scale zoom lewat width/height atau elemen anak.

## Tabel Master (`devices.db`)

- `networks`: id, network_id (UUID), isp_name, **paket**, **status**, **trial_end**, **expired_at**.
- `users`: id, network_id, username, password_hash, role, nama, permissions (JSON), aktif.
- `superadmins`: pengelola platform.
- `upgrade_requests`: permintaan upgrade owner (pending/approved/rejected).

Skema DB owner didefinisikan di `utils.init_owner_schema()` (devices, pelanggan, olt, odc, odp, onu_mapping, profil_harga).
