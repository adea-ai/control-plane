# Cross-repository Node and Bun toolchain adoption inventory — 2026-10-21

Scope: issue [#1233](https://github.com/adea-ai/control-plane/issues/1233), now
titled "Finish cross-repository Bun and Vite+ toolchain adoption". The issue
approves the full Bun and Vite+ adoption scope, and it no longer approves Bunly.

Status: **the inventory and the reconciliation are complete for every repository
that is reachable, and one adoption check is added to this repository; no version
is changed here.** The one failing check in this repository's unit lane is
pre-existing on `main` and is recorded below with the local branch that carries
its fix. What this increment completes, and what the issue's adoption still
requires, are separated under "Completed here, and what remains" below.

This repository: `adea-ai/control-plane`, branch
`chore/toolchain-adoption-inventory-1233`, base `main` at
`f1bd75c5877f31b809c42b8aa43e2d5b08e3ad14`.

## The approved repository set

The set is not guessed. It is the shared ownership index's own coverage record
(`scopedAdeaRepositoryCoverage20261021T1704Z`), which enumerates eight of the
nine approved Adea repositories and names the missing one:

```
adea-ai/adea  adea-ai/control-plane  adea-ai/cortana  adea-ai/ui
adea-ai/themes  adea-ai/plugins  adea-ai/agent-sim  adea-ai/assets
adea-ai/.github   (the ninth; remote exists, no local checkout)
```

`0xPlayerOne/bunly` is a separate repository, not one of the nine, and **the
current issue no longer approves it**: its text names no Bunly scope. The rows
about Bunly below are therefore retained as prior evidence and as out-of-scope
context, and they are not part of this increment's qualification. Nothing in
Bunly was edited or read as a target; the shared index records it as a separate
fleet repository with an active assignment and an artifact-custody hold.

## The inventory

Each row is read from the repository's own tracked declaration files at the head
named. The contract column is the shared adoption contract: the package manager
declaration, the mise tool pin, the version file the continuous integration
installs from, and the declared engine must name one toolchain, the node engine
must be one exact version, and a bounded bun engine must admit the pinned bun.

| Repository              | Head        | `.mise.toml`                         | `.bun-version` | `.node-version` | `packageManager` | `engines`                         | Contract            |
| ----------------------- | ----------- | ------------------------------------ | -------------- | --------------- | ---------------- | --------------------------------- | ------------------- |
| `adea-ai/control-plane` | `f1bd75c58` | node 24.21.0, bun 1.4.3              | 1.4.3          | 24.21.0         | `bun@1.4.3`      | bun `>=1.4.0 <2`, node 24.21.0    | holds               |
| `adea-ai/adea`          | `d3c24c1c1` | node 24.21.0, bun 1.4.3, java 21.0.2 | absent         | absent          | `bun@1.4.3`      | node 24.21.0                      | holds               |
| `adea-ai/themes`        | `02dbb62b6` | bun 1.4.3 (no node pin)              | absent         | absent          | `bun@1.4.3`      | node 24.22.0                      | holds               |
| `adea-ai/ui`            | `822827e`   | node 24.18.0, bun 1.4.3              | absent         | absent          | `bun@1.4.3`      | node 24.18.0                      | holds               |
| `adea-ai/cortana`       | `19a4031`   | node 24.21.0, bun 1.4.3, rust 1.99.0 | absent         | absent          | `bun@1.4.3`      | node 24.21.0                      | holds               |
| `adea-ai/plugins`       | `e7d9bea`   | bun 1.4.3 (no node pin)              | absent         | absent          | `bun@1.4.3`      | bun `>=1.4.0 <2`, node `>=24 <25` | **does not hold**   |
| `adea-ai/agent-sim`     | —           | not anonymously reachable            | —              | —               | —                | —                                 | not measured        |
| `adea-ai/assets`        | —           | not anonymously reachable            | —              | —               | —                | —                                 | not measured        |
| `adea-ai/.github`       | `b32a045`   | no package manifest and no pin files | absent         | absent          | absent           | absent                            | nothing to hold     |
| `0xPlayerOne/bunly`     | `531b47f5`  | absent                               | 1.4.3          | absent          | `bun@1.4.3`      | bun 1.4.3                         | holds, out of scope |

### What is not uniform

- **Node is not uniform.** `adea-ai/ui` pins 24.18.0, `adea-ai/control-plane`,
  `adea-ai/adea` and `adea-ai/cortana` pin 24.21.0, `adea-ai/themes` pins 24.22.0
  and its two drafts move it to 24.22.1, and `adea-ai/plugins` declares only
  the range `>=24 <25`. The repositories have therefore **not** adopted one
  toolchain, which is what the issue says the two Themes drafts do not prove.
- **Bun is uniform at 1.4.3** in every reachable repository. The one exception
  read locally is the `adea-ai/themes` checkout, which still says `bun@1.4.2` —
  that checkout is _behind_ `main` (`f25a5fa` against `02dbb62b`), and
  `main` already says `bun@1.4.3`. The stale checkout is recorded here so it is
  not read as a divergence.
- **`adea-ai/plugins` is the only repository that does not satisfy the shared
  contract**, because its node engine is a range rather than one exact version.
  It is **not** changed here: choosing an exact version would be a guess, and
  the issue forbids speculative version changes. Its own test support does not
  read `engines` at all — verified in
  `packages/plugins/test-support/portable-fixture.ts` — so the range is a
  contract divergence, not a demonstrated failure.
- **Two repositories pin node in different surfaces.** This repository's
  continuous integration installs the runtimes from `.node-version` and
  `.bun-version`, so those files are the single source of truth. `adea-ai/adea`
  carries the versions as inline literals in its workflows (`node-version:
  24.21.0`, `bun-version: 1.4.3`, and one lane that accepts `node-version: 24`),
  so its workflows are a second source of truth that nothing binds to the
  manifest. The values agree today; nothing keeps them agreeing.

## Related pull requests and local work, by exact head and scope

| Item        | Head                                       | State                                                                          | Scope                                                                                                                                                                |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Themes #106 | `f1e6a2621c6c243ae2667df4a424c95a8eb117b7` | open draft                                                                     | `package.json` only: `engines.node` 24.22.0 to 24.22.1; source branch `renovate/external-dependencies`                                                               |
| Themes #107 | `7f04d2be76801aa73699d73fd5e90e8b5834ac22` | open draft                                                                     | the same `package.json` change **plus** a new `tests/toolchain-compatibility.test.ts`; source branch `recovery/pr106-toolchain-w3-20261021`                          |
| Bunly #85   | `531b47f5e9338afcab40505dc8183a944eedc9a8` | open draft, "perf: adopt Bun-native tooling and enforce repository formatting" | Bun-native tooling, a formatting baseline, TypeScript 7.0.2 for editor tooling; base `main` at `11d98e2`; **out of scope**, the current issue does not approve Bunly |

- **#107 is stacked on #106, and it is not a main-base replacement.** #107
  descends from #106's own commit: the merge base of the two heads is #106's head
  `f1e6a2621c6c243ae2667df4a424c95a8eb117b7`, #106's source branch is
  `renovate/external-dependencies` and #107's is
  `recovery/pr106-toolchain-w3-20261021`. Both drafts share the merge base
  `02dbb62b6` with Themes' `main`, and both carry the same `engines.node` change:
  #107's `package.json` is byte-identical to #106's, and #107 adds only
  `tests/toolchain-compatibility.test.ts` on top of #106's content. #106 remains
  open with that change alone. #107's own test passes at its head (2 passes, 0
  failures), and the draft was qualified at that exact head under Node 24.22.1 and
  Bun 1.4.3 with the repository's own `verify` chain green.
