# #1230 — Dependency budget remediation

## Current candidate: 43 real identities removed, residual 263

The integrated candidate preserves the transferred #1270 head
`0b190108b34d2feef46bd29d8b3f0aeadda347e7`, #1214 head
`5f078dc25d4a86434d3cbea1d7fe6949d21dba7e`, and unpublished recovery tip
`a548b164942e6e9215deaa0e6aabd75aca19f26a`. Published reconciliation `c30c058af42d1504c6e2ef3e40e7b380448d7a01`
incorporates main `5dc4a3396a6442dc5dc1e3c0131468702d4da15e`; main pins Bun **1.4.4**.

Root `oxfmt` and `oxlint` now pin **0.73.0** and **1.88.0**, exactly the
versions already required by Vite+ 1.3.0. Both exact packages and integrity
values were verified with `npm view ... --registry=https://registry.npmjs.org`.
Direct binaries, package scripts, custom lint behavior, and hooks are retained.
The obsolete 0.72.0/1.86.0 copies and their platform bindings disappear from the
actual regenerated lockfile. A real `bun install --frozen-lockfile` succeeded.

| Full lock receipt                 | Identities | Ceiling | Overage |
| --------------------------------- | ---------: | ------: | ------: |
| Current main before consolidation |        591 |     285 |     306 |
| Formatter/linter consolidation    |        551 |     285 |     266 |
| Compatible transitive pins        |        548 |     285 |     263 |

This is a **43-identity source reduction**, not a change in counting scope.
The current lockfile SHA-256 is
`6c7d01d7658c8dcb787841ce9840d177188f7942222d1a823224936119083bf4`.
The earlier 551-identity lock receipt remains historical at
`6b42afa9967a45911c55b8b4e45da6601a0bd62dbd7a42611ef6845d02517543`.
No ceiling is raised or disabled, and #1230 remains open.

### Preserve the all-platform scope across the Bun upgrade

The historical 551-identity lockfile produces **551** pairs from Bun 1.4.3's real
`bun pm ls --all`, but **370** on Bun 1.4.4 on this Darwin ARM64 host.
The installed Bun 1.4.4 help describes this command as the installed dependency
tree and exposes no all-platform listing option. Reporting the 370 as the old
all-platform closure would silently narrow the established scope.

The real gate therefore takes an independent stable inventory directly from
**every** `bun.lock` entry, including optional other-platform packages and
unreachable entries. Aliases retain the established listing identity; workspace
links are excluded by the unchanged namespace rule. Invalid or missing lock
inventories fail closed. The fixture-listing seam remains an explicitly labeled
fixture measurement and is unset for real acceptance.

The gate reports the unchanged all-platform verdict separately from the real
CLI listing's runtime, host, and measured count:

```text
env -u ADEA_DEPS_LISTING_FILE bun scripts/check-budgets.mjs deps
BUDGET EXCEEDED: measured 548, ceiling 285, scope all-platform lockfile identities
installedListing: bun@1.4.4, darwin-arm64, measured 367
exit 1
```

The two committed listing fixtures were produced by real Bun 1.4.3 on main's
before and candidate's after lockfiles; only the machine-specific header is
replaced by `node_modules`. Tests pin **591 → 551**, exactly 40 removed pairs,
no added pairs. The current lock inventory removes exactly three further pairs
from that after fixture, adds none, and agrees with the reachable graph. Every current installed CLI identity
must be covered. Replacing equality with the runtime's host-only listing is
necessary to preserve the original scope, not to waive it.

### Compatible transitive consolidation

Three exact root overrides reuse versions already present in the lockfile:
`@smithy/core@3.35.0`, `@smithy/types@4.19.0`, and `magic-string@1.4.3`.
All declared consumer ranges admit these targets, including the older Smithy
`^3.33.2`/`^3.33.3` and types `^4.17.2`/`^4.18.0` ranges, and Sentry's
`~0.30.8 || ^1.0.0` magic-string range. The official npm registry confirms all
three exact versions and their integrity values match the existing lock entries.
The regenerated lock removes exactly `@smithy/core@3.33.3`,
`@smithy/types@4.17.2`, and `magic-string@0.30.21`; it introduces no new
package/version identities. AWS Bedrock/S3, Sentry, Vite+ and their supported
consumers remain present. Seven workspace version metadata entries synchronize
with the already-merged main manifests; external pins otherwise remain unchanged.

