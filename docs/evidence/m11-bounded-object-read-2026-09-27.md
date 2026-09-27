# M11 bounded ObjectStore reads

Status: verified component checkpoint, not complete M11 profile acceptance.
Integrated source: `615517c5441bb1d55cbd6b98369e7327d5e97fa0`.
Reader implementation and allocation correction: `22594fc6`, `cbd1cb90`.

## Implementation boundary

R2/S3 GET previously invoked the SDK bulk byte-array transformation before
checking the object-size limit. The declared-overlimit regression observed one
bulk invocation where zero was required; malformed-header rejection also left
the supplied Node stream open.

The replacement validates the descriptor and declared length before consumption,
reads Node async byte iterators or WHATWG readers incrementally into one bounded,
exact declared-size owned buffer, and rejects a chunk exceeding the configured
cap or declared size before copying it. Provider buffer reuse cannot change copied
bytes, and empty chunks do not accumulate retained bookkeeping. Exact length and
checksum verification remain mandatory.

Early rejection cancels/destroys the provider body and releases acquired reader
locks. Cleanup accessor failures cannot replace the original normalized failure.
Unsupported transform-only bodies fail closed; no unsafe bulk-transform fallback,
new dependency, contract change or write-path change was introduced.

Independent review identified one allocation-cleanup edge in the initial reader:
allocation happened before the cleanup try. The root reproduced an unread stream
remaining open when an unallocatable safe-integer length was declared (zero tests
passed, one failed, four assertions), then moved allocation inside the handler.
The corrected complete reader suite passed 11 tests, zero failures, 45 assertions.
The runtime rejects that length; no enormous allocation succeeded in the test.

## Evidence and limits

The bounded Luna lane reproduced RED (6 passed, 9 failed, 40 assertions), then
passed all ObjectStore tests (51 passed, zero failed, 196 assertions). Tests use
real in-memory Node/WHATWG streams with injected provider responses, including
understated length, multiple/empty chunks, reused buffers, malformed bytes,
provider failure, pre-read cancellation and cleanup accessor failures. These
are not live R2 or deployed-cloud acceptance evidence.

The initial combined integration run passed 333 tests and failed two hosted
writer tests because their injected SDK body exposed only the removed bulk
transformation helper. Replacing that fake with a real Node Readable retained
every concurrent publication assertion. The complete hosted integrity file
passed 31 tests, zero failures, 58 assertions.

Final integrated verification:

- Full workspace build at corrected runtime source `cbd1cb90`: 41 successful
  tasks, zero cached. Subsequent source `615517c5` changes only the downstream
  test fixture, not production source.
- Combined ObjectStore/deployment/runtime-worker/runtime-gateway suites:
  335 passed, zero failed, 1230 assertions, 31 files, randomized seed 1106.
- SDK compatibility, strict ObjectStore/gateway lint, changed-file formatting
  and whitespace checks passed.
- Architecture: 41 packages, 16 operations, four profiles validated.
- Live requirements ledger: 200 requirements and 103 issue audits validated;
  this is consistency with current open issues, not their acceptance completion.
- Boundaries: 1501 files in 41 packages checked without issues.
- Independent read-only review found the initial allocation-cleanup issue, then
  verified the exact correction as resolved with no actionable defect in that
  delta. The reviewer did not run tests or processes. The root reviewed the
  subsequent test-only stream substitution; no assertions were weakened.
- Fetched main; zero missing main commits.

Final test children were absent after completion. Task-specific filesystem,
gateway and Artifact fixture temp prefixes were empty in the actual OS temp root.
Native worker/reviewer lanes completed; no cloud service was started. Existing
goal-owned worktrees and the stopped PostgreSQL recovery fixture are preserved
for unfinished acceptance work, not reported as disposable leftovers.

The reader bounds retained/copied payload bytes, not allocations made upstream by
the SDK, stream producer, or transport before yielding a chunk. It does not add a
read deadline or certify global process memory under concurrent workload. Actual
provider faults/capacity and operations acceptance remain open under #194.

The root separately reproduced a filesystem test cleanup failure, then registered
and removed exact fixture roots, including renamed originals. Cleanup runs after
each test and an afterAll check verifies all registered paths are absent. Only
the ten exact paths from the isolated RED run were removed; unattributed older
`control-plane-objects-*` directories were left untouched.

No M11 issue is closed by this checkpoint. The original profile, production
activation, recovery and independent/manual acceptance scope remains unchanged.
