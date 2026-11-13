# Private observations dashboard

This dashboard is a separate **owner-private Sites app**. It uses the current Sites identity and does not require a separate Cloudflare account, provider sign-in, or a service running on your Mac. Keep its visibility owner-private; do not publish or share it as a public site.

The public honeypot continues to collect HTTP metadata. This private app displays those existing observations through a server-side proxy:

1. Your browser accesses the private Sites app through its identity boundary.
2. The dashboard Worker requests only the fixed public honeypot's `/_nightjar/api/overview` and `/_nightjar/api/events` endpoints.
3. The server supplies `HONEYPOT_ADMIN_TOKEN` from a hosted Sites secret. The browser does not receive, enter, or persist that credential.

The dashboard has no D1 binding or independent event store. Its code does not configure a paid Cloudflare plan or add storage, queues, containers, or other cloud services. Source events stay in the existing honeypot database; access to this interface is separate from public honeypot traffic. Provider-level access and traffic records remain under the hosting platform's control.

## Source and build

Use Node.js 24 or newer. No package dependencies are required. From this directory:

```sh
npm run check
npm test
npm run build
```

The dependency-free build writes one ESM Worker to the ignored `dist/worker.mjs`. For native Sites artifact packaging, an operator can instead run:

```sh
node scripts/build.mjs --bundle-worker /absolute/path/to/artifact/server/index.js
```

The build gives the UI module its own lexical scope, preserves the Worker entry exports, and rejects unsupported imports rather than including external modules. These commands parse, test, and package source only. They do not start a server, open a tunnel, authenticate a provider account, or deploy anything. There is deliberately no `dev` or `start` script.

`src/index.mjs` owns the fixed upstream and private API proxy. `src/ui.mjs` owns the browser interface. Tests use Node and mocked requests; they require no local listener or public honeypot requests.

## Hosted configuration

The Sites deployment must remain owner-private and must expose `HONEYPOT_ADMIN_TOKEN` to the server as a hosted secret. Configure it through the existing Sites connection; never put its value in source, CLI arguments, chat, saved JSON, or an environment file. A missing or invalid upstream credential prevents reading observations; the app must not substitute invented activity.

The existing collector's limits are unchanged: at most **5,000 admitted events per UTC day** and **20,000 retained events**. Seven days is the expiration threshold, with deletion processed in bounded cleanup batches. Older rows can remain until cleanup completes. New observations are omitted when a cap is reached, so the dashboard is a bounded view rather than a complete forensic record.

The public collector retains sanitized request paths, methods, statuses, timestamps, and recognized user-agent products. It discards request bodies, submitted files, credentials, cookies, and query strings. This dashboard does not enable SSH, Beelzebub or Cowrie binaries, file capture, shell execution, or a local deployment.

The deployed dashboard is [guike8 / catches](https://guike8-catches.seithargroup.chatgpt.site), restricted to the owner's existing ChatGPT account. A browser without that session sees the Sites sign-in gate. This does not require creating another hosting account. Visibility must remain owner-private.