- The Themes contract test asserts that the package manager declaration matches
  the `.mise.toml` bun pin and that the node engine is one exact version. It
  cannot assert a node pin, because Themes' `.mise.toml` pins no node.
- **Bunly is outside the scope the current issue approves**, so the following is
  retained as prior evidence and not as this increment's qualification: **#37
  and #52 are local work and are not published.** `adea-ai/bunly`
  issues #37 ("[M7] Add engine-neutral browser actions and secure developer
  diagnostics") and #52 ("[M10] Add independent browser build profiles and
  shared backend conformance") are open, and the preserved branches
  `feat/m37-portable-browser-actions` at `b4b00f4` and
  `feat/m10-browser-build-profiles` at `fe64d15` carry the work. Both are based
  on `3fc759f9` while Bunly's `main` is at `11d98e2`, so **both are behind
  `main`**, and neither has a pull request. The shared index holds "no new Bunly
  edits until artifact custody established", so nothing in Bunly was edited and
  no claim is made about either branch's readiness.
- **One local branch in this lane carries a fix for a pre-existing failure in
  this repository**: `fix/runtime-gateway-start-authority-marker` at
  `957fe7293` (base `f1bd75c58`). It is a separate scope from this issue and is
  deliberately not folded into this increment; it is unpublished for the same
  reason as the increment below.

