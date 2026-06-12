# TechnoFix di Proxmox — Cheat Sheet Harian

VM: `technofix` — IP `172.15.0.11` — user SSH: `technofix`

---

## 1. Menyalakan VM

Kalau VM Proxmox sudah pernah di-setup dan **mati/restart**:

1. Login ke web UI Proxmox: `https://<ip-proxmox>:8006`
2. Klik VM **`technofix`** di sidebar kiri
3. Klik tombol **Start** (di kanan atas)
4. Tunggu ~30 detik sampai boot selesai (service akan auto-start: Apache + backend Flask, karena sudah `systemctl enable`)

> Tidak perlu masuk ke Console kecuali untuk troubleshooting — semua kerja sehari-hari lewat SSH.

---

## 2. Login ke VM (SSH)

Dari laptop (PowerShell / terminal VS Code):

```bash
ssh technofix@172.15.0.11
```

Masukkan password yang dibuat saat instalasi.

> Tips: kalau sering konek, bisa setup SSH key supaya tidak perlu input password tiap kali (opsional, tanya kalau mau setup).

---

## 3. Akses aplikasi via browser

```
http://172.15.0.11/app/frontend/auth/auth.html       ← halaman login
http://172.15.0.11/app/frontend/landing/landing.html ← landing page
```

(Nanti kalau domain `technofix-bill.com` sudah aktif, tinggal ganti IP dengan domain.)

---

## 4. Cek status & log backend Flask

```bash
# Status service (harus "active (running)")
sudo systemctl status technofix-backend

# Lihat log realtime (Ctrl+C untuk keluar)
sudo journalctl -u technofix-backend -f

# Lihat 50 baris log terakhir
sudo journalctl -u technofix-backend -n 50 --no-pager
```

---

## 5. Restart / Start / Stop backend

```bash
sudo systemctl restart technofix-backend   # restart (wajib tiap update kode backend)
sudo systemctl stop technofix-backend      # matikan
sudo systemctl start technofix-backend     # nyalakan
```

---

## 6. Update kode dari GitHub (workflow rutin)

**Di laptop** (VS Code), setelah selesai edit & sudah ditest:
```bash
git add .
git commit -m "Deskripsi perubahan"
git push origin main
```

**Di VM** (SSH):
```bash
cd /opt/technofix
bash deploy/deploy.sh
```

`deploy.sh` otomatis: `git pull` → update dependencies Python (kalau `requirements.txt` berubah) → restart `technofix-backend`.

> Kalau ada perubahan file `.js`/`.css` di frontend → **hard-refresh browser** (`Ctrl+Shift+R`).

---

## 7. Cek & restart Apache (frontend + reverse proxy)

```bash
sudo systemctl status apache2
sudo systemctl restart apache2

# Lihat error log Apache
sudo tail -50 /var/log/apache2/technofix-error.log
```

---

## 8. Backup database (manual, sebelum perubahan besar)

```bash
# Di VM — backup ke folder home
mkdir -p ~/backup
cp -r /opt/technofix/app/database ~/backup/database-$(date +%Y%m%d-%H%M)
```

Atau download ke laptop (dari PowerShell di laptop):
```powershell
scp -r technofix@172.15.0.11:/opt/technofix/app/database "C:\Backup\technofix-db-$(Get-Date -Format yyyyMMdd)"
```

---

## 9. Cek penggunaan resource VM

```bash
htop          # CPU & RAM (tekan q untuk keluar; kalau belum ada: sudo apt install htop)
df -h         # sisa disk
free -h       # memory
```

---

## 10. Troubleshooting cepat

| Masalah | Cek |
|---|---|
| Halaman tidak terbuka sama sekali | `sudo systemctl status apache2` |
| Halaman terbuka tapi data tidak muncul / error API | `sudo systemctl status technofix-backend` + `journalctl -u technofix-backend -n 50` |
| 403 Forbidden di `/` | Normal — akses path spesifik, mis. `/app/frontend/auth/auth.html` |
| Setelah `git pull`, error `unable to open database file` | Pastikan folder `/opt/technofix/app/database/owners` ada: `mkdir -p /opt/technofix/app/database/owners` |
| Setelah update JS/CSS, tampilan tidak berubah | Hard-refresh: `Ctrl+Shift+R` |

---

## 11. Reboot VM penuh (kalau perlu)

```bash
sudo reboot
```

Setelah reboot (~1 menit), semua service (Apache + `technofix-backend`) akan **otomatis menyala lagi** (sudah `systemctl enable`). Tunggu sebentar lalu cek halaman login seperti biasa.
