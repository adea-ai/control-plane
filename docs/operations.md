# Production operations runbook

Production compute runs on Railway; the production PostgreSQL database is `railway`. Adea and Control Plane have separate schemas and roles. Runtime uses scoped non-admin credentials. No persistent preproduction environment exists: qualification uses disposable sandboxes with synthetic data and credentials.

Use the protected production schema and promotion workflows. Confirm exact service/environment/database identity, verified TLS, canonical migration history, least-privilege capabilities, private connectivity, readiness and representative application behavior before accepting a deployment. Liveness alone is insufficient. Never apply an unknown staged provider patch. Preserve existing rotated operational secrets. See [the database contract](railway-production-database-cutover.md).

Production exposes the Control API, with its database runtime endpoint private. Optional durable-workflow sandbox qualification does not create production workers or storage. Local and Hosted profiles retain their independent lifecycle and persistence rules.

The provisional operational targets remain RPO 5 minutes and RTO 60 minutes. These are qualification targets, not verified provider guarantees; measure backup freshness and restore/reconciliation in an isolated sandbox before relying on them.

## M11 intake rollout fence: incomplete operator workflow

The development candidate adds migration 0052 and a durable PostgreSQL intake
gate. A newly empty database starts open; any retained execution, attempt,
command, runtime command or delegation rows conservatively seed it paused.
Both command acceptance and bare/delegated owner insertion respect the gate.
Existing replay and already-accepted work are not cancelled by an intake pause.
New valid API intake while paused returns a sanitized 503
`EXECUTION_INTAKE_UNAVAILABLE`, without new owner or accounting records.

`PostgresAdmissionRolloutService.pause()` requires actual database update
authority. The application role has only SELECT on the gate, including after
Hosted role re-provisioning. Production schema preflight checks effective
table and column permissions, not a caller-supplied operator flag.

**Do not promote this checkpoint as a complete rollout workflow.** Bounded
paginated inventory, drain audit and fresh exclusive-lock resume are
implemented in the database service and operator CLI. They do not establish
concurrent cutover acceptance or externally prove that old API/workflow
replicas have been quiesced before migration; the current automatic schema/image
promotion does not establish that proof. Journal provenance, commit-outcome
reconciliation, live role/migration verification and external
provider-settlement evidence also remain open.
Never restore intake with an arbitrary SQL update or invent historical funding
authority.

The operator CLI supports actual PostgreSQL `status`, `audit`, `pause`, and
`resume` operations. It loads only `DATABASE_MIGRATION_URL`, uses an explicit
migration connection factory, and verifies the target host, port and database
before connecting. The connection profile does not grant authority: the service
checks the authenticated database role's actual privileges. Do not put
credentials in command arguments. After building the workspace, use the exact
intended target:

```sh
bun run admission:admin status --host <host> --port <port> --database <database>
bun run admission:admin audit --host <host> --port <port> --database <database>
bun run admission:admin pause --host <host> --port <port> --database <database> --confirm pause
bun run admission:admin resume --host <host> --port <port> --database <database> --confirm resume
```

The bounded `audit` and `resume` operations take PostgreSQL `SHARE` locks on
these inventory tables for the pass: `public.executions`,
`public.execution_attempts`, `public.command_inbox`,
`public.runtime_commands`, `public.retired_command_keys`, and
`public.delegations`. Those locks conflict with writes to the inventory tables,
so owner and intake writes may wait for up to the 20-second audit budget. Lock
waits time out after 2 seconds; plan the audit/resume window around write
traffic. A lock timeout or incomplete audit fails closed. Resume performs a
fresh audit under the exclusive intake fence and those table locks before
updating the gate; a saved report cannot authorize it.

Use `DATABASE_MIGRATION_URL` for this CLI, pointed at the exact target. It does
not fall back to `DATABASE_URL` or `DATABASE_ADMIN_URL`. The authenticated role
must be the migration owner (provisioned PostgreSQL uses `control_plane_migrator`)
or an equivalent role with rights to lock all six inventory tables. `pause` and
`resume` also require `UPDATE` authority on `admission_rollout_gate` (table-level,
or column-level for `state`, `revision`, `updated_at`, and `updated_by`); the
service checks the connected role's actual gate privileges. The application
role's gate access is read-only and is not sufficient for `pause` or `resume`.

