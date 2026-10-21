# #1230 — Dependency budget: attribution of the 591-against-285 closure

This is the dedicated dependency-budget audit document for
[adea-ai/control-plane#1230](https://github.com/adea-ai/control-plane/issues/1230).
It continues the audit slice carried by PR #1214 (its runtime/dependency sections live in
`docs/405-runtime-audit.md` §3.2–§3.3) and answers the question that issue asks: **is the
591-against-285 result a counting defect or a genuine overage, and what exactly is the
residual?**

The committed ceiling is **not** changed by this document, and no manifest, lockfile or
threshold is touched.

## 1. The real measurement, reproduced

The repository-pinned check, with the listing seam **unset**, so it enumerates the lockfile's
dependency tree itself:

```
$ env -u ADEA_DEPS_LISTING_FILE bun scripts/check-budgets.mjs deps
BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree"}
$ echo $?
1
```

The unit is the committed one — `budgets.json` records it as _"Unique external
`package@version` pairs from `bun pm ls --all`"_ — and the ceiling stays at **285**.

Every number below is reproducible from the repository's own artifacts:

- the measurement input: `bun pm ls --all` (the lockfile's dependency tree);
- the identity rule: the checker's exported `externalPackagePairs` / `normalizePackageName`
  in `scripts/check-budgets.mjs`;
- the graph: `bun.lock`, parsed with the repository's own `JSONC.parse` (the same call
  `scripts/architecture-audit.mjs` uses).

## 2. Counting defect, or genuine overage? — **genuine**

Four invariants were measured against the **real** listing. They are now pinned by
`packages/production-readiness/src/dependency-budget-scope.test.mjs`, so they are checked
rather than asserted in prose:

| Invariant                                                           | Measured                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Package-like lines of the real listing that the identity rule drops | **0** of 643                                               |
| Counted identities that the lockfile does not name                  | **0** of 591                                               |
| Lockfile packages the count excludes                                | **45** — exactly the `@control-plane/*` workspace packages |
| Counted identities that are not plain `package@version` identities  | **0** of 591                                               |
| Identities reachable from the declared roots that the count misses  | **0** of 591                                               |
| Counted identities the declared roots do not reach                  | **0** of 591                                               |

So the counter neither drops an entry nor invents one, and the identities it reports are the
lockfile's own package identities. **The 591 is the exact size of the lockfile's external
closure**; the 306-entry gap is real graph growth, not a measurement artefact. The gap was
already measured against the ceiling's own baseline: `budgets.json` records 274 pairs at
`c37de22`, and the same reconstruction over that lockfile yields 274 again.

## 2a. The attribution, reproduced

The attribution is now **recomputed by a test** rather than stated in prose.
`packages/production-readiness/src/dependency-budget-scope.test.mjs` walks the
lockfile graph from the declared roots and compares it with the counted set:

- the walk follows the `dependencies`, `optionalDependencies` and
  `peerDependencies` edges of every `bun.lock` entry, resolving a dependency
  name to the entries that carry it (a nested entry such as
  `@fastify/ajv-compiler/fast-uri` names the package `fast-uri`);
- an identity is `<package name>@<resolved version>`, with the workspace
  packages excluded, exactly as the counter names them;
- **the reachable set and the counted set are the same set** — 591 identities
  each, with no identity counted but unreachable and none reachable but
  uncounted, and every declared root resolving to a lockfile entry.

The per-root and per-manifest closures below are that walk's output on the
current lockfile. The per-root table in `docs/405-runtime-audit.md` §3.3 was
produced with a narrower walk (it does not follow every edge this walk
follows), so it does not reproduce under this definition, while the totals the
budget measures and the identity-level agreement do. The difference is in the
walk's edges, not in the graph: `bun.lock` has not changed between the audit's
published head and this head.

| Declared root                | Transitive external identities (this walk) |
| ---------------------------- | ------------------------------------------ |
| `vite-plus`                  | 264                                        |
| `@earendil-works/pi-durable` | 125                                        |
| `@earendil-works/pi-ai`      | 95                                         |
| `@nestjs/platform-fastify`   | 84                                         |
| `miniflare`                  | 62                                         |
| `fastify`                    | 49                                         |
| `@sentry/node`               | 45                                         |
| `drizzle-kit`                | 38                                         |

| Declaring manifest            | Transitive external identities |
| ----------------------------- | ------------------------------ |
| repository root               | 379                            |
| `apps/control-api`            | 220                            |
| `packages/pi-cloudflare-host` | 178                            |
| `packages/sqlite-persistence` | 142                            |
| `packages/pi-durable-adapter` | 125                            |
| `packages/langgraph-adapter`  | 71                             |
| `packages/database`           | 55                             |
| `packages/telemetry`          | 49                             |
| `packages/object-store`       | 29                             |

