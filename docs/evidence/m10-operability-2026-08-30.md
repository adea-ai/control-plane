# M10 Local and Hosted operability evidence — 2026-08-30

This record closes the M10.11 release-hardening gate. It combines production-shaped developer-host
drills, deterministic package tests, four-profile semantic conformance, and the Linux Hosted Compose
gate in [`.github/workflows/m10-operability.yml`](../../.github/workflows/m10-operability.yml). It is
release-candidate evidence, not an independent capacity benchmark or packaged-desktop certification;
those remain M11 gates.

No prompt, context, credential, HPKE plaintext, private key, or secret value was recorded. Credential
continuity was compared only through SHA-256 digests.

## Local desktop composition

The production Local entry point ran with its bundled Restate 1.7.7 child, SQLite, filesystem
Artifacts, local secret handles, and direct RuntimeTransport. `/health` and `/ready` returned 200.
The process tree survived `SIGSTOP`/`SIGCONT` as a host sleep/wake simulation and recovered readiness.
Terminating the Restate binary changed `/ready` to 503; the desktop supervisor contract then restarts
the whole composition.

An offline checkpoint captured 61 entries with digest
`sha256:d499372ff426ad272499bc2a42cd4ef13289f9be11d5f40ed3172f567b71cd26`.
Create, verify, restore dry-run, and restore `--apply` all succeeded. The restored directory booted the
real composition and returned ready. Source and restored data were each 816 KiB in this empty-state
drill.

The idle point-in-time process snapshot was approximately 389 MiB RSS: 168.3 MiB Bun, 40.5 MiB the
Restate Node wrapper, and 180.2 MiB the Restate binary. This is below the 750 MiB Local idle release
budget. Under 10,000 loopback echo requests at concurrency 16, all 10,000 returned 200; the active
snapshot was approximately 430 MiB RSS and 10.9% of one host core across the process tree. It is a
bounded API-path sample, not a workflow-throughput benchmark.

## Hosted Simple

The production image built from the repository and launched as one long-running container with only
the Control API published to `127.0.0.1:33300`. `/ready` returned 200. A forced container recreation
against the same operator-owned bind mount returned ready and retained the same private credential
digest.

An offline integrity checkpoint captured 74 entries with digest
`sha256:299fd3b1df894da7587e44103fb56c8c263fcb7e3c17cfdfa74739383e37c1d9`.
Verification, restore dry-run, and applied restore succeeded; the restored directory booted and
retained the credential digest. The empty-state bind mount occupied approximately 224 MiB, primarily
single-node Restate state. The idle container snapshot was 1.90% CPU and 462.6 MiB of its 2 GiB
ceiling. Under 2,000 loopback echo requests at concurrency 16, all 2,000 returned 200; the active
snapshot was 19.23% CPU and 492.7 MiB. An earlier 20,000-request concurrency-32 saturation probe
returned a non-zero client result without per-status attribution, so it is not counted as passing
throughput evidence and remains an M11 saturation-test input.

## Hosted Server

The supported three-service topology launched the all-in-one Hosted Control Plane, PostgreSQL 18.3,
and Restate 1.7.7. The one-shot migration job exited zero before Control Plane startup. PostgreSQL
advertised only its internal Compose port and Restate exposed no host port; only the Control API was
published to loopback.

The repository image applied all 27 SQL migrations (`0000` through `0026`). A full forced recreation
against the same bind mounts returned ready with the migration count unchanged. Stopping either
Restate or PostgreSQL changed `/ready` to 503; restarting each dependency restored 200 without
recreating the Control Plane.

A custom-format PostgreSQL dump was restored into an isolated database and reported the same 27
Drizzle migrations. The 96,999-byte dump digest was
`sha256:78219d36525232e28c5cae0bd2a6e3c88586f375388e3e1d56ac088780cf26f7`.
The temporary restore database was removed after verification.

The idle point-in-time snapshots were:

| Component            |   CPU |    Memory | Disk state |
| -------------------- | ----: | --------: | ---------: |
| Hosted Control Plane | 0.46% | 112.1 MiB |      4 KiB |
| PostgreSQL           | 0.03% | 46.86 MiB |   64.5 MiB |
| Restate              | 2.19% | 343.8 MiB |  173.0 MiB |

These fit the documented component ceilings and the 2-vCPU/4-GiB minimum Hosted Server class. The
same 2,000-request concurrency-16 sample returned 2,000 HTTP 200 responses. Its active snapshots
were 21.97%/135 MiB for Control Plane, 3.47%/27.02 MiB for PostgreSQL, and 2.90%/309.9 MiB for
Restate. The samples do not establish workflow throughput or saturation limits.

## Cost budgets

Local requires no mandatory managed infrastructure and therefore has a $0/month incremental
provider budget on the developer's existing machine. Hosted Simple has a USD 10/month minimum-class
budget and Hosted Server has a USD 25/month minimum-class budget, excluding taxes, egress, backup
retention, domains, and optional managed providers. These are release ceilings, not vendor price
quotes; actual operator invoices depend on provider and region.

## Portability, relay, storage, and telemetry

- The M10 conformance suite executes the same public/domain scenarios across Cloud, Local, Hosted
  Simple, and Hosted Server and permits differences only at declared provider seams.
- The encrypted relay suite covers RFC 9180 HPKE, outbound-only registration, key rotation and
  revocation, reconnect/redelivery, concurrent duplicate acceptance, and the real CommandInbox
  durable identity boundary. Redelivery converges without duplicate workflow submission.
- Local and Hosted default to filesystem Artifacts. Hosted Server may replace only the ObjectStore
  adapter with an HTTPS S3-compatible endpoint; Cloudflare R2 uses this path with region `auto`.
- First-party telemetry and relay status projection are content-redacted allowlists and do not
  require plaintext execution content.

## Reproducibility and remaining release gate

The Local and Hosted runbooks contain exact checkpoint, restore, upgrade, rollback/forward-repair,
incident, host-loss, TLS, secret, and provider-replacement procedures. The M10 Operability workflow
repeats both Hosted launches and dependency disruption checks on a fresh Ubuntu runner for every PR
to `sandbox` or `main`. This evidence is accepted only with that workflow's green gate for the exact
revision being released.
