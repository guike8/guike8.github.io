#!/usr/bin/env python3
"""Atomically stage the canonical root homepage without committing a second copy."""
from pathlib import Path
import os
import sys
import tempfile

MAX_HOMEPAGE_BYTES = 256 * 1024


def sync_homepage(canonical: Path, destination: Path):
    data = canonical.read_bytes()
    if not data or len(data) > MAX_HOMEPAGE_BYTES:
        raise ValueError('Homepage must contain 1–262144 bytes')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.homepage-', delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    source = Path(__file__).resolve().parent.parent
    canonical = source.parent / 'index.html'
    destination = source / 'web/public/index.html'
    if len(sys.argv) != 1:
        raise SystemExit('Usage: python3 scripts/sync-homepage.py')
    # A sanitized /opt/nightjar image context contains the baked artifact only.
    # Its original repository-root source is intentionally not copied wholesale.
    packaged = not canonical.exists()
    sync_homepage(destination if packaged else canonical, destination)
    print('Packaged homepage verified for the container build.' if packaged else 'Canonical homepage staged for the container build.')