## 2b. The attribution ships in the checker

The walk is not only a test: `scripts/check-budgets.mjs` exports
`attributeExternalPackages(lockfileText)` and `summarizeAttribution(lockfileText)`,
and the `deps` report now carries the attribution next to the verdict:

```
BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree",
  "attribution":{"reachableIdentities":591,"declaredRootCount":40,
    "largestContributors":{"oxfmt":264,"oxlint":264,"vite-plus":264,
      "@earendil-works/pi-durable":125,"@earendil-works/pi-ai":95,
      "@nestjs/platform-fastify":84,"@langchain/langgraph-checkpoint-postgres":62,
      "miniflare":62,"@nestjs/swagger":59,"@langchain/langgraph":56},
    "aliasedIdentities":2,
    "aliases":{"vite@1.3.0":"@voidzero-dev/vite-plus-core@1.3.0",
      "typescript6@6.0.3":"typescript@6.0.3"},
    "unresolvedRoots":[]}}
```

The attribution is **additive**: the measured count, the ceiling and the verdict
are computed exactly as before, and a lockfile that cannot be read is reported
as an absent attribution rather than an empty one.

**The counted identities can be aliases.** `vite@1.3.0` is the repository's
alias for `@voidzero-dev/vite-plus-core@1.3.0`, and `typescript6@6.0.3` for
`typescript@6.0.3`; the checker records the resolution of every counted
identity, so a measured identity can always be traced to the package that is
actually installed. Each alias is one identity, so the count is unaffected.

**The installed graph is covered by the measurement.** Where the packages are
installed, every installed external package is covered by the counted closure
once the alias resolution is applied — a test walks the installed store and
asserts that coverage. The installed store in this checkout is _older_ than the
lockfile's pins for six packages (`@opentelemetry/api@1.9.1` against the
pinned `1.10.0`, and the `@opentelemetry/*` `2.12.0` against the pinned
`3.0.0`), so the installed graph is not version-identical to the lockfile
here; that is a stale install, not a measurement difference.

## 3. The composition of the 591

| Category                                      | Pairs   | What it is                                                                                                                                                                                                               |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime dependency                            | **352** | packages a product workspace imports (the AWS SDK, Anthropic SDK, Nest/Fastify, LangChain, Sentry, Drizzle, … families)                                                                                                  |
| Optional platform binary, not toolchain-owned | **124** | the optional per-platform binaries of runtime packages (`esbuild` 26, `typescript` 20, `oxc-parser` 19, `sharp` 15, `yuku-core` 12, `lightningcss` 11, `workerd` 5, `@restatedev/restate-server` 4, `@img/sharp-*` 4, …) |
| Toolchain dependency                          | **10**  | the build/lint/test toolchain's own packages (listed in §4)                                                                                                                                                              |
| Toolchain optional platform binary            | **105** | the optional per-platform binaries the toolchain brings (listed in §4)                                                                                                                                                   |
| **Total**                                     | **591** |                                                                                                                                                                                                                          |

Distinct package names: **533**, of which **58** appear at more than one version
(533 + 58 = 591). Seven identities are contributed by two lockfile entries each (the same
package nested under two parents); two are named by their alias (`typescript6@6.0.3`,
`vite@1.3.0`). Neither case changes the count.

## 4. The Vite+ toolchain closure: 115 pairs, 74 names

| Owner (lockfile key)         | Optional binaries | Versions       | Consumes                                                                            |
| ---------------------------- | ----------------- | -------------- | ----------------------------------------------------------------------------------- |
| `oxfmt`, `vite-plus/oxfmt`   | 38                | 0.72.0, 0.73.0 | the root manifest declares `oxfmt`; `vite-plus@1.3.0` brings its own `oxfmt@0.73.0` |
| `oxlint`, `vite-plus/oxlint` | 38                | 1.86.0, 1.88.0 | the root manifest declares `oxlint`; `vite-plus@1.3.0` brings `oxlint@1.88.0`       |
| `vite`, `vite-plus`          | 8                 | 1.3.0          | `vite-plus@1.3.0`                                                                   |
| `rolldown`                   | 15                | 1.2.14         | the root manifest                                                                   |
| `oxlint-tsgolint`            | 6                 | 7.0.2004       | the root manifest                                                                   |

