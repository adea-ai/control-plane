import { managementCanonicalRequestDigest } from './management-decision-issuer.js'

/**
 * Durable governed management caller (#932 / CP1043). This is the CP half that
 * owns the full immutable `DurableToolCallRequest`, performs repeatable
 * authority validation at the required boundaries, mints exactly one immutable
 * decision bound to the exact request digest, and makes exactly one physical
 * Adea call. The single durable effect claim lives on Adea
 * (`management_authority_consumptions`); this caller never claims, consumes an
 * approval, or retries an ambiguous effect with a fresh decision.
 */

/**
 * Opaque exact request supplied by the durable governed adapter. The caller
 * reads only the fields below; the full `DurableToolCallRequest` schema is
 * validated by the canonical authority and the Adea route.
 */
export type PiDurableManagementCallRequest = Readonly<Record<string, unknown>>

export type PiDurableManagementCallBoundary = 'admission' | 'approval' | 'effect'

export interface PiDurableManagementCallAuthority {
  /** Repeatable current-authority check; must never consume approval or mint a grant. */
  assertCurrent(
    request: PiDurableManagementCallRequest,
    boundary: PiDurableManagementCallBoundary
  ): Promise<void>
}

export interface PiDurableManagementCallDecisionInput {
  readonly request: PiDurableManagementCallRequest
  readonly targetId: string | null
}

export interface PiDurableManagementCallDecision {
  /** Signed `adea-management-authority/v1` decision. */
  readonly decision: string
  readonly decisionId: string
  /** Must equal `managementCanonicalRequestDigest(request)`. */
  readonly canonicalRequestDigest: `sha256:${string}`
  readonly expiresAt: string
}

export interface PiDurableManagementCallTransportInput {
  readonly canonicalRequest: PiDurableManagementCallRequest
  readonly decision: string
  readonly input: Readonly<Record<string, unknown>>
  readonly operation: string
  readonly targetId: string | null
  readonly workspaceId: string
}

export type PiDurableManagementCallTransportResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: string; operation: string; reason?: string }>

export type PiDurableManagementCallOutcome =
  | Readonly<{ state: 'succeeded'; value: unknown }>
  | Readonly<{ state: 'refused'; code: string; reason?: string }>
  | Readonly<{ state: 'reconciliation_required'; code: 'PI_MANAGEMENT_EFFECT_UNKNOWN' }>

export interface PiDurableManagementCallerOptions {
  readonly authority: PiDurableManagementCallAuthority
  /** Host signer path; called once per execute and only before the effect assertion. */
  issue(input: PiDurableManagementCallDecisionInput): Promise<PiDurableManagementCallDecision>
  callAdea(
    input: PiDurableManagementCallTransportInput
  ): Promise<PiDurableManagementCallTransportResult>
  /** Maps the exact retained request to the management target identity. */
  resolveTargetId(request: PiDurableManagementCallRequest): string | null
  /** True when the retained request carries an approval that must remain current. */
  requiresApproval?(request: PiDurableManagementCallRequest): boolean
}

export class PiDurableManagementCallError extends Error {
  constructor(readonly code: 'PI_MANAGEMENT_CALL_INVALID') {
    super(code)
    this.name = 'PiDurableManagementCallError'
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/

/**
 * Digest identity helper: the digest of the exact request object Adea
 * recomputes, using the same canonical JSON as the issuer and the Adea route.
 */
export function piDurableManagementRequestDigest(
  request: PiDurableManagementCallRequest
): `sha256:${string}` | null {
  return managementCanonicalRequestDigest(request)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Structural guard for the fields this adapter reads; the authority owns full schema validation. */
function parseManagementCallRequest(value: unknown): PiDurableManagementCallRequest | null {
  if (!isPlainRecord(value)) return null
  const { approval, input, operation, workspaceId } = value
  if (typeof operation !== 'string' || operation.length === 0 || operation.length > 128) return null
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 128)
    return null
  if (!isPlainRecord(input)) return null
  if (approval !== undefined && !isPlainRecord(approval)) return null
  // Retain one immutable snapshot; every boundary, the decision and the Adea
  // call observe the same exact object identity.
  return structuredClone(value)
}

function failClosed(): never {
  throw new PiDurableManagementCallError('PI_MANAGEMENT_CALL_INVALID')
}

/**
 * Creates the governed caller. One instance may be reused across calls; the
 * ambiguous-outcome fence is process-local and keyed by the exact request
 * digest so a caller retry of the same request can never resend or mint a
 * fresh decision after an unknown effect outcome.
 */
export function createPiDurableGovernedManagementCall(options: PiDurableManagementCallerOptions) {
  if (
    typeof options.authority?.assertCurrent !== 'function' ||
    typeof options.issue !== 'function' ||
    typeof options.callAdea !== 'function' ||
    typeof options.resolveTargetId !== 'function'
  )
    failClosed()
  const ambiguous = new Map<string, PiDurableManagementCallOutcome>()
  const requiresApproval =
    options.requiresApproval ?? ((request) => request['approval'] !== undefined)

  async function execute(
    input: PiDurableManagementCallRequest
  ): Promise<PiDurableManagementCallOutcome> {
    const request = parseManagementCallRequest(input)
    if (!request) failClosed()
    const requestDigest = piDurableManagementRequestDigest(request)
    if (!requestDigest || !digestPattern.test(requestDigest)) failClosed()
    const prior = ambiguous.get(requestDigest)
    if (prior) return prior

    const targetId = options.resolveTargetId(request)
    if (targetId !== null && (typeof targetId !== 'string' || targetId.length > 128)) failClosed()

    // Repeatable authority validation; none of these checks consumes an
    // approval or produces a grant.
    try {
      await options.authority.assertCurrent(request, 'admission')
      if (requiresApproval(request)) await options.authority.assertCurrent(request, 'approval')
    } catch {
      return Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
    }

    let decision: PiDurableManagementCallDecision
    try {
      decision = await options.issue({ request, targetId })
    } catch {
      return Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
    }
    if (
      typeof decision?.decision !== 'string' ||
      decision.decision.length === 0 ||
      typeof decision.decisionId !== 'string' ||
      decision.decisionId.length === 0 ||
      decision.canonicalRequestDigest !== requestDigest ||
      !digestPattern.test(decision.canonicalRequestDigest)
    )
      return Object.freeze({ code: 'authority_binding_mismatch', state: 'refused' as const })

    try {
      await options.authority.assertCurrent(request, 'effect')
    } catch {
      return Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
    }

    let result: PiDurableManagementCallTransportResult
    try {
      result = await options.callAdea({
        canonicalRequest: request,
        decision: decision.decision,
        input: request['input'] as Readonly<Record<string, unknown>>,
        operation: request['operation'] as string,
        targetId,
        workspaceId: request['workspaceId'] as string,
      })
    } catch {
      // The effect may have been applied; never resend or mint a fresh
      // decision for this exact request. Adea's durable claim remains the
      // single owner if the call did reach it.
      const unknown: PiDurableManagementCallOutcome = Object.freeze({
        code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
        state: 'reconciliation_required' as const,
      })
      ambiguous.set(requestDigest, unknown)
      return unknown
    }
    if (!result || typeof result !== 'object') {
      const unknown: PiDurableManagementCallOutcome = Object.freeze({
        code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
        state: 'reconciliation_required' as const,
      })
      ambiguous.set(requestDigest, unknown)
      return unknown
    }
    if (result.ok) return Object.freeze({ state: 'succeeded' as const, value: result.value })
    return Object.freeze({
      code: result.code,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      state: 'refused' as const,
    })
  }

  return { execute } as const
}
