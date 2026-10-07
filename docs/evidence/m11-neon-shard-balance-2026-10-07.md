# Neon integration shard balance — 2026-10-07

Run [37575729589](https://github.com/adea-ai/control-plane/actions/runs/37575729589)
at main `2ea5039de73fc182c5116de864a69bcc6e3f6ae3` completed shards 1 and 2.
Shard 3 was cancelled by GitHub's 45-minute job limit; its check annotation says
“The job has exceeded the maximum execution time of 45m0s”. This was not a green
integration run. The raw run/job/log/annotation observations are retained in the
task evidence. This document and the adjacent JSON retain only nonsensitive
identities, timings, and diagnosis.

The integration steps took 1,220s (shard 1), 560s (shard 2), and 2,688s before
cancellation (shard 3). Shard 1 also ran the PostgreSQL cross-profile matrix.
On shard 3, usage-store took 643.659s, memory-provenance-retention took 314.087s,
and retention-hold-owner-activation took 156.796s, measured between consecutive
file-start timestamps. These spans include process transition overhead.

Move those three complete files to shard 2. Preserve all tests, foundation case
filters, per-case database isolation, serial per-file execution, retry policy,
job limits, branch expiration, exact-owner deletion, and absence verification.
No additional branch, compute instance, job, or workflow trigger is introduced.

Redistributing the recorded work projects integration spans of 1,220s, 1,674.542s,
and 1,573.458s. The last number is a **lower bound**: shard 3 did not finish its
last file. These projections are scheduling inputs, not actual candidate runtime,
complete-run acceptance, or measured financial savings. A regression protects
the redistribution target, while the existing inventory and real Bun selection
tests protect exclusive ownership and all 65 foundation cases.

All three original shards successfully deleted their owned preview branches and
verified metadata absence, including the timed-out shard. This proves the merged
cleanup path ran during cancellation. It does not prove synchronous physical
storage reclamation, the entire reliability audit, or all asynchronous operations.

The timeout remains a reliability finding owned by the M11 implementation lane
(P2; follow-up due 2026-10-08). Acceptance requires a complete hosted run from the
merged candidate, with every assigned file and existing cross-profile/drill lane
passing and cleanup verified. Do not increase the job limit or rerun the old
candidate simply to hide the recorded failure. #194 and M11 remain open.