The current attributed closures are 115 for `@earendil-works/pi-durable`,
85 for `@earendil-works/pi-ai`, 168 for Vite+, 76 for Nest's Fastify platform,
56 for Miniflare, 49 for Fastify, 42 for Sentry Node, and 38 for Drizzle Kit.
The test pins these current figures separately from historical attribution below.

### Attribution, reconciliation, and remaining ownership

Dependency edges resolve through scoped ancestors; declaration resolution is
preserved per workspace before roots are grouped by name. Aliases and conflicting
nested versions have regression fixtures. The greedy reduction plan reports a
sufficient sequence, with an unknown minimum represented by `null`. Individual
exclusive shares do not bound the saving of combined removals.

The prior unused local/worker declarations remain removed, and generated
architecture changes describe only those declaration removals. The two inherited
fresh-array sorts in the skill evaluation harness now use `toSorted`; this fixes
the current linter without changing sorting behavior or weakening the gate.

Miniflare is required by emulator/security tests, Drizzle Kit by migration
configuration and commands, Sentry by supported instrumentation, and Railway by
infrastructure/guarded CLI scripts. Deleting them would remove required consumers.
Further reduction needs scoped owner-approved implementation; no architectural
feature, supported runner, or required check is removed here. This work authorizes
no release, deployment, provider change, production data access, or live account.

### Remaining compatible-version audit and required tools

A read-only audit of every remaining multi-version name checks each existing
locked version against all dependency, optional, peer and workspace consumer
ranges. None of these 15 names has an existing target that satisfies every
declared range. Representative opposing constraints are recorded below; no
cross-major override or forced exact-pin replacement is applied.

