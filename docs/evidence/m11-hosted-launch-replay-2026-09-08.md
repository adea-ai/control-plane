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
