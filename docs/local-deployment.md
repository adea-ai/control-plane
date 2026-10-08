# Local deployment and recovery

Local is the developer-MVP default. Adea Desktop owns one Control Plane process. The composition
uses embedded SQLite, filesystem Artifacts, local secret handles, content-redacted telemetry, and a
direct co-located RuntimeTransport. It does not require Docker, PostgreSQL, Redis/Valkey, Temporal,
Railway, Neon, R2, Runtime Gateway, or a Restate process: durable execution runs in-process on the
embedded SQLite queue (`WorkflowJobStore` + `EmbeddedWorkflowRuntime`), which serves the same
workflow contracts as the Restate path. Restate remains the durable-execution backbone for the
hosted and user-controlled self-hosted profiles (`hosted-simple` keeps the bundled Restate child
through this same composition with `durableExecution: 'restate'`).

## Packaging contract

For initial immutable profile/skill publication and ProjectState setup without test-only database
seeding, use the [offline operator setup command](local-operator-bootstrap.md). Context authoring,
catalog approval, credentials and runtime bindings retain their separate authority checks.

The desktop host supplies a private data directory and starts `@control-plane/local-control-plane`.
It must supervise the parent process and send a graceful termination signal before desktop exit or
upgrade. Accepted executions are enqueued durably before the HTTP response, claims are leased with
single-use tokens, and a restart (graceful or crashed) resumes parked or in-flight jobs
at-least-once: workflow activities replay from the durable journal and lost dispatches reconcile
against the runtime adapter. A failed component makes readiness false; the desktop must not
silently move work to Cloud. Host sleep/wake preserves the process and data directory; on wake the
desktop rechecks `/ready` and restarts the composition if it did not survive.

`hosted-simple` deployments select `durableExecution: 'restate'` (or
`CONTROL_PLANE_DEPLOYMENT_PROFILE=hosted-simple`) and bundle the Restate child. In that mode the
desktop must additionally restart the composition after an unexpected Restate failure. If the owned
Restate child exits while startup is polling readiness, startup reports `RESTATE_PROCESS_EXITED`
and cleans up through the captured process handle. A health response received after that child
exits does not establish readiness. This is a child liveness check, not cryptographic
authentication of a service listening on the selected port.

Co-located compositions must use separate private data directories and distinct ports. Restate-mode
compositions accept `restateAdminPort` (default 9070), `restateIngressPort` (8080),
`restateNodePort` (5122), and `workflowEndpointPort` (9080); all four listeners remain
loopback-only. The embedded local mode starts no extra listeners. Standalone E2E tests allocate
their own ports so they do not register workflows or submit commands to an already running Local
service.

The supported runtime seams are the `runtimeTransport` and `runtimeFactory` options on
`LocalControlPlaneComposition` (or the same fields under `start({ compositionOptions })`). The
factory runs only after the SQLite catalog and ContextPackage repositories exist, so a packaged
client can resolve immutable inputs without copying repository internals into the adapter contract.
The result must be a `RuntimeAdapterWithTransport` whose `transportKind` is `direct-local`.

A packaged host can configure `graphRuntime` under `compositionOptions` to bind published graph
programs from this composition's workspace-scoped SQLite graph catalog. Supply the server-owned
`compiler` schema registry and operation allowlist, advertised `capabilities`, and an `operations`
port that enforces accepted-plan policy, approvals, budget reservations and durable provider receipts.
The same compiler and catalog authorize both execution validation and acceptance, then execute
bounded segments with SQLite checkpoints and the normal pending execution-event queue. Checkpoints
share the existing backup and database-close lifecycle; storage threads include workspace and
execution identity. The configured execution-event retention duration is used by graph events.

This configuration requires a direct runtime transport and cannot be combined with `activities`,
`graphActivities`, or `graphActivitiesFactory`. The latter remain explicit injection seams without
implicit graph admission. Without `graphRuntime`, default graph admission remains closed. This
assembly requires explicit provider bindings and does not establish deployed profile acceptance.

