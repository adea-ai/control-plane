import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ServicePrincipalSchema,
  type ServicePrincipal,
} from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { PiDurableAdmission } from '@control-plane/pi-durable-adapter'
import type { DelegationService } from '@control-plane/orchestration'
import { PiLeadPreparationError, type SqlitePiLeadPreparations } from './lead-preparation.js'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeStartRequestSchema,
  type RuntimeAdapter,
  type RuntimeExecutionHandle,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'

export const PI_DURABLE_LEAD_SERVICE = Symbol('PI_DURABLE_LEAD_SERVICE')
import {
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadRequestedTargetSchema,
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadPrepareResponseSchema,
  PiDurableLeadLookupRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadStatusRequestSchema,
  PiDurableLeadProgressRequestSchema,
  PiDurableLeadCancelRequestSchema,
  PiDurableLeadDispatchResponseSchema,
  PiDurableLeadStatusResponseSchema,
  PiDurableLeadProgressResponseSchema,
  PiDurableLeadCancelResponseSchema,
  PiDurableLeadCommandEnvelopeSchema as command,
  PiDurableLeadReadEnvelopeSchema as read,
} from '@control-plane/runtime-sdk'
export {
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadPrepareResponseSchema,
  PiDurableLeadPreparationSchema,
  PiDurableLeadPreparationRefSchema,
  PiDurableLeadLookupRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadRequestedTargetSchema,
  PiDurableLeadStatusRequestSchema,
  PiDurableLeadProgressRequestSchema,
  PiDurableLeadCancelRequestSchema,
  PiDurableLeadReceiptResponseSchema,
  PiDurableLeadDispatchResponseSchema,
  PiDurableLeadStatusResponseSchema,
  PiDurableLeadProgressResponseSchema,
  PiDurableLeadCancelResponseSchema,
  PiDurableLeadHttpContract,
} from '@control-plane/runtime-sdk'

const IntentId = z.uuid()
const DispatchId = z.string().regex(/^dispatch_[a-f0-9]{32}$/)

/** A trusted server resolver loads the canonical message and already admitted domain attempt. */
export interface PiDurableLeadAdmission {
  readonly schemaVersion: 'pi-lead-authority/v1'
  readonly intentId: string
  readonly workspaceId: string
  readonly allowedPrincipalIds: readonly string[]
  readonly admissionDigest: string
  readonly deadlineAt: string
  readonly admittedAttempt: {
    readonly executionId: string
    readonly attemptId: string
    readonly executionPlanId: string
    readonly executionPlanDigest: string
  }
  readonly startRequest: RuntimeStartRequest
}

/**
 * Root-approved M18.01.3 pinned-fence result: an admitted read-safe observation or
 * original-actor cancellation decision against retained revision/scope — never an
 * admission, never a dispatchable product.
 */
export interface PiDurableLeadFencedResult {
  readonly schemaVersion: 'pi-lead-fenced/v1'
  readonly kind: 'fenced'
  readonly operation: 'status' | 'progress' | 'cancel'
  readonly fenceVariant: 'v1' | 'v2'
  readonly retainedMatch: boolean
  readonly fence: {
    readonly intentId: string
    readonly workspaceId: string
    readonly fencedAt: string
    readonly reason: 'operator_intervention' | 'rollback_cohort'
    readonly actor:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'operator'; readonly operatorId: string }
    readonly authorityRevision: number
    readonly canonicalActorPrincipalId: string
    readonly scopeRef: string
    readonly allowedPrincipalIds: readonly string[]
  }
}

/** Immutable admission a retained run started from, read from the adapter journal. */
export interface RetainedLeadAdmission {
  readonly request: RuntimeStartRequest
  readonly admission: PiDurableAdmission
  readonly handle: RuntimeExecutionHandle
}

/** The Pi adapter's fence capabilities: a metadata-only retained read, and a cancel whose
 * authorization is supplied by the lead service because the prompt is withheld under a fence. */
export interface PiDurableLeadFenceAdapter {
  findRetainedAdmission(handle: RuntimeExecutionHandle): Promise<RetainedLeadAdmission | undefined>
  cancelFenced(
    handle: RuntimeExecutionHandle,
    input: { readonly idempotencyKey: string; readonly requestedAt: string },
    authorize: (retained: RetainedLeadAdmission) => Promise<void>
  ): Promise<z.output<typeof RuntimeExecutionStatusSchema>>
}