## The change in this repository

`tests/repository.test.mjs` gains one test, "the declared toolchain agrees with
the files continuous integration installs from". It binds the four surfaces that
name the toolchain in this repository — the mise tool pin, the version file the
continuous integration installs from, the package manager declaration and the
declared engine — and it asserts that the workflows that install the runtimes
read those two files, so the versions pinned are the versions the lanes run.

This is the adoption increment the issue asks for. It is a check, not a version
change: the repository's own declarations already satisfy the contract, so
nothing here changes a version, and the check makes the agreement permanent
rather than incidental.

The check is proven to bite: with `.node-version` moved to `24.22.0` the file
reports 31 passes and 1 failure on exactly the new assertion, and with the
declared value restored it reports 32 passes and 0 failures.

### The comparator defect that this check carried

The first revision of the check compared two versions with a closure that found
the first differing component and then returned the difference of the **major**
components alone. The comparison therefore decided every same-major pair as
equal: it accepted `1.3.0` against a `>=1.4.0` floor and it rejected `1.4.3`
against a `<1.5.0` ceiling. The declared range happened to survive it only
because the pinned runtime is `1.4.3` and the declared range is `>=1.4.0 <2`,
whose bounds differ from the pin in the major or the patch component.

The comparator now decides on the first component that differs, and the range
check is one helper that the regressions exercise directly. The same-major
boundaries are covered: a version below the lower bound is refused, the lower
bound itself is admitted, a version inside the range is admitted, and the upper
bound and a version above it are refused — for a same-major range and for the
declared range. With the defective comparator in place the file reports 31
passes and 1 failure on those boundaries, and with the correction it reports 32
passes and 0 failures.

No established semver implementation is used instead: `semver` is present in the
workspace only as an undeclared transitive dependency that no repository code
imports, and taking a dependency for one comparison would change the
repository's dependency surface. The corrected comparison is dependency-free.

## Completed here, and what remains

**Completed by this increment.**

- The inventory of the approved repository set and of the divergences it names,
  read from each repository's own tracked declaration files at the head named.
- The reconciliation of the related drafts and preserved local work by exact head
  and scope, including the Themes stacking.
- One adoption check in this repository that binds the mise tool pin, the version
  files the continuous integration installs from, the package manager declaration
  and the declared engine, with the same-major boundary regressions, and the
  comparator correction that the check carried.
- The qualification runs recorded below, with their failures and environmental
  limits retained rather than presented as passes.
- The Bun TypeScript checker's project graph, its generated-type coverage and its
  non-vacuity, qualified with a disposable intentional type error, and the guard
  that now keeps them true.