The supported `start()` launcher can opt into one built-in graph tool with the operator-owned
`CONTROL_PLANE_LOCAL_GRAPH_CONFIG` environment variable. It must name an absolute path to a regular,
non-symlink JSON file no larger than 16 KiB. The file has exactly these fields: `schemaVersion` (1),
`workspaceId`, `toolDefinitionId`, `toolVersionId`, `currency` (`USD`), `costMicrounits` (a
non-negative safe integer), `createdAt`, and `publishedAt` (canonical UTC timestamps). The file is
configuration, not a secret. The launcher creates or verifies the fixed tool definition and
published immutable version before readiness, binds only its fixed `store-json` operation and
server-owned tariff, and records the configuration digest in SQLite only after successful registry
bootstrap. Restarting with changed configuration, conflicting injected graph activity, or no direct
runtime fails before opening the HTTP listener. Callers cannot register the executor, pick prices, or
select an object key through graph input. Bootstrap does not migrate earlier `tool-effects` records
or rewrite previously published version schemas. Prior accepted graph pins and unknown effects from
the earlier key convention require verified reconciliation before replay. The launcher acceptance
uses a fresh test directory; it does not certify upgrades of existing installations.

For the built-in immutable JSON tool, `operations` can be a server-owned factory receiving
`{ api, persistence, objectStore }` from the Local composition. Return `LocalGraphToolOperations`
(exported from the Local package) with those resources and an operator-owned `prices` array. Each
price contains an exact `GraphToolPin`, currency, and integer `costMicrounits`; graph input cannot
select a price, object key, or filesystem path. Publish the tool definition/version in that
workspace's `ToolRegistry` before admitting its graph. The supported binding is operation
`store-json`, executor `{ type: 'internal', reference: 'local.object-store-json.v1' }`, with no
capabilities beyond optional `object-store.write`. Advertise `graph.tool-pins.v1` only when the
configured operation port supports it.

This port reloads the accepted execution, current attempt, immutable plan, graph node and tool
version. Every matching logical tool grant must permit the operation's version, capabilities,
risk and approval requirements. Approved effects require an authorized persisted Interaction; a
graph resume value merely wakes the checkpoint. The port reserves the configured tariff before
delivery, records one durable charge after a confirmed write, and releases the reservation after
a known no-effect denial/failure. Unknown writes retain their reservation and are not redelivered.
Cancellation intent and rate-limit windows survive SQLite reconstruction. An unconfirmed graph
cancellation moves the execution/attempt to `reconciliation_required` and cannot complete terminal
cancellation or cleanup. The tool writes canonical JSON bytes to an immutable `art_<id>` ObjectStore
key and returns that Artifact reference, SHA-256 digest, and byte count only after verifying the
persisted receipt. The stable key is derived from accepted workspace/execution identity and the
durable request ID; its metadata binds workspace, project, execution, and internal sensitivity. This
deliberately replaces the earlier `tool-effects/<workspace>/<execution>/<request>` key shape so the
terminal execution result is a real Artifact understood by the existing lifecycle. Existing objects
are checked for matching bytes, digest, scope, media type, and available lifecycle metadata before
cold replay.

An operator with the `execution:reconcile` service scope can inspect and reconcile a parked Local
tool effect through `POST /v1/executions/tool-effects/inspect` and
`POST /v1/executions/tool-effects/reconcile`. Inspection is limited to 64 calls and returns only
call identity/revision/state, artifact verification state, and charge/settlement flags. Reconcile
accepts an execution ID, tool-call ID, inspected revision, and `resume` or `cancel` action. The
service rebuilds input, request identity, checkpoint, and authority from persisted execution data;
callers cannot supply artifact bytes, workspace/project scope, or checkpoint IDs. It marks a call
succeeded only after verifying the canonical immutable object bytes, SHA-256 digest, and bound
metadata, then repairs the existing reservation's charge and settlement idempotently. A `resume`
queues one deterministic recovery job for that tool call/checkpoint in a distinct SQLite journal,
preserving the original parked outcome; replaying with a different command ID does not queue a
second continuation. Missing, conflicting, or unverifiable evidence stays held with its reservation
unchanged. If execution deadline or current delivery authority has expired, verified historical
accounting may finish, but continuation is refused and cancellation remains available.

