#!/usr/bin/env bash
# One-time server preparation (Ubuntu 22.04/24.04, run as root on the server).
# Installs Docker + rsync, adds swap (2 GB RAM is tight for QQ + the app),
# configures Docker Hub mirrors (Docker Hub itself is unreachable from
# mainland China), and turns off SSH password login once a key is installed.
#
#   bash setup-server.sh [extra-registry-mirror-url]
#
# DaoCloud's public mirror is used by default: as of 2026-10 the Aliyun
# personal accelerator (https://xxxx.mirror.aliyuncs.com) answers "not found"
# for both images this project needs. Pass another mirror to try it first.
set -euo pipefail

MIRROR="${1:-}"

echo "==> Installing Docker, Compose and rsync"
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 rsync
systemctl enable --now docker

MIRRORS='"https://docker.m.daocloud.io"'
[ -n "$MIRROR" ] && MIRRORS="\"$MIRROR\", $MIRRORS"
echo "==> Configuring Docker registry mirrors: $MIRRORS"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{ "registry-mirrors": [$MIRRORS] }
EOF
systemctl restart docker

if ! swapon --show | grep -q /swapfile; then
  echo "==> Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Aliyun images set vm.swappiness=0 (99-apsara-sysctl.conf), so the swapfile
# goes unused and a build froze the server three times instead of swapping.
# This file sorts after theirs.
echo 'vm.swappiness = 60' > /etc/sysctl.d/99-zz-companion.conf
sysctl --system >/dev/null

# Bots try root passwords on every public IP all day. Once a key works, allow
# key logins only. sshd uses the first value it reads, and Ubuntu includes
# sshd_config.d/*.conf at the top, so a 00- file wins over cloud-init's 50-.
if [ -s /root/.ssh/authorized_keys ]; then
  echo "==> SSH: key login only (password login off)"
  cat > /etc/ssh/sshd_config.d/00-key-only.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
else
  echo "==> SSH: no key in /root/.ssh/authorized_keys yet, leaving password login on"
fi

echo "==> Done"
docker --version
docker compose version
free -h