**Not completed here, and still required by the issue.**

- **The adoption itself.** No repository's toolchain is changed by this
  increment, and the repositories still do not agree: node is 24.18.0, 24.21.0
  and 24.22.0 across them, one repository declares only a range, and two of the
  nine could not be measured at all because they are not anonymously reachable.
- **The wider adoption scope the issue now approves**, none of which this
  increment performs: removing remaining Turbo usage where the migration is
  approved, consolidating Vite+ configuration across the scoped repositories, and
  qualifying Bun TypeScript and applicable Bun APIs with supported pinned
  behaviour rather than version-only bumps.
- **The per-repository evidence checklist** the issue now requires, for the two
  repositories that were not measured and for the Bun, Vite+ and published-version
  qualifications the issue names. The published-dependency ordering also still
  governs: the UI, Plugins and Themes changes and their normal releases must
  exist before any consumer version upgrade is qualified.
- **The `adea-ai/plugins` contract divergence**, which needs its owner to decide
  the exact node engine its range should name; choosing one here would be a
  guess.
- **The node version the lanes install.** In this repository the version file is
  the source of truth and the new check binds it to the manifest. In
  `adea-ai/themes` the node version is declared in `engines.node` while the
  repository's `.mise.toml` pins no node, so the declared version is not the
  version the toolchain resolution reads; the Themes #107 test asserts the
  declaration, and the tool pin is that draft's owner's decision.
- **The pre-existing runtime-gateway authority-marker failure** in this
  repository's unit lane, which is fixed on a separate local branch that is not
  published.
- **The checker qualification of the repositories that were not measured.**
  `adea-ai/agent-sim` and `adea-ai/assets` are not anonymously reachable, so
  their checker graphs, generated types and failing-fixture exit codes are not
  qualified here, and the per-repository checklist the issue requires is not
  complete for them.
- **The Bun APIs the issue names beyond the checker.** The checker's own graph,
  generated types and exit codes are qualified here; the applicable Bun APIs
  beyond the checker are not, and no API or version was substituted to reach a
  green result.

## The Bun TypeScript checker: project graph, generated types, and a disposable failure

The issue now approves qualifying the Bun TypeScript checker and the applicable Bun
APIs with supported, pinned behaviour, and names the checker project graph, the
generated types, the intentional failing fixtures and their exit codes, and the
required build and declaration generation. This section records what was measured
on the repository as it stands, under the repository's own pinned tooling: **Bun
1.4.3** and **Node 24.21.0**, the versions the manifest and the toolchain files
name. Nothing was substituted and no version was changed.

### The checker project graph

The repository holds 47 `tsconfig` projects, and they are not all the same kind of
thing:

| Kind                                              | Count | Reached by                                                        |
| ------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| Checked package and application projects          | 45    | one `bun check -p tsconfig.json` per package, all of them present |
| The shared base, `tsconfig.base.json`             | 1     | extended by all 45 checked projects                               |
| The infrastructure project, `tsconfig.infra.json` | 1     | `bun run infra:typecheck`                                         |
| The repository root project, `tsconfig.json`      | 1     | **nothing**: no project extends it and no command checks it       |

The root project is worth naming, because it is the one that would mislead a
reader: it extends the shared base, it declares the two decorator options, and it
names **no** files, so a project that inherited it would take its whole directory
into the check rather than the sources its own `include` names. The one package
that uses decorators, `apps/control-api`, declares the decorator options in its
own project, so the check is correct where the decorators are.

### The generated types

Every checked project resolves the types of the other workspace packages from
their **built** declarations, so the check is only meaningful when those
declarations exist. The graph orders it: a package's `typecheck` task depends on
the `build` task of every workspace package it depends on, over dependencies,
development dependencies, peer dependencies and optional dependencies alike, and
the aggregate `orch:check` depends on `orch:build`, `orch:typecheck` and
`orch:openapi:check`. The build therefore produces the declarations before the
checker resolves against them.

