# Decision 558 — context consumer conformance at the existing Control Plane consumers

Status: implemented on `f2w1/cp558-context-consumer-27f17`. Scope: the
existing-consumer context conformance of control-plane#558. This record does
not claim whole-digest acceptance, production or deployed evidence, and it
does not close #558.

## The decision

The decision layer selects; the Control Plane consumers resolve. `resolveDecisionLayer`
stays pure and selection-only: it picks the harness, model, skills,
capabilities, runtime, sandbox, context package and delegation policy, and it
never authorizes, assembles, redacts or grants. Everything that #558 calls
"what context is assembled for a run" is completed where a run is actually
resolved — at the two production-reachable consumers that exist today:

- `POST /v1/executions/validate`, through `DurableExecutionValidationService`
  and the `ContextPackageAuthoringService` / `ContextPackageCompiler` it
  composes, and
- `POST /v1/profiles/resolve`, through `RepositoryProfileResolutionService`.

No endpoint, bridge, authority, or pin-derived grant was added. The Control
Plane identity of a run — the authenticated service principal, the workspace
and the project — and the authorized immutable references it may resolve stay
the only authority basis.

## The proven boundary

The boundary below is what the consumers now guarantee, and what the
conformance suite proves. Everything outside it is unchanged.

### Assembly

`ContextPackageAuthoringService` assembles the context for a run from the
authoritative project state, the artifacts the current grant authorizes, and
the provider contributions the current grant authorizes. The compiler pins the
exact project-state revision and the exact selected item revisions, and the
result is content addressed. The same objective in the same scope therefore
assembles byte-identical context in every composition: the conformance suite
asserts one `contentDigest` across Local, Hosted Simple, Hosted Server and
Cloud, over SQLite and PostgreSQL.

### Redaction

Redaction is fail-closed and stays where it already was. The authoring
authority's `allowedSensitivities` decides which state items and artifacts may
be assembled at all, and the execution constraints' `context.allowedClassifications`
decides which classifications a plan may consume. A state item whose
sensitivity the policy does not allow is never assembled and never redacted
into a partial value: the authoring fails closed with `UNAUTHORIZED_CONTEXT`,
and the content never reaches a package, a plan, a response or an error. The
conformance suite keeps a secret canary in a restricted state item and asserts
it appears in no result.

### CP identity

The authenticated principal, the workspace and the project bind every
resolution. `DurableExecutionValidationService` rejects a request whose
asserted caller is not the authenticated caller, and both consumers resolve
catalog versions under the caller's ownership. The service-authentication
guard binds the asserted caller to the credential, so the asserted identity is
never taken from the request body alone.

### Immutable references

A consumer only resolves what it can verify against the reference it was
given:

- `RepositoryProfileResolutionService` now honors the profile's pinned skill
  content digest and requires the pinned skill version to be published. A
  profile that pins a skill version whose published content no longer carries
  that digest, or whose skill version is revoked, deprecated or superseded,
  does not resolve.
- `RepositoryProfileResolutionService` selects the default published profile
  version by version, then revision, then identifier, so the selection does
  not depend on the order a store returns versions in. SQLite and PostgreSQL
  do not return versions in the same order.
- `RepositoryContextPackageResolutionService` verifies the stored package
  against the digest it publishes. A package whose content does not verify is
  not resolvable, and the endpoint does not publish a reference that no
  consumer could check.
- `DurableExecutionValidationService` refuses a context package whose content
  no longer verifies against the digest it is published under, so a package
  that was damaged after it was written cannot be compiled into a plan. The
  plan compiler verifies the same content independently, and the consumer does
  not rely on that layer to refuse it.
- `DurableExecutionValidationService` resolves a context package against the
  shared consumer scope rule: same workspace, same project, same pinned
  project-state revision, and — when the caller pinned an existing package —
  the same schema and compiler version.

### Current authorization on replay

A replay returns the same recorded result, and re-evaluates the authorization
the run consumed:

- The catalog ownership of the profile and the skill versions is re-read and
  re-checked against the current principal.
- The catalog approval gate now applies to a replay as it does to the first
  pass. A version that is no longer approved is not resolved again.
- A profile or skill version that is no longer executable — revoked,
  deprecated or superseded after the plan was certified — is not resolved
  again. The skill version's lifecycle is re-checked the same way the profile
  version's is: a revoked skill version is refused on a first pass and on a
  replay. A replay never re-reads the durable evidence, so on that path the
  lifecycle refusal is the consumer's own and not the plan compiler's.