The toolchain's own 10 package identities: `vite-plus@1.3.0`, `oxfmt@0.72.0`,
`oxfmt@0.73.0` (under `vite-plus`), `oxlint@1.86.0`, `oxlint@1.88.0` (under `vite-plus`),
`rolldown@1.2.14`, `oxlint-tsgolint@7.0.2004`, `@oxc-project/runtime@0.154.0`,
`@oxc-project/types@0.152.0` (under `oxc-parser`), `@oxc-project/types@0.154.0`.

The duplicated majors are the shape of the gap: the repository root declares `oxfmt` and
`oxlint`, and `vite-plus@1.3.0` brings a **second** copy of each, so every platform binary
of both copies is counted.

## 5. The exact residual

| Step                                                           | Pairs   | Against the 285 ceiling |
| -------------------------------------------------------------- | ------- | ----------------------- |
| as measured                                                    | **591** | **+306**                |
| remove the whole Vite+ toolchain closure (115)                 | 476     | **+191**                |
| additionally remove the other-platform optional binaries (124) | 352     | **+67**                 |

**The overage cannot be closed by a measurement change.** Even the pure runtime closure —
352 product dependencies, with no toolchain and no other-platform binaries left — is 67
above the ceiling, and the toolchain alone accounts for only 115 of the 306.

## 6. The installed graph, verified independently

The budget measures the **lockfile's** closure, not the installed tree, and the scope is
unchanged. On this host the installed external graph was walked independently
(`node_modules/.bun` → 1031 store entries → **374** distinct external `package@version`
identities), so **217** of the 591 are lockfile-only: 213 other platforms' optional
binaries and 4 packages the toolchain ships inside its own binary distribution
(`rolldown@1.2.14`, `@rolldown/pluginutils@1.0.1`, `vite@8.3.4`, `@emnapi/runtime@1.11.3`).

## 7. The owner dependency of the residual — and why it is not reduced here

The reduction candidates are named, with their owning manifests, by the measured per-root walk
in `docs/405-runtime-audit.md` §3.3:

| Declared root                   | Kind                          | Owning manifest                            | Slice that owns it   |
| ------------------------------- | ----------------------------- | ------------------------------------------ | -------------------- |
| `vite-plus`                     | devDependency                 | `package.json` (root)                      | repository toolchain |
| `oxfmt`, `oxlint`, `typescript` | devDependency                 | `package.json` (root)                      | repository toolchain |
| `miniflare`                     | devDependency                 | `packages/pi-cloudflare-host/package.json` | Pi Cloudflare host   |
| `@sentry/node`                  | devDependency + optional peer | `packages/telemetry/package.json`          | telemetry            |

Every one of those manifests is owned by another slice, and this issue authorizes only
`scripts/check-budgets.mjs`, the dependency-budget tests and this document. Removing them is
an infrastructure decision (it would delete the repository's own build, lint and test
toolchain), not a budget repair. The measured six-removal path to ≤285 is recorded in
`docs/405-runtime-audit.md` §3.3 with the saving of each step.

**This slice therefore changes no manifest, no lockfile and no threshold**, and the gate keeps
reporting the breach: `BUDGET EXCEEDED … 591 against 285`, exit 1.

## 8. What this slice changed

| Path                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-budgets.mjs`                                          | the counting rule is **unchanged** — no parser defect is proven (§2), so the counter is not touched. The checker gains the attribution: `attributeExternalPackages` / `summarizeAttribution` walk the lockfile graph from the declared roots, record the resolution of every counted identity, and the `deps` report carries the attribution next to the unchanged verdict                                                                                                                                                                |
| `packages/production-readiness/src/dependency-budget-scope.test.mjs` | six regression tests pin the §2 invariants over the **real** listing: no listing entry is dropped, every counted identity is named by the lockfile and only the workspace packages are excluded, and every counted identity is a plain package identity; the measured closure is exactly the lockfile graph reachable from the declared roots; the closure without the Vite+ toolchain is still above the unchanged ceiling; and every installed external package is covered by the measured closure once the alias resolution is applied |
| `docs/1230-dependency-budget-attribution.md`                         | this document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 9. Receipts

- Real measurement, seam unset: `BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree"}`, exit 1.
- Installed graph: 374 distinct external identities on this host (1031 store entries walked).
- Focused regression: `bun test src/dependency-budget-scope.test.mjs` (packages/production-readiness) — 17 pass / 0 fail, of which 6 are new.
- Reproduced attribution: the lockfile walk reaches exactly the 591 counted identities (591 = 591, no difference in either direction, no unresolved root), and the gate's own report carries it.
- The ceiling is unchanged: `budgets.json` → `dependencies.externalPackageCeiling = 285`.
- No release and no deployment were performed or requested.
