# Nightjar

A small, real HTTP/HTTPS and emulated SSH honeypot. Pinned **Beelzebub v3.10.0** serves the repository-root `index.html` byte-for-byte at `/` and `/index.html`, plus static HTTP decoys. Cowrie supplies SSH emulation; the Node receiver handles binary uploads. This directory provides the collector and private console. Run it locally with a public HTTP tunnel, or on a dedicated VPS for directly reachable web and SSH ports.

For a dedicated server, the reusable **DigitalOcean snapshot** is prepared with Packer. The image includes the application, fixed container images and startup configuration. The final image cleanup removes builder identity and runtime state; each launched Droplet initializes its own identities and secrets.

## What it does

- HAProxy accepts HTTP, HTTPS and SSH, preserving the source address into separate isolated backends. Public HTTP is handled by Beelzebub; `/upload` and `/api/upload` route to the bounded Node intake service.
- Beelzebub serves the personal intro and synthetic `staging-02` administration, API, configuration, Git and backup paths. Only static handlers are enabled. No LLM provider, dynamic plugin, Beelzebub Cloud, RabbitMQ or public metrics listener is configured.
- The upstream HTTP tracer puts request bodies, credentials, cookies and headers into raw events. A Node supervisor keeps those streams in pipes, selects only bounded metadata, and writes the sanitized result to a rotating spool. Raw child stdout/stderr never go directly to Docker logging or a file. See [the pinned runtime configuration and logging boundary](beelzebub/README.md).
- Cowrie 3.1.6 emulates a Linux shell and filesystem. Login attempts, client fingerprints and commands are observed, while passwords and rendered diagnostic payloads are excluded from persistent logs. Forwarding, real shell execution, SCP/SFTP and outbound downloads are disabled.
- A private console combines the two sensors into searchable events, hourly activity, recurring sources, session details and a bounded NDJSON export.
- Raw binary uploads to `/upload` or `/api/upload` are hashed and retained as **unclassified samples**, never executed or publicly served. No URL is fetched from an attacker command.

The repository-root homepage is the single source. `scripts/build-containers.sh` stages its exact bytes into an ignored build artifact; the Beelzebub image embeds it into validated YAML handlers during the build. The image-context exporter refreshes it from root as well. Rebuild and restart the services to deploy page edits. No request chooses a filesystem path.

The HTTP network is fixed to `172.30.243.0/24`. Dynamic addresses come from `172.30.243.128/25`; HAProxy owns `172.30.243.2` outside that pool. Beelzebub trusts only that proxy's `/32` for forwarded source attribution. If this subnet overlaps another network, change both Compose IPAM and the generator's trusted-proxy constant together. The optional tunnel network reserves `172.30.244.0/24`; its connector address `172.30.244.2` must stay synchronized between the overlay and HAProxy's connector ACL. HAProxy overwrites supplied forwarding headers. Beelzebub, the upload receiver and SSH each have a separate internal network; none publishes a direct host port.

Ingress caps regular HTTP bodies at 8 KiB, URLs at 4 KiB and binary header representation at 8 KiB. Small request bodies must finish within 5 seconds, including byte-trickling clients. Raw artifact streams retain the Node service's independent 2 MiB cap and 5-second deadline. Ingress rejections do not enter Beelzebub's application event stream.

GitHub Pages can publish the intro but cannot run this collector. The collecting endpoint is the tunnel URL, VPS IP, or a custom domain routed to either. Requests and unknown paths sent to `guike8.github.io` still terminate at GitHub; a client-side redirect or analytics beacon would not capture scanners that never run JavaScript. No such beacon is included.

## Run without a VPS

Install Docker Desktop (or Docker Engine on Linux), Docker Compose **2.24.4 or newer**, Python 3 and OpenSSL. From this checkout:

```sh
cd honeypot
./scripts/tunnel.sh start
```

The helper builds the containers, prepares local state and random secrets, starts the stack, and prints a temporary public `https://…trycloudflare.com` address. No Cloudflare account, domain, router port forwarding, or host installation of `cloudflared` is required. The pinned official connector runs in its own container and can reach only the ingress, not the console or decoy networks. Backend egress remains blocked. All published host ports are forced to loopback even if `.env` previously used public VPS bindings.

Visit `http://127.0.0.1:19090` for the private console. Run `docker compose exec -T console cat /run/secrets/console_token` locally and enter the result there. The console and SSH are not published through the tunnel. The connector uses a separate unpublished listener; HAProxy accepts a single valid `CF-Connecting-IP` only from that connector's fixed peer address, strips external forwarding headers, and supplies the validated address to the sensors. Direct HTTP cannot spoof that trust. Connector logs are disabled; the helper obtains the public hostname and readiness through a private loopback endpoint inside its network namespace.

```sh
./scripts/tunnel.sh url       # show the running public URL
./scripts/tunnel.sh status    # show local service status
./scripts/tunnel.sh stop      # stop public access; keep local services/data
# To stop the entire local stack:
docker compose -f compose.yaml -f compose.tunnel.yaml down
```

