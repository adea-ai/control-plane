# M11 ContextProvider cache audit

This is a bounded implementation audit, not completion of #186 or #188.

## Reproduced and corrected

`packages/context/src/provider.ts` passed execution location to the provider but
omitted it from the cache key. A provider eligible in both locations could return
location-specific content: after resolving `cloud`, an otherwise identical
`runtime_node` request incorrectly received the cached cloud contribution.

The regression in `packages/context/src/provider.test.mjs` failed with expected
`runtime_node`, received `cloud`. The resolver now hashes every parsed request
field except `now`, which remains represented by the existing freshness bucket.
The cache namespace is version 3, preventing reuse of old keys. The regression
also proves repeated requests reuse the correct location-specific entries.

Verification on the release 1.14.3 base: 12 provider tests passed; full suite
passed 1,277 tests (1,072 unit, 127 E2E, 78 smoke). Type checks, lint, and formatting
passed. These are synthetic tests, not deployed or native-provider acceptance.

## Remaining requirements, not covered by this correction

The current TDD revision 96 requires request/objective identity and relevant
corpus/memory revisions or authoritative validators to participate in cache
validity. The resolver request schema currently has no objective/query digest,
and its driver interface exposes no cache revision validator. Hashing the parsed
request does not supply those missing inputs. Cortana adapter expected-revision
options validate live retrievals, but cache hits bypass that adapter retrieval.
An adapter-specific configuration identity is also not represented by the
resolver's fixed compiler-version string.

Further work must define and propagate these inputs through the provider
contract, adapter, cache-hit validation, and production execution composition.
The production wiring and end-to-end requirement remain unproven: repository
references to `ContextProviderResolver` inspected in this audit were its
implementation and tests, not a production execution call site. This fix must
not be used as evidence that the complete ContextProvider TDD contract is met.
