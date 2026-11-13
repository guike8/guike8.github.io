# guike8.github.io

A minimal red intro page for guike8: pentest, security research, post-training, fine-tuning, privacy, vampire kaomojis and the supplied XMR address.

`index.html` is the canonical homepage. GitHub Pages publishes it directly. The [VPS stack](honeypot/README.md) uses pinned [Beelzebub v3.10.0](honeypot/beelzebub/README.md) to serve that same page and HTTP decoys, Cowrie for SSH emulation, and a separate receiver for bounded file quarantine. Sanitized request metadata goes to the private console.

The honeypot is active only when traffic reaches that backend. GitHub Pages alone cannot run the collector or forward arbitrary probes to it. Use the VPS IP or a custom domain pointed at the VPS for the collecting endpoint. The reusable [DigitalOcean image builder](honeypot/image/README.md) includes the homepage automatically.