export interface PiDurableLeadFencedBindingInput {
  readonly workspaceId: string
  readonly intentId: string
  readonly principal: ServicePrincipal
  readonly operation: 'status' | 'progress' | 'cancel'
  readonly receipt: {
    readonly executionId: string
    readonly attemptId: string
    readonly startDigest: string
    readonly admissionDigest: string
    readonly deadlineAt: string
    readonly allowedPrincipalIds: readonly string[]
  }
  readonly retained: {
    readonly request: RuntimeStartRequest
    readonly admission: PiDurableAdmission
  }
}

export interface PiDurableLeadAuthority {
  resolveIntent(input: {
    readonly workspaceId: string
    readonly intentId: string
    readonly principal: ServicePrincipal
    readonly operation?: 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel'
  }): Promise<PiDurableLeadAdmission | PiDurableLeadFencedResult>
  /** Re-verifies a retained fenced run against the current fence, before and after each awaited
   * effect. Never re-reads the withheld prompt and never reserves budget or creates an attempt. */
  assertFencedBinding?(input: PiDurableLeadFencedBindingInput): Promise<void>
  /** Checks canonical audience, current accepted attempt, pinned plan, deadline and budget. */
  assertCurrent(
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal,
    operation: 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel'
  ): Promise<void>
}

const ReceiptSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-receipt/v1'),
    dispatchId: DispatchId,
    intentId: IntentId,
    workspaceId: IdentifierSchemas.workspaceId,
    admissionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    startDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    deadlineAt: z.iso.datetime(),
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    allowedPrincipalIds: z.array(z.string().min(1).max(256)).min(1).max(256),
    requestedTarget: PiDurableLeadRequestedTargetSchema.optional(),
    revision: z.number().int().positive(),
    state: z.enum(['dispatching', 'dispatched', 'reconciliation_required']),
    handle: RuntimeExecutionHandleSchema.optional(),
  })
  .strict()
export type PiDurableLeadReceipt = z.output<typeof ReceiptSchema>

export interface PiDurableLeadReceiptStore {
  get(dispatchId: string): Promise<PiDurableLeadReceipt | undefined>
  insert(receipt: PiDurableLeadReceipt): Promise<boolean>
  compareAndSet(expectedRevision: number, receipt: PiDurableLeadReceipt): Promise<boolean>
  bindCommand(key: string, digest: string): Promise<boolean>
}

