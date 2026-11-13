"""Build a coherent synthetic filesystem from the trusted, bundled Cowrie tree."""
from pathlib import Path
import pickle
import stat
from cowrie.core.resources import read_data_bytes

root = pickle.loads(read_data_bytes("fs.pickle"))
MTIME = 1736467200


def directory(parts):
    node = root
    for part in parts:
        children = node[7]
        child = next((item for item in children if item[0] == part), None)
        if child is None:
            child = [part, 1, 0, 0, 4096, stat.S_IFDIR | 0o755, MTIME, [], None, None]
            children.append(child)
        if child[1] != 1:
            raise ValueError("Synthetic directory conflicts with existing filesystem")
        node = child
    return node


def file(path, contents, mode=0o644):
    parts = path.strip("/").split("/")
    parent = directory(parts[:-1])
    encoded = contents.encode("utf-8")
    parent[7] = [node for node in parent[7] if node[0] != parts[-1]]
    parent[7].append([parts[-1], 2, 0, 0, len(encoded), stat.S_IFREG | mode, MTIME, encoded, None, None])


file("/etc/hostname", "staging-02\n")
file("/etc/issue", "Debian GNU/Linux 12 \\n \\l\n")
file("/etc/motd", "Debian GNU/Linux 12 (bookworm)\n\nMaintenance window: archive migration pending.\n")
file("/root/README.txt", "Archive staging node\n--------------------\nWeb root: /var/www/html\nExport queue: /srv/archive\nThe nightly export job is paused during storage maintenance.\n")
file("/root/.bash_history", "cd /srv/archive\nls -lah\ncat /var/www/html/.env\nsystemctl status archive-worker\n")
file("/var/www/html/.env", "APP_NAME=archive\nAPP_ENV=staging\nAPP_DEBUG=false\nDB_HOST=127.0.0.1\nDB_DATABASE=archive_staging\nDB_USERNAME=archive_reader\nDB_PASSWORD=synthetic-local-only\n")
file("/var/www/html/README.md", "# Archive staging\nThe export API lives at /api/v1/.\nBackups are staged in /srv/archive before rotation.\n")
file("/srv/archive/README.txt", "Nightly exports are temporarily paused.\nLast completed export: inventory-2025-01-10.sql\n")
file("/srv/archive/inventory-2025-01-10.sql", "-- Synthetic staging fixtures\nCREATE TABLE inventory (id integer, name text, status text);\nINSERT INTO inventory VALUES (1, 'staging-index', 'queued');\n")
Path("/opt/observatory/fs.pickle").write_bytes(pickle.dumps(root, protocol=4))
