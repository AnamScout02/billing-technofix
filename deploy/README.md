# Migrasi TechnoFix ke Proxmox — Panduan Lengkap (Git-based)

Target: VM Ubuntu Server di Proxmox, IP lokal `172.15.0.11`, domain rencana
`technofix-bill.com`. Repo: `https://github.com/AnamScout02/billing-technofix.git`
(branch `main`).

Dengan workflow ini, **tidak perlu scp manual tiap update** — edit kode di
laptop (VS Code), `git push`, lalu di VM tinggal `git pull` + restart service.

---

## 0. Sebelum mulai — push kode terbaru ke GitHub

Dari laptop, di folder project (`c:\xampp\htdocs\billing`):

```bash
git add .
git commit -m "Siapkan deployment Proxmox (requirements, apache, systemd, scripts)"
git push origin main
```

> Catatan: file `*.db`, `venv/`, `__pycache__/`, `.claude/` sudah di-ignore
> (lihat `.gitignore`) — jadi database & environment lokal **tidak** ikut
> ter-upload. Ini di luar repo dan harus dipindah manual sekali (lihat
> langkah 4).

---

## 1. Buat VM di Proxmox

Ikuti panduan instalasi Ubuntu Server 22.04/24.04 LTS seperti yang sudah
dijelaskan sebelumnya (download ISO via "Query URL" dulu, buat VM, install
OS, set IP statis `172.15.0.11/28`, install `openssh-server` saat instalasi
supaya bisa di-SSH dari VS Code).

Setelah VM jalan, dari laptop:

```bash
ssh <user-kamu>@172.15.0.11
```

(Atau pakai VS Code Remote-SSH untuk edit langsung di VM kalau mau.)

---

## 2. Clone repo ke VM

Di dalam VM (via SSH):

```bash
sudo apt update
sudo apt install -y git
sudo mkdir -p /opt/technofix
sudo chown $USER:$USER /opt/technofix
git clone https://github.com/AnamScout02/billing-technofix.git /opt/technofix
cd /opt/technofix
```

> Jika repo **private**, `git clone` akan minta username + Personal Access
> Token (PAT) GitHub sebagai password. Bisa juga setup SSH key di VM dan
> pakai URL `git@github.com:AnamScout02/billing-technofix.git`.

---

## 3. Jalankan setup otomatis (sekali saja)

```bash
sudo bash deploy/setup-vm.sh
```

Script ini otomatis:
- Install `apache2`, `python3-venv`, `sqlite3`, `ufw`, dll.
- Aktifkan module Apache (`proxy`, `proxy_http`, `headers`, `rewrite`).
- Buat virtualenv Python di `/opt/technofix/venv` + install
  `requirements.txt`.
- Pasang & aktifkan service systemd `technofix-backend`
  (menjalankan `python input.py`, sama seperti di XAMPP — bukan gunicorn,
  karena `init_db()` dan worker background hanya jalan lewat
  `if __name__ == '__main__':`).
- Pasang vhost Apache `technofix.conf` (reverse proxy `/api`, `/olt`,
  `/devices` ke backend Flask di `127.0.0.1:5000`, frontend statis dilayani
  langsung oleh Apache dari `/opt/technofix`).
- Setup firewall `ufw` (allow SSH + Apache).

Cek hasilnya:

```bash
systemctl status technofix-backend
curl http://127.0.0.1/          # harus dapat HTML landing page
```

Akses dari browser laptop: `http://172.15.0.11/`

---

## 4. Pindahkan database existing (SEKALI, manual)

Karena file `.db` **tidak** masuk git (`.gitignore`), saat clone pertama
database owner masih kosong (`init_db()` cuma bikin skema baru). Kalau mau
bawa data pelanggan/owner yang sudah ada dari XAMPP, copy manual sekali via
`scp` dari laptop:

```bash
# Dari laptop (PowerShell), matikan dulu backend Flask lokal supaya file
# .db tidak sedang ditulis saat di-copy:
scp -r "C:\xampp\htdocs\billing\app\database" user@172.15.0.11:/opt/technofix/app/
```

Setelah itu restart backend di VM:

```bash
sudo systemctl restart technofix-backend
```

Ini **satu-satunya** langkah yang masih manual (sengaja — database adalah
data, bukan kode, jadi tidak cocok lewat git). Untuk update kode
selanjutnya, tidak perlu langkah ini lagi.

---

## 5. Workflow update selanjutnya (tanpa scp)

Setiap kali selesai edit kode di laptop (VS Code):

```bash
# Di laptop
git add .
git commit -m "Deskripsi perubahan"
git push origin main
```

Lalu di VM (SSH):

```bash
cd /opt/technofix
bash deploy/deploy.sh
```

`deploy.sh` otomatis `git pull`, update dependencies kalau
`requirements.txt` berubah, dan restart service backend.

Kalau perubahan ada di file `.js`/`.css` (frontend), jangan lupa
**hard-refresh** browser (`Ctrl+Shift+R`) — sama seperti aturan cache-busting
yang sudah dipakai selama ini.

---

## 6. Domain & HTTPS (nanti, setelah DNS technofix-bill.com siap)

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d technofix-bill.com -d www.technofix-bill.com
```

Certbot otomatis menambah blok `<VirtualHost *:443>` dan redirect HTTP→HTTPS
di `/etc/apache2/sites-available/technofix.conf`.

---

## Ringkasan file di folder `deploy/`

| File | Fungsi |
|---|---|
| `apache-technofix.conf` | Konfigurasi vhost Apache (reverse proxy + static frontend) |
| `technofix-backend.service` | Unit systemd untuk menjalankan `python input.py` |
| `setup-vm.sh` | Setup awal VM (sekali saja, setelah clone) |
| `deploy.sh` | Update kode (`git pull` + restart), dipakai berulang |
