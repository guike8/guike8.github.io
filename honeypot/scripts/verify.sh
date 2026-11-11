#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
docker compose ps
docker run --rm --network host --user 10001:10001 --cap-drop ALL \
  --security-opt no-new-privileges --read-only --memory 128m \
  -e "HTTP_URL=${HTTP_URL:-http://127.0.0.1:80}" \
  -e "HTTPS_URL=${HTTPS_URL:-https://127.0.0.1:443}" \
  -e "CONSOLE_URL=${CONSOLE_URL:-http://127.0.0.1:9090}" \
  -e "SSH_PORT=${SSH_PORT:-22}" \
  -v "$PWD/scripts/smoke.mjs:/app/scripts/smoke.mjs:ro" \
  -v "$PWD/.secrets/console_token:/app/.secrets/console_token:ro" \
  --entrypoint node nightjar-app:local /app/scripts/smoke.mjs
docker compose exec -T web node -e 'const s=require("net").connect(443,"1.1.1.1");s.on("connect",()=>process.exit(1));s.on("error",e=>{console.log("web egress:",e.code);process.exit(e.code==="ENETUNREACH"?0:2)});s.setTimeout(2000,()=>process.exit(3))'
docker compose exec -T ssh python -c 'import socket; s=socket.socket(); s.settimeout(2); result=s.connect_ex(("1.1.1.1",443)); print("ssh egress errno:", result); assert result==101'
