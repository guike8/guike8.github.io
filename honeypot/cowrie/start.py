"""Start Cowrie's shell emulator with an additional application egress guard."""
from pathlib import Path
import os
import sys

os.umask(0o077)
if os.getuid() == 0:
    raise SystemExit("Run the SSH decoy as its unprivileged container user")
for path in ("var/log/cowrie", "var/lib/cowrie/downloads", "var/lib/cowrie/snapshots", "var/lib/cowrie/tty", "var/run"):
    Path(path).mkdir(parents=True, exist_ok=True)

from twisted.internet import reactor
from twisted.internet.error import ConnectError
from twisted.internet import defer


def deny_connect(*args, **kwargs):
    raise ConnectError("Network is unreachable")


def deny_resolve(*args, **kwargs):
    return defer.fail(ConnectError("Network is unreachable"))

# Incoming listenTCP/accepted connections are unaffected. This is defense in
# depth; the Docker network and host firewall are the actual egress boundary.
reactor.connectTCP = deny_connect
reactor.connectSSL = deny_connect
reactor.connectUNIX = deny_connect
reactor.listenUDP = deny_connect
reactor.resolve = deny_resolve

# Fail closed if the custom plugin/config cannot load. Cowrie otherwise skips
# an output plugin whose import/start raises and can run without observation.
from cowrie.core.config import CowrieConfig
from cowrie.output.observatory import Output

if CowrieConfig.get("honeypot", "backend") != "shell":
    raise SystemExit("Only the simulated shell backend is permitted")
if CowrieConfig.getboolean("output_jsonlog", "enabled", fallback=False):
    raise SystemExit("Default unredacted output must remain disabled")
probe = Output()
probe.stop()

from twisted.scripts.twistd import run
sys.argv = ["twistd", "-n", "--umask=0077", "--pidfile=", "--logger=safe_logger.observer", "cowrie"]
run()
