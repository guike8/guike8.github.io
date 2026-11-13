#!/usr/bin/env bash
set -euo pipefail
nightjar_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$nightjar_root"

compose() { docker compose -f compose.yaml -f compose.tunnel.yaml "$@"; }
tunnel_url() {
  local connector_id
  connector_id=$(compose ps --status running -q tunnel)
  if [[ -z $connector_id ]]; then return 1; fi
  # Read only the connector's private loopback metrics endpoint. Its logs are
  # disabled so proxy errors cannot persist attacker-controlled URLs or queries.
  docker run --rm -i --network "container:$connector_id" --log-driver none \
    --user 10001:10001 --read-only --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 32 --memory 96m --cpus 0.25 \
    --entrypoint node nightjar-app:local --input-type=module - "${1:-once}" <<'NODE'
const waiting = process.argv[2] === 'wait';
const deadline = Date.now() + (waiting ? 45000 : 1500);
do {
  try {
    const [ready, info] = await Promise.all([
      fetch('http://127.0.0.1:2000/ready', {signal:AbortSignal.timeout(1500)}),
      fetch('http://127.0.0.1:2000/quicktunnel', {signal:AbortSignal.timeout(1500)}),
    ]);
    const {hostname} = await info.json();
    if (ready.ok && info.ok && typeof hostname === 'string' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname)) {
      console.log(`https://${hostname}`);
      process.exit(0);
    }
  } catch {}
  if (!waiting) break;
  await new Promise(resolve => setTimeout(resolve, 1500));
} while (Date.now() < deadline);
process.exit(1);
NODE
}

case "${1:-help}" in
  start)
    # Compose !override keeps every published host port on loopback, even if
    # this checkout previously used a VPS-oriented .env file.
    compose config --quiet
    ./scripts/build-containers.sh
    ./scripts/setup-local.sh
    compose up -d --no-build
    echo 'Waiting for the temporary public HTTPS address…'
    public_url=$(tunnel_url wait || true)
    if [[ -z $public_url ]]; then
      echo 'The tunnel did not become ready. Check Docker, outbound network access, and ./scripts/tunnel.sh status.' >&2
      exit 1
    fi
    printf 'Public web honeypot: %s\n' "$public_url"
    echo 'Private console: http://127.0.0.1:19090'
    echo 'Read its token locally with: docker compose exec -T console cat /run/secrets/console_token'
    echo 'Keep Docker and this computer running. Stop public access with: ./scripts/tunnel.sh stop'
    ;;
  url)
    public_url=$(tunnel_url || true)
    if [[ -z $public_url ]]; then echo 'No running tunnel URL is available.' >&2; exit 1; fi
    printf '%s\n' "$public_url"
    ;;
  status)
    compose ps
    tunnel_url || true
    ;;
  stop)
    compose stop tunnel
    echo 'Public tunnel stopped. The honeypot and console remain available on loopback.'
    ;;
  help|--help|-h)
    echo 'Usage: ./scripts/tunnel.sh {start|url|status|stop}'
    echo 'Runs the HTTP honeypot through a temporary Cloudflare Quick Tunnel; no VPS or account required.'
    echo 'Requires Docker Compose 2.24.4+, Python 3 and OpenSSL. Start builds the images and initializes local state.'
    ;;
  *) echo 'Usage: ./scripts/tunnel.sh {start|url|status|stop}' >&2; exit 2 ;;
esac
