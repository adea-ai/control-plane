# Production operations runbook

This runbook covers the accepted Control Plane deployment sequence and must distinguish **managed cloud (M9)** from **Local/Hosted portability (M10)**. A release is not complete because infrastructure files exist; live environment evidence is required.

## Milestone sequence

- **M9 — Managed Cloud Deployment, Hardening & Evals:** make the Railway + Neon + R2 + Restate profile actually deploy, recover, and pass the cloud hardening/eval gates.
- **M10 — Local & Hosted Portability:** port the accepted M9 semantics to Local and user-controlled Hosted profiles.
- **M11 — Feature Completion & Production Audit:** rerun production-readiness evidence across managed cloud, Local, and Hosted.
- **M12 — Cross-Product Integration & Release:** connect the independently approved Control Plane candidate to Adea and optional Cortana release candidates.

Historical AWS/ECS/Terraform procedures are not the current first-party cloud runbook.

## Managed-cloud access and configuration

The initial managed-cloud profile uses:

- Railway for compute/service lifecycle;
- a separate Control Plane Neon PostgreSQL project/database;
- Cloudflare R2 behind the `ObjectStore` boundary;
- Restate as the canonical durable workflow runtime;
- Railway private networking where applicable;
- Railway variables for service/bootstrap configuration;
- a separate provider-neutral credential-vault boundary for dynamic user/provider secrets.

Keep runtime database credentials separate from migration/admin authority. Keep service credentials scoped by service/audience. Do not store production credentials in repository files, issue bodies, test fixtures, or ordinary logs.

## Current M9 state

The Railway project has isolated `staging` and `production` environments. The Cloud activation
topology is the public `control-api`, private `workflow-worker`, and separately pinned `restate`
runtime. The local-first MVP baseline keeps Railway application compute at zero **running** replicas
in both environments by removing active deployments. Staging retains the certified Restate volume
and can be activated on demand; production remains deliberately unavailable and disconnected from
automatic Git deployment.

Use these terms precisely:

- **configured** — the service graph, provider mappings, variable names, health policy, and resource
  limits are reproducible from the repository;
- **deployed** — Railway has a built service revision or image deployment record;
- **running** — the environment currently has one or more live replicas;
- **availability enabled** — the environment has passed its release, migration, dependency, health,
  smoke, and rollback gates and is intentionally allowed to serve users.

A configured environment can therefore be neither running nor available. The 2026-08-28 staging
activation, restart, execution, Neon, R2, security, resource, and bounded cost results are recorded in
[`evidence/m9-cloud-certification-2026-08-28.md`](evidence/m9-cloud-certification-2026-08-28.md).

The repository Cloud composition now persists accepted commands/executions in PostgreSQL and wires
the workflow worker's lifecycle activities to the same authoritative execution and plan data.
Staging uses the explicit `certification` runtime mode to persist and integrity-check a deterministic
terminal result through R2. Production uses `disabled`: the worker remains healthy and discoverable,
but runtime activities fail closed with `CLOUD_RUNTIME_DISABLED` and never open R2. It cannot accept
certification executions or claim execution availability.
This path certifies the Control Plane cloud infrastructure only; later Adea managed-runtime
support requires its own runtime provider and certification.

Do not treat the staging certification, current Railway dashboard, or historical AWS configuration as
production certification. Production promotion remains a separate reviewed release gate.

## Local-first Railway standby

`infrastructure/railway/cost-policy.json` is the machine-readable standby policy. Railway rejects a
configured replica count of zero in both the TypeScript Infrastructure as Code schema and the live
service update API, so `.railway/railway.ts` describes the explicit one-replica activation shape.
Standby disconnects application sources and removes the exact active deployment revisions while
retaining services, settings, and volumes. The guarded command also inventories and removes
reactivatable nonterminal revisions so a delayed build cannot start compute after standby has been
verified. Applying the Infrastructure as Code file can start compute; it must never be used as an
ordinary standby reconciliation command.

The baseline is:

| Environment | Git source                       | Running replicas                       | Persistent state                                         |
| ----------- | -------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| staging     | application sources disconnected | 0 for each of the three Cloud services | Restate volume retained; Neon/R2 remain provider-managed |
| production  | application sources disconnected | 0 for each of the three Cloud services | Restate volume retained; Neon/R2 remain provider-managed |

Railway Serverless remains disabled. Control API first-request failures/cold starts and the
worker/Restate long-lived connection and registration behavior have not been accepted under a sleep
model. No active deployment is explicit and unambiguous.

The current Railway trial plan does not expose workspace usage limits: the live CLI rejected the
attempt with `Usage limits require an active subscription`. When the workspace moves to a paid plan,
configure the versioned $5 soft alert and $10 hard limit only after confirming the workspace still
contains no project other than Control Plane. The hard limit is an availability control, not a normal
autoscaling target.

