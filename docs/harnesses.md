# Harnesses

The Control Plane is harness-agnostic. A _harness_ is the execution
environment an agent runs in, such as Pi, an ACP-speaking CLI such as Codex, or
a future runtime. The platform owns harness selection, placement, and
permissions. Each harness is a pluggable implementation.

## The seams

| seam                 | where                                                       | contract                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter surface      | `packages/runtime-sdk`                                      | implement `RuntimeAdapter` (`inspect`/`start`/`progress`/`cancel`/sessions); the gateway protocol lives in `packages/runtime-gateway-protocol`                                                                                                                 |
| Protocol integration | `packages/acp-adapter`                                      | Any Agent-Client-Protocol-speaking harness connects through a launched executable. This requires no Control Plane code changes.                                                                                                                                |
| Native integration   | `packages/managed-pi-adapter`                               | the Pi implementation of the same adapter surface                                                                                                                                                                                                              |
| Selection            | `packages/policy` decision layer; production router         | `HarnessIdSchema` is a free-form kebab-case id; a runtime exposes up to 16 `harnessIds`; an accepted harness pin is a hard candidate filter (exact id) before ranking; decision-layer resolution is explicit pin → policy default → first exposed, fail-closed |
| Marketplace          | control-api                                                 | `harness` is a free-form profile dimension validated against the requested harness                                                                                                                                                                             |
| Discovery            | `packages/contracts/runtime-discovery`                      | runtime inventory records the harness version; discovery advertises `harnessIds: [family]`; attempt routing selects by capabilities, scope, and an accepted harness id matched exactly                                                                         |
| Certifications       | `docs/runtime-compatibility/runtime-certifications.v1.json` | rows keyed by `runtimeFamily` (today: `managed-pi`, `acp`) with per-harness version pins                                                                                                                                                                       |

Pi integrations are wired in the relevant composition roots. Local constructs
the managed Pi runtime in `apps/local-control-plane/src/managed-pi-runtime.ts`.
Hosted and Cloud have their own managed Pi runtime paths. The adapter and
composition packages keep those implementations behind the runtime contracts.

## Adding or swapping a harness

1. Implement the `RuntimeAdapter` surface in a new adapter package, or ship
   an ACP-speaking executable and reuse `acp-adapter`.
2. Register the runtime family in the certification registry with version
   pins and verified capabilities.
3. Expose the new `harnessId` from runtime discovery (the discovered family
   id). Production routing matches an accepted harness pin against it exactly.
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
- Production routing: `RuntimeDiscoveryAttemptRouter`
  (`apps/workflow-worker/src/runtime-attempt-router.ts`) applies an accepted
  harness pin as a hard filter over the eligible candidates before ranking. The
  cloud composition constructs it in `remote` runtime mode, and the hosted
  control-plane composition constructs it with its `pinnedHarnessId` option.
  Discovery advertises `harnessIds: [family]` (`availableRuntimesFromDiscovery`),
  so a runtime exposes exactly its discovered family id. Pinned attempts bind
  `acceptedHarnessId` into the routing input digest and add the reason code
  `HARNESS_PINNED`; unpinned digests are unchanged. When no eligible candidate
  exposes the pin, the attempt fails closed with `NO_COMPATIBLE_RUNTIME`.
- The managed Pi remote command accepts only discovered family `managed-pi`
  (`MANAGED_PI_DRIVER_FAMILY`, `apps/workflow-worker/src/managed-pi-remote-command.ts`)
  and refuses `pi`.

## Known limits

- The managed Pi remote command receives no accepted-harness id. It enforces
  driver identity by discovered family only; the pin is enforced at routing.
- `resolveDecisionLayer` has no production caller yet. Production harness
  filtering happens in the router above.
- The managed Pi certification rows are keyed `runtimeFamily: managed-pi`
  (`docs/runtime-compatibility/runtime-certifications.v1.json`). They were keyed
  `pi`, which named the durable Pi family; their evidence cites only
  `packages/managed-pi-adapter`, so the key was corrected and the evidence and
  dates were kept. No certification row covers the durable `pi` family.
- Production does not consult the certification registry. No production code
  calls `applyRuntimeCompatibilityCertification` or `assessRuntimeCompatibility`.
  Inventory ingestion records `compatibilityState: 'untested'`, but the health
  ingest that follows recomputes it from the health report
  (`packages/runtime-sdk/src/health.ts`, `compatibilityState`): a healthy driver
  with a verified capability snapshot becomes `compatible` with no certification
  row check. Production routing of managed Pi therefore does not depend on a
  certification row. The hosted managed Pi worker
  (`apps/runtime-worker/src/hosted-managed-pi-worker.ts`) sets `compatible`
  directly for a host that is neither unavailable nor degraded. Whether certification should gate
  production compatibility is a root decision. The cloud remote drill's discovery
  fixture sets compatibility to `compatible` directly and does not exercise the
  reader.
- Runtime discovery records one harness version per node. Revisit this model if
  a node hosts several harnesses concurrently.
- Canonical-JSON sites that persist harness-adjacent digests are tracked in
  #612 with per-site versioned migrations.
