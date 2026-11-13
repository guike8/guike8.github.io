#!/usr/bin/env bash
# Run only by the image builder on a fresh, disposable Ubuntu 24.04 VPS.
set -euo pipefail
if [[ $(id -u) != 0 || ${NIGHTJAR_IMAGE_BUILD:-} != 1 ]]; then
  echo 'This installer requires root and NIGHTJAR_IMAGE_BUILD=1 on a new image-builder VPS.' >&2; exit 1
fi
cd /opt/nightjar
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y --no-install-recommends curl openssl e2fsprogs util-linux python3 cloud-init ca-certificates
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update -q
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
dpkg --compare-versions "$(docker version --format '{{.Server.Version}}')" ge 28.0.0
# A 1 GiB builder may need swap while installing dependencies. It remains bounded.
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi
docker compose build --pull
docker compose pull ingress
docker compose config --quiet
chmod 0755 scripts/setup-runtime.sh
install -m 0644 scripts/nightjar.service /etc/systemd/system/nightjar.service
systemctl daemon-reload
systemctl enable nightjar.service
# Leave the Packer SSH session on 22. Launch-only cloud-init performs the port change.
# Do not call setup-runtime, compose up or start nightjar while baking the image.
docker image inspect nightjar-app:local nightjar-cowrie:local nightjar-beelzebub:3.10.0 >/dev/null
docker run --rm --network none --entrypoint node nightjar-app:local --check web/server.mjs
docker run --rm --network none --entrypoint python nightjar-cowrie:local -m unittest discover -s /opt/observatory -p 'test_safety.py'
install -d -m 0755 /etc/cloud/cloud.cfg.d
cat > /etc/cloud/cloud.cfg.d/90-nightjar-launch.cfg <<'EOF'
# Per-instance identities and management listener; all values here are public configuration.
ssh_deletekeys: true
ssh_genkeytypes: [ed25519, rsa]
ssh_pwauth: false
write_files:
  - path: /etc/ssh/sshd_config.d/00-nightjar.conf
    permissions: '0644'
    content: |
      Port 22222
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin prohibit-password
      AllowTcpForwarding local
      X11Forwarding no
      PermitTunnel no
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, disable, --now, ssh.socket]
  - [systemctl, enable, ssh.service]
  - [systemctl, restart, ssh.service]
  - [systemctl, --no-block, restart, nightjar.service]
EOF
echo 'Image software prepared. Runtime secrets and sensors remain uninitialized.'
