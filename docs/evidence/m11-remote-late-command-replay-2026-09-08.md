# M11 remote command replay after an attempt deadline

Scope: remote execution and interaction recovery under M11.3/M11.9. This does
not certify native Cloud execution, production deployment, or retention cleanup.

Previously `DurableRemoteWorkflowRuntime` constructed a fresh execute or
interaction envelope before reaching the runtime command repository. The
managed-Pi factory used the current time, so a retry after the attempt deadline
threw `REMOTE_RUNTIME_COMMAND_EXPIRED` before it could recover an existing
command. Grant, deny, and input regression tests reproduced this failure.

The factory now exposes its deterministic command ID, and the runtime reads the
first persisted issuance timestamp before constructing a replay candidate.
This timestamp is internal repository data, not a public caller-controlled
lease. The usual context, response, route, and complete-envelope comparisons
remain in place. Enqueue returns the original stored record, with its original
expiry and delivery state; it does not renew or requeue an expired command.
Factories without deterministic lookup retain their previous behavior.

Tests advance the clock beyond the attempt deadline for execute, grant, deny,
and input. Existing keys converge to the original record; new keys fail expiry
validation. Eight concurrent late interaction retries preserve the first record,
and stale response IDs still fail before waiting. Existing command-conflict,
scope, cancellation, and lease-replay regressions also pass: 23 focused tests,
121 assertions across the factory and durable-runtime suites.

These tests use the in-memory command repository and a controlled outcome
waiter. They prove candidate construction and immutable replay, not a late
native runtime effect or remote provider settlement. Live all-profile recovery
and independent acceptance remain outstanding.

Workspace validation passes: lint, type-check, format check, 984 unit tests,
104 E2E tests, and 67 smoke tests. The full integration command also passes,
including 27 PostgreSQL tests, remote delivery, and outage/restart/restore
drills. Those integration lanes retain their existing scripted-node limits;
the new post-deadline assertions are in the focused suites described above.
