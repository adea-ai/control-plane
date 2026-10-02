# Harnesses

The Control Plane is harness-agnostic. A _harness_ is the execution
environment an agent runs in, such as Pi, an ACP-speaking CLI such as Codex, or
a future runtime. The platform owns harness selection, placement, and
permissions. Each harness is a pluggable implementation.

## The seams

| seam                 | where                                                       | contract                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter surface      | `packages/runtime-sdk`                                      | implement `RuntimeAdapter` (`inspect`/`start`/`progress`/`cancel`/sessions); the gateway protocol lives in `packages/runtime-gateway-protocol`                    |
| Protocol integration | `packages/acp-adapter`                                      | Any Agent-Client-Protocol-speaking harness connects through a launched executable. This requires no Control Plane code changes.                                   |
| Native integration   | `packages/managed-pi-adapter`                               | the Pi implementation of the same adapter surface                                                                                                                 |
| Selection            | `packages/policy` decision layer                            | `HarnessIdSchema` is a free-form kebab-case id; a runtime exposes up to 16 `harnessIds`; resolution is explicit pin → policy default → first exposed, fail-closed |
| Marketplace          | control-api                                                 | `harness` is a free-form profile dimension validated against the requested harness                                                                                |
| Discovery            | `packages/contracts/runtime-discovery`                      | runtime inventory records the harness version; attempt routing selects by capabilities and scope, never by harness identity                                       |
| Certifications       | `docs/runtime-compatibility/runtime-certifications.v1.json` | rows keyed by `runtimeFamily` (today: `pi`, `acp`) with per-harness version pins                                                                                  |

Pi integrations are wired in the relevant composition roots. Local constructs
the managed Pi runtime in `apps/local-control-plane/src/managed-pi-runtime.ts`.
Hosted and Cloud have their own managed Pi runtime paths. The adapter and
composition packages keep those implementations behind the runtime contracts.

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
- Runtime discovery records one harness version per node. Revisit this model if
  a node hosts several harnesses concurrently.
- Canonical-JSON sites that persist harness-adjacent digests are tracked in
  #612 with per-site versioned migrations.
