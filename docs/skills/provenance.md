# Skill provenance ledger

Provenance record for the repository's retained audit skills. It answers three
questions for every skill: where the content came from, which local revision
applies, and who is accountable for it. The machine-readable form is the
`provenance` block in each skill's frontmatter; the validator cross-checks the
two, so this ledger and the skills cannot drift apart silently.

## Ledger

| Skill                          | Origin            | Upstream source                                                                                                               | Upstream version | Local integration version | Accountable owner                   |
| ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------- | ----------------------------------- |
| code-review                    | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| code-simplification            | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| control-plane-audit            | repository-owned  | —                                                                                                                             | —                | 1.2.0                     | Control Plane maintainers           |
| incremental-implementation     | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| security-and-hardening         | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| test-driven-development        | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| turborepo                      | vendored-upstream | Vercel Turborepo agent skill (upstream docs: apps/docs/content/docs/ in the Turborepo repository, https://turborepo.dev/docs) | 2.10.11-canary.4 | 1.1.1                     | vendored — Vercel upstream (pinned) |
| typescript-advanced-types      | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |
| verification-before-completion | repository-owned  | —                                                                                                                             | —                | 1.1.0                     | Control Plane maintainers           |

## Rules

- `repository-owned` content is authored and maintained inside this repository.
  Its `metadata.version` is the only version; `integration_version` is optional
  and, when declared, must equal it.
- `vendored-upstream` content is imported from another project and pinned. Its
  `metadata.version` is the pinned upstream version and must equal
  `metadata.provenance.upstream_version`. The local contract revision is
  `metadata.provenance.integration_version`.
- A vendored skill may only be edited at its integration points: the
  frontmatter metadata, the evidence contract, and the boundary contract.
  Substantive upstream changes arrive by re-vendoring a new pinned version and
  recording it here and in [`CHANGELOG.md`](./CHANGELOG.md).
- Adapted content keeps its attribution. `code-simplification` retains the
  Chesterton's Fence principle it was adapted from; `turborepo` retains the
  Vercel upstream pin recorded above.
- No skill may embed credentials, machine-specific absolute paths, or private
  data. The validator rejects secret-shaped content and absolute paths, and
  the repository credential scan covers `.agents/skills/`.

## Vendored adaptations

The `upstream_version` of a vendored skill records the upstream content the
local file is based on. It is not a claim that re-vendoring that version
reproduces the local file byte for byte, because the permitted integration
points change the bytes. The local bytes are pinned instead: the inventory
records each entrypoint's `skillMdDigest`.

`turborepo` carries one intentional local adaptation:

- The upstream file's frontmatter `description` was a multi-line block that
  listed the upstream trigger surface ("Triggers on: turbo.json, task
  pipelines, dependsOn, …" and a second "Use when user:" sentence). It was
  replaced with a repository-authored routing clause in the form
  `Use when <trigger>. Not for <non-trigger>.`, so the skill takes part in the
  library's routing convention and its trigger and non-trigger clauses are
  unique and non-overlapping across the library.
- The upstream body, its reference files, and its evidence contract are
  otherwise unchanged. The local addition is the evidence and boundary
  contracts every retained skill carries.
- The upstream source is identified by the vendored file's own _Source
  Documentation_ section: `apps/docs/content/docs/` in the Turborepo
  repository, with the live documentation at <https://turborepo.dev/docs>. The
  local integration revision moved from `1.1.0` to `1.1.1` when that source
  was made identifiable and this adaptation was recorded.

## Verification

```sh
bun scripts/validate-skills.mjs
```

The validator fails the lane when a provenance block is missing, when a
vendored skill has no upstream source or pin, when a vendored pin disagrees
with the declared version, when a repository-owned skill declares an
upstream source, and when this ledger's origin, upstream source, upstream
version, integration version, or owner disagrees with the skill's frontmatter.
