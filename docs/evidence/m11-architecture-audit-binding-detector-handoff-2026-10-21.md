# CP #187 — capability-binding detector correction and handoff packet

Owner: Fleet 2 / F2W3 — branch `f2w3/cp187-architecture-audit`.

This packet records the correction of the capability-binding detector that root reviewed on draft
pull request #1215, and the exact evidence for it. It is the handoff artifact for root's review of
the resulting head.

| Item                        | Value                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                  | `adea-ai/control-plane`                                                                                                                                             |
| Branch                      | `f2w3/cp187-architecture-audit`                                                                                                                                     |
| Base commit (reviewed head) | `51ae5991e38cb25efe452d72ce0863e87cbfef2e`                                                                                                                          |
| Files changed               | `scripts/architecture-audit.mjs`, `scripts/m11-architecture-audit-regression.test.mjs`, this packet                                                                 |
| Toolchain                   | Bun 1.4.3, Node 24.21.0, `darwin-arm64`                                                                                                                             |
| Prior evidence packet       | `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` — **unchanged**, and still specific to the base commit `27f17bd55e0266439b5b3089163195c9e7a669be` |

Nothing in the prior evidence packet is restated or re-measured here. This packet adds the
correction, its proof and the remaining handoff; it claims no new integrated-candidate coverage
and no CI coverage.

---

## 1. What root reviewed, and what was wrong

Root reviewed the draft pull request at the exact head `51ae5991e38cb25efe452d72ce0863e87cbfef2e`
and reported that `bindsCapabilityOption` was too permissive: it returned `true` for commented
examples such as `// example: { executionAcceptanceService: adapter }`, for type members such as
`type Options = { executionAcceptanceService: Service }`, and for explicit `undefined` bindings.
That can conceal a missing default: a capability that is only named in a comment, in a type, or
bound to `undefined` is in fact served by the Control API from its unavailable implementation, and
reading it as bound hides that.

All three findings reproduced against the base head:

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

---

## 2. The correction

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

The change is confined to `scripts/architecture-audit.mjs`. The public function keeps its name and
signature, `bindsCapabilityOption(source, option)`.

### 2.1 The measurement did not change

Root did **not** find the current cloud binding absent, and this correction does not make any
capability absent that was not already absent. The measured per-profile binding matrix is
identical before and after:

