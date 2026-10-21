# Skill provenance ledger

Provenance record for the repository's retained audit skills. It answers three
questions for every skill: where the content came from, which local revision
applies, and who is accountable for it. The machine-readable form is the
`provenance` block in each skill's frontmatter; the validator cross-checks the
two, so this ledger and the skills cannot drift apart silently.

## Ledger

| Skill                          | Origin            | Upstream source              | Upstream version | Local integration version | Accountable owner                   |
| ------------------------------ | ----------------- | ---------------------------- | ---------------- | ------------------------- | ----------------------------------- |
| code-review                    | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| code-simplification            | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| control-plane-audit            | repository-owned  | —                            | —                | 1.2.0                     | Control Plane maintainers           |
| incremental-implementation     | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| security-and-hardening         | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| test-driven-development        | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| turborepo                      | vendored-upstream | Vercel turborepo agent skill | 2.10.11-canary.4 | 1.1.0                     | vendored — Vercel upstream (pinned) |
| typescript-advanced-types      | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |
| verification-before-completion | repository-owned  | —                            | —                | 1.1.0                     | Control Plane maintainers           |

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

## Verification

```sh
bun scripts/validate-skills.mjs
```

The validator fails the lane when a provenance block is missing, when a
vendored skill has no upstream source or pin, when a vendored pin disagrees
with the declared version, or when a repository-owned skill declares an
upstream source.
