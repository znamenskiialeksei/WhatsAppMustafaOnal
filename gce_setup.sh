#!/bin/bash
set -e

echo "=== Обновление и запуск платформы на GCE VM ==="

sudo apt-get update && sudo apt-get install -y \
  git curl build-essential chromium-browser ca-certificates \
  fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release xdg-utils || sudo apt-get install -y chromium

if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo npm install -g pm2
npm install

if [ ! -f .env ]; then
  cp .env.example .env
fi

pm2 start ecosystem.config.js || pm2 restart whatsapp-bot
pm2 save
echo "=== Сервер обновлен и работает! Логи: pm2 logs whatsapp-bot ==="
