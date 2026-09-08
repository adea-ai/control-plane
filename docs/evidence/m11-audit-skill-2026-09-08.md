# M11 repository audit skill evidence — 2026-09-08

Scope: partial progress on #196 (M11.11), based on main commit
`8b85ef7a2231405ec1c9aa4ffa16b0862e0f3044`. The candidate is the Git commit
containing this document, not a claim that the milestone's final candidate is frozen.

## Change

Added the repository-owned `control-plane-audit` router, version 1.0.0, with
maintainer ownership, ten evidence lanes, explicit mutation boundaries, and
partial/fixture/skipped-evidence limitations. Its 13 local references route to
existing policy, contracts, commands, and evidence guidance. The lock now
inventories nine skills. A follow-up inspection found that `code-review` referenced
a missing issue-tracker guide and unavailable setup command. Added the actual
read-only GitHub retrieval guide, versioned that repository adaptation, and
clarified dirty-worktree scope and unavailable-spec/delegation reporting. The
other seven existing skills are unchanged.

Added smoke tests for inventory consistency, skill frontmatter, router metadata,
repository-contained local links, and referenced package commands. These checks
are structural, not proof that an agent will follow the instructions.

## Verification

- Isolated `uv run --with PyYAML==6.0.3 python
<installed-skill-creator>/scripts/quick_validate.py
.agents/skills/control-plane-audit`: passed. The initial direct Python invocation
  lacked PyYAML; no global Python packages were changed.
- `bun test tests/agent-skill-library.test.mjs tests/repository.test.mjs`:
  initially 23 passed / 72 assertions; after extending structural coverage to
  `code-review`, 24 passed / 78 assertions, zero failures.
- Root lint, type-check, format-check, and test sequence: passed again after the
  review-guide and structural-test changes. The E2E group reported 101 passed and
  571 assertions. Lint warnings are not represented as absent.

## Behavioral forward test

One independent, read-only agent received the proposed skill and raw local
evidence, with the question whether green CI and real Pi certification make M11
ready to close. It was not given the expected answer or suspected defect.

The reviewer rejected closure, distinguishing real Pi process evidence from
full runtime acceptance and identifying stale candidate metadata and missing
M11 requirement entries. It also found that the router did not identify the
authoritative issue criteria source. The router was corrected to name #186–#197,
authenticated issue retrieval, and a fallback when GitHub is unavailable.

A targeted retest by the same reviewer accepted the revised decision routing but
identified underspecified export provenance. The final refinement requires
repository identity, retrieval time, number, title, full body, state, URL,
all twelve issues, and explicit freshness/completeness verification. That final
refinement is not claimed as another independent blinded test.

## Remaining acceptance limits

This is not completion of #196 or M11. There is no independent human calibration,
representative golden/adversarial task suite, measured before/after context or
execution-efficiency benchmark, or final frozen-candidate audit in this evidence.
One agent forward test and its targeted retest do not replace those gates.