The durable evidence a plan pins is deliberately _not_ re-read on a replay.
The context package and the project state were resolved once, are immutable,
and are reference-protected by the retention window; re-reading them would
re-derive the assembly and would make a replay a second assembly. That
boundary is the shipped contract and is asserted by
`apps/control-api/src/application.test.mjs`, which fails a replay that reads
durable evidence again.

## What is already shipped and was not changed

- The decision-layer contract, its precedence layers and the pure resolver
  (`packages/contracts/src/decision-resolution.ts`,
  `packages/policy/src/decision-resolution.ts`) are untouched. The resolver
  still selects; it never authorizes.
- The entitlement and model-access behavior, the harness pin filtering
  (`selectRuntimesExposingHarness`), the runtime attempt router and the
  sandbox rules that intersect with grants are untouched.
- The context compiler's budget, freshness, artifact-lifecycle and
  child-narrowing rules, the provider resolver, the contribution validation
  and the context-authoring command's idempotency are untouched.
- The catalog domain resolver (`resolveCatalogManifest`) and the execution
  plan compiler's own pin, digest and lifecycle checks are untouched. The
  consumers now agree with them instead of being looser.
- The Cloud composition still ships no default context authority. An operator
  must supply one, so context authoring is not configured by default there.
  The conformance suite models that difference rather than hiding it.

## The conformance suite

`apps/control-api/src/decision-context-consumer-conformance.test.mjs` and its
fixtures hold the canonical inputs and the matrix. The suite:

1. proves that the matrix models the real composition roots, by asserting
   that each root still constructs the repositories the matrix models, and
   that only the compositions with a default authority construct a
   `GrantsBackedContextAuthoringAuthority`;
2. resolves the same objective through the same consumer services in the
   Local, Hosted Simple, Hosted Server and Cloud compositions, over SQLite and
   PostgreSQL, and asserts one semantic result;
3. shows that a distinct runtime selection yields a distinct plan while the
   objective, the assembled context and the resolved pins stay equal — the
   suite never requires a whole-digest equality across distinct runtime
   selections;
4. replays deterministically in every composition and shows that a revoked
   profile version denies the replay;
5. shows, in every composition and with a configured catalog approval gate,
   that an unchanged approval keeps the replay idempotent while a
   de-approved pinned profile denies the replay, without a provider read and
   without rewriting the recorded plan;
6. shows that a revoked skill version denies a first pass and a replay, so the
   skill half of the "no longer executable" rule is proved and not only the
   profile half;
7. assembles context with no provider and with a fake alternate provider;
8. denies denied scope, a foreign identity, a revoked or expired reference,
   an incompatible explicit pin, unsupported context and out-of-bounds
   context;
9. proves the redaction rule and the absence of a leak, that a context
   reference whose content does not verify is not published, and that a plan
   is not compiled from a context package whose content does not verify;
10. proves that an explicit pin wins over the current default, for both the
    profile version and the context package, and that the default version
    selection does not depend on the order a store returns versions in; and
11. proves the suite's own resource discipline: an allocation whose
    migration fails is still released, an isolated allocation whose seeding
    fails is still released with the original error kept, and every owned
    disposer is attempted even when an earlier one fails, with the cleanup
    failures aggregated around the original errors.

Seven of those cases fail against the base implementation and pass only after
the repairs in this record: restoring the base consumer services
(`apps/control-api/src/executions/execution-validation.service.ts`,
`apps/control-api/src/queries/profile-resolution.service.ts`,
`apps/control-api/src/queries/context-package-resolution.service.ts`) and
running the suite again fails "replays deterministically and re-checks the
current catalog authorization", "refuses a replay whose catalog approval no
longer holds", "denies a profile whose pinned skill reference no longer
holds", "selects the same default profile version regardless of the store
order", "selects the same default profile version whatever order the store
returns versions in", "refuses to publish a context reference whose content
does not verify" and "refuses a revoked skill version on a first pass and on a
replay". The approval-gate case and the lifecycle-revoke cases are distinct:
the first denies through the catalog approval gate, the others through the
version lifecycle. The pin-precedence, the resource-discipline and the
damaged-package cases pass against the base as well, because they prove
behavior this change preserves rather than repairs: the plan compiler
verifies a context package's content independently of the consumer, so a
damaged package is refused there too.

