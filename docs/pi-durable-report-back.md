# Retained child report-back increment

This additive increment addresses the terminal-outcome/publication crash window in
`DelegationService`. It is preparation for the approved Pi Durable first slice;
it does not qualify a Pi runtime or enable new admissions.

A child callback must carry its admitted `childAttemptId`. Delayed events from an
older attempt cannot affect a running retry or its publication. Missing attempt
identity fails closed. `ChildProgressInputSchema` is the exported strict callback
contract. Dispatch retains its exact attempt/runtime/session identities and a
pending command intent before changing canonical execution state. Replaying a
dispatch never creates a second attempt or switches runtimes.

A completed, failed or cancelled child first retains a bounded `pendingProgress`
intent, after validating the lifecycle transition without effects. Recovery can
finish attempt/execution transitions even if the caller died before the terminal
delegation CAS. Cascade cancellation similarly retains its original cancellation
intent before transitions. An already retained child result wins over later parent
cancellation. A completed, failed or cancelled child persists a pending terminal-publication
receipt in the same delegation compare-and-set as its terminal state. The receipt
contains only a stable publication key, status and bounded failure/cancellation
metadata. The original outcome references and observation time remain authoritative.
The sender acknowledges publication only after the parent inbox accepts it.

`DelegationEventPublisher.publish(event, idempotencyKey)` must atomically retain and
deduplicate delivery. A publisher that ignores the key does not meet the recovery
contract. `SqliteDelegationEventPublisher` supplies a persistent parent-scoped inbox
with duplicate suppression and payload-conflict rejection. Its strict event schema
rejects prompt and credential payload fields. It does not invoke a model, send tools
or write the user-visible Adea timeline.

`SqliteDelegationRepository` retains canonical delegation state and immutable plan,
context and execution references in the same SQLite provider as execution lifecycle
records. Reference validation and child uniqueness occur in one writer transaction;
CAS rejects revision or immutable admission changes. Retained delegation and inbox
evidence pin execution/plan deletion. Pending compiler receipts also pin their parent
execution and plan before a child effect, and retention validates canonical parent
plan/attempt references inside the receipt writer transaction. This increment does not define an erasure
policy for those records; releasing those pins requires a separately qualified
retention and publication policy.

Recovery calls `reconcileChildPublications(parentExecutionId)` through the existing
authorized parent scope, without requiring a lead model turn. Product timeline
delivery still needs its own current audience check and publication receipt. The
SQLite inbox is not a substitute for that authorization boundary. Composition must
provide the correct parent scope and arrange recovery wake-ups. The structural
`DelegationParentInbox` port exposes `list(): Promise<readonly DelegationEvent[]>`.
Reads are nondestructive; wake callbacks are advisory and never acknowledge user
publication or require inference. Run recovery at startup independently of model
turns. Native tool effects remain governed by the existing tool-execution authority.

The additive `CanonicalDelegationRuntimeBridge` takes the strict trusted-host
`delegation-runtime-admission/v1` identity: `parentExecutionId`, `parentAttemptId`,
`delegationId` and `childAttemptId`. It reloads canonical lineage, immutable plan
and context pins, the exact active attempts and the selected runtime connection.
The delegation retains `parentAttemptId` and `admittedToolCallId`; they are optional
for legacy records, required on this governed path and immutable after admission.
Recovery must re-read that originating tool call and approval through the supplied
authority port, as well as current actor, provider and funding authority. Retaining
a child record alone grants no permission to spend. A separate budget port recovers
the same authorized reservation; the bridge checks authority again after that await.
The governed executor carries its abort signal through child admission and checks
it after awaited dispatch, budget and authority work before starting inference.
The signal is transient and does not replace current authority on restart.
`RuntimeAdapter.start` receives the stored child plan and exact attempt with stable
`delegation:<delegationId>:attempt:<childAttemptId>` identity. The adapter must retain
and reconcile that request and its handle across process restarts.

