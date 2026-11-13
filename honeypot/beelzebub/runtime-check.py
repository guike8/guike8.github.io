#!/usr/bin/env python3
"""Exercise the pinned build stage on loopback; never retain its raw log stream.

Run after building --target beelzebub-build -t nightjar-beelzebub-build:test.
Docker logging is disabled. Raw stdout/stderr are consumed through memory pipes.
Only assertions and an explicit safe-field projection are printed.
"""
from pathlib import Path
from threading import Thread
import hashlib
import http.client
import json
import os
import subprocess
import time

root = Path(__file__).resolve().parent
config = root / "generated"
expected = (root.parent / "web/public/index.html").read_bytes()
name = "nightjar-beelzebub-check-" + str(os.getpid())
records = []


def collect(stream):
    for line in stream:
        try:
            row = json.loads(line)
            if isinstance(row.get("event"), dict):
                records.append(row["event"])
        except (ValueError, AttributeError):
            pass


process = subprocess.Popen([
    "docker", "run", "--rm", "--name", name, "--log-driver", "none",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5",
    "-p", "127.0.0.1::8080", "-v", str(config) + ":/config:ro",
    "--entrypoint", "/out/beelzebub", "nightjar-beelzebub-build:test", "run",
    "--mem-limit-mib", "64", "--conf-core", "/config/core.yaml", "--conf-services", "/config/services",
], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
readers = [Thread(target=collect, args=(stream,), daemon=True) for stream in (process.stdout, process.stderr)]
for reader in readers:
    reader.start()
try:
    port = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = subprocess.run(["docker", "inspect", "--format", '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}', name], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip().isdigit():
            port = int(result.stdout.strip())
            break
        if process.poll() is not None:
            raise RuntimeError("Beelzebub runtime exited before accepting requests")
        time.sleep(0.1)
    if port is None:
        raise RuntimeError("Loopback runtime did not start")

    def request(path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    for _ in range(30):
        try:
            status, body, _ = request("/")
            if status == 200:
                break
        except (OSError, http.client.HTTPException):
            time.sleep(0.1)
    else:
        raise RuntimeError("HTTP listener did not become ready")
    assert body == expected, "Root bytes differ from the canonical staged homepage"
    assert request("/index.html")[1] == expected
    assert request("/", "HEAD")[1] == b""
    assert request("/.env")[0] == 200
    assert request("/.git/HEAD")[0] == 200
    assert request("/admin/")[0] == 200
    assert request("/admin/session", "POST", "username=fixture&password=private-fixture", {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Bearer private-fixture",
        "Cookie": "session=private-fixture",
        "X-Nightjar-Source": "203.0.113.10",
        "X-Forwarded-For": "203.0.113.11",
    })[0] == 303
    assert request("/does-not-exist")[0] == 404
    assert request("/api/status")[0] == 200
    assert request("/.env", "PUT")[0] == 405
    deadline = time.monotonic() + 3
    while len(records) < 10 and time.monotonic() < deadline:
        time.sleep(0.05)
    login = next(row for row in records if row.get("RequestURI") == "/admin/session")
    assert login["Protocol"] == "HTTP"
    assert login["Handler"] == "authentication:303"
    assert "private-fixture" in login["Body"], "Upstream schema changed: inspect redaction boundary"
    assert "private-fixture" in login["Cookies"]
    assert "private-fixture" in login["Headers"]
    assert login["SourceIp"] != "203.0.113.11", "Untrusted forwarded source was accepted"
    projection = {key: login[key] for key in ("DateTime", "Protocol", "HTTPMethod", "RequestURI", "Handler")}
    print(json.dumps({"checks": 12, "homepage_sha256": hashlib.sha256(expected).hexdigest(), "raw_stream_persisted": False, "upstream_sensitive_fields_confirmed": True, "safe_trace_projection": projection}))
finally:
    subprocess.run(["docker", "stop", "--time", "3", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=3)
    for reader in readers:
        reader.join(timeout=1)
    records.clear()