The two store-order cases prove the same contract at two strengths, and the
difference matters. The multi-composition case composes two real stores and
asks each of them for the two tied versions in opposite orders, but a store
decides its own order: the SQLite store lists by `updated_at, id`, so the two
harnesses only see genuinely opposite orders when the two versions were
written in different milliseconds, and against a base implementation that
selects the default version by version and revision alone the case therefore
detects the defect only sometimes. The second case wraps the catalog so that
it returns the tied versions in a chosen order, and resolves the consumer once
per order, so the selection is proven to be independent of the order a store
returns versions in rather than independent of the order this store happens to
return them in.

The PostgreSQL legs need a configured database. They run when the database
credentials are present, and a job that intends to qualify them sets
`RUN_M10_POSTGRES_CONFORMANCE=true`, which then fails the run instead of
skipping it. Wiring the PostgreSQL legs into the pull-request PostgreSQL job
is a workflow change and is outside the paths this change owns.

## Remaining composition obligations

- **W1 / W2 — decision-layer selection.** `resolveDecisionLayer` still has no
  production caller. The consumers here consume a _selected_ context; the
  selection that produces the pins a run carries remains the decision layer's
  own obligation, and the precedence and diagnostics in
  `packages/contracts/src/decision-resolution.ts` and
  `packages/policy/src/decision-resolution.ts` are unchanged by this change.
- **W1 / W2 — skills and delegation outputs.** The decision layer's `skills`
  and `delegation` outputs remain pin passthrough. The consumer now refuses to
  resolve a skill version that does not match the profile's pin, so an
  unresolved skill output is denied at the consumer rather than resolved
  wrongly; the selection of the skill set itself is still the decision
  layer's obligation.
- **W1 — Cloud composition authority.** The Cloud composition
  (`apps/control-api/src/cloud-composition.ts`) has no default context
  authority, so `POST /v1/executions/validate` with `contextInputs` fails
  closed with `CONTEXT_AUTHORING_NOT_CONFIGURED` there while the Local and
  Hosted Server compositions assemble the context. Supplying a default
  authority for Cloud, or documenting the operator step, is a composition
  decision outside this change.
- **W1 — harness, runtime, sandbox and delegation composition.** Unchanged
  here. The conformance suite covers the context output only.
- **Root — CI coverage of the PostgreSQL legs.** The PostgreSQL legs of the
  suite are proven locally and are gated on the repository's existing
  PostgreSQL opt-in. Making them part of the pull-request PostgreSQL job
  needs a workflow change.

## Evidence

Run from the isolated worktree at `27f17bd55e0266439b5b3089163195c9e7a669be`
on branch `f2w1/cp558-context-consumer-27f17`.

```
bun test src/decision-context-consumer-conformance.test.mjs --timeout 30000
  18 pass, 0 fail (SQLite legs)

DATABASE_ADMIN_URL=… DATABASE_MIGRATION_URL=… DATABASE_URL=… \
  RUN_M10_POSTGRES_CONFORMANCE=true \
  bun test src/decision-context-consumer-conformance.test.mjs --timeout 60000
  17 pass, 0 fail (SQLite and PostgreSQL legs)
  the recorded PostgreSQL run predates the three cases this record adds after
  it — the store-order case, the revoked-skill case and the plan-integrity
  case; the PostgreSQL legs were not re-run for them
  superseded: the PostgreSQL legs were re-run for every case at this head, and
  that receipt is recorded below

bun --cwd apps/control-api test src
  710 pass, 15 skip, 1 fail
  the one failure is apps/control-api/src/models/sqlite-funding-confirmations.test.mjs,
  which spawns `node`; this environment has no `node` on PATH

bun --cwd packages/context test
  74 pass, 0 fail
bun --cwd packages/execution-plan test
  52 pass, 0 fail
bun scripts/run-bun-test-group.mjs unit --timeout 30000
  4287 pass, 11 skip, 48 fail, 2 errors
  the same lane with the four repaired source files reverted to the base
  commit reports 4283 pass, 11 skip, 52 fail, 2 errors; the only difference
  between the two runs is the conformance cases that need the repair,
  so every other failure is pre-existing
  the conformance file alone, with the three consumer services reverted to
  the base commit, reported 12 pass and 6 fail
  the deterministic store-order case fails the base implementation in every
  run (6 of 6), and the multi-composition store-order case fails it in 10 of
  10 runs; both pass at this head in 10 of 10 runs
bun run format:check
  All matched files use the correct format
bun run lint
  0 boundary violations; canonical ordering and digest-writer checks passed
bun run architecture:check
  Validated 45 packages, 54 operations, and 4 profiles
bun run db:check
  Everything's fine
bun run compatibility:check
  passed
bun run infra:typecheck
  No type errors in 208 files
```

