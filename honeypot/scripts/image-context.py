#!/usr/bin/env python3
"""Create an explicit source-only image context; never copy logs, keys or samples."""
from pathlib import Path
import shutil
import sys
from importlib.util import spec_from_file_location, module_from_spec

source = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve()
if target == source or source in target.parents:
    raise SystemExit('Choose an empty context directory outside the source checkout')
if target.exists() and any(target.iterdir()):
    raise SystemExit('Context directory must be empty')
target.mkdir(parents=True, exist_ok=True)
files = ['Dockerfile', '.dockerignore', '.env.example', 'compose.yaml', 'compose.tunnel.yaml', 'ingress.cfg', 'package.json']
directories = ['web', 'console', 'cowrie', 'beelzebub', 'adapters', 'scripts', 'image', 'test']
for name in files:
    shutil.copy2(source / name, target / name)
for name in directories:
    shutil.copytree(source / name, target / name, ignore=shutil.ignore_patterns(
        '__pycache__', '*.pyc', '*.pkrvars.hcl', '.packer.d', 'packer_cache', 'packer-manifest.json', 'manifest.json', 'generated',
        '.env', '.secrets', 'state', '*.key', '*.pem', '*.qcow2', '*.img', '*.raw'))
# The root page is the only additional repository file in this source context.
# Always overwrite an old ignored build artifact with the current canonical page.
spec = spec_from_file_location('nightjar_homepage_asset', source / 'scripts/sync-homepage.py')
homepage_asset = module_from_spec(spec)
spec.loader.exec_module(homepage_asset)
homepage_asset.sync_homepage(source.parent / 'index.html', target / 'web/public/index.html')
print(target)
