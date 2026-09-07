# Performance, capacity, and cost baseline

Performance evidence is profile-specific. The repository's existing M9 synthetic load harness remains a useful regression baseline, but it is **not** a substitute for the live Railway, Local, or Hosted measurements required by the current milestone plan.

## Existing synthetic baseline

`bun run test:load` / `bun run test:m9-acceptance` exercises representative Control API, workflow/event, Runtime Gateway/routing, model/tool, orchestration, and telemetry paths with bounded admission. Existing budgets and historical local results remain regression evidence for the implementation they exercise.

Do not reinterpret a synthetic/developer-host pass as proof that Railway, Neon, R2, Restate, SQLite, or a VPS profile meets production capacity requirements.

## M9 managed-cloud evidence

M9.6 #73 requires measurements from the accepted Railway + Neon + R2 + Restate staging candidate after M9.7–M9.13 configuration is complete.

Record at minimum:

- clean build/deploy/startup/readiness time;
- Railway CPU/RAM/network and service saturation;
- execution acceptance and time-to-first-progress;
- Restate invocation/wait/recovery overhead and state growth;
- Neon query/pool/connection behavior and migration/reconnect impact;
- R2 request/storage/network behavior where used;
- Runtime Gateway connection/ACK overhead where used;
- event/tool/model/provider throughput and backpressure;
- p50/p95/p99/max latency;
- retry/redelivery/error counts;
- idle and representative active cost.
- telemetry median overhead and representative p95 overhead.

M9.6 recorded the initial Cloud baseline after live staging became healthy. M11 later reruns it from
the frozen release candidate.

## M10 Local evidence

Measure the all-in-one Local profile using SQLite + single-node Restate + filesystem storage + direct RuntimeTransport:

- clean start/readiness;
- idle CPU/RSS/disk;
- active execution CPU/RSS/disk;
- SQLite query/lock/WAL growth and backup overhead;
- direct-local RuntimeTransport latency;
- Restate process/runtime overhead;
- managed Pi/ACP resource use;
- filesystem Artifact behavior;
- restart/recovery latency.

Local release budgets must fit ordinary developer hardware and cannot assume Docker/PostgreSQL/Redis/Runtime Gateway are running.

## M10 Hosted evidence

Measure both supported profiles:

- `simple`: all-in-one + Restate + SQLite + filesystem on a small VPS;
- `server`: PostgreSQL-backed composition with split services/remote Runtime Gateway only where required.

Record minimum/recommended CPU, memory and disk, idle/active consumption, saturation/backpressure, database/storage behavior, remote-control overhead, restart/backup/restore impact, and monthly infrastructure cost for the reference classes tested.

## Cross-profile conformance

Performance differences are allowed; semantic differences are not. M10.9 runs equivalent versioned fixtures across the accepted M9 cloud candidate, Local, Hosted `simple`, and Hosted `server`.

Permitted differences include latency, capacity, availability, infrastructure cost and location-specific capabilities. Retry/idempotency/cancellation/approval/state/result semantics must remain compatible.

## Optimization rules

1. Pin candidate/baseline commits, runtime versions, deployment configuration, persistence schema, environment class, dataset and concurrency.
2. Profile before optimizing.
3. Run cold/warm, steady, ramp, spike, stress, soak and restart/recovery cases where appropriate.
4. Preserve raw profiles and environment manifests.
5. Caching/batching/backpressure cannot weaken workspace isolation, durability, idempotency, privacy, or provider scope.
6. Re-establish baselines after an approved infrastructure/runtime/database configuration change.
7. Never compare unlike deployment profiles as if they were the same capacity class.

## M11 release gate

### Bounded SQLite measurement

After `bun run build`, run `bun scripts/run-m11-sqlite-benchmark.mjs` to measure
1,000 durable record writes and replay reads through the real SQLite provider,
at concurrency 8. Override `M11_SQLITE_ITERATIONS` (1–10,000) and
`M11_SQLITE_CONCURRENCY` (1–64, no greater than iterations) for bounded profiles.
The JSON output retains every latency sample, percentiles/max, throughput, WAL
and database sizes, backup time/size, CPU usage and RSS snapshots, plus commit,
dirty-state, runtime and host metadata. Each read is checked against its written
record and revision; database integrity is checked before cleanup.

Each run creates and removes its own temporary database. No external database or
provider is used. Capture the JSON as raw benchmark evidence from a clean, pinned
candidate. Results are explicitly `measurement_only`: these are single-process
SQLite record measurements, not API/execution/Restate capacity, peak memory,
provider cost, live VPS measurements or an approved release-budget decision.

M11 owns final absolute and regression budgets after real M9/M10 data exists. It can block release for unbounded resource growth, unsafe retry amplification, database saturation, excessive deployment overhead, unacceptable cost, or profile-specific behavior that cannot be operated reliably.