/** The host supplies the persistent SQLite connection and owns closing it. */
export class SqlitePiDurableLeadReceiptStore implements PiDurableLeadReceiptStore {
  constructor(readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS pi_lead_receipts (
      dispatch_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS pi_lead_commands (key TEXT PRIMARY KEY, digest TEXT NOT NULL)`)
  }
  async get(dispatchId: string): Promise<PiDurableLeadReceipt | undefined> {
    const row = this.database
      .prepare('SELECT record FROM pi_lead_receipts WHERE dispatch_id = ?')
      .get(dispatchId)
    return row ? ReceiptSchema.parse(JSON.parse(String(row['record']))) : undefined
  }
  async insert(receipt: PiDurableLeadReceipt): Promise<boolean> {
    const value = ReceiptSchema.parse(receipt)
    return (
      this.database
        .prepare('INSERT OR IGNORE INTO pi_lead_receipts VALUES (?, ?, ?)')
        .run(value.dispatchId, value.revision, JSON.stringify(value)).changes === 1
    )
  }
  async compareAndSet(expectedRevision: number, receipt: PiDurableLeadReceipt): Promise<boolean> {
    const value = ReceiptSchema.parse(receipt)
    return (
      this.database
        .prepare(
          'UPDATE pi_lead_receipts SET revision = ?, record = ? WHERE dispatch_id = ? AND revision = ?'
        )
        .run(value.revision, JSON.stringify(value), value.dispatchId, expectedRevision).changes ===
      1
    )
  }
  async bindCommand(key: string, digest: string): Promise<boolean> {
    this.database.prepare('INSERT OR IGNORE INTO pi_lead_commands VALUES (?, ?)').run(key, digest)
    return (
      this.database.prepare('SELECT digest FROM pi_lead_commands WHERE key = ?').get(key)?.[
        'digest'
      ] === digest
    )
  }
}

export type PiDurableLeadErrorCode =
  | 'PI_LEAD_INVALID'
  | 'PI_LEAD_PROJECT_SCOPE_REQUIRED'
  | 'PI_LEAD_SCOPE_REJECTED'
  | 'PI_LEAD_WORKSPACE_SCOPE_UNSUPPORTED'
  | 'PI_LEAD_PROVIDER_READINESS_REQUIRED'
  | 'PI_LEAD_MISSING'
  | 'PI_LEAD_AUTHORITY_CONFLICT'
  | 'PI_LEAD_COMMAND_CONFLICT'
  | 'PI_LEAD_DISPATCH_CONFLICT'
  | 'PI_LEAD_DEADLINE_EXPIRED'
  | 'PI_LEAD_UNAVAILABLE'
  | 'PI_LEAD_NOT_CONFIGURED'
  | 'PI_LEAD_PREPARATION_REQUIRED'
  | 'PI_LEAD_FUNDING_CONFIRMATION_STALE'
export class PiDurableLeadError extends Error {
  constructor(readonly code: PiDurableLeadErrorCode) {
    super(code)
    this.name = 'PiDurableLeadError'
  }
}

export interface PiDurableLeadService {
  lookup(input: unknown, principal: ServicePrincipal): Promise<unknown>
  prepare(input: unknown, principal: ServicePrincipal): Promise<unknown>
  dispatch(input: unknown, principal: ServicePrincipal): Promise<unknown>
  status(input: unknown, principal: ServicePrincipal): Promise<unknown>
  progress(input: unknown, principal: ServicePrincipal): Promise<unknown>
  cancel(input: unknown, principal: ServicePrincipal): Promise<unknown>
}

export interface DurablePiDurableLeadServiceOptions {
  readonly authority: PiDurableLeadAuthority
  readonly receipts: PiDurableLeadReceiptStore
  readonly adapter: Pick<RuntimeAdapter, 'start' | 'status' | 'progress' | 'cancel'>
  /** Required to observe or cancel a retained run under a fence; absent means fail closed. */
  readonly fence?: PiDurableLeadFenceAdapter
  readonly now?: () => string
  readonly preparations?: SqlitePiLeadPreparations
  /** Canonical cascade-only child stop. The supplied service must use the admitted parent stores. */
  readonly delegationService?: Pick<DelegationService, 'cancelChildren'>
  /** Metadata-only journal read. Must never start, reconcile or invoke a provider. */
  readonly findRuntimeHandle?: (
    request: RuntimeStartRequest
  ) => Promise<RuntimeExecutionHandle | undefined>
}

export class DurablePiDurableLeadService implements PiDurableLeadService {
  readonly #now: () => string
  constructor(readonly options: DurablePiDurableLeadServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async prepare(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadPrepareRequestSchema, input)
    checkPrincipal(request, principal, 'execution:accept')
    verifyPayload(request)
    if (!this.options.preparations) fail('PI_LEAD_NOT_CONFIGURED')
    await this.#bind(request, principal)
    const admission = await this.#resolve(
      request.workspaceId,
      request.payload.intentId,
      principal,
      'prepare'
    )
    const prepared = await this.#preparationOperation(() =>
      this.options.preparations!.prepare(admission, principal)
    )
    try {
      await this.options.authority.assertCurrent(admission, principal, 'prepare')
      return PiDurableLeadPrepareResponseSchema.parse(
        success(request, {
          schemaVersion: 'pi-lead-preparation/v1',
          intentId: admission.intentId,
          executionId: admission.admittedAttempt.executionId,
          attemptId: admission.admittedAttempt.attemptId,
          selectionRef: prepared.funding.selectionRef,
          selectionRevision: prepared.funding.selectionRevision,
          ...prepared,
        })
      )
    } catch (error) {
      try {
        await this.options.preparations.rejectPreparation(prepared.preparationRef)
      } catch {
        // Release failure is retained for the recovery scanner; preserve the admission denial.
      }
      throw error
    }
  }

  async lookup(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadLookupRequestSchema, input)
    checkPrincipal(request, principal, 'execution:read')
    const dispatchId = `dispatch_${hash([request.workspaceId, request.parameters.intentId]).slice(7, 39)}`
    let receipt = await this.options.receipts.get(dispatchId)
    let admission: PiDurableLeadAdmission
    try {
      admission = await this.#resolve(
        request.workspaceId,
        request.parameters.intentId,
        principal,
        'status'
      )
    } catch (error) {
      if (!receipt && error instanceof PiDurableLeadError && error.code === 'PI_LEAD_MISSING')
        return PiDurableLeadLookupResponseSchema.parse(
          success(request, {
            schemaVersion: 'pi-lead-lookup/v1',
            workspaceId: request.workspaceId,
            intentId: request.parameters.intentId,
            receipt: null,
          })
        )
      throw error
    }
    if (receipt) {
      verifyReceipt(receipt, admission)
      if (!receipt.handle && this.options.findRuntimeHandle) {
        const handle = await this.options.findRuntimeHandle(admission.startRequest)
        await this.options.authority.assertCurrent(admission, principal, 'status')
        if (handle) {
          const verified = RuntimeExecutionHandleSchema.parse(handle)
          if (verified.attemptId !== receipt.attemptId || !verified.externalSessionId)
            fail('PI_LEAD_AUTHORITY_CONFLICT')
          const next = ReceiptSchema.parse({
            ...receipt,
            revision: receipt.revision + 1,
            state: 'dispatched',
            handle: verified,
          })
          if (await this.options.receipts.compareAndSet(receipt.revision, next)) receipt = next
          else {
            receipt = await this.options.receipts.get(dispatchId)
            if (!receipt || hash(receipt.handle) !== hash(verified))
              fail('PI_LEAD_DISPATCH_CONFLICT')
            verifyReceipt(receipt, admission)
          }
        }
      }
    }
    await this.options.authority.assertCurrent(admission, principal, 'status')
    return PiDurableLeadLookupResponseSchema.parse(
      success(request, {
        schemaVersion: 'pi-lead-lookup/v1',
        workspaceId: request.workspaceId,
        intentId: request.parameters.intentId,
        receipt: receipt
          ? {
              dispatchId: receipt.dispatchId,
              executionId: receipt.executionId,
              attemptId: receipt.attemptId,
              state: receipt.state,
              ...(receipt.handle?.externalSessionId
                ? { runtimeSessionId: receipt.handle.externalSessionId }
                : {}),
              ...(receipt.requestedTarget !== undefined
                ? { requestedTarget: receipt.requestedTarget }
                : {}),
              ...observedTarget(receipt, admission.startRequest),
            }
          : null,
      })
    )
  }

  async dispatch(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadDispatchRequestSchema, input)
    checkPrincipal(request, principal, 'execution:accept')
    verifyPayload(request)
    if (this.options.preparations)
      await this.#preparationOperation(async () =>
        this.options.preparations!.assertDispatchReference(
          request.payload.preparationRef,
          request.workspaceId,
          request.payload.intentId,
          principal
        )
      )
    // The trusted resolver can admit a canonical attempt and reserve its budget.
    // Fence the transport key atomically before entering that mutating boundary.
    await this.#bind(request, principal)
    const admission = await this.#resolve(
      request.workspaceId,
      request.payload.intentId,
      principal,
      'dispatch'
    )
    const dispatchId = `dispatch_${hash([request.workspaceId, admission.intentId]).slice(7, 39)}`
    if (this.options.preparations)
      await this.#preparationOperation(() =>
        this.options.preparations!.assertDispatch(
          request.payload.preparationRef,
          admission,
          principal
        )
      )
    // The target binds once, at dispatch where effects begin: retained
    // verbatim from the dispatch request onto the immutable receipt.
    // Redelivery names it again or conflicts at the command digest;
    // a retained target never changes under the same dispatch.
    const immutable = {
      schemaVersion: 'pi-lead-receipt/v1' as const,
      dispatchId,
      intentId: admission.intentId,
      workspaceId: request.workspaceId,
      admissionDigest: admission.admissionDigest,
      startDigest: hash(admission.startRequest),
      deadlineAt: admission.deadlineAt,
      executionId: admission.admittedAttempt.executionId,
      attemptId: admission.admittedAttempt.attemptId,
      allowedPrincipalIds: [...admission.allowedPrincipalIds],
      ...(request.payload.requestedTarget !== undefined
        ? { requestedTarget: request.payload.requestedTarget }
        : {}),
    }
    let receipt = await this.options.receipts.get(dispatchId)
    let replayed = receipt !== undefined
    if (!receipt) {
      const next = ReceiptSchema.parse({ ...immutable, revision: 1, state: 'dispatching' })
      if (await this.options.receipts.insert(next)) receipt = next
      else {
        replayed = true
        receipt = await this.options.receipts.get(dispatchId)
      }
    }
    if (!receipt) fail('PI_LEAD_DISPATCH_CONFLICT')
    verifyReceipt(receipt, admission)
    if (!receipt.handle) {
      if (Date.parse(admission.deadlineAt) <= Date.parse(this.#now()))
        fail('PI_LEAD_DEADLINE_EXPIRED')
      // A retry reacquires the SAME immutable admitted attempt. The adapter owns
      // restart reconciliation; this service never invents a replacement attempt.
      await this.options.authority.assertCurrent(admission, principal, 'dispatch')
      let dispatchClaim: string | undefined
      if (this.options.preparations)
        await this.#preparationOperation(async () => {
          await this.options.preparations!.assertDispatch(
            request.payload.preparationRef,
            admission,
            principal
          )
          // Payer disclosure may await independently of the canonical transport
          // audience. Recheck that authority before retaining the dispatch claim.
          await this.options.authority.assertCurrent(admission, principal, 'dispatch')
          dispatchClaim = this.options.preparations!.markDispatching(
            request.payload.preparationRef!
          )
        })
      let handle: RuntimeExecutionHandle
      try {
        this.options.preparations?.assertDispatchClaim(
          request.payload.preparationRef!,
          dispatchClaim
        )
        handle = RuntimeExecutionHandleSchema.parse(
          await this.options.adapter.start(admission.startRequest)
        )
        this.options.preparations?.markDispatched(
          request.payload.preparationRef!,
          dispatchClaim,
          handle
        )
      } catch {
        fail('PI_LEAD_UNAVAILABLE')
      } finally {
        this.options.preparations?.finishDispatchClaim(dispatchClaim)
      }
      if (handle.attemptId !== receipt.attemptId || !handle.externalSessionId)
        fail('PI_LEAD_AUTHORITY_CONFLICT')
      const next = ReceiptSchema.parse({
        ...receipt,
        revision: receipt.revision + 1,
        state: 'dispatched',
        handle,
      })
      if (await this.options.receipts.compareAndSet(receipt.revision, next)) receipt = next
      else {
        const winner = await this.options.receipts.get(dispatchId)
        if (!winner?.handle || hash(winner.handle) !== hash(handle))
          fail('PI_LEAD_DISPATCH_CONFLICT')
        verifyReceipt(winner, admission)
        receipt = winner
      }
    }
    await this.options.authority.assertCurrent(admission, principal, 'dispatch')
    const status = RuntimeExecutionStatusSchema.parse(
      await this.options.adapter.status(requireHandle(receipt))
    )
    verifyRuntimeHandle(receipt, status.handle)
    await this.options.authority.assertCurrent(admission, principal, 'dispatch')
    return PiDurableLeadDispatchResponseSchema.parse(
      success(request, {
        ...publicReceipt(receipt),
        ...observedTarget(receipt, admission.startRequest),
        state: status.state,
        replayed,
      })
    )
  }

  async status(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadStatusRequestSchema, input)
    checkPrincipal(request, principal, 'execution:read')
    const lookup = await this.#lookup(
      request.workspaceId,
      request.parameters.dispatchId,
      principal,
      'status'
    )
    await this.#assertCurrent(lookup, principal, 'status')
    const status = RuntimeExecutionStatusSchema.parse(
      await this.options.adapter.status(requireHandle(lookup.receipt))
    )
    verifyRuntimeHandle(lookup.receipt, status.handle)
    await this.#assertCurrent(lookup, principal, 'status')
    return PiDurableLeadStatusResponseSchema.parse(
      success(request, {
        ...publicReceipt(lookup.receipt),
        ...observedTarget(lookup.receipt, startRequestOf(lookup)),
        state: status.state,
        status,
      })
    )
  }

  async progress(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadProgressRequestSchema, input)
    checkPrincipal(request, principal, 'execution:read')
    const lookup = await this.#lookup(
      request.workspaceId,
      request.parameters.dispatchId,
      principal,
      'progress'
    )
    await this.#assertCurrent(lookup, principal, 'progress')
    const { receipt } = lookup
    const handle = requireHandle(receipt)
    const events = []
    let size = 0
    let nextSequence = request.parameters.afterSequence ?? 0
    const controller = new AbortController()
    try {
      for await (const value of this.options.adapter.progress(handle, {
        afterSequence: nextSequence,
        signal: controller.signal,
      })) {
        const event = RuntimeExecutionProgressSchema.parse(value)
        if (event.handleId !== handle.handleId || event.sequence <= nextSequence)
          fail('PI_LEAD_AUTHORITY_CONFLICT')
        size += Buffer.byteLength(JSON.stringify(event))
        if (size > 1_048_576) {
          if (events.length === 0) fail('PI_LEAD_UNAVAILABLE')
          break
        }
        events.push(event)
        nextSequence = event.sequence
        if (events.length === 256) break
      }
    } finally {
      controller.abort()
    }
    await this.#assertCurrent(lookup, principal, 'progress')
    return PiDurableLeadProgressResponseSchema.parse(
      success(request, {
        ...publicReceipt(receipt),
        ...observedTarget(receipt, startRequestOf(lookup)),
        events,
        nextSequence,
      })
    )
  }

  async cancel(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadCancelRequestSchema, input)
    checkPrincipal(request, principal, 'execution:cancel')
    verifyPayload(request)
    const lookup = await this.#lookup(
      request.workspaceId,
      request.payload.dispatchId,
      principal,
      'cancel'
    )
    const { receipt } = lookup
    await this.#bind(request, principal)
    const command = { idempotencyKey: request.idempotencyKey, requestedAt: request.issuedAt }
    let status: z.output<typeof RuntimeExecutionStatusSchema>
    if (lookup.kind === 'fenced') {
      status = await this.#fence().cancelFenced(requireHandle(receipt), command, () =>
        this.#recheckFenced(lookup, principal, 'cancel')
      )
    } else {
      await this.options.authority.assertCurrent(lookup.admission, principal, 'cancel')
      status = RuntimeExecutionStatusSchema.parse(
        await this.options.adapter.cancel(requireHandle(receipt), command)
      )
    }
    verifyRuntimeHandle(receipt, status.handle)
    // Ordinary lead-stop ends here: it never cascades to child jobs.
    // Child cancellation is a separately explicit authorized operation
    // (delegationService.cancelChildren, invoked directly with its own
    // authorization), never a lead-stop side effect — so independent
    // child work survives a normal parent stop by construction.
    await this.#assertCurrent(lookup, principal, 'cancel')
    return PiDurableLeadCancelResponseSchema.parse(
      success(request, {
        ...publicReceipt(receipt),
        ...observedTarget(receipt, startRequestOf(lookup)),
        state: status.state,
        status,
      })
    )
  }

  async #resolve(
    workspaceId: string,
    intentId: string,
    principal: ServicePrincipal,
    operation: 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel'
  ) {
    const resolved = await this.options.authority.resolveIntent({
      workspaceId,
      intentId,
      principal,
      operation,
    })
    return this.#admission(resolved, workspaceId, intentId, principal, operation)
  }

  async #admission(
    resolved: PiDurableLeadAdmission | PiDurableLeadFencedResult,
    workspaceId: string,
    intentId: string,
    principal: ServicePrincipal,
    operation: 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel'
  ) {
    if (!('schemaVersion' in resolved) || resolved.schemaVersion !== 'pi-lead-authority/v1') {
      // Prepare and dispatch are never admitted under a fence. Observation and cancel take the
      // retained-binding path in #lookup instead.
      fail('PI_LEAD_UNAVAILABLE')
    }
    const admission = structuredClone(resolved)
    const plan = assertExecutionPlanIntegrity(admission.startRequest.executionPlan)
    const request = RuntimeStartRequestSchema.parse(admission.startRequest)
    if (
      admission.schemaVersion !== 'pi-lead-authority/v1' ||
      admission.workspaceId !== workspaceId ||
      admission.intentId !== intentId ||
      plan.correlation.workspaceId !== workspaceId ||
      (plan.correlation.projectId !== undefined &&
        !principal.projectIds.includes(plan.correlation.projectId)) ||
      !admission.allowedPrincipalIds.includes(principal.principalId)
    )
      fail('PI_LEAD_SCOPE_REJECTED')
    if (
      !/^sha256:[a-f0-9]{64}$/.test(admission.admissionDigest) ||
      !z.iso.datetime().safeParse(admission.deadlineAt).success ||
      request.executionId !== admission.admittedAttempt.executionId ||
      request.attemptId !== admission.admittedAttempt.attemptId ||
      request.executionPlan.executionPlanId !== admission.admittedAttempt.executionPlanId ||
      request.executionPlan.contentDigest !== admission.admittedAttempt.executionPlanDigest ||
      !request.attemptBudget
    )
      fail('PI_LEAD_AUTHORITY_CONFLICT')
    deepFreeze(admission)
    await this.options.authority.assertCurrent(admission, principal, operation)
    return admission
  }

  async #lookup(
    workspaceId: string,
    dispatchId: string,
    principal: ServicePrincipal,
    operation: 'status' | 'progress' | 'cancel'
  ): Promise<ReceiptLookup> {
    const receipt = await this.options.receipts.get(dispatchId)
    if (!receipt) fail('PI_LEAD_MISSING')
    if (
      receipt.workspaceId !== workspaceId ||
      !receipt.allowedPrincipalIds.includes(principal.principalId)
    )
      fail('PI_LEAD_SCOPE_REJECTED')
    const resolved = await this.options.authority.resolveIntent({
      workspaceId,
      intentId: receipt.intentId,
      principal,
      operation,
    })
    if (isFencedResult(resolved)) {
      const retained = await this.#retainedBinding(receipt, resolved, principal, operation)
      return { kind: 'fenced', receipt, retained, principal, operation }
    }
    const admission = await this.#admission(
      resolved,
      workspaceId,
      receipt.intentId,
      principal,
      operation
    )
    verifyReceipt(receipt, admission)
    return { kind: 'admission', receipt, admission }
  }

  /** Verifies the original binding of a fenced receipt against its retained admission, request,
   * and handle, before any effect. Denials here carry the authority's own codes. */
  async #retainedBinding(
    receipt: PiDurableLeadReceipt,
    resolved: PiDurableLeadFencedResult,
    principal: ServicePrincipal,
    operation: 'status' | 'progress' | 'cancel'
  ): Promise<RetainedLeadAdmission> {
    if (resolved.operation !== operation) fail('PI_LEAD_UNAVAILABLE')
    const handle = requireHandle(receipt)
    const retained = await this.#fence().findRetainedAdmission(handle)
    if (!retained) fail('PI_LEAD_UNAVAILABLE')
    if (hash(retained.handle) !== hash(handle)) fail('PI_LEAD_AUTHORITY_CONFLICT')
    await this.#fencedAuthority()(fencedBinding(receipt, principal, operation, retained))
    return retained
  }

  /** Current authority for an observation or cancel, rechecked after every awaited effect. */
  async #assertCurrent(
    lookup: ReceiptLookup,
    principal: ServicePrincipal,
    operation: 'status' | 'progress' | 'cancel'
  ): Promise<void> {
    if (lookup.kind === 'admission') {
      await this.options.authority.assertCurrent(lookup.admission, principal, operation)
      return
    }
    await this.#recheckFenced(lookup, principal, operation)
  }

  async #recheckFenced(
    lookup: FencedLookup,
    principal: ServicePrincipal,
    operation: 'status' | 'progress' | 'cancel'
  ): Promise<void> {
    const handle = requireHandle(lookup.receipt)
    const fresh = await this.#fence().findRetainedAdmission(handle)
    if (!fresh || hash(fresh) !== hash(lookup.retained)) fail('PI_LEAD_AUTHORITY_CONFLICT')
    await this.#fencedAuthority()(fencedBinding(lookup.receipt, principal, operation, fresh))
  }

  #fence(): PiDurableLeadFenceAdapter {
    if (!this.options.fence) fail('PI_LEAD_UNAVAILABLE')
    return this.options.fence
  }

  #fencedAuthority(): (input: PiDurableLeadFencedBindingInput) => Promise<void> {
    const authority = this.options.authority
    if (!authority.assertFencedBinding) fail('PI_LEAD_UNAVAILABLE')
    return (input) => authority.assertFencedBinding!(input)
  }

  async #bind(request: z.output<typeof command>, principal: ServicePrincipal) {
    const key = JSON.stringify([request.workspaceId, principal.principalId, request.idempotencyKey])
    const digest = hash({
      operation: request.operation,
      payload: request.payload,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      issuedAt: request.issuedAt,
    })
    if (!(await this.options.receipts.bindCommand(key, digest))) fail('PI_LEAD_COMMAND_CONFLICT')
  }
  async #preparationOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof PiLeadPreparationError) fail(error.code)
      throw error
    }
  }
}

export class UnavailablePiDurableLeadService implements PiDurableLeadService {
  async lookup(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
  async prepare(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
  async dispatch(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
  async status(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
  async progress(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
  async cancel(): Promise<never> {
    fail('PI_LEAD_NOT_CONFIGURED')
  }
}

function parse<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const result = schema.safeParse(input)
  if (!result.success) fail('PI_LEAD_INVALID')
  return result.data
}
function checkPrincipal(
  request: z.output<typeof command> | z.output<typeof read>,
  principal: ServicePrincipal,
  scope: string
) {
  const trusted = ServicePrincipalSchema.safeParse(principal)
  if (
    !trusted.success ||
    trusted.data.principalId !== request.caller.servicePrincipalId ||
    !trusted.data.workspaceIds.includes(request.workspaceId) ||
    !trusted.data.scopes.includes(scope) ||
    (request.projectId && !trusted.data.projectIds.includes(request.projectId))
  )
    fail('PI_LEAD_SCOPE_REJECTED')
}
function verifyPayload(request: z.output<typeof command>) {
  if (hash(request.payload).slice(7) !== request.payloadHash) fail('PI_LEAD_INVALID')
}
type FencedLookup = {
  readonly kind: 'fenced'
  readonly receipt: PiDurableLeadReceipt
  readonly retained: RetainedLeadAdmission
  readonly principal: ServicePrincipal
  readonly operation: 'status' | 'progress' | 'cancel'
}
type ReceiptLookup =
  | {
      readonly kind: 'admission'
      readonly receipt: PiDurableLeadReceipt
      readonly admission: PiDurableLeadAdmission
    }
  | FencedLookup

function isFencedResult(
  value: PiDurableLeadAdmission | PiDurableLeadFencedResult
): value is PiDurableLeadFencedResult {
  return 'schemaVersion' in value && value.schemaVersion === 'pi-lead-fenced/v1'
}
function startRequestOf(lookup: ReceiptLookup): RuntimeStartRequest {
  return lookup.kind === 'admission' ? lookup.admission.startRequest : lookup.retained.request
}
function fencedBinding(
  receipt: PiDurableLeadReceipt,
  principal: ServicePrincipal,
  operation: 'status' | 'progress' | 'cancel',
  retained: RetainedLeadAdmission
): PiDurableLeadFencedBindingInput {
  return {
    workspaceId: receipt.workspaceId,
    intentId: receipt.intentId,
    principal,
    operation,
    receipt: {
      executionId: receipt.executionId,
      attemptId: receipt.attemptId,
      startDigest: receipt.startDigest,
      admissionDigest: receipt.admissionDigest,
      deadlineAt: receipt.deadlineAt,
      allowedPrincipalIds: receipt.allowedPrincipalIds,
    },
    retained: { request: retained.request, admission: retained.admission },
  }
}
function verifyReceipt(receipt: PiDurableLeadReceipt, admission: PiDurableLeadAdmission) {
  if (
    receipt.admissionDigest !== admission.admissionDigest ||
    receipt.startDigest !== hash(admission.startRequest) ||
    receipt.deadlineAt !== admission.deadlineAt ||
    receipt.executionId !== admission.admittedAttempt.executionId ||
    receipt.attemptId !== admission.admittedAttempt.attemptId ||
    hash(receipt.allowedPrincipalIds.toSorted()) !== hash(admission.allowedPrincipalIds.toSorted())
  )
    fail('PI_LEAD_AUTHORITY_CONFLICT')
}
function requireHandle(receipt: PiDurableLeadReceipt): RuntimeExecutionHandle {
  if (!receipt.handle) fail('PI_LEAD_UNAVAILABLE')
  return receipt.handle
}
function verifyRuntimeHandle(receipt: PiDurableLeadReceipt, handle: RuntimeExecutionHandle) {
  if (hash(requireHandle(receipt)) !== hash(handle)) fail('PI_LEAD_AUTHORITY_CONFLICT')
}
function publicReceipt(receipt: PiDurableLeadReceipt) {
  return {
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: receipt.dispatchId,
    intentId: receipt.intentId,
    executionId: receipt.executionId,
    attemptId: receipt.attemptId,
    runtimeSessionId: requireHandle(receipt).externalSessionId,
    ...(receipt.requestedTarget !== undefined ? { requestedTarget: receipt.requestedTarget } : {}),
  }
}
/** Server-owned execution observation for one verified receipt: the
 *  adapter-observed execution session plus the authority-resolved plan
 *  task. Both facts come from server-held records already pinned by the
 *  surrounding verifyReceipt/verifyRuntimeHandle checks — never from
 *  caller claims. Absent unless a handle with an observed session exists;
 *  generation is deliberately not emitted (no current read reports it). */
function observedTarget(
  receipt: PiDurableLeadReceipt,
  startRequest: RuntimeStartRequest
): { observedTarget: { sessionId: string; taskId: string } } | Record<string, never> {
  const sessionId = receipt.handle?.externalSessionId
  // The admission type leaves the plan loosely typed; read the correlation
  // defensively — anything but a string taskId means no observation.
  const plan = startRequest.executionPlan as { correlation?: { taskId?: unknown } } | undefined
  const taskId = plan?.correlation?.taskId
  if (typeof sessionId !== 'string' || typeof taskId !== 'string') return {}
  return { observedTarget: { sessionId, taskId } }
}
function success(request: z.output<typeof command> | z.output<typeof read>, data: unknown) {
  return {
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
    data,
  }
}
function hash(input: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(input) ?? 'null')
    .digest('hex')}`
}
function fail(code: PiDurableLeadErrorCode): never {
  throw new PiDurableLeadError(code)
}
function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  for (const item of Object.values(value)) deepFreeze(item)
  Object.freeze(value)
}
