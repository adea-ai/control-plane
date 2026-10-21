# CP #187 — architecture-audit repair bundle and handoff packet

Owner: Fleet 2 / F2W3 — branch `f2w3/cp187-architecture-audit`.

This packet records the corrections root reviewed on draft pull request #1215, the exact evidence
for each of them, and the proposed CI lane and owner handoff. It is the handoff artifact for
root's review of the resulting head.

| Item                      | Value                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                | `adea-ai/control-plane`                                                                                                                                             |
| Branch                    | `f2w3/cp187-architecture-audit`                                                                                                                                     |
| First root-reviewed head  | `51ae5991e38cb25efe452d72ce0863e87cbfef2e`                                                                                                                          |
| Second root-reviewed head | `ccd2d1798efe45804cfd112118af91508086851b` (binding-parser repair)                                                                                                  |
| Files in this bundle      | `scripts/architecture-audit.mjs`, `scripts/m11-architecture-audit-regression.test.mjs`, this packet                                                                 |
| Toolchain                 | Bun 1.4.3, Node 24.21.0, `darwin-arm64`                                                                                                                             |
| Prior evidence packet     | `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` — **unchanged**, and still specific to the base commit `27f17bd55e0266439b5b3089163195c9e7a669be` |

Two root findings are addressed in this bundle. Neither changes a measured value: the architecture
audit's complete output is byte-identical to the first reviewed head. Nothing in the prior
evidence packet is restated, upgraded or withdrawn; no integrated-candidate coverage and no CI
coverage is claimed here.

---

## 1. Finding 1 — the capability-binding detector read names, not code

Root reported that `bindsCapabilityOption` was too permissive: it returned `true` for commented
examples such as `// example: { executionAcceptanceService: adapter }`, for type members such as
`type Options = { executionAcceptanceService: Service }`, and for explicit `undefined` bindings.
That can conceal a missing default: a capability that is only named in a comment, in a type, or
bound to `undefined` is in fact served by the Control API from its unavailable implementation, and
reading it as bound hides that.

All three findings reproduced against `51ae5991e`:

| Input                                                                             | Base head | Required |
| --------------------------------------------------------------------------------- | --------- | -------- |
| `// example: { executionAcceptanceService: adapter }`                             | `true`    | `false`  |
| `/* { executionAcceptanceService: adapter } */`                                   | `true`    | `false`  |
| `type Options = { executionAcceptanceService: Service }`                          | `true`    | `false`  |
| `interface Options { executionAcceptanceService: Service }`                       | `true`    | `false`  |
| `class Composition { readonly executionAcceptanceService: Service }`              | `true`    | `false`  |
| `{ executionAcceptanceService: undefined }`                                       | `true`    | `false`  |
| `const executionAcceptanceService = undefined` + `{ executionAcceptanceService }` | `true`    | `false`  |
| `{ executionAcceptanceService: composition.x }`                                   | `true`    | `true`   |
| `{ executionAcceptanceService }`                                                  | `true`    | `true`   |

### 1.1 The correction

The detector now reads the source with the TypeScript parser instead of matching names, so the
language itself decides what is code, what is a type and what is a comment. A capability counts
as bound only when the source contains a **runtime object literal** that assigns it:

| Source shape                                                      | Base head | After         |
| ----------------------------------------------------------------- | --------- | ------------- |
| object literal key with a real value                              | bound     | bound         |
| object literal shorthand property                                 | bound     | bound         |
| shorthand whose variable is declared `undefined`                  | bound     | **not bound** |
| property whose value is `undefined` or `void 0`                   | bound     | **not bound** |
| property whose value is `undefined ?? fallback`                   | bound     | bound         |
| name inside a line or block comment                               | bound     | **not bound** |
| `type` alias member, `interface` member, class property signature | bound     | **not bound** |
| member access (`composition.x`, `options.x`), index access        | not bound | not bound     |

The public function keeps its name and signature, `bindsCapabilityOption(source, option)`.

`scripts/workspace-boundaries.mjs` already parses this repository's sources with the same
`typescript6` dependency for its import checks, so the tooling now uses one notion of "this is
code" throughout.

### 1.2 The measurement did not change

Root did **not** find the current cloud binding absent, and this correction does not make any
capability absent that was not already absent. The measured per-profile binding matrix is
identical before and after:

