"""Cowrie output plugin: bounded, explicit fields only; never persist passwords."""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import ipaddress
import json
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
import re
import time

from cowrie.core.config import CowrieConfig
from cowrie.core.output import Output as BaseOutput

ALLOWED = frozenset({
    "cowrie.session.connect", "cowrie.session.closed", "cowrie.client.version",
    "cowrie.client.kex", "cowrie.login.failed", "cowrie.login.success",
    "cowrie.command.input", "cowrie.command.failed", "cowrie.session.params",
    "cowrie.direct-tcpip.request", "cowrie.direct-tcpip.data",
    "cowrie.session.file_download", "cowrie.session.file_download.failed",
    "cowrie.session.file_upload", "cowrie.session.file_upload.failed",
})
FIELD_LIMITS = {
    "timestamp": 40, "eventid": 64, "session": 64, "src_ip": 64,
    "username": 64, "input": 1024, "version": 192, "hassh": 32, "url": 256,
}


def text(value, limit):
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, (str, int, float)):
        return ""
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", str(value))[:limit]
    # Defense in depth for credentials pasted into commands or URL arguments.
    value = re.sub(r"(?i)(?:https?|ftp)://[^\s/@:]+:[^\s/@]+@", "https://[redacted]@", value)
    value = re.sub(r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s;&]+", r"\1=[redacted]", value)
    value = re.sub(r"([?&][A-Za-z0-9_.%-]{1,64}=)[^\s&#]+", r"\1[redacted]", value)
    return value[:limit]


def sanitize(event):
    if event.get("eventid") not in ALLOWED:
        return None
    result = {key: text(event[key], limit) for key, limit in FIELD_LIMITS.items() if key in event}
    if "src_ip" in result:
        try:
            result["src_ip"] = str(ipaddress.ip_address(result["src_ip"]))
        except ValueError:
            result.pop("src_ip")
    for key in ("duration", "duration_ms", "src_port", "dst_port"):
        if isinstance(event.get(key), (int, float)) and 0 <= event[key] < 1e12:
            result[key] = event[key]
    # A boolean preserves the useful fact of a password attempt without its value.
    if "password" in event:
        result["credential_attempt"] = True
    return result


class PrivateRotatingFileHandler(RotatingFileHandler):
    def _open(self):
        descriptor = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, "a", encoding=self.encoding, errors=self.errors)


class Output(BaseOutput):
    def start(self):
        path = Path(CowrieConfig.get("output_observatory", "logfile"))
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handler = PrivateRotatingFileHandler(
            path, maxBytes=CowrieConfig.getint("output_observatory", "max_bytes", fallback=2097152),
            backupCount=CowrieConfig.getint("output_observatory", "backups", fallback=3), encoding="utf-8",
        )
        path.chmod(0o600)
        self.handler.setFormatter(logging.Formatter("%(message)s"))
        self.window = deque()
        self.dropped = 0
        self.last_report = time.monotonic()

    def stop(self):
        self.handler.flush()
        self.handler.close()

    def write(self, event):
        result = sanitize(event)
        if result is None:
            return
        now = time.monotonic()
        while self.window and self.window[0] < now - 1:
            self.window.popleft()
        if len(self.window) >= 40:
            self.dropped += 1
            return
        self.window.append(now)
        if self.dropped and now - self.last_report >= 5:
            self._write({"timestamp": datetime.now(timezone.utc).isoformat(), "eventid": "cowrie.sensor.dropped", "count": self.dropped})
            self.dropped = 0
            self.last_report = now
        self._write(result)

    def _write(self, event):
        record = logging.LogRecord("observatory", logging.INFO, "", 0, json.dumps(event, ensure_ascii=True, separators=(",", ":")), (), None)
        self.handler.emit(record)
