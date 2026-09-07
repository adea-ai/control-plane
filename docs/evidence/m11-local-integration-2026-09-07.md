# M11 local integration checkpoint

Decision: incomplete milestone; local integration passed. This is not final release approval.

Validated candidate: `dac6dd6a15272a345aa57f4ad586ed9a5d8de7c4` on local branch
`codex/m11-integration-candidate`. The candidate combines these exact PR heads:

| PR                                                   | Head                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| #392 component disclosure and CI prerequisites       | `b49c63b85623eb72f4cb4c3f85bded7c996dd022` |
| #393 Hosted Restate identity                         | `1c6ff75960377fdd054a7fa1ab222f4f5f8bf2eb` |
| #394 evaluation authority and metrics                | `4624360aae532e9c6100b825b22be7e8c53605a0` |
| #395 canonical source and contributor reconciliation | `b441d8eec339ed2aaad894a456a902fdd4a3bb29` |
| #396 command retention                               | `d85e0b8f7f0c6bef4548507afe5c23e4180c3f5f` |

All local merges completed without conflicts. No branch was merged into `main`, no release
was published, and no deployment or Neon permissions changed.

## Checks on the candidate

`bun install --frozen-lockfile`, `bun run lint`, `bun run type-check`,
`bun run format:check`, and `bun run test` exited successfully. The test command includes
the workspace build. Results: 754 unit, 47 smoke and 98 E2E tests; zero failures.
Coverage: 87.40% lines and 83.83% functions, exceeding the configured 80% minimum.
Requirement validation checked 80 entries and 103 historical issue audits; architecture
validation checked 41 packages, 13 operations and four profiles. Those validator counts
do not establish that all underlying requirements are implemented or accepted.

The signed-request negative test deliberately logs a rejected invalid JWT. Its test passes;
that expected rejection is not an observed authentication failure for valid requests.

## Remaining acceptance

No PostgreSQL integration, live Hosted Compose, Railway/Neon/R2, fresh Linux VPS, load/soak,
adversarial live-provider, human calibration or independent final audit was run on this
combined candidate. Earlier branch-specific evidence must not be relabeled as exact-candidate
evidence. The existing requirements ledger candidate remains a historical audit record, not
this integration checkpoint. M11 issues #188 and #190–#197 remain open acceptance work.

Neon CI requires the build prerequisite already included from #392 and separately has a
role-membership blocker on that PR. Local integration success does not waive remote CI.
Permission approval remains outstanding. Execution-lifetime retention, physical cleanup and
legacy remediation remain separate from the accepted-command retention boundary tests.

The local integration worktree is intentionally retained for subsequent candidate testing.
No new persistent server or database container was created by this checkpoint. Existing
unrelated containers were left untouched.
