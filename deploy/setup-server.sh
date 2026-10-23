#!/usr/bin/env bash
# One-time server preparation (Ubuntu 22.04/24.04, run as root on the server).
# Installs Docker + rsync, adds swap (2 GB RAM is tight for QQ + the app),
# and configures a Docker Hub mirror, since Docker Hub is unreliable from
# mainland China.
#
#   bash setup-server.sh [registry-mirror-url]
#
# On Aliyun ECS, get your personal mirror URL from the console:
# 容器镜像服务 ACR -> 镜像工具 -> 镜像加速器 (looks like https://xxxx.mirror.aliyuncs.com)
set -euo pipefail

MIRROR="${1:-}"

echo "==> Installing Docker, Compose and rsync"
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 rsync
systemctl enable --now docker

if [ -n "$MIRROR" ]; then
  echo "==> Configuring Docker registry mirror: $MIRROR"
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<EOF
{ "registry-mirrors": ["$MIRROR"] }
EOF
  systemctl restart docker
fi

if ! swapon --show | grep -q /swapfile; then
  echo "==> Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Done"
docker --version
docker compose version
free -h