### The disposable intentional type error

The type error is written into an **isolated disposable project outside the
repository**: a temporary directory carrying its own `package.json`
(`{"type": "module"}`), a `tsconfig.json` that extends this repository's
`tsconfig.base.json` and names the probe file, and the probe itself:

```
export const cp1233TypecheckProbe: number = 'not a number'
```

The check is run with the repository's pinned Bun against that project, so the
failure means the pinned checker rejects a type error under this repository's own
strict configuration — and the repository's tree is never written at all. The
measured result:

- a **clean** disposable project exits **0** with
  `✓ No type errors in 1 file`, so the failure below is not an artefact of the
  disposable project;
- the same project with the intentional error exits **1** and reports it where it
  was written:
  `<error file=".../probe.ts" line="1" column="14" code="TS2322">`,
  `Type 'string' is not assignable to type 'number'.`, and
  `Found 1 error in 1 file, checked 1 file`;
- the temporary directory is removed afterwards, and the repository's tree is
  exactly as it was.

So the checker is not vacuous, and nothing is left behind. An earlier revision of
this proof wrote the probe into a package's own source directory and removed it
afterwards; the isolated project is used instead, so a run that is interrupted
cannot leave a file in the tree.

### The gaps this found, and the guard that now prevents them

Two real gaps were found, and neither was guarded by anything in the repository:

1. **Nothing asserted that the check graph still covers the workspace.** A package
   whose `typecheck` script was renamed, or a workspace dependency that dropped
   out of the graph's dependency set, would have left the check running against
   stale or missing declarations with nothing to notice.
2. **Nothing proved the checker can still fail, or that the checked projects
   still cover their own sources.** A project whose `include` was emptied, or
   narrowed past the sources, would still have reported "no type errors" for every
   package, and the whole lane would have stayed green.

`tests/repository.test.mjs` now carries one guard that closes both, and it is
proven to bite:

- it asserts that every workspace package with a `typecheck` script has a
  typecheck task in the graph, that the task runs that package's own checker, that
  it waits for the build of every workspace dependency, and that the aggregate
  depends on the build, the type checks and the openapi check;
- it asserts that every checked project inherits the shared base rather than a
  project that names no files;
- it proves that every checked project still names at least one of its own
  sources, so a project that covers nothing cannot pass;
- it proves the checker is not vacuous with an isolated disposable project: a clean
  project must typecheck, the same project with an intentional type error must
  exit nonzero and name the file, and the temporary directory is removed
  afterwards, so no file in the repository is ever written.

The mutations that make the guard fail, each applied and then reverted: narrowing
a package's `include` past its own sources fails "tool-sdk's checked project must
name at least one of its own sources"; a disposable project that includes nothing
fails "the checker must fail on an intentional type error"; removing the dependency
builds from the graph fails "runtime-gateway's check must wait for bootstrap's
build"; and making a checked project inherit the root project fails "tool-sdk must
extend the shared base".

## The checks that were run, and their results

### This repository, `adea-ai/control-plane`

