# Neon budget-admission shard balance — 2026-10-07

Run [37684246003](https://github.com/adea-ai/control-plane/actions/runs/37684246003)
at `7f8d3010c2b3e3c84cd3536cc734ea1006713f7f` ended cancelled when shard 1
reached its 45-minute job limit. Shards 2 and 3 passed. This is an incomplete
integration run, not acceptance evidence for a green candidate.

Shard 1's PostgreSQL cross-profile matrix passed all 11 cases. Its foundation
slice passed 37 cases in 1,397.768s, then the budget-admission file started at
21:12:14.4864561 UTC. That file passed 23 of its 24 static cases before
cancellation at 21:29:32.7973639 UTC. The file's 1,038.311s observed span is a
**lower bound**. The adjacent JSON records the reviewed file hash and inventory;
no database test bodies change in this repair.

The integration steps took 2,441s before cancellation (shard 1), 886s (shard 2),
and 601s (shard 3), using GitHub's whole-second step timestamps. Move the complete
budget-admission file from shard 1 to shard 3, retaining all its cases without a
name filter. The existing inventory and actual Bun-selection checks retain
exclusive ownership and all 65 foundation cases. Files still execute serially
within each shard against isolated per-case databases.

Redistribution of recorded work gives approximately 1,402.689s, 886s, and
1,639.311s. Shards 1 and 3 remain lower-bound estimates because the moved file
did not finish. These are scheduling inputs, not measured candidate durations
or monetary savings. The regression checks the reviewed inventory and the
redistribution of known work; a complete run from the merged candidate must
prove the job deadline, all integration lanes, and cleanup.

All three original preview branches were deleted and absence verified:
`br-green-hill-ay4i04q5` (shard 1), `br-divine-truth-ayhmi2e0` (shard 2), and
`br-bold-fog-ay459sld` (shard 3). Cleanup also passed on the cancelled job. No
additional branch owner, compute instance, job, trigger, retry, or timeout is
introduced. The earlier three-file move and its dated evidence remain historical
observations of a different run; their projections do not certify this candidate.

This is an M11 reliability finding (P2; owner: M11 implementation lane; follow-up
due 2026-10-08). #194 and the full M11 acceptance remain open until a complete
hosted run and the other required acceptance gates are verified.
