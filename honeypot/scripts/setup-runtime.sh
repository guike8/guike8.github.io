#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run this script as root on the dedicated honeypot VPS.' >&2; exit 1; fi
cd /opt/nightjar
umask 077
install -d -m 0750 -o 10001 -g 10001 state/{web,console,cowrie/log/cowrie,cowrie/lib/cowrie,cowrie/run,quarantine}
install -d -m 0700 .secrets
if ! grep -Eq '^[[:xdigit:]]{64}$' .secrets/console_token 2>/dev/null; then
  openssl rand -hex 32 > .secrets/console_token.new
  mv .secrets/console_token.new .secrets/console_token
fi
if ! openssl x509 -in .secrets/frontend.pem -noout 2>/dev/null || ! openssl pkey -in .secrets/frontend.pem -noout 2>/dev/null; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -days 365 -nodes \
    -subj '/CN=staging-02' -keyout .secrets/frontend.key -out .secrets/frontend.crt 2>/dev/null
  cat .secrets/frontend.key .secrets/frontend.crt > .secrets/frontend.pem.new
  mv .secrets/frontend.pem.new .secrets/frontend.pem
  rm .secrets/frontend.key .secrets/frontend.crt
fi
chown 10001:10001 .secrets/console_token .secrets/frontend.pem
chmod 0400 .secrets/console_token .secrets/frontend.pem
install -d -m 0700 /var/lib/nightjar
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab; fi
fi
if [[ ! -e /var/lib/nightjar/quarantine.ext4 ]]; then
  truncate -s 192M /var/lib/nightjar/quarantine.ext4
  mkfs.ext4 -q -m 0 /var/lib/nightjar/quarantine.ext4
fi
if ! mountpoint -q state/quarantine; then
  mount -o loop,nodev,nosuid,noexec /var/lib/nightjar/quarantine.ext4 state/quarantine
fi
if [[ $(findmnt -n -o OPTIONS --target state/quarantine) != *noexec* ]]; then
  echo 'Refusing startup: quarantine is not mounted noexec.' >&2; exit 1
fi
install -d -m 0700 -o 10001 -g 10001 state/quarantine/objects
if [[ ! -f .env ]]; then
  cp .env.example .env
  # The custom image configures real management SSH on 22222, leaving 22 for Cowrie.
  sed -i 's/^SSH_PORT=.*/SSH_PORT=22/' .env
fi
chmod 0600 .env
echo 'Nightjar runtime initialized; private console token is stored on the VPS.'
