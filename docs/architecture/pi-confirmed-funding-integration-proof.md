# Confirmed funding integration qualification

The R2 host caches one execution-bound selection facade and injects it into both native credential use and recorded spending resolution. A retained preparation is one immutable payer/display winner per accepted attempt. Readiness does not authorize spending; the existing ledger owns each physical-send reservation.

Two independent test files cover the boundary. The production runtime changes in this branch are limited to the funding-authorization schema extraction described in the PR, not to the confirmation behavior:

- `packages/model-gateway/src/confirmed-funding-await.test.mjs` exercises the actual R2 confirmation and selection facades using deterministic mocked host ports. Payer revision, exact confirmation expiry, actor revocation and mock device-authority denial after awaited selection or credential callbacks prevent the protected operation. This is fault injection, not device integration qualification.
- `apps/control-api/src/models/pi-confirmed-funding-candidate.test.mjs` loads an explicitly supplied host entry at the pinned commit and an installed SDK artifact bound to a candidate manifest. It uses real SDK/HTTP/Pi/canonical SQLite composition with a scripted loopback provider and synthetic credential. Preparation performs no inference; repeated intent retains one payer confirmation and avoids another physical request or accounting entry. Payer change before dispatch or after runtime admission denies without refreshing the accepted payer or choosing a different connection. Scope expiry, actor/grant revocation and transport revocation are tested after the provider auth-resolution await, immediately before physical send. This gate follows credential callback admission; it does not prove denial before that callback. After expiry or actor/grant/transport revocation, authenticated status reads must also be rejected. The test uses trusted fixture evidence to verify zero physical requests and retained hold identity/maximum pins instead of requiring an unauthorized read to succeed.

The actual candidate test is an explicit qualification profile and skips when no inputs are supplied. Once enabled it fails closed before any candidate module is imported, unless all of the following hold (`apps/control-api/src/models/candidate-provenance.fixture.mjs`):

- The host repository is at the exact 40-character `PI_FUNDING_CANDIDATE_HEAD` with a clean tree, including untracked files. There is no dirty override (`CANDIDATE_SOURCE_DIRTY`).
- `PI_CANDIDATE_MANIFEST_SHA256` pins the bytes of `PI_CANDIDATE_MANIFEST`, the `manifest.json` written by `scripts/pack-pi-durable-candidate.mjs`. The manifest's `head` must equal the pin and its `dirty` must be `false`.
- Every archive listed in the manifest (`@adea-ai/contracts`, `@adea-ai/runtime-sdk`, `@adea-ai/sdk`) must match its recorded byte length and SHA-256, and its packed `package.json` identity must match the manifest entry.
- Each packed package must be installed under the same `@adea-ai` scope as `PI_CANDIDATE_SDK_ENTRY`, with a file tree byte-identical to its archive. A missing or substituted sibling fails closed.

The manifest digest is an operator-supplied pin, not authentication: it binds the run to a commit and packed bytes, and nothing here verifies who built them. The pack script does not run the package builds, so the proof builds from a fresh clone of the pinned commit (`turbo run build --force`) before packing. No guessed registry versions, credentials, alternative host or provider fallback are used. `candidate-provenance.test.mjs` covers each guard with hash-valid mutations and subprocess runs of both profiles.

Candidate host: `apps/control-api/src/pi-durable/node-candidate.fixture.mjs`. Its content is byte-identical to the frozen R1 host at `050dbabdabd4724405dc9b02b9993dc5234205d2`, which is not an ancestor of this branch.

```sh
# Deterministic R2 boundary tests and provenance regressions
(cd packages/model-gateway && bun test src/confirmed-funding-await.test.mjs)
(cd apps/control-api && bun test src/models/candidate-provenance.test.mjs)

# Positive proof. $CAND is a fresh clone at $PIN with node_modules copied in; $OUT and $CONSUMER are outside the repository.
(cd "$CAND" && bun install --frozen-lockfile && node_modules/.bin/turbo run build --force)
(cd "$CAND" && bun scripts/pack-pi-durable-candidate.mjs "$OUT")
# Install $OUT/*.tgz into $CONSUMER with file: dependencies (sdk, contracts and runtime-sdk), then:
MSHA=$(shasum -a 256 "$OUT/manifest.json" | cut -d' ' -f1)
(cd "$CAND/apps/control-api" && \
  PI_FUNDING_CANDIDATE_HOST_ENTRY="$CAND/apps/control-api/src/pi-durable/node-candidate.fixture.mjs" \
  PI_FUNDING_CANDIDATE_HEAD="$PIN" \
  PI_CANDIDATE_MANIFEST="$OUT/manifest.json" \
  PI_CANDIDATE_MANIFEST_SHA256="$MSHA" \
  PI_CANDIDATE_SDK_ENTRY="$CONSUMER/node_modules/@adea-ai/sdk/dist/index.js" \
  bun test src/models/pi-confirmed-funding-candidate.test.mjs)
```

Run Bun directly if a version-manager shim refuses an untrusted `.mise.toml`. Record the pinned commit, manifest digest, archive digests, exact commands and results in the pull request, and keep failures. The profile verifies packed archives and installed trees. It does not hash-pin the registry dependency closure (for example `zod`). A mocked device reader or transport/service credential revocation must not be labeled as actual device revocation. The candidate currently has no device-specific authority hook, so that integration claim remains unresolved. These proofs confer no live-provider, paid-call, credential setup or activation qualification.

The supplementary `pi-inference-reopen-candidate.test.mjs` profile uses R1's native/governed-child/SQLite fixture at a 1100-token attempt ceiling, 1024-token input context and 32-token output limit. A scripted generation-two HTTP503 must preserve generation one's committed 11-token usage and generation two's unknown hold. Reconciliation and a physical ledger close/reopen must not authorize another send, duplicate settlement or silently replace a conflicting receipt. Spending authority in this native sequencing fixture is mocked; it does not extend the actual payer proof.

Configure `PI_NATIVE_REPAIR_SOURCE` with the candidate's `packages/pi-durable-adapter/src` directory and `PI_NATIVE_REPAIR_HEAD` with its exact commit. The source repository must be clean (`NATIVE_REPAIR_SOURCE_DIRTY` otherwise). The former `PI_NATIVE_REPAIR_ALLOW_DIRTY` exploratory override was removed because a dirty run could report a passing, qualification-shaped result; WIP probes must be recorded outside this profile. Qualify the owner's committed repair checkpoint before claiming the native repair qualified.
