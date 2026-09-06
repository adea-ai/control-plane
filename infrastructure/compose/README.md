# Hosted Control Plane

This Compose project packages the provider-neutral Control Plane for a user-controlled Linux host. It does not require Railway, Neon, Cloudflare R2, or Adea credentials.

## Simple profile

The `simple` profile is the default small-VPS topology. One container runs the Control API, SQLite persistence, filesystem artifact storage, the canonical workflow endpoint, and a single-node Restate runtime. Its only durable state is the operator-owned directory mounted at `/var/lib/control-plane`.

```sh
cd infrastructure/compose
cp .env.example .env
mkdir -p data/simple
sudo chown 1000:1000 data/simple
chmod 700 data/simple
docker compose --profile simple up --build -d
docker compose --profile simple ps
```

The API binds to `127.0.0.1:3000` by default. Readiness is available at `/ready`. The bearer credential is generated inside `data/simple`; do not publish the port directly or copy that credential into Compose configuration. Use a same-host TLS reverse proxy with authentication, or the outbound encrypted relay adapter when it is configured.

## Server profile

The `server` profile runs three long-lived services: the all-in-one hosted Control Plane, PostgreSQL, and Restate. A one-shot migration container applies the versioned schema before the Control Plane starts. PostgreSQL and Restate stay private on the Compose network; only the Control API is published to host loopback.

Set three distinct URL-safe PostgreSQL passwords before the first start: the bootstrap administrator,
the schema migrator, and the long-running application role. Empty values fail closed. The application
role receives only schema usage plus table DML and sequence access; it cannot create database objects.

```sh
cd infrastructure/compose
cp .env.example .env
# Generate each value separately and put it in POSTGRES_PASSWORD,
# POSTGRES_MIGRATION_PASSWORD, and POSTGRES_APPLICATION_PASSWORD in .env.
openssl rand -hex 32
mkdir -p data/server/control-plane data/server/postgres data/server/restate
sudo chown 1000:1000 data/server/control-plane
sudo chown 70:70 data/server/postgres
sudo chown 0:0 data/server/restate
chmod 700 data/server data/server/*
docker compose --profile server up --build -d
docker compose --profile server ps
```

The one-shot `database-bootstrap` service creates or updates the distinct roles before
`database-migrate` runs. It is idempotent for existing data directories: it transfers objects owned
by the former `control_plane` application/owner role to `control_plane_migrator`, reapplies bounded
runtime grants, and then migrations run as the migrator. Back up PostgreSQL before the first upgrade
from a release that used one shared role. Never reuse any of the three passwords or point
`DATABASE_URL` at the bootstrap or migration role.

