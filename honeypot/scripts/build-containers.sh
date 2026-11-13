#!/usr/bin/env bash
set -euo pipefail
nightjar_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
python3 "$nightjar_root/scripts/sync-homepage.py"
cd "$nightjar_root"
docker compose build "$@"