Each reconcile command is fenced by a durable Local receipt in
`local-graph-tool-reconciliation-receipts`. Its identity is the authenticated caller, workspace,
operation, and idempotency key; project and canonical payload are checked for conflicts. The receipt
preserves the first command ID, request ID, and issue time, so a retry with new transport IDs returns
the original acknowledgment. A pending intent is persisted before accounting or continuation work;
if dispatch succeeds but receipt completion is lost, retry resolves the exact persisted recovery job
before returning the planned acknowledgment. An active owner produces a bounded processing result,
not a false held result. This namespace currently has no age-based deletion path and must remain
protected. Issue #194 still needs an explicit retention policy, retired-key fence, hold/reference
rules, and cleanup/restore evidence for this class; this receipt is not a completed retention
implementation.

This remediation path is supported only by Local `embedded-sqlite`; Restate is explicitly
unsupported. It does not migrate old records. A historical effect is reconcilable only when its
persisted accepted plan, graph pin, checkpoint/input identity, tool request, reservation, and object
evidence can all be verified. Records missing one of those bindings remain `unverifiable` and must
not be resumed automatically; operators can request cancellation, which remains non-terminal while
an effect or accounting state is unresolved.

The `launcher-graph.test.mjs` supported-launcher acceptance uses a test-local `direct-local`
transport fixture because the graph node itself is the executed work. It exercises the exported
`start()` path, real API plan validation/acceptance, persisted approval, Artifact write, and SQLite
restart/replay; it is not Pi/ACP provider certification or the complete deployed profile matrix.
This binding is one Local tool path; other tools, MCP, model/runtime and delegation bindings require
separate delivery evidence.

The standalone launcher packages managed Pi with:

```sh
CONTROL_PLANE_LOCAL_RUNTIME=managed-pi \
CONTROL_PLANE_MANAGED_PI_EXECUTABLE=/absolute/path/to/pi \
CONTROL_PLANE_MANAGED_PI_PROVIDER=openai-codex \
CONTROL_PLANE_MANAGED_PI_MODEL=gpt-5.4 \
CONTROL_PLANE_MANAGED_PI_MODEL_ALIAS=reasoning.standard \
CONTROL_PLANE_MANAGED_PI_MODEL_CAPABILITIES=tool_calling,structured_output \
CONTROL_PLANE_MANAGED_PI_PROVIDER_CLASS=managed \
CONTROL_PLANE_MANAGED_PI_DATA_RESIDENCY=us \
bun run --cwd apps/local-control-plane start
```

