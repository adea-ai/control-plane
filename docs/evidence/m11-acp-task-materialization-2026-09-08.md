# Local ACP task materialization

M11.3 (#188) remains open. Inspection found that the generic ACP driver built a
prompt from the plan ID, attempt ID, digest and optional ContextPackage ID, but
did not resolve task content. Exposing that factory as a complete standalone
launcher would not prove that the harness received the requested work.

The driver now accepts a read-only, abort-aware task resolver before creating a
native session. It bounds resolution by the request deadline, rejects empty or
greater-than-256-KiB UTF-8 prompts, normalizes resolver failures and prevents a
late resolver completion from creating a session. Existing successful-start
idempotency continues to return the admitted handle without another prompt.

The concrete Local factory requires this resolver. The repository-backed helper
checks plan and ContextPackage integrity, exact content/schema/compiler pins and
workspace/project scope before rendering objective, context, success criteria and
output contract. It does not replace native harness instructions or grant tools,
file access or credential authority. Generic reference-driver compatibility does
not establish concrete Local readiness.

Tests cover resolution failure, timeout/late completion, oversized input,
duplicate starts, missing/corrupted content and pre-aborted lookup. A real child
JSON-RPC fixture checks that the objective reaches `session/prompt` and returns
a terminal response. The Local durable-lifecycle test resolves from the actual
SQLite ContextPackage repository before the same native-wire execution. Fixture
usage counters are synthetic, not provider billing evidence.

Validation passed format, lint, types, 41 builds, 1,243 unit/E2E/smoke tests,
31 PostgreSQL tests, all integration packages and local connection-loss,
restart and backup/restore drills. The earlier failed run is qualified below.

Separate open gates include profile/Skill instruction materialization, verified
native model-route policy, supported launcher selection, native aggregate usage,
in-flight restart recovery, Linux sandbox hosting and cloud composition.

The first full validation run also exposed an independent checkpoint-copy race:
`control-plane.sqlite-shm` disappeared between inventory and copy in the graph
checkpoint/restore test. The targeted two-mode rerun and subsequent full suite
passed without a checkpoint change. This is retained as an unresolved intermittent
backup/recovery observation under M11.9 (#194), not claimed fixed by ACP work.
