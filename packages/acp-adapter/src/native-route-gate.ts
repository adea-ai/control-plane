import type { RuntimeCapabilityName } from '@control-plane/runtime-sdk'
import {
  ExecutorQualificationEvaluator,
  type ExecutorObservation,
  type ExecutorQualification,
  type ExecutorQualificationFailure,
  type GovernedNativePath,
  type TransportState,
} from './qualification.js'
import type { AcpGatewayConnectionState } from './acp-gateway-types.js'

/**
 * Native route gate (M13.03.1 — issue #1021).
 *
 * The executor qualification evaluator answers one question: may this
 * deployment claim capabilities for one observed native executor route? This
 * module turns that answer into the three decisions a runtime must consult
 * before it advertises or exercises a native route, and it is the enforcement
 * point for pre-effect policy on governed native channels.
 *
 * It is pure and fail-closed: it performs no I/O, spawns no harness, contacts
 * no provider, and never accepts, stores, or returns credentials. When the
 * route is not qualified every capability, every usage claim and every
 * governed native path stays disabled — nothing defaults to permissive.
 */

/**
 * Maps the gateway transport's connection state onto the evaluator's transport
 * vocabulary. `offline` and `revoked` are local denials; the gate never
 * translates either into a cloud dispatch.
 */
export function mapNativeTransportState(
  connectionState: AcpGatewayConnectionState
): TransportState {
  switch (connectionState) {
    case 'online':
      return 'online'
    case 'offline':
      return 'offline'
    case 'revoked':
      return 'revoked'
  }
}

/**
 * The pre-effect policy outcome the runtime supplies for one native effect.
 * The gate authorizes a governed channel only when the route qualified it AND
 * the runtime's own policy check for that effect passed.
 */
export interface NativeEffectPolicy {
  /** True only when policy was enforced for this specific effect before it ran. */
  readonly policyEnforced: boolean
  /** True only when the policy decision permitted this specific effect. */
  readonly allowed: boolean
}

/** Typed reasons a governed native effect is refused. */
export type NativeEffectDenialReason =
  | 'route_unqualified'
  | 'not_evidenced'
  | 'controls_missing'
  | 'effect_policy_denied'

export interface NativeEffectAuthorization {
  readonly allowed: boolean
  readonly reason: NativeEffectDenialReason | null
  readonly failure: ExecutorQualificationFailure | null
}

const denied = (
  reason: NativeEffectDenialReason,
  failure: ExecutorQualificationFailure | null
): NativeEffectAuthorization => ({ allowed: false, reason, failure })

export interface NativeRouteGateOptions {
  /** Trusted deployment evidence evaluator; constructed from deployment configuration. */
  readonly evaluator: ExecutorQualificationEvaluator
  /** Live executor observation. Never trusted on its own — it is compared against the evidence. */
  readonly observation: ExecutorObservation
}

/**
 * Fail-closed gate over one observed native executor route. Every decision it
 * exposes is derived from the evaluated qualification, so an unqualified,
 * expired, revoked, drifted, conflicting, offline or unauthorized route yields
 * no capabilities, no usage claims and no governed native paths.
 */
export class NativeRouteGate {
  readonly #evaluator: ExecutorQualificationEvaluator
  readonly #observation: ExecutorObservation

  constructor(options: NativeRouteGateOptions) {
    this.#evaluator = options.evaluator
    this.#observation = options.observation
  }

  /** The evaluated qualification for the observed route. Re-evaluated per call so expiry is time-correct. */
  evaluate(): ExecutorQualification {
    return this.#evaluator.evaluate(this.#observation)
  }

  get qualified(): boolean {
    return this.evaluate().qualified
  }

  get failure(): ExecutorQualificationFailure | null {
    return this.evaluate().failure
  }

  /**
   * Exactly the evidenced capability allow-list. Absent names stay disabled:
   * an unqualified route yields an empty list, and a route whose evidence does
   * not list `session.resume` or `execution.cancel` never advertises them.
   */
  get capabilities(): readonly RuntimeCapabilityName[] {
    const result = this.evaluate()
    return result.qualified ? result.capabilities : []
  }

  /** True only when the qualified route's evidence allow-lists this capability. */
  supports(name: RuntimeCapabilityName): boolean {
    return this.capabilities.includes(name)
  }

  /** Usage reporting is opt-in evidence and stays disabled on an unqualified route. */
  get usageReporting(): boolean {
    return this.evaluate().usageReporting
  }

  /** Governed native channels the qualified route may use; each is already proven policy-enforced by the evidence. */
  get governedNativePaths(): readonly GovernedNativePath[] {
    const result = this.evaluate()
    return result.qualified ? result.governedNativePaths : []
  }

  /**
   * Authorize one native effect on a governed channel (shell, network, hooks,
   * mcp, extensions). Deny by default: the route must qualify, the channel
   * must be evidenced, the evidence must prove pre-effect policy enforcement,
   * and the runtime's own policy decision for this effect must have allowed it.
   */
  authorizeNativeEffect(
    path: GovernedNativePath,
    policy: NativeEffectPolicy
  ): NativeEffectAuthorization {
    const result = this.evaluate()
    if (!result.qualified) {
      return denied('route_unqualified', result.failure)
    }
    if (!result.governedNativePaths.includes(path)) {
      const disabled = result.disabledGovernedNativePaths.find((entry) => entry.path === path)
      return denied(disabled?.reason ?? 'not_evidenced', null)
    }
    if (!policy.policyEnforced || !policy.allowed) {
      return denied('effect_policy_denied', null)
    }
    return { allowed: true, reason: null, failure: null }
  }
}
