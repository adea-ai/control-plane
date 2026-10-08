# Executor qualification integration (M13.03)

`src/qualification.ts` adds a pure, fail-closed executor qualification evaluator
(`ExecutorQualificationEvaluator`, re-exported from the package root). It turns
trusted deployment evidence into the exact capability set an ACP execution
bridge may claim for one observed native executor (Codex/OpenCode/Claude ACP
routes). **This slice does not wire the evaluator into any runtime path.** It
performs no I/O, spawns no harness, and never accepts, stores, or returns
credentials — the evidence schema has no credential fields and rejects unknown
keys.

## What the evaluator guarantees

- Fail-closed typed reasons (`ExecutorQualificationFailure`): `evidence_invalid`,
  `evidence_missing`, `evidence_expired`, `evidence_revoked`, `evidence_mismatch`
  (version, location, native-installation or configuration-digest drift, and
  codex deployment-pin drift), `auth_unsupported`, `location_unauthorized`,
  `transport_offline`, `transport_revoked`. Every failure yields empty
  capability/governed-path allow-lists and `usageReporting: false`; nothing
  defaults to permissive.
- Offline and revoked transports are local denials with `fallback: 'none'`;
  the result never suggests or enables a cloud reroute, and the denial is
  evaluated before evidence is consulted.
- Only `native_owned` authentication qualifies; credentials stay on the
  executor. `agent_hq_cloud` never qualifies a native executor route. Pi is not
  a qualifiable harness here: Pi dispatch is not native checkpointing or
  subscription entitlement.
- `session.resume`, `execution.cancel`, usage reporting and each governed
  native path (shell, network, hooks, mcp, extensions) appear only when the
  specific path is allow-listed by evidence; governed paths additionally require
  `policyEnforced: true` (pre-effect policy enforcement) in the evidence.
- The codex route must exactly match the pinned ACP build identity
  (`pinnedAcpBuild`); fixture-valued installation evidence cannot activate it.

## Call-sites later milestones must add

1. **Evidence supply (deployment configuration).** Construct one
   `ExecutorQualificationEvaluator` per deployment from trusted
   `ExecutorQualificationEvidence` records — deployment configuration only,
   never executor output or session requests — and inject a deterministic
   `now`. Records carry: harness, exact `harnessVersion`, location,
   authentication, `deploymentAuthorized`, `nativeInstallation`
   (repository/tag/commit/bundleSha256 verified at qualification time),
   `configurationDigest`, the explicit `capabilities` allow-list,
   `usageReporting`, `governedPaths` with per-path `policyEnforced`,
   `validUntil`, and optional `revokedAt`.
2. **Observation detection (executor side).** Produce the `ExecutorObservation`
   from live detection: harness identity/version, execution location,
   authentication mode, native-installation identity (for codex, the manifest
   verified by `verifyPinnedCodexNativeBinary`), a digest of the current native
   configuration (settings, hooks, MCP registrations), transport state
   (reuse `AcpGatewayConnectionState` from the gateway transport), and the
   governed paths the harness currently exposes.
3. **Gateway/session wiring.** Session and gateway code (driver state, gateway
   client capability advertisement, external-session options) must consult the
   evaluated result instead of declaring capabilities directly:
   - advertise exactly `result.capabilities` (resume, cancellation and every
     other claim absent from the allow-list stay disabled);
   - pass `usage_update`/snapshot usage through only when
     `result.usageReporting` is true;
   - permit native shell/network/hooks/MCP/extension effects only for paths in
     `result.governedNativePaths`, and enforce policy before each effect;
     `result.disabledGovernedNativePaths` names why each observed path stayed
     disabled (`not_evidenced` or `controls_missing`).
4. **Transport mapping.** Map `AcpGatewayTransport.connectionState()`
   (`online`/`offline`/`revoked`) into the observation's `transport`. An
   offline or revoked device must surface the evaluator's local denial; no
   code path may translate it into a cloud dispatch.
5. **Pin registry growth.** `pinned-codex-build.ts` currently pins only the
   codex ACP route. Before opencode/claude routes carry production evidence,
   add equally exact pinned build identities and enforce them here the same
   way the codex deployment-pin check does.

## Non-goals (unchanged by this slice)

Pi runtime, child delegation, funding/billing, `packages/runtime-sdk`, and any
gateway/session/driver behavior change. The evaluator is exercised only by
`src/qualification.test.mjs` until the call-sites above land.
