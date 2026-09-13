# M11 standalone profile scenario runs — 2026-09-13

Candidate: `8365442` (main; PR #478 merged). Host: developer macOS ARM machine with
Docker Desktop; not a fresh VPS and not a capacity measurement. These runs are the
required Local and Self-hosted scenario evidence for #188; the managed-cloud baseline
evidence is recorded in `m11-context-command-delivery-2026-09-12.md`.

## Local credential-free matrix

`bun run test:m11-standalone` from a synced clean checkout at the candidate.

- Core matrix: 107 tests across 8 files (durable execution, runtime fabric, Runtime
  Gateway, managed-Pi/ACP adapters, tools/models/sandboxes, multi-agent orchestration,
  portability conformance, standalone E2E), all passing in 30.2s.
- Package lanes: context 53, cortana-context-adapter 23, remote-control-relay 18,
  profile-portability 16, deployment 11 — all passing. Total 228 tests.
- The standalone E2E executes both supported Local adapter families through
  `DirectLocalRuntimeTransport`, the Local composition, SQLite persistence and
  filesystem Artifacts with a restart/reopen recovery check; it never starts a Runtime
  Gateway process and requires no Railway, Neon, R2, PostgreSQL, Cortana or reusable
  provider credentials. No-provider, disabled-provider and fake alternate provider
  paths are included.
- Environment note: the checkout needed `bun install` after pulling the merged release
  (the `@control-plane/cortana-context-adapter` workspace link was absent in the stale
  `node_modules`); `bun install --force` relinked dependencies but the single workspace
  symlink still required an explicit `ln -s` on this host. This is a local
  checkout-state issue, not a candidate defect — CI's fresh install resolves it.

## Self-hosted simple

`docker compose --profile simple up -d --build` with a fresh bind-mounted data path,
loopback-published API on 127.0.0.1:3000, candidate pinned via
`CONTROL_PLANE_COMMIT_SHA=8365442`.

- Container started and `/ready` returned 200 within ~10s; `/health` reported
  `local-control-plane`, environment `production`, the pinned commit and instance id.
- `/v1/components` returned the accepted minimal public manifest
  (`{schemaVersion:1, ready:true}`); the detailed component manifest is intentionally
  operator-side only.
- Durable state present on the bind mount: `control-plane.sqlite` (+WAL/SHM),
  `auth/local-api.token`, and the embedded single-node Restate cluster directory.
- Forced container recreation against the same bind mount: readiness recovered in ~10s,
  the private credential SHA-256 was unchanged, and the SQLite schema fingerprint was
  stable.
- `docker compose down` removed the container and network; no leftovers.

## Self-hosted server

`docker compose --profile server up -d --build` with fresh bind mounts and
operator-supplied ephemeral database secrets (superuser, application, migration) plus a
freshly provisioned Restate request-identity Ed25519 key through
`scripts/provision-restate-identity.mjs` (the compose restate service reads
`/restate-data/request-identity-private.pem`; the matching `publickeyv1_…` goes into
`RESTATE_REQUEST_IDENTITY_PUBLIC_KEY` for the server).

- Topology: postgres 18.3 healthy, one-shot database-bootstrap exited 0, one-shot
  database-migrate exited 0, restate healthy only after the identity key was provided,
  control-plane-server started. No database or Restate host ports exposed; API published
  only to 127.0.0.1:3000.
- `/ready` returned 200 in ~10s; `/health` reported `hosted-control-plane` with the
  pinned commit; `/v1/components` returned the minimal manifest.
- Durable schema: `drizzle.__drizzle_migrations` count 45 (migrations through 0044).
- Forced recreation of the full topology against the same bind mounts: readiness
  recovered in ~10s, the private credential SHA-256 was unchanged, and the migration
  count remained 45.
- Two operational findings from the run, both operator ergonomics rather than product
  defects: fresh clusters require consistent secrets across bootstrap/migrate reruns
  (re-running bootstrap with different superuser/migration passwords fails closed), and
  the Restate identity key must exist before first restate boot. Both failed closed with
  clear container errors.
- `docker compose down` removed all containers and the network; generated secrets and
  data directories were deleted afterwards.

## Scope and remaining gates

These runs prove the Local and Self-hosted profile scenarios from the candidate on a
developer host with Docker Desktop. They do not satisfy the fresh-VPS reproduction gate
(#197 entry criteria), the small-VPS resource/saturation measurements (#193), or the
required human/independent acceptance. The Railway managed-cloud baseline, restart
recovery drills from the earlier evidence, and the M10.9/M10.10 re-run remain the next
scenario tranche.
