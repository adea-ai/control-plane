# Optional context providers

The Control Plane can enrich an execution with bounded external context while remaining fully
functional with no provider configured. Providers are optional integrations behind the public
`ContextProviderDriver` port. The core never reads a provider database, accepts provider-native
credentials, or treats retrieval as a ProjectState or durable-memory mutation.

## Policy and selection

Each request pins `disabled`, `preferred`, or `required` mode and an explicit failure behavior:
`continue_without`, `fail`, or `await_input`. Eligible connections must match the caller workspace,
principal, scope digest, execution location, requested capability, provider preference, health, and
budget. Selection and substitution are deterministic. A returned contribution must repeat the exact
provider, connection, contract version, and scope pins; mismatches are rejected rather than widened.

Evidence and memory inclusion are separate policy choices. Contributions are bounded by token,
freshness, latency, and output limits. Retrieval produces a sorted `ContextContribution` collection
with provenance and citations. It cannot overwrite ProjectState or make provider memory canonical.

Execution records should retain only the provider pin: provider and connection identifiers, public
contract version, scope/content digests, revision, freshness, degradation/omission state, and bounded
provenance. Raw contribution content and reusable credentials do not belong in the pin.

## Testing and adapters

`@control-plane/context` supplies no-provider behavior, evidence and memory fake profiles, malformed
and degraded fixtures, and a reusable conformance check. These tests require no Cortana, Adea,
local corpus, or production credentials. A vendor adapter must implement the same port and pass the
same scope, determinism, and bound checks before integration testing.
