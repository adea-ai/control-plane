# Workspace tasks and caching

Vite+ 1.3.0 runs the workspace graph from `vite.config.ts` and
`scripts/orch-graph.mjs`. Bun 1.4.4 checks each package with `bun check`.
The existing TypeScript 7 build scripts still emit JavaScript, declarations,
declaration maps and source maps, including decorator metadata where configured.
These emit steps remain necessary; Bun checking does not replace them.

Build, typecheck, OpenAPI and package test tasks wait for dependency builds.
Database integration also waits for its own build. Integration and development
commands retain their complete environment and run uncached. Grouped root test
runners still own test discovery, deterministic seeds, coverage and lane budgets.
Published-package builds and the integration runner use explicit named aggregates;
an unknown package name fails instead of silently matching no package.

Cached tasks declare source/configuration and transitive dependency inputs,
including Bun-loaded files. Each command carries the actual Node/Bun/platform
identity; an uncached prerequisite verifies it. Build hits restore `dist/**`.
Generated outputs and ephemeral Vite config paths are excluded from inputs.

The dependency boundary guard parses import syntax with the fleet's TypeScript 6
API alias, while TypeScript 7 remains the emit compiler. It includes type-only
imports, re-exports, import types and literal dynamic imports/require calls.
Undeclared dependencies, imports outside a workspace and parser errors fail.
No tag policy existed in the removed Turbo configuration.

## Qualification

At base `878e8e042a265ef58d81c63c06c439079d3ea69d`, Turbo checked 1,218 files
in 45 packages without a violation and built 2,616 files. The replacement guard
checked the same 1,218 files cleanly; old and new guards reject undeclared
type-only imports and relative imports crossing a package boundary.
The Vite+ build emitted all 2,616 files with identical SHA-256 hashes. All 45
Bun package checks passed. These are local correctness receipts, not hosted-cache
or production performance evidence.

The official Code Foundry 1.48.1 sync was previewed in a disposable clone. Its
stock validation renderer would remove this repository's PostgreSQL qualification
and fail-closed aggregate, so those jobs are preserved and their runtime pins
updated in place. The audit caller's new read-only issue permission remains a
root decision; hosted warm replay and full lane qualification remain outstanding.
