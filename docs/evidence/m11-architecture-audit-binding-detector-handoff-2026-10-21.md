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
| Third root-reviewed head  | `fc169f506ec98432883af6cd26bcc8a0101570f3` (evidence-path repair)                                                                                                   |
| Fourth root-reviewed head | `70017bd9ae7a46a8a58aada372f9e75166004d02` (parse-cache identity)                                                                                                   |
| Recovery head             | `bcea5ae46bd30179b66124b76e76ea9528a7b266` (canonical CI discovery — section 11)                                                                                    |
| Files in this bundle      | `scripts/architecture-audit.mjs`, `scripts/m11-architecture-audit-regression.test.mjs`, this packet                                                                 |
| Toolchain                 | Bun 1.4.3, Node 24.21.0, `darwin-arm64`                                                                                                                             |
| Prior evidence packet     | `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` — **unchanged**, and still specific to the base commit `27f17bd55e0266439b5b3089163195c9e7a669be` |

Three root findings are addressed in this bundle. None of them changes a measured value: the
architecture audit's complete output is byte-identical to the first reviewed head, and the measured
per-profile capability matrix is unchanged. Nothing in the prior evidence packet is restated,
upgraded or withdrawn; no integrated-candidate coverage and no CI coverage is claimed here.

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

## 3. Finding 3 — the parse cache was keyed by the relative path

Root reported that `parsedBindingSites` cached by relative path, modification time and size while
parsing `resolve(root, path)`, so sequential audits of two checkout roots with the same relative
path, the same size and the same modification time, but different binding contents, could reuse the
wrong checkout's parse.

The defect reproduced against `fc169f506`: with two synthetic roots whose matching files have the
same relative path, the same byte length and the same timestamp, the second root reported the
first root's answer — the second root claimed a capability was bound that its own sources do not
bind.

### 3.1 The correction

The cache entry is now keyed by the **canonical target path** and validated by the **content
hash**, so the entry identity is the file the parse came from:

| Aspect                        | Before                                | After                                                   |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Cache key                     | the relative path                     | the canonical absolute target path                      |
| Change identity               | modification time and size            | the SHA-256 of the file contents                        |
| Two roots, same relative path | one shared entry                      | one entry per root                                      |
| File edited in place          | detected only if time or size changed | always detected                                         |
| Parse reuse                   | across any root                       | only for the same canonical file with the same contents |

The entry is validated against the content hash rather than a timestamp, so the reuse rule is
exact: an entry is reused only when the bytes it was parsed from are the bytes on disk now. The
parse is still the expensive step and is still reused, so the cost does not regress.

### 3.2 The regression is hermetic and deterministic

`createTwoRootBindingFixture` builds two synthetic checkout roots. In each root every profile
binding source path is written with one of two contents that are **exactly the same byte length**:
one binds `executionAcceptanceService` with a real value, the other binds it to `undefined` and so
does not bind it. The fixture asserts the two lengths are equal, and it sets the same fixed
modification time on every file with `utimes`, so the two roots are indistinguishable by relative
path, size and timestamp. The test then audits the first root and the second root in one process
and requires the two answers to differ. Against the pre-fix cache the second assertion fails.

---

## 4. Shorthand-binding scope: inspection result and the conservative rule

Root asked whether the actual admitted profile sources exercise shorthand-binding shadowing or
lexical scopes, and said not to build a broad typechecker or dataflow analyzer.

### 4.1 What the admitted sources contain

The six admitted profile composition sources were parsed and every shorthand property whose name
is one of the 21 unavailable-default capability options was enumerated:

| Source                                         | Shorthand capability bindings | Capability names declared more than once |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------- |
| `apps/control-api/src/index.ts`                | 15                            | none                                     |
| `apps/control-api/src/cloud-composition.ts`    | 3                             | none                                     |
| `apps/local-control-plane/src/index.ts`        | 2                             | none                                     |
| `apps/hosted-control-plane/src/index.ts`       | 0                             | none                                     |
| `apps/hosted-control-plane/src/composition.ts` | 0                             | none                                     |
| `apps/local-control-plane/src/composition.ts`  | 0                             | none                                     |

20 shorthand capability bindings in total. For each one the declaration that actually binds the
name at that site was resolved by walking the lexical scopes, and compared with the
first-declaration-in-file-order lookup the detector uses:

| Check                                                        | Result |
| ------------------------------------------------------------ | ------ |
| shorthand capability bindings examined                       | 20     |
| with no declaring scope found                                | 0      |
| where the first declaration differs from the declaring scope | 0      |

