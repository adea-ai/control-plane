# M11 Local graph launcher — 2026-10-02

This checkpoint closes the Local `start()` launcher gap for one operator-configured JSON graph tool.
It does not close #188, #187, #190, or establish full M11 acceptance.

## Reachable behavior

`CONTROL_PLANE_LOCAL_GRAPH_CONFIG` configures one server-owned tool definition, immutable version,
operation binding, and USD tariff. Startup validates the bounded operator file, checks any existing
SQLite config pin, verifies or publishes the exact registry entries, then atomically records the
config digest before readiness. A failed registry bootstrap does not pin a digest, so the operator
can correct a conflicting ID and retry against the same data directory. A losing concurrent startup
with changed config cannot become ready.

The acceptance test invokes the exported `start()` function and reaches the real Local HTTP routes
for graph publication, execution-plan validation and acceptance, and persisted interaction
response. It confirms that pending approval does not write an object, reconstructs the composition
from the same SQLite directory, resumes only after the authorized persisted response, and completes
the command with one immutable Artifact. The test checks exact canonical bytes, SHA-256, Artifact
reference, workspace/project/execution metadata, one durable tool call, one settled tariff charge,
and idempotent acceptance replay after another restart. It also covers fail-closed incomplete,
conflicting, and runtime-less configuration, changed configuration after pinning, and registry
bootstrap repair.

The graph uses a test-local `direct-local` transport fixture because this case executes a graph tool
node and no model/runtime node. The Local plan compiler, catalog, admission APIs, tool registry,
approval path, ObjectStore, SQLite workflow, and launcher are production code. This is not Pi or ACP
provider certification, native tool acceptance, or the complete deployed profile matrix.

## Verification

Focused launcher regression: `bun test ./src/launcher-graph.test.mjs` — 5 passed, 0 failed, 37
expectations. The bootstrap-repair case failed when the config digest was pinned before registry
bootstrap and passed after pinning moved after successful registry verification.

Local package suite: `bun test ./src/*.test.mjs` — 138 passed, 0 failed, 712 expectations across 21
files. `bun run build` and `bun run lint` passed from `apps/local-control-plane`; `bun run
format:check` passed for the repository (1,255 files). The focused Oxfmt check for the 12 changed
source and documentation files also passed. `bun run architecture:check` passed with 42 packages,
20 operations, and 4 profiles; the checked audit updates only the Local and hosted-simple composition
source digests.

Separate base-branch evidence in [PR #845](https://github.com/adea-ai/control-plane/pull/845),
reviewed head `85a9225`, covers PostgreSQL RED/GREEN with 6 tests and 70 assertions, followed by
`bun run test:recovery-matrix` with 22 named scenarios, 168 database tests, and 40 workspace tasks.
That recovery evidence is supplemental and is not part of this launcher test.

### CI timing follow-up — 2026-10-03

The first [PR #851 unit run](https://github.com/adea-ai/control-plane/actions/runs/37084018825/job/111090587555)
failed three tests with seed `1104`. Two durable graph happy paths used a one-second
tool budget around real filesystem writes; their ToolCalls reported `TIMEOUT` and
correctly held the outcome for reconciliation. A bounded reproduction delayed a
committed write receipt by 1.5 seconds and reproduced that classification. The
durable-effect fixture now uses the supported launcher's 30-second tool budget;
the same delayed write returns its verified Artifact. Dedicated timeout-policy
tests retain their short intentional deadlines.

The embedded deadline test used a 750-millisecond wall-clock deadline and a
500-millisecond lease, making its intended in-flight cancellation depend on host
timing. Deadline checks now use the same injected runtime clock as queue and lease
operations; the default remains the current wall-clock time. The test advances
that clock only after observing dispatch and keeps the lease valid throughout.
The injected-clock regression failed before the runtime change and passed after
it. The two affected files passed 38 tests and 141 expectations with seed `1104`.

The integrated `bun run test` then passed 2,101 unit tests, 185 E2E tests, and
246 smoke tests with zero failures. Two PostgreSQL smoke cases were explicitly
skipped because that command did not supply a PostgreSQL integration environment.
Unit coverage was 85.51% lines and 78.47% functions. This rerun is repository
regression evidence, not deployed or full-milestone acceptance.

## Limits

The launcher does not migrate prior `tool-effects` records or rewrite an already published version
schema. Accepted old pins and unknown effects using the prior key convention require verified
reconciliation before replay. The acceptance starts with a fresh data directory and does not certify
upgrades of existing installations. Other tools, MCP, model/runtime and delegation bindings,
provider-backed execution, deployed-profile acceptance, and human/operator reconciliation remain
separate gates.
