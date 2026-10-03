# Hosted Docker acceptance — 2026-10-03

## Candidate and environment

The user explicitly selected Docker for fresh-environment acceptance and stated that no VPS exists or should be created. This record follows that target change while retaining the functional acceptance gates.

Source was the clean frozen candidate at `4c3aa3fd03eea91c0acd5f123f28c85b0e2d8e19`. Runtime was Docker Desktop 29.8.1, context `desktop-linux`, Linux/arm64, 8 CPUs and 16 GiB. Each profile used a fresh task-owned bind-data directory and isolated Compose project `cp-m11-docker-1003-st`; this reused the existing Docker Desktop engine. Host port 33300 was unbound before the run and published only as `127.0.0.1:33300:3000`. PostgreSQL and Restate had no host port mappings.

Pinned candidate images were built from the checkout with unique tags. Hosted Simple image ID was `sha256:833906c9f71be9fa3f286715bd123ce057f4afc33131f8af06008ae5e084fb5a`; Hosted Server image ID was `sha256:587536a4198ed12d033c707e611794427c0aa5e48058934920e3b827e1fb2484`. Compose used PostgreSQL 18.6 at pinned digest `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` and Restate 1.7.13 at pinned digest `sha256:ebe1c025b225b01ea5340e5dfb3bf9a8bfd7a75d27fe142f2d6545a38b59747f`.

## Hosted Simple

`docker compose --project-name cp-m11-docker-1003-st --env-file <private external env> -f infrastructure/compose/compose.yaml --profile simple up --build -d` built and started the image healthy. `/health` and `/ready` returned 200. The generated bearer credential was in `/var/lib/control-plane/auth/local-api.token`, owned by UID/GID 1000 with mode 0600; the data and auth directories were UID/GID 1000 with mode 0700. A private authenticated API request without the credential returned 401; using the persisted credential returned 201 with `authenticated=true`. After `up -d --force-recreate`, the token hash matched without printing either hash, the API still authenticated, and the file permissions remained correct. `down` removed the profile container and network.

## Hosted Server

`docker compose --profile server up -d --wait --wait-timeout 120 postgres` brought up fresh PostgreSQL. A legacy table owned by `control_plane` was created before `docker compose --profile server up --build -d`. The one-shot role bootstrap and migration containers both exited 0; all 58 migration files were recorded as applied. Migration and application passwords independently authenticated as their respective roles. The application role had no elevated attributes or role memberships, did not own the database, had no excess table grants, and could not create a table. It could perform the permitted DML probe; the probe left no rows. Bootstrap rejected duplicate role passwords. The legacy table owner transferred to `control_plane_migrator`.

With the real Restate 1.7.13 and PostgreSQL 18.6 containers running, `/health` and `/ready` returned 200. Stopping Restate changed `/ready` to 503; restarting it healthy returned `/ready` to 200. Stopping PostgreSQL likewise changed `/ready` to 503; restarting PostgreSQL healthy restored `/ready` to 200. After recovery, 58/58 migrations remained applied, the legacy table remained present and empty, and Restate's admin `/health` returned 200.

## Evidence and limits

The run retained sanitized command logs and a task resource ledger outside the repository. Immutable candidate and dependency image IDs are recorded above. The environment file, generated database passwords, Restate private key, and bind data were kept outside the checkout with owner-only permissions and removed after the run. No source file changed, no production/paid cloud resource was touched, and unrelated Docker containers were left running.

This verifies the supported Hosted Simple and Hosted Server Compose flows on Docker Desktop's Linux/arm64 engine, including the existing M10 operability drill plus a bounded Simple auth/API check. It does not certify a clean generic Linux host, managed-cloud or native-provider operation, durable graph execution/recovery, capacity/soak, independent evaluation, or all M11 requirements. Readiness after dependency recovery is not a full milestone acceptance claim.
