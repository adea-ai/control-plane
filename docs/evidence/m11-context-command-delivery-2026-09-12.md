# Authenticated context command delivery boundary

This service builds on the separate context-command ledger from #474. It does not
fabricate an execution, attempt, or RuntimeConnection for a context read.

Commands are persisted before sending. Send failure leaves a dispatched record for
bounded reconnect enumeration; delivery requires a composition-owned sequence
allocator and rechecks active channel ownership after the durable update. Expired
commands become terminal without being sent. New grants longer than 24 hours are
rejected.

ACKs, results, and errors bind node, workspace, active channel ownership, generation,
and semantic payload digest to the persisted command. ACKs also match its last
delivery sequence. Successful results require the configured result store to return
a validated Artifact ID before terminal CAS. Result-store failures and a channel
replacement during storage cannot settle the command. A stable completion digest
detects altered terminal replays; classified errors do not retain raw provider
diagnostics. Terminal records cannot be reopened.

The gateway message router classifies context frames using the durable ledger in
the authenticated source's workspace. Context frames do not enter runtime-execution
event normalization. Unknown context commands retain the existing runtime route;
unsupported context progress frames fail closed. No caller-selected family field
is added to ACK/result contracts.

Focused tests exercise failed sends, stale channels/sequences, cross-workspace
frames, ACK/result replay, changed terminal content, failed Artifact persistence,
replacement during persistence/lookup, bounded results, and overlong grants. An
actual SQLite test closes and reopens the database before reconnect dispatch and
again before terminal replay, proving that the delivery state and completion digest
survive reconstruction without another result-store call.

The late-positive-ACK regression first failed with `CONTEXT_COMMAND_ACK_CONFLICT`;
it now returns the unchanged terminal record. Sixteen focused domain/delivery tests
passed with 101 assertions. Full repository tests passed 1,320 tests (1,113 unit,
127 E2E, 80 smoke), with type-check and subsequent lint/boundary/format validation
passing. SQLite is an explicit test-only dependency of the gateway package; Bun's
lockfile refresh also updates existing workspace version metadata, without adding
external packages. Post-rebase validation is recorded separately in the PR.

No SQL migration is needed for the optional completion digest in the stored JSON.
Older strict record readers cannot read that new field: deploy compatible readers
before enabling this delivery writer. No deployed composition uses this writer yet.
Rollback should stop its activation and preserve command history, not remove replay
digests from terminal records.

## Remaining acceptance

The result-store port still needs its production implementation, including Artifact
scope/content verification and idempotent storage by command and digest. Production
composition must provide the authenticated lifecycle sender, authoritative node
coordination, and durable sequence allocation. RuntimeNode context-driver execution
and node-side deduplication are not implemented here. Full socket transport,
revocation/reconnect races, multi-profile replay, and provider authoring integration
remain required. These service/SQLite tests do not prove exactly-once external
reads or complete M11.
