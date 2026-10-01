# Execution constraints

AgentProfile versions carry a provider-neutral `ExecutionConstraintSet`. The same immutable value is the input to ExecutionPlan compilation. Stable domain code does not import MCP, LiteLLM, Cedar, Railway, Neon, R2, AWS, database drivers, workflow-runtime SDKs, or connector SDKs; gateways and adapters resolve concrete implementations later.

## Tool authority

Tool access is always deny-by-default. A grant identifies a logical tool and version range, the exact operations and capabilities requested, a risk class, and an approval mode. A grant for `read` never implies `write`, and an unknown tool or operation is denied. Concrete protocol names, endpoints, credentials, and deployment providers are not part of the contract.

Risk classes progress from `safe` and `read` through `write`, `destructive`, and `privileged`. Approval modes are explicit and policy-owned.

## Model and policy requirements

Model requests use logical aliases/capability requirements, permitted/denied provider classes, data policy, and bounded fallback policy. User-authored constraints cannot create arbitrary provider authority.

`PolicySnapshotReference` pins the policy identity/version/digest used to compile or authorize an execution. Authorization input remains evaluator-neutral; Cedar is an adapter implementation rather than a domain dependency.

## Limits and interaction

Every constraint set specifies bounded cost/tokens/duration/concurrency/delegation and sandbox/resource limits as applicable. Interaction policy separately controls approvals, user input, destructive operations, and expiry.

Operational transport/retry/heartbeat/retention defaults are infrastructure/reliability policy owned by M9.13, not caller-chosen execution authority.

## Composition

Constraint composition only narrows authority:

- context classifications, tool operations, model/provider classes, data residency, runtime families and runtime locations are intersected;
- required capabilities and denied providers are combined;
- numeric limits use the strictest compatible ceiling;
- risk and approval requirements become stricter;
- pinned policy snapshots must remain compatible;
- deployment profile cannot broaden permissions merely because components are co-located or user-controlled.

An empty required intersection or incompatible immutable constraint fails deterministically. Composition never silently chooses a provider, runtime location, deployment profile, secret source, or broader capability.

## Deployment portability

M9 freezes these deployment-independent semantics against the Railway managed-cloud reference. M10 changes persistence, workflow composition, object storage, secrets, process supervision and RuntimeTransport adapters for Local/Hosted profiles without changing constraint meaning.

Location-specific capabilities may affect runtime eligibility. For example, local project access
may be available only at a particular location. Record the reason explicitly; do not infer it from
the infrastructure provider.
