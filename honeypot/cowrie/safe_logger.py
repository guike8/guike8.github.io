"""Twisted diagnostic observer that does not render attacker-supplied payloads."""
import json
import sys
from datetime import datetime, timezone
from twisted.logger import ILogObserver
from zope.interface import directlyProvides


def observer():
    def emit(event):
        level = getattr(event.get("log_level"), "name", "info")
        if level not in {"warn", "error", "critical"}:
            return
        # Never serialize message, format, failure, exception, arguments or locals:
        # Cowrie diagnostics can carry submitted login passwords in those fields.
        namespace = event.get("log_namespace", "cowrie")
        if not isinstance(namespace, str) or not namespace.startswith(("cowrie", "twisted")):
            namespace = "cowrie"
        sys.stdout.write(json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "component": namespace[:96], "level": level,
            "message": "SSH service diagnostic; inspect health status",
        }) + "\n")
        sys.stdout.flush()
    directlyProvides(emit, ILogObserver)
    return emit
