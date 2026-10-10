# Selected model candidate bridge

`apps/control-api/src/models/selected-model-host-bridge.fixture.mjs` exports
`createSelectedModelHostBridge({ selections, target })` for a separate opt-in test
host. `selections` must be the same actual server model-selection service used by
the metadata API. The target pins location, harness, harness version and provider
binding. There is no environment or fixed-selection fallback.

`bindIntent({ workspaceId, intentId, selectionRef, selectionRevision })` accepts
only references, resolves the stored immutable selection and checks readiness.
It returns the accepted safe snapshot. Concurrent registrations for the same
workspace/intent have one winner; changing that intent's selection fails closed.
`resolveIntent` rereads the same reference and checks the complete snapshot.
`forIntent` exposes `resolveSelection`, `assertReady`, and `withCredential` for
that winner. Credential use remains within the upstream service's callback;
readiness is checked again inside that callback.

The new R1 candidate host must use this accepted snapshot for the plan, price,
recorded payer evidence, preparation and reader bindings. It supplies the intent
selection port to the canonical model host, then uses the **same canonical
execution-bound facade** for both native provider and spending resolution. This
bridge does not create payer authority, validate a product actor, authorize an
execution, or replace recorded spending authority. Original product actor,
transport and lease principals remain distinct.

Retention here is process-local and test-only. It does not qualify restart
recovery of intent selections; that requires the canonical persisted intent
store. Existing frozen candidate fixtures remain unchanged.

Focused tests exercise the actual configured metadata resolve operation, actual
model-selection service and repository, plus explicit mocked readiness/vault
ports. They cover non-fixed selections, reference/target mismatch, snapshot
injection, connection revocation, concurrent winners and readiness denial inside
the credential callback. No live provider, real credential or payer is involved.
The actual selected-model PG/UI/prepared inference journey remains unqualified
until the separate R1 host consumes the bridge and Task12 runs its connected
proof.
