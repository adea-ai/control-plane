FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS dependencies

WORKDIR /workspace

COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build

RUN bun run build

# Assemble an install tree separately from the build tree. Swagger's optional
# TypeScript peer is needed by its compile-time plugin, not by compiled services.
# Exclude compiler packages from the runtime artifact while retaining other peers.
FROM build AS runtime-package

RUN mkdir /runtime-source /runtime-artifact \
    && tar --exclude=node_modules --exclude='*.tsbuildinfo' -cf /tmp/runtime-source.tar \
        package.json bun.lock bunfig.toml patches apps packages \
    && tar -xf /tmp/runtime-source.tar -C /runtime-source

WORKDIR /runtime-source

RUN bun install --frozen-lockfile --production --ignore-scripts \
    && tar --exclude='./node_modules/.bun/typescript@*' \
        --exclude='./node_modules/.bun/@typescript+typescript-*' \
        --exclude='*/node_modules/typescript' --exclude='*/node_modules/@typescript' \
        --exclude='*/node_modules/.bin/tsc' --exclude='*/node_modules/.bin/tsserver' \
        -cf /tmp/runtime-artifact.tar . \
    && tar -xf /tmp/runtime-artifact.tar -C /runtime-artifact

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS runtime

ARG APP_NAME
ARG COMMIT_SHA
ENV APP_NAME=${APP_NAME} \
    COMMIT_SHA=${COMMIT_SHA} \
    APP_ENV=production \
    NODE_ENV=production

WORKDIR /workspace

# Only the assembled artifact crosses into runtime; installer caches remain in
# the producer stage and cannot reintroduce build tools into service images.
COPY --from=runtime-package --chown=bun:bun /runtime-artifact /workspace
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