| Profile         | Bound | Never bound (served from the unavailable default)                                                                                                                                                                                            | Change |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `cloud`         | 20    | `runtimeNodeCredentialRevocationService`, `toolEffectRecoveryService`                                                                                                                                                                        | none   |
| `hosted-server` | 13    | `admissionControlService`, `credentialAdministrationService`, `marketplaceInstallationService`, `marketplaceRegistryService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `toolEffectRecoveryService` | none   |
| `hosted-simple` | 16    | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | none   |
| `local`         | 16    | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | none   |

The correction removes the _ability_ to conceal a missing default; it does not change any number
that the base evidence packet recorded, and no new finding is asserted here.

---

## 2. Finding 2 — the evidence containment check followed symlinks

Root reported that `validateEvidence` in `scripts/architecture-audit.mjs` checked lexical
containment and then followed symlinks for `stat`, so an in-tree symlink pointing outside the
repository could satisfy the repository-contained evidence check. On the reviewed base
`51ae5991e` that is the block at lines 986-999: `const resolved = resolve(root, evidence.path)`
through the `stat(resolved)` call. This is a boundary-check correctness issue; **no actual
disclosure was observed**.

The defect reproduced against `ccd2d1798` with a synthetic tree: an in-tree symlink whose target
is outside the repository was **accepted** by the base implementation (the base check returned no
reason for it), because the resolved path is lexically inside the root and `stat` follows the
symlink to the outside target.

### 2.1 The correction

`validateEvidence` now delegates to `evidencePathError(root, path, realRoot)`, which compares the
repository root and the evidence target as **canonical real paths** rather than resolved paths:

| Step                                                         | Rule                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| absolute path                                                | rejected — evidence path must be repository-relative |
| lexically outside the root                                   | rejected — evidence path escapes the repository      |
| canonical target outside the canonical root                  | rejected — evidence path escapes the repository      |
| canonical target missing                                     | rejected — evidence path does not exist              |
| canonical target unresolvable (for example a symlink loop)   | rejected — evidence path could not be resolved       |
| canonical target is not a regular file                       | rejected — evidence path is not a file               |
| canonical target is a regular file inside the canonical root | accepted                                             |

The root is canonicalised too, so a checkout that is itself reached through a symlinked path does
not make every in-tree path look like an escape. The target is canonicalised **before** it is
examined, and the file test is applied to the canonical target, so no symlink is followed to a
file outside the root.

Ordinary in-tree evidence behaviour is preserved: the repository contains no symlink outside
`node_modules` and `dist`, all 116 evidence paths in the canonical audit are regular existing
files, and the canonical audit still validates with zero errors.

### 2.2 The regression is hermetic

The new regression builds its own tree in a temporary directory: a synthetic repository root, a
synthetic target **outside** that root, a symlink from the root to that target, an ordinary
in-tree file, an in-tree symlink that stays inside the root, and a symlink that cannot be
resolved. The external target is created by the test and holds only the string
`synthetic external target`; no real or sensitive file is read, and only paths are resolved. The
fixture is removed in a `finally` block and nothing is written into the checkout.

---

## 3. Regression coverage

`scripts/m11-architecture-audit-regression.test.mjs` grows from 16 to 25 tests across this bundle.

| Test                                                                        | Covers                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `does not read a commented binding as a capability binding`                 | finding 1: the exact commented example, a block comment, a trailing comment inside a real options literal, and a comment next to a real binding                                                    |
| `does not read a type-only declaration as a capability binding`             | finding 1: a `type` alias, an `interface`, an optional `interface` member, an exported `interface`, a class property signature, and a type declaration next to a real binding                      |
| `does not read an explicit undefined binding as a capability binding`       | finding 1: `undefined`, `void 0`, a shorthand whose variable is declared `undefined`, a conditional whose branches are both `undefined`, and the `undefined ?? fallback` case that must still bind |
| `keeps reading real runtime object and shorthand bindings`                  | the positive cases: object key with a real value, shorthand, shorthand over a declared value, a conditional spread guard, a quoted key                                                             |
| `does not let a comment conceal a missing default in a real profile source` | end to end: a commented binding appended to the real `apps/control-api/src/index.ts` is still not read as a cloud binding                                                                          |
| `pins the number of capability bindings each profile supplies`              | the measured counts (20 / 13 / 16 / 16) and the disjointness of each profile's bound and unbound sets                                                                                              |
| `rejects an in-tree evidence symlink that points outside the repository`    | finding 2: the escaping symlink is rejected directly and end to end through the audit validator                                                                                                    |
| `keeps accepting ordinary in-tree evidence`                                 | finding 2: a regular in-tree file and an in-tree symlink that stays inside the root remain citable                                                                                                 |
| `rejects an evidence path that cannot be resolved`                          | finding 2: a symlink loop is rejected as unresolvable, not mistaken for a missing file                                                                                                             |

The four evidence cases root did not report — a lexical escape, an absolute path, a directory and
a missing file — remain covered by `rejects evidence that escapes the repository or is not a
file`, with the same expected reasons.

---

## 4. Cost of the corrections

| Measurement                                                                         | First reviewed head | After the bundle |
| ----------------------------------------------------------------------------------- | ------------------- | ---------------- |
| `bun run architecture:check` wall clock                                             | ~1 s                | 4.0 s            |
| `discoverCapabilityBindings`, first call in a process                               | —                   | 2.4 s            |
| `discoverCapabilityBindings`, subsequent calls                                      | —                   | ~30 ms           |
| `discoverArchitecture`, first call / subsequent                                     | —                   | 1.2 s / ~0.2 s   |
| `bun test tests/m11-architecture-audit.test.mjs` (W1's file)                        | 4.10 s              | 7.3 s            |
| `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs` | 8.1 s               | 11.9 s           |

The added cost is the TypeScript parse of the six profile composition sources, paid once per
process. The parse is memoised per file identity (size and modification time), the same memo
pattern `scripts/orch-toolchain.mjs` already uses, so repeated discovery in one process does not
re-parse the tree and an edited file is always re-read. The evidence-path correction adds one
`realpath` and one `stat` per evidence path.

The smoke lane has a reviewed CI ceiling of 90 s against a 68 s baseline (`budgets.json`,
`lanes.smoke`). The added cost is paid once per process and is inside the reviewed headroom; the
lane budget owner should re-measure it on the CI runner.

---

## 5. Gates run on the bundle head

| Gate                           | Command                                                                                                          | Result                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Canonical architecture audit   | `bun run architecture:check`                                                                                     | PASS (exit 0); output byte-identical to `51ae5991e` and to `ccd2d1798`                      |
| W1's existing audit coverage   | `bun test tests/m11-architecture-audit.test.mjs`                                                                 | 7 pass / 0 fail, 193 expects                                                                |
| F2W3 dedicated regression file | `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`                              | 25 pass / 0 fail, 184 expects                                                               |
| Repository smoke lane          | `bun scripts/run-bun-test-group.mjs smoke --timeout 30000`                                                       | recorded in section 5.1                                                                     |
| Full lint lane                 | `bun run lint`                                                                                                   | PASS — 47/47 tasks, 0 boundary violations, digest-writer and canonical-ordering checks pass |
| Formatting                     | `bun x oxfmt --check scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs`          | all matched files use the correct format                                                    |
| Lint                           | `bun x oxlint --deny-warnings scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs` | clean                                                                                       |
| Workspace boundaries           | `bun run check:boundaries`                                                                                       | 1229 files in 45 packages, 0 boundary violations                                            |
| Digest writers                 | `bun run check:digest-writers`                                                                                   | 39 flows matched exact reviewed exceptions                                                  |
| Canonical ordering             | `bun run check:canonical-ordering`                                                                               | pass                                                                                        |
| Migration drift                | `bun run db:check`                                                                                               | `Everything's fine`                                                                         |
| Contract compatibility         | `bun run compatibility:check`                                                                                    | pass                                                                                        |
| Published OpenAPI              | `bun --cwd=packages/control-sdk run openapi:check`                                                               | pass                                                                                        |
| Infrastructure types           | `bun run infra:typecheck`                                                                                        | no type errors in 208 files                                                                 |

