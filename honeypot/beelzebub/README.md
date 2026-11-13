# Beelzebub HTTP runtime

The HTTP decoy is the genuine, unmodified [Beelzebub](https://github.com/beelzebub-labs/beelzebub) **v3.10.0** runtime, built from commit `a02d0354e19a01e97eeccaf1874419dcb05b94ca`. `UPSTREAM.json` records the official source archive and verified SHA-256. The Dockerfile pins the Go builder and Node runtime images, verifies Go modules, and embeds version/commit metadata. The complete corresponding upstream source archive and GPL license are included under `/usr/share/beelzebub/` in the resulting image.

Only an HTTP service on internal port **8080** is configured. Cowrie retains SSH emulation; the separate Node receiver retains binary quarantine uploads. No LLM, Maze, external plugin, cloud reporting, RabbitMQ, or metrics listener is enabled.

## Canonical public page

`generate-config.mjs` reads the staged `web/public/index.html` prepared from the repository-root page by the existing homepage helper. It embeds those exact UTF-8 bytes as Beelzebub's static handler for both `/` and `/index.html`. It neither writes biography text nor fabricates personal details. Rebuilding the image updates the served page.

The generator rejects missing, empty, invalid UTF-8, byte-order-mark, or oversized input. Generated configuration is JSON-as-YAML: this preserves HTML whitespace and Unicode while passing through Beelzebub's actual YAML parser and strict v1 schema. Docker builds run the upstream validator before completing.

## Decoy behavior

Specific routes precede fallbacks:

- `/robots.txt`, `/.env`, `/.env.backup`, and selected `/.git/` paths.
- `/archive/`, `/backup/`, a small synthetic SQL export, and an export manifest.
- `/admin/`, `/wp-login.php`, and maintenance-style authentication responses. Submissions grant no real access.
- `/api/status`, `/api/version`, restricted internal API responses, and static exploit-probe fallbacks.

Every fixture is synthetic. Static handlers do not run commands, parse visitor input, retrieve external URLs, or echo submitted text into responses. Request methods are explicit; a method mismatch produces upstream's real 405 response. Unknown paths produce a real 404. All responses use bounded static content and restrictive browser headers.

Only `172.30.243.2/32` is trusted to supply a forwarded source IP. The stack assigns that address to HAProxy on the isolated HTTP network. HAProxy must overwrite client-supplied `X-Forwarded-For` and `X-Nightjar-Source`; backends must remain unpublished. The adapter prefers Beelzebub's source address resolved through that exact trusted proxy; a validated private source header is only a configured fallback.

The optional local Cloudflare tunnel uses a separate unpublished HAProxy listener. Only its fixed connector peer may supply a single validated bare `CF-Connecting-IP`; direct listeners ignore that header. HAProxy then supplies the verified address through the same trusted backend path. The connector never joins the Beelzebub network.

## Logging boundary

Beelzebub's upstream HTTP tracer emits raw bodies, cookies, and headers. Its `core.logging.logsPath` is therefore explicitly empty: the child writes only into the Node supervisor's pipes. The supervisor discards raw payloads and persists a bounded field allowlist through the existing rotating log spool. Neither stdout nor stderr of the raw child may be attached to Docker logging or a file.

The upstream event's `Status` is a lifecycle string, not an HTTP status code. Static command names encode `category:status`, for example `authentication:303`. The adapter accepts only known categories and numeric codes. The empty-handler method-mismatch event maps to 405. This avoids representing `Stateless` as a response code.

The unmodified upstream HTTP server has no configurable header/body deadlines or connection cap. HAProxy supplies those limits; the container additionally has CPU, memory, PID, read-only filesystem, capability, and internal-network restrictions. Its sole configured service has no outbound behavior. Network isolation remains the egress boundary.

## Validation

From `honeypot/` after staging the canonical homepage:

```sh
node --test beelzebub/config.test.mjs
docker build -f beelzebub/Dockerfile --target beelzebub-build \
  -t nightjar-beelzebub-build:test .
node beelzebub/generate-config.mjs web/public/index.html beelzebub/generated
docker run --rm --network none --read-only --entrypoint /out/beelzebub \
  -v "$PWD/beelzebub/generated:/config:ro" nightjar-beelzebub-build:test \
  validate --conf-core /config/core.yaml --conf-services /config/services
python3 beelzebub/runtime-check.py
```

The runtime check publishes only a temporary loopback port, disables raw Docker logging, consumes child streams in memory, verifies the actual upstream schema and public responses, prints a safe field projection, and removes its container. It verifies that direct, untrusted forwarded headers are ignored. Full-stack tests separately verify HAProxy source attribution and sanitized persistent telemetry.

Upstream source references: [HTTP strategy](https://github.com/beelzebub-labs/beelzebub/blob/v3.10.0/internal/protocols/strategies/HTTP/http.go), [logging setup](https://github.com/beelzebub-labs/beelzebub/blob/v3.10.0/internal/builder/builder.go), [event shape](https://github.com/beelzebub-labs/beelzebub/blob/v3.10.0/internal/tracer/tracer.go), [configuration parser](https://github.com/beelzebub-labs/beelzebub/blob/v3.10.0/internal/parser/configurations_parser.go).