The server component manifest reports `hosted-server`, PostgreSQL persistence, filesystem artifacts, and the separate Restate dependency. An S3-compatible ObjectStore is optional and replaces only the object-store adapter; Neon is a supported PostgreSQL provider but is not required. To enable it, set `HOSTED_OBJECT_STORE=s3-compatible` plus `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. The endpoint must use HTTPS and all values are required together. Cloudflare R2 works through this seam with region `auto`.

The hardened Control Plane image runs as the pinned non-root `bun` user, UID/GID 1000. On a native Linux Docker host, the Simple data directory and Server `control-plane` directory must therefore be owned by 1000:1000. The pinned PostgreSQL image writes as UID/GID 70, while the pinned Restate image writes as UID/GID 0 with all Linux capabilities dropped. Give their bind directories the owners shown above and keep every data directory mode 0700. Do not make any data directory world-writable to bypass an ownership error. Re-check these image ownership contracts before changing either pinned image version.

## Persistence and backup

Stop the container before a filesystem-level backup so SQLite, Restate, artifacts, credentials, and their integrity metadata form one checkpoint. From the repository checkout, create and verify an owner-controlled checkpoint:

```sh
docker compose --profile simple stop control-plane-simple
bun run checkpoint create --profile hosted-simple --source ./data/simple --destination ./backups/simple-pre-upgrade
bun run checkpoint verify --checkpoint ./backups/simple-pre-upgrade
docker compose --profile simple start control-plane-simple
```

Restore into a new directory while the container is stopped. The first command is a dry run; the second performs the copy. Keep the previous directory until `/ready` succeeds and a workflow recovery drill passes. Never merge individual files from different checkpoints.

```sh
bun run checkpoint restore --checkpoint ./backups/simple-pre-upgrade --destination ./data/simple-restored
bun run checkpoint restore --apply --checkpoint ./backups/simple-pre-upgrade --destination ./data/simple-restored
```

For `server`, quiesce command acceptance and stop `control-plane-server` plus `restate` before the checkpoint. Keep PostgreSQL running long enough to create a custom-format dump, then stop it. Copy `data/server/control-plane`, `data/server/restate`, the dump, image digest, schema version, and Restate version into one owner-only recovery directory. Restore PostgreSQL with `pg_restore --clean --if-exists` into an empty isolated database, restore the matching Restate and filesystem-artifact checkpoint, run `database-migrate`, then start the Control Plane. A live database dump combined with arbitrary Restate files is not a valid checkpoint. S3-compatible Artifact bytes are backed up/versioned through that provider; record bucket/version policy and verify referenced object digests before reopening admission.

## Upgrade and rollback

Pin `CONTROL_PLANE_IMAGE` to an immutable release tag. Back up the data directory, pull the candidate, recreate the container, and wait for readiness. Roll back the image only when its documented schema and Restate data versions remain compatible; otherwise restore the matching pre-upgrade checkpoint or follow the release's forward-repair procedure.

After host restart, require `docker compose ps`, `/ready`, Restate health, and one idempotent durable-command replay before accepting new work. If a host is lost, revoke its outbound relay registration and X25519 key before restoring its checkpoint to a replacement host. Relay redelivery reuses the durable command identity and must converge without duplicate execution.

## TLS and secret handling

Keep the published port on loopback. Terminate HTTPS in a same-host reverse proxy with a valid certificate and forward only to `127.0.0.1:3000`; do not publish PostgreSQL or Restate. Preserve bearer authentication at the Control API. Store PostgreSQL, S3, reverse-proxy, and relay credentials in owner-only environment/secret files supplied by the host, never in the Compose file or image. Rotate and revoke the outbound relay X25519 key using the bounded procedure in [`../../docs/remote-control-relay.md`](../../docs/remote-control-relay.md).

## Resource classes

Hosted Simple minimum is 1 vCPU, 1 GiB RAM, and 10 GiB disk; recommended is 2 vCPU, 2 GiB RAM, and 20 GiB disk. Hosted Server minimum is 2 vCPU, 4 GiB RAM, and 20 GiB disk; recommended is 4 vCPU, 8 GiB RAM, and 40 GiB disk. Compose enforces configurable component ceilings: Simple 2 CPU/2 GiB, Control Plane Server 2 CPU/2 GiB, PostgreSQL 1 CPU/768 MiB, and Restate 1.5 CPU/768 MiB. Operators must monitor SQLite/PostgreSQL, Restate, Artifact, and backup growth; these are release ceilings, not capacity promises.

The M10 operator-cost budget is at most USD 10/month for the minimum Hosted Simple class and USD 25/month for the minimum Hosted Server class, excluding taxes, egress, backup retention, domains, and optional managed PostgreSQL/S3 providers. These are product budget ceilings rather than claims about any vendor's current price; an operator whose chosen provider exceeds the ceiling must select a smaller compatible plan or explicitly accept the variance.

## Hostinger and generic VPS notes

Install a supported Docker Engine with the Compose plugin, clone or copy this versioned Compose directory, and follow the same `simple` commands. Configure the host firewall to keep port 3000 private. Terminate public HTTPS in Caddy, nginx, Traefik, or the provider's reverse proxy and forward only to `127.0.0.1:3000`.

The M10 candidate evidence records the exact developer-host and Linux CI drills completed. Shared CI/VPS snapshots are diagnostic; M11 owns the final independent capacity and packaged-desktop audit.
