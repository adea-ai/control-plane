# Pi source authority: characterization and qualification

This page separates what the #1178 source-authority candidate has **verified by
characterization** from what Adea #1178 still needs as **physical and profile
qualification**. It describes evidence only. It enables nothing: the candidate code
is not wired to startup or HTTP, and Adea's foreign-Agent guard stays enabled.

Rule for readers and reviewers: a synthetic or same-realm test double is never
physical qualification. A passing result below qualifies the named test, not a
source workspace, Agent, profile, tool, grant, payer, provider or destination.

## 1. Verified characterization (synthetic ports, no physical effects)

These claims are about CP code behavior with test-controlled authority ports. Each
test supplies its own host, source, model, funding and provider answers
(`SYNTHETIC_*` errors and `synthetic:*` references in the fixtures), so they prove
how the code reacts to those answers, not that any real authority gives them.

| Layer             | What is verified                                                                                                                                                                                                                                                                                                    | Evidence                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal schemas  | Strict host/source binding and publication schemas; missing source identity, added authorization fields, host-for-source scope substitution, cross-group or same-name Agent conflation, changed actor/audience/enlistment/profile pins and renewed intent deadlines all fail closed. Parsing confers no authority.  | `apps/control-api/src/pi-durable/source-authority-contract.test.mjs`, `apps/control-api/src/pi-durable/source-publication-contract.test.mjs` |
| Product authority | Source-scoped profile/model resolution retains both host and source metadata in SQLite; no host selector or profile fallback; expiry and revocation across awaited waits deny without renewing the deadline; the final combined fence is required; SQLite reopen cannot adopt a changed source default.             | `apps/control-api/src/models/production-source-lead-product.test.mjs`                                                                        |
| Node composition  | Compiled plans must use the source workspace and the exact qualified Agent and immutable profile; host or legacy project plans, missing host-context qualification and unqualified child wiring are refused.                                                                                                        | `apps/control-api/src/pi-durable/source-node-composition.test.mjs`                                                                           |
| Lifecycle         | One run through real SQLite catalog, admission, preparation, journal and ledger and the Pi-native loopback runtime: prepare, native dispatch, progress, restart and reopen, retained publication metadata, and denied reads after revocation. **Host, source, funding and provider authority ports are synthetic.** | `apps/control-api/src/pi-durable/source-node-lifecycle.test.mjs`                                                                             |
| Publication       | Retained metadata joins the host target with freshly revalidated source publication; revocation or expiry during awaited metadata or a delayed final fence denies; host scope or a changed native session cannot replace source scope; no output is returned.                                                       | `apps/control-api/src/pi-durable/source-publication-current.test.mjs`                                                                        |

## 2. Required physical and profile qualification (not established)

None of the rows below is established by this candidate. Rows 1 to 5 and 9 need
real deployed identities and tools that this repository does not contain and this
environment cannot create. Rows 6 to 8 are product work that does not exist yet.

| #   | Required for #1178                                                                                                                                                  | Why it is not established                                                                                     | Can this environment do it?         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Designated source workspace and Agent identity                                                                                                                      | No evidence names a designated source Agent. The recorded guest workspace has no Agent or runtime node.       | No. Nothing may be invented.        |
| 2   | Immutable source profile and model selection                                                                                                                        | Needs the designated Agent's real profile. Tests build their own.                                             | No                                  |
| 3   | Authorized runtime/node definition or connection for the source                                                                                                     | None exists for the source identity.                                                                          | No                                  |
| 4   | Source tool definition, version and reference, then a physical tool effect at an authorized destination                                                             | No registered source tool; lifecycle tests use a loopback Pi-native runtime and perform no physical effect.   | No                                  |
| 5   | Existing source grant and payer binding                                                                                                                             | Tests use `synthetic:source-funding` and `synthetic:source-payer`. No grant or payer may be created for this. | No                                  |
| 6   | Production lock-backed combined fence (`withCurrentAuthorization`) holding host service and source actor/principal/grant authority together, with lock-order review | The port is an interface. The only implementations are same-realm test doubles.                               | Code does not exist. Not done here. |
| 7   | Startup and HTTP wiring, and Adea delivery integration                                                                                                              | Candidate code is unwired by design; the guard stays enabled. Adea's side lives in adea-ai/adea#1327.         | Not in this repository              |
| 8   | Live provider execution of the source Agent                                                                                                                         | No provider credential or funding is used or created.                                                         | No                                  |
| 9   | Hosted CI, hosted PostgreSQL/Restate, and the pinned PostgreSQL image                                                                                               | Draft PR, so hosted checks are skipped.                                                                       | See section 4                       |

