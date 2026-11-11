# SSH decoy

This is Cowrie **3.1.6**, pinned with all installed Python dependencies and a multi-architecture Python base-image digest. It runs as UID/GID **10001**, emulates a Debian 12 `staging-02` archive node, and listens on container TCP **2222**. A trusted HAProxy peer must prepend the PROXY v1/v2 header; the listener is never published directly. This preserves the original source address while allowing Cowrie to remain on an internal network without an Internet route.

The `shell` backend interprets commands against a synthetic filesystem; it does not hand visitors a system shell. `prepare_fs.py` adds coherent archive files to the trusted bundled filesystem during the image build. Submitted scripts are never executed by the host OS. SFTP, TCP forwarding, and SCP sample retention are disabled. Outgoing Twisted TCP, TLS, Unix-socket, UDP-listener, and resolver calls are blocked as an extra guard; Docker network isolation remains the security boundary.

Mount `/cowrie/var` writable with owner `10001:10001` to retain host keys, sensor identity, and sanitized events. Mount `/cowrie/var/lib/cowrie/downloads` and `/cowrie/var/lib/cowrie/snapshots` as **bounded noexec tmpfs**, so incidental emulator artifacts are ephemeral. Keep the container root filesystem read-only, drop all capabilities, and use `no-new-privileges`, memory/CPU/PID limits. The container needs no Docker socket or host directories.

`events.json` contains a strict field allowlist. Submitted login passwords and rendered event messages are discarded before writing. Raw TTY transcripts and the default Cowrie JSON output are disabled. Commands are limited to 1,024 stored characters and common inline credential/query-value patterns are redacted; private command logs may still contain visitor-supplied text. The diagnostic observer emits only timestamp, component, and severity. It deliberately omits exception messages because those can contain passwords.

`events.json` rotates at **2 MiB**, keeping **3 backups**. Every file is mode `0600`; the process uses umask `0077`. Telemetry is capped at 40 events/second with a dropped-event counter. The collector must handle inode replacement/rotation; it should read this log volume with read-only access. Authentication lasts at most 45 seconds, logged-in transport at most 600 seconds, and idle shells at most 90 seconds. No notifications or third-party enrichment requests are sent.

Build and test from the honeypot directory:

```sh
docker build -t observatory-cowrie ./cowrie
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=16m \
  --entrypoint python observatory-cowrie /opt/observatory/test_safety.py
```

The end-to-end VPS smoke test should establish a session through HAProxy, verify original source attribution, check a synthetic command event, and confirm that neither a submitted fixture password nor a TTY transcript was retained. Test the internal network's egress denial separately.

Upstream references: [release](https://github.com/cowrie/cowrie/releases/tag/v3.1.6), [configuration](https://github.com/cowrie/cowrie/blob/v3.1.6/src/cowrie/data/etc/cowrie.cfg.dist), [SSH transport source](https://github.com/cowrie/cowrie/blob/v3.1.6/src/cowrie/ssh/transport.py), [output plugin contract](https://github.com/cowrie/cowrie/blob/v3.1.6/src/cowrie/core/output.py).
