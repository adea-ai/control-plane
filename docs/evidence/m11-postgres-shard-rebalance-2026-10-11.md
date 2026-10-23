# PostgreSQL integration shard rebalance — 2026-10-11

Run [38178336814](https://github.com/adea-ai/control-plane/actions/runs/38178336814)
used head `7d61c6c5551348fa172bfc8998f8b6406329ea1b`. The candidate is reconciled
to fresh `main` `6e772034516d31f3a7ddd0474b7c41cfc42f38a7`; all four moved test
files have identical SHA-256 hashes at both heads.

Shard 1's verification step completed in 842.428s and shard 3's in 1,192.819s.
Shard 2 completed its foundation slice and the reference-window, hold-activation,
and ancestry files. The runner reached `usage-store` after 2,065.381s. The job
was cancelled 594.492s later with 9 of 12 usage-store tests complete. The three
following files did not start. No shard log contains retry messages; every
started shard verified its database sandbox cleanup and absence.

The exact same `usage-store` source was also run in [38112415657](https://github.com/adea-ai/control-plane/actions/runs/38112415657):
it reached 619.319s, with 10 of 12 tests complete, before cancellation. This is
a lower bound rather than a completed file duration. The other two moved files
are unchanged from the earlier complete file timings in
[37575729589](https://github.com/adea-ai/control-plane/actions/runs/37575729589):
314.087s for memory-provenance-retention and 156.796s for
retention-hold-owner-activation.

The candidate moves those three tail files from shard 2 to shard 1. It moves
the unmeasured workspace-execution-scope file from shard 2 to shard 3, whose
observed verification span was 1,192.819s. The known lower bounds are 1,932.630s
for shard 1 (including the usage-store lower bound), 2,065.381s before shard 2's
removed tail, and 1,192.819s for shard 3 before the unmeasured workspace file.
These numbers do not establish a complete-run fit: the usage-store and workspace
files are censored/unmeasured. A complete hosted run on the candidate is required
to qualify the new ownership.

The shard map changes file ownership only. It preserves all integration files
and assertions, foundation filters, per-file serial execution, three existing
database sandboxes, the 45-minute limit, cleanup, and branch absence checks. The
separate runner correction removes automatic integration-file reruns and keeps
bounded diagnostics while streaming complete output. Neither change claims
reduced cost.
