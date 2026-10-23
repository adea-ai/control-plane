> Historical proposal only: the LangGraph inventory-file move described below was not a qualified
> fix for the five-minute trusted-main target. The current workflow keeps the portable suite on
> local PostgreSQL and uses a bounded PostgreSQL provider-compatibility proof. See
> [the current compatibility-budget evidence](m11-postgres-compatibility-budget-2026-10-12.md).

# PostgreSQL integration shard rebalance — 2026-10-12

The completed trusted-main run [38198473355](https://github.com/adea-ai/control-plane/actions/runs/38198473355)
used head `149836981090cef18ebb10643148629cba5b82af`. Its integration steps
took 791s on shard 1, 416s on shard 2, and 1,047s on shard 3. Including
setup/conformance, the corresponding job durations were 907s, 452s, and
1,114s. This run completed successfully.

The complete run log measured
`tests/langgraph-retirement-inventory-pg.integration.test.mjs` at 263.7s on
shard 3. Its source blob is unchanged on current main `7f12f8aa` from the
measured head. The test runs a read-only inventory collector against its own
disposable PostgreSQL fixture. The candidate moves the whole file to shard 2,
without changing test selection, assertions, fixture ownership, database sandbox
count, cleanup, or qualification steps.

Subtracting 263.7s from shard 3 and adding it to shard 2 projects integration
work at 791s / 680s / 783s for shards 1 / 2 / 3. Projected job durations are
907s / 716s / 850s; shard 1 remains the longest job. The projected longest job
is about 207s shorter than shard 3's measured 1,114s job in the baseline run.
These values are a projection from one completed run, not a guarantee of future
runner or provider performance.

Post-merge run [38209161123](https://github.com/adea-ai/control-plane/actions/runs/38209161123)
used merged head `2085eebcf5e66afd50707158c50eb7db18db8a67`. At 06:20:07Z,
shard 2 had passed its integration step in 1,062s and verified database sandbox
deletion and absence. Shards 1 and 3 were still executing their integration
steps; the run had no reported shard failure, but it was not complete. This
slower partial run does not validate the projection. A complete trusted-main
run on the candidate ownership is required before accepting the rebalance.

The workflow's cross-profile conformance check remains on shard 1, and Hosted
PostgreSQL/Restate qualification remains on shard 3. Each integration file
still runs once, serially within its shard. No retry, timeout, credential,
permission, check, or provider qualification behavior changes.
