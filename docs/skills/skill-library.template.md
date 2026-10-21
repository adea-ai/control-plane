# Skill template

Copy this template to `.agents/skills/<skill-name>/SKILL.md` when adding a
retained skill, then follow
[`maintenance-cadence.md`](./maintenance-cadence.md) for versioning, registry
registration, and validation.

## What the validator checks

`scripts/validate-skills.mjs` checks the **shape** of the contract, not the
meaning of its text:

- the frontmatter name matches the directory, and the description follows the
  routing convention with a trigger and a non-trigger of at least 20
  characters;
- the trigger and non-trigger clauses are unique across the library and do not
  overlap another skill's clause;
- `metadata.version` is a semantic version and `metadata.owner` is present and
  matches the registry row;
- the evidence contract contains every labelled field, including
  `**Stop conditions:**` and `**Cleanup:**`;
- the boundary contract contains all five labels, each value at least 30
  characters and unique per label across the library;
- the provenance block is present, and the upstream source, upstream version,
  and integration version agree with the provenance ledger;
- the deprecation lifecycle is consistent: a deprecated skill names a retained
  replacement;
- local Markdown links resolve inside the repository, and the generated
  inventory matches the on-disk skills.

## What the validator does not check

It does not read the prose. A copied placeholder in an evidence-contract or
boundary-contract body is **not** detected: a boundary placeholder is long
enough to satisfy the length rule, and a single new skill's placeholder is not
a duplicate of another skill's value. Only the routing clause, the labelled
fields, and the structural rules above fail the lane. Reviewers must check that
the boundary and stop-condition text is specific to the skill.

Every placeholder below is therefore a prompt for the author, not a token the
validator rejects.

## Routing contract

The `description` is the only agent-visible selection surface. It must follow
this convention exactly:

```
Use when <trigger>. Not for <non-trigger>. <optional context sentence>
```

- The trigger and non-trigger clauses must each be at least 20 characters.
- They must be unique across the library, and neither may overlap another
  skill's trigger or non-trigger clause.
- Keep the context sentence short enough that the whole description stays under
  400 characters; the inventory truncates at 400.

## Frontmatter

```yaml
---
name: <skill-name>
description: 'Use when <trigger>. Not for <non-trigger>. <optional context>.'
metadata:
  version: '1.0.0'
  owner: 'Control Plane maintainers'
  provenance:
    origin: repository-owned
---
```

Use `origin: vendored-upstream` only for content imported from another project.
A vendored skill must also declare `source`, `upstream_version` (equal to
`metadata.version`), and `integration_version` (the local contract revision),
and its local edits are limited to the frontmatter metadata and the evidence
and boundary contracts.

## Body

```markdown
# <Skill title>

<What the skill does, in one or two paragraphs. Reference canonical owners
such as `AGENTS.md` and `.agents/validation.md` instead of copying them.>

## Evidence contract

- **Inputs:** <what the skill consumes>
- **Safe assumptions:** <what may be treated as given, and what may not>
- **Allowed mutations:** <what may change, and under whose authorization>
- **Outputs:** <what the skill produces>
- **Verification commands:** <the commands that prove the output>
- **Failure/skip reporting:** <how failures and skipped checks are recorded>
- **Stop conditions:** <when the skill halts and hands back>
- **Cleanup:** <what the skill leaves behind, or that it leaves nothing>
- **Completion-claim guard:** <the claim the skill must never make>

### Boundary contract

- **Secrets:** <what the skill must never read, print, or commit>
- **Dirty worktree:** <how unrelated working-tree changes are preserved>
- **Migration:** <how schema and migration changes are bounded>
- **Generated files:** <how generated artifacts are treated>
- **Provider:** <whether the skill may call a provider or activate one>
```

Each boundary value must be at least 30 characters and must be specific to
this skill: a boundary that is byte-identical to another skill's boundary for
the same label fails the lane.

## Registry row

Add one row to [`.agents/skills/README.md`](../../.agents/skills/README.md)
with seven cells — skill, version, purpose, trigger, non-trigger, owner, and
the evidence-contract link. The trigger and non-trigger cells must match the
`description` clauses exactly; the validator fails the lane on drift.

## Validation

```sh
bun scripts/validate-skills.mjs --refresh
bun test tests/agent-skill-library.test.mjs tests/skill-library.test.mjs
```

The refresh also validates the manifest against
[`skill-library.schema.json`](./skill-library.schema.json) and checks this
library's [`provenance.md`](./provenance.md) ledger against the skill
frontmatter, so a new skill needs a ledger row that agrees with it.

Commit the refreshed [`skill-library.json`](./skill-library.json) alongside the
skill, and record the change in [`CHANGELOG.md`](./CHANGELOG.md).
