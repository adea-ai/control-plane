# CP #190 independent trust-boundary audit — 2026-10-21

Status: **audit complete for the Control Plane surface; acceptance NOT granted.**
The whole-cloud and whole-runtime trust acceptance remains **held**. Every live
profile gate is still open, and no targeted penetration exercise or independent
security-review evidence has been produced against a permitted live profile. Issue #190
asks for independent review and targeted manual penetration against the candidates; it
does not require the reviewer to be human.

Revision 2 (2026-10-21): calibrated against root's counterevidence. Six findings were
re-checked against exact source; F-01, F-02, F-04, F-05 and F-09 were reduced in
severity and restated with an explicit reachability class, and F-03's citation was
corrected. Every finding now states what the code does and what that makes
reachable, and no finding claims a demonstrated deployed credential leak, a deployed
unauthenticated approval path, or a cross-UID read. The unresolved gates in §8 are
unchanged.

Revision 3 (2026-10-21): every finding was traced from its entrypoint through the
authority and effect path to the point where a control is applied, and every probe
was re-read as a synthetic demonstration rather than as deployed behaviour. Five
findings were restated with their traced path, F-09 was split so the provider
observation and the adapter-owned directory are reported separately, CP190-F29 was
added for the adapter-owned directory, and five static reachability probes
(CP190-P21 to CP190-P25) were added. The finding count is now 29 and the probe count 25. No severity changed in this round and no gate was released.

