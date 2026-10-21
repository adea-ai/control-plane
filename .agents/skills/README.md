# Skill library registry

Registry for the repository's audit-skill stack. Each skill ends with an
`## Evidence contract` section defining its inputs, safe assumptions, allowed
mutations, outputs, verification commands, failure/skip reporting, stop
conditions, cleanup, and completion-claim guard, followed by a
`### Boundary contract` section declaring its secret, dirty-worktree,
migration, generated-file, and provider boundaries.

Each skill's frontmatter `description` follows one routing convention:

```
Use when <trigger>. Not for <non-trigger>. <optional context>
```

The trigger and non-trigger clauses are the routing contract. They must be
unique across the library and must not overlap, so an agent can select one
skill — or correctly select none. `scripts/validate-skills.mjs` enforces the
convention, the uniqueness, the registry/skill drift check, and the evidence
and boundary contracts.

| Skill | Version | Purpose | Trigger | Non-trigger | Owner | Evidence contract |
| --- | --- | --- | --- | --- | --- | --- |
| code-review | 1.1.0 | Two-axis (standards + spec) review of a diff since a fixed point, run as parallel sub-agents | the user asks to review a branch, pull request, or work-in-progress diff against a fixed point | fixing the findings, approving the change, or merging it | Control Plane maintainers | [`code-review/SKILL.md` → Evidence contract](./code-review/SKILL.md#evidence-contract) |
| code-simplification | 1.1.0 | Behavior-preserving clarity refactors guided by five principles and Chesterton's Fence | existing code works but is hard to read, maintain, or extend and behavior must not change | behavior changes, for code whose intent is not yet understood, or for performance-critical paths | Control Plane maintainers | [`code-simplification/SKILL.md` → Evidence contract](./code-simplification/SKILL.md#evidence-contract) |
| control-plane-audit | 1.2.0 | Router that selects the smallest relevant evidence lane for milestone-acceptance and production-readiness audits | the user asks for a repository-wide milestone acceptance or production-readiness audit across the managed-cloud, Local, and self-hosted profiles | an ordinary isolated bug fix or a single-file change | Control Plane maintainers | [`control-plane-audit/SKILL.md` → Evidence contract](./control-plane-audit/SKILL.md#evidence-contract) |
| incremental-implementation | 1.1.0 | Delivers multi-file changes as thin vertical slices — implement, test, verify, and checkpoint each increment | a change spans more than one file or is too large to land in one step | a single-file, single-function change of minimal scope | Control Plane maintainers | [`incremental-implementation/SKILL.md` → Evidence contract](./incremental-implementation/SKILL.md#evidence-contract) |
| security-and-hardening | 1.1.0 | Threat-model-first hardening: OWASP patterns, SSRF, supply chain, privacy, and the LLM attack surface | the code handles untrusted input, authentication, data storage, external integrations, or personal data | pure configuration, documentation, or static content with no security surface | Control Plane maintainers | [`security-and-hardening/SKILL.md` → Evidence contract](./security-and-hardening/SKILL.md#evidence-contract) |
| test-driven-development | 1.1.0 | RED→GREEN→REFACTOR discipline with a prove-it reproduction test for every bug fix | implementing logic, fixing a bug, or changing any existing behavior | pure configuration, documentation, or static content that has no observable behavior to test | Control Plane maintainers | [`test-driven-development/SKILL.md` → Evidence contract](./test-driven-development/SKILL.md#evidence-contract) |
| turborepo | 2.10.11-canary.4 | Monorepo build-system guidance: task pipelines, caching, filtering, environment variables, boundaries | the question is about turbo.json, task pipelines, dependsOn, caching, the turbo CLI, --filter or --affected, CI optimization, or monorepo package boundaries | general package-manager, application-framework, or non-Turborepo build questions | vendored — Vercel upstream (pinned) | [`turborepo/SKILL.md` → Evidence contract](./turborepo/SKILL.md#evidence-contract) |
| typescript-advanced-types | 1.1.0 | Reference for advanced type-level design: generics, conditional, mapped, and template literal types | designing complex TypeScript type logic such as generics, conditional types, mapped types, template literals, or reusable utility types | everyday typing that the compiler already infers correctly | Control Plane maintainers | [`typescript-advanced-types/SKILL.md` → Evidence contract](./typescript-advanced-types/SKILL.md#evidence-contract) |
| verification-before-completion | 1.1.0 | Evidence-before-claims gate: no completion statement without fresh verification output | about to claim that work is complete, fixed, or passing, including before a commit or pull request | performing the work itself or for restating a status that was never verified | Control Plane maintainers | [`verification-before-completion/SKILL.md` → Evidence contract](./verification-before-completion/SKILL.md#evidence-contract) |

## M11 audit-lane mapping

The stack maps onto the M11 audit lanes as follows, one skill (or pair) per lane:

- **Requirements traceability** → `control-plane-audit` (authoritative issue/ledger evidence) + `code-review` (diff-to-spec review)
- **Architecture and contracts** → `control-plane-audit`
- **Code Foundry validation** → `AGENTS.md`, `.agents/validation.md`, and `.agents/ci.md` via `control-plane-audit`; `turborepo` covers task-graph details only
- **Security** → `security-and-hardening`
- **Evals and agent behavior** → `control-plane-audit` routes to `docs/evaluation-dimensions.md` and `docs/evals/`; the scripted fixtures exercise the harness, not actual Skill invocation or human calibration
- **Simplification** → `code-simplification`
- **Performance** → `control-plane-audit` routes to `docs/performance.md`
- **Reliability and recovery** → `control-plane-audit` routes to `docs/operations.md`
- **Documentation reconciliation** → `control-plane-audit` compares issue criteria with current docs and evidence
- **Verification** → `verification-before-completion`
- **Implementation discipline** → `incremental-implementation` + `test-driven-development`
- **Build/toolchain** → `turborepo`
- **Type-safety reference** → `typescript-advanced-types`

These routed documents remain canonical references rather than duplicate Skills.
The historical calibration kit is a procedure, not a completed result. Use
`control-plane-audit` to retrieve the current milestone's independent evidence
requirements. Structural fixtures do not prove those outcomes or qualify
unavailable live profiles.
This is the smallest compatible stack only when the router and
its referenced policy/evidence documents are available.

## Canonical policy ownership

Policy ownership is singular: [AGENTS.md](../../AGENTS.md) owns workflow policy,
[`.agents/validation.md`](../validation.md) owns validation commands, and
`verification-before-completion` owns the completion-claim gate. Skills
reference these canonical owners; they never copy or restate their content, so
a policy change lands in exactly one place.

## Contract and provenance ownership

Each retained skill owns one contract, declared in its own `SKILL.md`:

- **Routing** — the `Use when …` / `Not for …` clauses in the frontmatter
  `description`. They are the only agent-visible selection surface, so they
  must stay unique and non-overlapping across the library.
- **Evidence** — the `## Evidence contract` section, including stop conditions
  and cleanup.
- **Boundaries** — the `### Boundary contract` section, covering secrets, dirty
  worktrees, migrations, generated files, and providers.
- **Provenance** — the frontmatter `metadata.provenance` block: `origin`
  (`repository-owned` or `vendored-upstream`), the upstream `source` and
  `upstream_version` for vendored skills, and the local integration version.

The machine-readable inventory for these contracts is
[`docs/skills/skill-library.json`](../../docs/skills/skill-library.json),
described by [`docs/skills/skill-library.schema.json`](../../docs/skills/skill-library.schema.json).
The provenance ledger is [`docs/skills/provenance.md`](../../docs/skills/provenance.md).
A new skill starts from
[`docs/skills/skill-library.template.md`](../../docs/skills/skill-library.template.md).

## Maintenance

Owner: Control Plane maintainers. Review this registry and every skill at each
release, and whenever a lane mapping, validation command, or policy owner
changes. Deprecation: a skill is removed only after its lane is covered by
another entry in this registry, with the removal and its replacement recorded
in [`CHANGELOG.md`](../../docs/skills/CHANGELOG.md). `turborepo` is vendored from Vercel upstream (pinned at
2.10.11-canary.4, owner: vendored/Vercel upstream): it is updated only by
re-vendoring a new pinned upstream version, and local edits to it are limited
to this registry's integration points (frontmatter metadata and evidence
contract). The procedure, versioning rules, and deprecation lifecycle are in
[`docs/skills/maintenance-cadence.md`](../../docs/skills/maintenance-cadence.md).
