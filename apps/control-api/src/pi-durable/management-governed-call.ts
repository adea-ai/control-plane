import type { DatabaseSync } from 'node:sqlite'

import { managementCanonicalRequestDigest } from './management-decision-issuer.js'

/**
 * Durable governed management caller (#932 / CP1043).
 *
 * The replay fence is the canonical retained record keyed by the exact durable
 * tool-call identity (`workspaceId` + `idempotencyKey`, bound to the request
 * digest), not a process-local map. A single atomic claim happens BEFORE the
 * decision is minted; the exact decision is retained before dispatch; settled
 * outcomes are reused; an interrupted/unknown call stays `invoking` and yields
 * `reconciliation_required` forever (including across process restarts) with no
 * fresh decision. Adea's `management_authority_consumptions` remains the single
 * durable physical-effect claim.
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
  readonly decision: string
  readonly decisionId: string
  /** Must equal `piDurableManagementRequestDigest(request)`. */
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

/** The canonical retained effect identity. */
export interface PiDurableManagementCallRecord {
  readonly schemaVersion: 'pi-management-call-gates/v1'
  readonly key: string
  readonly requestDigest: `sha256:${string}`
  readonly revision: number
  readonly state: 'invoking' | 'settled'
  /** Retained BEFORE dispatch so a restart/duplicate can never mint a fresh one. */
  readonly decision?: string
  readonly decisionId?: string
  readonly outcome?: PiDurableManagementCallOutcome
}

/** Same atomic contract as the durable pi effect gate store. */
export interface PiDurableManagementCallStore {
  get(key: string): Promise<PiDurableManagementCallRecord | undefined>
  insert(record: PiDurableManagementCallRecord): Promise<boolean>
  compareAndSet(expectedRevision: number, record: PiDurableManagementCallRecord): Promise<boolean>
}

