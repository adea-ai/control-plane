# @control-plane/pi-cloudflare-host

Internal Cloudflare boundary for pinned Pi Durable, Pi AI, and Chord **1.1.0**.
It owns a SQLite-backed Durable Object's runtime journal and opens Pi's actual
`@earendil-works/pi-durable/storage/sqlite/cloudflare` storage driver. It does
not import the Node adapter, process leases, Node SQLite, or canonical transcript
and job repositories.

This increment has no production Worker route, runtime registration, deployment
profile, or advertised capability. A production adapter must implement the public
`RuntimeAdapter` contract and supply current canonical authority and spending
composition before activation. Refs [#930](https://github.com/adea-ai/control-plane/issues/930)
and [#187](https://github.com/adea-ai/control-plane/issues/187); neither issue is closed.

## Ownership and admission

One Durable Object maps to one server-resolved workspace/conversation/Agent
binding. Its exact versioned owner pins contain the runtime, adapter, configuration
digest, and binding. Another binding or unsupported version fails before opening
Pi. The same host serializes wakes, and every constructor increments the persisted
owner epoch to fence old asynchronous continuations.

The host accepts the public SDK `RuntimeStartRequestSchema`, including an exact
plan ID/digest/version and required attempt budget. `CloudflareCurrentAuthority`
is a **server-only port**, never an HTTP claim:

- `readAccepted(request)` returns the canonical accepted task with its recorded
  original `canonicalActorPrincipalId` and exact immutable request.
- `assertCurrent(task, owner, boundary)` rereads the canonical workspace and
  conversation/Agent binding, original actor, separate admitting service,
  current audience, grants, expiry, scope, and exact admitted plan/budget pins.
  It rejects revoked, expired, cross-workspace, or changed authority.

These checks run at admission, wake, status/progress reads, cancellation, and
before effects. Capability declarations, prompt content, transport identity,
and persisted history cannot mint authority. An engine supplied by trusted host
composition must use the callback before every physical effect and keep existing
native model broker, per-send spending, credential, and usage authorities in
force. The host's budget snapshot is not spending or credential authorization.
The qualification engine installs no model provider and makes no paid calls.

## Runtime storage and wake behavior

| Storage                                              | Owner and purpose                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `cp_pi_owner`                                        | Exact configuration/binding pins and fencing epoch                                     |
| `cp_pi_tasks`                                        | Accepted request, unique attempt/replay keys, runtime state and retained outcome/usage |
| `cp_pi_events`                                       | Retained ordered runtime progress cursor                                               |
| `cp_pi_wake`                                         | Durable wake intent until accepted work is processed                                   |
| Pi's `durable_schema`, conversations/tasks/documents | Pi runtime context, exclusively through its pinned Cloudflare driver                   |
| Canonical transcript/jobs/command records            | Existing Control Plane/product services; not owned by this package                     |

An admission atomically persists task, initial event, and wake intent through
`transactionSync`. `setAlarm` is asynchronous and is deliberately separate.
Admission acknowledges only after the alarm is armed. A crash before that
acknowledgement requires the Control Plane caller to retry its immutable start
key; constructor reentry repairs the persisted wake intent before handling events.
This is a replay/reentry recovery contract, not a claim that an unarmed alarm can
wake an otherwise unreachable object by itself.

Alarms process accepted work in ordered pages, continue after individual authority
failures, and rearm remaining work with a 30-second delay. Terminal work consumes
its wake intent. A send interrupted while running becomes
`reconciliation_required`, and automatic wake never retries that ambiguous send.
Only accepted work can cancel immediately. Cancellation after possible effects
retains `cancelling` and any returned result/usage until trusted broker
reconciliation establishes settlement. The optional server-only reconciliation reader below settles recorded outcomes without dispatching a retry; no public payload can provide a settlement receipt.

## Versions and recovery

Owner schema 1 requires runtime 1.1.0 and adapter 0.1.0. Plans 1 and 2 are
supported; all other versions fail closed. Replaying compares JSON identities
without adding fields to or rehashing historical canonical plans.

Compatible code revisions keep exact owner/configuration pins. A different
runtime, adapter, configuration, conversation, or Agent needs an explicit reviewed
migration; silently accepting those changes is unsupported. Pi's own driver also
rejects a future SQLite schema. Qualification tests exercise an explicit durable
task migration from definition 1 to 2, preserving its input and conversation ID.
No native child-process checkpointing, production deployment, provider parity,
or complete Cloudflare runtime-adapter qualification is claimed.

## Validation

Run from this package:

```sh
bun run build
bun run lint
bun run test
bun run test:emulator
```

The default tests use Bun SQLite structural fixtures. They exercise the actual
Pi Cloudflare driver and actual Pi Harness but do not establish Workers
hibernation. The emulator command is opt-in and starts one local workerd at a
time through pinned, test-only Miniflare 5.20260926.0-alpha / workerd 1.20260926.1.
It denies outbound traffic and cleans up its own instance and temporary storage.
The alpha API is required for its explicit Durable Object hibernating eviction
control; it is not a production dependency.

The pinned Miniflare release requires vulnerable `sharp` and `undici` versions.
Repository overrides select the published versions `sharp` **0.35.5** and
`undici` **8.11.2**, preserving Miniflare/workerd and Pi/Chord pins. This addresses
[sharp's upstream librsvg advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
and undici's [WebSocket handshake](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5)
and [BalancedPool TLS-options](https://github.com/advisories/GHSA-w293-vg96-wgc3)
advisories. The latest inspected Miniflare alpha still pinned vulnerable sharp,
so upgrading Miniflare alone could not clear the audit. Native image compatibility,
custom connector rejection, and actual workerd qualification must pass after this
constrained override; auditing remains enabled for all dependencies, including
existing LangGraph/LangSmith paths that use undici.

`tests/worker.mjs` is a local-only qualification entry. It supplies deterministic
server fixtures and never registers a production route. Its intended checks are
actual SQLite/Pi storage on workerd, WebSocket attachments across hibernation,
constructor/epoch reentry, fresh-process restart, supported task/code upgrade,
future-runtime rejection without changing retained outcomes, and isolated runtime
contexts. A skipped emulator test is unverified. See the PR's exact-head evidence
for actual results; fixture success cannot substitute for that evidence.

## Interrupted effect settlement

`CloudflarePiHost.reconcile(attemptId)` (also exposed by the owning Durable Object)
checks current authority on reads and at the new `reconcile` boundary, both before
and after the trusted ledger read. It never opens an engine or dispatches a send.
An absent reader fails with `CLOUDFLARE_RECONCILIATION_UNAVAILABLE`; an undefined
receipt retains the unresolved state. Revocation or owner replacement while the
reader awaits prevents any settlement commit.

`CloudflareReconciliationAuthority.readSettlement(task, owner, recoveryEpoch)` is
injected by server composition, not exposed as an HTTP argument. Its implementation
must reread the existing broker/dispatch/usage ledger and establish settlement of
all prior effects for this exact attempt. It cannot authorize spending, retry a
request, infer authority from persisted history, or convert an unknown ACK into
permission to resend. The deterministic qualification reader substitutes only a
local controlled effect recorder, not a provider or production broker.

A version-1 receipt binds the complete canonical accepted task (original actor,
plan and attempt budget), exact owner/configuration/binding pins, current recovery
epoch and bounded receipt reference. A completed disposition requires a validated
runtime result; a cancelled disposition requires validated terminal usage and no
result. Already observed results/usage cannot be replaced or erased. Future receipt
versions, extra authority fields, changed identities and cross-owner receipt reuse
fail closed. `cp_pi_settlements` atomically retains one immutable receipt per attempt
and unique receipt reference with its final state/event. Repeated reconciliation
and start replay preserve that outcome and progress cursor across owner reentry.
No interrupted task transitions back to `running` through reconciliation.

The opt-in abrupt fixture records a single local effect outside workerd, holds its
ACK inside an actual native Pi task phase before its terminal commit, and sends SIGKILL only to the uniquely verified direct workerd child of its
own test runner. It then reopens the same persisted SQLite context, verifies no
engine close ran before interruption, requires reconciliation, and counts physical
fixture invocations without receiver-side deduplication. Pending settlement cannot
resend; trusted settlement retains the host result once while leaving the exact native running-phase checkpoint quarantined. This does not prove native task resumption or settlement; production engine composition must bind each native task to its original attempt and reconcile its interrupted checkpoint before future activation. This proof covers interruption and quarantine, not native task resumption; the earlier graceful restart test cannot substitute for it.

## Remaining full adapter integration

| Seam                            | Current boundary and remaining work                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public `RuntimeAdapter`         | Internal host methods only; no registered remote transport or full adapter facade.                                                               |
| Start/status/progress           | Accepted-task and ordered journal seams exist; stable public handles, timestamps/cursors and transport binding still need composition.           |
| Input/approval                  | Native interaction/effect approval identity and replay storage are not yet wired to this host.                                                   |
| Cancel/reconcile                | Internal cancellation and trusted recorded settlement exist; public status/terminal usage mapping and real broker reader still need composition. |
| Session/cleanup                 | Context isolation exists; authorized public session operations, retention and cleanup gates are not yet implemented.                             |
| Capabilities/driver             | Actual pinned Cloudflare SQLite driver is used; no capability or deployment profile advertised before full qualification.                        |
| Physical provider/child effects | Existing per-send broker, credential/usage and policy approval ports remain required; no paid provider or native child checkpoint proof here.    |

This independently testable slice advances #930 restart/recovery evidence and
retained settlement. Full adapter acceptance, live activation and the external
ACP/evidence/inventory/read-only/Adea lanes remain separate. No issue closure.

## Partial public adapter composition

`CloudflarePiDurableOwner.runtimeAdapter()` explicitly returns an in-process
`RuntimeAdapter` facade over this owner. It schedules `start` through retained
alarm intent, maps accepted work to `starting` and interrupted work to `unknown`,
and implements current-authorized status, cancellation, reconciliation and a
finite snapshot of retained progress events. Progress reconnects use the exact
persisted sequence and timestamp; no polling or automatic native resume occurs.

First admission atomically persists a random opaque handle and original admission
timestamp. Full supplied handle tuples are compared with retained identity at
every operation; no session ID is fabricated. Additive nullable SQLite columns
preserve historical task JSON/digests/replay keys. Historical rows without handle
or event timing fail unavailable rather than receive invented replay timestamps.
Cancellation keys retain their exact request; changed retry bodies conflict.

This partial adapter advertises **no capabilities**, rejects unsupported required
plan capabilities before admission, and reports degraded inspection. Input,
approval, session mutation/history and cleanup operations throw explicit
non-retryable unsupported errors. Session load/list also default to unsupported;
they require an explicitly injected canonical session authority port. There is no Worker transport, profile registration, production authority
composition, live activation or native checkpoint resumption. Production current
actor/audience/grant and physical-send spending/credential authority remain
mandatory independent ports; a local scripted engine does not qualify them.

Acceptance map for #930: pinned native driver/versioned owner, exact accepted
runtime/configuration pins, isolated context, hibernation/restart/upgrade and
interrupted-no-resend evidence are merged in #964/#971. This facade closes the
local public start/status/progress/cancel/reconcile composition seam. Full
RuntimeAdapter interaction/session mutation/history/cleanup, production provider authority and
safe native checkpoint continuation remain open; no full acceptance is claimed.

### Canonical read-only session composition

An optional server-only `sessionAuthority` enables binding an existing canonical
session ID to an existing Pi conversation and exact accepted attempt. Binding is
immutable and idempotent: changed session/native/attempt mappings conflict, and
owner replacement fences stale writers. Public operations cannot register aliases.
The authority port must verify the active canonical mapping, original actor,
separate caller, current audience/grants/expiry and exact plan/budget pins. Both
execution and session authority are rechecked after every native-storage await,
including close; SQLite columns and serialized bindings must agree.

`session({operation:'load', sessionId})` and `session({operation:'list'})` read
only Pi 1.1.0 `Storage.conversation` records and return canonical metadata.
Lists fail closed above 64 bound sessions; revoked authority is checked even for
an empty list or unknown alias. They never construct Harness, enable scheduling,
change checkpoints, or release unknown-send quarantine. This source slice adds
no advertised capability, production transport or activation.

Pinned vendor evidence: `harness/types.d.ts` exposes `Conversation.submit` and
`Harness.resume` as scheduling operations; `types.d.ts` exposes the read-only
`Storage.conversation` lookup. Pi 1.1.0 provides no public canonical approval or
exact interaction-scoped resume operation. Input, approval, create, resume,
close and history therefore remain explicitly unsupported. A production
canonical session authority implementation and native continuation proof remain
required before broader acceptance.

## Native task compatibility preflight

Trusted `CloudflarePiDurableOwner` composition must supply `nativeTaskCatalog`
with schema version 1, the exact admitted owner configuration digest, an actual
Pi registry snapshot, and explicit `{kind, fromVersion, toVersion}` migration
pairs. Task names, versions, phase/migration functions and migration permissions
are captured before awaits. `openEngine(storage, pinnedRegistry)` must use the
supplied registry reader; later registry publications cannot select new task code.
Missing catalog composition fails non-retryable unsupported before engine opening.

Before opening Harness, the host scans actual native task storage with current
accepted-task authority and owner-epoch checks before and after every scan await.
Live pending/running/waiting records need an installed exact definition or an
explicitly permitted older version with the captured migration function. Missing,
newer or unapproved versions fail with typed unsupported reasons. Preflight never
invokes migration/task code, writes input/checkpoints, or schedules/resends work.
Completing and terminal records retain their receipt independently of removed
live definitions; ordinary retained completion reads do not open an engine.

Scans use 64 records per page with a **1,024-record availability limit**, including
retained terminal records. More records fail `CLOUDFLARE_TASK_SCAN_LIMIT`; no page
is silently truncated. Repeated/empty continuation cursors fail
`CLOUDFLARE_TASK_SCAN_INVALID`. A deployment needing a larger context requires a
reviewed capacity change; this adds no destructive retention cleanup. A refused
wake retains the host's conservative reconciliation state and does not infer a
no-send settlement or release unknown-send quarantine.

Pi 1.1.0 already blocks `missing_task`, `task_too_old`, and `migration_failed` in
its scheduler. This increment adds bounded host-visible refusal before opening
that scheduler, rather than claiming Pi previously reran arbitrary latest code.
The actual registry remains an operator-owned implementation contract, not scope
or spending authority. No capability, production Worker route or activation is
added.

For #930, merged #964 supplies pinned storage/owner/context/restart/upgrade
foundation, #971 interruption reconciliation, #977 the public lifecycle facade,
and #985 authorized read-only sessions. This preflight strengthens the unknown
native-definition wake boundary. Native child checkpointing is explicitly outside
#930's claim; no extra checkpoint requirement is introduced. Full issue acceptance
still requires the coordinator's criterion-by-criterion integrated evidence review.