To activate staging for a bounded Cloud test:

1. Confirm the intended `staging` revision, Railway variables, Neon branch/schema, R2 mapping, and
   retained Restate volume.
2. Run `railway config plan` while linked to staging and review every change. Run
   `railway config apply` to reconcile the activation profile, reconnect the staging sources, and
   deploy the one-replica topology. A source-only redeploy is acceptable when the project graph is
   already current.
3. Verify Restate health and registration, private worker readiness, public `/health` and `/ready`,
   explicit Neon schema compatibility, and the required smoke/certification scenario.
4. After evidence is captured, preview and apply the guarded standby transition. It disconnects both
   application sources, removes the exact active and reactivatable deployment revisions in admission
   order, and verifies that running replicas and nonterminal deployment work are both zero:

   ```sh
   bun run railway:standby --environment staging
   bun run railway:standby --environment staging --apply --confirm staging
   railway service list --environment staging --json
   ```

Production activation is a release operation, not a scale-only operation. Before scaling production,
the reviewed `staging` to `main` promotion must be complete; production-specific secrets and service
identity must exist; the production Neon migration must pass with migration-only authority; Restate
must have its production volume, stable identity key, and worker registration; and R2 isolation,
health, smoke, observability, and rollback gates must pass. Connect application sources only as an
explicit part of that activation. On rollback, stop new admission, preserve provider state, return
to no active application deployments, and disconnect production sources again.

## Managed-cloud release and rollback

The provisional operational targets remain RPO 5 minutes and RTO 60 minutes. M9.6 recorded no
committed-work loss in its bounded restart scenarios, but it did not claim a timed disaster-recovery
exercise or measured production RTO. M11 must measure or explicitly revise these targets against a
production release candidate.

1. Require M9.7–M9.13 implementation/configuration gates to be complete.
2. Build/test/scan the complete monorepo using the repository-owned Railway/container build path.
3. Record exact commit, service versions, Restate version, schema/contracts, and repository-owned Railway configuration.
4. Validate required Railway variables and external dependency references without exposing secret values.
5. Run explicit Neon migrations using separately scoped migration authority.
6. Deploy required Railway services and the accepted Restate topology.
7. Verify liveness/readiness through intended public/private network paths.
8. Run a representative durable execution through Restate and verify authoritative Neon state plus R2 operations where used.
9. Exercise failed deploy rollback/forward repair, service restart/redeploy, Neon reconnect, Restate restart/recovery, and Runtime Gateway reconnect where applicable.
10. Run the existing M9 security, recovery, and performance tooling against the actual staging candidate and record measured evidence.

A database migration failure blocks rollout. Never hide a broken revision behind a green process health check. Applied schema changes are repaired forward unless a reviewed restore operation is explicitly required.

For M9 staging certification, verify the retained `m9/certification/` result with `get` and `head`,
match its digest to the terminal execution/command state, and replay the same accepted command to
confirm that no second logical artifact is created. Do not report this as managed Pi certification.

Run the repository-owned live certification harness only against the isolated Railway/Neon/R2
staging profile:

```sh
bun run certify:m9-cloud
```

The operator supplies `M9_CONTROL_API_URL`, `M9_SERVICE_AUTH_ISSUER`,
`M9_SERVICE_AUTH_KEY_ID`, `M9_SERVICE_AUTH_PRIVATE_KEY_FILE`, `DATABASE_URL`, `R2_ENDPOINT`,
`R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` through the local secret boundary. The
private signing key is a short-lived staging-certification credential whose matching public key is
configured in the staging Control API trust set; it is never committed or printed. `DATABASE_URL`
uses the least-privilege staging application role because the harness seeds one immutable bounded
certification plan through the same repository used by the service. The harness does not accept a
migration/admin connection.

A passing JSON record proves all of the following for one run: authenticated public acceptance,
terminal command/execution/attempt state in Neon, an integrity-matched retained result through the
R2 `ObjectStore`, and idempotent replay returning the original execution and artifact. The record
contains identifiers, timestamps, state, and digests only. Keep deployment IDs, exact source commit,
Railway build/readiness results, Restate registration/restart evidence, resource metrics, and the
sanitized harness record together in the M9.6 evidence attachment. The harness is not by itself
proof of rollback, restart recovery, load, isolation, secret-canary, or cost acceptance.

## Neon operations

- Use the dedicated Control Plane Neon project/database, never Adea's database.
- Application services receive least-privilege runtime authority only where needed.
- Migration/admin authority is one-shot/operator scoped and not available to ordinary service replicas.
- Validate schema version before accepting traffic.
- On database saturation, stop nonessential producers and inspect query/pool/backlog evidence before increasing retry pressure.
- On corruption or accidental deletion, freeze writes where practical, restore into an isolated destination using Neon recovery/PITR or equivalent provider capability, verify schema/integrity/reconciliation, then switch through an explicit change process.
- The existing `neon_auth` schema in the Control Plane Neon project is not application identity authority and must remain unused unless an explicit architecture decision changes ownership.

