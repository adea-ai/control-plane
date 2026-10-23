import { RuntimeAdapterError, type RuntimeCapabilityName } from '@control-plane/runtime-sdk'
import type { AcpGatewayConnectionState } from './acp-gateway-types.js'
import {
  type ExecutorQualification,
  type ExecutorQualificationEvaluator,
  type ExecutorQualificationFailure,
  type GovernedNativePath,
  type TransportState,
} from './qualification.js'

/**
 * The qualified native route (M13.03, control-plane#1021).
 *
 * `qualification.ts` decides, from trusted deployment evidence and one live
 * observation, exactly which capability claims a native ACP executor route
 * (Codex/OpenCode/Claude) may make and which governed native paths it may
 * open. This module is the call-site that gateway and session code uses: it
 * turns that evaluation into the three decisions a route must never take on
 * its own — which capabilities may be advertised, whether usage may be
 * reported, and whether a governed native effect may run.
 *
 * Every decision is fail-closed and local. An unqualified route advertises
 * nothing, reports no usage and opens no governed path, and its denial never
 * names, suggests or enables a fallback route: a native executor that is not
 * qualified is refused, not rerouted.
 *
 * It performs no I/O, starts no harness, spawns no process and holds no
 * credential. The evidence is trusted deployment configuration owned by the
 * caller, and the observation is produced by the caller from live detection.
 */

/**
 * The transport state an observation carries, mapped from the gateway's
 * connection state.
 *
 * An offline or revoked device is a LOCAL denial. The mapping never produces
 * a transport that would let the route look reachable, so no caller can turn
 * an offline device into a cloud dispatch.
 */
export function observationTransportFromConnectionState(
  state: AcpGatewayConnectionState
): TransportState {
  if (state === 'online') return 'online'
  if (state === 'revoked') return 'revoked'
  return 'offline'
}

/**
 * A local denial of a native route claim.
 *
 * `fallback` is always `'none'`: the denial names the fence that refused the
 * claim and never offers another route in its place. The typed evaluator
 * failure is carried so a caller can attribute the refusal exactly.
 */
export class NativeRouteDeniedError extends RuntimeAdapterError {
  readonly failure: ExecutorQualificationFailure | null
  readonly fallback = 'none' as const

  constructor(input: {
    readonly code: string
    readonly classification: 'unsupported' | 'unavailable'
    readonly failure: ExecutorQualificationFailure | null
  }) {
    super({
      code: input.code,
      classification: input.classification,
      message: input.code,
      retryable: false,
      details: { fallback: 'none', reason: input.failure?.reason ?? 'route_unqualified' },
    })
    this.name = 'NativeRouteDeniedError'
    this.failure = input.failure
  }
}

/** Whether one governed native path may be opened, and why not when it may not. */
export type GovernedPathDecision =
  | { readonly allowed: true; readonly path: GovernedNativePath }
  | {
      readonly allowed: false
      readonly path: GovernedNativePath
      readonly reason: 'not_evidenced' | 'controls_missing'
    }

export interface QualifiedNativeRouteOptions {
  /** The deployment's evaluator, built from trusted evidence records. */
  readonly evaluator: ExecutorQualificationEvaluator
  /** The live observation of this executor, produced by the caller. */
  readonly observation: () => unknown
}

/**
 * The qualified native route: the only source of the capability, usage and
 * governed-path claims an ACP native route may make.
 */
export class QualifiedNativeRoute {
  readonly #evaluator: ExecutorQualificationEvaluator
  readonly #observation: () => unknown

  constructor(options: QualifiedNativeRouteOptions) {
    this.#evaluator = options.evaluator
    this.#observation = options.observation
  }

  /** The evaluated qualification for the current observation. */
  evaluate(): ExecutorQualification {
    return this.#evaluator.evaluate(this.#observation())
  }

  /**
   * Exactly the capability claims the evidence allows. A claim the allow-list
   * omits — `session.resume`, `execution.cancel` and every other claim —
   * stays disabled, and an unqualified route advertises nothing at all.
   */
  advertisedCapabilities(): readonly RuntimeCapabilityName[] {
    const result = this.evaluate()
    return result.qualified ? result.capabilities : []
  }

  /** Fail-closed guard for one capability claim. */
  assertCapabilityAllowed(capability: RuntimeCapabilityName): void {
    const result = this.evaluate()
    if (!result.qualified) throw denial('ACP_NATIVE_ROUTE_UNQUALIFIED', result.failure)
    if (!result.capabilities.includes(capability))
      throw denial('ACP_NATIVE_CAPABILITY_NOT_ALLOWED', result.failure)
  }

  /**
   * Whether usage may be reported. Usage is opt-in evidence: without it the
   * route reports no usage, even when the route itself is qualified.
   */
  usageReportingEnabled(): boolean {
    const result = this.evaluate()
    return result.qualified && result.usageReporting
  }

  /**
   * Whether one governed native path (shell, network, hooks, MCP, extensions)
   * may be opened.
   *
   * A path the evidence does not name is `not_evidenced`; a path the evidence
   * names without proven pre-effect policy enforcement is `controls_missing`.
   * Both stay closed.
   */
  governedPathDecision(path: GovernedNativePath): GovernedPathDecision {
    const result = this.evaluate()
    if (result.qualified && result.governedNativePaths.includes(path))
      return { allowed: true, path }
    const disabled = result.disabledGovernedNativePaths.find((entry) => entry.path === path)
    return { allowed: false, path, reason: disabled?.reason ?? 'not_evidenced' }
  }

  /**
   * Fail-closed guard for one governed native path.
   *
   * The caller must enforce policy before the effect itself; this guard only
   * proves the path is open under the route's evidence.
   */
  assertGovernedPathAllowed(path: GovernedNativePath): void {
    const decision = this.governedPathDecision(path)
    if (!decision.allowed) throw denial('ACP_NATIVE_PATH_NOT_ALLOWED', this.evaluate().failure)
  }
}

/**
 * The denial for a native route claim.
 *
 * An offline or revoked device is reported as `unavailable`; every other
 * refusal is `unsupported`. Neither is retryable: the evaluator offers no
 * fallback route, so a retry could only repeat the same local denial.
 */
function denial(
  code: string,
  failure: ExecutorQualificationFailure | null
): NativeRouteDeniedError {
  const classification =
    failure?.reason === 'transport_offline' || failure?.reason === 'transport_revoked'
      ? 'unavailable'
      : 'unsupported'
  return new NativeRouteDeniedError({ code, classification, failure })
}