A completed audit that reports `RETIRED_COMMAND_KEY_UNVERIFIABLE` is blocked by
a pre-existing v1 replay tombstone: the audit cannot verify its scoped identity.
Do not try to clear the finding with SQL or by editing the gate. The tombstone
continues rejecting matching replays and remains audit-blocking until its
30-day retention window from `retired_at` has passed and the row is removed by
the supported operator sweep. Preflight the class with the default dry run,
using the migration-owner URL and an authorized hold policy so recorded holds
are evaluated:

```sh
bun scripts/retention-apply.mjs --backend postgres --class retired-command-keys \
  --database <database> --host <host> \
  --hold-policy /absolute/path/operator-policy.json
```

Review the audit diagnostics and the sweep's eligible/retained counts. A row is
eligible only after the 30-day boundary and when no matching hold prevents
deletion. Once the dry run and change review confirm eligibility, use the
explicit `--apply --confirm retired-command-keys` sweep documented in
[Retention deletion (#194)](#retention-deletion-194), then rerun `audit`; call
`resume` only when its fresh audit permits it. These local service checks are
not external rollout or replica-quiescence acceptance. Do not treat them as
proof that the production cutover is safe. No force flag, automatic migration
or deployment is provided. Failed operations return exit code 1 with sanitized
stderr; a completed audit that does not permit resume returns exit code 2.

## Catalog approval gate (#188)

Approval is a version-bound decision separate from publication: a catalog profile or skill version is
either explicitly approved or explicitly rejected by a recorded decision bound to its revision and
content digest. The gate is **off unless configured** and controls execution-time resolution, not
publication. Unapproved versions remain authorable and listable.

- Configuration (control-api): `CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED=true|false` and, optionally,
  `CONTROL_PLANE_CATALOG_APPROVAL_REQUIRED_SINCE=<ISO instant>`. Any other value fails startup rather
  than silently disabling the gate. Versions published strictly before the cutover are grandfathered;
  the cutover instant itself is not.
- Production enables the gate with the cutover declared in `.railway/railway.ts`; disposable test fixtures keep it
  disabled so reference-environment debugging is never blocked by approvals. Reviewing or changing the
  cutover is a data-governance decision, not a routine config edit.
- Record and inspect decisions with the scoped operator tool
  (`scripts/catalog-approval-admin.mjs`, `approvals.record` / `approvals.show`) against the target
  database. The request file is validated (absolute path, regular file, size-capped) and the CLI
  reports a single sanitized failure code; it never echoes database or credential content.
  The tool replaces request-supplied actor/authority attribution with the executing OS account
  (`operator:os-user:<encoded-account>`) and its real storage authority: Local OS access for SQLite,
  or the PostgreSQL session's `current_user`. These identify a privileged operator session, not an
  authenticated product user or a validated product grant. Shared OS/database accounts are shared
  attribution; use individual operator accounts when individual accountability is required.
  Programmatic administration must supply adapter-verified operator context and matching attribution;
  a JSON principal or grant reference alone is not proof of authority.
- With the gate enabled, a version published at or after the cutover denies execution with
  `*_APPROVAL_MISSING` until a decision exists, and denies with `*_APPROVAL_REJECTED` when a rejection
  was recorded. Approve deliberately: the decision is append-only and bound to the exact revision and
  digest, so republishing content invalidates the binding.

## Retention deletion (#194)

Physical retention deletion is an operator action, never a background behaviour:
the scheduled sweeps only assess and report. Run the command against an explicit
target, dry-run first, and keep the JSON result with the change record.

```sh
# SQLite profile (absolute, non-symlink file)
bun scripts/retention-apply.mjs --backend sqlite --class command-inbox \
  --database /var/lib/control-plane/state.sqlite

# PostgreSQL profile (host and database must match the credentialed target)
bun scripts/retention-apply.mjs --backend postgres --class command-inbox \
  --database control_plane --host <postgres-host>

# The same command covers execution events, executions and context packages:
#   --class execution-events
#   --class executions
#   --class context-packages
#   --class evaluation-runs    (deletes evaluation runs past their window)
#   --class audit-records      (PostgreSQL only; deletes release audit records
#                               past their own longer window)
#   --class execution-plans    (deletes plans past the window only when no
#                               execution, acceptance record or validation
#                               command still pins them)
#   --class interaction-receipts (deletes confirmed interaction/cancellation
#                               receipts only after their scoped execution is
#                               terminal and settled through attempts,
#                               reconciliation and event delivery; the window
#                               starts at the later of acceptance/settlement;
#                               unconfirmed receipts always stay)
#   --class runtime-ledgers    (deletes commands with a recorded result and their
#                               event receipts; expired or unresolved commands are
#                               reconciliation work and stay)
#   --class messaging          (PostgreSQL only; deletes settled deliveries and
#                               compacts delivered inbox payloads, keeping the
#                               (consumer, messageId) deduplication identity)
```

Replay-key tombstones have their own 30-day operator retention class. The
PostgreSQL runtime application role is limited to `SELECT` and `INSERT` on
`retired_command_keys`; it cannot update or delete replay evidence. The
`retired-command-keys` class therefore requires the separately configured
`DATABASE_MIGRATION_URL` role, which is also used by schema migrations and the
admission-rollout operator CLI. The retention command does not fall back to the
application or administration URL. Keep the class dry-run as the default and
record its result with the change:

```sh
bun scripts/retention-apply.mjs --backend postgres --class retired-command-keys \
  --database control_plane --host <postgres-host>

# Only after review; requires the explicit operator hold policy and confirmation.
bun scripts/retention-apply.mjs --backend postgres --class retired-command-keys \
  --database control_plane --host <postgres-host> \
  --hold-policy /etc/control-plane/operator-policy.json \
  --apply --confirm retired-command-keys
```

The 30-day clock starts at `retired_at`. Rows remain at day 29 and at the exact
30-day instant; deletion becomes eligible only after that instant. This is an
explicit physical-retention action, not background cleanup. Legacy v1 rows
continue to reject matching replays while retained, but cannot prove their
scoped identity to the admission audit; they block a safe intake resume until
the 30-day window expires and the operator deletes them through this class.
Execution cleanup keeps an owner reference-pinned while any tombstone row is
persisted, even after day 30. Run the retired-command-key sweep first, then
rerun execution-owner cleanup if it is otherwise eligible. Do not manually edit
a tombstone to clear that diagnostic.

Context packages are freed by the same bottom-up order: a package stays
retained while a plan pins it or the authoring command that produced it still
exists.

Executions are the last class to become eligible: an execution stays retained
while its acceptance record, either interaction/cancellation receipt, its
interaction requests, events, a reconciliation checkpoint or a non-terminal
attempt still exists, so a pass over the earlier classes is what frees it.
Interaction requests currently have no configured retention deletion class;
they remain a durable reference until that lifecycle is defined. Running
`--class executions` first is harmless. The pass reports `reference_pending`
until those records are gone.

The default is a dry run: it reports how many expired candidates exist, how many
are eligible, and why the rest are retained. Deleting any supported class requires
`--apply --confirm <class> --hold-policy /absolute/path/operator-policy.json`.
The protected policy must bind the exact target and grant the verified operator
class-wide `sweep` authority. Confirmation alone is not authorization, even when
the database has no holds. Only records that are expired, terminal,
reconciled, unreferenced and already carry their reserved rejection key are
removed; the rejection key itself is kept, so a replay of the same scoped
idempotency key still fails closed. `raced` counts candidates whose state changed
between selection and deletion. Those candidates are left alone and picked up by a later
pass. `--bound` limits a pass; `--now <instant>` selects an assessment instant
for dry runs and historical backfills. A physical apply rejects future instants
so replay tombstones cannot be expired ahead of the host's current clock.

### Operator policy and durable holds

The host operator adapter is `scripts/retention-hold-admin.mjs`. Its policy is an
explicit UTF-8 JSON file, not request-body policy, environment identity claims, or
an implicit administrator grant. Keep it under the trusted operator's control:
an absolute regular file owned by the current process UID, with no group/world
write permission (for example `0600`). Symlinks, files over 256 KiB, unconfigured
classes, unknown fields, target mismatches, and owners that differ from the decided
retention policy are refused. Parent directories must also remain operator-controlled.
This adapter fails closed where Unix UID/no-follow checks are unavailable; it is
not Windows certification or a hosted product-user authorization endpoint.

A SQLite policy for one class looks like this (replace the canonical database
path and encoded OS username with the actual operator's values):

```json
{
  "schemaVersion": 1,
  "target": { "backend": "sqlite", "database": "/var/lib/control-plane/state.sqlite" },
  "policy": {
    "command-inbox": {
      "owner": "platform-operator",
      "scopes": ["class", "workspace", "project"],
      "reasonCodes": ["legal-case"]
    }
  },
  "grants": [
    {
      "actorPrincipalRef": "operator:os-user:alice",
      "authorityRef": "authority:sqlite:local-os",
      "classId": "command-inbox",
      "scope": { "kind": "class" },
      "actions": ["create", "release", "assess", "sweep"]
    }
  ]
}
```

For PostgreSQL, the target is
`{"backend":"postgres","database":"control_plane","host":"<postgres-host>","port":5432}`;
it must match the application credential's database, hostname, and effective
port exactly. Existing policies without `port` remain scoped to the default
PostgreSQL port 5432 only. The
grant's authority is `authority:postgres:role:<encoded-current_user>`, read from
the actual connection, not a role supplied in JSON or inferred from a username
in the connection URL. The actor remains the verified encoded OS username.
Provision individual trusted operator accounts and least-privilege database
credentials; shared accounts give shared attribution. Database access alone is
not an implicit owner grant.

Include explicit class policies for all stored holds that a pass validates. A
missing policy for a stored hold fails closed. Class owners remain those printed
by `retention-report --classes`. Grant only necessary actions: `create` and
`release` administer holds; `assess` and `sweep` authorize configured dry-run and
physical passes. Workspace/project grants cannot authorize the current unscoped
whole-class passes, even if they list `sweep`. There is no implicit widening to
another workspace, project, or class.

Create input is a strict JSON object with `operation: "create"`, a UUID-v4
`holdId`, `classId`, canonical `scope`, configured `reasonCode`, and the verified
session's `actorPrincipalRef` and `authorityRef`. Release input uses
`operation: "release"`, the existing `holdId`, a UUID-v4 `requestId`,
`expectedRevision: 0`, and the same matching session claims. Claims are compared
with the real host session; the adapter never overwrites spoofed attribution.
Release is explicit and revision-checked; retrying a create after release does
not reactivate the hold. Output contains only status, operation, hold ID and
revision, not the reason or principal.

```sh
bun scripts/retention-hold-admin.mjs --backend sqlite \
  --database /var/lib/control-plane/state.sqlite \
  --hold-policy /etc/control-plane/operator-policy.json --input /secure/hold-request.json

bun scripts/retention-apply.mjs --backend sqlite --class command-inbox \
  --database /var/lib/control-plane/state.sqlite \
  --hold-policy /etc/control-plane/operator-policy.json

# Only after reviewing the dry run:
bun scripts/retention-apply.mjs --backend sqlite --class command-inbox \
  --database /var/lib/control-plane/state.sqlite \
  --hold-policy /etc/control-plane/operator-policy.json --apply --confirm command-inbox
```

PostgreSQL administration uses the same flags plus `--host <postgres-host>` and
`--database control_plane`. An unconfigured dry run remains possible only when
the existing storage guards can prove there are no holds. An active matching
hold prevents deletion and produces no deletion-journal entry; releasing it
does not restart the retention/reference clock. This host path does not prove
full application/profile wiring, hold-event backup durability, provider TTL
coordination, or restore-time outcome reconciliation.

Restoring a snapshot that predates a deletion pass brings the compacted records
back and can lose the rejection identities that keep replays failing closed. Every
`--apply` pass writes a journal (default `<database>.retention-journal.jsonl`, or
`retention-journal.jsonl`; `--journal <path>` overrides) recording the effects it
is about to apply. After restoring such a snapshot and **before exposing it**, run:

```sh
bun scripts/retention-reapply.mjs --backend sqlite --database <restored.sqlite> \
  --journal <retention-journal.jsonl>

bun scripts/retention-reapply.mjs --backend postgres --database control_plane \
  --host <postgres-host> --journal <retention-journal.jsonl>
```

Reapply is idempotent: inserts are insert-if-absent and deletes are by identity.
An entry whose transaction never committed still applies its approved deletion
intent; idempotence alone does not reconcile that outcome or later holds and
references. The current command is not proof of full restore acceptance. Keep
the journal independently of the database and reconcile ambiguous outcomes
before exposing a restored copy; without the journal a snapshot cannot be
brought forward. External durability and outcome reconciliation remain open
M11 gates.

For a retired-command entry, reapplication derives the v2 commitment from the
restored inbox row and compares it with the journal before inserting the
tombstone. It fails closed when the source row is absent and no exact verified
v2 tombstone already exists. The journal contains the opaque scope key and
command/execution identifiers, not the original caller, operation, workspace,
project, idempotency key, or command payload.

PostgreSQL reapplication uses `DATABASE_URL` for journals that only insert
retirement evidence. A journal containing `postgres.deleteRetiredCommandKey`
requires the dedicated `DATABASE_MIGRATION_URL`; the command never falls back
to the application URL for that deletion. Keep the application role
insert-only for retired-command tombstones.

Use this command to see which classes can be swept and which remain
reference-governed. It prints the decided duration, governance mode, hold owner,
and whether a deletion path exists:

```sh
bun scripts/retention-report.mjs --classes
```

A `reference-governed` class has no age deadline, so no candidate can become
eligible for it; a `bounded` class without a deletion path still needs one
built. Both are reported rather than implied.

Inspect retained growth without deleting anything with
`bun scripts/retention-report.mjs` (same target validation, payload-free counts),
or read the `retention.sweep` records the services log every sweep interval.

Deleting execution events also records a retired event id and sequence, so a
retry of that event cannot resurrect it and the sequence number is never reused;
`bun run db:migrate` must have applied migration `0048_tense_thor.sql` before the
first event deletion on a PostgreSQL deployment.

## PostgreSQL operations

- Use Control Plane’s public schema in the existing Railway database; never grant its roles access to Adea’s app/auth schemas.
- Application services receive least-privilege runtime authority only where needed.
- Migration/admin authority is one-shot/operator scoped and not available to ordinary service replicas.
- Validate schema version before accepting traffic.
- On database saturation, stop nonessential producers and inspect query/pool/backlog evidence before increasing retry pressure.
- On corruption or accidental deletion, freeze writes where practical, restore into an isolated destination using PostgreSQL recovery/PITR or equivalent provider capability, verify schema/integrity/reconciliation, then switch through an explicit change process.

## R2 operations

- R2 buckets remain private and are accessed only through the provider-neutral ObjectStore/Artifact boundary.
- Bucket/environment separation, retention/lifecycle, least-privilege credentials, and upload/download policy are defined in M9.9.
- Failed or ambiguous object operations reconcile against authoritative metadata/digests rather than assuming success.
- Local/Hosted data is not automatically promoted to R2; cloud storage requires an explicit authorized operation.

## Restate operations

Durable-workflow qualification uses the pinned runtime in `infrastructure/railway/restate.json` only inside an explicitly provisioned disposable sandbox. Keep ingress, administration and fabric ports private. Use persistent sandbox storage for restart/recovery tests and never run two processes against the same volume. Production currently promotes only the Control API; expanding that topology requires a separately reviewed configuration change.

## Gateway and provider degradation

- Distinguish transport failure, provider refusal, policy denial, approval wait, budget exhaustion, and persistence/workflow failure in telemetry.
- Runtime Gateway is used only for non-co-located RuntimeNodes. Local co-located execution uses direct RuntimeTransport and must not fall back to Runtime Gateway as an implicit recovery path.
- On gateway disconnect, replay only durably identified commands and reconcile ambiguous outcomes before retry.
- On model/tool/sandbox/ContextProvider degradation, follow the pinned policy and approved fallback behavior; optional providers must not become undeclared startup dependencies.

## Local operations (M10)

Local uses all-in-one Control Plane + SQLite's embedded workflow queue (no Restate process) + filesystem storage + direct RuntimeTransport.

### Ambiguous direct-runtime dispatch

Local commits a dispatch intent in the existing SQLite `workflow-effects` namespace
before calling a direct runtime. A completed outcome replays normally. For a saved
handle, Local asks the runtime to reconcile its status without starting new work.
A schema-valid terminal status matching the exact saved handle can recover the
outcome and its Artifact. Missing native state, nonterminal status, a mismatched
handle, or an intent without a handle returns `LOCAL_RUNTIME_DISPATCH_AMBIGUOUS`
with `retryable: false` instead of launching the attempt again. Concurrent callers
in the same composition share one pending call.

This diagnostic does **not** prove that the native runtime stopped or never began.
Preserve the SQLite database, Restate journal, native runtime state, and correlated
execution/attempt IDs. Reconcile native work, Artifacts, and usage before an operator
authorizes replacement work. Do not clear the intent, delete the runtime handle,
or automatically retry under a new attempt ID to bypass the ambiguity. Cleanup may
remain unresolved when the runtime cannot recognize a recovered handle; do not
report that as successful native process cleanup.

The intent is retained with existing workflow-effect records and contains only
execution/attempt identifiers, not prompts or credentials. It does not add native
Pi in-flight reattachment. Drain or reconcile outstanding work before upgrading:
an older lost-ACK attempt with neither an intent nor a handle cannot be detected
retroactively by this guard.

SQLite startup checks the stored schema version before running schema DDL. The version check,
schema creation, and version stamp share one transaction: unsupported versions are rejected, and
failed schema statements roll back without leaving partially created tables. This is not automatic
downgrade support or a cross-version migration guarantee. Preserve a verified backup and use a
compatible binary when `SQLITE_SCHEMA_INCOMPATIBLE` blocks startup.

The packaging, checkpoint, sleep/wake, upgrade, rollback, incident, host-loss, and measured resource
contracts are executable from [`local-deployment.md`](local-deployment.md).

Operational requirements include:

- clean startup/shutdown and component health manifest;
- Control Plane/Restate crash recovery;
- host restart and sleep/wake behavior;
- SQLite backup/restore and corruption handling;
- local filesystem Artifact lifecycle;
- OS-secure secret handles or approved standalone-local secret references;
- no Docker/PostgreSQL/Redis/Temporal/Runtime Gateway requirement for ordinary Local execution;
- explicit unavailable/queued behavior when the selected node is offline, with no silent cloud failover.

## Hosted operations (M10)

Hosted `simple` uses SQLite; `server` uses PostgreSQL. Both use Restate and user-controlled storage/secrets.

Required operational evidence includes:

- one documented Compose deployment path;
- persistent volumes across container/host restart;
- TLS/reverse-proxy and authenticated external API/relay configuration;
- backup/restore;
- update/rollback/forward repair;
- key/credential rotation/revocation;
- resource budgets for small VPS and server profiles;
- no dependency on Railway/PostgreSQL/R2/Adea Cloud for standalone operation.

## Diagnostic correlation

Investigations begin with stable product/execution identifiers, not provider-specific resource IDs. Minimum useful correlation includes request, workspace, execution, attempt, workflow/Restate invocation, runtime/node/transport, profile/Skill versions, provider/tool/model policy versions, and trace identifiers.

Provider-specific Railway/PostgreSQL/R2/Restate identifiers may appear in operational diagnostics but do not replace stable Control Plane IDs and must not leak secrets or protected content.

Child-progress lead deliveries, evidence packets and correlated child usage cost states are documented in [child-progress-evidence.md](child-progress-evidence.md), including the durable publication path, restart replay, and the current single-child runtime guard limits.

## Security incidents

- Policy denial is authoritative and cannot be overridden by prompt/model/tool/provider content.
- On credential leakage, revoke/rotate first, then clean history/logs and record sanitized evidence.
- On suspected cross-workspace access, disable affected routes/credentials, preserve sanitized correlation evidence, run the isolation matrix, and block promotion until fixed.
- Remote relay/gateway incidents must preserve HPKE/content-redaction guarantees; cloud/relay systems must not require plaintext sensitive execution content.
- Remote control is disabled unless an outbound `RemoteControlHostAdapter` is supplied to the Local or Hosted composition. Provision its dedicated X25519 private key through the profile's `SecretsProvider`; never place it in a database, Artifact, Compose file, or relay configuration. Follow [`remote-control-relay.md`](remote-control-relay.md) for rotation, revocation, redelivery, and reconciliation behavior.

## Scheduled evidence

- **Every managed-cloud candidate:** build/deploy, PostgreSQL migration/schema, Restate, R2, health/readiness, recovery, security, and cost evidence.
- **Every M10 candidate:** Local and Hosted clean install/start/restart/backup/restore/conformance evidence.
- **M11:** independent full-profile audit from frozen candidate.
- **M12:** profile-substrate and live cross-product certification/release evidence only after M11 approval, per the #195 owner decision.

The production database bootstrap did not claim a timed disaster-recovery exercise. Run `bun run certify:m9-cloud` only against an explicitly authorized disposable sandbox, including idempotent replay and recovery checks. Production promotion continues through its protected schema and readiness gates.
