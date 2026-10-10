# Pi Durable adapter

An opt-in `RuntimeAdapter` for a Node 24.21 remote host with SQLite, pinned to
`@earendil-works/pi-durable`, `pi-ai` and `chord` **1.1.0**. This package does not
replace the managed Pi subprocess, direct sessions, Restate or LangGraph.

Use `createNodePiDurableRuntime` for runtime composition or
`createNodePiDurableLeadComposition` from Control API for canonical lead admission
and persistent HTTP receipts. The host must supply current product authority,
immutable compiled plans, budget-enabled command acceptance, current provider
eligibility, authenticated recorded spending decisions and recovery policy.
There are no default credentials, grants or funding approvals.

Explicit version2 plans require the host's `CurrentExecutionScopeAuthority` and
the original canonical product actor. Workspace capability is advertised only
when this port is configured. It rechecks the exact plan, scope, actor, current
grant and audience before execution, resume and inference; legacy project plan
serialization stays unchanged.

`createPiDurableProviderResolver` consumes an immutable gateway selection and
reconstructs a fresh Models registry inside the gateway's `withCredential`
callback. The concrete provider binding is OpenAI Responses with an API key.
It has no ambient auth, OAuth, provider/account fallback or retained registry.
The callback encompasses inference and disposal; only normalized results leave
the callback. Other provider bindings need their own qualification.

`createPiRecordedSpendingAuthority` reuses the model gateway's recorded
spending schema, existing immutable attempt allocation and pinned price. Use its
ports with `createPiDurableUsageAuthority`, which reserves through the existing
ledger's physical-dispatch fence and settles authoritative usage. Accepted plan
allowance and selection readiness do not authorize spending. Uncertain sends
remain held; replay never silently issues another paid request.
Committed native generation receipts settle before another generation reserves
its full context or a governed child executes. A later generation failure keeps
its uncertain hold while preserving the earlier committed usage.

The engine returns committed output snapshots. Compaction, deferred requests,
retries, redirects and positive cache writes are disabled. The optional native
`delegate_child` tool requires a verified retained source, the existing full
policy/approval effect gate, independently admitted child authority and a retained
inbox scanner. It accepts only a bounded objective. Other native tools remain
unavailable.

Funding preparation is opt-in in the Control API composition. It displays the
immutable recorded payer before explicit dispatch, and never starts inference.
Both provider and spending ports must share the canonical host's confirmed
execution facade. Unused preparation allocations are recovered after restart;
ambiguous physical sends keep their ledger holds. Intent-only receipt lookup
repairs lost dispatch acknowledgements without starting another model call.
The Node preparation store runs in the main thread. A retained process claim
fences cleanup while dispatch awaits admission. Recovery requires an inactive
owner, a metadata-only runtime journal lookup and the canonical allocation's
no-send checks. An actual journal handle prevents unused-allocation release;
unknown owners, lookup failures and ambiguous sends remain fenced.

Run `bun test src --timeout 30000` from this package. Process fixtures use Node
from `CONTROL_PLANE_TEST_NODE` when specified, otherwise `node` on PATH. Tests
include real Node termination and SQLite reopen, deterministic provider faults,
canonical spending records and persistent approval/effect recovery. They do not
verify a live provider account.

See [runtime ownership and qualification](../../docs/pi-durable-runtime.md).