## 3. Checks run in this environment

Receipts are for CP head `e21e48a6b0df1a3cfbf94f0d8019f25f4660dc4b`
(tree `0c312638b167a2a51e515ec1e78010ba2c259733`; see PR description for the head
that adds this page, which changes documentation only). Environment: Bun 1.4.2,
Node v22.22.0 (the repository pins Node 24.21.0; test runs use Bun), Linux
container, `bun install --frozen-lockfile --ignore-scripts` with no lockfile change.

| Check                       | Command                                                                    | Result                                                                                        |
| --------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Build                       | `bunx --no-install turbo run build`                                        | 45 of 45 tasks                                                                                |
| Lint                        | `bun run lint`                                                             | exit 0 (turbo lint, oxlint on tests, boundaries, canonical ordering)                          |
| Format                      | `bun run format:check`                                                     | exit 0, 1,825 files                                                                           |
| Type-check                  | `bun run type-check`                                                       | exit 0 (build, OpenAPI, db:check, compatibility, requirements, architecture, infra)           |
| Source focused suite        | the two `bun test` commands in the PR description                          | publication 8/8; combined 128/128 across 19 files                                             |
| Contracts                   | `cd packages/contracts && bun test`                                        | 103 pass, 0 fail                                                                              |
| Control API                 | `cd apps/control-api && bun test src --timeout 30000`                      | 611 pass, 15 skip, 0 fail                                                                     |
| Architecture and repository | `bun test tests/m11-architecture-audit.test.mjs tests/repository.test.mjs` | 38/38                                                                                         |
| Unit group                  | `bun scripts/run-bun-test-group.mjs unit --timeout 30000`                  | 3,734 pass, 11 skip, 2 fail across 434 files; both failures are environmental (see section 4) |

The 15 skipped control-api tests are the PostgreSQL-gated integration tests
(`budget-admission`, `marketplace-installation`, `validation-replay`). None of the
source-authority tests is skipped.

## 4. Checks this environment cannot support

- **Pinned PostgreSQL 18.6 image and Compose stack.** The container has the Docker
  client but no daemon (`docker ps` cannot reach `/var/run/docker.sock`). The
  PostgreSQL 16 binaries on this machine are not the pinned image, and nothing in
  the source candidate uses PostgreSQL, so no substitute run is claimed.
- **Two permission-denial unit tests.** `operator-inspection.test.mjs` ("fails closed when an
  existing WAL sidecar cannot be copied") and `object-store/src/filesystem.test.mjs`
  ("normalizes filesystem read failures...") rely on `chmod 000` denying access. This
  container runs as uid 0, which ignores file modes, so both fail here. Neither file
  is touched by this PR, and neither relates to source authority. They need a
  non-root run (hosted CI) to be confirmed.
- **Hosted CI, Restate and PostgreSQL.** Draft PRs skip the hosted lanes. No PostgreSQL target
  or credentials are available.
- **Anything in section 2.** These need real identities, tools, grants and payers.

## 5. When a row may move

A section 2 row moves to verified only with evidence that names the real
identity or tool, the exact CP and Adea heads, the command, and the destination
checked, produced without created grants, payer changes or widened scope.
Rewording a synthetic test never moves a row.