/** SQLite-backed store on the runtime journal database (same DB as the effect gate). */
export class SqlitePiDurableManagementCallStore implements PiDurableManagementCallStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS pi_management_call_gates (
      key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL
    )`)
  }

  async get(key: string): Promise<PiDurableManagementCallRecord | undefined> {
    const row = this.database
      .prepare('SELECT record FROM pi_management_call_gates WHERE key = ?')
      .get(key)
    return row ? (JSON.parse(String(row['record'])) as PiDurableManagementCallRecord) : undefined
  }

  async insert(record: PiDurableManagementCallRecord): Promise<boolean> {
    return (
      this.database
        .prepare('INSERT OR IGNORE INTO pi_management_call_gates VALUES (?, ?, ?)')
        .run(record.key, record.revision, JSON.stringify(record)).changes === 1
    )
  }

  async compareAndSet(
    expectedRevision: number,
    record: PiDurableManagementCallRecord
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          'UPDATE pi_management_call_gates SET revision = ?, record = ? WHERE key = ? AND revision = ?'
        )
        .run(record.revision, JSON.stringify(record), record.key, expectedRevision).changes === 1
    )
  }
}

export interface PiDurableManagementCallerOptions {
  readonly authority: PiDurableManagementCallAuthority
  /** Canonical durable retained identity. Required: there is no process-local fallback. */
  readonly store: PiDurableManagementCallStore
  /** Host signer path; called at most once per retained identity, after the atomic claim. */
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
const unknownOutcome: PiDurableManagementCallOutcome = Object.freeze({
  code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
  state: 'reconciliation_required' as const,
})

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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return Object.freeze(value)
}

/**
 * Keeps one validated immutable snapshot. Callbacks receive the same frozen
 * object across awaits; `structuredClone` alone is only a snapshot, so every
 * callback boundary recomputes the digest before dispatch as well.
 */
function parseManagementCallRequest(value: unknown): PiDurableManagementCallRequest | null {
  if (!isPlainRecord(value)) return null
  const { approval, idempotencyKey, input, operation, workspaceId } = value
  if (typeof operation !== 'string' || operation.length === 0 || operation.length > 128) return null
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 128)
    return null
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 256
  )
    return null
  if (!isPlainRecord(input)) return null
  if (approval !== undefined && !isPlainRecord(approval)) return null
  return deepFreeze(structuredClone(value))
}

function identityKey(request: PiDurableManagementCallRequest): string {
  return JSON.stringify([request['workspaceId'], request['idempotencyKey']])
}

/**
 * Creates the governed caller. The durable store is mandatory: concurrent
 * duplicates, restarts and repeats all resolve through the retained record.
 */
export function createPiDurableGovernedManagementCall(options: PiDurableManagementCallerOptions) {
  if (
    typeof options.authority?.assertCurrent !== 'function' ||
    typeof options.store?.get !== 'function' ||
    typeof options.store?.insert !== 'function' ||
    typeof options.store?.compareAndSet !== 'function' ||
    typeof options.issue !== 'function' ||
    typeof options.callAdea !== 'function' ||
    typeof options.resolveTargetId !== 'function'
  )
    failClosed()
  const requiresApproval =
    options.requiresApproval ?? ((request) => request['approval'] !== undefined)

  async function repeatableChecks(request: PiDurableManagementCallRequest): Promise<boolean> {
    try {
      await options.authority.assertCurrent(request, 'admission')
      if (requiresApproval(request)) await options.authority.assertCurrent(request, 'approval')
      return true
    } catch {
      return false
    }
  }

  async function settle(
    record: PiDurableManagementCallRecord,
    outcome: PiDurableManagementCallOutcome
  ): Promise<PiDurableManagementCallOutcome> {
    const settled: PiDurableManagementCallRecord = {
      ...record,
      outcome,
      revision: record.revision + 1,
      state: 'settled',
    }
    if (await options.store.compareAndSet(record.revision, settled)) return outcome
    const current = await options.store.get(record.key)
    return current?.state === 'settled' && current.outcome ? current.outcome : unknownOutcome
  }

  async function execute(
    input: PiDurableManagementCallRequest
  ): Promise<PiDurableManagementCallOutcome> {
    const request = parseManagementCallRequest(input)
    if (!request) failClosed()
    const requestDigest = piDurableManagementRequestDigest(request)
    if (!requestDigest || !digestPattern.test(requestDigest)) failClosed()
    const targetId = options.resolveTargetId(request)
    if (targetId !== null && (typeof targetId !== 'string' || targetId.length > 128)) failClosed()

    // Repeatable boundary checks run before any claim; they never consume
    // approval and never mint a decision.
    if (!(await repeatableChecks(request)))
      return Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })

    const key = identityKey(request)
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const record = await options.store.get(key)
      if (record && record.requestDigest !== requestDigest)
        return Object.freeze({ code: 'authority_binding_mismatch', state: 'refused' as const })
      if (record?.state === 'settled' && record.outcome) {
        // Replay keeps repeatable authority current but never re-issues or
        // re-dispatches.
        if (!(await repeatableChecks(request)))
          return Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
        return record.outcome
      }
      if (record?.state === 'invoking') return unknownOutcome
      const claim: PiDurableManagementCallRecord = {
        key,
        requestDigest,
        revision: 1,
        schemaVersion: 'pi-management-call-gates/v1',
        state: 'invoking',
      }
      if (!(await options.store.insert(claim))) continue

      // Winner: mint exactly one decision and retain it BEFORE dispatch.
      let decision: PiDurableManagementCallDecision
      try {
        decision = await options.issue({ request, targetId })
      } catch {
        return settle(
          claim,
          Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
        )
      }
      if (
        typeof decision?.decision !== 'string' ||
        decision.decision.length === 0 ||
        typeof decision.decisionId !== 'string' ||
        decision.decisionId.length === 0 ||
        decision.canonicalRequestDigest !== requestDigest ||
        !digestPattern.test(decision.canonicalRequestDigest)
      )
        return settle(
          claim,
          Object.freeze({ code: 'authority_binding_mismatch', state: 'refused' as const })
        )
      const retained: PiDurableManagementCallRecord = {
        ...claim,
        decision: decision.decision,
        decisionId: decision.decisionId,
        revision: 2,
      }
      if (!(await options.store.compareAndSet(claim.revision, retained))) continue

      try {
        await options.authority.assertCurrent(request, 'effect')
      } catch {
        return settle(
          retained,
          Object.freeze({ code: 'authority_unavailable', state: 'refused' as const })
        )
      }
      // Re-verify the exact digest at the effect boundary: the retained
      // snapshot must still be the object being dispatched.
      if (piDurableManagementRequestDigest(request) !== requestDigest)
        return settle(
          retained,
          Object.freeze({ code: 'authority_binding_mismatch', state: 'refused' as const })
        )

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
        return settle(retained, unknownOutcome)
      }
      if (!result || typeof result !== 'object') return settle(retained, unknownOutcome)
      return settle(
        retained,
        result.ok
          ? Object.freeze({ state: 'succeeded' as const, value: result.value })
          : Object.freeze({
              code: result.code,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
              state: 'refused' as const,
            })
      )
    }
    return unknownOutcome
  }

  return { execute } as const
}

function failClosed(): never {
  throw new PiDurableManagementCallError('PI_MANAGEMENT_CALL_INVALID')
}
