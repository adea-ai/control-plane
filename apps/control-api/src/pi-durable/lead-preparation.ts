import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionFundingViewSchema,
  ServicePrincipalSchema,
  type ModelSelectionFundingView,
  type ServicePrincipal,
} from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import type { PiDurableLeadAdmission } from './pi-durable-lead.service.js'

type ReadyFunding = Extract<ModelSelectionFundingView, { state: 'ready' }>
export interface PiLeadPreparationAuthority {
  /** Disclosure only; this port creates no spending capability. */
  readFunding(
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal
  ): Promise<ModelSelectionFundingView>
  /** Idempotently releases an unused allocation; must reject dispatched/in-flight attempts. */
  releaseExpired(admission: PiDurableLeadAdmission): Promise<void>
}
const Admission = z.strictObject({
  schemaVersion: z.literal('pi-lead-authority/v1'),
  intentId: z.uuid(),
  workspaceId: IdentifierSchemas.workspaceId,
  allowedPrincipalIds: z.array(z.string().min(1).max(256)).min(1).max(256),
  admissionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  deadlineAt: z.iso.datetime(),
  admittedAttempt: z.strictObject({
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    executionPlanId: IdentifierSchemas.executionPlanId,
    executionPlanDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  startRequest: RuntimeStartRequestSchema,
})
const Record = z.strictObject({
  preparationRef: z.string().regex(/^prep_[a-f0-9]{32}$/),
  admission: Admission,
  principalId: ServicePrincipalSchema.shape.principalId,
  funding: ModelSelectionFundingViewSchema.optional(),
  expiresAt: z.iso.datetime(),
  state: z.enum([
    'preparing',
    'prepared',
    'dispatched',
    'release_pending',
    'released',
    'superseded',
  ]),
})
type Preparation = z.output<typeof Record>
export class PiLeadPreparationError extends Error {
  constructor(
    readonly code: 'PI_LEAD_PREPARATION_REQUIRED' | 'PI_LEAD_FUNDING_CONFIRMATION_STALE'
  ) {
    super(code)
  }
}

/** The host runs recovery at startup and periodically. Retain allocation cleanup
 * intent before asynchronous funding lookup; this store never admits spending.
 */
export class SqlitePiLeadPreparations {
  constructor(
    readonly database: DatabaseSync,
    readonly authority: PiLeadPreparationAuthority,
    readonly now: () => string = () => new Date().toISOString()
  ) {
    if (
      typeof authority?.readFunding !== 'function' ||
      typeof authority?.releaseExpired !== 'function'
    )
      this.#stale()
    database.exec(
      'CREATE TABLE IF NOT EXISTS pi_lead_preparations (preparation_ref TEXT PRIMARY KEY, record TEXT NOT NULL)'
    )
  }
  async prepare(input: PiDurableLeadAdmission, principalInput: ServicePrincipal) {
    const admission = this.#admission(input)
    const principal = ServicePrincipalSchema.parse(principalInput)
    if (
      !admission.allowedPrincipalIds.includes(principal.principalId) ||
      !principal.workspaceIds.includes(admission.workspaceId)
    )
      this.#stale()
    const provisional: Preparation = {
      preparationRef: `prep_${randomUUID().replaceAll('-', '')}`,
      admission,
      principalId: principal.principalId,
      expiresAt: new Date(
        Math.min(Date.parse(admission.deadlineAt), this.#at() + 300_000)
      ).toISOString(),
      state: 'preparing',
    }
    // No awaited callback before this receipt. Concurrent preparation fails
    // boundedly and can retry the same canonical attempt, without allocating again.
    const existing = this.#transaction(() => {
      let retained: Preparation | undefined
      for (const prior of this.#all()) {
        if (!sameAttempt(prior.admission, admission)) continue
        if (
          ['preparing', 'dispatched', 'release_pending', 'released'].includes(prior.state) ||
          (prior.state === 'prepared' && Date.parse(prior.expiresAt) <= this.#at())
        )
          this.#stale()
        if (prior.state === 'prepared') {
          if (retained) this.#stale()
          retained = prior
        }
      }
      if (retained) return retained
      this.#insert(provisional)
      return undefined
    })
    // An accepted attempt has one immutable funding winner. Re-display can
    // replay that winner, but cannot overwrite it or renew its allocation TTL.
    if (existing) {
      try {
        const funding = this.#ready(
          await this.authority.readFunding(structuredClone(admission), principal),
          admission
        )
        const retained = this.#dispatchable(existing.preparationRef, admission, principal)
        if (digest(funding) !== digest(existing.funding) || digest(retained) !== digest(existing))
          this.#stale()
        return {
          preparationRef: retained.preparationRef,
          funding: structuredClone(funding),
          expiresAt: retained.expiresAt,
          replayed: true,
        }
      } catch {
        this.#stale()
      }
    }
    try {
      if (Date.parse(provisional.expiresAt) <= this.#at()) this.#stale()
      const funding = this.#ready(
        await this.authority.readFunding(structuredClone(admission), principal),
        admission
      )
      const preparationRef = `prep_${digest([admission.admissionDigest, principal.principalId, funding]).slice(0, 32)}`
      return this.#transaction(() => {
        const current = this.#get(provisional.preparationRef)
        if (
          !current ||
          current.state !== 'preparing' ||
          Date.parse(current.expiresAt) <= this.#at()
        )
          this.#stale()
        if (this.#get(preparationRef)) this.#stale()
        const expires = Math.min(Date.parse(current.expiresAt), Date.parse(funding.expiresAt))
        if (expires <= this.#at()) this.#stale()
        const next: Preparation = {
          preparationRef,
          admission,
          principalId: principal.principalId,
          funding,
          expiresAt: new Date(expires).toISOString(),
          state: 'prepared',
        }
        this.#insert(next)
        this.#replace(current, { ...current, state: 'superseded' })
        return {
          preparationRef,
          funding: structuredClone(funding),
          expiresAt: next.expiresAt,
          replayed: false,
        }
      })
    } catch {
      // Never retain callback diagnostics. Cleanup failure keeps release_pending.
      const current = this.#get(provisional.preparationRef)
      if (current?.state === 'preparing')
        this.#compare(current, { ...current, state: 'release_pending' })
      try {
        await this.recoverExpired()
      } catch {
        /* Startup/periodic recovery retries retained evidence. */
      }
      this.#stale()
    }
  }
  async assertDispatch(
    preparationRef: string | undefined,
    input: PiDurableLeadAdmission,
    principal: ServicePrincipal
  ): Promise<void> {
    if (!preparationRef) throw new PiLeadPreparationError('PI_LEAD_PREPARATION_REQUIRED')
    try {
      const admission = this.#admission(input)
      const stored = this.#dispatchable(preparationRef, admission, principal)
      const current = this.#ready(
        await this.authority.readFunding(structuredClone(admission), principal),
        admission
      )
      if (digest(current) !== digest(stored.funding)) this.#stale()
      // Funding may await a refresh, expiry scanner or another dispatcher.
      const retained = this.#dispatchable(preparationRef, admission, principal)
      if (digest(retained) !== digest(stored)) this.#stale()
    } catch {
      this.#stale()
    }
  }
  /** Persist before RuntimeAdapter.start; atomic with expiry/rejection claims. */
  markDispatching(preparationRef: string): void {
    this.#transaction(() => {
      const stored = this.#get(preparationRef)
      if (!stored || !['prepared', 'dispatched'].includes(stored.state)) this.#stale()
      this.#assertAttemptFence(stored)
      if (stored.state === 'prepared') {
        if (Date.parse(stored.expiresAt) <= this.#at()) this.#stale()
        this.#replace(stored, { ...stored, state: 'dispatched' })
      }
    })
  }
  /** Rejected publication/current authority claims cleanup; dispatched is final. */
  async rejectPreparation(preparationRef: string): Promise<void> {
    this.#transaction(() => {
      const current = this.#get(preparationRef)
      if (!current || ['dispatched', 'released', 'superseded'].includes(current.state)) return
      this.#assertAttemptFence(current)
      if (current.state !== 'release_pending')
        this.#replace(current, { ...current, state: 'release_pending' })
    })
    await this.recoverExpired()
  }
  /** Any validated receipt owns cleanup/finality for this intent, including a released receipt. */
  hasIntent(intentId: string): boolean {
    const id = z.uuid().parse(intentId)
    return this.#all().some((record) => record.admission.intentId === id)
  }
  async recoverExpired(): Promise<void> {
    // Validate every record before invoking any host callback.
    const records = this.#all()
    let failed = false
    for (const stored of records) {
      if (
        stored.state !== 'release_pending' &&
        (!['preparing', 'prepared'].includes(stored.state) ||
          Date.parse(stored.expiresAt) > this.#at())
      )
        continue
      const pending = this.#transaction(() => {
        const current = this.#get(stored.preparationRef)
        if (!current || digest(current) !== digest(stored)) return undefined
        this.#assertAttemptFence(current)
        const next: Preparation = { ...current, state: 'release_pending' }
        if (current.state !== 'release_pending') this.#replace(current, next)
        return next
      })
      if (!pending) continue
      try {
        await this.authority.releaseExpired(structuredClone(pending.admission))
        this.#compare(pending, { ...pending, state: 'released' })
      } catch {
        failed = true
      }
    }
    if (failed) this.#stale()
  }
  #dispatchable(
    ref: string,
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal
  ): Preparation {
    const stored = this.#get(ref)
    if (
      !stored ||
      !['prepared', 'dispatched'].includes(stored.state) ||
      stored.principalId !== principal.principalId ||
      digest(stored.admission) !== digest(admission) ||
      (stored.state === 'prepared' && Date.parse(stored.expiresAt) <= this.#at())
    )
      this.#stale()
    this.#assertAttemptFence(stored)
    return stored
  }
  #assertAttemptFence(stored: Preparation): void {
    for (const other of this.#all()) {
      if (
        other.preparationRef !== stored.preparationRef &&
        sameAttempt(other.admission, stored.admission) &&
        ['preparing', 'prepared', 'dispatched', 'release_pending', 'released'].includes(other.state)
      )
        this.#stale()
    }
  }
  #ready(value: ModelSelectionFundingView, admission: PiDurableLeadAdmission): ReadyFunding {
    const parsed = ModelSelectionFundingViewSchema.safeParse(value)
    if (
      !parsed.success ||
      parsed.data.state !== 'ready' ||
      parsed.data.workspaceId !== admission.workspaceId ||
      parsed.data.executionId !== admission.admittedAttempt.executionId ||
      parsed.data.attemptId !== admission.admittedAttempt.attemptId ||
      Date.parse(parsed.data.expiresAt) <= this.#at()
    )
      this.#stale()
    return parsed.data
  }
  #admission(value: unknown): z.output<typeof Admission> {
    try {
      const admission = Admission.parse(value)
      const plan = assertExecutionPlanIntegrity(admission.startRequest.executionPlan)
      const { admittedAttempt: attempt, startRequest: request } = admission
      if (
        !request.attemptBudget ||
        request.attemptBudget.workspaceId !== admission.workspaceId ||
        plan.correlation.workspaceId !== admission.workspaceId ||
        request.executionId !== attempt.executionId ||
        request.attemptId !== attempt.attemptId ||
        plan.executionPlanId !== attempt.executionPlanId ||
        plan.contentDigest !== attempt.executionPlanDigest
      )
        this.#stale()
      return admission
    } catch {
      this.#stale()
    }
  }
  #parse(raw: unknown, ref: unknown): Preparation {
    try {
      const record = Record.parse(JSON.parse(String(raw)))
      this.#admission(record.admission)
      if (
        record.preparationRef !== ref ||
        !record.admission.allowedPrincipalIds.includes(record.principalId) ||
        Date.parse(record.expiresAt) > Date.parse(record.admission.deadlineAt)
      )
        this.#stale()
      if (record.funding) {
        const funding = record.funding
        if (
          funding.state !== 'ready' ||
          funding.workspaceId !== record.admission.workspaceId ||
          funding.executionId !== record.admission.admittedAttempt.executionId ||
          funding.attemptId !== record.admission.admittedAttempt.attemptId ||
          Date.parse(record.expiresAt) > Date.parse(funding.expiresAt) ||
          record.preparationRef !==
            `prep_${digest([record.admission.admissionDigest, record.principalId, funding]).slice(0, 32)}`
        )
          this.#stale()
      } else if (['prepared', 'dispatched'].includes(record.state)) this.#stale()
      return record
    } catch {
      this.#stale()
    }
  }
  #get(ref: string): Preparation | undefined {
    const row = this.database
      .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref = ?')
      .get(ref)
    return row ? this.#parse(row['record'], ref) : undefined
  }
  #all(): Preparation[] {
    return this.database
      .prepare('SELECT preparation_ref, record FROM pi_lead_preparations')
      .all()
      .map((row) => this.#parse(row['record'], row['preparation_ref']))
  }
  #insert(value: Preparation): void {
    const parsed = this.#parse(JSON.stringify(value), value.preparationRef)
    this.database
      .prepare('INSERT INTO pi_lead_preparations VALUES (?, ?)')
      .run(parsed.preparationRef, JSON.stringify(parsed))
  }
  #replace(prior: Preparation, next: Preparation): void {
    if (!this.#compare(prior, next)) this.#stale()
  }
  #compare(prior: Preparation, next: Preparation): boolean {
    const parsed = this.#parse(JSON.stringify(next), next.preparationRef)
    const row = this.database
      .prepare('SELECT record FROM pi_lead_preparations WHERE preparation_ref = ?')
      .get(prior.preparationRef)
    if (!row || digest(this.#parse(row['record'], prior.preparationRef)) !== digest(prior))
      return false
    return (
      this.database
        .prepare(
          'UPDATE pi_lead_preparations SET record = ? WHERE preparation_ref = ? AND record = ?'
        )
        .run(JSON.stringify(parsed), prior.preparationRef, String(row['record'])).changes === 1
    )
  }
  #transaction<Result>(operation: () => Result): Result {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
  #at(): number {
    const at = Date.parse(this.now())
    if (!Number.isFinite(at)) this.#stale()
    return at
  }
  #stale(): never {
    throw new PiLeadPreparationError('PI_LEAD_FUNDING_CONFIRMATION_STALE')
  }
}
function sameAttempt(a: PiDurableLeadAdmission, b: PiDurableLeadAdmission): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.admittedAttempt.executionId === b.admittedAttempt.executionId &&
    a.admittedAttempt.attemptId === b.admittedAttempt.attemptId
  )
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')
}