The cleanup and replay regressions in this record were added on top of that
head, and were checked with the focused suite and the lightweight checks only
(`format:check`, `lint`, and the `control-api` and `context` package type
checks); the unit lane was not re-run for them. The focused consumer run for
that head covers the conformance suite, the application test and the two
consumer service tests:

```
bun --cwd apps/control-api test src/decision-context-consumer-conformance.test.mjs \
  src/application.test.mjs src/queries/profile-resolution.service.test.mjs \
  src/executions/execution-validation-graph.test.mjs --timeout 60000
  81 pass, 0 fail
```

The lifecycle regressions for a revoked skill version, and the plan-integrity
regression for a context package whose content does not verify, were added on
top of that head as well and were checked with the focused suite, the
`control-api` package lane, the full type-check chain and the normal
pre-commit hook:

```
bun test src/decision-context-consumer-conformance.test.mjs --timeout 30000
  20 pass, 0 fail (SQLite legs)
  20 pass, 0 fail in 10 of 10 runs

bun --cwd apps/control-api test src
  720 pass, 15 skip, 0 fail (735 tests / 88 files)

bun run type-check
  Validated 200 requirements and 103 issue audits
  Validated 45 packages, 54 operations, and 4 profiles
  No type errors in 208 files

# the three consumer services reverted to the base commit, head test file
bun test src/decision-context-consumer-conformance.test.mjs --timeout 30000
  13 pass, 7 fail
  the seven failures are the six cases this record already listed plus
  "refuses a revoked skill version on a first pass and on a replay"
  the earlier receipt's 12 pass and 6 fail belongs to the head it was taken
  on; the same recipe at this head reports the counts above

# the consumer's skill-lifecycle check removed from the replay path
bun test src/decision-context-consumer-conformance.test.mjs --timeout 30000
  1 fail
  the revoked-skill case fails: the replay resolves a revoked version
```

The pre-commit hook was run with this record's whole scope staged — the seven
paths this change owns, on top of the base commit — and passed: the format
check, the orchestrator build (47 of 47 tasks) and the type-check chain above.

The focused consumer run for this head covers the same set — the conformance
suite, the application test and the two consumer service tests:

```
bun --cwd apps/control-api test src/decision-context-consumer-conformance.test.mjs \
  src/application.test.mjs src/queries/profile-resolution.service.test.mjs \
  src/executions/execution-validation-graph.test.mjs --timeout 60000
  84 pass, 0 fail
```

The PostgreSQL legs were re-run for **every** case at this head, against a
disposable PostgreSQL 16.15 with a migration principal that owns the isolated
database and an application principal that cannot create or alter anything:

```
DATABASE_ADMIN_URL=… DATABASE_MIGRATION_URL=… DATABASE_URL=… \
  RUN_M10_POSTGRES_CONFORMANCE=true \
  bun test src/decision-context-consumer-conformance.test.mjs --timeout 120000
  20 pass, 0 fail (SQLite and PostgreSQL legs)

# the same run with the application principal's password replaced
  16 pass, 4 fail
  "password authentication failed for user \"appuser\""
```

The two `hosted-server` and `cloud` profiles are the PostgreSQL ones, and the
case that resolves the same objective in every composition asserts that every
profile produced a projection, so the PostgreSQL legs are part of the passing
run rather than a skipped branch. The falsification run is the proof of that:
with the application principal's password replaced, the run fails against the
real server, so the passing run really talked to PostgreSQL. The disposable
server, the isolated databases and the credentials were local to that run and
are not part of the repository.

### The replay contract, aligned in the consumer that asserted the older one