## R2 operations

- R2 buckets remain private and are accessed only through the provider-neutral ObjectStore/Artifact boundary.
- Bucket/environment separation, retention/lifecycle, least-privilege credentials, and upload/download policy are defined in M9.9.
- Failed or ambiguous object operations reconcile against authoritative metadata/digests rather than assuming success.
- Local/Hosted data is not automatically promoted to R2; cloud storage requires an explicit authorized operation.

## Restate operations

- Restate is the only required durable workflow runtime for the accepted release path.
- Railway staging runs the immutable Restate image recorded in `infrastructure/railway/restate.json`,
  with a persistent `/restate-data` volume and stable node name. Never replace it with a floating
  image tag or an ephemeral filesystem deployment.
- Keep ingress, Admin API, and fabric ports private. Register `workflow-worker` through its Railway
  private-network endpoint and verify that the registration survives a Restate service restart.
- Treat the volume-backed Restate node as a singleton during replacement: remove its active Railway
  deployment and verify zero active revisions before starting the replacement. Two Restate
  processes must never contend for the same RocksDB volume during a health-checked rollout.
- M9.8 replaced active Temporal cloud configuration with Restate and defined its Railway networking, persistence, health/readiness, restart, upgrade, and observability behavior.
- On Restate degradation, stop unsafe new admission where required, preserve durable command/domain state, and recover using the accepted Restate lifecycle guarantees.
- LangGraph graph/checkpoint mechanics remain subordinate to the Restate lifecycle; ProjectState remains separately authoritative.
- Temporal-specific worker/runbook evidence is historical migration provenance and is not part of the active path.

## Gateway and provider degradation

- Distinguish transport failure, provider refusal, policy denial, approval wait, budget exhaustion, and persistence/workflow failure in telemetry.
- Runtime Gateway is used only for non-co-located RuntimeNodes. Local co-located execution uses direct RuntimeTransport and must not fall back to Runtime Gateway as an implicit recovery path.
- On gateway disconnect, replay only durably identified commands and reconcile ambiguous outcomes before retry.
- On model/tool/sandbox/ContextProvider degradation, follow the pinned policy and approved fallback behavior; optional providers must not become undeclared startup dependencies.

## Local operations — M10

Local uses all-in-one Control Plane + SQLite + single-node Restate + filesystem storage + direct RuntimeTransport.

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

## Hosted operations — M10

Hosted `simple` uses SQLite; `server` uses PostgreSQL. Both use Restate and user-controlled storage/secrets.

Required operational evidence includes:

- one documented Compose deployment path;
- persistent volumes across container/host restart;
- TLS/reverse-proxy and authenticated external API/relay configuration;
- backup/restore;
- update/rollback/forward repair;
- key/credential rotation/revocation;
- resource budgets for small VPS and server profiles;
- no dependency on Railway/Neon/R2/Adea Cloud for standalone operation.

## Diagnostic correlation

Investigations begin with stable product/execution identifiers, not provider-specific resource IDs. Minimum useful correlation includes request, workspace, execution, attempt, workflow/Restate invocation, runtime/node/transport, profile/Skill versions, provider/tool/model policy versions, and trace identifiers.

Provider-specific Railway/Neon/R2/Restate identifiers may appear in operational diagnostics but do not replace stable Control Plane IDs and must not leak secrets or protected content.

## Security incidents

- Policy denial is authoritative and cannot be overridden by prompt/model/tool/provider content.
- On credential leakage, revoke/rotate first, then clean history/logs and record sanitized evidence.
- On suspected cross-workspace access, disable affected routes/credentials, preserve sanitized correlation evidence, run the isolation matrix, and block promotion until fixed.
- Remote relay/gateway incidents must preserve HPKE/content-redaction guarantees; cloud/relay systems must not require plaintext sensitive execution content.
- Remote control is disabled unless an outbound `RemoteControlHostAdapter` is supplied to the Local or Hosted composition. Provision its dedicated X25519 private key through the profile's `SecretsProvider`; never place it in a database, Artifact, Compose file, or relay configuration. Follow [`remote-control-relay.md`](remote-control-relay.md) for rotation, revocation, redelivery, and reconciliation behavior.

## Scheduled evidence

- **Every managed-cloud candidate:** build/deploy, Neon migration/schema, Restate, R2, health/readiness, recovery, security, and cost evidence.
- **Every M10 candidate:** Local and Hosted clean install/start/restart/backup/restore/conformance evidence.
- **M11:** independent full-profile audit from frozen candidate.
- **M12:** live cross-product integration evidence only after M11 approval.
