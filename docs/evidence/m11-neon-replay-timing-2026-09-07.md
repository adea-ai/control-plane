# M11 Neon replay test timing

PR #417's Neon run `34169217802` failed the HTTP validation replay test at
30 seconds after 21 assertions. A diagnostic reproduction against its isolated
preview branch reached database-ready at 22,239 ms, application-ready at
24,688 ms, and concurrent-validation-complete at 28,911 ms before timing out
after 19 assertions. Provisioning and all schema migrations were consuming the
same deadline as the behavior under test.

Fixture creation and migration now run in a separately bounded 60-second
`beforeAll` hook. Cleanup runs in a 30-second `afterAll` hook, including when
migration or behavior fails. The behavior retains its 30-second deadline.
Optional `INTEGRATION_TIMING=true` checkpoints contain stage names and elapsed
milliseconds only, never credentials or database URLs.

The same-preview verification passed all 31 assertions in 10,677 ms. Application
close completed at 8,917 ms, connection close at 8,990 ms, application reopen at
9,002 ms, and stored replay at 9,802 ms. Total process duration including fixture
setup and cleanup was 31.91 seconds. This establishes remote provisioning budget
contention, not a connection-close hang, in the diagnostic reproduction; the
original CI run did not have per-stage timing instrumentation.

Local lint, type checks, formatting, and the complete root test command passed,
including 101 E2E tests and 569 assertions. Remote CI must pass the updated commit
before merge. This evidence does not certify all of Milestone 11.
