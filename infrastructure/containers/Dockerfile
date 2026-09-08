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
ENV APP_NAME=${APP_NAME} \
    APP_ENV=production \
    NODE_ENV=production

WORKDIR /workspace

COPY --from=build --chown=bun:bun /workspace /workspace
COPY --chown=bun:bun infrastructure/containers/entrypoint.sh /usr/local/bin/control-plane-entrypoint

RUN chmod 0555 /usr/local/bin/control-plane-entrypoint

USER bun

ENTRYPOINT ["/usr/local/bin/control-plane-entrypoint"]

FROM runtime AS migration

ENTRYPOINT ["bun", "--cwd=packages/database", "run", "db:migrate"]
