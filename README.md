# guike8.github.io
Personal website for guike8: offensive security, security research, OSINT, open source, post-training, fine-tuning, cryptography, blockchain and privacy.

The [cloud-hosted page and HTTP decoys](https://guike8-nightjar.seithargroup.chatgpt.site) run on Workers with a private D1 metadata store through the already-connected Sites host. No server, tunnel, VPS, or background process is needed on the Mac, and no separate Cloudflare account or paid-plan upgrade was created.

The canonical profile remains `index.html`. The [Cloudflare source](cloudflare/README.md) builds that page with static decoys. Submitted bodies, files, cookies, authorization values and query strings are discarded. Observations are bounded to 5,000 per UTC day and 20,000 retained records, with bounded cleanup after seven days. Native deployment does not retain client IP addresses.

The [private catches dashboard](https://guike8-catches.seithargroup.chatgpt.site) is limited to the owner's existing ChatGPT account. It displays recent observations, timestamps, request paths, methods, categories, statuses and recognized clients. It provides current-page filters, manual refresh, pagination and a JSON export. Its server reads the collector using hosted secrets; the browser needs no API token. See the [dashboard source](dashboard/README.md) for the access boundary and build instructions.

The repository is private. If GitHub Pages remains available for the account, requests to its hostname still terminate at GitHub; the cloud URL above is the collecting endpoint. Cloudflare may filter requests before they reach the application. Captured observations do not establish that a visitor is malicious.