This path is `ManagedPiAdapter -> DirectLocalRuntimeTransport -> ManagedPiDriver ->
ManagedPiProcessClient -> Pi RPC`. Before starting Pi, it resolves the exact published
AgentProfile/Skill versions and the content-addressed ContextPackage from SQLite and rejects any
missing, draft, or mismatched pin. Pi receives the materialized input through strict JSONL RPC.
Ambient tools, extensions, skills, prompt templates, themes, context files, project trust, and
session persistence are disabled. The child receives PATH plus a freshly generated
private HOME, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR`; ambient Pi
configuration is not inherited. Native Pi authentication contains only the
attempt's private model-broker capability. Provider/model selectors describe the
approved server route, while Pi selects `control-plane` and the logical alias.
Before execution, an operator must record scoped spending approval and its pinned
price/deployment/credential reference through the private file boundary described
in [model-gateway.md](model-gateway.md). The server leases provider credentials and
commits each model-request hold in the same SQLite usage store as workflow budget
admission. Closing the attempt revokes the broker and removes private configuration.
The configured logical alias, declared model capabilities, provider class, provider deny-list, and
data residency must satisfy the immutable ExecutionPlan model policy or materialization fails closed.

The packaged process client currently accepts Pi `>=1.0.0 <1.1.0`, exposes streaming,
cancellation, and degraded steering input, and does not claim approval interactions, native tools,
or in-flight process recovery. Plans requiring those unsupported capabilities remain ineligible.
The historical injected client certification remains `>=0.52.0 <0.53.0`; the two ranges are not
silently conflated. ACP can use the pinned Codex ACP launcher below. A remote-gateway adapter is rejected, and omitting a
runtime deliberately leaves execution acceptance unavailable rather than selecting a fixture or
silently routing to Cloud.

### Pinned Codex ACP launcher

Build the pinned artifact using the [installation procedure](evidence/m11-pinned-acp-installation-2026-09-08.md),
then configure explicit paths and a native model route:

```sh
CONTROL_PLANE_LOCAL_RUNTIME=codex-acp \
CONTROL_PLANE_CODEX_ACP_INSTALLATION=/absolute/acp-installation \
CONTROL_PLANE_CODEX_ACP_NODE=/absolute/node24 \
CONTROL_PLANE_CODEX_ACP_CWD=/absolute/task-workspace \
CONTROL_PLANE_CODEX_ACP_HOME=/absolute/native-codex-home \
CONTROL_PLANE_CODEX_ACP_PROVIDER=openai \
CONTROL_PLANE_CODEX_ACP_MODEL=gpt-5.4 \
CONTROL_PLANE_CODEX_ACP_MODEL_ALIAS=reasoning.standard \
CONTROL_PLANE_CODEX_ACP_MODEL_CAPABILITIES=tool_calling,structured_output \
CONTROL_PLANE_CODEX_ACP_PROVIDER_CLASS=managed \
CONTROL_PLANE_CODEX_ACP_DATA_RESIDENCY=us \
bun run --cwd apps/local-control-plane start
```

Startup verifies the manifest, ACP executable digest, installed Codex package version, patched
native release receipt and binary digest, and Node 24
before spawning. It neither installs nor authenticates automatically. Configure authentication and
provider endpoints in the explicitly selected native Codex home. Only the selected paths,
`CODEX_CONFIG` model/provider selectors, `MODEL_PROVIDER`, and the fixed upstream
`INITIAL_AGENT_MODE=read-only` human-review preset enter the child environment; its HOME
is under the Local data directory. Arbitrary parent environment variables are not forwarded.
Published profile/Skill pins and model-route eligibility are checked before the prompt is sent.
Native harness instructions and tool permissions retain their native ownership.
The `read-only` preset maps to Codex native `readOnly` sandbox policy with network access disabled,
while keeping `on-request` approval routed through the authenticated Control Plane interaction
flow rather than the upstream automatic reviewer. It does not grant workspace-write access.

The native certification covers completion through this runtime selector with SQLite and real
Restate, including configured model/provider override of conflicting native defaults. It is not
proof of in-flight process recovery, all native tools/approvals, live provider quality, or full M11
acceptance. Unsupported requirements must still be rejected by capability negotiation.

`createLocalAcpRuntime` requires an explicit `resolvePrompt` function. The repository helper
`createRepositoryAcpTaskPromptResolver(contextPackages)` resolves and verifies the exact
ExecutionPlan/ContextPackage digests, schema/compiler pin and workspace/project scope, then sends
the objective, bounded context, success criteria and output contract as task data. It preserves
native harness instructions and authority; identifiers alone are not an executable task. The
driver resolves this input before creating a native session, applies its request deadline, and
rejects empty or greater-than-256-KiB UTF-8 prompts. Failed or timed-out resolution cannot later
launch a session. Resolvers must be read-only and honor the supplied AbortSignal.

The context-only resolver does not materialize profile/Skill instructions, configure or certify the
native model route, install/authenticate a harness, grant filesystem/tool authority, or solve
native aggregate usage and restart recovery. Those remain separate acceptance gates. The generic
driver retains its reference-only metadata prompt for compatibility; the concrete Local factory
does not silently select that fallback.

When the repository-backed ACP prompt resolver is also supplied the published catalog, it checks
the exact profile and Skill version identities, revisions, digests, schema versions and publication
states using the same validation as managed Pi. Validated profile/Skill instructions are included
as structured task inputs, without adding Pi-only restrictions or replacing native harness-owned
instructions. The context-only injection seam remains available for existing callers. This shared
materialization is used by the pinned launcher above.

The resolver also accepts a `LocalRuntimeModelRoute`. When supplied, the route's declared logical
alias, provider, provider class, residency and capabilities must satisfy the ExecutionPlan before
task data is read. Managed Pi uses the same policy checks. This validates declarations; the pinned
launcher separately enforces the selected native model/provider. The legacy context-only
injection seam does not infer a route or certify native configuration.

Runtime interactions use the same durable workflow signal as other profiles. Input responses carry
the bounded structured value validated by the interaction domain and are translated to the direct
driver only after the workflow resumes. Approval, denial, cancellation, and input effects retain
their stable workflow effect key, so replay does not submit a second native action.

Lifecycle cancellation does not commit its effect on a non-terminal or unknown adapter
acknowledgement. It reconciles the same handle once per activity invocation; if the state remains
non-terminal or unknown, `RUNTIME_CANCEL_UNCONFIRMED` leaves the effect uncommitted so the durable
workflow can retry before terminal status publication and cleanup. Retries retain the original
idempotency key and request timestamp, and reconciliation must match the full handle identity.
A terminal state confirms the adapter reports no active execution; this boundary check does not
independently certify native process termination or resolve an unavailable adapter's state.

The data directory is one recovery unit: `control-plane.sqlite` (including any SQLite sidecars),
`artifacts/`, `secrets/`, and generated private API authentication state. Restate-mode
(`hosted-simple`) compositions additionally own the `restate/` subdirectory. It must remain
owner-only. Do not back up one of those paths independently while work is admitted.

## Checkpoint and restore

Local retains observed unsuccessful-terminal usage in SQLite's
`runtime-terminal-usage` namespace before completing cancellation cleanup. These
immutable execution/attempt receipts are included in the normal whole-directory
checkpoint. Preserve them until settlement and recovery references are resolved;
they are not themselves billing entries. Missing usage is unresolved, not zero.
See the [receipt evidence and limits](evidence/m11-terminal-usage-receipts-2026-09-08.md).

Stop the Local Control Plane and, in restate mode, confirm the process plus bundled Restate
child have exited. Create
and verify an integrity manifest without printing file contents:

Successful Local composition shutdown requests a cold SQLite checkpoint before closing the
database. It truncates the WAL and verifies the switch to DELETE journal mode so deferred
statement cleanup cannot remove sidecars during filesystem copying. Normal startup reinstates
WAL mode. If another connection prevents this transition, shutdown reports
`SQLITE_CHECKPOINT_BUSY`; do not proceed with the directory checkpoint until all users of the
database are stopped and a clean shutdown/checkpoint succeeds. Ordinary provider `close()`
remains available without this exclusive cold-checkpoint requirement. Never manually delete a
live WAL to make backup succeed.

```sh
bun run checkpoint create --profile local --source "$CONTROL_PLANE_DATA_DIR" --destination ./backups/local-pre-upgrade
bun run checkpoint verify --checkpoint ./backups/local-pre-upgrade
```

Restore is dry-run verification unless `--apply` is present. The destination must not exist, which
prevents accidental merging of checkpoints:

```sh
bun run checkpoint restore --checkpoint ./backups/local-pre-upgrade --destination "$CONTROL_PLANE_DATA_DIR.restored"
bun run checkpoint restore --apply --checkpoint ./backups/local-pre-upgrade --destination "$CONTROL_PLANE_DATA_DIR.restored"
```

Start against the restored directory, require `/ready`, run SQLite `PRAGMA quick_check`, and verify
one known ProjectState/Artifact digest before replacing the previous directory. A failed digest,
symlink, special file, extra file, missing file, or private-path overlap fails closed.

## Upgrade, rollback, and incidents

Before upgrade, quiesce admission, create a checkpoint, record the current app and schema
versions (plus the Restate version in restate mode), and retain the prior signed desktop bundle. After upgrade, require readiness and a durable
command replay check. Roll back the application only when its schema and Restate data format remain
compatible. Otherwise restore the matching pre-upgrade checkpoint or apply the reviewed
forward-repair release.

For corruption or host loss, preserve the failed directory, restore into a new path, and record only
stable IDs, versions, counts, and digests. Never put prompts, context, credentials, HPKE plaintext,
or secret file contents in evidence. Revoke remote-control registration and rotate the host key if
the host or backup confidentiality is uncertain.

## Resource envelope

Minimum supported developer host allocation is 2 CPU cores, 4 GiB system RAM, and 2 GiB free disk;
recommended is 4 cores, 8 GiB RAM, and 10 GiB free disk. The Local composition release budget is
less than 750 MiB idle RSS, less than 5% of one core sustained at idle, at most 2 cores and 2 GiB RSS
under the representative M10 workload, and bounded disk growth attributable to SQLite and Artifacts (plus Restate data in restate
mode). Local has a $0/month mandatory managed-infrastructure budget because it runs on the
developer's existing machine; optional backups or remote-control connectivity are user-selected
costs. M11 must remeasure these limits on packaged macOS and desktop sleep/wake hardware.
