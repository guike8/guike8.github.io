FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
# scripts/build-containers.sh and image-context.py stage the canonical root page.
# An explicit COPY fails the build if that generated asset was not prepared.
COPY --chown=10001:10001 web/*.mjs ./web/
COPY --chown=10001:10001 web/public/index.html ./web/public/index.html
COPY --chown=10001:10001 console ./console
USER 10001:10001
CMD ["node", "console/main.mjs"]