### 5.1 Smoke lane result

Recorded verbatim from the run on the bundle head:

```
629 pass
5 skip
0 fail
5756 expect() calls
Ran 634 tests across 44 files. [356.86s]
lane smoke: 357s (budget check is CI-only; SKIP_LANE_BUDGET=1 also skips)
```

Exit code 0. The pass, skip and fail counts are identical to every earlier run on this branch;
the lane wall clock varies between runs and its budget check runs only on the CI runner.

**Skipped, and why:** `bun run requirements:check` needs an authenticated GitHub CLI to read the
issue set and cannot run in this environment; it is F2W2's gate and no requirement file is touched
here. `packages/database/src/integration.test.mjs` needs a live PostgreSQL instance and was not
executed. No live profile, provider, deployment or production action was taken.

---

## 6. Proposed CI lane and owner handoff — proposed only, not applied

Root asked for the exact proposed lane and owner handoff to be documented rather than runner
ownership to be changed silently. **No runner file, lane list or CI registration was edited.**

The regression file lives at `scripts/m11-architecture-audit-regression.test.mjs` because it must
import `scripts/architecture-audit.mjs` directly, and `scripts/workspace-boundaries.mjs` rejects
an import that leaves a package directory. The repository's lane system does not cover `scripts/`:

- `scripts/run-bun-test-group.mjs` (`discoverTestInventory`) walks `apps/`, `packages/` and
  `tests/` only, so a `scripts/**/*.test.mjs` path is not in the lane inventory.
