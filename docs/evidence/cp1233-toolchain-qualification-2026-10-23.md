# Cross-repository toolchain qualification: 2026-10-23

Issue: [#1233](https://github.com/adea-ai/control-plane/issues/1233). This is a partial acceptance receipt. Dependency budget acceptance remains separate in [#1230](https://github.com/adea-ai/control-plane/issues/1230).

A read-only reconciliation recorded one day later is appended at [Dated status: 2026-10-24](#dated-status-2026-10-24). The October 23 receipt itself is unchanged historical evidence: every command, failure, head, count and hash below still refers to the sources recorded there.

## Source inventory

GitHub main identities were read using authenticated `gh api repos/adea-ai/REPO/commits/main --jq .sha`. Inventory and command results below apply to those immutable sources, not to older shared checkouts or a future moving main.

| Repository    | Exact source head                          | Declared toolchain and command surface                                                                                                              | Qualification in this receipt                                                                                                               |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Control Plane | `ab931d068142a0c5629ed4d6cc2c96a1b377a986` | Node `24.21.0`, Bun `1.4.4`, Vite+ `1.3.0`; root build/type/lint use `vp run orch:*`; workspace types use `bun check`, declarations still use `tsc` | Frozen install, build, lint, format and focused contract/cache suites executed on declared pins; requirements check fails as recorded below |
| UI            | `968c0afa43cb7e1e2ff4852323781a2ec0b33fab` | Node `24.18.0`, Bun `1.4.4`, Vite+ `1.3.0`; root build/test/type/lint use `vp run orch:*`; no root Turbo dependency                                 | Source inventory only; normal install/build/tests and browser/package consumers remain unverified here                                      |
| Themes        | `d3a35cf673e6fcd0dfd10ce9430eb53f68e3b9c4` | Node `24.22.1`, Bun `1.4.4`; `bun check -p tsconfig.json`, declaration build with `tsc`                                                             | Frozen install and compatibility checks on Node `24.21.0` / Bun `1.4.4`; exact declared Node was unavailable                                |
| Plugins       | `882cb6853aaabdfe9010cc9d0e37ad29c8313f4e` | Node engine `>=24 <25`, Bun `1.4.4`; `bun check -p tsconfig.json`, declaration build with `tsc`                                                     | Source inventory only; normal validation and published consumers remain unverified here                                                     |
| Adea          | `70c7c7150c67eb40644dbc09c678b80b82aea45a` | Node `24.21.0`, Bun `1.4.4`, Vite+ `1.3.0`; root host orchestration uses `vp`                                                                       | Main identity read; full host, generated web types and packaged desktop qualification remain outstanding                                    |
| Agent Sim     | `a5b33f41f329b28bac7f680eb27f900b2f11c6d1` | Node `24.22.0`, Bun `1.4.4`, Vite+ `1.3.0`; root build/lint/type/test use `vp run orch:*`, no Turbo dependency/config                               | Main identity read; private assets and desktop separation acceptance remain outstanding                                                     |

Themes [#106](https://github.com/adea-ai/themes/pull/106) merged at `14919247d0893010190080d0ae7ad7cb30323a2f` on October 22 at 02:04:55 UTC. [#107](https://github.com/adea-ai/themes/pull/107) merged at `492f9c28cdef797bae150740e9321d70e835ff1b` at 06:14:14 UTC. Those changes must not be recreated based on stale tracker text.

## Control Plane execution

The source was extracted with `git archive` into a disposable local directory. Dependencies were installed into that copy, not linked to a writer's checkout. Commands used explicit installed Bun `1.4.4` and Node `24.21.0` binaries on PATH. No shared source, provider configuration or live resource was changed.

- `bun install --frozen-lockfile`: passed, 374 packages installed. `bun.lock` SHA256 remained `852c4ba6d2eda9bebb94150f6398606b33519baf90de1ef86cfcc39af9723ae3`, equal to the source commit.
- `bun run build`: passed, 47/47 tasks successful, 0/45 cache hits.
- `bun run format:check`: passed, 1,996 files checked.
- `bun run lint`: passed, 47/47 orchestration tasks; 1,258 files in 45 packages, zero dependency-boundary violations; canonical ordering and 39 reviewed digest flows passed.
- `bun test tests/workspace-tooling.test.mjs tests/task-cache-qualification.test.mjs tests/repository.test.mjs`: passed after the normal build, 122 tests, zero failures, 958 expectations. Before building, the recalibration test correctly failed on missing build output. An initial attempt using older dependencies failed the declaration-link guard for the new `memory-writeback` workspace; the frozen install above resolved that setup failure.
- `bun run type-check`: checker/build/OpenAPI orchestration passed 97/97 tasks; database migration check and runtime compatibility check completed; composite command failed at `requirements:check`. It is not a passing full type-check receipt.
- `bun run infra:typecheck`: passed, 208 files checked.
- `bun run architecture:check`: passed with the source Git objects available read-only; existing version-drift, route/capability and profile warnings remain observable.

The exact-head requirements check used an isolated bare Git mirror whose HEAD was the recorded source commit, plus the disposable source as work tree. Authenticated GitHub issue reads succeeded. The unchanged check still failed:

```text
reconciliation record omits the differing worker evidence path W7 docs/project-state-digest-compatibility.md
reconciliation record says 5 lanes have a differing path, the recorded heads show 6
```

An archive without Git history cannot verify this provenance. Pointing Git at an older shared checkout HEAD also produces misleading ancestor/content differences; neither attempt is a valid exact-head requirements result. The failure quoted above is from the corrected exact-head mirror.

The checker-contract suite traverses every TypeScript workspace, verifies the actual `bun check -p tsconfig.json` invocation and aggregate build ordering, checks generated declaration paths/workspace links, and rejects removed, renamed or neutered scripts. Its disposable clean fixture exits zero; its intentional type error exits nonzero and names the failing source. Passing these guards does not prove the whole repository test suite or integration environments pass.

## Themes compatibility execution

Commands used Bun `1.4.4`, Node `24.21.0`, and an npm cache inside the disposable task directory. This Node version differs from the declared `24.22.1`; exact-pin acceptance remains outstanding.

- `bun install --frozen-lockfile`: passed, 11 packages installed.
- `bun run verify`: format, typecheck, lint and catalogue freshness passed before the test phase. The full suite reported 141 pass / 1 fail: the packed-content reproducibility case exceeded its unchanged 5,000 ms test deadline. The final build command in the composite did not run after that failure.
- `bun test tests/package.test.ts` with the writable npm cache: 12 pass, zero failures, 425 expectations. This includes Node/Bun export resolution, consumer declaration checking and reproducible packed contents. This isolated pass does not erase the full-suite timeout.
- An earlier package attempt failed when npm tried to write its default cache outside the writable task directory. Setting `npm_config_cache` to a disposable writable directory resolved that environmental failure; no home-directory permissions were changed.

## Published dependency evidence

Read-only metadata requests to `https://registry.npmjs.org/PACKAGE/VERSION` returned HTTP 200 and a matching name/version for each row. This establishes publication, not consumer compatibility, and does not authorize an upgrade or release.

| Package           | Existing version | Registry integrity                                                                                |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `vite-plus`       | `1.3.0`          | `sha512-wZGsDeYfPcrCegqgY68pJJHGTpEZdsZvIMH2/mWXkGkBD72UY3M7z24Sv3ZeOL/FrqbbtyqBOfkKO6BvoQ8wMw==` |
| `typescript`      | `7.0.2`          | `sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==` |
| `typescript`      | `6.0.3`          | `sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==` |
| `@adea-ai/ui`     | `0.146.3`        | `sha512-eHZSIEk8qeZpNFVu6GDUxsgNreeiLtXogd7zF/Tt7zZqQ33xRBncO/tbEyBdAXrfo0kWrI93BZVkWmIZ4v4hEA==` |
| `@adea-ai/themes` | `0.10.16`        | `sha512-VLUWfTCSow/ZLDnZn/N+/O2Jxz81HUzTNUdjhDo2x7eHNVfU+OCioD8qTPSKij2GZRz1HLUySaH/m7qXit2SqA==` |

## Remaining acceptance

- Preserve source ownership and reconcile existing PRs before edits. [#1239](https://github.com/adea-ai/control-plane/pull/1239) is draft at `2d8adb41807668b0b2529b157bb818b101f217e0`; [#1279](https://github.com/adea-ai/control-plane/pull/1279) is draft at `65870b256e4b3c46dfdf608bda35aeca9a230f86`. Their overlapping lifecycle files are owned by their separate reconciliation lane; neither hosted draft-skipped checks nor older receipts qualify a new combined head.
- Resolve the requirements provenance divergence through its evidence owner without weakening the checker.
- Run each remaining repository's complete normal commands and CI-discovery checks on its exact pins, generated declarations/types and actual published dependencies. Themes still needs its exact Node `24.22.1` lane.
- Qualify packaged desktop runtimes separately from host/CI Bun tooling. This receipt provides no workerd CPU, production auth, deployment, private-asset permission, cost or desktop-runtime acceptance.
- Keep [#1230](https://github.com/adea-ai/control-plane/issues/1230) open until actual dependencies meet the unchanged ceiling. No budget waiver is implied.

No version upgrades, lockfile edits, release, deployment, credentials or production changes are part of this receipt. Issue #1233 remains open.

## Dated status: 2026-10-24

Read-only reconciliation recorded 2026-10-24 against Control Plane main `94d14dcb5a37aff10445813596f6e86f1b42c41e`, the same base identity named in [issue #1233 comment 6380216125](https://github.com/adea-ai/control-plane/issues/1233#issuecomment-6380216125). `git rev-parse origin/main` in this checkout returns that commit, and the comment's body matches the records below. Nothing above this section was rewritten: the original failed commands, historical heads, counts and lock hashes in the October 23 receipt remain published exactly as received, and no historical failure is reinterpreted as a current pass.

### Merge records superseding the pending-prerequisite wording

The [Remaining acceptance](#remaining-acceptance) bullet that reports [#1239](https://github.com/adea-ai/control-plane/pull/1239) and [#1279](https://github.com/adea-ai/control-plane/pull/1279) as drafts is superseded by authoritative merge records read with `gh pr view <pr> --json mergeCommit,mergedAt,baseRefName`:

| Pull request                                                | Merge commit                               | Merged (UTC)        | Ancestor of `main` |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------- | ------------------ |
| [#1279](https://github.com/adea-ai/control-plane/pull/1279) | `3d40c23c203686bb57f75971681ed8ee2dad50f1` | 2026-10-23 19:48:27 | no                 |
| [#1239](https://github.com/adea-ai/control-plane/pull/1239) | `9a8646ae4f7826eb96e7a0209098e7f2586facd4` | 2026-10-23 20:43:55 | yes                |
| [#1303](https://github.com/adea-ai/control-plane/pull/1303) | `b65e2c770cd5d2fa7a3007bdff71613e18748860` | 2026-10-24 01:17:39 | yes                |

[#1279](https://github.com/adea-ai/control-plane/pull/1279) merged into its base branch `fix/issue-189-integration-runner-cleanup` as `fix(testing): integrate reviewed descendant cleanup with current main` (commit date 2026-10-23 19:46:59 UTC); that branch was then squash-merged into `main` as [#1239](https://github.com/adea-ai/control-plane/pull/1239), so `3d40c23c203686bb57f75971681ed8ee2dad50f1` exists upstream but is not an ancestor of `main`. `git merge-base --is-ancestor` succeeds for `9a8646ae4f7826eb96e7a0209098e7f2586facd4` and `b65e2c770cd5d2fa7a3007bdff71613e18748860`. [#1303](https://github.com/adea-ai/control-plane/pull/1303) carries the later type/output-size qualification repair — verified full-lock receipt identity substitutions and reduced declaration expansion — and its own record states that the count assertions 591/551/547 and the ceiling are unchanged. Themes [#106](https://github.com/adea-ai/themes/pull/106) and [#107](https://github.com/adea-ai/themes/pull/107) remain merged as recorded above and are not reimplemented.

### Read-only observations on this exact head

- **Toolchain pins.** Root `package.json` declares `"packageManager": "bun@1.4.4"` and `.bun-version` contains `1.4.4`. No `package.json` anywhere in this workspace contains `turbo`, so no inspected root manifest carries a Turbo command. These are static observations only: they do not prove complete nested-source removal, the generated/typechecker graph, actual published dependency qualification, desktop-runtime separation, or normal commands on the other repositories' exact heads.
- **Lock identity.** `shasum -a 256 bun.lock` on this head returns `6f4969030dcd5164864ef39360223aac0a807261d418caf89a4270466106ad75`; the worktree `bun.lock` is unmodified relative to `HEAD:bun.lock` (`git status --porcelain` reports no change). Computed read-only: no lockfile, manifest, schema or dependency was written.
- **Dependency budget.** With the listing seam unset, the repository's own gate still fails:

  ```text
  env -u ADEA_DEPS_LISTING_FILE bun scripts/check-budgets.mjs deps
  BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":547,"scope":"all-platform lockfile identities",
    "installedListing":{"command":"bun pm ls --all","runtime":"bun@1.4.4","platform":"darwin-arm64","measured":547},
    "attribution":{"reachableIdentities":547,"declaredRootCount":40, … "overageUpperBound":262}}
  exit 1
  ```

  Measured **547** against the unchanged ceiling **285**, residual **262** unresolved. No threshold, platform identity, artifact or required consumer is excluded or waived, and [#1230](https://github.com/adea-ai/control-plane/issues/1230) stays open.

`docs/1230-dependency-budget-attribution.md` published `829196fc27f4a3e4a4e4af2b3a291d5421401b3b57c8f4976f1cf46f8f9a4535` as "the current lockfile SHA-256". That value matches no `bun.lock` of any commit reachable from the refs in this clone, including `main`, so that document now records the head hash above as current and keeps `829196fc27f4a3e4a4e4af2b3a291d5421401b3b57c8f4976f1cf46f8f9a4535` — and the earlier `6c7d01d7658c8dcb787841ce9840d177188f7942222d1a823224936119083bf4` 548-identity and `6b42afa9967a45911c55b8b4e45da6601a0bd62dbd7a42611ef6845d02517543` 551-identity receipts — as historical.

### What this dated status does not establish

No fresh cross-repository qualification is claimed: the UI, Themes, Plugins, Adea and Agent Sim heads, their generated declarations and types, actual published dependencies, their normal command lanes, and packaged desktop runtimes remain unverified here, and Themes still needs its exact Node `24.22.1` lane. The requirements provenance failure quoted in [Control Plane execution](#control-plane-execution) and the Themes suite timeout remain historical failures, not resolved items. [#1233](https://github.com/adea-ai/control-plane/issues/1233) remains open pending the remaining exact-head acceptance evidence; this reconciliation closes no issue and changes no code, lockfile, schema, dependency or test.