Keep the computer awake and Docker running while collecting. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are temporary development endpoints: the hostname changes on a new tunnel, there is no uptime guarantee, and at most 200 requests can be in flight. A named Cloudflare Tunnel and your own domain can provide a stable hostname later. This mode observes HTTP traffic reaching that address; it does not expose ordinary SSH to Internet port scans, and Cloudflare terminates public TLS before forwarding requests. It also does not reveal a dedicated public IP for scanners to find. Do not treat test requests as organic attacker activity.

Local uploads retain the application quotas and SHA-256 storage behavior below. They use a Docker bind directory rather than the VPS image's separate ext4 filesystem; there is no additional 192 MiB filesystem quota or `noexec` mount in this local mode. Samples are never executed or served by the application.

## Build our image

Read [the image build instructions](image/README.md). A DigitalOcean account and an operator-supplied API token are needed for the actual snapshot build. Neither the token nor a private SSH key belongs in this repository.

Prepare a clean context outside the checkout:

```sh
python3 honeypot/scripts/image-context.py /absolute/path/to/empty/nightjar-context
packer init honeypot/image
packer validate -var 'source_directory=/absolute/path/to/empty/nightjar-context' honeypot/image
packer build -var 'source_directory=/absolute/path/to/empty/nightjar-context' honeypot/image
```

Supply `DIGITALOCEAN_TOKEN` securely in the build process environment, without placing it in the command line, a saved variables file or shell history. The snapshot build uses a temporary billable Ubuntu 24.04 x64 Droplet. Packer normally deletes that builder and its temporary SSH key; retain the resulting snapshot for launches. An interrupted build needs an account resource check before retrying. No paid resource is created by `validate`.

## Launch and access

Create a Droplet from the snapshot, select your own SSH public key and **leave User Data empty** so the image's first-boot configuration is preserved. Attach a cloud firewall with:

| Direction | Port | Source / purpose |
| --- | --- | --- |
| Inbound TCP | 22 | Public SSH honeypot |
| Inbound TCP | 80, 443 | Public web honeypot |
| Inbound TCP | 22222 | Only your administrative IP/CIDR |
| Inbound TCP | 9090 | No public rule; console is loopback-only |

Allow the host's normal outbound package, DNS and cloud-init traffic. Decoy egress is separately blocked by the internal Docker networks and SSH application guard. Honeypot services share no network with the console and have no Docker socket or host-device access. The TLS certificate is instance-generated and self-signed; a custom domain and trusted certificate can be configured separately.

After cloud-init completes, open a terminal on your own computer:

```sh
ssh -p 22222 -L 9090:127.0.0.1:9090 root@SERVER_IP
```

On the server, obtain the console token for your own local session:

```sh
sudo cat /opt/nightjar/.secrets/console_token
```

Visit `http://127.0.0.1:9090` on your computer and enter that token. It remains only in tab memory. `systemctl status nightjar` and `journalctl -u nightjar` provide operational diagnostics; request payloads are not logged to the container console. A local preview has ordinary test activity, not evidence of public attackers.

## Storage and limits

Events live in SQLite, persist across service restarts and are retained for 7 days with a 50,000-event target cap enforced every minute. Beelzebub and upload spools each rotate across 3 × 5 MiB; SSH rotates across 4 × 2 MiB and applies an event-rate cap. The Beelzebub decoder discards raw lines over 64 KiB and incomplete records. Events may be dropped under sustained load; SSH rate-limit drops are surfaced as sensor events. Beelzebub's lifecycle status is not an HTTP code: the adapter derives intended static response codes from configured handler names, with method mismatches represented as 405. Cursor checkpoints and event inserts commit together, including across source-file rotation. This is a bounded observatory, not a complete forensic recorder.

Samples have a 2 MiB per-file limit, 128 MiB aggregate limit, 256-object limit and four concurrent upload slots. On the VPS image, a separate 192 MiB ext4 loop filesystem mounted with `noexec,nodev,nosuid` bounds the backing store; samples use SHA-256 filenames and mode `0400` in both deployment modes. Files persist until the operator removes them. At capacity, new uploads are rejected. Multipart bodies and submitted filenames are not parsed; this captures raw binary HTTP uploads only. Captured bytes are not a malware verdict. No sample is executed, rendered, fetched from a supplied URL, or submitted to an external analysis service.

The upload service must remain a **single writer**. The console receives only read-only source and quarantine mounts and exposes inventory metadata, with no sample-download endpoint. Runtime state, images, credentials and samples are excluded from Git and from the explicit image source context. Never snapshot a collecting instance to make a distributable image.

## Verification

```sh
cd honeypot
npm test
./scripts/build-containers.sh
docker run --rm --network none --entrypoint python nightjar-cowrie:local /opt/observatory/test_safety.py
```

On the launched VPS, run `sudo /opt/nightjar/scripts/verify.sh`. It uses the existing Node container image; Node need not be installed on the host. The check deliberately submits an inert fixture and creates test observations. It checks decoy behavior, TLS, the SSH banner, private API access, sample metadata and blocked backend egress. It does not send malware or scan third-party systems. Test hostnames/ports can be overridden with `HTTP_URL`, `HTTPS_URL`, `CONSOLE_URL` and `SSH_PORT` for a local preview.

The image template is validated locally; a successful cloud build and first-boot check are still required before claiming the snapshot or public deployment is ready.