- `tests/repository.test.mjs` asserts the `e2e` and `smoke` lane lists by exact deep equality, and
  the inventory fails closed with `missing [...]` for any lane entry outside those roots.

Two options are available to the runner owner; this work does not choose between them and applies
neither:

1. **Extend the lane roots to `scripts/`.** In `scripts/run-bun-test-group.mjs`, add `scripts` to
   `testRoots` and to the `sourceRoots` used by `discoverTestFiles('unit')`, so the file joins the
   `unit` lane by discovery. `tests/repository.test.mjs` needs no change, because the `unit` lane
   is asserted by inclusion and the inventory and the expected union are both derived from the same
   discovery.
2. **Move and register the file in a covered root.** Move the file to `tests/` and add
   `tests/m11-architecture-audit-regression.test.mjs` to the `smoke` list in
   `scripts/run-bun-test-group.mjs` **and** to the expected `smoke` list in
   `tests/repository.test.mjs`; the two edits must land together or the lane inventory fails
   closed.

Until then the file runs with `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`.
Owner: the test-runner / Code Foundry lane owner (W1/W7 custody, per the Fleet 2 ledger exclusion
"Test runners W1/W7 and global/shared Code Foundry").

---

## 7. Scope and preservation

- The corrections change **only** `scripts/architecture-audit.mjs` and
  `scripts/m11-architecture-audit-regression.test.mjs`, plus this packet.
- W1's `docs/architecture/control-plane-architecture.v1.json` and its generated report, and
  `tests/m11-architecture-audit.test.mjs`, are untouched and still validate byte-identically.
- `scripts/run-bun-test-group.mjs`, `tests/repository.test.mjs` and every CI lane registration are
  untouched; section 6 proposes the handoff only.
- The prior evidence packet
  `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` is untouched and stays
  specific to the base commit it measured. No finding in it is re-stated, upgraded or withdrawn
  here, and the cloud binding matrix is unchanged from what that packet records.
- No runtime source, composition, migration, requirement file or owned-by-another-worker path was
  changed. No credentials, access, provider, deployment or production change was made.
- Auto-merge stays off. No issue is closed and no issue-closing language is used. The existing
  draft pull request was not edited, pushed or republished; publication and the mechanical draft
  update stay with the original controller.

---

## 8. Outstanding gates — explicitly not claimed

1. **Root's review of the resulting patch.** This packet is a handoff for that review; it is not
   an approval and it does not close anything.
2. **Live profile gates.** No profile was deployed and no provider was called. Every profile row
   in the canonical audit stays `partially_verified`.
3. **Integrated-candidate readback.** The prior packet's readback compared the canonical audit's
   recorded candidate `6c922d487c3c2e70a047c11c55a1cb4ddbabad26` with the base commit
   `27f17bd55e0266439b5b3089163195c9e7a669be`. No frozen integrated candidate that includes other
   workers' changes exists in this checkout, and none is claimed.
4. **CI lane registration** for the regression file (section 6).
5. **CI runner lane-budget re-measurement** of the added parse cost (section 4), on the CI runner.
6. **#186 reconciled snapshot.** `bun run requirements:check` cannot run without an authenticated
   GitHub CLI; the snapshot was not consumed and no requirement file was touched.
7. **PostgreSQL integration path.** Not executed; no live database was used.
8. **Human gates.** No human acceptance, sign-off, provider qualification or deployed confirmation
   is claimed anywhere in this packet.