The prepared workspace composition adds a trusted `DelegationScopeAdmission`
constructor port to `DelegationService`. Its caller resolver must reload the original
actor from canonical admission and the retained source tool call; a transport service
or model-supplied actor cannot substitute for that identity. Explicit plans use the
kernel's async `deriveExecutionPlanWithAuthority`, rechecking both exact plan pins,
current audience/grant/expiry and real same-workspace project membership before
writes and on replay. Missing authority fails closed. Legacy plan-1 inputs keep their
existing derivation and input digest, while the public synchronous helper still
denies workspace-to-project narrowing. Physical SQLite reopen tests cover this workspace-to-real-project path, current
grant revocation on replay, stale child attempts and retained completion/cancellation.
Native Pi and product publication still require combined qualification.

Prepared `delegation-tool-admission/v1` receipts retain the full
`DurableToolCallRequest` and bounded server compiler command before the policy
service/effect gate runs. `sourceKey` is exactly `pi-tool:<64 lowercase hex>`.
R1 must verify and hash its persisted native ToolTask, AssistantEntry and journal
identity tuple; this host store treats that reference as opaque. It is stable across
process epochs and contains no prompt or credential material. Workspace-scoped
SQLite atomically fences source key, request ID and tool-call ID, rejecting changed
request, actor, grant, approval or compiler receipt on replay. The canonical resolver
reloads the receipt from the stripped gateway request ID, requires its exact request
projection and currently executing canonical tool call, then invokes a mandatory
current authority port. Receipt existence grants no inference or spending authority.
The child Pi admission and its provider/funding selection require a separate
host-owned resolver. The native Pi registry, retained receipt cleanup/export and
full gate/callback proof remain qualification requirements before activation.

`GovernedDelegateChildExecutor` implements the existing `ToolExecutor` contract for
one `delegate-child` operation (Pi-facing name `delegate_child`). Its strict model
input is only `{ objective }`. A server compiler resolves the originating recorded
tool call and stable IDs, timestamps and bounded context for the trusted request;
it supplies neither inherited credentials nor model funding. Lead plans on this
path allow exactly one child. SQLite enforces the sibling cap inside its writer
transaction even when a caller saw stale state. Register this executor only behind
`PolicyControlledToolExecutionService` and the runtime owner's full-request effect
gate. Generic Pi native tools remain disabled. No runtime registry or production
composition is enabled by this increment. Model-driven child qualification and
current audience-authorized Adea publication remain separate composed gates.

The tested persistence profile for this increment is the existing SQLite provider
on a local filesystem. Eleven persistence and fault-injection tests physically close and reopen all
canonical SQLite stores, then recover without callback redelivery. They cover
dispatch attempt commit, dispatch delegation CAS, cascade cancellation commit,
before/after terminal attempt transition, execution transition, outcome CAS and
before/after inbox publication. Inbox concurrent redelivery, payload conflict,
parent isolation, invalid/secret callback fields and late-attempt fencing are tested.
Sixteen child-host cases additionally exercise the actual governed tool service with
scripted runtime starts: denied/pending approval sends nothing, tool replay retains
one session, canonical SQLite reopen preserves exact child identity and source tool
call, retention pins hold, and mismatched attempts/runtime/objective or cancellation
stop new inference. These tests do not run a live child provider or kill an operating-system
process. The reusable `tests/pi-durable-child-host.fixture.mjs` exports the server compiler
recipe without importing tests. It accepts explicit runtime, current authority,
canonical stores and workspace scope inputs; its default runtime and budget ports
are scripted test doubles, not production authority. The candidate first deployment profile is opt-in `remote_host` with Node
24.21.0, Pi Durable 1.1.0 and a persistent local SQLite journal, separately qualified
by the runtime owner. This increment provides no Cloud or PostgreSQL profile evidence.
Runtime/profile qualification, model eligibility/funding, durable human-message dispatch and Adea UI remain
separate implementation work. Restate, LangGraph and managed Pi stay available.

Legacy terminal delegations have no trustworthy publication receipt and are not
automatically republished. They require an explicit evidence-based reconciliation.
Nonterminal progress notifications and manual-intervention publication retain their
existing behavior; this change does not claim they all have an atomic outbox. Dispatch
command identity is durable; the nonterminal notification itself remains best effort.

Rollback retains the additive receipt fields and inbox records. Older strict-schema
readers must not receive records carrying the new field until they are upgraded.
Do not delete inbox records while timeline delivery or effect reconciliation remains
unsettled. Inbox retention/export integration and production composition are required
before enabling this path for a launch cohort.
