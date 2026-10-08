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

The first engine profile returns committed output snapshots. Native tools,
compaction, deferred requests, retries, redirects and positive cache writes are
disabled. The separately exported effect gate is a host integration with the
existing policy-controlled tool service; it does not register native tools.

Run `bun test src --timeout 30000` from this package. Process fixtures use Node
from `CONTROL_PLANE_TEST_NODE` when specified, otherwise `node` on PATH. Tests
include real Node termination and SQLite reopen, deterministic provider faults,
canonical spending records and persistent approval/effect recovery. They do not
verify a live provider account.

See [runtime ownership and qualification](../../docs/pi-durable-runtime.md).
