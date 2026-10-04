# M11 Neon budget-admission shard balance

## Scope and source

This is a bounded follow-up to M11.4 (#189), required framework item 9:
measure suite duration and optimize wall-clock without sharing mutable integration
state. It does not close the original issue acceptance criteria or M11.

The baseline is trusted-main commit
`cb68d5914cd5f34489706bbdcf887c487f3faf28`,
[run 37177353771](https://github.com/adea-ai/control-plane/actions/runs/37177353771).
All three migration/integration shards and their preview cleanup steps succeeded.
The following observations come from completed job step timestamps and streamed
Bun file summaries, retrieved on 2026-10-04. They are elapsed time, not billing.

| Shard | Job ID       | Integration step | Relevant file summaries                                                                  |
| ----- | ------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| 1     | 111362675558 | 763 seconds      | Foundation slice: 37 cases, 725.58 seconds                                               |
| 2     | 111362675559 | 2,602 seconds    | Foundation slice: 28 cases, 1,089.19 seconds; budget admission: 24 cases, 955.20 seconds |
| 3     | 111362675568 | 1,278 seconds    | Independent database, composition, and recovery files                                    |

Shard 1 additionally ran the PostgreSQL conformance matrix (134.92 seconds for
its 11 cases) and the cloud remote drill. Shard 2's three remaining retention
files took 220.84, 168.76, and 163.72 seconds. There were no file retry receipts
or failed case receipts in any of these completed shard logs. Shard 2's integration
step alone used 43m22s of a 45-minute job budget, before considering other steps.

## Change and preserved coverage

Move `packages/database/src/budget-admission.integration.test.mjs` as one whole
file from shard 2 to shard 1. The runner still executes files serially, and each
shard retains its own disposable Neon branch. No fourth branch, mutable shared
fixture, case filter, retry, timeout increase, or test omission is introduced.
The complementary 37/28 foundation slices and shard 1's drill ownership remain
unchanged. The existing executable inventory checks all integration file owners
and verifies actual Bun selection of all 65 foundation cases without duplication.

The timing sample identifies spare capacity and a timeout risk. Moving work does
not reduce the number of assertions or database setup operations, and the
observed file time cannot predict its duration on another compute instance.
Post-change trusted-main timing, runner billing, Neon compute/transfer, and cost
savings are unverified until measured. No percentage or dollar savings is claimed.

## Validation and resource limits

Focused source validation and independent reviews are recorded in the pull
request. Required current-head CI gates and a successful trusted-main Neon run
remain necessary evidence after publication. The latter's branch deletion steps
must also succeed; branch expiration alone is not cleanup proof.

Local verification uses the existing shard partition test with synthetic Bun
case-name fixtures. It never connects to PostgreSQL or invokes Docker. One
fixture directory and child process at a time are bounded and removed. Local
Docker, full builds, installs, and broad suites are excluded under the user's
resource constraint; remote CI supplies the broader validation.

The existing 150GB Docker footprint, the older failed Neon cleanup branch, release
token permissions, deployed profile acceptance, and full M11 acceptance remain
separate unverified follow-ups.
