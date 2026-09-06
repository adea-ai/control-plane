# Cortana-compatible context adapter

`@control-plane/cortana-context-adapter` is the preferred first-party profile for the optional
context-provider framework. It consumes the checked-in public `ContextBundle` v1 contract through a
client port; it does not import Cortana code, read Cortana storage, or handle source credentials.

The same adapter supports versioned HTTP, MCP, and a generic RuntimeNode transport. RuntimeNode reads
use a `context_provider` / `context.read` Runtime Gateway command and never create a
`RuntimeConnection`. Cloud deployments therefore do not assume that a user's loopback service is
reachable.

Every request pins the mapped project reference, least-privilege principal reference, exact scope
digest, contract and retrieval revisions, token budget, deadline, and evidence/memory inclusion.
Every response validates the bundle and slice digests, revisions, freshness, token and byte bounds,
degradation, and omission metrics. External evidence retains citations; native memory is marked as
provider memory and cannot satisfy an external-evidence citation requirement.

Reads are idempotent and may use a bounded retry. Timeouts are cancelled, repeated failures open a
circuit, and telemetry contains only normalized error codes and transport names. The standalone fake
server, golden bundle, malformed cases, and generic provider conformance suite run without Cortana or
Adea.
