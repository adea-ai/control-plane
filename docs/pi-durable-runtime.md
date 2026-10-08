# Pi Durable runtime and authority

This first R1/R3 slice adds an opt-in **Node SQLite remote-host profile**. It uses
Node 24.21.0 and Pi Durable/Pi AI/Chord 1.1.0, reviewed at upstream Pi commit
`1cedd32724abfcb0915f76cc61b6827e2c16dbad`. These exact packages were published on
2026-10-07. Their recent release is an explicit exception to the usual seven-day
dependency preference: this experimental API is pinned, not resolved from latest.
All three direct Pi packages declare the MIT license; their notices stay in the
installed dependencies. The private adapter adds no native binary or new license
terms to the public contracts. Pi AI brings provider SDK dependencies into the
explicit Node profile; none is used to create ambient credentials or login flows.
Cloudflare Agents commit `000d076d535b8bf53ac66b2c86c4c83c5a95d8c7` is a design
reference, not a Worker/DO deployment implemented here.

The implementation has real Harness, Node process and physical SQLite restart
evidence. Provider HTTP responses, product evidence and recorded spending records
in the fixtures are controlled test inputs. This does not qualify a live account,
Cloudflare hibernation, a production deployment, or a model-driven child tool.

## Ownership and retained paths

| State or effect                                                               | Durable owner                                     | Boundary                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Canonical message, conversation/Agent and lead intent                         | Adea                                              | Versioned product authority port rereads original message, lead/profile and current audience |
| Accepted execution, exact attempt, plan, policy and allowance                 | Existing CP domain repositories                   | Budget-enabled command inbox plus immutable plan validation                                  |
| Runtime admission, input replay keys, approval references, output and cursors | Adapter `authority.sqlite`                        | Versioned immutable admission plus atomic state/event commits                                |
| Native generation and AssistantEntry receipt                                  | One Pi Harness SQLite store per admitted session  | Exact runtime version and PID/epoch ownership fencing                                        |
| Recorded spending authorization, price and usage                              | Existing model authority and durable usage ledger | Separate server-authenticated decision; one physical-send hold and settlement                |
| Credential values and one-use leases                                          | Existing vault                                    | Registry creation, inference and disposal entirely inside credential-use callback            |
| Governed tools and approval decisions                                         | Existing tool-execution/domain services           | Full request digest, canonical attempt, action, audience and expiry checks                   |
| Child terminal publications                                                   | Existing delegation service and parent inbox      | Exact child attempt; independently retained and deduplicated evidence                        |

The adapter completion record remains after the native Harness closes. Native
task state is never the sole completion record. SQLite files contain approved
prompt/output content and opaque selection references; credential values and
lease capabilities are excluded. Each intent admits one isolated runtime session
and retains its canonical product message reference; this slice does not combine
multiple product conversations into a shared agent context.

| Existing component                                                 | Disposition in this slice                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Managed Pi subprocess                                              | Retained; its unsupported in-flight reconciliation remains truthful |
| Direct-session and legacy runtime paths                            | Retained                                                            |
| Restate and LangGraph                                              | Retained                                                            |
| Shared execution-plan/domain/tool-execution/usage-ledger authority | Reused                                                              |
| Node Pi Durable runtime package                                    | Added behind explicit composition                                   |
| Cloudflare Worker/DO profile                                       | Not implemented or qualified                                        |

## Admission and HTTP contract

`createNodePiDurableLeadComposition` requires a persistent canonical repository
composition, budget-enabled command repository, current plan validator,
`PiLeadProductAuthorityPort`, eligible provider resolver, recorded-spend bridge
and explicit inference reconciliation policy. The factory creates its own SQLite
intent/receipt store, composes the actual adapter, drains retained parent inbox
evidence independently of model inference and scans retained runtime admissions.
The caller owns closing this composition and its external repositories.

