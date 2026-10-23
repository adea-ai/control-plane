# PostgreSQL provider compatibility budget — 2026-10-12

## Scope and status

The trusted-main PostgreSQL workflow is reduced to one ephemeral branch and one bounded compatibility
proof for pooled/direct routing, the application and migrator roles, required TLS, and transaction
round trips. Portable integration, migration, PostgreSQL profile conformance, and Hosted
PostgreSQL/Restate qualification retain their local PostgreSQL owners. This aligns with
[#189](https://github.com/adea-ai/control-plane/issues/189), which tracks deterministic test lanes,
explicit ownership, and runtime budgets.

The workflow starts its elapsed-time clock before branch creation. The five-minute budget check runs
after exact branch lookup, deletion, and an absence check. The compatibility command has a 90-second
timeout. Cleanup retains its separate bounded lookup allowance so a slow proof can still clean up
before the final budget check fails. A successful run must finish all those steps within 300 seconds.

This candidate has **not** run on trusted main yet. The 300-second limit is enforced, but there is no
new-run measurement proving that this design completes within the limit. A complete trusted-main run
is still required to qualify actual elapsed time and cleanup behavior.

## Fresh historical timing evidence

- PR [#1101](https://github.com/adea-ai/control-plane/pull/1101) local PostgreSQL integration job
  passed in 2m51s: [job 114678122742](https://github.com/adea-ai/control-plane/actions/runs/38208784192/job/114678122742).
- The same PR's local migration/PostgreSQL profile-conformance job passed in 58s. Its graph scenario
  will now run in this local job under the same strict no-skip script; this candidate has not yet
  produced a local run of that new ownership.
- Complete PostgreSQL run [38198473355](https://github.com/adea-ai/control-plane/actions/runs/38198473355)
  measured integration steps of 791s, 416s, and 1,047s on shards 1, 2, and 3. Hosted
  PostgreSQL/Restate qualification took 31s on shard 3.
- Later PostgreSQL run [38209161123](https://github.com/adea-ai/control-plane/actions/runs/38209161123)
  took 37m09s on shard 1 and 18m14s on shard 2; shard 3 was canceled at 45m23s. Its three owned
  branches were deleted and absence was verified. These observations show that balancing full test
  files cannot meet a five-minute PostgreSQL job budget.

The observed step times in the latter workflow included about 2s for branch creation, 2s for
checkout, 4s for dependency installation, 11s for the now-removed build, and 1s for database-owner
setup. The new bounded proof replaces that build/setup path and caps its own command at 90s. These
partial historical timings are planning inputs, not a complete estimate or performance claim for
the new job.

## Qualification checklist

A successful trusted-main run must show one compatibility job with exactly one database sandbox, a
successful provider proof, successful exact-name cleanup lookup, successful branch deletion and
absence verification, and a final elapsed time no greater than 300 seconds. If the proof, cleanup,
or budget step fails, the run remains failed. Cleanup receives the PostgreSQL API key and project ID but
no database connection URL or database password. Database-admin credentials and role grants are not
used by this proof.