| Check                                  | Exit | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`        | 0    | 374 packages installed                                                                                                                                                                                                                                                                                                                                                                       |
| `bun run build`                        | 0    | vp run 47/47 successful                                                                                                                                                                                                                                                                                                                                                                      |
| `vp run orch:check`                    | 0    | vp run 97/97 successful                                                                                                                                                                                                                                                                                                                                                                      |
| `bun run db:check`                     | 0    | `Everything's fine`                                                                                                                                                                                                                                                                                                                                                                          |
| `bun run compatibility:check`          | 0    | passed                                                                                                                                                                                                                                                                                                                                                                                       |
| `bun run architecture:check`           | 0    | 45 packages, 54 operations, 4 profiles validated                                                                                                                                                                                                                                                                                                                                             |
| `bun run infra:typecheck`              | 0    | no type errors in 208 files                                                                                                                                                                                                                                                                                                                                                                  |
| `bun run requirements:check`           | 1    | `Unable to query GitHub issues through authenticated GitHub CLI (exit 4)` — **environmental limit**: the check queries the live issues through an authenticated GitHub CLI, and no such route exists here                                                                                                                                                                                    |
| `bun run format:check`                 | 0    | clean, 1938 files                                                                                                                                                                                                                                                                                                                                                                            |
| `bun run lint`                         | 0    | 1230 files in 45 packages, 0 boundary violations; canonical ordering passed; 39 digest flows matched                                                                                                                                                                                                                                                                                         |
| `bun test ./tests/repository.test.mjs` | 0    | 32 passes, 0 failures                                                                                                                                                                                                                                                                                                                                                                        |
| seeded unit lane with coverage         | 1    | 4351 pass, 11 skip, **1 fail**, 4363 tests over 465 files, 168s. The failure is `Runtime Gateway production startup > forwards the host credential authority in an isolated subprocess`, and it is **pre-existing on `main`**: the fixture's only marker is the name of a passing test, and the reporter prints the name of a failing test. The fix is the separate local branch named above |
| seeded smoke lane                      | 0    | 662 pass, 5 skip, 0 fail, 667 tests over 44 files, 148s                                                                                                                                                                                                                                                                                                                                      |

### The other repositories

| Repository                            | Checks                                                                                    | Result                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adea-ai/themes`                      | the contract test from its own draft #107, at that head, under Node 24.22.1 and Bun 1.4.3 | 2 pass, 0 fail; the repository's own `verify` chain (format, typecheck, lint, catalogue, test, build) exits 0, with the test lane at 142 pass, 0 fail, 15,415 assertions over 6 files |
| `adea-ai/adea`                        | `format:check`, `oxlint`, `typecheck`                                                     | clean over 2963 files; no findings; vp run 33/33 successful                                                                                                                           |
| `adea-ai/ui`                          | install, `typecheck`                                                                      | install passed; vp run 4/4 successful                                                                                                                                                 |
| `adea-ai/cortana`                     | install, `typecheck`                                                                      | installed; vp run 3/3 successful                                                                                                                                                      |
| `adea-ai/plugins`                     | install, `lint`, `type-check`, `format:check`, unit lane                                  | install, lint (no findings), type-check (no type errors in 37 files) and format (113 files) pass; the unit lane reports **3 failures** in 237 tests                                   |
| `adea-ai/agent-sim`, `adea-ai/assets` | —                                                                                         | not anonymously reachable, so not measured; no local checkout                                                                                                                         |
| `adea-ai/.github`                     | —                                                                                         | no toolchain surface to check                                                                                                                                                         |
| `0xPlayerOne/bunly`                   | inventory only, out of scope                                                              | read only; under an artifact-custody hold and outside the current issue's approved scope, so no check was run and nothing was edited                                                  |

The three `adea-ai/plugins` failures are one environmental limit, not three
defects: `selectPinnedNode` refuses any runtime that is not Node 24, because an
unpinned Node would change which artifact is under test, and this machine
exposes no Node 24 in the location the fixture looks in and none on the path its
child process resolves. The failure message is the fixture's own, "the
compiled-import qualification needs Node 24". It is retained here as a failure
and is not represented as a pass.

## The holds that are preserved

No credential was created, read or used; no credential helper and no
`GH_TOKEN` was used. No native, migration, human-acceptance or production action
was taken, nothing was deployed or released, no security setting was changed,
and no issue was closed. No version was guessed and no check was weakened or
bypassed. The unrelated dirty work in the shared `adea-ai/control-plane`
checkout (nine paths on `feat/1021-native-route-pre-effect-controls`) and in
every other worktree was left exactly as it was.

## Publication

The increment is one documentation file and one test, with the checks above. It
is a draft with auto-merge off, and it is not ready, not merged, and closes
nothing.
