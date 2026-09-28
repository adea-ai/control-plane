# M11 runtime artifact verification

Status: verified component checkpoint, not complete M11 profile acceptance.
Integrated source: `8e11fd25fef507be7266a4b8c81e0f98372ce10f`.

## Root authority correction

Source: `e39fbac98f7d824b246e0d43dbd95ea20151dc46`.

Runtime event ingestion re-reads the durable command, execution, attempt and
active source channel after asynchronous normalization, before progress or
terminal effects. The result branch with no normalized terminal event also
revalidates authority before returning applied. Historical result generation
rules and duplicate-effect conflict handling remain unchanged.

The lifecycle's channel-authority guard requires the current local authenticated
connection and coordinated ownership, verifies credential expiry and durable
revocation, then re-reads ownership after the revocation lookup. Registry and
coordination failures fail closed. Runtime composition now uses this guard
instead of treating coordination metadata alone as channel authority.
The ownership comparison includes workspace identity; a deterministic ownership
change during revocation lookup failed before that additional correction.

Root regressions: seven cases were RED before the ingestion correction, then
the complete ingestion file passed 20 tests. Four lifecycle tests were RED before
the new guard; combined authentication/lifecycle/ingestion validation passed
47 tests, zero failures, 203 assertions. Scoped build passed 37 tasks (36 cached),
strict lint, formatting and whitespace passed. Independent read-only review of
the root correction found no actionable defect, with no tests or processes run.

## Storage-verifier integration

The bounded Luna lane reproduced acceptance of a missing artifact with a no-op
host verifier through actual WebSocket and SQLite composition. The correction
parses command and reference schemas before storage access, derives the Artifact
ID and ObjectStore key from the trusted command's attempt, verifies HEAD/GET
bindings, media, bounded accepted size, reference digest and actual bytes, then
requires the separate host authorization hook. That hook cannot bypass storage
verification. Provider failures become a fixed diagnostic without raw details.

The storage convention matches the current Hosted managed-Pi terminal writer.
Local direct activities use a different key format and bypass the gateway; they
are unchanged. Synthetic ACP fixture IDs do not prove compatibility with a real
remote ACP producer; that producer and its storage binding remain acceptance work.

## Integrated validation

- Full workspace build: 41 successful tasks, 40 cached.
- Combined ObjectStore, deployment, runtime-worker and runtime-gateway suites:
  324 passed, zero failed, 1185 assertions, 30 files, randomized seed 1105.
- Runtime SDK compatibility, strict gateway lint, changed-source formatting and
  whitespace checks passed.
- Architecture audit: 41 packages, 16 operations and four profiles validated.
- Requirements ledger checked live GitHub state: 200 requirements and 103 issue
  audits validated. This is ledger consistency, not completion of open gates.
- Workspace boundaries: 1500 files in 41 packages, no issues found.
- Independent read-only review of the immutable integration delta found no
  actionable correctness finding. The reviewer did not run tests or processes.
- Fetched `origin/main`; no main commits were missing from the integrated source.

All three emitted filesystem contender child PIDs were absent after the suite.
No owned runtime-gateway, verifier, filesystem-artifact or hosted-artifact temp
directories remained in the OS temp directory. Composition fixtures closed their
listeners in cleanup; this root run did not print listener ports, so worker-run
port records are not claimed as root-run observations. Native worker/reviewer
lanes completed without cloud deployment. Goal-owned worktrees and the stopped
PostgreSQL recovery fixture remain preserved for unfinished milestone work.

## Acceptance boundaries

This does not issue upload credentials, provision device enrollment, implement
the real Hosted provider or outbound node connector, or prove full Cloud/Local/
Hosted-simple/server acceptance. It does not make independent credential
revocation and effect persistence one distributed atomic transaction.

At this checkpoint, the verifier's accepted-size checks do not establish a streaming allocation
bound for the existing R2 adapter: its GET currently transforms the complete SDK
body before enforcing `maxObjectBytes`. A bounded provider reader and live
provider acceptance remain required for the full operations gate.

Follow-up: the adapter's bulk-read gap at this historical checkpoint is corrected
by the [bounded ObjectStore read checkpoint](m11-bounded-object-read-2026-09-27.md).
Live provider, deadline, concurrency and complete operations acceptance remain
unproven; the follow-up does not expand this checkpoint's profile claims.

No M11 issue is closed by these component checks. Original #188, #190, #191 and
#194–#197 acceptance requirements remain intact.