Product `readCurrent` accepts `{schemaVersion:'pi-lead-intent/v1',intentId,
workspaceId,principalId}`. It returns verified immutable message/profile/selection
references, original principal, scoped authority revision, current audience,
expiry and authorized prompt. This is a server port; a caller cannot supply this
evidence as the dispatch payload. CP derives deterministic execution/attempt and
command identities from workspace plus UUID intent, persists a marker before
acceptance, and repairs incomplete admission without another command or budget.

Current canonical plans require a project. Product evidence can be workspace
scoped, but absent/null project returns `PI_LEAD_PROJECT_SCOPE_REQUIRED` before
creating any marker, execution, attempt or budget. No synthetic project is added.
Project-free lead execution needs a deliberate canonical plan/domain extension.
The additive `execution.scope.workspace.v1` capability vocabulary reserves that
interface. This runtime increment does not advertise it until its canonical
workspace authority and plan integration are verified.

The strict request/response schemas and `PiDurableLeadHttpContract` are exported
from `@control-plane/runtime-sdk`. Control API mounts the following existing
authenticated envelope operations only when an explicit service is supplied;
otherwise requests return `PI_LEAD_NOT_CONFIGURED`.

| POST route under `/v3/pi-durable/lead-dispatches` | Operation                  | Existing scope     | References                               |
| ------------------------------------------------- | -------------------------- | ------------------ | ---------------------------------------- |
| `dispatch`                                        | `pi-durable.lead.dispatch` | `execution:accept` | UUID `payload.intentId`                  |
| `status`                                          | `pi-durable.lead.status`   | `execution:read`   | `parameters.dispatchId`                  |
| `progress`                                        | `pi-durable.lead.progress` | `execution:read`   | Dispatch ID and optional `afterSequence` |
| `cancel`                                          | `pi-durable.lead.cancel`   | `execution:cancel` | `payload.dispatchId`                     |

Replies use `pi-lead-dispatch/v1`, deterministic `dispatch_<32hex>`, canonical
`exe_`/`att_` references and `runtimeSessionId:ses_<26crockford>`. Progress is a
bounded replay after committed sequence, capped at 256 events and 1 MiB. Request
identity includes operation, caller, workspace/project, command key and immutable
intent evidence. Reuse with changed input conflicts. Read/publication rereads the
current product audience and canonical attempt even after runtime completion.

The public Control SDK adds `dispatchPiDurableLead`, `getPiDurableLeadStatus`,
`getPiDurableLeadProgress` and `cancelPiDurableLead`, validated against these exact
schemas. An isolated tarball consumer test covers the SDK/runtime-sdk dependency
boundary. These source artifacts do not claim a new SDK release is already
published. Adea's existing signer lacks the required execution scopes;
this work does not create grants or credentials. Its U2 intent remains blocked
until an authorized compatible client and signer integration exists.

## Provider, spend and recovery gates

R2 owns immutable `model-selection/v1` connection/account/auth/location/funding
qualification. The runtime binds `{selectionRef,selectionRevision}`, requires
`remote_host/pi_durable/1.1.0/pi_durable_models`, and resolves the complete pinned
snapshot at each registry use. Gateway readiness must check revocation, credential
rotation, quota, grant and policy eligibility. The concrete API-key provider
registry has a fixed OpenAI endpoint, no ambient credential store and no OAuth.
Registry capabilities are removed when the lease callback ends.

Recorded spending semantics reuse merged M11 substrate commit
`2780e4c364dbb634b6196f499d58cbbfdc578fb0`. The native bridge parses its canonical
grant schema and compares the actual immutable attempt allocation, provider,
credential, alias, policy, price and lifetime. Selection readiness and a funded
allowance cannot manufacture a spending decision. R2's paid `byo_api` extension
must update both the retained grant enum and cumulative paid-allocation predicate.
No live BYO qualification is claimed until those compatible artifacts compose.

