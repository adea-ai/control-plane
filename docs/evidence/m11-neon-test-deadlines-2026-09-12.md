# M11 Neon integration test deadlines

PR #458 and #460 preview runs reproduced two test-runner timeouts. These were
not migration assertion failures or confirmed security findings. Earlier preview
creation HTTP 422 failures are separate and remain unexplained by this audit.

## Evidence and correction

- The transaction-timeout test combined cold migrations and both ESM/CommonJS
  child probes within 30 seconds. A timestamped phase trace showed the children
  progressing normally before the runner killed the second during rollback
  verification. Direct standalone probes passed in approximately 4.5 seconds.
  Changing synchronous waiting to asynchronous waiting did not fix the combined
  deadline and was reverted.
- Migration now runs in `beforeAll` with a separate 60-second setup budget.
  The transaction test retains its 30-second deadline, each child retains its
  10-second limit, and the 500 ms backend timeout assertions are unchanged.
  The targeted pooled-Neon test passed all 10 assertions in 8.858 seconds;
  setup plus testing took 31.878 seconds.
- The health test deliberately exercises two 11-second stalls, transactional
  rollback, delivery/replay, concurrent writes, and channel fencing. It passed
  all 113 assertions in 62.400 seconds when allowed to finish. Its former
  60-second outer deadline interrupted the final checks and triggered cleanup
  while the test was still using its connections. The outer limit is now
  120 seconds. The production 10-second inventory transaction limit is unchanged.

## Verification and scope

The full repository database integration file passed against a disposable Neon
preview using pooled application credentials and direct migration/admin
credentials: **31 tests, 390 assertions, zero failures, 242.547 seconds**. The
repository harness created and disposed its own isolated test database. No
production or staging database settings, credentials, or data were changed.

Local validation on base `6742d16` passed 1,276 tests plus build, type checks,
lint, and formatting. This is database integration evidence, not completion of
the managed-cloud, native runtime, fresh-host, or full Milestone 11 audit.
Temporary phase diagnostics and the asynchronous-wait experiment were removed.
