# Managed model gateway

`@control-plane/model-gateway` is the server-only boundary for managed model calls. An
ExecutionPlan and runtime request identify a logical alias and required capabilities; they never
select an arbitrary provider endpoint, SDK type, model credential, or raw provider configuration.

`ManagedModelGateway` validates bounded messages/settings, resolves an approved alias deployment,
enforces the plan's provider class, denied-provider, residency, and capability constraints, then
requires a `model:invoke` PDP decision before calling an adapter. Provider adapters implement a
replaceable completion/streaming/health/cancellation port. `LiteLlmAdapter` is the initial adapter;
LiteLLM field names and its server-side credential reference do not enter domain or runtime
contracts.

Completion and stream results normalize input, output, cache, reasoning, and total token counts,
finish reasons, latency, trace correlation, provider/model/request metadata, policy snapshot, and
funding source. `hq_managed` calls therefore remain distinguishable from
`external_subscription` harness usage in the authoritative Control Plane ledger.

Routing is deterministic and auditable. The registry filters disabled or unhealthy deployments,
then applies capability, plan, entitlement, residency, context/output, and cost constraints before
the PDP evaluates any candidate. Eligible routes are ranked by configured priority, cost class, and
deployment identifier. Results record the selected deployment, router version, ordered eligible
candidate identifiers, and any fallback origin without exposing credentials. Fallback occurs only
after a retryable provider failure and only to another candidate that already passed every policy
and budget constraint; equivalent inputs and registry state therefore produce the same route.

Unknown aliases, incompatible plan constraints, policy denial/evaluator failure, missing adapters,
timeouts, provider errors, and stream failures fail closed with bounded codes. Raw prompts,
credentials, provider response bodies, and exception messages are not copied into normalized errors.
The deterministic fake adapter exercises the same provider-neutral contract in CI.

## Ledger-backed HTTP transport

`LedgerLiteLlmHttpClient` implements the initial LiteLLM port with one HTTP request
per model-call identity. The trusted server authority must resolve an exact proxy
deployment, lease its credential, provide a pinned price snapshot, and authenticate
a recorded spending authorization covering the workspace, execution, attempt,
principal, alias, policy digest, credential and funding class. A plan allowance
or a caller-supplied `hq_managed` field does not establish that authorization.
The complete immutable attempt allocation must fit the recorded spending ceiling;
checking just the next request would allow cumulative overspending.

The client prices the configured full input context and bounded output ceiling,
commits a durable hold before `fetch`, rechecks current authorization immediately
before sending, refuses redirects and disables LiteLLM's
[request retries](https://docs.litellm.ai/docs/routing) and
[fallbacks](https://docs.litellm.ai/docs/proxy/reliability). The configured proxy
must enforce an exact deployment and these controls; injected-fetch tests do not
certify a real proxy deployment. Known pre-fetch denials settle at zero without
sending. Network failures, non-success responses, malformed or absent usage,
truncated streams, and unacknowledged accounting writes retain unresolved holds
and forbid blind replay. Route changes cannot replace a previously admitted call
with a second send. Definitive nonbillable upstream error/fallback reconciliation
requires separate evidence; an HTTP status alone does not establish zero cost.

Validated input/output counts settle once from the pinned price. Cache and
reasoning counts are subsets; neither is billed twice. External subscription
usage requires its own trusted authorization and zero HQ monetary price, while
remaining distinguishable from exact HQ-managed charges. Stream settlement waits
for the final usage frame and completed protocol; a finish marker alone cannot
release a hold. The native broker derives its model-call identity from the trusted
attempt scope and normalized request. Identical requests are retries and are
refused after their first dispatch, including when a settled response is lost.
Distinct conversation or compaction requests get distinct identities. The broker supplies the trusted
scope independently of request metadata.

A serial native attempt refuses concurrent requests and further requests after
an uncertain completion or stream failure. SDK retries cannot create another
billable send under a fresh identity while the previous outcome remains unknown.
The same deterministic identity reaches the durable dispatch fence after broker
recreation. Repeated requests return an error rather than replaying cached output.
Cold connection preparation also rejects persisted unresolved holds. Successful
successive calls and compaction requests retain separate identities and charges.

The Local managed Pi composition now connects this transport to native execution.
It shares the workflow's SQLite usage store and server SecretsProvider, and
requires an operator-owned private spending record at
`secrets/model-authorizations/<workspaceId>/<executionId>/<attemptId>.json`
under the Local data directory. `LocalModelSpendingRecordSchema` defines the
strict envelope: pinned plan ID/digest, scoped recorded grant, price snapshot,
exact proxy endpoint/deployment, credential reference, cost class and entitlements.
The file records an independently approved spending decision with an evidence
reference; accepting an execution or reserving a plan budget does not create it.
Missing, unsafe, expired, mismatched or changed records deny execution/sends.
Every physical send re-reads the record, so removal or replacement revokes the
connection. Keep approval records as operational evidence; they contain secret
references, never credential values, and must not be committed to the repository.

Pi receives a private per-attempt HOME and agent/session directories. The only
native authentication value is a random broker capability; provider credentials
are leased only inside the server HTTP adapter. The native provider is
`control-plane` and its model is the plan's logical alias. Each incoming native
request gets its own durable hold. Terminal processing reaps the child, revokes
the broker, closes its loopback listener and removes private configuration before
publishing the durable terminal receipt. Uncertain provider usage remains held;
aggregate Pi session statistics are audit observations, never exact charges.
Local composition shutdown closes active clients, waits for owned preparation,
reaps children and closes their connections before shutting down SecretsProvider
and persistence.

Cloud/Hosted-server authority storage and runtime composition, egress isolation,
pinned LiteLLM compatibility, and executed real-binary Docker qualification remain
required before claiming full M11 activation. The real-binary Docker lane now
checks Local per-request charges and unresolved cancellation holds using a
synthetic operator record and model endpoint; it does not certify provider billing.
