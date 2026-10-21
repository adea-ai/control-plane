# CP #190 independent trust-boundary audit — 2026-10-21

Status: **audit complete for the Control Plane surface; acceptance NOT granted.**
The whole-cloud and whole-runtime trust acceptance remains **held**. Every live
profile gate is still open, and the independent human penetration review required by
the issue acceptance criteria has not been performed.

| Field                   | Value                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue                   | [#190 — M19.06 Complete the security, trust-boundary, and adversarial audit](https://github.com/adea-ai/control-plane/issues/190)                                 |
| Repository              | `adea-ai/control-plane`                                                                                                                                           |
| Branch                  | `f2w4/cp190-trust-boundary`                                                                                                                                       |
| Audited head            | `27f17bd55e0266439b5b3089163195c9e7a669be` (workspace `1.105.5`)                                                                                                  |
| Base                    | `main` at `6d16a495186d2a4d84d422c936a02b4abdc93928`                                                                                                              |
| Reviewer                | Fleet 2 / F2W4, independent of every code owner whose fix this report assesses                                                                                    |
| Machine-readable matrix | [`docs/evidence/m11-security-trust-boundary-matrix-2026-10-21.v1.json`](m11-security-trust-boundary-matrix-2026-10-21.v1.json)                                    |
| Executable probes       | [`scripts/security-trust-boundary-probes.mjs`](../../scripts/security-trust-boundary-probes.mjs) — `bun scripts/security-trust-boundary-probes.mjs`               |
| Requirements source     | [`docs/requirements/security-trust-atomic-inventory.md`](../requirements/security-trust-atomic-inventory.md) (`STA-L*` atoms, Security & Trust Model revision 78) |
| Prior source audit      | [`docs/requirements/security-trust-source-audit.md`](../requirements/security-trust-source-audit.md) (`STM-001`..`STM-035`)                                       |

## 1. Scope and method

The audit maps every Control Plane threat and control surface that the issue names
onto reachable entrypoints and then onto evidence, then probes the reachable ones
with credential-free synthetic inputs.

What this lane did:

- re-read the current issue acceptance text (retrieved 2026-10-21, issue updated
  2026-10-18), the atomic security/trust inventory, and the existing bounded source
  audit;
- traced the workspace, project, runtime, session, tools, models, artifacts and admin
  domains from the public entrypoint through authority, effect, persistence and
  cleanup, recording `path:line` for every decisive decision;
- assessed native grant and effect authorization, secret-canary sinks, direct-local
  IPC and path handling, the remote Runtime Gateway and the product relay separately,
  HPKE AAD/recipient/replay/expiry, SQLite/backup/import, provider and secret
  providers, sandbox boundaries and supply chain;
- ran **20 credential-free synthetic probes** against the audited head. Every probe
  reproduces a confirmed finding at this head. All 20 reproduce; 0 harness failures.

What this lane deliberately did **not** do:

- no secret, credential, token, key or connection string was read;
- no production or deployed profile was contacted and no penetration traffic was sent;
- no source file, existing test, canonical ledger or architecture artifact was edited;
- no owner fix is approved by this reviewer — each routed owner must verify its own fix
  on its own exact head, and an independent reviewer must then re-verify it.

### 1.1 Custody of the three new paths

The shared cross-fleet index
(`/tmp/opencode-three-fleet-20261020-fresh/data/cross-fleet-ownership.json`,
SHA-256 `561ccd22bdd6d5a4abb1ebbecc489d8ee055c046074df680262547ad52784f05`) was
searched for each candidate path. It contains **no** reference to
`scripts/run-bun-test-group.mjs`, `tests/m11-security-probes.test.mjs`,
`packages/credential-vault`, `packages/remote-control-relay`, `packages/sandbox`,
`packages/deployment/src/checkpoint` or `packages/profile-portability`. The four open
pull requests (1212, 1210, 1204, 1048) touch none of the three new paths, and no
registered worktree has any of them dirty or untracked.

Claude-lead custody is recorded as `unverified` in the shared index, so this lane used
**new, unique, additive paths only** and modified no existing file. A later custody
reversal can drop the branch without touching another owner.

| New path                                                              | Purpose                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/security-trust-boundary-probes.mjs`                          | Executable credential-free synthetic probes; exits `0` while every recorded finding still reproduces, `2` when an owner fix lands, `1` on a harness failure |
| `docs/evidence/m11-security-trust-boundary-matrix-2026-10-21.v1.json` | Machine-readable threat/control → entrypoint → evidence matrix and the finding register                                                                     |
| `docs/evidence/m11-security-trust-boundary-audit-2026-10-21.md`       | This independent review report                                                                                                                              |

`tests/m11-security-probes.test.mjs` was **not** modified: it is a shared lane file and
its custody is not established here. The 20 new probes are therefore a separate,
dedicated artifact rather than an edit to the existing probe suite.

## 2. Threat/control → entrypoint → evidence matrix

The full matrix, including the per-control obligation mapping and the evidence index,
is in the JSON artifact. The summary by domain:

| Domain    | Verified | Partial | Gap | Findings   |
| --------- | -------- | ------- | --- | ---------- |
| Workspace | 2        | 0       | 2   | F-05, F-10 |
| Project   | 0        | 1       | 1   | F-03       |
| Runtime   | 2        | 0       | 2   | F-07, F-24 |
| Session   | 1        | 0       | 1   | F-26       |
| Tools     | 1        | 0       | 1   | F-18       |
| Models    | 1        | 0       | 1   | F-20       |
| Artifacts | 2        | 0       | 1   | F-08       |
| Admin     | 1        | 0       | 2   | F-14, F-19 |

By the thirteen audit areas the issue requires:

| #190 required area                                                                                                                                             | Result       | Findings                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| 1. Every security objective/trust boundary/credential class maps to a testable control                                                                         | partial      | the inventory maps the obligations; the Control Plane cannot evidence several of them (F-03, F-13, F-19) |
| 2. Authorization matrices for every operation class                                                                                                            | partial      | F-05, F-18, F-19 leave workspace, tool and credential matrices open                                      |
| 3. Instruction injection, malicious output, memory poisoning, scope broadening, plan substitution, child-plan expansion, approval bypass, destructive coercion | gap          | F-20, F-18; the injection corpus remains with the #191 lane                                              |
| 4. Managed-cloud trust (Railway/Neon/R2/Restate, SSRF, ingress, cross-service auth, leakage)                                                                   | partial      | F-14, F-15, F-25, F-26, F-28                                                                             |
| 5. Direct-local RuntimeTransport/native trust                                                                                                                  | gap          | F-03, F-05, F-23, F-24                                                                                   |
| 6. Runtime Gateway and product relay, assessed separately                                                                                                      | gap          | F-01, F-02, F-07, F-16, F-17                                                                             |
| 7. HPKE envelopes: recipient, AAD, rotation, replay, expiry, tamper, downgrade, substitution                                                                   | **verified** | only the replay window is affected by F-02                                                               |
| 8. Local SQLite and self-hosted persistence                                                                                                                    | gap          | F-08, F-09, F-10                                                                                         |
| 9. SecretsProvider adapters across profiles                                                                                                                    | gap          | F-04, F-06, F-20, F-21, F-22                                                                             |
| 10. Sandbox boundaries, SSRF/metadata, output limits, cleanup, promotion, ambient credentials                                                                  | gap          | F-11, F-12, F-13                                                                                         |
| 11. Supply chain for containers, Local binaries and self-hosted images                                                                                         | **verified** | none; see §5                                                                                             |
| 12. DoS/abuse boundaries                                                                                                                                       | gap          | F-14, F-27                                                                                               |
| 13. Independent threat-model review and targeted manual penetration                                                                                            | partial      | this report is the independent read-only threat review; the penetration half is still open               |

## 3. Confirmed findings

Severity is the reviewer's assessment against the release, not a CVSS score.
"Release impact" states what the finding blocks.

| ID   | Severity     | Finding                                                                                                               | Release impact                                                       | Probe          |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------- |
| F-01 | **Critical** | Product relay metadata-only commands are unauthenticated                                                              | blocks all remote-control acceptance                                 | P01, P02       |
| F-02 | High         | Relay effects run before the durable idempotency receipt; no durable receipt ships                                    | duplicate live effects on redelivery                                 | P03, P04       |
| F-03 | High         | `LocalProjectGrant` is not enforced on the direct-local path; the production grant state is a hard-coded constant     | blocks Local filesystem/project acceptance                           | P08, P09, P10  |
| F-13 | High         | The sandbox provider contract is composed into no application and no live provider exists                             | there is no sandbox boundary in any shipped profile                  | P18            |
| F-04 | Medium-High  | The credential-vault egress guard does not see a secret inside an `Error`, `Map`, `Set` or `Buffer`                   | a leased secret can leave the vault                                  | P05            |
| F-05 | Medium-High  | The Local private API derives workspace and project scope from the request body                                       | cross-workspace fail-closed is unproven for Local                    | P07            |
| F-06 | Medium       | Redaction is key-name based and misses compound credential key names                                                  | secrets reach logs and events under such keys                        | P06            |
| F-07 | Medium       | Runtime Gateway runtime commands are not bounded to 24 hours                                                          | remote commands outlive their authority                              | P11            |
| F-08 | Medium       | A Local filesystem checkpoint copies the private-file secrets directory in cleartext                                  | operator backups carry plaintext secrets                             | P12            |
| F-09 | Medium       | SQLite WAL/SHM sidecars keep the pre-restriction file mode                                                            | recent writes may be group/world readable                            | P13            |
| F-10 | Medium       | Portable import scans with an empty sensitive-value list; portable secret references are not workspace scoped         | exports can carry another workspace's secret locator                 | P14, P15       |
| F-11 | Medium       | Sandbox credential bindings are injected after the ambient-credential denial runs                                     | a raw secret reaches the sandbox environment                         | P16            |
| F-12 | Medium       | The sandbox metadata-service deny list is incomplete                                                                  | non-default metadata endpoints stay reachable                        | P17            |
| F-14 | Medium       | The only public control-plane service has no HTTP rate limit and no inbound deadline                                  | an authenticated principal can saturate the pool                     | P19            |
| F-15 | Medium       | The Restate ingress submission carries no request credential                                                          | workflow submission trusts placement only                            | P20            |
| F-16 | Medium       | The repository ships a RuntimeNode credential issuer                                                                  | the issuer private key lives on Control Plane infrastructure         | source reading |
| F-17 | Medium       | The synthetic RuntimeNode authority merges credential classes and drops the binding fence                             | gateway auth tests do not exercise production separation             | source reading |
| F-18 | Medium       | The pi-durable tool path does not cross-check the accepted plan's tool grants                                         | a call can present a grant the plan does not grant                   | source reading |
| F-19 | Medium       | No policy decision point is composed into any application                                                             | the authorized-executor path cannot be demonstrated                  | source reading |
| F-20 | Medium       | Provider contributions and ProjectState items carry free-form content with no secret filter or untrusted-data marking | retrieved content can carry a credential or an instruction           | source reading |
| F-21 | Medium       | The environment and private-file secret providers ignore the `SecretUse` context                                      | a resolved secret is not bound to a workspace or purpose             | source reading |
| F-22 | Medium       | The Hosted server profile composes no credential vault; the host-secure provider has no resolver                      | the self-hosted server profile has no dynamic credential lifecycle   | source reading |
| F-23 | Medium       | The spawn-policy check is not pinned to the executed path                                                             | a symlink swap can launch an unlisted executable                     | source reading |
| F-24 | Medium       | The exported direct-local ACP factory applies no spawn policy by default                                              | an embedder can start any absolute executable at any absolute cwd    | source reading |
| F-25 | Medium       | Marketplace registry egress accepts any HTTPS URL with no metadata-range denial                                       | a misconfigured registry URL can reach a metadata endpoint           | source reading |
| F-26 | Medium       | The Restate interaction handler resolves by name without a responding-principal check                                 | an approval delivered over the workflow ingress is not re-authorized | source reading |
| F-28 | Medium       | Staging and production share one R2 bucket credential slot, separated by prefix only                                  | the asserted environment credential separation is a convention       | source reading |
| F-27 | Low-Medium   | Tool rate-limit events are only deleted for the tuple being checked                                                   | unbounded row growth for abandoned tuples                            | source reading |

### 3.1 The four highest-severity findings in detail

**F-01 — Product relay metadata-only commands are unauthenticated (Critical).**
`RelayMetadataCommandSchema` (`packages/remote-control-relay/src/protocol.ts:68-81`)
is a `.strict()` object with exactly `schemaVersion, workspaceId, hostId, commandId,
operation, issuedAt, expiresAt, targetId`. There is no signature, MAC, nonce,
sequence or key field. `RelayMetadataCommandProcessor.process`
(`packages/remote-control-relay/src/relay.ts:379-424`) validates only the schema,
the `hostId`/`workspaceId` equality and the time bounds, then calls `accept`, which
performs a live control-plane effect — `cancel`, `resume`, `approve`, `deny`,
`status`. `OutboundOpaqueRelayClient`
(`packages/remote-control-relay/src/adapter.ts:13-29`) has no credential either.
`docs/remote-control-relay.md:44` explicitly pushes the metadata transport's
authentication to the concrete relay client, which does not exist in this repository.
The content-bearing path is protected by HPKE; the metadata path is not, so a party
that can write to the relay store can approve or cancel a live execution in a chosen
workspace and host inside a 24-hour window. Obligation `STA-L46-09` requires the
_authenticated_ relay envelope for metadata-only commands.

**F-02 — Relay effects run before the durable idempotency receipt (High).**
All three relay processors apply the effect and only then write the receipt:
`packages/remote-control-relay/src/relay.ts:296-303` (content),
`packages/remote-control-relay/src/relay.ts:417-437` (metadata) and
`packages/remote-control-relay/src/execution.ts:187-197` (execution). A crash or a
failed receipt write leaves the effect applied and unrecorded, and the adapter
re-pulls any unacknowledged record (`packages/remote-control-relay/src/adapter.ts:134-153`),
so the effect repeats. Compounding this, the only receipt repositories in the package
are in-memory (`packages/remote-control-relay/src/relay.ts:227`, `:343`,
`packages/remote-control-relay/src/execution.ts:135`), so a host restart forgets every
receipt, and `commandId` is a free identifier, so a relay can re-issue the same
logical effect under a new identifier. The envelope lifetime is the only replay
window (`packages/remote-control-relay/src/protocol.ts:6`).

**F-03 — `LocalProjectGrant` is not enforced on the direct-local path (High).**
The grant exists only as an opaque reference plus a tri-state
(`packages/runtime-gateway-protocol/src/protocol.ts:562-567`,
`packages/acp-adapter/src/acp-gateway-types.ts:18`). The grant checks live in the
_gateway_ drivers (`packages/managed-pi-adapter/src/managed-pi-gateway-driver.ts:108-120`,
`packages/acp-adapter/src/acp-gateway-driver.ts:127-139`); the direct-local drivers
(`packages/acp-adapter/src/acp-driver-execution.ts`,
`packages/managed-pi-adapter/src/managed-pi-driver.ts`) never consult a grant at all.
The only production writer of the grant state is a hard-coded constant,
`localProjectGrant: { required: false, state: 'not_required' }`
(`apps/runtime-gateway/src/runtime-inventory-ingestion.ts:387`), consumed by
`apps/workflow-worker/src/runtime-attempt-router.ts:179-184`. Because the grant
carries no path, the canonical path containment that `STA-L42-10` requires has no
implementation to attach to: no `realpath` and no containment check exist in either
adapter package, and the only such code in the repository is the private-file secret
provider (`packages/secrets/src/index.ts:137-161`), which uses the correct order
(resolve, then compare, then `O_NOFOLLOW` with a device/inode re-check). The
boundary that does exist for the local process is the operator-declared
`allowedWorkingDirectories` (`packages/deployment/src/process-runtime.ts:67-86`),
which is optional and absent from the exported ACP factory.

**F-13 — There is no sandbox boundary in any shipped profile (High, evidence gap).**
`@control-plane/sandbox` is a root dev dependency only; no application or runtime
package depends on it, and `SandboxCoordinator` appears nowhere outside the package
and its tests. The package has no `@e2b/*` dependency
(`packages/sandbox/package.json:24-27`) and only a provider-neutral contract, an
adapter over an `E2bClientPort`, and fakes. `docs/sandbox.md:12-18` already states
that the in-process network check is a precheck and that provider-level isolation is
the required enforcement boundary. `STA-L77-01` and `STA-L83-02` therefore have no
implementation to assess, and the live E2B gate stays unproven.

## 4. Reproducible regression packet

Each entry names the confirmed behaviour, the failing condition, the synthetic
reproduction and the regression test the owner must add inside the package they own.
The `CP190-Pnn` identifiers are the probes in
`scripts/security-trust-boundary-probes.mjs`; running that script today prints
`20 open, 0 resolved, 0 harness failures`.

| ID             | Failing condition (synthetic)                                                                                                                   | Regression test the owner must add                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01 / P01-P02 | Submit a `RelayMetadataCommand` with only the eight schema fields and `operation: 'approve'` for a known `targetId`                             | Reject a metadata command with no authentication field; reject a forged `approve`/`deny`/`cancel` for a known target                                                                 |
| F-02 / P03-P04 | Re-submit the same logical effect under a new `commandId`; or make the receipt store's write fail                                               | Write the receipt before the effect and make it durable; a receipt-write failure must leave no effect; a replay after restart must be rejected as duplicate                          |
| F-03 / P08-P10 | Read the discovery projection and the direct drivers                                                                                            | The direct-local driver must require a current grant and contain every path against a canonical grant root after symlink resolution                                                  |
| F-04 / P05     | Lease a credential and return `new Error(secret)` from the leased operation                                                                     | The egress guard must traverse `Error` message/stack/cause, `Map`, `Set`, `Buffer` and typed arrays, or reject a non-plain result with `SECRET_EGRESS_BLOCKED`                       |
| F-05 / P07     | Call the Local API with a valid token and a foreign `workspaceId`                                                                               | The Local principal must be bound to an authorized workspace/project set; a foreign scope must be rejected                                                                           |
| F-06 / P06     | `redactTelemetryValue({ sessionToken: canary })`                                                                                                | `sessionToken`, `passphrase`, `bearerToken`, `connectionString` and `apiSecret` must be redacted, or the production value-based canary guard must run at every sink                  |
| F-07 / P11     | Enqueue a runtime command with a one-year lifetime                                                                                              | The runtime family must apply the same 24-hour bound and reject with `EXPIRY_TOO_LONG`                                                                                               |
| F-08 / P12     | Checkpoint a data directory that contains `secrets/provider-key`                                                                                | The checkpoint must exclude or seal the secrets directory; the cleartext must not appear in the copy                                                                                 |
| F-09 / P13     | Open a provider in a 0755 directory                                                                                                             | The `-wal` and `-shm` sidecars must be mode 0600                                                                                                                                     |
| F-10 / P14-P15 | Import a manifest whose record value carries a secret under a non-prohibited key; export a manifest with a foreign workspace's secret reference | The import path must scan with the export's sensitive values, and secret references must carry a workspace scope                                                                     |
| F-11 / P16     | Execute a sandbox command with `credentialBindings: [{ leaseId, environmentName: 'AWS_SESSION' }]`                                              | The ambient credential denial must apply to the effective environment including credential bindings                                                                                  |
| F-12 / P17     | Execute a sandbox command that targets `169.254.170.2`                                                                                          | The metadata denial must cover the link-local range and the known provider endpoints                                                                                                 |
| F-13 / P18     | Compose a hosted profile                                                                                                                        | A hosted composition must resolve a sandbox provider, and a composition without one must fail closed; the live E2B template, network, resource and cleanup evidence must be attached |
| F-14 / P19     | Send concurrent authenticated requests to the public API                                                                                        | A per-principal quota and an inbound deadline must exist; an over-quota request must get a bounded `429` without reaching the database                                               |
| F-15 / P20     | Submit a workflow without the Restate request identity                                                                                          | The ingress submission must be authenticated, and the self-hosted ingress must bind to the private interface                                                                         |
| F-16           | Inspect the production Control Plane image                                                                                                      | The image must not contain an issuer private key path; issuance must live on a separate operator surface                                                                             |
| F-17           | Present a device-signed credential with an issuer key id                                                                                        | The synthetic authority must sign with a distinct issuer key and enforce the node, workspace and generation fence                                                                    |
| F-18           | Submit a tool call whose grant names a tool absent from the accepted plan                                                                       | The pi-durable path must cross-check `plan.constraints.tools.grants`                                                                                                                 |
| F-19           | Compose a profile that leases a connector credential                                                                                            | A composed profile must resolve a decision point, and the permit matrix must be recorded                                                                                             |
| F-20           | Admit a provider contribution whose content carries a canary                                                                                    | Provider and ProjectState content must be filtered and marked as untrusted data                                                                                                      |
| F-21           | Resolve the same reference under two different `use` contexts                                                                                   | Every provider must accept and enforce the `SecretUse` context                                                                                                                       |
| F-22           | Compose the hosted server profile; resolve a packaged Local handle                                                                              | The hosted server profile must resolve a credential lifecycle; packaged Local must resolve an opaque OS-secure handle                                                                |
| F-23           | Swap the allowlisted executable for a symlink after the check                                                                                   | The spawn must execute the resolved canonical path with a device/inode re-check                                                                                                      |
| F-24           | Create the exported ACP factory without a spawn policy                                                                                          | The factory must require an explicit spawn policy and fail closed without it                                                                                                         |
| F-25           | Point the marketplace registry base URL at a metadata address                                                                                   | The registry fetch must deny the link-local and metadata ranges                                                                                                                      |
| F-26           | Deliver an interaction response from a principal outside `allowedPrincipalIds`                                                                  | The workflow ingress must re-check the responding principal before resolving                                                                                                         |
| F-27           | Stop calling a principal/tool/operation tuple and wait out the window                                                                           | The retention sweep must remove expired `tool_rate_limit_events` rows for abandoned tuples                                                                                           |
| F-28           | Use the staging credential against a production object key                                                                                      | Staging and production must hold distinct bucket-scoped R2 credentials; cross-environment reads must be denied                                                                       |

## 5. What the audit confirmed as sound

These are recorded so the next reviewer does not re-derive them.

- **HPKE envelopes (`packages/remote-control-relay/src/crypto.ts`).** RFC 9180 Base
  mode with `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256` and `AES-128-GCM`. The AAD
  (`packages/remote-control-relay/src/protocol.ts:132-151`) binds envelope version,
  suite, key id, workspace, host, command id, payload type and schema version,
  issued and expiry times, and the content digest. Expiry is checked before
  decryption, the 1 MiB cap is exact, wrong recipient, tamper, downgrade and digest
  mismatch all fail closed, and the ciphertext cap is enforced on both sides. The
  only HPKE weakness found is the replay window, which is F-02, not the envelope.
- **Supply chain.** Frozen lockfile with integrity hashes, digest-pinned base images
  and GitHub Actions, a pinned patched dependency with upstream provenance in
  `patches/README.md`, a Trivy image scan with a CycloneDX SBOM before publication,
  build-provenance attestation, least-privilege workflow permissions,
  `persist-credentials: false` on every checkout, and `pull_request_target`
  workflows that never check out PR code.
- **Deny-by-default policy.** `CedarPolicyDecisionPoint`
  (`packages/policy/src/index.ts:209-248`) denies on an unmapped action, a
  workspace mismatch, a missing or revoked policy, an evaluator failure, and a
  forbidden override. The credential vault denies leases outright when no decision
  point is composed (`packages/credential-vault/src/vault.ts:326-332`). The gap is
  that no profile composes one (F-19).
- **Child-plan privilege narrowing.** `packages/execution-plan/src/index.ts:280-340`
  and `:1162-1210` reject every expansion dimension, and
  `assertExecutionPlanDerivedFrom` re-derives and compares on persistence.
- **Memory-write safety.** `packages/memory-writeback/src/index.ts:208-215` defaults
  to `disabled`; approval is exhaustive (`:480-506`) and ambiguous writes park in
  `reconciliation_required` instead of retrying.
- **Gateway channel hardening.** Ed25519 credential plus device proof, a one-time
  transactional consumption fence bound to node/workspace/generation, durable
  revocation re-checked on every command, strict frame-size and backpressure limits,
  and workspace/node binding on every frame.
- **Existing probes.** `tests/m11-security-probes.test.mjs` passes at this head
  (42 tests, 129 assertions, seed 1104). It covers policy denial, grant-handle
  shape, secret-file traversal and symlink escape, spawn-policy limits, object-store
  content addressing, sandbox network and metadata denial, and HPKE tamper, expiry
  and cap behaviour. It does **not** cover any of the 28 findings in §3, which is
  why the dedicated probe file was necessary.

## 6. Unresolved gates — the reasons acceptance stays held

1. **No permitted live profile evidence.** The managed cloud, Local and self-hosted
   profiles have no permitted evidence in this lane. Whole-cloud and whole-runtime
   trust acceptance stays held until it exists.
2. **Agent HQ owns the other half of the trust model.** LocalProjectGrant issuance,
   desktop key storage, Event Gateway authorization and replay, durable
   `ContentSyncDevice`/`ContentKeyEpoch` flows, and the product relay's own
   credential are product-owned. The inventory already records them as `NONE-AHQ`;
   this audit cannot close them.
3. **No live E2B sandbox.** F-13 leaves the sandbox boundary as a contract only.
4. **No live managed-cloud vault rotation and restore evidence** for the selected
   credential-vault provider.
5. **No packaged Local OS-secure handle resolution** and no packaged binary signing
   or rollback evidence (F-22, and the inventory's `STA-L40-06`/`STA-L40-14`).
6. **No malware scanner composition, quarantine or fail-closed outage evidence.**
7. **No independent human penetration review.** This report is an independent
   read-only threat review with synthetic probes. The issue's "independent
   security-review evidence" criterion also needs the human penetration pass that
   this lane is not authorized to perform.
8. **The reviewer approves none of the routed fixes.** Each routed owner must verify
   its own fix on its own exact head, and an independent reviewer must then re-verify
   it on that exact head before the finding is closed.

## 7. Routing

No source path is taken by this lane. Each finding is routed to the owner that already
holds the affected package, and the routing table is in the JSON artifact
(`findings[].routedTo`).

| Owner                                       | Findings                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 — runtime and profile composition        | F-01, F-02, F-03, F-05, F-07, F-08, F-09, F-10, F-11, F-12, F-13, F-15, F-16, F-17, F-18, F-19, F-20, F-21, F-22, F-23, F-24, F-25, F-26, F-28 |
| W2 — policy, contracts, decision resolution | F-19 (Cedar matrix and the per-profile authorization matrix)                                                                                   |
| W4 — coverage and runner paths              | F-27 (retention sweep coverage), plus the probe-to-regression-test conversion for the packages it owns                                         |
| Agent HQ / product owner                    | F-01 (the product relay's own transport authentication) and the `NONE-AHQ` controls in §6.2                                                    |
| Operations                                  | F-13 (E2B template, network, resource and cleanup thresholds), F-14 (deployed limit values), F-28 (per-environment R2 credentials)             |

### 7.1 Next actions

1. Root assigns each finding to the owner above and the owner converts the
   `CP190-Pnn` probe into a regression test inside the package they own.
2. The owner records the fix head; this reviewer re-verifies each fix on that exact
   head and updates this report and the JSON matrix.
3. `scripts/security-trust-boundary-probes.mjs` must be updated in the same change as
   any fix that stops a probe from reproducing; a probe that stops reproducing
   without that update is a CI-visible drift, not a silent pass.
4. The live profile evidence in §6.1–§6.6 is requested from its owner; until it
   exists, `STA-L*` rows marked open in the inventory stay open and the whole-cloud
   trust acceptance stays held.