**No admitted profile source exercises shorthand-binding shadowing or a lexical-scope
divergence.** Every capability name is declared at most once in the file that uses it, and that
declaration encloses the shorthand site, so the conservative lookup is exact for the admitted
sources.

### 4.2 The conservative rule and its limits

The detector resolves a shorthand property's value by looking up the **first declaration of that
name anywhere in the file** and asking whether its initializer is `undefined`. Scope is not
resolved, and the lookup deliberately stays that simple:

- **It is exact when** the name is declared at most once in the file and that declaration is
  visible at the shorthand site. That is the case for all 20 admitted shorthand bindings.
- **It can be wrong when** a name is declared more than once (shadowing), because the lookup
  takes the first declaration in file order rather than the one in scope. It can also be wrong
  when the only declaration of the name sits in a scope that does not enclose the shorthand site.
- **Both error directions are possible.** A first declaration of `undefined` that the shorthand
  does not actually reference makes the detector report a binding that is not there, which
  conceals a missing default. A first declaration with a real value that the shorthand does not
  reference makes the detector report a capability as unbound that the profile does bind, which
  would assert absence that is not true.
- **No scope-resolving analyzer was added.** Resolving the binding correctly needs the real
  declaration of each name at each site, which is type- and flow-sensitive, and the audit needs a
  conservative, reproducible answer rather than an inferred one. A scope-only lookup would
  resolve the admitted sources exactly, but it would not be a bound on the remaining ambiguity,
  and it would add machinery for a case the admitted sources do not contain.
- **What to do if it changes.** The binding matrix is pinned by a regression test
  (`pins the number of capability bindings each profile supplies`), so a composition that starts
  declaring a capability name twice, or moving a shorthand out of its declaration's scope, fails
  that test and forces the measurement to be reviewed rather than silently reinterpreted.

---

## 5. Regression coverage

`scripts/m11-architecture-audit-regression.test.mjs` grows from 16 to 28 tests across this bundle.

| Test                                                                                | Covers                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `does not read a commented binding as a capability binding`                         | finding 1: the exact commented example, a block comment, a trailing comment inside a real options literal, and a comment next to a real binding                                                                       |
| `does not read a type-only declaration as a capability binding`                     | finding 1: a `type` alias, an `interface`, an optional `interface` member, an exported `interface`, a class property signature, and a type declaration next to a real binding                                         |
| `does not read an explicit undefined binding as a capability binding`               | finding 1: `undefined`, `void 0`, a shorthand whose variable is declared `undefined`, a conditional whose branches are both `undefined`, and the `undefined ?? fallback` case that must still bind                    |
| `keeps reading real runtime object and shorthand bindings`                          | the positive cases: object key with a real value, shorthand, shorthand over a declared value, a conditional spread guard, a quoted key                                                                                |
| `does not let a comment conceal a missing default in a real profile source`         | end to end: a commented binding appended to the real `apps/control-api/src/index.ts` is still not read as a cloud binding                                                                                             |
| `pins the number of capability bindings each profile supplies`                      | the measured counts (20 / 13 / 16 / 16) and the disjointness of each profile's bound and unbound sets                                                                                                                 |
| `rejects an in-tree evidence symlink that points outside the repository`            | finding 2: the escaping symlink is rejected directly and end to end through the audit validator                                                                                                                       |
| `keeps accepting ordinary in-tree evidence`                                         | finding 2: a regular in-tree file and an in-tree symlink that stays inside the root remain citable                                                                                                                    |
| `rejects an evidence path that cannot be resolved`                                  | finding 2: a symlink loop is rejected as unresolvable, not mistaken for a missing file                                                                                                                                |
| `parses two checkout roots separately when their files share a path, size and time` | finding 3: two roots with the same relative path, byte length and modification time, but different binding contents, are parsed separately, and re-auditing the first root afterwards returns the first root's answer |
| `re-parses a source whose contents change while its size and time do not`           | finding 3: the same path rewritten with the same byte length and the same modification time is parsed again, because the content hash is the change identity                                                          |
| `documents the conservative first-declaration rule for a shadowed shorthand`        | the lexical-scope limit in section 4: a shadowed shorthand resolves by file order, not by scope, and the limit is pinned so it stays visible                                                                          |

The four evidence cases root did not report — a lexical escape, an absolute path, a directory and
a missing file — remain covered by `rejects evidence that escapes the repository or is not a
file`, with the same expected reasons.

---

## 6. Cost of the corrections

