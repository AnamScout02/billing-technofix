#!/bin/bash
# ============================================================
# Update TechnoFix di VM dari Git (ganti scp manual)
# ============================================================
#
# Jalankan di VM setiap kali ada perubahan kode baru di GitHub:
#
#   bash deploy/deploy.sh
#
# Script ini akan:
#   1. git pull perubahan terbaru
#   2. update dependencies Python (kalau requirements.txt berubah)
#   3. restart service backend (reloader Flask mati, jadi wajib restart)
# ============================================================
set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INSTALL_DIR"

echo "==> Tarik perubahan terbaru dari GitHub"
git pull

echo "==> Update dependencies Python (jika ada perubahan)"
./venv/bin/pip install -q -r requirements.txt

echo "==> Restart backend (technofix-backend)"
sudo systemctl restart technofix-backend

echo ""
echo "============================================================"
echo "Update selesai."
echo "  Cek status : systemctl status technofix-backend"
echo "  Log        : journalctl -u technofix-backend -f"
echo ""
echo "Kalau ada perubahan file .js/.css, hard-refresh browser"
echo "(Ctrl+Shift+R) supaya tidak pakai versi cache lama."
echo "============================================================"
