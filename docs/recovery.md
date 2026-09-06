# Failure recovery and disaster-recovery runbook

Control Plane recovery is profile-specific but preserves one semantic rule: committed logical work, idempotency state, ProjectState, execution/event/usage evidence, and approved artifacts must survive supported failure modes without guessing ambiguous external side effects. Ambiguous non-idempotent outcomes enter `reconciliation_required`.

## Ownership by milestone

- **M9** proves the managed-cloud Railway + Neon + R2 + Restate recovery path.
- **M10** adds Local SQLite/Restate and Hosted SQLite/PostgreSQL recovery, backup, restart, and upgrade/rollback behavior.
- **M11** independently reruns the recovery matrix across all accepted profiles and records measured RPO/RTO or equivalent recovery evidence.

Historical AWS/RDS/ECS recovery text is retained only as decision provenance. It is not executable
recovery code, a compatibility layer, or the current first-party Cloud runbook.

## Managed-cloud recovery target — M9

The accepted cloud profile is Railway compute, separate Control Plane Neon PostgreSQL, Cloudflare R2, and Restate.

Required M9 evidence includes:

- `apps/workflow-worker/src/execution-workflow.test.mjs`;
- `apps/runtime-gateway/src/reconnect-reconciliation.test.mjs`;
- `packages/events/src/delivery.test.mjs`;
- failed Railway deploy rollback/forward repair;
- service restart/redeploy and draining behavior;
- Neon connection loss/reconnect;
- explicit migration failure behavior;
- Neon backup/PITR or equivalent restore procedure validated against an isolated destination;
- Restate restart/redeploy while durable work exists;
- Runtime Gateway reconnect where a non-co-located RuntimeNode is used;
- R2 operation failure/recovery where cloud object storage is used;
- no duplicate logical execution, effect, Artifact, usage, or billing record after redelivery/restart;
- content-redacted logs/traces throughout incidents.

M9.6 #73 did not close from configuration shape alone; its live staging restart/recovery evidence is
recorded in `docs/evidence/m9-cloud-certification-2026-08-28.md`.

## Local recovery target — M10

Local uses the all-in-one Control Plane composition, Node 24 `node:sqlite`, single-node Restate, filesystem storage, and direct RuntimeTransport.

Use the integrity-verified create/verify/dry-run/apply procedure in
[`local-deployment.md`](local-deployment.md); restore into a new directory and never merge checkpoint
contents into live state.

Required behavior:

- Control Plane process crash/restart;
- Restate process crash/restart;
- full host restart and desktop sleep/wake where applicable;
- SQLite WAL/transaction integrity;
- SQLite backup/restore and corruption handling;
- local filesystem Artifact availability/recovery;
- RuntimeDriver/Pi/ACP restart/reconciliation;
- no Runtime Gateway dependency for co-located execution;
- no silent failover to Adea Cloud when the selected Local node is unavailable.

## Hosted recovery target — M10

`simple` uses SQLite + Restate + filesystem storage. `server` uses PostgreSQL + Restate and filesystem or S3-compatible storage.

Required behavior:

- container recreation and host restart with persistent user-owned volumes;
- backup/restore for SQLite `simple` and PostgreSQL `server`;
- upgrade/rollback/forward repair;
- TLS/reverse-proxy and outbound remote-control reconnection;
- Runtime Gateway reconnect only where runtime topology requires it;
- secret/key rotation and revocation;
- operator-visible failure and explicit recovery rather than automatic movement to first-party cloud.

## Common failure signatures and response

- **Configuration/startup invalid:** refuse readiness; compare exact candidate, schema, service configuration, Restate version, public-contract versions, and required provider connectivity.
- **Database connection loss:** stop schema mutation, preserve durable command/event state, restore/reconnect the owning persistence provider, then replay only from durable idempotency/reconciliation boundaries.
- **Restate loss/restart:** recover from Restate durable state; a workflow incompatibility or nondeterministic migration blocks new promotion and requires the previous compatible application/runtime revision or explicit forward repair.
- **Runtime Gateway reconnect storm:** apply admission/backpressure limits and preserve command identity; replay only commands that are queued or provably unresolved.
- **Direct RuntimeDriver failure:** reconcile against driver/runtime authoritative status where possible; do not route through Runtime Gateway merely because the direct path failed.
- **Missing runtime/provider outcome:** enter reconciliation rather than guessing or blindly retrying a non-idempotent effect.
- **Event delivery outage:** retain durable event/outbox state and resume from durable acknowledgement/cursor; duplicate delivery must converge idempotently.
- **LangGraph checkpoint interruption:** resume the exact graph/version/checkpoint lineage inside the Restate-owned lifecycle; ProjectState remains separately authoritative.
- **ContextProvider outage:** follow the immutable disabled/preferred/required failure policy; never broaden scope or upload provider/local corpus data as an implicit recovery action.

## Recovery evidence

Every drill records:

- exact commit/release and deployment profile;
- application, Restate, persistence schema, adapter/driver/transport, and relevant provider versions;
- timestamps and observed recovery duration;
- committed record counts/digests where safe;
- command/event replay and reconciliation counts;
- operator decisions and rollback/forward-repair target;
- cleanup evidence;
- deviations from the declared guarantees.

Sensitive prompt, file, provider, credential, or HPKE plaintext content is prohibited from incident evidence.

## Current automated evidence

Existing PostgreSQL/LangGraph/Temporal-era integration and recovery scripts are historical executable evidence. They do not by themselves certify the accepted Railway/Neon/R2/Restate cloud profile or the M10 Local/Hosted profiles.

M9.7–M9.9 established the executable Cloud recovery matrix. M10 must extend that matrix for Local and
Hosted so M11 can run one explicit profile-aware suite rather than treating historical AWS/Temporal
fixtures as production proof.