| Measurement                                                                         | First reviewed head | After the bundle       |
| ----------------------------------------------------------------------------------- | ------------------- | ---------------------- |
| `bun run architecture:check` wall clock                                             | ~1 s                | 4.0 s                  |
| `discoverArchitecture`, first call in a process                                     | —                   | 1.2 s cold, 0.1 s warm |
| `discoverCapabilityBindings`, first call / subsequent                               | —                   | 0.15 s warm / 2–3 ms   |
| `bun test tests/m11-architecture-audit.test.mjs` (W1's file)                        | 4.10 s              | 2.1 s warm             |
| `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs` | 8.1 s               | 1.2 s warm             |

The added cost is the TypeScript parse of the six profile composition sources, paid once per
process. The parse is reused across calls in a process; since finding 3 the reuse is keyed by the
canonical target and validated by the content hash, so it stays exact.

The smoke lane has a reviewed CI ceiling of 90 s against a 68 s baseline (`budgets.json`,
`lanes.smoke`). The lane budget owner should re-measure the added parse cost on the CI runner.

---

## 7. Checks run on the bundle head

This task's scope is a bounded correctness repair, so the checks are the focused pinned ones for
the changed tooling. What was run, and what was deliberately not run, are recorded exactly.

| Check                           | Command                                                                                                          | Result                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| F2W3 dedicated regression file  | `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`                              | 28 pass / 0 fail, 196 expects                                                                 |
| W1's existing audit coverage    | `bun test tests/m11-architecture-audit.test.mjs`                                                                 | 7 pass / 0 fail, 193 expects                                                                  |
| Canonical architecture audit    | `bun run architecture:check`                                                                                     | PASS (exit 0); output byte-identical to `51ae5991e`, `ccd2d1798`, `fc169f506` and `70017bd9a` |
| Formatting of the changed files | `bun x oxfmt --check scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs`          | all matched files use the correct format                                                      |
| Lint of the changed files       | `bun x oxlint --deny-warnings scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs` | clean                                                                                         |
| Measured capability matrix      | `discoverCapabilityBindings` on the checkout                                                                     | unchanged: cloud 20, hosted-server 13, hosted-simple 16, local 16, with the same unbound sets |

**Pinned dependency resolution.** `@control-plane/runtime-sdk` resolves in this checkout: the workspace
symlink `node_modules/@control-plane/runtime-sdk -> packages/runtime-sdk` is present and the built
`packages/runtime-sdk/dist/index.js` is in place, so the audit's dynamic import of the SDK operation
registry succeeds (141 exports resolved). No dependency was changed and no package was installed.

**Toolchain note.** This environment currently has Bun 1.4.3 (the version pinned by `.bun-version`) but
no Node 24.21.0 binary: the toolchain install under the session directory holds only
`npm`/`corepack`/`npx` for Node. The `vp run` lanes execute `node scripts/orch-toolchain.mjs` to verify the
toolchain identity, so the full build, lint and smoke lanes cannot be executed here, independently of
this task's instruction to run focused and static checks only.

**Not run in this task, by instruction:** no full build, no coverage run, no full smoke lane, no
full lint lane. The last full smoke-lane result on this branch is the one recorded for the
`fc169f506` bundle head — 629 pass / 5 skip / 0 fail across 634 tests in 44 files, exit 0 — and the
lane budget owner should re-measure after this repair lands.
full lint lane. The last full smoke-lane result on this branch is the one recorded for the
`fc169f506` bundle head — 629 pass / 5 skip / 0 fail across 634 tests in 44 files, exit 0 — and the
lane budget owner should re-measure after this repair lands.

**Also not run, and why:** `bun run requirements:check` needs an authenticated GitHub CLI to read
the issue set and cannot run in this environment; it is F2W2's gate and no requirement file is
touched here. `packages/database/src/integration.test.mjs` needs a live PostgreSQL instance and
was not executed. No live profile, provider, deployment or production action was taken.

---

## 8. Proposed CI lane and owner handoff — proposed only, not applied

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

## 9. Scope and preservation

- The corrections change **only** `scripts/architecture-audit.mjs` and
  `scripts/m11-architecture-audit-regression.test.mjs`, plus this packet.
- W1's `docs/architecture/control-plane-architecture.v1.json` and its generated report, and
  `tests/m11-architecture-audit.test.mjs`, are untouched and still validate byte-identically.
- `scripts/run-bun-test-group.mjs`, `tests/repository.test.mjs` and every CI lane registration are
  untouched; section 8 proposes the handoff only.
- The prior evidence packet
  `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` is untouched and stays
  specific to the base commit it measured. No finding in it is re-stated, upgraded or withdrawn
  here, and the cloud binding matrix is unchanged from what that packet records.
- No runtime source, composition, migration, requirement file or owned-by-another-worker path was
  changed. No credentials, access, provider, deployment or production change was made.
- Auto-merge stays off. No issue is closed and no issue-closing language is used, and no claim is
  made that CP #187 is complete. The existing draft pull request was not edited, pushed or
  republished; publication and the mechanical draft update stay with the original controller.

---

## 10. Outstanding gates — explicitly not claimed

1. **Root's full-scope review of the resulting patch.** This packet is a handoff for that review;
   it is not an approval, and it does not close anything.
2. **Live profile gates.** No profile was deployed and no provider was called. Every profile row
   in the canonical audit stays `partially_verified`.
3. **Integrated-candidate readback.** The prior packet's readback compared the canonical audit's
   recorded candidate `6c922d487c3c2e70a047c11c55a1cb4ddbabad26` with the base commit
   `27f17bd55e0266439b5b3089163195c9e7a669be`. No frozen integrated candidate that includes other
   workers' changes exists in this checkout, and none is claimed.
4. **CI lane registration** for the regression file (section 8). The audit now discovers this gap
   canonically rather than describing it in prose — see section 11.
5. **CI runner lane-budget re-measurement** of the added parse cost (section 6), on the CI runner.
6. **#186 reconciled snapshot.** `bun run requirements:check` cannot run without an authenticated
   GitHub CLI; the snapshot was not consumed and no requirement file was touched.
7. **PostgreSQL integration path.** Not executed; no live database was used.
8. **Human gates.** No human acceptance, sign-off, provider qualification or deployed confirmation
   is claimed anywhere in this packet.

---

## 11. Canonical CI discovery — the lane gap is now discovered, not described

Section 8 left the CI-lane question as prose for the lane owner. This section makes the audit
answer it canonically, inside the audit's own scope. **No shared runner file, lane list or CI
registration was edited**: `scripts/run-bun-test-group.mjs` and `tests/repository.test.mjs` are
byte-identical to the previous head.

### 11.1 What the discovery does

`scripts/architecture-audit.mjs` gains two exported functions.

`discoverArchitectureCiCoverage(rootUrl, options)` answers one question: **which canonical CI lane
runs each of the architecture audit's own test files?**

- The **audit's own test files** are discovered by what they import — a `*.test.mjs` file that
  imports `architecture-audit.mjs` is a test of the audited module. The answer is a property of the
  tree, not of a list written next to the tool, so a new audit test file is covered the moment it
  exists and a file that only _names_ an audit test is not counted as one.
- The **lane inventory** is read from the shared runner's own exported discovery
  (`discoverTestInventory()`), imported read-only as a library. The lane model is therefore not
  re-implemented here: this reports the lanes the repository actually runs.
- The inventory is read defensively. It fails closed on lane drift, and that drift is captured as
  `inventoryError` and reported as a finding rather than taking the audit down.

`validateArchitectureCiCoverage(coverage)` turns that into findings. A file no canonical lane runs
is reported as a **warning**, never as an error: a lane-registration gap belongs to the lane owner,
and the canonical audit record and its generated report stay byte-identical either way.

### 11.2 What it found on this checkout

| Audit test file                                      | Canonical lane | Status                               |
| ---------------------------------------------------- | -------------- | ------------------------------------ |
| `tests/m11-architecture-audit.test.mjs`              | `smoke`        | covered by a canonical lane          |
| `scripts/m11-architecture-audit-regression.test.mjs` | none           | **not run by any canonical CI lane** |

`bun run architecture:check` therefore now prints:

```
Architecture audit warning: architecture audit test file scripts/m11-architecture-audit-regression.test.mjs is not run by any canonical CI lane (e2e, integration, smoke, unit)
```

and still validates: `Validated 45 packages, 54 operations, and 4 profiles`.

This is the same gap section 8 described, now produced by the repository's own canonical lane
discovery rather than by an author's reading of it. **The gate is not closed by this**: the
registration itself is still the lane owner's, and section 8's two options are unchanged and still
unapplied.

### 11.3 The regression coverage added

`scripts/m11-architecture-audit-regression.test.mjs` grows from 28 to 35 tests.

| Test                                                                         | Covers                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discovers the architecture audit test files by what they import`            | the two audit test files are found, and a file that only names an audit test is not counted                                                                  |
| `records the canonical CI lane that runs a covered audit test file`          | `tests/m11-architecture-audit.test.mjs` is in the canonical `smoke` lane                                                                                     |
| `pins the audit regression file that no canonical CI lane runs`              | the open gap is pinned: when the lane owner registers the file, this pin fails and the registration is reviewed rather than silently reinterpreted           |
| `reports an uncovered audit test file as a warning and never as an error`    | the gap never fails the audit and never changes the canonical record                                                                                         |
| `reports lane inventory drift instead of failing the coverage discovery`     | a drift in the canonical inventory is reported as a finding, not a crash                                                                                     |
| `discovers the audit test files of a synthetic checkout by import`           | the discovery is hermetic: a synthetic tree with an importing file, a file that only names the audit, and an unrelated file yields exactly the importing one |
| `the canonical CI discovery leaves the canonical audit and report unchanged` | the discovery is read-only with respect to the canonical artifacts                                                                                           |

### 11.4 Checks run on the recovery head

| Check                                                       | Command                                                                                                          | Result                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Dedicated regression file                                   | `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`                              | **35 pass / 0 fail**, 210 expects (was 28 / 196)                                                                 |
| W1's existing audit coverage                                | `bun test tests/m11-architecture-audit.test.mjs`                                                                 | **7 pass / 0 fail**, 193 expects — unchanged                                                                     |
| Canonical architecture audit                                | `bun run architecture:check`                                                                                     | **PASS**; the canonical record and the generated report are byte-identical; one new warning, the CI coverage one |
| Railway production plan (in this bundle)                    | `bun test tests/railway-production-plan.test.mjs`                                                                | **16 pass / 0 fail**                                                                                             |
| Formatting                                                  | `bun run format:check`                                                                                           | **PASS** — 1,940 files use the correct format                                                                    |
| Lint of the changed files                                   | `bun x oxlint --deny-warnings scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs` | clean                                                                                                            |
| Workspace boundaries (the new runner import)                | `bun run check:boundaries`                                                                                       | **0 boundary violations** — 1,229 files across 45 packages                                                       |
| Full workspace build (the repository's own pre-commit gate) | `vp run orch:build` via `.githooks/pre-commit`                                                                   | **47/47 successful** on the declared toolchain (node 24.21.0, bun 1.4.3)                                         |
| Canonical smoke lane                                        | `bun scripts/run-bun-test-group.mjs smoke --timeout 30000`                                                       | **629 pass / 5 skip / 0 fail** across 634 tests in 44 files, 5,756 expects, **60.4 s**                           |

The smoke-lane result is identical to the one the bundle recorded for `fc169f506` — 629 pass / 5 skip /
0 fail across 634 tests in 44 files — so the lane is unchanged by the recovery head. The lane's
measured wall clock is **60.4 s** against the 68 s baseline recorded in section 6 and the 90 s
reviewed CI ceiling. That is a **local** measurement on this host, not the CI runner, so the
lane-budget owner's re-measurement on the CI runner is still outstanding; the local number is
recorded because it shows the added parse cost does not move the lane towards its ceiling.

The unit lane was not run: the recovery head changes `scripts/` and `docs/evidence/` only, the full
workspace build already passed, and the smoke lane covers both audit test files that the canonical
inventory discovers.

**Cost of the discovery.** The added work is one repository-wide source walk and the canonical
lane inventory, paid once per `bun run architecture:check`: measured over three runs each on this
checkout, `0.23s` before the change and `0.27s` after it. The added cost is therefore about
**0.04 s**. The smoke-lane budget question in section 6 is unchanged by this and still belongs to
the lane-budget owner.

**Toolchain note.** This recovery ran on Bun 1.4.2 (the sandbox's Bun) rather than the pinned
Bun 1.4.3, and with no Node 24.21.0 binary available, so the `vp run` lanes (full build, lint,
smoke) were not executed. The focused checks above were. The checkout had no installed
dependencies, so `bun install --frozen-lockfile` was run first (374 packages) and the three
workspace packages the audit imports dynamically (`contracts`, `runtime-sdk`, `control-sdk`) were
built with `tsc -p tsconfig.json` so that the audit's SDK import resolves. No dependency was
changed and no package was published.

### 11.5 Scope and preservation

- The change touches only `scripts/architecture-audit.mjs`,
  `scripts/m11-architecture-audit-regression.test.mjs` and this packet.
- `scripts/run-bun-test-group.mjs`, `tests/repository.test.mjs`, every CI lane registration and
  every shared runner are **untouched**; the runner is imported read-only.
- `docs/architecture/control-plane-architecture.v1.json` and the generated
  `docs/architecture/control-plane-architecture.md` are **untouched** and still validate
  byte-identically; the prior evidence packet is untouched.
- No runtime source, composition, migration, requirement file, or owned-by-another-worker path was
  changed. No credentials, keychain, secret store, provider, deployment or production change was
  made, and no live or native acceptance is claimed.
- Auto-merge stays off. No issue is closed and no issue-closing language is used. Nothing here
  claims that CP #187 is complete.