| Name                        | Opposing declared consumer constraints                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@aws-sdk/token-providers`  | `@aws-sdk/credential-provider-sso@3.973.16` requires `3.1138.0`; `@aws-sdk/client-bedrock-runtime@3.1127.0` requires `3.1127.0` |
| `@jridgewell/trace-mapping` | `@cspotcode/source-map-support@0.8.1` requires `0.3.9`; `@vitest/mocker@5.0.5` requires `0.3.31`                                |
| `@oxc-project/types`        | `oxc-parser@0.152.0` requires `^0.152.0`; `rolldown@1.2.14` requires `=0.154.0`                                                 |
| `agent-base`                | `https-proxy-agent@7.0.6` requires `^7.1.2`; `http-proxy-agent@9.1.0` requires `9.0.0`                                          |
| `eventemitter3`             | `p-queue@6.6.2` requires `^4.0.4`; `p-queue@9.3.3` requires `^5.0.4`                                                            |
| `fast-uri`                  | `@fastify/ajv-compiler@4.0.6` requires `^4.0.0`; `ajv@8.20.0` requires `^3.0.1`                                                 |
| `https-proxy-agent`         | `gaxios@7.3.1` requires `^7.0.1`; `@earendil-works/pi-ai@1.1.0` requires `9.1.0`                                                |
| `p-queue`                   | `@langchain/core@1.2.9` requires `^6.6.2`; `@langchain/langgraph-sdk@1.12.2` requires `^9.0.1`                                  |
| `p-retry`                   | `@langchain/langgraph-sdk@1.12.2` requires `^7.1.1`; `@google/genai@2.21.0` requires `^4.6.2`                                   |
| `p-timeout`                 | `p-queue@6.6.2` requires `^3.2.0`; `p-queue@9.3.3` requires `^7.0.0`                                                            |
| `process-warning`           | `light-my-request@6.6.0` requires `^4.0.0`; `fastify@5.12.6` requires `^5.1.0`                                                  |
| `real-require`              | `thread-stream@4.2.0` requires `^1.0.0`; `pino@10.3.1` requires `^0.2.0`                                                        |
| `supports-color`            | `@poppinss/dumper@0.6.5` requires `^10.0.0`; `@sentry/bundler-plugins@11.4.0` requires `^8.1.1`                                 |
| `typescript`                | `@nestjs/swagger@12.0.2` requires `^5.5.0                                                                                       |     | ^6.0.0`; `workspace:.`requires`^7.0.2` |
| `ws`                        | `@vitest/browser@5.0.5` requires `^8.22.0`; `miniflare@5.20260926.0-alpha` requires `8.21.0`                                    |

The joint reachable closure of the required Vite+, Miniflare, Sentry Node,
TypeScript 7, formatter and linter declarations is **282 identities** in the
current graph (shared identities counted once). This is a read-only union
measurement, **not a proved minimum** for a future implementation and not a
proposal to remove other required consumers. It does not establish impossibility
of meeting the budget. The real complete inventory remains **548**, over the
unchanged ceiling by **263**.

Further source-compatible reductions require evaluating upstream consumer
updates against their actual APIs and qualification, rather than forcing the
incompatible ranges above. In particular, AWS Bedrock's exact token-provider
pin and S3's newer provider chain need an upstream-compatible alignment;
LangChain queue/retry majors need their respective supported consumers aligned;
Vite+/Miniflare/TypeScript peer constraints belong to the already-supported
build/emulator graph. No such upstream version is invented or adopted by this
receipt, and no package/API removal is authorized by the arithmetic.

### Checked output optimization and validation limits

The SDK operation catalog now preserves imported schema type references in its
emitted declarations. These are 108 `as typeof ImportedSchema` assertions over
the exact existing values. They preserve all 54 operations in this independent main catalog, including
its existing lead-publication operation, and change no runtime schema or
operation definition. The separate unmerged Pi child-publication operation
is not part of this candidate or this receipt. Strict
TypeScript type equality and bidirectional assignment checks pass with
`skipLibCheck=false`; generated JavaScript remains byte-identical (SHA-256
`8842111d497096f0c02c512eb10daef9127dc4c3a4f8669c88611dadf0a8dfbf`).

`operations.d.ts` shrinks from **373,997** to **22,052** bytes without stripping
public declaration documentation or license notices. The real distribution
check goes from **12,611,584** bytes (28,672 above its ceiling) to **12,259,328**
bytes, below the unchanged **12,582,912** ceiling. SDK types, OpenAPI parity and
all **38** SDK tests pass, including the isolated packed consumer test.

The existing requirements candidate-tree repair is consumed identically from
reviewed donor heads `90d0bac8ad3e5ce58b977157649f6b7230b26310` (#1210) and
`5d9842a64e4ce8c5d71f91664efa2ca7262d1037` (#1204), limited to its checker,
regression tests and reconciliation record. Its **84** tests pass and the real
check validates **200** requirements and **103** issue audits. Provenance
warnings remain visible; the repair compares the same candidate bytes read by
the rest of the check rather than substituting historical HEAD contents.

The startup inspection subprocesses now use an unignorable timeout signal.
Three pinned-Bun regressions install a TERM-ignoring finite command and confirm
that RSS, parent-PID and listener inspections still stop within the existing
bound. The probe's unrelated-listener authority and owned-child cleanup guards
are retained.

The earlier aggregate test run encountered lifecycle and digest-history
failures, then was interrupted to release the shared host. It is **not** a
passing aggregate suite. Focused qualification and normal hooks are reported
separately; dependency acceptance remains failing at **548 / 285**.

## Historical audit evidence before consolidation

The following original audit/recovery receipts are preserved for provenance.
Their **591** totals, old tool versions, per-root figures and installation layout
refer to those historical heads; current acceptance and the residual above
supersede them.

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
      "residual":276,"reachable":true,"minimumRemovals":null,"overageUpperBound":306},
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

| Declared root                                                                                                              | Exclusive share = what removing it sheds |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `vite-plus`                                                                                                                | 160                                      |
| `miniflare`                                                                                                                | 50                                       |
| `@sentry/node`                                                                                                             | 40                                       |
| `typescript`                                                                                                               | 21                                       |
| `oxfmt`                                                                                                                    | 20                                       |
| `oxlint`                                                                                                                   | 20                                       |
| `@langchain/langgraph-checkpoint-postgres`                                                                                 | 14                                       |
| `@langchain/langgraph`                                                                                                     | 9                                        |
| `drizzle-kit`                                                                                                              | 9                                        |
| `@nestjs/swagger`                                                                                                          | 7                                        |
| `@restatedev/restate-server`                                                                                               | 5                                        |
| `@nestjs/platform-fastify`, `@opentelemetry/sdk-metrics`, `class-validator`                                                | 4 each                                   |
| `railway`, `@aws-sdk/client-s3`                                                                                            | 3 each                                   |
| `@fastify/helmet`, `@earendil-works/pi-durable`, `@restatedev/restate-sdk`                                                 | 2 each                                   |
| `acorn`, `code-foundry`, `typescript6`, `drizzle-orm`, `@hpke/core`, `@hpke/dhkem-x25519`, `class-transformer`, `postgres` | 1 each                                   |

Twenty-seven declared roots have an exclusive share, and the shares sum to **387**
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

**Six removals are a sufficient greedy sequence; a minimum is unproved.**
Shared identities can become removable only after several roots disappear.
The sum of the largest single-removal savings therefore does not bound the
saving of a combined removal. `minimumRemovals` is `null` while a minimum is
unknown; the measured sequence remains available for architecture review.

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

| Path                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-budgets.mjs`                                          | the counting rule is **unchanged** — no parser defect is proven (§2), so the counter is not touched. The checker gains the attribution: `attributeExternalPackages` walks the lockfile graph from the declared roots with **every edge resolved to the entry that provides it** and **optional peers not treated as edges**, records the owning manifest of every declared root, the consumers of every identity and the install layout of the measured listing; `planDependencyReduction` measures a sufficient greedy reduction sequence without claiming a minimum; and the `deps` report carries the attribution next to the unchanged verdict |
| `packages/production-readiness/src/dependency-budget-scope.test.mjs` | the regression tests pin the §2 invariants over the **real** listing, the per-root attribution against the published table, the measured reduction sequence without an unproved minimum, the install path and the consumers of a nested identity, and that the exclusive share of a root and its removal saving are the same set — the measurement's own count, the ceiling and the identity rule are unchanged, and the real listing is measured with the seam unset                                                                                                                                                                              |
| `docs/1230-dependency-budget-attribution.md`                         | this document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 9. Receipts

