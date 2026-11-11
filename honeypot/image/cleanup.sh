#!/usr/bin/env bash
# Image-build-only cleanup. Never run this on a collecting deployment.
set -euo pipefail

if [[ ${NIGHTJAR_IMAGE_BUILD:-} != 1 || ! -f /run/nightjar-image-build || $(id -u) != 0 ]]; then
  echo 'Refusing image cleanup outside the temporary root Packer builder.' >&2
  exit 1
fi
if [[ ! -f /opt/nightjar/scripts/install-image.sh ]]; then
  echo 'Expected Nightjar application source is missing.' >&2
  exit 1
fi

# install-image.sh must leave the application stopped. An image must contain
# no observations, quarantined bytes, per-instance certificates, or console keys.
if pgrep -f '/opt/nightjar/(web/main.mjs|console/main.mjs|cowrie/start.py)' >/dev/null; then
  echo 'Refusing to snapshot a running collector.' >&2
  exit 1
fi
if [[ -n $(docker ps --filter label=com.docker.compose.project=nightjar --format '{{.ID}}') ]]; then
  echo 'Refusing to snapshot running honeypot containers.' >&2
  exit 1
fi
if mountpoint -q /opt/nightjar/state/quarantine; then
  echo 'Refusing to snapshot a mounted quarantine store.' >&2
  exit 1
fi
rm -rf -- /opt/nightjar/state /opt/nightjar/.secrets
rm -f -- /opt/nightjar/.env
rm -f -- /var/lib/nightjar/quarantine.ext4
if [[ -f /swapfile ]]; then
  swapoff /swapfile
  shred --iterations=0 --zero --remove /swapfile
  sed -i '\|^/swapfile none swap sw 0 0$|d' /etc/fstab
fi

# Let every future Droplet obtain its own cloud metadata, authorized key,
# hostname, SSH host keys, and machine identity. Do not restart sshd here: Packer
# still uses its existing port-22 connection for this final provisioning step.
install -d -m 0755 /etc/cloud/cloud.cfg.d
cat > /etc/cloud/cloud.cfg.d/99-nightjar-image.cfg <<'CONFIG'
datasource_list: [ DigitalOcean, ConfigDrive, None ]
ssh_pwauth: false
ssh_deletekeys: true
ssh_genkeytypes: [ rsa, ecdsa, ed25519 ]
preserve_hostname: false
CONFIG
cloud-init clean --logs --machine-id
rm -rf -- /var/lib/cloud/*
rm -f -- /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f -- /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id

apt-get clean
rm -rf -- /var/lib/apt/lists/*
find /var/log -type f -exec truncate -s 0 {} +
rm -f -- /root/.bash_history /root/.wget-hsts /root/.docker/config.json
find /home -maxdepth 2 -type f -name '.bash_history' -delete

# File provisioner source staging and Packer temporary scripts are not runtime
# state. The active script remains mapped by this shell even after unlinking.
rm -f -- /tmp/script_*.sh
find /root/.ssh /home -type f -name authorized_keys -exec truncate -s 0 {} +
find /root/.ssh -maxdepth 1 -type f -name 'id_*' -delete
rm -f -- /run/nightjar-image-build
sync
