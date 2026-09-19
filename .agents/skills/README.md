# Skill library registry

Registry for the repository's audit-skill stack. Each skill ends with an
`## Evidence contract` section defining its inputs, safe assumptions, allowed
mutations, outputs, verification commands, failure/skip reporting, cleanup, and
completion-claim guard.

| Skill | Version | Purpose | Trigger boundary | Owner | Evidence contract |
| --- | --- | --- | --- | --- | --- |
| code-review | 1.0.0 | Two-axis (standards + spec) review of a diff since a fixed point, run as parallel sub-agents | Use for branch/PR/work-in-progress review; NOT for fixing, approving, or merging — read-only advisory | Control Plane maintainers | [`code-review/SKILL.md` → Evidence contract](./code-review/SKILL.md#evidence-contract) |
| code-simplification | 1.0.0 | Behavior-preserving clarity refactors guided by five principles and Chesterton's Fence | Use when code works but is hard to read or maintain; NOT when behavior must change, the code isn't understood yet, or the path is performance-critical | Control Plane maintainers | [`code-simplification/SKILL.md` → Evidence contract](./code-simplification/SKILL.md#evidence-contract) |
| control-plane-audit | 1.0.0 | Router that selects the smallest relevant evidence lane for milestone-acceptance and production-readiness audits | Use for repository-wide acceptance reviews; NOT for ordinary isolated bug fixes | Control Plane maintainers | [`control-plane-audit/SKILL.md` → Evidence contract](./control-plane-audit/SKILL.md#evidence-contract) |
| incremental-implementation | 1.0.0 | Delivers multi-file changes as thin vertical slices — implement, test, verify, commit per increment | Use for any multi-file change or task that feels too big to land at once; NOT for single-file, single-function changes of minimal scope | Control Plane maintainers | [`incremental-implementation/SKILL.md` → Evidence contract](./incremental-implementation/SKILL.md#evidence-contract) |
| security-and-hardening | 1.0.0 | Threat-model-first hardening: OWASP patterns, SSRF, supply chain, privacy, and the LLM attack surface | Use for untrusted input, auth, sensitive data, external integrations, or privacy compliance; NOT needed for pure configuration, docs, or static content with no security surface | Control Plane maintainers | [`security-and-hardening/SKILL.md` → Evidence contract](./security-and-hardening/SKILL.md#evidence-contract) |
| test-driven-development | 1.0.0 | RED→GREEN→REFACTOR discipline with a prove-it reproduction test for every bug fix | Use when implementing any logic, fixing any bug, or changing any behavior; NOT for pure configuration, documentation, or static content changes | Control Plane maintainers | [`test-driven-development/SKILL.md` → Evidence contract](./test-driven-development/SKILL.md#evidence-contract) |
| turborepo | 2.10.11-canary.4 | Monorepo build-system guidance: task pipelines, caching, filtering, environment variables, boundaries | Use for turbo.json, task pipelines, cache, `--filter`/`--affected`, and CI questions; NOT for general package-manager or app-framework issues | vendored — Vercel upstream (pinned) | [`turborepo/SKILL.md` → Evidence contract](./turborepo/SKILL.md#evidence-contract) |
| typescript-advanced-types | 1.0.0 | Reference for advanced type-level design: generics, conditional, mapped, and template literal types | Use for complex type logic, reusable type utilities, and compile-time safety design; NOT for everyday typing the compiler already infers | Control Plane maintainers | [`typescript-advanced-types/SKILL.md` → Evidence contract](./typescript-advanced-types/SKILL.md#evidence-contract) |
| verification-before-completion | 1.0.0 | Evidence-before-claims gate: no completion statement without fresh verification output | Use before any success/completion claim, commit, or PR; NOT for performing the work itself | Control Plane maintainers | [`verification-before-completion/SKILL.md` → Evidence contract](./verification-before-completion/SKILL.md#evidence-contract) |

## M11 audit-lane mapping

The stack maps onto the M11 audit lanes as follows, one skill (or pair) per lane:

- **Requirements traceability** → `code-review`
- **Architecture and contracts** → `control-plane-audit`
- **Security** → `security-and-hardening`
- **Simplification** → `code-simplification`
- **Verification** → `verification-before-completion`
- **Implementation discipline** → `incremental-implementation` + `test-driven-development`
- **Build/toolchain** → `turborepo`
- **Type-safety reference** → `typescript-advanced-types`

The eval-lane and performance/reliability-lane audit procedures are owned by
[`docs/evals/calibration-kit.md`](../../docs/evals/calibration-kit.md) and
[`.agents/validation.md`](../validation.md) respectively, and are deliberately
not duplicated as skills — this list is the smallest compatible stack.

## Canonical policy ownership

Policy ownership is singular: [AGENTS.md](../../AGENTS.md) owns workflow policy,
[`.agents/validation.md`](../validation.md) owns validation commands, and
`verification-before-completion` owns the completion-claim gate. Skills
reference these canonical owners; they never copy or restate their content, so
a policy change lands in exactly one place.

## Maintenance

Owner: Control Plane maintainers. Review this registry and every skill at each
release, and whenever a lane mapping, validation command, or policy owner
changes. Deprecation: a skill is removed only after its lane is covered by
another entry in this registry, with the removal and its replacement recorded
in the release notes. `turborepo` is vendored from Vercel upstream (pinned at
2.10.11-canary.4, owner: vendored/Vercel upstream): it is updated only by
re-vendoring a new pinned upstream version, and local edits to it are limited
to this registry's integration points (frontmatter metadata and evidence
contract).
