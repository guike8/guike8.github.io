#!/usr/bin/env bash
set -euo pipefail
nightjar_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
packer_bin=${PACKER_BIN:-packer}
command -v "$packer_bin" >/dev/null || { echo 'Install Packer from HashiCorp, or set PACKER_BIN to its absolute path.' >&2; exit 1; }
context=$(mktemp -d "${TMPDIR:-/tmp}/nightjar-image.XXXXXX")
trap 'rm -rf -- "$context"; unset DIGITALOCEAN_TOKEN' EXIT
python3 "$nightjar_root/scripts/image-context.py" "$context" >/dev/null
"$packer_bin" init "$nightjar_root/image"
"$packer_bin" fmt -check "$nightjar_root/image"
if [[ -z ${DIGITALOCEAN_TOKEN:-} ]]; then
  if [[ ! -t 0 ]]; then echo 'Supply DIGITALOCEAN_TOKEN securely in the process environment, or run interactively.' >&2; exit 1; fi
  read -r -s -p 'DigitalOcean API token (hidden, not saved): ' DIGITALOCEAN_TOKEN
  printf '\n'
  export DIGITALOCEAN_TOKEN
fi
if [[ -z $DIGITALOCEAN_TOKEN ]]; then echo 'No token supplied.' >&2; exit 1; fi
revision=$(git -C "$nightjar_root" rev-parse HEAD 2>/dev/null || printf 'source-package')
"$packer_bin" validate -var "source_directory=$context" "$nightjar_root/image"
echo 'Building one temporary billable 1 GiB Ubuntu VPS and retaining its reusable snapshot.'
"$packer_bin" build -var "source_directory=$context" -var "source_revision=$revision" "$nightjar_root/image"
