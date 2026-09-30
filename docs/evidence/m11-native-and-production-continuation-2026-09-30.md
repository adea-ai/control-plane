# M11 bounded native and production observations — 2026-09-30

These observations do not constitute a frozen-candidate acceptance or issue closure.

## Native transport qualification

At branch commit `8488e5d500b5992c99c50a7600d44aca223b8f1b`, the real published Pi 0.84.2 qualification command passed using Node 24.18.0 and Bun 1.4.0. This branch combines the RPC deadline patch from PR #771 with merged dependency PR #767 and main release 1.59.8. The [qualification projection](m11-native-pi-continuation-2026-09-30.json) records package executable/lock hashes, exact source, runtime limitations and outcome. The installed host Pi was 0.99.1, outside the explicitly certified `>=0.84.0 <0.85.0` range: its process version inspection was healthy, but the qualification adapter correctly rejected it. A disposable pinned package was used without changing the global installation.

The successful probe used a credential-free deterministic local model endpoint. It verified streaming/final output, token accounting, duplicate and concurrent starts, changed-command rejection, cancellation, original terminal result/usage/event recovery after cleanup, and a real bundled Restate 1.7.12 with SQLite Local composition. The Local Restate portion verifies an optional compatibility path; it does not establish default Restate-free Local qualification. Native tools and ambient context remained disabled, approval interaction and in-flight restart reconciliation remained unsupported. This is transport/runtime evidence, not live provider quality/cost, hidden-task, human calibration, every harness/version or complete all-profile acceptance.

The script reported completed cleanup. Recorded runner, child-test and Restate process IDs were subsequently absent; the fixture temporary directory and disposable package installation were removed. Unrelated listeners and the user’s global runtime remained untouched.

## Default embedded-SQLite Pi follow-up

The bounded follow-up at candidate `0b616155d2a6a7c21303fbb426bdb0f44109d501` runs the real Pi 0.84.2 process through Local without supplying a `durableExecution` override. The test verifies the `embedded-sqlite` default, SQLite persistence, `externalServices: 0`, unavailable Restate discovery, zero workflow Restate lookups, and successful queue outcomes through `awaitLocalWorkflowOutcome`. The actual native completion and cancellation cases passed; the ordinary fixture E2E also retains and passes its explicit Local Restate compatibility path. The [default-Local qualification projection](m11-native-pi-default-local-2026-09-30.json) records the outcomes, package provenance and limitations.

The fresh exact-version NPM tarball integrity and executable SHA256 match the earlier recorded values. The fresh disposable Bun lock hash differs because its root workspace name differs; the lock diff contains no other change. Global Pi remained at 0.99.1 and was not modified. This is default Local transport/topology evidence against the credential-free deterministic fixture. It does not establish live-provider quality/cost, in-flight restart recovery, approval execution, human acceptance, every harness/profile, or full M11 acceptance.

## Production release observation

[Promotion run 36683198399](https://github.com/adea-ai/control-plane/actions/runs/36683198399) completed for `workspace-v1.59.8`. Production API deployment `07eff796-e1f2-4efc-824a-8b49166b5df1` and worker deployment `456c8115-5458-4a64-8b42-066e93bb683a` reported successful startup at main commit `fdc057e4a8393aa6751937a7999f5b2eef08078b`. Configured immutable image digests match the promotion artifacts; the [release projection](m11-production-release-1.59.8.json) preserves this linkage.

This release includes PR #769 and dependency PR #767, but predates the RPC branch above and the PRD/TDD inventory PR #773. Successful startup/image provenance does not prove deployed functional, trust-boundary, recovery, performance or independent acceptance. The current trusted-main Neon run remains a separate required verification; canceled superseded runs do not count as passes.
