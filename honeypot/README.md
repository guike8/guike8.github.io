# Nightjar

A small, real HTTP/HTTPS and emulated SSH honeypot for a dedicated VPS. The public front door is the minimal vampire intro from the repository-root `index.html`, served byte-for-byte at `/` and `/index.html`. This directory adds the server-side collector and decoy endpoints behind that page.

The recommended deployment is a reusable **DigitalOcean snapshot**, prepared with Packer. The image includes the application, fixed container images and startup configuration. The final image cleanup removes builder identity and runtime state; each launched Droplet initializes its own identities and secrets.

## What it does

- HAProxy accepts HTTP, HTTPS and SSH, preserving the source address into separate isolated backends.
- The web service serves the personal intro page and records incoming requests without browser analytics. Probes can discover a synthetic `staging-02` archive through administration, API, fake configuration, Git and backup paths. Authentication bodies are discarded.
- Cowrie 3.1.6 emulates a Linux shell and filesystem. Login attempts, client fingerprints and commands are observed, while passwords and rendered diagnostic payloads are excluded from persistent logs. Forwarding, real shell execution, SCP/SFTP and outbound downloads are disabled.
- A private console combines the two sensors into searchable events, hourly activity, recurring sources, session details and a bounded NDJSON export.
- Raw binary uploads to `/upload` or `/api/upload` are hashed and retained as **unclassified samples**, never executed or publicly served. No URL is fetched from an attacker command.

The repository-root homepage is the single source. `scripts/build-containers.sh` stages its exact bytes into an ignored build artifact before a local Docker build. The image-context exporter always copies the current root page into the image build as well. The server reads the page once at startup; rebuild and restart the service to deploy page edits. No request chooses a filesystem path.

GitHub Pages can publish the intro but cannot run this collector. The collecting endpoint must be the VPS IP or a custom domain pointed at the VPS. Requests and unknown paths sent to `guike8.github.io` still terminate at GitHub; a client-side redirect or analytics beacon would not capture scanners that never run JavaScript. No such beacon is included.

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

Events live in SQLite, persist across service restarts and are retained for 7 days with a 50,000-event target cap enforced every minute. Source logs rotate (web 3 × 5 MiB, SSH 4 × 2 MiB); SSH also applies an event-rate cap. Events may be dropped under sustained load; SSH rate-limit drops are surfaced as sensor events. Cursor checkpoints and event inserts commit together, including across source-file rotation. This is a bounded observatory, not a complete forensic recorder.

Samples have a 2 MiB per-file limit, 128 MiB aggregate limit, 256-object limit and four concurrent upload slots. A separate 192 MiB ext4 loop filesystem mounted with `noexec,nodev,nosuid` bounds the backing store; samples use SHA-256 filenames and mode `0400`. Files persist until the operator removes them. At capacity, new uploads are rejected. Multipart bodies and submitted filenames are not parsed; this captures raw binary HTTP uploads only. Captured bytes are not a malware verdict. No sample is executed, rendered, fetched from a supplied URL, or submitted to an external analysis service.

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
