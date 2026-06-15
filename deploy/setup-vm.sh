#!/bin/bash
# ============================================================
# Setup awal TechnoFix di VM Proxmox (Ubuntu 22.04/24.04)
# ============================================================
#
# Jalankan SEKALI saja di VM yang masih bersih, sebagai user
# yang akan menjalankan aplikasi (bukan root), dengan sudo:
#
#   sudo bash deploy/setup-vm.sh
#
# (Script ini harus dijalankan dari dalam folder hasil clone,
#  jadi clone repo dulu secara manual sebelum menjalankan ini —
#  lihat deploy/README.md langkah 1.)
# ============================================================
set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"

echo "==> Install dir : $INSTALL_DIR"
echo "==> App user    : $APP_USER"

echo "==> [1/7] Update sistem & install paket dasar"
apt update && apt upgrade -y
apt install -y apache2 python3 python3-pip python3-venv sqlite3 ufw

echo "==> [2/7] Aktifkan module Apache (proxy + headers)"
a2enmod proxy proxy_http headers rewrite >/dev/null

echo "==> [3/6] Siapkan folder database (tidak ikut git karena isi .db di-gitignore)"
sudo -u "$APP_USER" mkdir -p "$INSTALL_DIR/app/database/owners"

echo "==> [4/6] Setup virtualenv Python + dependencies"
sudo -u "$APP_USER" python3 -m venv "$INSTALL_DIR/venv"
sudo -u "$APP_USER" "$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
sudo -u "$APP_USER" "$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt"

echo "==> [5/6] Setup systemd service (technofix-backend)"
sed -e "s/User=technofix/User=$APP_USER/" \
    -e "s/Group=technofix/Group=$APP_USER/" \
    -e "s#/opt/technofix#$INSTALL_DIR#g" \
    "$INSTALL_DIR/deploy/technofix-backend.service" > /etc/systemd/system/technofix-backend.service
systemctl daemon-reload
systemctl enable --now technofix-backend

echo "==> [6/6] Setup Apache vhost (reverse proxy)"
sed -e "s#/opt/technofix#$INSTALL_DIR#g" \
    "$INSTALL_DIR/deploy/apache-technofix.conf" > /etc/apache2/sites-available/technofix.conf
a2ensite technofix.conf >/dev/null
a2dissite 000-default.conf >/dev/null 2>&1 || true
systemctl reload apache2

echo "==> [7/7] Firewall"
ufw allow OpenSSH
ufw allow 'Apache Full'
ufw --force enable

echo ""
echo "============================================================"
echo "Selesai!"
echo "  Cek backend : systemctl status technofix-backend"
echo "  Log backend : journalctl -u technofix-backend -f"
echo "  Akses web   : http://$(hostname -I | awk '{print $1}')/"
echo "============================================================"
