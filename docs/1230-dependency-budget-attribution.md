# #1230 — Dependency budget: attribution of the 591-against-285 closure

This is the dedicated dependency-budget audit document for
[adea-ai/control-plane#1230](https://github.com/adea-ai/control-plane/issues/1230).
It continues the audit slice carried by PR #1214 (its runtime/dependency sections live in
`docs/405-runtime-audit.md` §3.2–§3.3) and answers the question that issue asks: **is the
591-against-285 result a counting defect or a genuine overage, what exactly is the
residual, and which dependency brings each part of it in?**

The committed ceiling is **not** changed by this document, and no manifest, lockfile or
threshold is touched.

## 1. The real measurement, reproduced

The repository-pinned check, with the listing seam **unset**, so it enumerates the lockfile's
dependency tree itself:

```
$ env -u ADEA_DEPS_LISTING_FILE bun scripts/check-budgets.mjs deps
BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree", ... }
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

The attribution is **recomputed by a test** rather than stated in prose.
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

**Every edge resolves to the entry that provides it.** A dependency is satisfied by the
copy the lockfile installs under the requiring package, or by the hoisted copy when
there is none — `vite-plus` pins `oxfmt` to `=0.73.0`, so its copy is the nested
`vite-plus/oxfmt` entry, while the repository's own `oxfmt` is the hoisted
`oxfmt@0.72.0`. Resolving a dependency _name_ to every entry that carries it
instead would attribute a package's whole closure — every version of it — to each
root that names it, and would report one number for roots that share their
dependencies. The walk above is the one the published tables use, and the
per-root numbers it produces are the ones `docs/405-runtime-audit.md` §3.3
publishes.

**An optional peer is not an edge that keeps a package installed.** `oxfmt` and
`oxlint` list `vite-plus` as an _optional_ peer: it is satisfied only when
something else provides it, so it cannot hold the toolchain in the tree on its
own. It is still recorded as a consumer.

| Declared root                | Transitive external identities | Owning manifest                                                                                                                        |
| ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `vite-plus`                  | 168                            | `package.json` (root)                                                                                                                  |
| `@earendil-works/pi-durable` | 117                            | `packages/sqlite-persistence`, `packages/pi-durable-adapter`, `packages/pi-cloudflare-host`                                            |
| `@earendil-works/pi-ai`      | 87                             | `package.json` (root), `apps/control-api`, `packages/sqlite-persistence`, `packages/pi-durable-adapter`, `packages/pi-cloudflare-host` |
| `@nestjs/platform-fastify`   | 76                             | `apps/control-api/package.json`                                                                                                        |
| `miniflare`                  | 56                             | `packages/pi-cloudflare-host/package.json`                                                                                             |
| `fastify`                    | 49                             | `apps/control-api/package.json`                                                                                                        |
| `@sentry/node`               | 42                             | `packages/telemetry/package.json`                                                                                                      |
| `drizzle-kit`                | 38                             | `packages/database/package.json`                                                                                                       |

The same walk, per declaring manifest:

| Declaring manifest            | Transitive external identities |
| ----------------------------- | ------------------------------ |
| repository root               | 370                            |
| `apps/control-api`            | 178                            |
| `packages/pi-cloudflare-host` | 172                            |
| `packages/pi-durable-adapter` | 118                            |
| `packages/sqlite-persistence` | 118                            |
| `packages/telemetry`          | 46                             |
| `packages/database`           | 40                             |
| `packages/langgraph-adapter`  | 37                             |
| `packages/object-store`       | 28                             |

## 2b. The attribution ships in the checker

The walk is not only a test: `scripts/check-budgets.mjs` exports
`attributeExternalPackages(lockfileText)`, `planDependencyReduction(lockfileText, ceiling)`,
`parseListingLayout(lsOutput)` and `summarizeAttribution(lockfileText, listingText, ceiling)`,
and the `deps` report now carries the attribution next to the verdict:

```
BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree",
  "attribution":{"reachableIdentities":591,"declaredRootCount":40,
    "largestContributors":{"vite-plus":168,"@earendil-works/pi-durable":117,
      "@earendil-works/pi-ai":87,"@nestjs/platform-fastify":76,"miniflare":56,
      "fastify":49,"@sentry/node":42,"drizzle-kit":38,"railway":32,"@nestjs/swagger":30},
    "largestOffenders":{"vite-plus":160,"miniflare":50,"@sentry/node":40,"typescript":21,
      "oxfmt":20,"oxlint":20,"@langchain/langgraph-checkpoint-postgres":14,
      "@langchain/langgraph":9,"drizzle-kit":9,"@nestjs/swagger":7},
    "exclusiveShareTotal":387,"removalSavingTotal":387,
    "reductionPlan":{"steps":[
        {"root":"vite-plus","saving":160,"closure":431,"owner":["package.json (root)"]},
        {"root":"miniflare","saving":52,"closure":379,"owner":["packages/pi-cloudflare-host/package.json"]},
        {"root":"@sentry/node","saving":41,"closure":338,"owner":["packages/telemetry/package.json"]},
        {"root":"oxfmt","saving":21,"closure":317,"owner":["package.json (root)"]},
        {"root":"typescript","saving":21,"closure":296,"owner":["package.json (root)"]},
        {"root":"oxlint","saving":20,"closure":276,"owner":["package.json (root)"]}],
      "residual":276,"reachable":true,"minimumRemovals":6,"overageUpperBound":306},
    "aliasedIdentities":2,
    "aliases":{"vite@1.3.0":"@voidzero-dev/vite-plus-core@1.3.0","typescript6@6.0.3":"typescript@6.0.3"},
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

## 2c. The exact offenders: the paths, the consumers, and what a removal really sheds

The **contribution** of a root and what an owner could actually **shed** are
different numbers. A dependency that several roots share cannot be removed by
dropping one declaration: the identity stays in the resolved tree because
another root still needs it. The checker therefore also reports the _exclusive_
share of every declared root — the identities only that root brings in — and,
because the attribution resolves every edge to the entry that provides it,
that share is exactly what removing the root would shed.

**The exclusive share and the removal saving are the same set**, and the
attribution proves it: an identity only that root reaches is exactly an identity
the other roots stop reaching when it is removed. The two agree
(`exclusiveShareTotal` = `removalSavingTotal` = 387 of the 591). A disagreement
between them would mean the attribution is charging a shared dependency to a
root that does not own it.

| Declared root                                                                                                                         | Exclusive share = what removing it sheds |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `vite-plus`                                                                                                                           | 160                                      |
| `miniflare`                                                                                                                           | 50                                       |
| `@sentry/node`                                                                                                                        | 40                                       |
| `typescript`                                                                                                                          | 21                                       |
| `oxfmt`                                                                                                                               | 20                                       |
| `oxlint`                                                                                                                              | 20                                       |
| `@langchain/langgraph-checkpoint-postgres`                                                                                            | 14                                       |
| `@langchain/langgraph`                                                                                                                | 9                                        |
| `drizzle-kit`                                                                                                                         | 9                                        |
| `@nestjs/swagger`                                                                                                                     | 7                                        |
| `@restatedev/restate-server`                                                                                                          | 5                                        |
| `@nestjs/platform-fastify`, `@opentelemetry/sdk-metrics`                                                                              | 4 each                                   |
| `railway`, `@aws-sdk/client-s3`                                                                                                       | 3 each                                   |
| `@fastify/helmet`, `@earendil-works/pi-durable`, `@restatedev/restate-sdk`                                                            | 2 each                                   |
| `acorn`, `code-foundry`, `typescript6`, `drizzle-orm`, `@hpke/core`, `@hpke/dhkem-x25519`, `@langchain/langgraph-checkpoint-postgres` | 1 each                                   |

Thirty declared roots have an exclusive share, and the shares sum to **387**
identities of the 591 — more than the 306 the ceiling needs, so the gap **is**
reachable by removing declarations, and §5 measures how.

**The install path and the required consumers of each identity** come from the
measured listing's own layout and from the lockfile's requirement edges. The
`installLayout` block of the report carries the shape of it (598 external
entries, 533 install roots, 65 nested installs, the five largest install roots
and a sample of the nested paths with their consumers); the test pins the
example: `@oxfmt/binding-darwin-arm64@0.73.0` is installed at depth 3 under the
`vite-plus@1.3.0` install root, and its consumer is `oxfmt@0.73.0
(optionalDependencies)`.

## 3. The composition of the 591

| Category                                      | Pairs   | What it is                                                                                                                                                                                                               |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime dependency                            | **352** | packages a product workspace imports (the AWS SDK, Anthropic SDK, Nest/Fastify, LangChain, Sentry, Drizzle, … families)                                                                                                  |
| Optional platform binary, not toolchain-owned | **124** | the optional per-platform binaries of runtime packages (`esbuild` 26, `typescript` 20, `oxc-parser` 19, `sharp` 15, `yuku-core` 12, `lightningcss` 11, `workerd` 5, `@restatedev/restate-server` 4, `@img/sharp-*` 4, …) |
| Toolchain dependency                          | **10**  | the build/lint/test toolchain's own packages (listed in §4)                                                                                                                                                              |
| Toolchain optional platform binary            | **105** | the optional per-platform binaries the toolchain brings (listed in §4)                                                                                                                                                   |
| **Total**                                     | **591** |                                                                                                                                                                                                                          |

The three categories are measured, not classified by hand: an identity is a
_platform binary_ when it is an optional dependency of another entry, the
toolchain's own are the packages of §4, and the rest are the runtime closure.
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

The reduction is **measured, not argued**. Every step's saving is the number of
identities the remaining roots no longer reach once that root is gone, so the
plan accounts for the identities several roots share instead of counting them
once per root. The plan is the checker's own `planDependencyReduction`, and the
test pins it:

| Step | Declared root removed | Section           | Saving | Closure | Owning manifest               |
| ---- | --------------------- | ----------------- | ------ | ------- | ----------------------------- |
| 0    | — (as measured)       | —                 | —      | **591** | —                             |
| 1    | `vite-plus`           | `devDependencies` | −160   | 431     | `package.json` (root)         |
| 2    | `miniflare`           | `devDependencies` | −52    | 379     | `packages/pi-cloudflare-host` |
| 3    | `@sentry/node`        | `devDependencies` | −41    | 338     | `packages/telemetry`          |
| 4    | `oxfmt`               | `devDependencies` | −21    | 317     | `package.json` (root)         |
| 5    | `typescript`          | `devDependencies` | −21    | 296     | `package.json` (root)         |
| 6    | `oxlint`              | `devDependencies` | −20    | **276** | `package.json` (root)         |

**Six removals are the minimum, and that is proved rather than found.** A set
of removals sheds only what one of its members sheds alone, so the _n_ largest
single removals bound any set of _n_. The five largest single removals are
160 + 50 + 40 + 21 + 20 = **291**, below the 306 the ceiling requires, so no
five-root set reaches 285; the six-removal plan above does, at 276. (A step's
_marginal_ saving in the plan above can exceed its single-removal saving —
`miniflare` is worth 52 once `vite-plus` is gone and 50 alone — because the
plan removes the roots in the order that frees the most.)

**Every one of the six is a devDependency**, and every one of them is declared
in a manifest this issue does not own (§7). The plan is therefore _measured and
reported_, not applied: the gate keeps reporting the breach —
`BUDGET EXCEEDED … 591 against 285`, exit 1 — and the residual is routed to the
owners below.

## 6. The installed graph, verified independently

The budget measures the **lockfile's** closure, not the installed tree, and the scope is
unchanged. On this host the installed external graph was walked independently
(`node_modules/.bun` → 376 store entries → **374** distinct external `package@version`
identities), so **217** of the 591 are lockfile-only: 213 other platforms' optional
binaries and 4 packages the toolchain ships inside its own binary distribution
(`rolldown@1.2.14`, `@rolldown/pluginutils@1.0.1`, `vite@8.3.4`, `@emnapi/runtime@1.11.3`).

## 7. The owner dependency of the residual — and why it is not reduced here

The six removals the plan measures are named, with their owning manifests, by the
measured per-root walk:

| Declared root                   | Kind                          | Owning manifest                            | Slice that owns it   |
| ------------------------------- | ----------------------------- | ------------------------------------------ | -------------------- |
| `vite-plus`                     | devDependency                 | `package.json` (root)                      | repository toolchain |
| `oxfmt`, `oxlint`, `typescript` | devDependency                 | `package.json` (root)                      | repository toolchain |
| `miniflare`                     | devDependency                 | `packages/pi-cloudflare-host/package.json` | Pi Cloudflare host   |
| `@sentry/node`                  | devDependency + optional peer | `packages/telemetry/package.json`          | telemetry            |

Every one of those manifests is owned by another slice, and this issue authorizes only
`scripts/check-budgets.mjs`, the dependency-budget tests and this document. Removing them is
an infrastructure decision (it would delete the repository's own build, lint and test
toolchain, and the Pi Cloudflare host's and telemetry's own dev tooling), not a budget
repair. The plan is therefore measured and published, and **not applied**: the ceiling stays
at 285, the count stays at 591, and the gate keeps failing visibly with the exact residual
and the owner of each removal named.

## 8. What this slice changed

| Path                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-budgets.mjs`                                          | the counting rule is **unchanged** — no parser defect is proven (§2), so the counter is not touched. The checker gains the attribution: `attributeExternalPackages` walks the lockfile graph from the declared roots with **every edge resolved to the entry that provides it** and **optional peers not treated as edges**, records the owning manifest of every declared root, the consumers of every identity and the install layout of the measured listing; `planDependencyReduction` measures the reduction plan and proves the minimum number of removals; and the `deps` report carries the attribution next to the unchanged verdict |
| `packages/production-readiness/src/dependency-budget-scope.test.mjs` | the regression tests pin the §2 invariants over the **real** listing, the per-root attribution against the published table, the measured reduction plan and its proved minimum, the install path and the consumers of a nested identity, and that the exclusive share of a root and its removal saving are the same set — the measurement's own count, the ceiling and the identity rule are unchanged, and the real listing is measured with the seam unset                                                                                                                                                                                  |
| `docs/1230-dependency-budget-attribution.md`                         | this document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 9. Receipts

- Real measurement, seam unset: `BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree"}`, exit 1.
- Installed graph: 374 distinct external identities on this host (376 store entries walked).
- Focused regression: `bun test src/dependency-budget-scope.test.mjs` (packages/production-readiness) — 21 pass / 0 fail.
- Reproduced attribution: the lockfile walk reaches exactly the 591 counted identities (591 = 591, no difference in either direction, no unresolved root), the per-root attribution reproduces the table `docs/405-runtime-audit.md` §3.3 publishes, and the gate's own report carries it.
- The measured plan: six removals reach 276 against the unchanged 285 ceiling, and the five largest single removals (295) prove that no smaller set can.
- The ceiling is unchanged: `budgets.json` → `dependencies.externalPackageCeiling = 285`.
- No manifest, lockfile or threshold was edited, and no dependency was removed.
- No release and no deployment were performed or requested.