`apps/local-control-plane/src/validation-replay.test.mjs` asserted that a
replay reads **nothing**: the project state, the context package and the
catalog approval gate were all stubbed to fail. The contract this record
proves is narrower. A replay re-evaluates the **current authorization** — the
catalog approval gate applies to a replay as it does to the first pass, so a
version that is no longer approved is not resolved again — while the durable
evidence the plan pins is still never re-read, because it was resolved once and
is immutable. That test now stubs the approval gate with an approving decision
and asserts the replay consulted it exactly once, for the profile version it
consumes; the project-state and context-package reads are still refused on the
replay path, and the replay still reads no clock.
`apps/control-api/src/validation-replay.integration.test.mjs` already keeps the
real approval gate on the replay path, so the two consumers now agree.

### The qualification for this head

```
bun test src/decision-context-consumer-conformance.test.mjs --timeout 30000
  20 pass, 0 fail (SQLite legs)

DATABASE_ADMIN_URL=… DATABASE_MIGRATION_URL=… DATABASE_URL=… \
  RUN_M10_POSTGRES_CONFORMANCE=true \
  bun test src/decision-context-consumer-conformance.test.mjs --timeout 120000
  20 pass, 0 fail (SQLite and PostgreSQL legs)

bun --cwd apps/control-api test src
  720 pass, 0 fail (735 tests / 88 files)

bun --cwd apps/local-control-plane test src
  355 pass, 0 fail (355 tests / 46 files)

bun --cwd packages/context test
  74 pass, 0 fail
bun --cwd packages/execution-plan test
  52 pass, 0 fail

bun --cwd apps/control-api test src/decision-context-consumer-conformance.test.mjs \
  src/application.test.mjs src/queries/profile-resolution.service.test.mjs \
  src/executions/execution-validation-graph.test.mjs --timeout 60000
  84 pass, 0 fail

bun run format:check
  All matched files use the correct format
bun run lint
  0 boundary violations; canonical ordering and digest-writer checks passed
bun scripts/workspace-boundaries.mjs
  1231 files in 45 packages, 0 boundary violations
bun run architecture:check
  Validated 45 packages, 54 operations, and 4 profiles
bun run db:check
  Everything's fine
bun run compatibility:check
  passed
bun run infra:typecheck
  No type errors in 208 files
bun run openapi:check
  passed
bun scripts/run-bun-test-group.mjs unit --timeout 30000
  4343 pass, 1 fail (4355 tests / 465 files)
  the one failure is apps/runtime-gateway/src/index.test.mjs → "forwards the
  host credential authority in an isolated subprocess", which reads a test name
  out of a `bun test` subprocess summary that this Bun build does not print. It
  fails identically on a pristine base commit and this change touches no file
  under apps/runtime-gateway
```

`bun run openapi:check` passes in this environment, so the "OpenAPI artifact
drifted" failure recorded above is not reproduced here; it is a property of the
environment that recorded it, and the artifact is unchanged by this change.

Three repository checks fail in this environment for reasons outside this
change, and all of them are preserved rather than worked around:

- `bun run openapi:check` reports "OpenAPI artifact drifted". The OpenAPI
  document generated from the untouched contract and SDK sources is
  semantically identical to the committed artifact; the local formatter
  truncates the 390 kB single-line JSON the generator feeds it. The same
  failure reproduces on the pristine base commit.
- `bun run requirements:check` reports "Requirements report drifted" once the
  ledger validates. The rendered report follows the live GitHub issue list,
  which has moved since the report was last written. The ledger itself
  validates. A local run needs an authenticated `gh` or `GH_TOKEN`; the
  tokenless path is subject to the public API rate limit.
- The unit lane reports 48 failures, all of them pre-existing: the same lane
  with the repaired source files reverted reports the identical 48 plus the four
  conformance cases that need the repair. The failures are process-spawning
  tests that need a `node` binary this environment does not have, an SDK
  packaging install, and a dependency patch check; none of them is in a package
  this change touches.

## Accepted limits

- The conformance suite composes the consumer services, the repositories and
  the context authority by hand, from the same classes the composition roots
  construct. It is not a real application bootstrap, it does not start the
  Nest application, and it does not exercise a live Cloud authority: the
  authority, the approval decisions and the provider are injected fixtures.
  The Cloud composition's missing default authority is therefore a modelled
  difference, not an observed production one.
- The conformance suite compares semantic projections across compositions. It
  does not require a whole-digest equality across distinct runtime
  selections, and it does not duplicate the current actor's authority.
- No text-redaction policy was invented. The redaction rules that exist —
  sensitivity, classification, artifact lifecycle — are the ones the suite
  proves.
- No harness prompt was rewritten, no harness loop, compaction or scheduler
  was added, and no provider or production path was activated.
