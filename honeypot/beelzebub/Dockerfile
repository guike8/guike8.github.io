# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS beelzebub-build
ARG TARGETOS=linux
ARG TARGETARCH
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2
# Official v3.10.0 source, pinned by commit and independently verified SHA-256.
ADD --checksum=sha256:aa141cb2004f8d5fa33da0a7863d616195feca7263fcafeb43b1a61782c6e373 https://codeload.github.com/beelzebub-labs/beelzebub/tar.gz/a02d0354e19a01e97eeccaf1874419dcb05b94ca /tmp/beelzebub-source.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/beelzebub-source.tar.gz --strip-components=1 -C /src \
    && go mod download \
    && go mod verify
RUN GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -p=2 -trimpath -buildvcs=false \
    -ldflags='-s -w -X github.com/beelzebub-labs/beelzebub/v3/cli.Version=3.10.0 -X github.com/beelzebub-labs/beelzebub/v3/cli.CommitSHA=a02d0354e19a01e97eeccaf1874419dcb05b94ca -X github.com/beelzebub-labs/beelzebub/v3/cli.BuildDate=2026-10-24T14:56:03Z' \
    -o /out/beelzebub .

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production TZ=UTC GOMEMLIMIT=64MiB
LABEL org.opencontainers.image.title="Nightjar Beelzebub HTTP decoy" \
      org.opencontainers.image.source="https://github.com/beelzebub-labs/beelzebub" \
      org.opencontainers.image.version="3.10.0" \
      org.opencontainers.image.revision="a02d0354e19a01e97eeccaf1874419dcb05b94ca" \
      org.opencontainers.image.licenses="GPL-3.0"
WORKDIR /app
COPY --from=beelzebub-build /out/beelzebub /usr/local/bin/beelzebub
# Include the complete corresponding upstream source and license with the binary.
COPY --from=beelzebub-build /tmp/beelzebub-source.tar.gz /usr/share/beelzebub/source.tar.gz
COPY beelzebub/LICENSE.upstream beelzebub/UPSTREAM.json /usr/share/beelzebub/
COPY beelzebub/generate-config.mjs ./beelzebub/generate-config.mjs
COPY web/public/index.html ./web/public/index.html
COPY web/log.mjs ./web/log.mjs
COPY adapters/*.mjs ./adapters/
RUN node beelzebub/generate-config.mjs web/public/index.html beelzebub/generated \
    && /usr/local/bin/beelzebub validate --conf-core /app/beelzebub/generated/core.yaml --conf-services /app/beelzebub/generated/services
USER 10001:10001
EXPOSE 8080
CMD ["node", "adapters/run-beelzebub.mjs"]
