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

## Model and harness selection are independent

Model selection and harness selection are separate decisions with no implicit
coupling, and neither ever substitutes for the other:

- A model pin, policy default, or entitlement change never alters the selected
  harness, and a harness pin or default never alters the selected model
  (`packages/policy` `resolveDecisionLayer`, precedence per output).
- A harness pin, at any precedence layer, is a hard candidate filter applied
  before runtime selection: only runtimes whose discovered `harnessIds` contain
  that exact id qualify. If no candidate satisfies the required capabilities and
  exposes the pinned harness, resolution denies with `NO_COMPATIBLE_RUNTIME`. An
  explicitly pinned runtime that does not expose the pinned harness denies with
  `HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME`. Neither case falls back to another
  harness, runtime, or model.
- Harness identity is exact. There is no global alias: `managed-pi` is not
  treated as `pi`. An alias is allowed only where code proves equivalence. No
  such proof exists today, so none is defined.
- Model admission (`packages/model-gateway` `ModelSelectionService`) checks the
  requested target exactly: harness id, harness version, provider binding, and
  location must match the qualification evidence. A mismatch denies with
  `INCOMPATIBLE_HARNESS` or `INCOMPATIBLE_LOCATION`; it never selects another
  target.
- Pending (Pi-owned, not yet changed): `apps/workflow-worker/src/runtime-attempt-router.ts`
  still applies the pin after selection and still contains the `managed-pi` → `pi`
  family alias (`runtimeFamilyAllowed`). Until that router change is approved, the
  production attempt path does not yet meet this policy.

## Known limits

- The decision-layer harness selection is substrate: runtime discovery does
  not yet populate `harnessIds`, so live per-model harness routing waits on
  that wiring (#74 / M12).
- Runtime discovery records one harness version per node. Revisit this model if
  a node hosts several harnesses concurrently.
- Canonical-JSON sites that persist harness-adjacent digests are tracked in
  #612 with per-site versioned migrations.
