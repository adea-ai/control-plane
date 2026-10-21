# M13.03.1 native route qualification and pre-effect controls — 2026-10-21

## Scope and result

This record preserves the evidence for control-plane child issue
[#1021](https://github.com/adea-ai/control-plane/issues/1021) — _M13.03.1, Qualify native routes and
pre-effect controls_ — under parent
[#936](https://github.com/adea-ai/control-plane/issues/936) (M13.03) and milestone **M13 — Durable
Jobs & External Harness Bridges**.

The slice adds `packages/acp-adapter/src/native-route-gate.ts`: the runtime seam that consumes the
existing fail-closed executor qualification evaluator
(`packages/acp-adapter/src/qualification.ts`) and turns it into the three decisions a runtime must
consult before it advertises or exercises a native executor route.

Nothing here performs I/O, spawns a harness, starts a native worker, contacts a provider, reads a
credential, changes a security setting, or touches a deployment. The gate is pure and deterministic.

## Exact capability / version / auth / location evidence

The gate never widens the evidence it is given. A route qualifies only when the trusted deployment
evidence and the live observation agree on the **whole** route identity:

| Field                    | Preserved evidence                                                                                                                           | Denial when it does not hold                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Harness                  | `codex` \| `opencode` \| `claude` — Pi is not qualifiable                                                                                    | `evidence_missing` / `evidence_invalid`                                                          |
| Harness version          | exact semantic version of the observation                                                                                                    | `evidence_mismatch` / `HARNESS_VERSION_CHANGED`                                                  |
| Authentication           | `native_owned` only, so credentials stay with the executor                                                                                   | `auth_unsupported`                                                                               |
| Execution location       | `local_device` \| `remote_host`; `agent_hq_cloud` never qualifies a native executor route                                                    | `location_unauthorized`                                                                          |
| Deployment authorization | `deploymentAuthorized` must be true                                                                                                          | `location_unauthorized`                                                                          |
| Native installation      | repository, tag, commit, bundle SHA-256 must equal the observation; the codex route must equal the pinned ACP build and pinned Codex version | `evidence_mismatch` / `NATIVE_INSTALLATION_CHANGED` / `deploymentPin` / `DEPLOYMENT_PIN_CHANGED` |
| Native configuration     | SHA-256 digest of the current native configuration (settings, hooks, MCP registrations)                                                      | `evidence_mismatch` / `CONFIGURATION_DIGEST_CHANGED`                                             |
| Validity                 | `validUntil` / optional `revokedAt`                                                                                                          | `evidence_expired` / `evidence_revoked`                                                          |
| Route contention         | at most one evidence record per route identity                                                                                               | `evidence_conflict`                                                                              |
| Transport                | `online` \| `offline` \| `revoked`                                                                                                           | `transport_offline` / `transport_revoked`, both `fallback: 'none'`                               |

Evidence array order never decides authorization: the typed denial is attributed by fixed
content precedence, and contending records deny in every order.

## Fail-closed behavior for unsupported native effects

Native **shell**, **network**, **hooks**, **mcp** and **extensions** channels are authorized per
effect by `NativeRouteGate.authorizeNativeEffect`. A channel must be evidenced _and_ proven
policy-enforced in the evidence, and the runtime's own pre-effect policy decision for that effect
must have allowed it. Otherwise the effect is refused:

| Denial                 | Meaning                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `route_unqualified`    | the route itself did not qualify                                                 |
| `not_evidenced`        | the observed channel is not covered by the route's evidence                      |
| `controls_missing`     | the evidence covers the channel but does not prove pre-effect policy enforcement |
| `effect_policy_denied` | the runtime's own pre-effect policy did not allow this effect                    |

An unqualified route also yields an empty capability allow-list and `usageReporting: false`, so
`session.resume` and `execution.cancel` stay disabled unless the evidence allow-lists them, and
neither the `usage_update` progress nor the observed terminal usage is passed through.

## Runtime wiring landed by this slice

- `AcpDriverOptions.nativeRouteGate` — a driver opts in with the gate.
- `inspectDriver()` advertises exactly the qualified allow-list; without the gate the previous
  behavior is unchanged.
- `executionStatus()` passes observed terminal usage through only when the route reports usage.
- `progressUpdates()` drops the `usage_update` progress when the route does not report usage.
- A completed result's `usage` is a mandatory part of the execution result contract rather than a
  route claim; an unauthorized route cannot reach a completed result at all, because the capability
  gate leaves it with no executable capabilities.

## Checks executed

| Check                  | Command                                                              | Result                                              |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Focused suite          | `cd packages/acp-adapter && bun test src/native-route-gate.test.mjs` | **14 pass / 0 fail** / 49 expect()                  |
| Affected package suite | `cd packages/acp-adapter && bun test src`                            | **269 pass / 0 fail** / 1268 expect() / 15 files    |
| Build                  | `cd packages/acp-adapter && bun run build` (`tsc -p tsconfig.json`)  | pass                                                |
| Type-check             | `cd packages/acp-adapter && bun x tsc -p tsconfig.json --noEmit`     | pass                                                |
| Lint                   | `cd packages/acp-adapter && bun run lint` (`oxlint src`)             | pass                                                |
| Format                 | `bun run format:check` (`oxfmt --check .`)                           | pass, 1940 files                                    |
| Digest-writer guard    | `bun run check:digest-writers`                                       | pass — "39 flows matched exact reviewed exceptions" |
| Canonical ordering     | `bun run check:canonical-ordering`                                   | pass                                                |
| Workspace boundaries   | `bun run check:boundaries`                                           | pass — 1232 files in 45 packages, 0 violations      |

## Not claimed

- No runtime acceptance of any production native route is claimed. Evidence supply from deployment
  configuration and observation detection from a live executor remain with the deployment
  milestone, as do exact pinned build identities for the opencode and claude routes.
- No harness was spawned, no provider was contacted, no credential was read or written, no security
  setting was changed, no deployment was made, no test was weakened, and no merge, readiness or
  issue closure was performed by this slice.
