# Harnesses

The control plane is harness-agnostic. A _harness_ is the execution
environment an agent actually runs in (Pi today; an ACP-speaking CLI like
Codex; any future runtime). The platform owns logistics — which harness to
select, where it runs, what it may do — and treats any specific harness as a
pluggable implementation.

## The seams

| seam                 | where                                                       | contract                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter surface      | `packages/runtime-sdk`                                      | implement `RuntimeAdapter` (`inspect`/`start`/`progress`/`cancel`/sessions); the gateway protocol lives in `packages/runtime-gateway-protocol`                    |
| Protocol integration | `packages/acp-adapter`                                      | any Agent-Client-Protocol-speaking harness plugs in through a launched executable — no control-plane code changes                                                 |
| Native integration   | `packages/managed-pi-adapter`                               | the Pi implementation of the same adapter surface                                                                                                                 |
| Selection            | `packages/policy` decision layer                            | `HarnessIdSchema` is a free-form kebab-case id; a runtime exposes up to 16 `harnessIds`; resolution is explicit pin → policy default → first exposed, fail-closed |
| Marketplace          | control-api                                                 | `harness` is a free-form profile dimension validated against the requested harness                                                                                |
| Discovery            | `packages/contracts/runtime-discovery`                      | runtime inventory records the harness version; attempt routing selects by capabilities and scope, never by harness identity                                       |
| Certifications       | `docs/runtime-compatibility/runtime-certifications.v1.json` | rows keyed by `runtimeFamily` (today: `pi`, `acp`) with per-harness version pins                                                                                  |

Pi appears in exactly two places by design: the adapter package that
implements the Pi integration, and the composition roots that construct it
as the current default (`apps/local-control-plane/src/managed-pi-runtime.ts`,
the runtime-worker hosted composition).

## Adding or swapping a harness

1. Implement the `RuntimeAdapter` surface in a new adapter package, or ship
   an ACP-speaking executable and reuse `acp-adapter`.
2. Register the runtime family in the certification registry with version
   pins and verified capabilities.
3. Expose the new `harnessId` from runtime discovery; the decision layer
   resolves it like any other (pin it per model/task, or set it as the
   policy default).
4. Point the relevant composition root at the new adapter.

## Known limits

- The decision-layer harness selection is substrate: runtime discovery does
  not yet populate `harnessIds`, so live per-model harness routing waits on
  that wiring (#74 / M12).
- Runtime discovery records a single harness version per node — revisit if a
  node ever hosts several harnesses concurrently.
- Canonical-JSON sites that persist harness-adjacent digests are tracked in
  #612 with per-site versioned migrations.
