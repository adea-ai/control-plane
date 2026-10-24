# Profile adapters

This package binds an explicitly selected product execution profile to the
existing deployment, workflow, runtime, and placement ports. It is a
server-side composition helper. It does not create credentials, grants, runtime
routes, or residency authority.

## Profile mapping

The product profile names are intentionally distinct from the canonical
`DeploymentProfile` values:

| Product profile | Canonical deployment profile | Source-backed storage and wake path     |
| --------------- | ---------------------------- | --------------------------------------- |
| `local`         | `local`                      | SQLite with the embedded workflow queue |
| `self-hosted`   | `hosted-simple`              | SQLite with Restate                     |
| `self-hosted`   | `hosted-server`              | PostgreSQL with Restate                 |
| `hosted`        | `cloud`                      | PostgreSQL with Restate                 |

The exact display labels map to the lowercase product names as follows:
`Local` to `local`, `Self-hosted` to `self-hosted`, and `Hosted` to `hosted`.
Other capitalization and aliases are rejected. In particular, a self-hosted
deployment must already identify either `hosted-simple` or `hosted-server`; if
that canonical variant is missing or unsupported, binding is unavailable rather
than guessed. `DeploymentComposition` proves only that the already configured
storage and workflow ports match that canonical deployment profile.

The source-level matrix is not a live certification. Runtime support is
conditional for Local, Self-hosted, and Hosted: Hosted binds only a healthy
managed-cloud adapter over the authenticated remote-gateway transport,
together with the trusted topology, current authority, and residency guards.
The Node Pi Durable adapter's `CLOUD_PROFILE_UNQUALIFIED` denial and its
direct-local identity fail closed, and the unregistered Cloudflare host
advertises no capabilities, so neither can be presented as a hosted runtime.
No fact here is evidence about every possible hosted topology, and there is
no implicit fallback from Hosted to a local or self-hosted runtime.

## Runtime binding and authority

`bindProfileRuntime` takes a server-selected `RuntimeAdapter`, its concrete
`RuntimeTransport`, and server-owned placement as separate inputs. The expected
transport is derived from the profile and trusted placement. A required
`CurrentProfileRuntimeTopologyGuard` must compare the exact adapter and
transport instances with the server's configured topology before inspection
and again at runtime boundaries. The `RuntimeAdapterWithTransport.transportKind`
property and inspection metadata are checked for consistency only; neither is
used as an execution route. Runtime calls continue through the semantic adapter
that the trusted topology approved.

Current actor authority and data residency are separate required server-side
guards. Authority must be bound to the authenticated original actor and
re-read current audience, grants, expiry, and exact plan/scope before effects.
The guard also binds the exact attempt and full retained handle tuple on
runtime operations.
The guard must derive canonical workspace scope from retained server records
and cross-check any workspace identifier present in a request; the adapter
binding does not make request fields authoritative.
Residency must recheck the configured host and data-placement policy. Both
guards run before and after runtime operations; progress is rechecked before
each emitted event and preserves the runtime's sequence and timestamp. The
package's guard contexts contain identifiers and plan pins only. Runtime and
wake instances are passed ephemerally to topology guards and must not be
logged, serialized, or persisted.

Capability declarations are support metadata, not authorization. The package
recomputes eligibility from the inspected capabilities for requested features
and from the immutable plan requirements before `start`. An absent required
capability fails closed. The package does not add capabilities or infer
eligibility from method presence.

`bindRetainedProfileWorkflowWake` is the production submit boundary. It accepts
only the dispatcher for the exact canonical profile (`embedded-sqlite-queue`
for Local, `restate-ingress` otherwise), resolves the command, execution, and
any latest attempt from server repositories, cross-checks the plan, scope,
graph payload and workspace against the stored plan and the retained deadline,
and admits only accepted or reconciliation-required executions with zero
attempts. Existing attempts fail closed. A historical execution without a
retained deadline fails closed; the binder does not infer an unbounded deadline
from missing legacy data. It re-reads command and execution generations after
current authority/residency checks and immediately before submit. The same
retained admission snapshot is passed to all pre-submit and post-submit
`workflow.wake` authority and residency callbacks. The post-submit callback
receives the admission snapshot, not a claim that the execution still has zero
attempts after dispatch. Its server-owned topology guard verifies the exact
dispatcher instance; profile and wake-kind labels alone are not proof. The
command's `callerPrincipalId` is retained for service admission and is not
treated as the original product actor. Composition must supply guards that
independently bind that actor to current grants and trusted residency. Hosted
Server has opt-in wiring for caller-supplied placement and current guards, but
it does not construct an original-actor/current-grant source, authoritative
host/residency source, or independently re-read topology source. The Hosted
path therefore remains unqualified. This
generation check does not make separate stores and dispatcher effects atomic,
and it does not prove active-attempt crash replay.

`bindProfileWorkflowWake` remains a lower-level adapter-binding primitive for
compositions whose server-side authority and residency checks are already
bound. It does not resolve retained records itself and is not sufficient as a
production submit path.

## Source basis

The mapping follows the current sources in `packages/deployment`,
`packages/sqlite-persistence`, `apps/local-control-plane`,
`apps/hosted-control-plane`, `apps/workflow-worker`, and
`packages/workflow-runtime`. Runtime behavior follows `packages/runtime-sdk`
and the internal adapters in `packages/pi-cloudflare-host` and
`packages/pi-durable-adapter`; the hosted composition mirrors the canonical
`ManagedPiAdapter` over `RemoteRuntimeGatewayTransport` path exercised by
`apps/runtime-worker/src/hosted-managed-pi.test.mjs`. This documents those
source boundaries and the tested qualification gate; it does not claim a live
production certification or that the separate profile-specific adapter map
requested by issue #941 has been accepted.

## Recovery boundary evidence

`tests/profile-recovery-rebind-fencing.test.mjs` exercises synthetic profile
bindings across a rollback fence: operations from the old owner fail before
upstream calls, a newly bound owner resumes the retained handle, and the
managed-Pi fixture does not resend its physical start. This is adapter-binding
evidence only. It does not prove process-level durability, self-hosted-server
wake/replay, storage restore through every profile composition, or live
production rollback; those recovery gaps are tracked in
`docs/profile-recovery-acceptance-map.md`.
