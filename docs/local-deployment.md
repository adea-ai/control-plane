# Local deployment and recovery

Local is the developer-MVP default. Adea Desktop owns one Control Plane process and its bundled
Restate child process. The composition uses embedded SQLite, filesystem Artifacts, local secret
handles, content-redacted telemetry, and a direct co-located RuntimeTransport. It does not require
Docker, PostgreSQL, Redis/Valkey, Temporal, Railway, Neon, R2, or Runtime Gateway.

## Packaging contract

The desktop host supplies a private data directory and starts `@control-plane/local-control-plane`
with loopback API and workflow ports. It must supervise the parent process, send a graceful
termination signal before desktop exit or upgrade, and restart the whole composition after an
unexpected Control Plane or Restate failure. A failed component makes readiness false; the desktop
must not silently move work to Cloud. Host sleep/wake preserves the process and data directory; on
wake the desktop rechecks `/ready` and restarts the composition if Restate did not recover.
If the owned Restate child exits while startup is polling readiness, startup reports
`RESTATE_PROCESS_EXITED` and cleans up through the captured process handle. A health
response received after that child exits does not establish readiness. This is a child
liveness check, not cryptographic authentication of a service listening on the selected port.

Co-located compositions must use separate private data directories and distinct ports.
`LocalControlPlaneComposition` accepts `restateAdminPort` (default 9070),
`restateIngressPort` (8080), `restateNodePort` (5122), and `workflowEndpointPort` (9080).
All four listeners remain loopback-only. Standalone E2E tests allocate their own ports so
they do not register workflows or submit commands to an already running Local service.

The supported runtime seams are the `runtimeTransport` and `runtimeFactory` options on
`LocalControlPlaneComposition` (or the same fields under `start({ compositionOptions })`). The
factory runs only after the SQLite catalog and ContextPackage repositories exist, so a packaged
client can resolve immutable inputs without copying repository internals into the adapter contract.
The result must be a `RuntimeAdapterWithTransport` whose `transportKind` is `direct-local`.

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
session persistence are disabled. The child receives only `HOME`, `PATH`,
`PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR` when those names are present; Control Plane
database, relay, API, and service credentials are not inherited. Provider/model selectors are
non-secret. Native Pi authentication remains in the explicitly selected Pi configuration directory.
The configured logical alias, declared model capabilities, provider class, provider deny-list, and
data residency must satisfy the immutable ExecutionPlan model policy or materialization fails closed.

The packaged process client currently accepts Pi `>=0.84.0 <0.85.0`, exposes streaming,
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
The preset retains upstream workspace-write sandbox behavior but routes permission requests to
the authenticated Control Plane interaction flow rather than the upstream automatic reviewer.

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
`restate/`, `artifacts/`, `secrets/`, and generated private API authentication state. It must remain
owner-only. Do not back up one of those paths independently while work is admitted.

## Checkpoint and restore

Local retains observed unsuccessful-terminal usage in SQLite's
`runtime-terminal-usage` namespace before completing cancellation cleanup. These
immutable execution/attempt receipts are included in the normal whole-directory
checkpoint. Preserve them until settlement and recovery references are resolved;
they are not themselves billing entries. Missing usage is unresolved, not zero.
See the [receipt evidence and limits](evidence/m11-terminal-usage-receipts-2026-09-08.md).

Stop the Local Control Plane and confirm the process plus bundled Restate child have exited. Create
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

Before upgrade, quiesce admission, create a checkpoint, record the current app/Restate/schema
versions, and retain the prior signed desktop bundle. After upgrade, require readiness and a durable
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
under the representative M10 workload, and bounded disk growth attributable to SQLite, Restate, and
Artifacts. Local has a $0/month mandatory managed-infrastructure budget because it runs on the
developer's existing machine; optional backups or remote-control connectivity are user-selected
costs. M11 must remeasure these limits on packaged macOS and desktop sleep/wake hardware.