| Profile         | Bound | Never bound (served from the unavailable default)                                                                                                                                                                                            | Change |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `cloud`         | 20    | `runtimeNodeCredentialRevocationService`, `toolEffectRecoveryService`                                                                                                                                                                        | none   |
| `hosted-server` | 13    | `admissionControlService`, `credentialAdministrationService`, `marketplaceInstallationService`, `marketplaceRegistryService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `toolEffectRecoveryService` | none   |
| `hosted-simple` | 16    | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | none   |
| `local`         | 16    | `marketplaceInstallationService`, `modelConnectionService`, `piDurableCurrentToolAuthority`, `piDurableLeadService`, `runtimeNodeCredentialRevocationService`                                                                                | none   |

The complete output of `bun scripts/architecture-audit.mjs` — every warning and the validation
result — is **byte-identical** before and after the correction, verified by running the tool on
the base head and on the corrected tree and diffing the two outputs.

The correction therefore removes the _ability_ to conceal a missing default; it does not change any
number that the base evidence packet recorded, and no new finding is asserted here.

### 2.2 Why the parse is the right instrument

`scripts/workspace-boundaries.mjs` already parses this repository's sources with the same
`typescript6` dependency for its import checks. Using the parser for the capability scan keeps
one notion of "this is code" for the whole tooling, and it is the only way to tell a comment, a
type and a value apart without hand-rolling a scanner — which is the class of defect root
reported.

---

## 3. Regression coverage added

`scripts/m11-architecture-audit-regression.test.mjs` grows from 16 to 22 tests. The six new tests
reproduce root's findings and pin the positive cases:

| Test                                                                        | Reproduces                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `does not read a commented binding as a capability binding`                 | root finding 1: the exact commented example, a block comment, a trailing comment inside a real options literal, and a comment that sits next to a real binding (which must still be read as bound)      |
| `does not read a type-only declaration as a capability binding`             | root finding 2: a `type` alias, an `interface`, an optional `interface` member, an exported `interface`, a class property signature, and a type declaration next to a real binding                      |
| `does not read an explicit undefined binding as a capability binding`       | root finding 3: `undefined`, `void 0`, a shorthand whose variable is declared `undefined`, a conditional whose branches are both `undefined`, and the `undefined ?? fallback` case that must still bind |
| `keeps reading real runtime object and shorthand bindings`                  | the positive cases: object key with a real value, shorthand, shorthand over a declared value, a conditional spread guard, a quoted key                                                                  |
| `does not let a comment conceal a missing default in a real profile source` | end to end: a commented binding is appended to the real `apps/control-api/src/index.ts` and the detector still refuses to read `toolEffectRecoveryService` as bound for the cloud profile               |
| `pins the number of capability bindings each profile supplies`              | the measured counts (20 / 13 / 16 / 16) and the disjointness of each profile's bound and unbound sets                                                                                                   |

---

## 4. Cost of the correction

The detector now parses TypeScript, so the tool pays a parse of the six profile composition
sources once per process. The parse is memoised per file identity (size and modification time),
the same memo pattern `scripts/orch-toolchain.mjs` already uses, so repeated discovery in one
process does not re-parse the tree and an edited file is always re-read.

| Measurement                                                                         | Base head | After          |
| ----------------------------------------------------------------------------------- | --------- | -------------- |
| `bun run architecture:check` wall clock                                             | ~1 s      | 4.0 s          |
| `discoverCapabilityBindings`, first call in a process                               | —         | 2.4 s          |
| `discoverCapabilityBindings`, subsequent calls                                      | —         | ~30 ms         |
| `discoverArchitecture`, first call / subsequent                                     | —         | 1.2 s / ~0.2 s |
| `bun test tests/m11-architecture-audit.test.mjs` (W1's file)                        | 4.10 s    | 7.27 s         |
| `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs` | 8.1 s     | 6.0 s          |

The smoke lane has a reviewed CI ceiling of 90 s against a 68 s baseline
(`budgets.json`, `lanes.smoke`). The added cost is paid once per process and is inside the
reviewed headroom; it is recorded here so root can weigh it, and the lane budget owner can
re-measure it on the CI runner.

---

## 5. Gates run on the corrected tree

| Gate                           | Command                                                                                                          | Result                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical architecture audit   | `bun run architecture:check`                                                                                     | PASS (exit 0); output byte-identical to the base head                                                                                                                                                    |
| W1's existing audit coverage   | `bun test tests/m11-architecture-audit.test.mjs`                                                                 | 7 pass / 0 fail, 193 expects                                                                                                                                                                             |
| F2W3 dedicated regression file | `cd scripts && bun test --timeout 30000 m11-architecture-audit-regression.test.mjs`                              | 22 pass / 0 fail, 178 expects                                                                                                                                                                            |
| Repository smoke lane          | `bun scripts/run-bun-test-group.mjs smoke --timeout 30000`                                                       | 629 pass / 5 skip / 0 fail, 634 tests across 44 files, 455.45 s, exit 0 (same pass/skip/fail counts as the base run; the lane wall clock is not comparable between runs and its budget check is CI-only) |
| Full lint lane                 | `bun run lint`                                                                                                   | PASS — 47/47 tasks, 0 boundary violations, digest-writer and canonical-ordering checks pass                                                                                                              |
| Formatting                     | `bun x oxfmt --check scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs`          | all matched files use the correct format                                                                                                                                                                 |
| Lint                           | `bun x oxlint --deny-warnings scripts/architecture-audit.mjs scripts/m11-architecture-audit-regression.test.mjs` | clean                                                                                                                                                                                                    |
| Workspace boundaries           | `bun run check:boundaries`                                                                                       | 1229 files in 45 packages, 0 boundary violations                                                                                                                                                         |
| Digest writers                 | `bun run check:digest-writers`                                                                                   | 39 flows matched exact reviewed exceptions                                                                                                                                                               |
| Canonical ordering             | `bun run check:canonical-ordering`                                                                               | pass                                                                                                                                                                                                     |
| Migration drift                | `bun run db:check`                                                                                               | `Everything's fine`                                                                                                                                                                                      |
| Contract compatibility         | `bun run compatibility:check`                                                                                    | pass                                                                                                                                                                                                     |
| Published OpenAPI              | `bun --cwd=packages/control-sdk run openapi:check`                                                               | pass                                                                                                                                                                                                     |
| Infrastructure types           | `bun run infra:typecheck`                                                                                        | no type errors in 208 files                                                                                                                                                                              |

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

- The correction changes **only** `scripts/architecture-audit.mjs` and
  `scripts/m11-architecture-audit-regression.test.mjs`, plus this new packet.
- W1's `docs/architecture/control-plane-architecture.v1.json` and its generated report, and
  `tests/m11-architecture-audit.test.mjs`, are untouched and still validate byte-identically.
- `scripts/run-bun-test-group.mjs`, `tests/repository.test.mjs` and every CI lane registration are
  untouched; section 6 proposes the handoff only.
- The prior evidence packet
  `docs/evidence/m11-architecture-reachability-trace-2026-10-21.md` is untouched and stays
  specific to the base commit it measured. No finding in it is re-stated, upgraded or withdrawn
  here.
- No runtime source, composition, migration, requirement file or owned-by-another-worker path was
  changed. No credentials, access, provider, deployment or production change was made.
- Auto-merge stays off. No issue is closed and no issue-closing language is used. The existing
  draft pull request was not edited or pushed; publication stays with the original controller.

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
