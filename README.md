# guike8.github.io

A minimal intro page for guike8: pentest, security research, post-training, fine-tuning, privacy, and a little vampire. ㇏(•̀ᵥᵥ•́)ノ

`index.html` is the canonical homepage. GitHub Pages publishes it directly; the [Nightjar honeypot](honeypot/README.md) serves the exact same page through its VPS backend and records incoming requests and decoy probes in the private console.

The honeypot is active only when traffic reaches that backend. GitHub Pages alone cannot run the collector or forward arbitrary probes to it. Use the VPS IP or a custom domain pointed at the VPS for the collecting endpoint. The reusable [DigitalOcean image builder](honeypot/image/README.md) includes the homepage automatically.
