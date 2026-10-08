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
reconciliation establishes settlement. This increment exposes no privileged
reconciliation shortcut.

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
Repository overrides select the published patch versions `sharp` **0.35.5** and
`undici` **7.29.1**, preserving Miniflare/workerd and Pi/Chord pins. This addresses
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