The conservative quote covers the selected model's entire input context window
plus bounded output before dispatch. Native task identity fences the physical
send across process restart. Authorization is checked again after asynchronous
SDK/auth preparation immediately before fetch. A second fetch is denied;
redirects, SDK retries, deferred calls, compaction and cache writes are disabled.
Provider cost fields are ignored; validated cache-inclusive counts settle against
the retained pinned price through the existing ledger. Missing historical price
or spending evidence leaves reconciliation required, rather than repricing.

An uncertain admitted inference wakes as `unknown` and needs trusted no-resend
reconciliation. `safe_to_resume` must mean that retained accounting/native evidence
permits replay without another uncertain paid effect. Cancellation remains
`cancelling` until the same policy proves the outstanding send reconciled; then it
can become `cancelled` without new inference. A revoked record blocks only itself
in the startup scan; other retained records continue recovering.

Pending input and approval identity are committed atomically. Concurrent input
admissions compare the expected epoch/state so a loser cannot overwrite a retained
turn. The effect gate journals intent before the existing tool executor, retains
exact pending approval and refuses ambiguous replay. Native tools are not exposed;
J1's agreed objective-only `delegate_child` host adapter must compose and pass a
real registry/gate/callback test before model-driven delegation is qualified.

## Reproducible evidence and activation prerequisites

Run focused package tests with `bun test src --timeout 30000` in
`packages/pi-durable-adapter`, and the Pi Durable tests in Control API. The process
fixtures kill only their own Node children and reopen the actual native/journal
stores. Controlled loopback HTTP tests use the default Pi engine and persistent
canonical command/execution/plan/usage stores. Mock engine tests are limited to
deterministic race/fault injection and are labeled separately.

Candidate cross-repository verification uses the actual locally built public
packages before registry release. Build contracts, runtime-sdk and control-sdk,
then run `bun scripts/pack-pi-durable-candidate.mjs /tmp/cp-pi-candidate`.
The script stages the existing `@adea-ai/*` publication rewrite, packs only public
artifacts, and records archive SHA-256 values, the base Git head and a digest of
the current candidate sources. It performs no registry query or publication.
An isolated consumer installs those archives with local overrides for all three
packages; local file paths belong only to its ephemeral fixture manifest.

The test-only `node-candidate.fixture.mjs` starts the real authenticated lead
HTTP module and Node composition on loopback, with a deterministic provider and
synthetic policy scoped to the fixture workspace. It exposes the pinned fixture
profile/selection, an intent-registration control and canonical record counts.
Adea owns the real PostgreSQL canonical message/UUID intent consumer and provides
the authorized product evidence. Its workspace-only intent must return
`PI_LEAD_PROJECT_SCOPE_REQUIRED` with zero CP admission, command, execution,
attempt and budget records. A separate explicitly project-scoped CP fixture
checks dispatch, status, cursor progress and cancellation through the four SDK
methods; it never adds a project to the Adea workspace. Test controls and synthetic
authentication are not production routes, grants or account credentials.

The cross-repository candidate consumer passed against Adea's actual PostgreSQL
message and intent transaction: retry retained the same canonical message and
intent, and workspace-only dispatch left all CP admission, command, execution,
attempt, budget, usage and runtime counters unchanged. The independent explicit
CP project consumer completed all four SDK operations with cursor replay, a
stable runtime session and exactly one scripted physical provider request.
The consumer verified the packed archive hashes and recorded the host source
identity separately from the package manifest. These results establish the
candidate boundaries; they do not qualify a live provider or a combined R2
selection-to-runtime deployment.

Before activating a real account, the accountable composition owner must supply
an eligible R2 selection service and recorded-spend reader for that exact account,
price and deployment; the account owner must provide an already authorized vault
credential if one is absent. Product integration also needs compatible project
scope, published client artifacts and existing authorized signer scopes. The runtime
owner then repeats physical-send, revocation, paid-usage, cancellation and restart
qualification against that exact profile. No access, funding or deployment is
created by this PR. Retain legacy paths for rollback and until integrated cutover
acceptance; no framework or layer is removed here.
