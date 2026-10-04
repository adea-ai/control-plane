# M11 Neon cleanup retry evidence — 2026-10-04

## Observed failure

Trusted-main run [37172768833](https://github.com/adea-ai/control-plane/actions/runs/37172768833)
tested source `1757bc09c54ebd48b879e641ca1544930ffd072b`. All three migration/integration
slice steps passed. Shards 1 and 2 deleted their preview branches successfully. Shard 3 failed
in `Find exact preview branch for cleanup` with `TypeError: fetch failed`, caused by
`ECONNRESET`; deletion was skipped, so the overall workflow failed.

The expected disposable name is `preview/main-37172768833-1-s3`, with expiration
`2026-10-05T03:00:44Z`. An independent read-only connector lookup failed authorization with
HTTP 404. Neither deletion nor expiration of that branch has been verified.

## Repair and bounded verification

Cleanup retries the current listing page at most three times for transport failures or
HTTP 408/429/500/502/503/504. Each request retains its ten-second deadline; retries wait
500 then 1000 ms. The existing twenty-page limit remains, and the cleanup lookup step
has a twelve-minute timeout. Successful absence still requires a complete valid listing.
Project, exact run/attempt/shard name, parent, protection flags, duplicate rejection,
and pagination validation remain mandatory before exporting a branch ID for deletion.
Retries do not replay the integration slice or turn failed cleanup into a passing workflow.

The actual embedded workflow script is executed in a synthetic VM with controlled fetch
responses and timer callbacks. Four new recovery assertions failed on the original source.
Independent review then found an unhandled response-body reset; two focused assertions reproduced
that gap and the unsanitized malformed-JSON error. After repair,
`bun test ./tests/neon-workflow.test.mjs` passed 34 tests with 266 assertions in 13.43 seconds;
the outer runner completed in 13.443 seconds under a twenty-second bound.
The suite covers transient recovery, exhausted retries, permanent HTTP errors, pagination,
unsafe metadata, failed complete-list verification, and trusted-main migration gating.
Scoped Oxfmt, Oxlint, and `git diff --check` passed. The existing cached Code Foundry 1.44.3
CLI passed `doctor`; no package was installed.

This is deterministic workflow-script evidence. Live recovery from a Neon network reset,
the old branch's deletion, billed-minute savings, and complete M11 acceptance are unverified.
No local Docker, database service, dependency installation, or persistent server was used.

Related acceptance owner: [#189](https://github.com/adea-ai/control-plane/issues/189).