Revision 4 (2026-10-21): the packet was reconciled against the repository as it
stands now, and several of its statements no longer described it. `main` has
advanced one commit past the base this packet recorded —
`4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` ("Harden credential vault callback
result inspection (#1224)") — and that commit **does** touch a dependency file this
packet relies on: it is the owner fix for F-04. The probe suite was executed
against that exact head and reports `24 open, 2 resolved, 0 harness failures`
with exit code `2`; CP190-P05 and CP190-P23, which are F-04's two probes, no
longer reproduce there. The other twenty-nine files this packet's probes read are
identical on the audited head and on current `main`, so the base advance can only
bear on F-04.

Seven further corrections are recorded in place, each against a check that decides
it: the probe count the script prints (26, not 25); the probe-kind split in §4
(eight probes call the real code path, eighteen read source as text); CP190-P26's
obligation mapping, whose two cited atoms do not exist in the cited inventory;
F-09's probe list, which named CP190-P25 although that probe's reproduction is
conditioned on the adapter-owned directory that F-29 reports; the pull-request
list in §1.1, which counted a merged pull request and this pull request as open
at the audited head; the file count in §3.1; the question count in §9.1; and the
routing table in §9, which omitted F-04 and F-06 from W1 and left F-27's package
owner unstated. §1.1's index claim is now scoped to the snapshot it cites, because
the index is rewritten continuously, and the re-read result is in §7 and in the
JSON matrix's custody block. §5's "seed 1104" is removed: it belongs to a
different suite, and this packet's cited file has no randomised seed. No finding
was added, removed or re-rated, no gate was released, and no acceptance is
claimed.

Revision 5 (2026-10-23): a bounded evidence repair after advisory review of head
`573f50c0c255073ca80372aad926c0bcea1ced81`. No finding was added or removed, no
severity changed, no gate was added or released, no live profile was contacted and no
secret was inspected. (1) The remaining penetration gate no longer says "human": issue
#190 asks for independent review and targeted manual penetration and does not require a
human reviewer, so an independent agent review or exercise can satisfy it. (2) F-16 and
F-28 are restated so that what the source shows is separated from deployment facts it does
not show: F-16 no longer asserts where an issuer private key lives, and F-28 no longer
infers shared credential values or scopes from matching variable names. Both deployment
facts are recorded as evidence gaps. (3) The F-03 entrypoint
`packages/managed-pi-adapter/src/managed-pi-driver.ts`, which does not exist, is replaced
in the matrix by `packages/managed-pi-adapter/src/index.ts:322`. (4) The conflicting
statements about whether the shared ownership index was readable at the audited head are
recorded as unverified in §1.1 and in the matrix custody block. (5) CP190-P21 scanned
only top-level `apps/*/src/*.ts` files but was worded as proving that no composition
builds the relay adapter or the metadata processor; it now scans `apps/` and `packages/`
recursively, and every statement that relied on it names what was scanned.

| Field                   | Value                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue                   | [#190 — M19.06 Complete the security, trust-boundary, and adversarial audit](https://github.com/adea-ai/control-plane/issues/190)                                                                                                                                   |
| Repository              | `adea-ai/control-plane`                                                                                                                                                                                                                                             |
| Branch                  | `f2w4/cp190-trust-boundary`                                                                                                                                                                                                                                         |
| Audited head            | `27f17bd55e0266439b5b3089163195c9e7a669be` (workspace `1.105.5`)                                                                                                                                                                                                    |
| Base                    | the `main` commit this branch was cut from, `6d16a495186d2a4d84d422c936a02b4abdc93928`; the branch's merge base with `main` is the audited head `27f17bd55e0266439b5b3089163195c9e7a669be`, and `main` is now `4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` — see §3.1 |
| Reviewer                | Fleet 2 / F2W4, independent of every code owner whose fix this report assesses                                                                                                                                                                                      |
| Machine-readable matrix | [`docs/evidence/m11-security-trust-boundary-matrix-2026-10-21.v1.json`](m11-security-trust-boundary-matrix-2026-10-21.v1.json)                                                                                                                                      |
| Executable probes       | [`scripts/security-trust-boundary-probes.mjs`](../../scripts/security-trust-boundary-probes.mjs) — `bun scripts/security-trust-boundary-probes.mjs`                                                                                                                 |
| Requirements source     | [`docs/requirements/security-trust-atomic-inventory.md`](../requirements/security-trust-atomic-inventory.md) (`STA-L*` atoms, Security & Trust Model revision 78)                                                                                                   |
| Prior source audit      | [`docs/requirements/security-trust-source-audit.md`](../requirements/security-trust-source-audit.md) (`STM-001`..`STM-035`)                                                                                                                                         |

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
- ran **26 credential-free synthetic probes** against the audited head. Every probe
  reproduces a confirmed finding at this head. All 26 reproduce; 0 harness failures.

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
searched for each candidate path **at the audited head**. In that snapshot it
contains **no** reference to `scripts/run-bun-test-group.mjs`,
`tests/m11-security-probes.test.mjs`, `packages/credential-vault`,
`packages/remote-control-relay`, `packages/sandbox`,
`packages/deployment/src/checkpoint` or `packages/profile-portability`. The open
pull requests checked at that head (1048, 1204, 1210, 1214, 1215, 1216, 1217, 1218,
1219, 1222, 1223 — 1212 is merged, and 1220 is this pull request) touch none of the
three new paths, and no registered worktree had any of them dirty or untracked.

**The index is rewritten continuously, so that snapshot is not the file as it
stands now.** The re-read is recorded in the JSON matrix's custody block, and
§7 records what it changed: the two F-04 paths this packet proposes are now named
in the index as the scope of the owner whose fix has landed on `main`.

**The records of the original index conflict, so the custody observation is unverified.**
This section and the matrix `custody.sharedIndexSha256` record a search of a snapshot of
the index at the audited head. The matrix `custody.sharedIndexNote` of the previous
revision said that the index was not readable at the audited head and that the claim was
scoped to the checkouts actually inspected. Both cannot hold, the index is a file outside
this repository, and this pull request cannot re-establish either statement. The
"no reference" results in this section are therefore the author's recorded observation
and not a verified fact. No finding depends on them: the only custody question they bear
on is F-04's, which is moot because its fix is on `main` (#1224).

Claude-lead custody is recorded as `unverified` in the shared index, so this lane used
**new, unique, additive paths only** and modified no existing file. A later custody
reversal can drop the branch without touching another owner.

| New path                                                              | Purpose                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/security-trust-boundary-probes.mjs`                          | Executable credential-free synthetic probes; exits `0` while every recorded finding still reproduces, `2` when an owner fix lands, `1` on a harness failure |
| `docs/evidence/m11-security-trust-boundary-matrix-2026-10-21.v1.json` | Machine-readable threat/control → entrypoint → evidence matrix and the finding register                                                                     |
| `docs/evidence/m11-security-trust-boundary-audit-2026-10-21.md`       | This independent review report                                                                                                                              |

`tests/m11-security-probes.test.mjs` was **not** modified: it is a shared lane file and
its custody is not established here. The 26 new probes are therefore a separate,
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

**Additional source-supported evidence for F-01/F-02 (the documented trust
properties are not in the contract).** `docs/remote-control-relay.md` states that
the metadata-only operations "use a separate strict, **authenticated** command
schema" that "bind each **idempotency key** to the exact command body", but
`packages/remote-control-relay/src/protocol.ts` (`RelayMetadataCommandSchema`,
`.strict()`) carries neither an authentication field nor an idempotency-key
field - its fields are `schemaVersion`, `workspaceId`, `hostId`, `commandId`,
`operation`, `issuedAt`, `expiresAt` and `targetId`. The schema therefore cannot
be the enforcement point the document describes, and the document's own hedge
("authentication of that metadata transport remains the responsibility of the
concrete relay client") covers the transport only, not the schema-level claim.
`CP190-P26` reads both files and reproduces the mismatch; the correction belongs
to the owner of `docs/remote-control-relay.md` and of the relay contract, and
this packet edits neither.

Severity is the reviewer's assessment against the release, not a CVSS score.
"Release impact" states what the finding blocks. **Reachability** states how a
reader may use the finding:

| Reachability class | Meaning                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `deployed-now`     | Present in a shipped profile today, subject to the preconditions in the finding                                                   |
| `configured-only`  | Reachable only after an operator configures the optional component; it ships disabled or is not composed by default               |
| `library-contract` | A library-level contract gap. No composed path in this repository reaches it, so no deployed behaviour is claimed                 |
| `defense-in-depth` | A hardening gap. The described attack is not demonstrated as reachable; a stated control prevents it in the current configuration |
| `evidence-gap`     | The control is a contract with no composed implementation, so there is nothing to attack and nothing to accept                    |

After the two calibration rounds the distribution is **0 critical, 2 high (F-03,
F-13), 22 medium, 2 low (F-04, F-09), 3 low-medium (F-23, F-27, F-29)** across 29
findings. No finding claims a demonstrated deployed credential leak, a deployed
unauthenticated approval path, or a cross-UID read.

| ID   | Severity   | Reachability       | Finding                                                                                                                         | Release impact                                                                                                                             | Probe              |
| ---- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| F-01 | Medium     | `configured-only`  | The relay host processor applies no authentication of its own to metadata-only commands                                         | does not block the release; no composed relay client or adapter instance exists and no metadata effect implementation ships                | P01, P02, P21, P26 |
| F-02 | Medium     | `configured-only`  | The relay receipt layer adds no idempotency beyond the command identifier, and only in-memory receipt repositories ship         | bounds the remote-control idempotency claim; `create_execution` is idempotent through the CommandInbox                                     | P03, P04, P22, P26 |
| F-03 | High       | `deployed-now`     | The direct-local runtime path never consults a `LocalProjectGrant`, and the production discovery state is a hard-coded constant | blocks the Local filesystem/project acceptance claim: the working directory is bounded by operator configuration, not by a grant           | P08, P09, P10, P24 |
| F-13 | High       | `evidence-gap`     | The sandbox provider contract is composed into no application and no live provider exists                                       | there is no sandbox boundary in any shipped profile                                                                                        | P18                |
| F-04 | Low        | `library-contract` | The credential-vault returned-value screen does not descend into `Error`, `Map`, `Set` or byte containers                       | no deployed credential leakage is claimed; the one composed leased path normalizes the result before the screen sees it                    | P05, P23           |
| F-05 | Medium     | `deployed-now`     | The Local private API derives workspace and project scope from the request body                                                 | leaves the Local cross-workspace fail-closed claim unproven; the Local profile binds loopback and uses an owner-only token                 | P07                |
| F-06 | Medium     | `deployed-now`     | Redaction is key-name based and misses compound credential key names                                                            | secrets reach logs and events under such keys                                                                                              | P06                |
| F-07 | Medium     | `configured-only`  | Runtime Gateway runtime commands are not bounded to 24 hours                                                                    | remote commands outlive their authority; the gateway is used only for non-co-located nodes                                                 | P11                |
| F-08 | Medium     | `deployed-now`     | A Local filesystem checkpoint copies the private-file secrets directory in cleartext                                            | operator backups carry plaintext secrets                                                                                                   | P12                |
| F-09 | Low        | `defense-in-depth` | SQLite WAL/SHM sidecars keep the pre-restriction file mode inside an owner-only parent directory                                | no cross-UID read is claimed and there is no supported traversal path in the provider                                                      | P13                |
| F-10 | Medium     | `deployed-now`     | Portable import scans with an empty sensitive-value list; portable secret references are not workspace scoped                   | exports can carry another workspace's secret locator                                                                                       | P14, P15           |
| F-11 | Medium     | `configured-only`  | Sandbox credential bindings are injected after the ambient-credential denial runs                                               | a raw secret reaches the sandbox environment; the sandbox is composed into no application                                                  | P16                |
| F-12 | Medium     | `configured-only`  | The sandbox metadata-service deny list is incomplete                                                                            | non-default metadata endpoints stay reachable; the sandbox is composed into no application                                                 | P17                |
| F-14 | Medium     | `deployed-now`     | The only public control-plane service has no HTTP rate limit and no inbound deadline                                            | an authenticated principal can saturate the pool; unauthenticated callers are rejected first                                               | P19                |
| F-15 | Medium     | `configured-only`  | The Restate ingress submission carries no request credential                                                                    | workflow submission trusts placement only; the Cloud profile relies on private networking and the self-hosted profile binds all interfaces | P20                |
| F-16 | Medium     | `configured-only`  | The repository ships a RuntimeNode credential issuer CLI                                                                        | issuer signing code ships with the repo and image build context; where an issuer private key is stored is an evidence gap                  | source reading     |
| F-17 | Medium     | `evidence-gap`     | The synthetic RuntimeNode authority merges credential classes and drops the binding fence                                       | gateway auth tests do not exercise production separation; the authority is test-only                                                       | source reading     |
| F-18 | Medium     | `deployed-now`     | The pi-durable tool path does not cross-check the accepted plan's tool grants                                                   | a call can present a grant the plan does not grant                                                                                         | source reading     |
| F-19 | Medium     | `evidence-gap`     | No policy decision point is composed into any application                                                                       | the authorized-executor path cannot be demonstrated; the deny path is proven                                                               | source reading     |
| F-20 | Medium     | `deployed-now`     | Provider contributions and ProjectState items carry free-form content with no secret filter or untrusted-data marking           | retrieved content can carry a credential or an instruction                                                                                 | source reading     |
| F-21 | Medium     | `deployed-now`     | The environment and private-file secret providers ignore the `SecretUse` context                                                | a resolved secret is not bound to a workspace or purpose                                                                                   | source reading     |
| F-22 | Medium     | `configured-only`  | The Hosted server profile composes no credential vault; the host-secure provider has no resolver                                | the self-hosted server profile has no dynamic credential lifecycle                                                                         | source reading     |
| F-23 | Low-Medium | `defense-in-depth` | The spawn-policy check is not pinned to the executed path                                                                       | a symlink swap race could launch an unlisted executable; it requires local write access to the executable path                             | source reading     |
| F-24 | Medium     | `configured-only`  | The exported direct-local ACP factory applies no spawn policy by default                                                        | an embedder can start any absolute executable at any absolute cwd; the production factory does set a policy                                | source reading     |
| F-25 | Medium     | `configured-only`  | Marketplace registry egress accepts any HTTPS URL with no metadata-range denial                                                 | a misconfigured registry URL can reach a metadata endpoint; the base URL is operator-controlled                                            | source reading     |
| F-26 | Medium     | `configured-only`  | The Restate interaction handler resolves by name without a responding-principal check                                           | an approval delivered over the workflow ingress is not re-authorized on that path                                                          | source reading     |
| F-28 | Medium     | `configured-only`  | Staging and production share one R2 bucket, separated by a key prefix; distinct credentials are not shown                       | prefix separation is visible in source; whether the credentials are shared or distinct is an evidence gap, not a finding                   | source reading     |
| F-27 | Low-Medium | `deployed-now`     | Tool rate-limit events are only deleted for the tuple being checked                                                             | unbounded row growth for abandoned tuples                                                                                                  | source reading     |
| F-29 | Low-Medium | `defense-in-depth` | The pi-durable adapter creates its own data directory without an owner-only mode                                                | the guarantee is inherited from an ancestor the composition happens to create owner-only, not enforced by the component that owns the data | P25                |

### 3.1 Final-candidate re-check against every available head

Every branch in the fleet's shared origin was compared against the audited head for
the files each finding depends on. The comparison covered
`packages/remote-control-relay/src`, `packages/credential-vault/src`,
`packages/sandbox/src`, `packages/deployment/src/checkpoint.ts`,
`packages/profile-portability/src`, `packages/secrets/src`,
`apps/control-api/src/auth`, `apps/runtime-gateway/src`,
`apps/workflow-worker/src/runtime-attempt-router.ts`,
`apps/workflow-worker/src/managed-pi-remote-command.ts`, `packages/execution-plan/src`,
`packages/telemetry/src`, `packages/events/src`,
`packages/sqlite-persistence/src/provider.ts`, `packages/context/src`,
`packages/domain/src/project-state.ts`, `packages/memory-writeback/src`,
`apps/control-api/src/pi-durable/current-tool-authority.ts`,
`apps/control-api/src/executions/execution-acceptance.service.ts`,
`apps/control-api/src/application.ts`, `apps/control-api/src/marketplace/registry.ts`,
`packages/workflow-runtime/src/restate-endpoint.ts`,
`scripts/runtime-node-identity-admin.mjs`, `apps/local-control-plane/src/acp-runtime.ts`,
`packages/acp-adapter/src`, `packages/managed-pi-adapter/src`,
`packages/deployment/src/process-runtime.ts` and
`apps/hosted-control-plane/src/composition.ts`.

**The base has advanced since this packet was written.** The branch's merge base
with `main` is the audited head, `27f17bd55`; `main` is now
`4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` ("Harden credential vault callback
result inspection (#1224)"), five commits ahead (`2e68492ed` #1211, `b1dee8b9c`
#1213, `df37ca85a` #1212, `5e4b8d33` #1221, `4e126a7c3` #1224).

The first four of those commits touch only `.release-please-manifest.json`,
`CHANGELOG.md`, `package.json`,
`packages/testing/{CHANGELOG.md,package.json,src/postgres.test.mjs}`,
`scripts/railway-production-plan.mjs` and `tests/railway-production-plan.test.mjs`.
**None of them is a dependency file this packet relies on**. One packet row needs
re-reading by its owner: F-28's proposed regression file
`tests/railway-production-plan.test.mjs` gained +542 lines on the new main;
F-28's cited source (`.railway/railway.ts`) is unchanged, so the finding stands
and only the proposed regression location moves.

**The fifth commit does touch a dependency file this packet relies on, and it is
the owner fix for F-04.** `4e126a7c3` changes
`packages/credential-vault/src/vault.ts` (+302 lines) and adds
`packages/credential-vault/src/index.test.mjs` (+219 lines): the returned-value
egress screen F-04 is about, and the exact regression file §4 proposes for it.
`packages/credential-vault/src/vault.ts` is the only one of the thirty files this
packet's probes read that differs between the audited head and current `main`; the
other twenty-nine are byte-identical, so the base advance can only bear on
F-04.

**`main` advanced once more after that read.** The authoritative read behind this
reconciliation returned `4e126a7c3`; a later read returned `f1bd75c58`
("test(model-gateway): prove the BYO eligibility rules independently (CP #931)
(#1225)"), which adds one test file under `packages/model-gateway/src`. That
commit changes none of the thirty files this packet's probes read and none of
this packet's dependency paths, so no finding, severity, probe result or gate
changes with it.

Result: **one owner fix exists on a currently available head: F-04's, on `main` at
`4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` (#1224).** The other 28 findings have no
owner fix on any available head. The F-04 fix was re-verified by execution on that
exact head, and the measurement is in §3.1a below. F-04 is **not closed by this
lane**: the finding stands against the audited head, where it still reproduces, and
closing a finding is the reviewer's act on the owner's fix head under §9.1 item 2,
not the landing of the fix. Five files still differ on unmerged branches, and in
every case the difference is cosmetic or belongs to an unrelated change:

| File                                                 | Branch                                                 | Difference                                                     | Effect on a finding                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/remote-control-relay/src/relay.ts`         | `origin/test/m612-tool-replay-qualification`           | the same `#612` byte-format fix under different variable names | none; the processor still adds no provenance check of its own, so F-01 and F-02 stand |
| `packages/deployment/src/checkpoint.ts`              | `origin/test/m612-tool-replay-qualification`           | the same `#612` digest-format wording                          | none; the secrets directory is still copied, so F-08 stands                           |
| `packages/profile-portability/src/migration.ts`      | `origin/test/m612-tool-replay-qualification`           | record-equivalence comparison refactor                         | none; F-10 stands                                                                     |
| `packages/sqlite-persistence/src/provider.ts`        | `origin/test/m612-tool-replay-qualification`           | scope-trigger statements moved                                 | none; F-09 stands                                                                     |
| `apps/workflow-worker/src/runtime-attempt-router.ts` | `origin/w1/cp1048-restore-generation-authority-repair` | the per-model harness map from #678                            | none; the grant-state check is unchanged, so F-03 stands                              |

The verification step required by the issue — "verify owner fixes on their new exact
heads after they are available" — therefore has one item to verify now, and it is
F-04's. It stays open for the other 28 findings until an owner lands a fix and
records its exact head.

### 3.1a The F-04 owner fix, re-verified on its exact head

The owner fix for F-04 landed on `main` at
`4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` (#1224, "Harden credential vault
callback result inspection"). This reviewer re-verified it by **executing** the
packet's own probe suite against that exact head, not by reading the fix's
description:

- the suite was run with `main`'s `packages/credential-vault` in place of the
  audited head's, and with every other file identical — `main`'s credential-vault
  is the only one of the thirty files the probes read that differs from the
  audited head, so the run measures the fix and nothing else;
- the run reports `24 open, 2 resolved, 0 harness failures` and exits `2`, the
  exit code the script defines for "a recorded finding no longer reproduces";
- the two probes that no longer reproduce are CP190-P05 ("the credential-vault
  egress screen misses a returned carrier but a thrown error is sanitized") and
  CP190-P23 ("the vault screen itself is an own-enumerable-key traversal") — which
  are exactly F-04's two probes, and the two the finding names;
- with the audited head's credential-vault restored and the package rebuilt, the
  suite reports `26 open, 0 resolved, 0 harness failures` and exits `0`, so the
  difference is the fix and not the harness.

**What this does and does not say.** It says that the F-04 defect is fixed on
that head, and that the fix removes the recorded gap: a returned `Error`, `Map`,
`Set` or byte container that carries the secret is now screened. It does not say
that F-04 is closed, and this lane does not close it: the finding is recorded
against the audited head `27f17bd55`, where it still reproduces; the reviewer's
close rule is the re-verification of the owner's fix head, and the closing
decision, routing and acceptance remain the controller's. It says nothing about a
deployed credential leak — the fix's own description says it is "not evidence of
a deployed leak and not whole-vault acceptance", and neither does this packet. The
gate in §8 that the vault rotation and restore evidence is missing is unaffected.

### 3.2 Calibration review

Root reviewed the counterevidence for the findings this revision originally stated
too strongly. Each counterevidence item was checked against the exact source before
any wording changed, and the finding was rewritten to state what the code does and
what that makes reachable — never a deployed impact the source contradicts.

| Finding | Was         | Now    | Counterevidence accepted                                                                                                                                                                                                     | Exact source checked                                                                                                                                                                                                   |
| ------- | ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01    | Critical    | Medium | The relay-client authentication obligation is documented and the adapters are opt-in; no concrete configured attacker-controlled ingress supports a deployed unauthenticated-approval claim                                  | `docs/remote-control-relay.md`; `apps/local-control-plane/src/composition.ts:152,249-250,508-512`; `apps/hosted-control-plane/src/composition.ts:164,220-223,371-375`; `packages/remote-control-relay/src/relay.ts:45` |
| F-02    | High        | Medium | `create_execution` uses the normal CommandInbox idempotency, so the generic callback-before-receipt ordering does not establish that all three processors duplicate live effects; and receipt-before-effect would be unsafe  | `apps/control-api/src/executions/execution-acceptance.service.ts:51,58`; `packages/domain/src/command-inbox.ts:53-58,684-705`; `packages/remote-control-relay/src/adapter.ts:37,79`                                    |
| F-04    | Medium-High | Low    | Ordinary thrown errors are sanitized and the Control API vault denies leases without a policy decision point, so this is a bounded library callback-result egress contract gap, not demonstrated deployed credential leakage | `packages/credential-vault/src/vault.ts:456-467,550-557`; `apps/control-api/src/cloud-composition.ts:100-104`; `packages/credential-vault/src/vault.ts:326-332`                                                        |
| F-05    | Medium-High | Medium | The Local profile binds loopback by default and the bearer credential is an owner-only file for the trusted local product, so the finding is an authorization-completeness gap                                               | `apps/local-control-plane/src/index.ts:82-88`; `apps/control-api/src/auth/private-api-authentication.ts:14-43`; `apps/control-api/src/auth/service-authentication.ts:310-313`                                          |
| F-09    | Medium      | Low    | The parent data directory is `chmod 0700` before SQLite and its WAL/SHM sidecars are created, so the sidecar mode alone does not establish that another UID can read; no supported path defeats the parent traversal control | `packages/sqlite-persistence/src/provider.ts:209-210,211,216,221`                                                                                                                                                      |
| F-03    | High        | High   | Severity unchanged; the previous revision cited a module that does not exist. The managed-Pi direct driver is `packages/managed-pi-adapter/src/index.ts:322`                                                                 | `packages/managed-pi-adapter/src/index.ts:322`; `packages/acp-adapter/src/index.ts:69`; `packages/acp-adapter/src/acp-driver-execution.ts`                                                                             |

The probe file was corrected with the findings. `CP190-P09` and `CP190-P10` named a
module that does not exist and therefore reported a missing grant check for a
missing file; they now read `packages/managed-pi-adapter/src/index.ts` and fail
loudly when a named file is missing or empty, so a nonexistent path can never be
reported as a finding. `CP190-P05` now asserts both halves of the boundary — a
returned `Error` carrier is not screened while a thrown error is sanitized to
`PROVIDER_OPERATION_FAILED`. `CP190-P13` now records the mitigating parent-directory
control next to the non-owner-only sidecar mode. `CP190-P02`, `CP190-P03` and
`CP190-P04` now carry their reachability bounds and no longer imply a deployed
unauthenticated approval path or a universal duplicate-effect path.

### 3.3 Round two — reachability traced to the authority and effect path

Every finding was traced from its public entrypoint through the authority check and
the effect, to the point where a control is actually applied. Five findings were
restated with that traced path, F-09 was split so that two different SQLite
directories are no longer described as one observation, CP190-F29 was added for the
adapter-owned directory, and five static reachability probes were added.

| Finding     | What the trace changed                                                                                                                                                                                                                                                                                                                                                                                                                   | Decisive source                                                                                                                                                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01        | The earlier wording implied a live approve, deny or cancel effect inside the Control Plane. The trace shows the opposite: the Control Plane ships **no metadata effect implementation at all** — the effect is an injected callback — and no file under `apps/` or `packages/` (outside the relay package, its tests and declarations) constructs the relay host adapter or the metadata processor, per the recursive scan in CP190-P21. | `packages/remote-control-relay/src/relay.ts:376-379`; `packages/remote-control-relay/src/adapter.ts:154-173`; `packages/remote-control-relay/src/relay.ts:45`; `apps/local-control-plane/src/composition.ts:152,249-250,508-512`; `apps/hosted-control-plane/src/composition.ts:164,220-223,371-375`                              |
| F-02        | The idempotency is not uniform across payload types. `create_execution` is idempotent in the CommandInbox because the acceptance request extends the context schema that carries `idempotencyKey`; `submit_input` carries **no** idempotency key at all; the metadata effect is an injected callback with no shipped implementation.                                                                                                     | `packages/contracts/src/control-api.ts:45,668`; `packages/remote-control-relay/src/execution.ts:38-52,209-223,260-268`; `apps/control-api/src/executions/execution-acceptance.service.ts:51,58`; `packages/domain/src/command-inbox.ts:53-58,684-705`                                                                             |
| F-03        | The direct-local bound is **operator configuration, not a grant**. The managed-Pi child runs in a per-attempt directory under the data directory and the composed spawn policy names only `allowedExecutables`, so the working-directory dimension is unconstrained; the ACP child instead runs in an operator-configured absolute directory.                                                                                            | `packages/managed-pi-adapter/src/index.ts:322`; `packages/managed-pi-adapter/src/process-client.ts:288-298`; `apps/local-control-plane/src/managed-pi-runtime.ts:66`; `apps/local-control-plane/src/index.ts:300`; `packages/deployment/src/process-runtime.ts:10`; `apps/local-control-plane/src/installed-acp-runtime.ts:88-95` |
| F-04        | A positive control the earlier revision missed: the one composed leased path **normalizes** the callback result and rejects a non-plain carrier before the vault screen can miss it. The gap is therefore confined to the two callers that return a raw result, and neither is composed.                                                                                                                                                 | `packages/model-gateway/src/selection-service.ts:269,341-380`; `packages/credential-vault/src/tool-broker.ts:91-99`; `packages/tool-execution/src/mcp-adapter.ts:257-277`; `apps/control-api/src/cloud-composition.ts:100-104`                                                                                                    |
| F-09 / F-29 | One observation was two directories. The provider creates and restricts its parent to `0700` **before** any file exists, so it has no traversal path. The pi-durable adapter creates its own directory with no mode and never restricts the database file, so its protection is inherited from an ancestor.                                                                                                                              | `packages/sqlite-persistence/src/provider.ts:209-210,211,216,221`; `packages/pi-durable-adapter/src/journal.ts:31`; `packages/pi-durable-adapter/src/lease.ts:20`; `apps/control-api/src/pi-durable/node-composition.ts:89`; `apps/control-api/src/models/production-model-composition.ts:230`                                    |

### 3.4 Detail for the findings whose severity, reachability or wording changed

**F-01 — The relay host processor applies no authentication of its own (Medium,
`configured-only`).**
The metadata command schema
(`packages/remote-control-relay/src/protocol.ts:68-81`) is a `.strict()` object with
exactly `schemaVersion, workspaceId, hostId, commandId, operation, issuedAt,
expiresAt, targetId` — no signature, MAC, nonce, sequence or key field — and
`RelayMetadataCommandProcessor.process`
(`packages/remote-control-relay/src/relay.ts:379-424`) validates only the schema, the
`hostId`/`workspaceId` equality and the time bounds before calling the injected
`accept` (`:376-379`). The obligation is documented and delegated:
`docs/remote-control-relay.md` states that metadata-only operations use a separate
strict, authenticated command schema and that "authentication of that metadata
transport remains the responsibility of the concrete relay client". The traced
reachability is what bounds this finding: the only consumer of a metadata command is
`RemoteControlHostAdapter.#pollOnce`
(`packages/remote-control-relay/src/adapter.ts:154-173`), the adapter itself is an
injected option of both compositions
(`apps/local-control-plane/src/composition.ts:249-250,508-512`,
`apps/hosted-control-plane/src/composition.ts:220-223,371-375`) reported as
`'disabled'` when absent (`:152`, `:164`), **no file scanned by CP190-P21 constructs
`RelayMetadataCommandProcessor` or `RemoteControlHostAdapter`** (a recursive scan of `apps/`
and `packages/`, excluding the relay package itself, tests and declarations; the relay
package's own `createRelayExecutionMetadataCommandProcessor` factory is the only non-test
construction and nothing scanned calls it), and the test fake `FakeOpaqueRelay` is present
(`packages/remote-control-relay/src/relay.ts:45`) while no scanned file outside the relay
package names `OutboundOpaqueRelayClient` or `FakeOpaqueRelay`. That is a textual
check: it shows the fake is present and that no scanned file names the client interface
or the fake, and it does not prove that no other, structurally conforming client
exists. Because the effect is an injected
callback, **the Control Plane ships no approve, deny or cancel effect at all** —
those are schema operation names, not shipped behaviour. An integrator must supply
the relay client, the effect and the adapter. **No deployed attacker-controlled
ingress exists, so no deployed unauthenticated approval path is claimed.** What
remains is that the processor adds no provenance check of its own.

**F-02 — The relay receipt layer adds no idempotency beyond the command identifier
(Medium, `configured-only`).**
The receipt is keyed by `commandId` and compared byte for byte
(`packages/remote-control-relay/src/relay.ts:400-409`), and the only receipt
repositories in the package are in-memory
(`packages/remote-control-relay/src/relay.ts:227,343`,
`packages/remote-control-relay/src/execution.ts:135`), while
`docs/remote-control-relay.md` already records the durable repository as a
composition requirement. The effect-before-receipt order is correct and must not be
inverted: a receipt written first would record an effect that never happened. What
the trace adds is that the durable guarantee is **not uniform across payload
types**. `create_execution` parses `ExecutionAcceptanceRequestSchema`
(`packages/remote-control-relay/src/execution.ts:209-223,260-268`), which extends
`CommandContextSchema` and therefore carries the caller's `idempotencyKey`
(`packages/contracts/src/control-api.ts:45,668`); the acceptance service then admits
it through the CommandInbox
(`apps/control-api/src/executions/execution-acceptance.service.ts:51,58`,
`packages/domain/src/command-inbox.ts:53-58,684-705`), so a redelivery is deduped
there. `submit_input` carries **no** idempotency key
(`packages/remote-control-relay/src/execution.ts:38-52`), so its dedupe must come
from the interaction domain. The metadata operations have no shipped effect at all.
So the finding is precisely: the relay's own receipt layer adds no idempotency
beyond the command identifier, the two writes are not atomic, and the durable
guarantee for the metadata and input paths is inherited from a callback and a domain
this package does not own.

**F-03 — The direct-local path never consults a grant (High, `deployed-now`).**
The grant exists only as an opaque reference plus a tri-state
(`packages/runtime-gateway-protocol/src/protocol.ts:562-567`,
`packages/acp-adapter/src/acp-gateway-types.ts:18`), and the grant checks live only in
the _gateway_ drivers
(`packages/managed-pi-adapter/src/managed-pi-gateway-driver.ts:108-120`,
`packages/acp-adapter/src/acp-gateway-driver.ts:127-139`). The direct driver is
`ManagedPiDriver` (`packages/managed-pi-adapter/src/index.ts:322`): it parses the
plan, enforces the runtime version range and the capability evaluation, and forwards
to the client, with no grant reference and no path check anywhere in it. The traced
path shows what actually bounds the child: the managed-Pi process runs with its
working directory set to a per-attempt directory under the data directory
(`apps/local-control-plane/src/managed-pi-runtime.ts:66`;
`packages/managed-pi-adapter/src/process-client.ts:288-298`), created `0700` with the
system prompt written `0600`, and the composed spawn policy names only
`allowedExecutables` (`apps/local-control-plane/src/index.ts:300`) — and
`NodeProcessSpawnPolicy` documents that "absent constraints leave the corresponding
dimension unconstrained" (`packages/deployment/src/process-runtime.ts:10`), so the
working-directory dimension is unconstrained by policy. The ACP path differs: the
child runs in the operator-configured absolute `CONTROL_PLANE_CODEX_ACP_CWD` and the
policy mirrors that directory
(`apps/local-control-plane/src/installed-acp-runtime.ts:88-95`), with absolute-path
validation as the only constraint. The only production writer of the grant state is a
hard-coded constant (`apps/runtime-gateway/src/runtime-inventory-ingestion.ts:387`)
consumed at `apps/workflow-worker/src/runtime-attempt-router.ts:179-184`. The
accurate statement is therefore that **the direct-local working directory is bounded
by operator configuration, not by a grant**, that the grant carries no path
semantics so `STA-L42-10` has nothing to attach to, and that the Control Plane
mediates no filesystem operation on the harness's behalf — the ambient-access denial
that `STA-L17-01` also requires remains a desktop-host obligation outside this
repository.

**F-04 — The returned-value screen misses non-plain carriers (Low,
`library-contract`).**
`packages/credential-vault/src/vault.ts:456-467` screens the value a leased callback
**returns** with `containsSecret`, and `containsSecret` (`:550-557`) walks own
enumerable string-keyed properties only, so a returned `Error`, `Map`, `Set` or byte
container carrying the secret is not detected. Ordinary thrown errors are already
sanitized: the `catch` at `:462-466` converts any non-`CredentialVaultError` throw
into `PROVIDER_OPERATION_FAILED`. The trace adds the control the earlier revision
missed: the one composed leased path is the model-selection service, which returns
`safeCredentialResult(await operation(secret))`
(`packages/model-gateway/src/selection-service.ts:269`), and `safeCredentialResult`
(`:341-380`) rejects any object whose prototype is not `Object.prototype` or `null`,
rejects symbol keys, rejects sparse arrays and rejects cycles — so an `Error`, a
`Map`, a `Set` or a typed array cannot survive that path. The two callers that
return the raw result are the credential broker
(`packages/credential-vault/src/tool-broker.ts:91-99`) and the MCP adapter
(`packages/tool-execution/src/mcp-adapter.ts:257-277`, which reduces thrown transport
errors to a bounded code but returns the invoke output raw); **neither is composed
into any application**, and no application composes a `VaultToolCredentialBroker`. The
composed profiles also do not lease: the Control API vault composes no policy
decision point (`apps/control-api/src/cloud-composition.ts:100-104`), so leases deny
before a secret is resolved (`packages/credential-vault/src/vault.ts:326-332`).
**No deployed credential leakage is claimed or demonstrated.**

**F-09 — SQLite sidecar modes in the provider (Low, `defense-in-depth`).**
`packages/sqlite-persistence/src/provider.ts:209-210` creates the parent directory
and `chmod`s it to `0700` **before** the database is opened at `:211` and before the
WAL pragma at `:216`; `:221` then restricts the main file to `0600`. The sidecars
therefore keep the pre-restriction mode, but **another UID cannot traverse the
`0700` parent, and no supported path defeats that control**, so the sidecar mode
alone does not establish a cross-UID read. The residual is defence in depth: the
sidecar files are not owner-only, so a later relaxation of the directory mode, a copy
of a sidecar on its own, or a backup that captures a sidecar would expose recent
writes that the `0600` main file would have protected. The adapter-owned directory is
a different observation and is reported separately as F-29.

**F-29 — The pi-durable adapter creates its own directory without an owner-only mode
(Low-Medium, `defense-in-depth`).**
`packages/pi-durable-adapter/src/journal.ts:31` and
`packages/pi-durable-adapter/src/lease.ts:20` create their directories with
`mkdirSync(..., { recursive: true })` and **no mode**, so the directory takes the
process umask default, and the database file is never `chmod`ed.
`apps/control-api/src/pi-durable/node-composition.ts:89` does the same for the
admission database. In the composed managed-cloud path an ancestor happens to be
created owner-only (`apps/control-api/src/models/production-model-composition.ts:230`),
which blocks traversal today — so the guarantee is **inherited from an unrelated
composition rather than enforced by the component that owns the data**. Any other
wiring would place a `0644` database in a `0755` directory, which is a supported
traversal path; no such wiring ships, so this is defence in depth rather than a
demonstrated cross-UID read.

**F-13 — There is no sandbox boundary in any shipped profile (High, `evidence-gap`).**
`@control-plane/sandbox` is a root dev dependency only; no application or runtime
package depends on it, and `SandboxCoordinator` appears nowhere outside the package
and its tests. The package has no `@e2b/*` dependency
(`packages/sandbox/package.json:24-27`) and only a provider-neutral contract, an
adapter over an `E2bClientPort`, and fakes. `docs/sandbox.md:12-18` already states
that the in-process network check is a precheck and that provider-level isolation is
the required enforcement boundary. `STA-L77-01` and `STA-L83-02` therefore have no
implementation to assess, and the live E2B gate stays unproven.

## 4. Reproducible regression packet

Each entry names the owner, the existing file in that owner's package where the
regression belongs, the failing condition expressed with credential-free synthetic
inputs, and the assertion the owner must add. The **proposed file** column names
where the owner would add the test; it is a proposal, not a custody claim — no
existing test file is edited by this lane, and the owner must confirm custody of
its own package before editing.

The `CP190-Pnn` identifiers are the probes in
`scripts/security-trust-boundary-probes.mjs`; running that script today prints
`26 open, 0 resolved, 0 harness failures`. Eight of the probes synthesize an
input and run the real code path, and the other eighteen read source as text;
none performs a live call, reads a credential or contacts a deployed profile. Every probe result is a **synthetic
demonstration** of a code-level property; none of them is a deployed observation,
and the report claims no deployed behaviour anywhere.

| ID                  | Owner                                                          | Proposed regression file                                                                      | Failing condition (credential-free synthetic)                                                                                                   | Assertion the owner must add                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 / P01-P02, P21 | W1                                                             | `packages/remote-control-relay/src/index.test.mjs`                                            | Submit a `RelayMetadataCommand` with only the eight schema fields and `operation: 'approve'` for a known `targetId`                             | The processor must not accept a metadata command its caller has not authenticated; a composition must refuse to start a relay adapter whose client declares no authentication                                                                                                           |
| F-02 / P03-P04, P22 | W1                                                             | `packages/remote-control-relay/src/index.test.mjs`                                            | Re-submit the same logical effect under a new `commandId`; or make the receipt store's write fail                                               | The effect and its receipt must be indivisible; a receipt-write failure must leave the effect unapplied; a receipt written before the effect is **not** an acceptable repair                                                                                                            |
| F-03 / P08-P10, P24 | W1                                                             | `packages/managed-pi-adapter/src/index.test.mjs`, `packages/acp-adapter/src/gateway.test.mjs` | Drive a direct-local dispatch with no grant, a revoked grant, and a symlinked path that escapes the grant root                                  | The direct-local driver must require a current grant and derive the working directory from it; a revoked or absent grant and an escaping symlink are rejected                                                                                                                           |
| F-04 / P05, P23     | W1 — owner fix landed on `main` at `4e126a7c3` (#1224); see §7 | `packages/credential-vault/src/index.test.mjs`                                                | Lease a credential and **return** `new Error(secret)`; separately, throw the same error                                                         | The returned-value screen must traverse `Error` message, stack and cause, `Map`, `Set`, `Buffer` and typed arrays, or reject a non-plain result; a thrown error must keep surfacing `PROVIDER_OPERATION_FAILED`; the model-selection normalizer must keep rejecting a non-plain carrier |
| F-05 / P07          | W1                                                             | `apps/control-api/src/application.test.mjs`                                                   | Call the Local API with a valid token and a foreign `workspaceId`                                                                               | The Local principal must be bound to an authorized workspace and project set and compared against the request                                                                                                                                                                           |
| F-06 / P06          | W1                                                             | `packages/telemetry/src/index.test.mjs`                                                       | `redactTelemetryValue({ sessionToken: canary })`                                                                                                | `sessionToken`, `passphrase`, `bearerToken`, `connectionString` and `apiSecret` must be redacted, or the production value-based canary guard must run at every sink                                                                                                                     |
| F-07 / P11          | W1                                                             | `apps/runtime-gateway/src/context-command-delivery.test.mjs`                                  | Enqueue a runtime command with a one-year lifetime                                                                                              | The runtime family must apply the same 24-hour bound and reject with `EXPIRY_TOO_LONG`                                                                                                                                                                                                  |
| F-08 / P12          | W1                                                             | `packages/deployment/src/checkpoint.test.mjs`                                                 | Checkpoint a data directory that contains `secrets/provider-key`                                                                                | The checkpoint must exclude or seal the secrets directory; the cleartext must not appear in the copy                                                                                                                                                                                    |
| F-09 / P13          | W1                                                             | `packages/sqlite-persistence/src/index.test.mjs`                                              | Open a provider in a 0755 directory and inspect the sidecar modes                                                                               | The `-wal` and `-shm` sidecars must be mode 0600, so the file mode does not depend on the parent directory mode                                                                                                                                                                         |
| F-10 / P14-P15      | W1                                                             | `packages/profile-portability/src/credentials.test.mjs`                                       | Import a manifest whose record value carries a secret under a non-prohibited key; export a manifest with a foreign workspace's secret reference | The import path must scan with the export's sensitive values, and secret references must carry a workspace scope                                                                                                                                                                        |
| F-11 / P16          | W1                                                             | `packages/sandbox/src/index.test.mjs`                                                         | Execute a sandbox command with `credentialBindings: [{ leaseId, environmentName: 'AWS_SESSION' }]`                                              | The ambient credential denial must apply to the effective environment including credential bindings                                                                                                                                                                                     |
| F-12 / P17          | W1                                                             | `packages/sandbox/src/index.test.mjs`                                                         | Execute a sandbox command that targets `169.254.170.2`                                                                                          | The metadata denial must cover the link-local range and the known provider endpoints                                                                                                                                                                                                    |
| F-13 / P18          | W1 + operations                                                | `packages/sandbox/src/index.test.mjs`                                                         | Compose a hosted profile                                                                                                                        | A hosted composition must resolve a sandbox provider, and a composition without one must fail closed; the live E2B template, network, resource and cleanup evidence must be attached                                                                                                    |
| F-14 / P19          | W1                                                             | `apps/control-api/src/application.test.mjs`                                                   | Send concurrent authenticated requests to the public API                                                                                        | A per-principal quota and an inbound deadline must exist; an over-quota request must get a bounded `429` without reaching the database                                                                                                                                                  |
| F-15 / P20          | W1 + deployment                                                | `apps/control-api/src/application.test.mjs`                                                   | Submit a workflow without the Restate request identity                                                                                          | The ingress submission must be authenticated, and the self-hosted ingress must bind to the private interface                                                                                                                                                                            |
| F-16                | W1                                                             | `scripts/runtime-node-identity-admin.test.mjs`                                                | Proposed evidence request, not a gate: inspect the built image manifest for the issuer CLI and key path; no key is read                         | If the image carries the issuer CLI, issuance moves to a separate operator surface; no issuer private key path is present                                                                                                                                                               |
| F-17                | W1                                                             | `apps/runtime-gateway/src/authentication.test.mjs`                                            | Present a device-signed credential with an issuer key id                                                                                        | The synthetic authority must sign with a distinct issuer key and enforce the node, workspace and generation fence                                                                                                                                                                       |
| F-18                | W1                                                             | `apps/control-api/src/pi-durable/current-tool-authority.test.mjs`                             | Submit a tool call whose grant names a tool absent from the accepted plan                                                                       | The pi-durable path must cross-check `plan.constraints.tools.grants`                                                                                                                                                                                                                    |
| F-19                | W1 + Cedar policy owner                                        | `packages/policy/src/index.test.mjs`                                                          | Compose a profile that leases a connector credential                                                                                            | A composed profile must resolve a decision point, and the permit matrix must be recorded                                                                                                                                                                                                |
| F-20                | W1                                                             | `packages/context/src/provider.test.mjs`                                                      | Admit a provider contribution whose content carries a canary                                                                                    | Provider and ProjectState content must be filtered and marked as untrusted data                                                                                                                                                                                                         |
| F-21                | W1                                                             | `packages/secrets/src/index.test.mjs`                                                         | Resolve the same reference under two different `use` contexts                                                                                   | Every provider must accept and enforce the `SecretUse` context                                                                                                                                                                                                                          |
| F-22                | W1 + desktop owner                                             | `apps/hosted-control-plane/src/index.test.mjs`                                                | Compose the hosted server profile; resolve a packaged Local handle                                                                              | The hosted server profile must resolve a credential lifecycle; packaged Local must resolve an opaque OS-secure handle                                                                                                                                                                   |
| F-23                | W1                                                             | `packages/deployment/src/process-runtime.test.mjs`                                            | Swap the allowlisted executable for a symlink after the check                                                                                   | The spawn must execute the resolved canonical path with a device and inode re-check                                                                                                                                                                                                     |
| F-24                | W1                                                             | `apps/local-control-plane/src/acp-runtime.test.mjs`                                           | Create the exported ACP factory without a spawn policy                                                                                          | The factory must require an explicit spawn policy and fail closed without it                                                                                                                                                                                                            |
| F-25                | W1                                                             | `apps/control-api/src/marketplace/registry.test.mjs`                                          | Point the marketplace registry base URL at a metadata address                                                                                   | The registry fetch must deny the link-local and metadata ranges                                                                                                                                                                                                                         |
| F-26                | W1                                                             | `packages/workflow-runtime/src/restate-endpoint.test.mjs`                                     | Deliver an interaction response from a principal outside `allowedPrincipalIds`                                                                  | The workflow ingress must re-check the responding principal before resolving                                                                                                                                                                                                            |
| F-27                | W1                                                             | `packages/database/src/tool-rate-limiter.test.mjs`                                            | Stop calling a principal, tool or operation tuple and wait out the window                                                                       | The retention sweep must remove expired `tool_rate_limit_events` rows for abandoned tuples                                                                                                                                                                                              |
| F-28                | W1 + operations                                                | `tests/railway-production-plan.test.mjs`                                                      | Proposed evidence request, not a gate: the operations owner states whether staging and production credentials are distinct                      | Distinct bucket-scoped credentials per environment, with cross-environment reads denied                                                                                                                                                                                                 |
| F-29 / P25          | W1                                                             | `packages/pi-durable-adapter/src/journal.test.mjs`                                            | Construct the adapter with a fresh directory under a 0755 parent                                                                                | The created directory must be 0700 and the database file 0600; the adapter must not inherit the guarantee from an ancestor                                                                                                                                                              |

## 5. What the audit confirmed as sound

These are recorded so the next reviewer does not re-derive them.

- **HPKE envelopes (`packages/remote-control-relay/src/crypto.ts`).** RFC 9180 Base
  mode with `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256` and `AES-128-GCM`. The AAD
  (`packages/remote-control-relay/src/protocol.ts:132-151`) binds envelope version,
  suite, key id, workspace, host, command id, payload type and schema version,
  issued and expiry times, and the content digest. Expiry is checked before
  decryption, the 1 MiB cap is exact, wrong recipient, tamper, downgrade and digest
  mismatch all fail closed, and the ciphertext cap is enforced on both sides. The
  only HPKE weakness found is the replay _window_, which is bounded by F-02, not the
  envelope itself.
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
  (42 tests, 129 assertions, re-run at this reconciliation; the file has no
  randomised seed). It covers policy denial, grant-handle
  shape, secret-file traversal and symlink escape, spawn-policy limits, object-store
  content addressing, sandbox network and metadata denial, and HPKE tamper, expiry
  and cap behaviour. It does **not** cover any of the 29 findings in §3, which is
  why the dedicated probe file was necessary.
- **Relay ordering.** The effect-before-receipt order in the relay processors is
  correct and must not be inverted: a receipt written before the effect would record
  an effect that never happened. The defect in F-02 is that the two writes are not
  atomic, not their order.
- **Relay idempotency for `create_execution`.** The acceptance request extends the
  context schema that carries `idempotencyKey`
  (`packages/contracts/src/control-api.ts:45,668`), so the caller's key reaches the
  CommandInbox (`packages/domain/src/command-inbox.ts:53-58,684-705`) and a
  redelivery is deduped there.
- **The composed leased path.** The model-selection service normalizes the leased
  callback result and rejects a non-plain carrier before the vault screen can miss
  it (`packages/model-gateway/src/selection-service.ts:269,341-380`), and thrown
  errors are already sanitized to `PROVIDER_OPERATION_FAILED`
  (`packages/credential-vault/src/vault.ts:462-466`).
- **Local SQLite file permissions.** The provider creates and restricts its parent
  directory to `0700` before the database and its sidecars exist
  (`packages/sqlite-persistence/src/provider.ts:209-210`), so there is no supported
  traversal path to the sidecars.
- **The direct-local managed-Pi working directory.** The child runs in a per-attempt
  directory created `0700` under the data directory with the system prompt written
  `0600` (`packages/managed-pi-adapter/src/process-client.ts:288-298`), and the
  harness is launched with `--no-tools --no-extensions --no-skills
  --no-context-files --no-approve`.

## 6. Targeted evidence questions

Each question is the specific external fact this lane could not establish from the
repository, with the owner who holds it. They are the fastest route to closing the
calibrated findings; none of them requires a credential.

| ID    | Finding | Question                                                                                                                                                                                                                   | Why it decides the finding                                                                                                                                                                            | Owner                                                                                |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Q-F04 | F-04    | Which profile, if any, is expected to lease a connector credential in the release candidate, and what result shapes can a tool executor return from a leased callback?                                                     | The returned-value screen only matters once a profile composes a policy decision point. The answer sets whether this is a release blocker or a library hardening item                                 | W1 (profile compositions) with the credential-vault owner                            |
| Q-F09 | F-09    | Does any supported deployment capture the SQLite `-wal` or `-shm` sidecar independently of the database file, and can the data directory mode be relaxed by configuration?                                                 | The parent is `0700` before creation, so the sidecar mode is defence in depth. It becomes material only if a backup or a configuration change separates a sidecar from its parent                     | W1 (`packages/sqlite-persistence`) with the operations owner                         |
| Q-F01 | F-01    | Which concrete relay client will be configured for a release profile, and how does that client authenticate the transport and the store it reads from?                                                                     | The documented delegation is only as strong as the concrete client. Until one is named, the host processor's missing check is a defence-in-depth gap and not a deployed path                          | W1 with the Agent HQ product relay owner                                             |
| Q-F02 | F-02    | Does the injected metadata `accept` callback provide its own idempotency for approve, deny, cancel and resume, and is the command-result repository bound to the durable persistence provider in the intended composition? | `create_execution` is already idempotent through the CommandInbox. The receipt path matters for the metadata operations, whose effect idempotency is the injected callback's property                 | W1 (`packages/remote-control-relay`)                                                 |
| Q-F03 | F-03    | Where is the `LocalProjectGrant` issued and validated on the product side, and which Control Plane component is intended to consume it for a direct-local dispatch?                                                        | The Control Plane has no grant authority of its own. The answer decides whether the fix is a grant check in the direct drivers or a different composition boundary                                    | W1 with the Agent HQ desktop owner                                                   |
| Q-F05 | F-05    | Which component is authoritative for the Local workspace and project authorization set that the private API should compare a request against?                                                                              | The hosted path compares signed claims. The Local path needs the equivalent authoritative set before the body-derived scope can be replaced                                                           | W1 (`apps/control-api` authentication) with the Agent HQ product owner               |
| Q-F13 | F-13    | Which profile is expected to compose a `SandboxProvider`, and what E2B template, network, resource and cleanup policy is the intended baseline?                                                                            | Without a composed provider there is no sandbox boundary to accept, and the live E2B gate cannot be closed                                                                                            | W1 (profile composition) with the operations owner                                   |
| Q-F20 | F-20    | Is the value-based `SecretCanaryGuard` intended to run at every content sink, and what is the authoritative protected-value set?                                                                                           | The production guard exists but has no call site, and the key-name redaction misses compound credential names. The answer decides filter placement and ownership                                      | W1 (`packages/telemetry`, `packages/events`, `packages/context`)                     |
| Q-F29 | F-29    | Which composition owns the pi-durable data directory, and is it ever created outside an owner-only ancestor?                                                                                                               | The adapter inherits the guarantee today. If a profile can point the adapter at a directory that is not inside an owner-only ancestor, the adapter-owned directory becomes a supported traversal path | W1 (`packages/pi-durable-adapter` and the `apps/control-api` pi-durable composition) |

## 7. F-04 implementation ownership — exact-path custody result

This lane does **not** own the F-04 repair and made no change to the proposed paths.
The result below is a custody _observation_, reported for root to verify and admit.

| Proposed path                                  | Purpose of the future edit                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/credential-vault/src/vault.ts`       | Extend the returned-value egress screen so it descends into `Error`, `Map`, `Set` and byte containers, or reject a non-plain result                                                                                |
| `packages/credential-vault/src/index.test.mjs` | Add the owner regression test: a leased callback that returns `new Error(secret)` must raise `SECRET_EGRESS_BLOCKED`, and a leased callback that throws must still surface the bounded `PROVIDER_OPERATION_FAILED` |

Custody check performed 2026-10-21:

- shared cross-fleet index `/tmp/opencode-three-fleet-20261020-fresh/data/cross-fleet-ownership.json`
  (SHA-256 `561ccd22bdd6d5a4abb1ebbecc489d8ee055c046074df680262547ad52784f05`): **0
  occurrences** of either proposed path, and 0 occurrences of `packages/credential-vault`
  or `credential-vault` anywhere in the index;
- all twelve open pull requests at that head (1048, 1204, 1210, 1214–1220, 1222,
  1223 — this pull request, #1220, included, because it is open): **0** touch
  either proposed path. Several branches change
  `packages/credential-vault/CHANGELOG.md` and `packages/credential-vault/package.json`
  for release metadata; none changes the two proposed source or test paths;
- every registered worktree, including the fleet and Fleet 1 checkouts: **0** dirty or
  untracked path under `packages/credential-vault`.

Result: **no exact-path owner found** for either proposed path. Absence of an
exact-path claim is **not** ownership approval. Root must verify and admit the exact
paths before any edit. This lane will not touch either path, and it will not touch
`packages/sqlite-persistence`, until that admission exists.

**The paths were subsequently admitted to an owner, and the owner fix has landed.**
The shared index now names both proposed paths as the scope of Fleet 2's F2W6
(`branch f2w6/credential-vault-f04`, base `27f17bd55`), and the fix is on `main`
at `4e126a7c3e55bfb05b8bdfc390705b83f777c6d4` (#1224), which changes
`packages/credential-vault/src/vault.ts` and adds
`packages/credential-vault/src/index.test.mjs` — the two paths this section
names. The custody observation above is therefore superseded for the purpose of
recording who owns the edit: the edit happened, on `main`, with the owner
regression test in the file this packet proposed. This lane still edits neither
path, and it did not take them: the reviewer re-verified the landed fix by
executing the probe suite on that head (§3.1a) and did not modify
`packages/credential-vault` in the repository.

The shared index this section cites has been rewritten since the audited head, so
its SHA-256 no longer matches the cited value. The re-read result is recorded in the
JSON matrix's custody block with the index's SHA-256 at that read. Like the original
search, that re-read cannot be re-verified from this repository (see §1.1).

## 8. Unresolved gates — the reasons acceptance stays held

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
7. **No targeted penetration exercise against live candidates.** This report is an
   independent read-only threat review with synthetic probes. Issue #190 also asks for
   targeted manual penetration against the managed-cloud, Local and Self-hosted
   candidates and for independent security-review evidence. It does not require the
   reviewer to be human, so an independent agent review or exercise can satisfy it, but
   this lane was not authorized to send penetration traffic to any live profile and no
   such exercise has been run.
8. **The reviewer approves none of the routed fixes.** Each routed owner must verify
   its own fix on its own exact head, and an independent reviewer must then re-verify
   it on that exact head before the finding is closed.
9. **The calibration review did not release any gate.** It narrowed five findings and
   corrected one citation. The live-profile, product-owned and penetration-review gates
   above are unchanged, so the acceptance hold is unchanged.

## 9. Routing

No source path is taken by this lane. Each finding is routed to the owner that already
holds the affected package, and the routing table is in the JSON artifact
(`findings[].routedTo`).

| Owner                                       | Findings                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 — runtime and profile composition        | F-01, F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-13, F-15, F-16, F-17, F-18, F-19, F-20, F-21, F-22, F-23, F-24, F-25, F-26, F-27, F-28, F-29 |
| W2 — policy, contracts, decision resolution | F-19 (Cedar matrix and the per-profile authorization matrix)                                                                                                           |
| W4 — coverage and runner paths              | F-27's retention-sweep coverage (the finding's package owner is W1), plus the probe-to-regression-test conversion for the packages it owns                             |
| Agent HQ / product owner                    | F-01 (the product relay's own transport authentication) and the `NONE-AHQ` controls in §8.2                                                                            |
| Operations                                  | F-13 (E2B template, network, resource and cleanup thresholds), F-14 (deployed limit values), F-28 (per-environment R2 credentials)                                     |

### 9.1 Next actions

1. Root assigns each finding to the owner above and the owner converts the
   `CP190-Pnn` probe into a regression test inside the package they own.
2. The owner records the fix head; this reviewer re-verifies each fix on that exact
   head and updates this report and the JSON matrix.
3. `scripts/security-trust-boundary-probes.mjs` must be updated in the same change as
   any fix that stops a probe from reproducing. **The probe suite is not wired
   into CI**: at the audited head the script is referenced only by its own usage
   comment, no workflow invokes it and no `package.json` script runs it, so a
   probe that stops reproducing is a **manual owner obligation**, not a
   CI-visible drift. Nothing in this packet claims CI visibility that does not
   exist.
4. The live profile evidence in §8.1–§8.6 is requested from its owner; until it
   exists, `STA-L*` rows marked open in the inventory stay open and the whole-cloud
   trust acceptance stays held.
5. The nine questions in §6 are answered by their owners; each answer either
   promotes a finding, retires it, or narrows it further.
6. F-04's repair has landed on `main` at `4e126a7c3e55bfb05b8bdfc390705b83f777c6d4`
   (#1224) and this reviewer re-verified it by execution on that exact head
   (§3.1a). The remaining act is the controller's: confirm the fix head, close
   F-04 against it, and carry the finding's status into the matrix. This lane
   still edits neither `packages/credential-vault/src/vault.ts` nor
   `packages/credential-vault/src/index.test.mjs` (see §7).
