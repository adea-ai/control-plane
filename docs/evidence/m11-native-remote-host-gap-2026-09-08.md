# M11 native remote host acceptance gap

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
