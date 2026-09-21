FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS dependencies

WORKDIR /workspace

COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build

RUN bun run build

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS runtime

ARG APP_NAME
ARG COMMIT_SHA
ENV APP_NAME=${APP_NAME} \
    COMMIT_SHA=${COMMIT_SHA} \
    APP_ENV=production \
    NODE_ENV=production

WORKDIR /workspace

COPY --from=build --chown=bun:bun /workspace /workspace
COPY --chown=bun:bun infrastructure/containers/entrypoint.sh /usr/local/bin/control-plane-entrypoint

# CVE-2026-14456 (OpenSSL denial of service, HIGH): the pinned base digest
# ships libcrypto3/libssl3 3.5.7-r0; pull the fixed 3.5.8-r0 packages so the
# digest-pinned base cannot freeze a known vulnerability into every image.
RUN apk upgrade --no-cache openssl libcrypto3 libssl3

RUN chmod 0555 /usr/local/bin/control-plane-entrypoint

USER bun

ENTRYPOINT ["/usr/local/bin/control-plane-entrypoint"]

FROM runtime AS migration

ENTRYPOINT ["bun", "--cwd=packages/database", "run", "db:migrate"]
