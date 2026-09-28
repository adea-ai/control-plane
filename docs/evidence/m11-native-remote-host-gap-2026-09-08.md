# M11 native remote host acceptance gap

## Current topology clarification — 2026-09-27

The startup observations below are historical facts about the optional separated
Hosted worker, **not a missing Railway Cloud service**. The accepted Cloud topology
is Control API + Workflow Worker + Restate; it explicitly excludes the former
Runtime Worker/Gateway/Tool Gateway process split. Do not repair Cloud activation by
enabling the bare `runtime-worker` entrypoint or substituting its reference provider.

The supported Cloud `remote` selection queues commands through
`createManagedCloudWorkflowWorkerComposition`, `DurableRemoteWorkflowRuntime` and
`ManagedPiRemoteCommandFactory` using PostgreSQL command/outcome stores. It still
needs an independently provisioned authenticated RuntimeNode/gateway, trusted
discovery and scoped Artifact/usage delivery. Hosted server has the same remote
boundary. Gateway startup currently requires an embedding application's real
runtime ports; environment-selected stores alone do not supply a host.

The actual remaining implementation target is the operator-owned host/RuntimeNode
composition with explicit isolation, credentials/enrollment, outbound transport,
retained outcomes and scoped Artifact authority. Production stays fail-closed until
that supported deployment passes acceptance. Local already selects managed Pi or
pinned Codex ACP through its explicit configuration and direct-local transport.
See [configuration](../configuration.md) and [infrastructure](../infrastructure.md).

This clarification supersedes any older guidance treating
`apps/runtime-worker/src/start.ts` as a Cloud activation entrypoint. All original
native execution, recovery, settlement and deployment gates remain required.

Status: open; M11.3 (#188), execution-control/runtime-host ownership. Severity:
high for milestone acceptance. This is an implementation/deployment gap, not a
claim of an exploitable vulnerability or an authorization failure.

## Verified boundaries

- `apps/runtime-worker/src/start.ts` calls `start()` without a hosted worker.
- `apps/runtime-worker/src/index.ts` requires `hostedManagedPiWorker` in staging
  and production and throws `HOSTED_MANAGED_PI_WORKER_REQUIRED` when absent.
- `HostedManagedPiWorker` delegates readiness, scaling observations, and cleanup
  to an injected `RuntimeHostProvider`; it does not provision a host itself.
- The runtime-worker module defines `ReferenceRuntimeHostProvider`; the source
  search found no other implementation of that interface. Its reference
  scenarios are not evidence of actual native managed execution.
- `apps/local-control-plane/src/acp-runtime.ts` constructs a real ACP process
  transport and driver, wrapped by `DirectLocalRuntimeTransport`. The verified
  native permission/cancellation probes exercise this Local boundary.
- `scripts/run-cloud-remote-drill.mjs` uses real PostgreSQL, authenticated
  WebSocket delivery, and Artifact persistence, but its node supplies scripted
  responses. It does not start the production runtime worker or native ACP.

The focused runtime-worker startup suite passes all three tests. It verifies
staging/production refusal without a host, cleanup after readiness failure, and
draining an injected worker. Injected readiness in those tests is not a live
host-readiness claim.

## Required implementation and acceptance

1. Select the actual Linux execution host and its supported isolation mechanism.
   Provisioning must preserve the accepted sandbox and scoped project-grant
   requirements; do not label an unrestricted child process as a sandbox.
2. Implement native host launch/inspection, durable handle identity, bounded
   capacity/deadlines, input/approval/cancellation, terminal Artifact handling,
   reconciliation, and cleanup. Wire production startup from explicit validated
   configuration, not a test-only injected object or reference scenario.
3. Connect that worker through authenticated RuntimeNode command delivery with
   real runtime discovery and least-privilege credentials. Verify the concrete
   adapter-family contract: current remote factory emits managed-Pi commands;
   the Local ACP adapter is not automatically interchangeable with it.
4. Run public execution/interaction/cancellation through PostgreSQL and real
   Restate to the native host, checking original command identity, actual native
   effects, Artifact provenance, and usage settlement.
5. Repeat after lost ACKs, process/host restart, disconnect, deadline, and replay;
   preserve uncertain non-idempotent effects for reconciliation. Perform the
   fresh-Linux and managed-cloud acceptance runs before closing the gap.

The user has already authorized publishing and infrastructure work. The open
question is which Linux host/provider to target, not another permission request.
No live host was provisioned and no production service was modified by this
inspection. Local and scripted remote evidence must remain separately labelled.
