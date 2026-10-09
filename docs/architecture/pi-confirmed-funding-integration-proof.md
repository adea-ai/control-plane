# Confirmed funding integration qualification

The R2 host caches one execution-bound selection facade and injects it into both native credential use and recorded spending resolution. A retained preparation is one immutable payer/display winner per accepted attempt. Readiness does not authorize spending; the existing ledger owns each physical-send reservation.

Two independent test files cover the boundary. The production runtime changes in this branch are limited to the funding-authorization schema extraction described in the PR, not to the confirmation behavior:

- `packages/model-gateway/src/confirmed-funding-await.test.mjs` exercises the actual R2 confirmation and selection facades using deterministic mocked host ports. Payer revision, exact confirmation expiry, actor revocation and mock device-authority denial after awaited selection or credential callbacks prevent the protected operation. This is fault injection, not device integration qualification.
- `apps/control-api/src/models/pi-confirmed-funding-candidate.test.mjs` loads an explicitly supplied immutable R1 host and SDK artifact. It uses real SDK/HTTP/Pi/canonical SQLite composition with a scripted loopback provider and synthetic credential. Preparation performs no inference; repeated intent retains one payer confirmation and avoids another physical request or accounting entry. Payer change before dispatch or after runtime admission denies without refreshing the accepted payer or choosing a different connection. Scope expiry, actor/grant revocation and transport revocation are tested after the provider auth-resolution await, immediately before physical send. This gate follows credential callback admission; it does not prove denial before that callback. After expiry or actor/grant/transport revocation, authenticated status reads must also be rejected. The test uses trusted fixture evidence to verify zero physical requests and retained hold identity/maximum pins instead of requiring an unauthorized read to succeed.

The actual candidate test is an explicit qualification profile and skips when no host is supplied. Once enabled it fails closed unless all of the following hold, enforced by `apps/control-api/src/models/candidate-provenance.fixture.mjs` before any module is imported:

- the host repository is checked out at the exact 40-character `PI_FUNDING_CANDIDATE_HEAD` with a clean tree, including untracked files (`CANDIDATE_SOURCE_DIRTY` otherwise; there is no dirty override);
- `PI_CANDIDATE_MANIFEST` names a JSON manifest whose `hostCommit` equals that pin and whose `sdk` block records `packageName`, `version`, `sourceCommit` and the SHA-256 of the SDK entry bytes;
- the explicit SDK entry's nearest `package.json` has the same name and version and a `gitHead` equal to `sdk.sourceCommit`, and the entry bytes match `sdk.entrySha256`.

The manifest is an owner-supplied identity pin, not authentication. No guessed registry versions, credentials, alternative host or provider fallback are used. `candidate-provenance.test.mjs` proves each guard refuses dirty or substituted inputs, including subprocess runs of both profiles.

```sh
# Deterministic R2 boundary tests
cd packages/model-gateway
bun test src/confirmed-funding-await.test.mjs

# Provenance guard regressions, then the actual candidate profile, from apps/control-api.
cd apps/control-api
bun test src/models/candidate-provenance.test.mjs

# Paths are supplied by the artifact owner.
PI_FUNDING_CANDIDATE_HOST_ENTRY="$R1_HOST_ENTRY" \
PI_FUNDING_CANDIDATE_HEAD="$R1_EXACT_HEAD" \
PI_CANDIDATE_SDK_ENTRY="$INSTALLED_PUBLIC_SDK_ENTRY" \
PI_CANDIDATE_MANIFEST="$CANDIDATE_MANIFEST" \
bun test src/models/pi-confirmed-funding-candidate.test.mjs
```

Record the candidate commit/tree, manifest hash, SDK entry hash, test-source hashes and exact command with results. Keep earlier failures. A mocked device reader or transport/service credential revocation must not be labeled as actual device revocation. The candidate currently has no device-specific authority hook, so that integration claim remains unresolved. These proofs confer no live-provider, paid-call, credential setup or activation qualification.

The supplementary `pi-inference-reopen-candidate.test.mjs` profile uses R1's native/governed-child/SQLite fixture at a 1100-token attempt ceiling, 1024-token input context and 32-token output limit. A scripted generation-two HTTP503 must preserve generation one's committed 11-token usage and generation two's unknown hold. Reconciliation and a physical ledger close/reopen must not authorize another send, duplicate settlement or silently replace a conflicting receipt. Spending authority in this native sequencing fixture is mocked; it does not extend the actual payer proof.

Configure `PI_NATIVE_REPAIR_SOURCE` with the candidate's `packages/pi-durable-adapter/src` directory and `PI_NATIVE_REPAIR_HEAD` with its exact commit. The source repository must be clean (`NATIVE_REPAIR_SOURCE_DIRTY` otherwise). The former `PI_NATIVE_REPAIR_ALLOW_DIRTY` exploratory override was removed because a dirty run could report a passing, qualification-shaped result; WIP probes must be recorded outside this profile. Qualify the owner's committed repair checkpoint before claiming the native repair qualified.