- Real measurement, seam unset: `BUDGET EXCEEDED: {"ok":false,"ceiling":285,"measured":591,"scope":"lockfile tree"}`, exit 1.
- Re-verified after the reconciliation with current `main` (`019604a11`, release 1.106.0): the measured closure is still **591** against the unchanged **285** ceiling, the per-root attribution is unchanged (168/117/87/76/56/49/42/38), the reduction plan is still six removals reaching 276, and the gate still exits 1. The reconciliation brought main's own manifests and lockfile; it changed no number in this document.
- The counting rule was audited independently of the checker on the real listing: 644 non-empty lines = 1 header + 45 workspace links + 598 external entries, with **0** unparsed lines, **0** entries the identity rule drops, **0** counted identities that no listing line names, **0** malformed identities and **0** workspace packages counted. The 591 is the exact size of the lockfile's external closure, and there is no counting defect to repair.
- Installed graph: 374 distinct external identities on this host (376 store entries walked).
- Focused regression: `bun test src/dependency-budget-scope.test.mjs` (packages/production-readiness) — 21 pass / 0 fail.
- Reproduced attribution: the lockfile walk reaches exactly the 591 counted identities (591 = 591, no difference in either direction, no unresolved root), the per-root attribution reproduces the table `docs/405-runtime-audit.md` §3.3 publishes, and the gate's own report carries it.
- The measured plan: six removals reach 276 against the unchanged 285 ceiling, without establishing whether a smaller set can.
- The ceiling is unchanged: `budgets.json` → `dependencies.externalPackageCeiling = 285`.
- No manifest, lockfile or threshold was edited, and no dependency was removed.
- No release and no deployment were performed or requested.

## Reconciliation correction

The recovery branch and #1214 are preserved together. Dependency edges now
resolve through intermediate scoped ancestors, and root declarations retain
workspace-specific resolutions. Regression fixtures cover nested versions,
scoped parents, workspace conflicts, aliases, and the unproved-minimum report.
The measurement, ceiling and verdict are unchanged. No fixture substitutes for
the real listing. Removing build tooling, Miniflare tests, database migration
commands or supported Sentry instrumentation is not a safe unused-dependency
cleanup; their source consumers must be retained.
