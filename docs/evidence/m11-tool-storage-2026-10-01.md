# M11 tool storage and graph assembly checkpoint — 2026-10-01

Source candidate: `6c922d487c3c2e70a047c11c55a1cb4ddbabad26` on `main`.
The workspace manifest reads 1.62.0, but this candidate includes PostgreSQL
storage merged after the 1.62.0 release at `566eb56b`. The release tag and this
source checkpoint identify different trees.

[The machine-readable record](./m11-tool-storage-2026-10-01.v1.json) contains source
file hashes and local results. [The PostgreSQL receipt](./m11-tool-storage-postgres-2026-10-01.txt)
preserves the six case names and aggregate output from the final isolated run.
Production source, tests and lockfile are unchanged from validation head
`319f12575f1447f29363a7a481d6ba0030db0b26`; the difference is generated release
version/changelog metadata. This is an implementation checkpoint for issues
[187](https://github.com/adea-ai/control-plane/issues/187),
[188](https://github.com/adea-ai/control-plane/issues/188) and
[194](https://github.com/adea-ai/control-plane/issues/194).

## Implemented paths and evidence limits

| Path                                   | Current evidence                                                                                                                                                                                                                                                                               | Remaining acceptance                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| SQLite tool registry and calls         | Workspace-bound immutable definitions/versions; semantic-version uniqueness; atomic call/idempotency rows; revision CAS; corrupt-index rejection; cold reopen and concurrent connections. Merged in [811](https://github.com/adea-ai/control-plane/pull/811).                                  | Application bindings, provider effects and deployed Local/Simple scenarios.                               |
| PostgreSQL tool registry and calls     | Migration 0057, workspace-scoped keys and foreign key, uniqueness fences, CAS, bigint revision parity, malformed-row rejection, independent clients and cold replay. Final real PostgreSQL run: six passes, 70 assertions. Merged in [814](https://github.com/adea-ai/control-plane/pull/814). | Production role grants/composition, Neon or fresh-VPS execution, outage recovery and retention.           |
| Configured Local/Simple graph assembly | Public execution validation and acceptance share the graph catalog/compiler; execution uses SQLite checkpoints and the durable event queue. Tests execute and cold-continue with a fixture operation port. Merged in [812](https://github.com/adea-ai/control-plane/pull/812).                 | Actual tool/model/runtime/delegation operations, Cloud/Server assembly and deployed scenario equivalence. |

Tool receipts already distinguish an in-progress effect from a completed or
ambiguous effect. Cold replay does not automatically reissue an executing or
unknown-outcome effect. The PostgreSQL service-boundary test uses
`FakeToolExecutor` and a fixture policy authorizer; it proves repository/service
receipt behavior. It provides no live provider or policy deployment evidence.

The PostgreSQL fixture runs PostgreSQL 18.3 with separate synthetic application,
migration and administration roles. Its harness explicitly grants application
access after migration. Those fixture grants do not establish production Neon
privileges. The owned container was removed and its port closed after the run.

## Validation

The source candidate passed 42 builds and the canonical unit group:
2,033 passes, 8,900 assertions, 81.03% line and 83.71% function coverage against
the unchanged 80% gate. E2E passed 185 tests and 1,089 assertions. Final smoke
passed 241 tests and 2,560 assertions; two PostgreSQL portability cases were
skipped in that credential-free group. The separate focused PostgreSQL suite
ran all six tool-storage cases.

The first smoke run failed only the exact integration inventory assertion: the
runner automatically found the new PostgreSQL tool test, while the expected
list lacked its path. Adding that path produced a passing focused inventory
check and the final green smoke group. The failing receipt is retained in the
task evidence; no assertion, timeout, coverage gate or lane budget was changed.

Frozen install, format, lint, type-check, OpenAPI, Drizzle migration/schema,
runtime compatibility, requirement and architecture checks passed. The
credential scan covered 1,406 repository files; the dependency audit checked
311 packages with zero findings. Independent Standards and Spec reviews
cleared the storage implementation, revision-width repair and inventory update.
All five required CI gates passed on the exact #814 head before its guarded
squash merge.

From an isolated checkout of the source candidate with Bun 1.4.2 and Node
24.21.0, the canonical commands are:

```sh
bun install --frozen-lockfile
bun run build
bun run test:group:unit
bun run test:group:e2e
bun run test:group:smoke
bun run format:check
bun run lint
bun run type-check
bun run security:scan
bun audit --audit-level=moderate
```

The focused database command is
`RUN_DATABASE_INTEGRATION=true bun --cwd=packages/database test src/tool-repositories.integration.test.mjs`.
It requires isolated fixture application, migration and administration URLs
through `DATABASE_URL`, `DATABASE_MIGRATION_URL` and `DATABASE_ADMIN_URL`.
The broader `bun run test:integration` owns PostgreSQL startup/disruption/restore
when it starts the local fixture; its operational scope is larger than this
six-case receipt.

## Remaining M11 gates

A complete first Local graph-to-tool path needs exact immutable tool-version
pins checked against the accepted plan's logical grants, a concrete executor,
approval suspension/resumption, trusted per-effect pricing or cost receipts,
reservation/charge/settlement, cancellation and ambiguous-outcome reconciliation.
The operation port alone does not provide those behaviors. Model, runtime and
delegation operations and every supported composition must then use the same
accepted-plan authority.

All original issue 188 scenarios remain required: frozen Railway/Neon/R2/Restate
execution, clean Local with real managed Pi and supported ACP, fresh-host Compose
Simple and PostgreSQL Server equivalence, provider variants, consumers, restart
and fault convergence, and M10 deployment/migration conformance. Reliability,
retention and measured backup/restore/RPO/RTO evidence under issue 194,
security and adversarial evaluation, documentation/Skill review and the
independent final audit remain outstanding. No deployed or whole-milestone
acceptance is established by these repository and fixture results.
