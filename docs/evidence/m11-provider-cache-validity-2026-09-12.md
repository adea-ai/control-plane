# M11 provider cache validity

## Reproduced failure

Two Cortana-compatible adapters with the same public provider/connection model
but different expected corpus revisions shared a contribution cache. After the
first adapter populated the cache, the second returned the old corpus without
calling its client or checking its new revision requirement. A rebuilt-workspace
regression failed with zero client calls where one was required (7 pass, 1 fail).

## Cache contract

`ContextProviderDriver.cacheIdentity(request)` optionally returns a SHA-256 digest
of the authoritative pinned revisions and adapter configuration that its retrieval
validates. The resolver includes that identity alongside the provider definition,
connection, full parsed request, freshness bucket, and resolver version 4. Drivers
without an identity retrieve fresh data and never read or populate this cache.
The identity and key are rechecked after asynchronous cache lookup and before
cache population. If either changes during retrieval, the response is not cached.

The identity is a trusted driver responsibility, not a client-supplied scope or an
automatic proof of the upstream service's current revision. A driver using mutable
latest-data semantics must establish an authoritative identity per request or leave
cache reuse disabled. Time-based freshness alone is insufficient.

The Cortana adapter opts in only when its endpoint/credential-policy binding has
an explicit non-secret `clientIdentity`, and corpus, embedding, retrieval, and
(when memory is requested) memory revisions are pinned. Its identity also binds
the provider reference, mapped project, transport, output limit, retry policy,
circuit threshold, and adapter implementation version. Retrieval already validates
those revision pins before the resolver can cache a result. An open circuit does
not opt into cached retrieval.

Changing the endpoint or credential-policy binding requires changing
`clientIdentity`; never put a credential in this field. Unconfigured identities
disable reuse without disabling retrieval. This change does not discover an
endpoint, authenticate a production provider, or certify the RuntimeNode helper.

## Focused evidence

The initial green run passed 26 tests with 88 assertions. Regressions cover corpus
revision changes, unchanged-pin reuse, mapped-project/transport/client/output-limit
separation, missing identity/pins, identity changes during retrieval, and generic
driver opt-out. Existing scope, policy, objective, location, authorization,
freshness, and contribution integrity tests remain in the same test lanes.

A follow-up regression reproduced identity changes during an asynchronous cache
lookup (16 pass, 1 fail before the recheck). This must trigger fresh retrieval,
not return the previous revision's cached response.

These are deterministic provider-fixture tests. Live provider authority selection,
production profile certification, and the remaining M11 requirements remain open.
