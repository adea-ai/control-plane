# Selected model composed candidate host

The new, opt-in `apps/control-api/src/pi-durable/selected-model-candidate.fixture.mjs`
exports `startSelectedModelCandidateHost` and a standalone Bun launcher. It uses
the canonical published Node runtime APIs from #949. The existing fixed-selection
candidate fixture is unchanged. This host is never imported by production startup.

Metadata and lead routes run in the same authenticated Nest application. The
metadata controller uses the actual configured model service and durable SQLite
model-selection store. Defaults and selection resolution therefore return actual
stored references rather than the former fixture's fixed selection. Registration
accepts those references and a trusted product evidence projection; it resolves
the selection from the same store. There is no caller selection snapshot or
provider/account fallback.

The selected snapshot supplies price, recorded funding bindings, readiness and
preparation readers. The plan retains its canonical logical model requirement
with fallback disabled; immutable selection references and full funding evidence
bind that plan's exact execution/attempt. Native provider and recorded spending
both receive the same cached canonical `forExecution` facade. Provider registries
are created, used and cleared inside the credential callback. Original product
actor is a required `user:<UUID>` separate from transport, admission and lease
principals. Actor/product registration is serialized per intent; rejected input
does not commit a selection winner.

## Launcher and current product reader

Run pinned Bun from this checkout with:

```sh
PI_CANDIDATE_WORKSPACE_ID=<canonical-workspace-id> \
PI_CANDIDATE_WORKSPACE_SCOPE=true \
PI_CANDIDATE_PREPARE_FUNDING=true \
bun apps/control-api/src/pi-durable/selected-model-candidate.fixture.mjs
```

One JSON line exposes loopback URL, synthetic test credential/principal, workspace,
profile pins, expiry, credential reference, eligible target and source identity.
There is no fixed selection reference at startup: the client obtains it from the
actual metadata API before registering an intent. Authenticated test controls
remain `/__candidate/intents`, `/__candidate/evidence`, and `/__candidate/close`.
Evidence exposes the safe selected snapshot and recorded payer ground truth.

An optional trusted current-product fixture reader requires both
`PI_SELECTED_PRODUCT_READER_URL` and `PI_SELECTED_PRODUCT_READER_CREDENTIAL`.
Only an HTTP loopback URL is accepted. The host POSTs
`{ workspaceId, intentId, principalId }`, authenticated with the synthetic fixture
credential. The launcher explicitly projects these three identifiers from the
internal versioned Node request, validating its literal version and refusing
extra authority fields. `principalId` is the CP transport reader, not the original DB actor.
HTTP 200 must return the raw strict `VerifiedPiLeadIntentEvidence` projection.
Denied reads return a non-success response. Each canonical read parses and
compares the complete accepted evidence; missing or changed evidence denies
without falling back to the cached registration. The safe launcher field
`currentProductReaderConfigured` distinguishes this mode. The supplying Adea
fixture must reread its real actor/audience under the product's DB locks.

## SQLite read port

`sqlite-candidate-model-store.fixture.mjs` executes fresh SELECTs on the canonical
durable metadata rows, validating DTO and workspace/reference identity. It caches
no selections, connections or readiness. All mutations delegate to the existing
transactional CAS repository. Its focused test covers parity, revocation and
physical reopen. This is a test-host composition port, not a custody rewrite.

## Qualification limits

Account authority, credential transport, payer records and provider responses are
explicitly synthetic. Existing write-only administration and spending contracts
are exercised; real vault custody and live provider entitlement are not qualified.
No environment credential lookup or OAuth extraction is available.

The dependency build passed 38 tasks with concurrency two. The initial host run
failed preparation because the new reader looked for a nonexistent
`admission.selection`; it now resolves the accepted snapshot by admission intent.
Subsequent runs reached preparation and exact funding reread, then timed out at
dispatch under the unchanged 30-second test limit. Diagnostic counters retained
one runtime admission/dispatch receipt and one catalog credential callback, with
zero physical provider requests and no spending read at the observed checkpoint.
The clean published `0dbbda21` diagnostic subsequently passed one test with
22 assertions in 11.96 seconds without a source, guard or deadline change.
Both catalog and inference callbacks completed, exactly one provider request
and model usage were recorded, and actor-race/revocation assertions were reached.
The earlier timing failures remain preserved with no demonstrated root cause.

The connected Adea PG preparation diagnostic on `0dbbda21` failed before
admission: metadata operations passed, prepare returned HTTP 503, host product
reads were one and successfully returned PG reads were zero; all admission,
budget, credential and provider counters were zero. The launcher forwarded
the internal fourth `schemaVersion` field to the strict three-key HTTP handler,
which rejected it before calling PG. The explicit three-identifier serializer
repairs this protocol mismatch; its two pure regressions pass eight assertions.
A new connected PG run remains pending, and this source repair alone does not
qualify the live product reader. Metadata physical
reopen does not prove runtime/intent restart: registration maps and host lifetime
remain process-local. No timeline publication authority, natural cancellation,
device integration, live provider, registry release or activation is claimed.
