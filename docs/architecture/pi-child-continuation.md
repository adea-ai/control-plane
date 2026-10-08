# Existing-child continuation

The optional Node host continuation port retains an immutable server-only grant
after a governed child has an actual runtime handle and before native Pi receives
the successful child outcome. The canonical SQLite writer validates the original
parent and child attempts, complete plan ancestry and contexts, full admitted
request and native source tuple, succeeded tool receipt, current approval,
provider selection, allocation and fixed expiry. First retention requires an
active parent. A competing parent completion writer cannot interleave with that
transaction.

The grant pins the existing child session and admission. It cannot create a new
child, reserve another budget, renew an expiry, select another provider or repair
an absent grant after a crash. Fresh child admission retains J1's active-parent
guard. Only the original parent's completed state is eligible for continuation;
cancelled, failed, superseded or revoked authority fails closed.

`createPiChildContinuationAuthority` rechecks canonical lineage and current
original actor, scope, approval, provider and independently recorded spending
authority around asynchronous boundaries. A host must use the same current
reader in its credential and spending facade. The existing journal owner fence
still serializes recovery before native inference. A continuation grant supplies
no proof that an uncertain physical send can be repeated: existing ledger and
native checkpoint reconciliation remain mandatory.

Publication uses an independent current audience port. A previously committed
result can remain retained while delivery to a changed audience is denied.
Historical succeeded source evidence is not a new tool-execution grant.

The production ports are opt-in and fail closed when absent. Focused tests use
synthetic current-account and spending readers with real lifecycle and SQLite
stores. The reusable process worker is a test fixture; initial governed execution
uses Bun and child-only recovery targets Node 24.21.0 with Pi 1.1.0. Its scripted
loopback provider is not live-provider or device-authorization qualification.
Actual unfinished-child process, concurrent recovery and ambiguous-send evidence
belong to the separate J1 proof harness. No deployment or production activation
is implied by this package.

Refs #930, #932, #933.
