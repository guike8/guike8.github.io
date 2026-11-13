# Nightjar HTTP Worker

This is the portable Cloudflare Workers + D1 edition of Nightjar. The current hosting path uses native Sites hosting and does not require a separate Cloudflare sign-in. The Wrangler configuration in this directory is an optional path for a future deployment in your own Cloudflare account.

The Worker serves the canonical repository homepage and synthetic HTTP decoys. It records bounded request metadata in D1 and provides a token-protected console at `/_nightjar/`. It does not run Beelzebub's binary, Cowrie, Docker, SSH, a real shell, or file capture. Request bodies, submitted credentials, cookies, and uploaded files are discarded. No service on your Mac needs to stay running.

## Build and verify

Use Node.js 24 or newer. From this directory:

```sh
npm ci
npm run build
npm run check
npm test
```

The build generates `src/homepage.mjs` and `src/routes.mjs` from the repository's canonical source. These commands do not start a server. There is deliberately no development-server script.

## Free plan boundaries

Native Sites hosting is managed through the already-connected account, with no separate Cloudflare account, payment method, or paid-plan upgrade created for this project. The application limits below are enforced independently of the hosting platform’s quotas. The listed Cloudflare Free quotas apply to the optional own-account deployment.

The portable configuration uses only Workers and D1. It does not configure R2, Durable Objects, KV, Queues, AI, containers, or a paid-plan upgrade. A Wrangler file cannot force an account onto the Free plan: verify the account is on **Workers Free** before any optional deployment. Do not deploy this configuration into a Workers Paid account when zero charges are required.

Cloudflare currently documents these Free limits:

| Resource | Free limit |
| --- | --- |
| Worker requests | 100,000 per day per account |
| Worker CPU | 10 ms per HTTP request |
| D1 rows read | 5 million per day per account |
| D1 rows written | 100,000 per day per account |
| D1 storage | 500 MB per database; 5 GB per account |

These account-wide quotas also include other projects using the same account. The application further limits stored observations to **5,000 per UTC day**, **20,000 retained events**, and **7 days**. Cleanup claims a 15-minute window and removes at most 100 expired events. Native Sites cleanup is driven by incoming requests; optional direct Cloudflare hosting also uses a cron trigger. Seven days is the expiry threshold, so older records can remain until the bounded cleanup catches up. Index updates and cleanup consume D1 writes too; dashboard queries consume reads. These application limits do not replace Cloudflare's quotas. When Free quotas are exhausted, requests or database operations can fail until the relevant quota resets; a dashboard may therefore become temporarily unavailable.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Workers observability, invocation logs, traces, Issues, and Logpush are disabled in the portable configuration to avoid storing raw URLs or request details in those channels. This does not disable Cloudflare's own platform security or billing records. The console displays observations, not a determination that a visitor is malicious.

## Optional deployment in your own account

This section is for later portability; it is not required for the native Sites hosting path. It creates remote resources and a public HTTP endpoint. First verify Workers Free and the available account quotas in your account dashboard. The commands below do not upgrade a plan.

1. Install the pinned dependencies and authenticate Wrangler to the intended account using Cloudflare's documented authentication flow. If multiple accounts are available, select the intended account explicitly. Do not put API tokens in this repository or chat.
2. Run `npx wrangler d1 list --json`. If `guike8-nightjar-events` does not exist, create it with `npx wrangler d1 create guike8-nightjar-events`. Copy the real database UUID into `database_id` in `wrangler.jsonc`; the checked-in value is deliberately an obvious placeholder.
3. Run `npm run build`, `npm run check`, and `npm test`.
4. Apply the schema only to the remote database: `npx wrangler d1 migrations apply guike8-nightjar-events --remote`.
5. Publish with `npx wrangler deploy`.
6. Set two independent, freshly generated secret values of at least 32 URL-safe characters using `npx wrangler secret put ADMIN_TOKEN` and `npx wrangler secret put IP_HASH_KEY`. Enter each value at Wrangler's secret prompt; keep the admin token in your password manager. Never put secret values in command arguments, source files, `.env` files, or saved JSON files. The private API remains inaccessible until a valid admin token is configured.

`TRUST_CF_IP=1` is appropriate only when this Worker receives requests directly from Cloudflare's edge. A separate hosted dispatcher must leave trusted source attribution disabled unless it provides a verified peer address; otherwise visitor-supplied headers could be mistaken for the source. The native Sites adapter leaves IP and country attribution disabled. The private Sites database viewer can inspect events without another provider login. The optional custom console remains protected by the hosted ADMIN_TOKEN secret.

Direct inbound public TCP is not supported by ordinary Workers, so this edition cannot become a public SSH honeypot. The prior Docker/tunnel deployment is separate and is not started by any command above. See [Worker protocol support](https://developers.cloudflare.com/workers/reference/protocols/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), and [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
