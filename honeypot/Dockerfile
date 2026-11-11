FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --chown=10001:10001 web ./web
COPY --chown=10001:10001 console ./console
USER 10001:10001
CMD ["node", "console/main.mjs"]
