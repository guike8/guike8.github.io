#!/usr/bin/env bash
# Initialize a local Docker runtime without changing the host's services or mounts.
set -euo pipefail

if [[ ${1:-} == --help ]]; then
  cat <<'HELP'
Usage: ./scripts/setup-local.sh

Run after ./scripts/build-containers.sh on macOS or Linux. Creates local runtime
folders, a private console token, and a self-signed localhost TLS certificate.
Existing valid secrets, stored activity, samples, and .env settings are preserved.
A fresh .env binds only to loopback on ports 8080, 8443, 2222, and 9090.
Requires an existing Docker engine, the built nightjar-app:local image, and openssl.
HELP
  exit 0
fi
if [[ $# != 0 ]]; then
  printf '%s\n' 'Usage: ./scripts/setup-local.sh [--help]' >&2
  exit 1
fi

nightjar_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$nightjar_root"
umask 077
for nightjar_command in docker openssl awk mktemp; do
  if ! command -v "$nightjar_command" >/dev/null 2>&1; then
    printf '%s\n' "Required local command is unavailable: $nightjar_command" >&2
    exit 1
  fi
done
if [[ ! -f compose.yaml || ! -f .env.example ]]; then
  printf '%s\n' 'Run this script from a complete honeypot source directory.' >&2
  exit 1
fi
if ! docker image inspect nightjar-app:local >/dev/null 2>&1; then
  printf '%s\n' 'Build the local images first with ./scripts/build-containers.sh.' >&2
  exit 1
fi
for nightjar_directory in state .secrets; do
  if [[ -L $nightjar_directory || ( -e $nightjar_directory && ! -d $nightjar_directory ) ]]; then
    printf '%s\n' 'Runtime roots must be ordinary directories, not links or files.' >&2
    exit 1
  fi
  mkdir -p -- "$nightjar_directory"
done
if [[ -L .env || ( -e .env && ! -f .env ) ]]; then
  printf '%s\n' 'The local .env path must be an ordinary file.' >&2
  exit 1
fi

nightjar_tls_directory=''
nightjar_env_temporary=''
cleanup_local_setup() {
  if [[ -n $nightjar_tls_directory && -d $nightjar_tls_directory ]]; then
    rm -rf -- "$nightjar_tls_directory"
  fi
  if [[ -n $nightjar_env_temporary && -f $nightjar_env_temporary ]]; then
    rm -f -- "$nightjar_env_temporary"
  fi
}
trap cleanup_local_setup EXIT

prepare_local_directories() {
  # The helper sees only the two runtime roots, has no network, and never prints
  # a secret. The host user retains the private directory for TLS regeneration;
  # files mounted into services are owned by their unprivileged runtime UID.
  docker run --rm -i --network none --log-driver none --read-only \
    --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges --pids-limit 16 --memory 64m \
    --mount "type=bind,src=$nightjar_root/state,dst=/runtime/state" \
    --mount "type=bind,src=$nightjar_root/.secrets,dst=/runtime/secrets" \
    -e "NIGHTJAR_HOST_UID=$(id -u)" -e "NIGHTJAR_HOST_GID=$(id -g)" \
    --entrypoint node nightjar-app:local - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const uid = 10001, gid = 10001;
const hostUid = Number(process.env.NIGHTJAR_HOST_UID);
const hostGid = Number(process.env.NIGHTJAR_HOST_GID);

function statIfPresent(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function ownership(target, stat, owner, group, mode) {
  if (stat.uid !== owner || stat.gid !== group) fs.chownSync(target, owner, group);
  if ((stat.mode & 0o7777) !== mode) fs.chmodSync(target, mode);
}
function ensureDirectory(target, mode, owner = uid, group = gid) {
  let stat = statIfPresent(target);
  if (!stat) { fs.mkdirSync(target, { mode }); stat = fs.lstatSync(target); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unexpected runtime directory');
  ownership(target, stat, owner, group, mode);
}
function ordinaryFile(target) {
  const stat = statIfPresent(target);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Unexpected secret file');
  return stat;
}
function readBounded(target, maximum) {
  const stat = ordinaryFile(target);
  if (!stat || stat.size > maximum) return null;
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile() || fs.fstatSync(descriptor).size > maximum) return null;
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
function certificateIsValid(target) {
  const bytes = readBounded(target, 65536);
  if (!bytes) return false;
  try {
    const certificate = new crypto.X509Certificate(bytes);
    const key = crypto.createPrivateKey(bytes);
    const now = Date.now();
    return certificate.checkPrivateKey(key)
      && Date.parse(certificate.validFrom) <= now
      && Date.parse(certificate.validTo) > now;
  } catch { return false; }
}

try {
  if (!Number.isSafeInteger(hostUid) || hostUid < 0 || !Number.isSafeInteger(hostGid) || hostGid < 0) throw new Error('Invalid host identity');
  ensureDirectory('/runtime/state', 0o750);
  ensureDirectory('/runtime/secrets', 0o700, hostUid, hostGid);
  const directories = [
    'web', 'beelzebub', 'console', 'cowrie', 'cowrie/log', 'cowrie/log/cowrie',
    'cowrie/lib', 'cowrie/lib/cowrie', 'cowrie/lib/cowrie/downloads',
    'cowrie/lib/cowrie/snapshots', 'cowrie/lib/cowrie/tty', 'cowrie/run', 'quarantine',
  ];
  for (const directory of directories) ensureDirectory(path.join('/runtime/state', directory), 0o750);
  ensureDirectory('/runtime/state/quarantine/objects', 0o700);

  const tokenPath = '/runtime/secrets/console_token';
  const token = readBounded(tokenPath, 128);
  if (!token || !/^[a-f0-9]{64}\n?$/i.test(token.toString('utf8'))) {
    const temporary = `${tokenPath}.${crypto.randomUUID()}.new`;
    try {
      fs.writeFileSync(temporary, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o400, flag: 'wx' });
      fs.chownSync(temporary, uid, gid);
      fs.renameSync(temporary, tokenPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  ownership(tokenPath, fs.lstatSync(tokenPath), uid, gid, 0o400);

  const certificatePath = '/runtime/secrets/frontend.pem';
  if (certificateIsValid(certificatePath)) {
    ownership(certificatePath, fs.lstatSync(certificatePath), uid, gid, 0o400);
    process.stdout.write('ready\n');
  } else {
    process.stdout.write('certificate-required\n');
  }
} catch {
  process.stderr.write('Local runtime directory or secret initialization failed.\n');
  process.exitCode = 1;
}
NODE
}

nightjar_certificate_state=$(prepare_local_directories)
case "$nightjar_certificate_state" in
  ready) ;;
  certificate-required)
    nightjar_tls_directory=$(mktemp -d "$nightjar_root/.secrets/local-tls.XXXXXX")
    cat > "$nightjar_tls_directory/request.cnf" <<'CONFIG'
[req]
distinguished_name = distinguished_name
x509_extensions = local_certificate
prompt = no
[distinguished_name]
CN = localhost
[local_certificate]
subjectAltName = @local_names
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
[local_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
CONFIG
    if ! openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -sha256 -days 365 -nodes -config "$nightjar_tls_directory/request.cnf" \
      -keyout "$nightjar_tls_directory/frontend.key" \
      -out "$nightjar_tls_directory/frontend.crt" >/dev/null 2>&1; then
      printf '%s\n' 'Could not generate the local TLS certificate with openssl.' >&2
      exit 1
    fi
    cat "$nightjar_tls_directory/frontend.key" "$nightjar_tls_directory/frontend.crt" > "$nightjar_tls_directory/frontend.pem"
    mv -f -- "$nightjar_tls_directory/frontend.pem" .secrets/frontend.pem
    # Host/VM clock granularity and shared-folder inode visibility can lag a
    # freshly generated certificate briefly. Recheck the same certificate;
    # never rotate it again just because the first check was too early.
    for nightjar_attempt in 1 2 3 4 5 6 7 8 9 10; do
      nightjar_certificate_state=$(prepare_local_directories)
      if [[ $nightjar_certificate_state == ready ]]; then break; fi
      sleep 0.2
    done
    if [[ $nightjar_certificate_state != ready ]]; then
      printf '%s\n' 'Local TLS certificate validation failed.' >&2
      exit 1
    fi
    ;;
  *)
    printf '%s\n' 'Unexpected local initialization result.' >&2
    exit 1
    ;;
esac

if [[ ! -f .env ]]; then
  nightjar_env_temporary=$(mktemp "$nightjar_root/.env.local.XXXXXX")
  awk '!/^(PUBLIC_BIND|HTTP_PORT|HTTPS_PORT|SSH_PORT|CONSOLE_BIND|CONSOLE_PORT)=/' .env.example > "$nightjar_env_temporary"
  cat >> "$nightjar_env_temporary" <<'ENV'
PUBLIC_BIND=127.0.0.1
HTTP_PORT=8080
HTTPS_PORT=8443
SSH_PORT=2222
CONSOLE_BIND=127.0.0.1
CONSOLE_PORT=9090
ENV
  mv -- "$nightjar_env_temporary" .env
  nightjar_env_temporary=''
fi

printf '%s\n' 'Local runtime initialized. From this honeypot directory, run docker compose up -d.' \
  'Existing .env settings were preserved; fresh settings use loopback ports 8080, 8443, 2222, and 9090.' \
  'The private console token was saved without printing it. Local quarantine uses the app’s 128 MiB cap.'
