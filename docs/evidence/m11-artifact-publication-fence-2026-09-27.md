# M11 artifact publication fence

Status: integrated, locally verified and independently reviewed.
This is component publication evidence, not full-profile or milestone acceptance.

Verified source: `0fa37bb622673ca1736036b0eead9f093df0ed3a`.
Includes filesystem commit `9d9299f0e3d554f0d453286bdfaeb032115f9b79`,
integrated from the bounded Luna implementation lane `bdcaa619`.
Includes the shared-mode correction integrated from Luna commit `b3c0d2c`.
Continues the conditional-R2 checkpoint `1b2e79d5`; PR #743 remains draft.

## Outcome

The Hosted ObjectStore artifact writer now requires atomic conditional creation
at construction, without unconditional fallback. Existing winners must pass
key/attempt/media/size/digest and actual-byte checks. Different results cannot
replace the winning artifact; identical results converge on its reference.
The in-flight map is only an optimization, not the concurrency fence.

Filesystem conditional creation publishes one synced private envelope through
an exclusive hard link. Header and body are not separately published. The
creator syncs the expected owning directory before returning created, and
readers establish the same directory barrier before returning verified bytes
if the creator died after linking. Reads use a bounded pre-sized buffer, a
64 KiB metadata-header cap, EOF/size checks and checksum verification. Legacy
objects remain readable; mutable PUT refuses existing conditional envelopes.

Current mutable and conditional writers share an exclusive, synced, persistent
per-key write-mode claim before publication. It is a format choice, not a
process lock or lease. A conditional claim without an envelope can be resumed
by another conditional writer. A mutable claim without a complete legacy object
returns a retryable provider failure to conditional callers, not false existence.
Malformed claims fail closed; deletion clears the claim and object formats.

## Verified checks

- Combined ObjectStore, deployment, Runtime Worker and Runtime Gateway suites:
  **286 pass, 0 fail, 1082 assertions, 29 files**, randomized seed 1104.
  No filters or skips in this final run. Includes separate-process competition,
  actual filesystem artifact writers forced to observe the same missing key,
  cold reopen, identical/conflicting results, metadata escape expansion,
  malformed envelopes/symlinks/root replacement and no-unconditional fallback.
  Includes a deterministic independent mutable child paused before its first
  legacy rename, mode-only crash recovery, malformed claims and legacy reads.
- Workspace build: **41 successful, 41 total, 0 cached**.
- Installed-SDK conditional suite: **12 pass, 0 fail, 32 assertions**;
  verifies signed precondition headers and preservation on SDK retry. No network.
- Worker package checks: **40 pass, 0 fail, 152 assertions**, package build,
  lint, format and whitespace passed before integration.
- Strict changed-source/package lint, formatting and whitespace passed.
- Runtime compatibility check passed.
- Independent read-only review of the mode-fence correction found no actionable
  defect. The reviewer ran no tests or processes and changed no files. A
  mutable-only claim deliberately requires a mutable repair or explicit deletion
  before conditional creation can succeed; it is not automatically reclaimed.
- Architecture: 41 packages, 16 operations, 4 profiles.
- Live requirements: 200 requirements, 103 issue audits.
- Boundaries: 1496 files, 41 packages, no issues (before this evidence file).

## Failed runs and corrections

- Initial root writer regression: 21 pass, 3 fail, proving unsupported stores
  were accepted and independent writers still used unconditional PUT.
- Initial filesystem integration regression: 0 pass, 2 fail, 24 filtered;
  fail-closed constructor correctly rejected the absent FS capability.
- Worker RED established the missing method, then revealed a subprocess
  readiness-harness newline/early-exit problem. Fixed actual delimiters, stderr
  draining, early-exit rejection and bounded readiness/child deadlines.
- Root first combined run: 278 pass, 3 fail because cross-package consumers
  resolved stale built ObjectStore output. The command incorrectly ordered
  build after tests. A focused reproduction confirmed the startup gate; rebuild
  before rerun produced the final green run without weakening the gate.
- Root review corrected JSON escape expansion beyond the initial 16 KiB header
  cap, unbounded `readFile` allocation, and the creator-crash reader sync window.
- Independent review identified a mixed mutable/conditional writer race:
  mutable preflight could pass before conditional publication and then rename
  legacy files afterward. The deterministic child regression reproduced both
  successful publications before the fix. The shared write-mode claim now
  selects one publication format before either writer can publish its object.

## Acceptance boundaries and next M11 work

The current cooperative mutable/conditional writer race is fenced by the shared
mode claim. This is not the full M11.3 or M11 milestone acceptance gate.
No issue is closed here.
Quiesce old writers/readers before rollout. Old filesystem readers do not
understand envelopes; verified artifact copying to a new root is required for
format conversion. Conditional creation does not fence authorized deletion,
old/external writers, hostile filesystems or network-filesystem behavior.
These tests are not hardware power-loss, live R2 or scoped-credential certification.

Still required: production workspace/node/command-scoped artifact authority and
gateway verification, real Hosted/Cloud startup and outbound runtime wiring,
per-attempt/graph-funded budgets and settlement, frozen full-profile scenarios,
and every remaining M11 security, adversarial, operations, documentation, Skill
and independent/manual acceptance gate. Original issue scope remains intact.

## Resource gate

No paid services, cloud object writes, database starts or servers were used.
Native implementation worker and read-only correction reviewer are completed
and own no remaining processes. Final root test children **70544, 70545 and
70546** exited successfully; exact PID readback found none live. The actual
platform temp directory has
no `m11-filesystem-artifact-*` or `m11-conditional-hosted-artifact-*` fixtures.
Both M11 checkouts and the stopped PostgreSQL volume remain owned by the
unfinished goal; unrelated processes were untouched.
