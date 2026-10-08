# Confirmed funding integration qualification

The R2 host caches one execution-bound selection facade and injects it into both native credential use and recorded spending resolution. A retained preparation is one immutable payer/display winner per accepted attempt. Readiness does not authorize spending; the existing ledger owns each physical-send reservation.

Two independent test files cover the boundary without changing production runtime or UI modules:

- `packages/model-gateway/src/confirmed-funding-await.test.mjs` exercises the actual R2 confirmation and selection facades using deterministic mocked host ports. Payer revision, exact confirmation expiry, actor revocation and mock device-authority denial after awaited selection or credential callbacks prevent the protected operation. This is fault injection, not device integration qualification.
- `apps/control-api/src/models/pi-confirmed-funding-candidate.test.mjs` loads an explicitly supplied immutable R1 host and SDK artifact. It uses real SDK/HTTP/Pi/canonical SQLite composition with a scripted loopback provider and synthetic credential. Preparation performs no inference; repeated intent retains one payer confirmation and avoids another physical request or accounting entry. Payer change before dispatch or after runtime admission denies without refreshing the accepted payer or choosing a different connection. Scope expiry, actor/grant revocation and transport revocation are tested after the provider auth-resolution await, immediately before physical send. This gate follows credential callback admission; it does not prove denial before that callback. After expiry or actor/grant/transport revocation, authenticated status reads must also be rejected. The test uses trusted fixture evidence to verify zero physical requests and retained hold identity/maximum pins instead of requiring an unauthorized read to succeed.

The actual candidate test is an explicit qualification profile and skips when no host is supplied. Once enabled it requires the exact 40-character candidate commit and explicit SDK entry, failing closed on a different HEAD or missing artifact. No guessed registry versions, credentials, alternative host or provider fallback are used.

```sh
# Deterministic R2 boundary tests
cd packages/model-gateway
bun test src/confirmed-funding-await.test.mjs

# Actual candidate profile, from apps/control-api; paths are supplied by the artifact owner.
PI_FUNDING_CANDIDATE_HOST_ENTRY="$R1_HOST_ENTRY" \
PI_FUNDING_CANDIDATE_HEAD="$R1_EXACT_HEAD" \
PI_CANDIDATE_SDK_ENTRY="$INSTALLED_PUBLIC_SDK_ENTRY" \
bun test src/models/pi-confirmed-funding-candidate.test.mjs
```

Record the candidate commit/tree, public tarball manifest hashes, test-source hashes and exact command with results. Keep earlier failures. A mocked device reader or transport/service credential revocation must not be labeled as actual device revocation. The candidate currently has no device-specific authority hook, so that integration claim remains unresolved. These proofs confer no live-provider, paid-call, credential setup or activation qualification.
