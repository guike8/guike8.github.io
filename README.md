# guike8.github.io

A minimal red intro page for guike8: offensive security, security research, open-source intelligence (OSINT), open source, post-training, fine-tuning, cryptography, blockchain, privacy, vampire kaomojis and the supplied XMR address.

`index.html` is the canonical homepage. GitHub Pages publishes it directly. The [honeypot stack](honeypot/README.md) uses pinned [Beelzebub v3.10.0](honeypot/beelzebub/README.md) to serve that same page and HTTP decoys, Cowrie for SSH emulation, and a separate receiver for bounded file quarantine. Sanitized request metadata goes to the private console.

The [local tunnel option](honeypot/README.md#run-without-a-vps) exposes the web honeypot from Docker on your own computer, with a temporary public HTTPS address and no VPS or Cloudflare account. The computer must stay online. The console stays on loopback; SSH remains local in this mode.

The honeypot is active only when traffic reaches that backend. GitHub Pages alone cannot run the collector or forward arbitrary probes to it. For a dedicated server, use its IP or a custom domain pointed at it. The reusable [DigitalOcean image builder](honeypot/image/README.md) includes the homepage automatically.
