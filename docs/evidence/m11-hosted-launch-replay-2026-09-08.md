# M11 hosted admitted-launch replay

Two focused regressions reproduced failures before this change: rebuilding the
client after advancing its clock changed the launch deadline and caused
`HOSTED_PI_IDEMPOTENCY_CONFLICT`; retrying an admitted launch at full host capacity
caused `HOSTED_PI_CAPACITY_UNAVAILABLE`.

`RuntimeHostProvider.getLaunch` now exposes the original admitted request and
handle. `HostedManagedPiClient` validates the incoming command and this receipt,
compares attempt identity and canonical configuration, and returns the original
handle before new-admission health/capacity checks or authority resolution. This
read does not launch work, renew authority, or change the original deadline.
Changed attempt/configuration still conflicts; a new key still faces capacity
checks. Callers remain responsible for authentication and scope authorization.

The reference provider retains and returns cloned receipts. The focused suite
passes 11 tests / 42 assertions, including both original failures, changed-command
conflicts, and new-admission rejection at capacity.

This is an internal host-provider contract change, not a new public API. Any new
production provider must persist receipts across host restarts and atomically
coordinate receipt creation with native launch admission. The reference provider
is in-memory; these tests prove client reconstruction against a retained host,
not host-process recovery, concurrent first admission, native sandbox behavior,
or full M11.3 acceptance. Those gates remain open.

## Concurrent reference admission follow-up

Eight simultaneous identical first-launch retries initially recorded eight
launches. The reference provider now reserves one in-flight admission per key
before awaiting execution creation. Matching requests await the same result;
conflicting request fingerprints fail closed. Receipt reads wait for in-flight
admission rather than reporting it absent. Rejected admissions remain fenced:
neither a subsequent launch nor a receipt lookup restarts uncertain allocation.

The focused suite passes 13 tests / 51 assertions. Fault injection throws during
Artifact persistence: eight callers share one persistence attempt, later retries
retain the error, and changed launch identity conflicts. These are in-process
reference-provider tests, not a durable native admission proof. In-flight launch
requests still require identical fingerprints, including derived deadlines;
simultaneous client calls with different clocks may conflict rather than replay.
Production admission must resolve that distinction with an atomic, persisted
first-admission identity and deadline, and provide explicit reconciliation for
uncertain allocation. The in-memory failure fence is not a restart guarantee.
