# Executor qualification integration (M13.03)

`src/qualification.ts` adds a pure, fail-closed executor qualification evaluator
(`ExecutorQualificationEvaluator`, re-exported from the package root). It turns
trusted deployment evidence into the exact capability set an ACP execution
bridge may claim for one observed native executor (Codex/OpenCode/Claude ACP
routes). It performs no I/O, spawns no harness, and never accepts, stores, or
returns credentials — the evidence schema has no credential fields and rejects
unknown keys.

`src/native-route-gate.ts` (M13.03.1, issue #1021) is the runtime seam that
consumes the evaluator. The `NativeRouteGate` maps the gateway transport's
connection state onto the evaluator's transport vocabulary, evaluates the
observed route, and exposes the three decisions a runtime must consult before it
advertises or exercises a native route: the capability allow-list to advertise,
whether usage may be reported, and whether one governed native effect is
authorized. The gate is fail-closed and pure: it performs no I/O, spawns no
harness, contacts no provider, and never accepts, stores, or returns
credentials.

A driver opts in with `AcpDriverOptions.nativeRouteGate`. When the gate is
present the driver consults the evaluated result instead of declaring
capabilities and usage claims directly; when it is absent the driver's previous
behavior is unchanged. Call-sites 3 and 4 below are landed by that gate; the
evidence supply, observation detection and pin-registry growth remain with the
deployment milestone.

## What the evaluator guarantees

- Fail-closed typed reasons (`ExecutorQualificationFailure`): `evidence_invalid`,
  `evidence_missing`, `evidence_expired`, `evidence_revoked`, `evidence_mismatch`
  (version, location, native-installation or configuration-digest drift, and
  codex deployment-pin drift), `evidence_conflict` (multiple evidence records
  contending for the same route identity), `auth_unsupported`,
  `location_unauthorized`, `transport_offline`, `transport_revoked`. Every
  failure yields empty capability/governed-path allow-lists and
  `usageReporting: false`; nothing defaults to permissive.
- Evidence is selected by full route identity: authentication mode, harness
  build version, execution location, native installation and configuration
  digest must all equal the observation. Records for other routes never shadow
  a route, contending duplicates for one route deny as `evidence_conflict` in
  every array order, and when no record matches the route the typed denial is
  attributed by fixed content precedence — evidence array order never decides
  authorization.
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
- The gateway client holds every direct call to the same evidence as the
  adapter path. `session/new` (`createSession`), `session/prompt`, `snapshot`,
  `replay`, `session/resume` and `session/cancel` are each refused locally,
  before any gateway command, unless the route is qualified and its evidence
  allow-lists `session.create`, `stream.output`, `stream.events`,
  `session.history`, `session.resume` or `execution.cancel` respectively. A
  client with no `nativeRoute` is unqualified and is refused. `initialize`
  (which advertises nothing for an unqualified route), `session/list`,
  `session/close` and interaction responses are not gated.
- `createLocalAcpRuntime` and `createInstalledLocalAcpRuntime` accept an
  optional `nativeRouteGate` and hand it to the driver unchanged; they never
  construct one. Without a gate the driver is ungated as before, so the
  deployment milestone must still supply it from trusted evidence.
- The codex route must exactly match the pinned ACP build identity
  (`pinnedAcpBuild`), including the pinned `codexVersion` harness version;
  fixture-valued installation evidence and evidence/observation pairs jointly
  claiming an unpinned version cannot activate it.

## Call-sites the deployment milestone must still add

1. **Evidence supply (deployment configuration).** Construct one
   `ExecutorQualificationEvaluator` per deployment from trusted
   `ExecutorQualificationEvidence` records — deployment configuration only,
   never executor output or session requests — and inject a deterministic
   `now`. Records carry: harness, exact `harnessVersion`, location,
   authentication, `deploymentAuthorized`, `nativeInstallation`
   (repository/tag/commit/bundleSha256 verified at qualification time),
   `configurationDigest`, the explicit `capabilities` allow-list,
   `usageReporting`, `governedPaths` with per-path `policyEnforced`,
   `validUntil`, and optional `revokedAt`. Supply at most one record per route
   identity: two records contending for the same route deny every evaluation
   for that route as `evidence_conflict`.
2. **Observation detection (executor side).** Produce the `ExecutorObservation`
   from live detection: harness identity/version, execution location,
   authentication mode, native-installation identity (for codex, the manifest
   verified by `verifyPinnedCodexNativeBinary`), a digest of the current native
   configuration (settings, hooks, MCP registrations), transport state
   (reuse `AcpGatewayConnectionState` from the gateway transport), and the
   governed paths the harness currently exposes.
3. **Gateway/session wiring — LANDED in M13.03.1 (#1021).** The
   `NativeRouteGate` now advertises exactly `result.capabilities` (resume,
   cancellation and every other claim absent from the allow-list stay
   disabled), passes `usage_update` progress and observed terminal usage
   through only when `result.usageReporting` is true, and authorizes native
   shell/network/hooks/MCP/extension effects only for paths in
   `result.governedNativePaths` **and** when the runtime's own pre-effect
   policy decision allowed that effect; `result.disabledGovernedNativePaths`
   names why each observed path stayed disabled (`not_evidenced` or
   `controls_missing`). A completed result's `usage` is a mandatory part of the
   execution result contract, not a route claim; an unauthorized route cannot
   reach a completed result because the capability gate leaves it with none.
4. **Transport mapping — LANDED in M13.03.1 (#1021).** `mapNativeTransportState`
   maps `AcpGatewayTransport.connectionState()` (`online`/`offline`/`revoked`)
   into the observation's `transport`. An offline or revoked device surfaces the
   evaluator's local denial (`transport_offline` / `transport_revoked`, both
   `fallback: 'none'`); no code path may translate it into a cloud dispatch.
5. **Pin registry growth.** `pinned-codex-build.ts` currently pins only the
   codex ACP route. Before opencode/claude routes carry production evidence,
   add equally exact pinned build identities and enforce them here the same
   way the codex deployment-pin check does.

## Non-goals (unchanged by this slice)

Pi runtime, child delegation, funding/billing, `packages/runtime-sdk`, and any
gateway/session/driver behavior change beyond consulting the evaluated result.
The evaluator and the gate are exercised by `src/qualification.test.mjs` and
`src/native-route-gate.test.mjs`; no harness is spawned and no credential is
read.
