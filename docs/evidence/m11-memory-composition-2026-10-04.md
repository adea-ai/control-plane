# M11 memory application composition

Status: source implementation for #188 and #194, based on main
`ef3cfb5b002f7b6304c8b33b46b22a98c5e6d59e`. Full candidate CI and PostgreSQL root tests are
pending. This does not close either issue or certify a deployed profile.

The four supported roots expose the same programmatic memory capability. Local and Hosted Simple
use their existing SQLite store; Managed Cloud and Hosted Server use their existing PostgreSQL
connection. All default to disabled. A configured provider requires separately injected effect
authority before resource allocation; read/context grants never supply it. Policy and lifecycle time
are server-owned. Fresh writes revalidate content, current principals and linked, unexpired approval.
Recovery with writes disabled uses separately authorized status only.

## Bounded source evidence

Bun 1.4.2 (`744846f84`), Node 24.21.0. Tests import the candidate's own source with temporary
workspace aliases and reuse existing external dependencies; aliases and dependency links are removed
in `finally`. These focused runs performed no install, build, server, Restate process, container or
Docker operation.
Each test process has a 20-second deadline. SQLite tests close their owned database and remove their
small temporary directory in `finally`.

At 02:20:26Z, the missing application factory produced 23 passes and 7 failures. After implementing
it, 30 tests passed. A new cross-scope application regression failed at 02:24:13Z and passed after
scope enforcement at record lookup. Root tests initially failed all eight cases because the capability
was absent. A subsequent Cloud fixture failed because its empty trusted-key list was invalid;
adding a generated Ed25519 fixture key corrected that fixture without weakening authentication.

A caller-time regression failed at 02:35:11Z: an expired approval could commit with a supplied old
timestamp. The application now uses its trusted clock and checks current approval expiry. A separate
Hosted Server start-option regression also failed because its resolver dropped the new configuration;
that option is now preserved.

At 02:35:40Z:

```sh
bun test ./packages/memory-writeback/src/index.test.mjs
```

32 passed, 0 failed, 200 assertions; native 72 ms, process 127 ms.

At 02:35:41Z:

```sh
bun test ./apps/local-control-plane/src/memory-writeback.test.mjs ./apps/control-api/src/memory-writeback.test.mjs ./apps/hosted-control-plane/src/memory-writeback.test.mjs
```

9 passed, 0 failed, 22 assertions; native 504 ms, process 560 ms.

The two SQLite root cases create real source ownership and durable approval, observe a fake provider
commit followed by timeout, close and reconstruct the root against the same database, then reconcile
through status with exactly one write and one provider record. Hosted Simple is constructed without
starting Restate. Cloud and Hosted Server unit cases use inert connection fixtures to prove disabled
behaviour and fail-before-connection validation; they do not prove PostgreSQL persistence.

The final bounded source/import check at 02:39:35Z ran the core test, three root unit files and two
PostgreSQL integration files with `RUN_DATABASE_INTEGRATION=false`: 41 passed, 13 skipped, 0 failed,
222 assertions; native 501 ms, process 558 ms. Skips are not PostgreSQL evidence. Scoped Oxfmt,
Oxlint with denied warnings, `git diff --check` and installed `code-foundry doctor` also passed.
No external dependency was added; three apps now explicitly depend on the existing workspace package.

New tests in the existing Cloud validation-replay and Hosted HTTP PostgreSQL integration files cover
approved writes, uncertain outcome and connection reopen through the actual roots. These tests are
prepared for CI and have not yet run against PostgreSQL.

Independent Spec review identified a missing status authorization on automatic ambiguity recovery.
The fresh-write path authorized `write` but could probe status after an unknown provider result without
checking the separate status grant. The regression failed at 02:42:47Z. The correction authorizes
`status` before that probe; denied or unavailable authority leaves `reconciliation_required` with no
status call. At 02:42:57Z the core suite passed 33 tests and 210 assertions in 73 ms native, 126 ms
process time. The independent Spec reviewer rechecked the correction and reported no further scoped source findings.
The independent Standards reviewer reported no actionable documented-standard or heuristic findings.
Reviewers ran no checks; full CI and PostgreSQL tests remain separate gates.

The final reviewed source run at 02:43:36Z used the six-file command above with
`RUN_DATABASE_INTEGRATION=false`: 42 passed, 13 skipped, 0 failed, 232 assertions; native 502 ms,
process 514 ms. The correction's candidate passed scoped Oxfmt, denied-warning Oxlint and whitespace
checks. PostgreSQL skips remain unverified pending CI.

The mandatory normal commit hook invokes workspace format/lint/type checking, including builds.
Its first attempt failed on missing isolated dependency links; two later 20-second caps stopped it
and cleaned outputs. A cached attempt then passed all 44 build/OpenAPI tasks, database schema,
runtime compatibility and 200-requirement/103-issue validation, but rejected architecture inventory
drift. The architecture refresh changes only three existing workspace dependency edges and four
composition source digests; candidate, operation definitions, classifications and acceptance evidence
are unchanged. Generated reports were refreshed accordingly. The hook is retried after that repair;
its final result is separate evidence. Each hook attempt uses one Turbo task at a time, a 20-second
deadline and a 60,000 KiB total-checkout cap; task-owned dependency directories, generated `dist`
and `.turbo` output are removed in `finally`. No dependencies are installed and no service or Docker
operation is invoked by this hook.

## Remaining acceptance

Actual provider transport, credentials and delivery revocation fencing; authenticated HTTP/local IPC
consumers; process/container crash and reconnect; fresh Docker Simple/Server profiles; deployed cloud
candidate and independent multi-profile acceptance; full retention/cleanup policy; frozen candidate
checks and cost/resource measurements remain unverified. A callback authority check alone does not
prove atomic revocation at delivery. Fake provider records survive in the test process; database reopen
is not a provider restart or workflow restart. Docker disk reclamation and monetary savings were not
measured. No original M11 acceptance criterion is waived.
