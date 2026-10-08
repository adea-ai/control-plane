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
  PiDurableLeadDispatchRequestSchema,
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

export interface PiDurableLeadAuthority {
  resolveIntent(input: {
    readonly workspaceId: string
    readonly intentId: string
    readonly principal: ServicePrincipal
    readonly operation?: 'dispatch' | 'status' | 'progress' | 'cancel'
  }): Promise<PiDurableLeadAdmission>
  /** Checks canonical audience, current accepted attempt, pinned plan, deadline and budget. */
  assertCurrent(
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal,
    operation: 'dispatch' | 'status' | 'progress' | 'cancel'
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
  | 'PI_LEAD_MISSING'
  | 'PI_LEAD_AUTHORITY_CONFLICT'
  | 'PI_LEAD_COMMAND_CONFLICT'
  | 'PI_LEAD_DISPATCH_CONFLICT'
  | 'PI_LEAD_DEADLINE_EXPIRED'
  | 'PI_LEAD_UNAVAILABLE'
  | 'PI_LEAD_NOT_CONFIGURED'
export class PiDurableLeadError extends Error {
  constructor(readonly code: PiDurableLeadErrorCode) {
    super(code)
    this.name = 'PiDurableLeadError'
  }
}

export interface PiDurableLeadService {
  dispatch(input: unknown, principal: ServicePrincipal): Promise<unknown>
  status(input: unknown, principal: ServicePrincipal): Promise<unknown>
  progress(input: unknown, principal: ServicePrincipal): Promise<unknown>
  cancel(input: unknown, principal: ServicePrincipal): Promise<unknown>
}

export interface DurablePiDurableLeadServiceOptions {
  readonly authority: PiDurableLeadAuthority
  readonly receipts: PiDurableLeadReceiptStore
  readonly adapter: Pick<RuntimeAdapter, 'start' | 'status' | 'progress' | 'cancel'>
  readonly now?: () => string
}

export class DurablePiDurableLeadService implements PiDurableLeadService {
  readonly #now: () => string
  constructor(readonly options: DurablePiDurableLeadServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async dispatch(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadDispatchRequestSchema, input)
    checkPrincipal(request, principal, 'execution:accept')
    verifyPayload(request)
    const admission = await this.#resolve(
      request.workspaceId,
      request.payload.intentId,
      principal,
      'dispatch'
    )
    const dispatchId = `dispatch_${hash([request.workspaceId, admission.intentId]).slice(7, 39)}`
    await this.#bind(request, principal)
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
      let handle: RuntimeExecutionHandle
      try {
        handle = RuntimeExecutionHandleSchema.parse(
          await this.options.adapter.start(admission.startRequest)
        )
      } catch {
        fail('PI_LEAD_UNAVAILABLE')
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
      success(request, { ...publicReceipt(receipt), state: status.state, replayed })
    )
  }

  async status(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadStatusRequestSchema, input)
    checkPrincipal(request, principal, 'execution:read')
    const { receipt, admission } = await this.#lookup(
      request.workspaceId,
      request.parameters.dispatchId,
      principal,
      'status'
    )
    await this.options.authority.assertCurrent(admission, principal, 'status')
    const status = RuntimeExecutionStatusSchema.parse(
      await this.options.adapter.status(requireHandle(receipt))
    )
    verifyRuntimeHandle(receipt, status.handle)
    await this.options.authority.assertCurrent(admission, principal, 'status')
    return PiDurableLeadStatusResponseSchema.parse(
      success(request, { ...publicReceipt(receipt), state: status.state, status })
    )
  }

  async progress(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadProgressRequestSchema, input)
    checkPrincipal(request, principal, 'execution:read')
    const { receipt, admission } = await this.#lookup(
      request.workspaceId,
      request.parameters.dispatchId,
      principal,
      'progress'
    )
    await this.options.authority.assertCurrent(admission, principal, 'progress')
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
    await this.options.authority.assertCurrent(admission, principal, 'progress')
    return PiDurableLeadProgressResponseSchema.parse(
      success(request, { ...publicReceipt(receipt), events, nextSequence })
    )
  }

  async cancel(input: unknown, principal: ServicePrincipal) {
    const request = parse(PiDurableLeadCancelRequestSchema, input)
    checkPrincipal(request, principal, 'execution:cancel')
    verifyPayload(request)
    const { receipt, admission } = await this.#lookup(
      request.workspaceId,
      request.payload.dispatchId,
      principal,
      'cancel'
    )
    await this.#bind(request, principal)
    await this.options.authority.assertCurrent(admission, principal, 'cancel')
    const status = RuntimeExecutionStatusSchema.parse(
      await this.options.adapter.cancel(requireHandle(receipt), {
        idempotencyKey: request.idempotencyKey,
        requestedAt: request.issuedAt,
      })
    )
    verifyRuntimeHandle(receipt, status.handle)
    await this.options.authority.assertCurrent(admission, principal, 'cancel')
    return PiDurableLeadCancelResponseSchema.parse(
      success(request, { ...publicReceipt(receipt), state: status.state, status })
    )
  }

  async #resolve(
    workspaceId: string,
    intentId: string,
    principal: ServicePrincipal,
    operation: 'dispatch' | 'status' | 'progress' | 'cancel'
  ) {
    const admission = structuredClone(
      await this.options.authority.resolveIntent({ workspaceId, intentId, principal, operation })
    )
    const plan = assertExecutionPlanIntegrity(admission.startRequest.executionPlan)
    const request = RuntimeStartRequestSchema.parse(admission.startRequest)
    if (
      admission.schemaVersion !== 'pi-lead-authority/v1' ||
      admission.workspaceId !== workspaceId ||
      admission.intentId !== intentId ||
      plan.correlation.workspaceId !== workspaceId ||
      !principal.projectIds.includes(plan.correlation.projectId) ||
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
  ) {
    const receipt = await this.options.receipts.get(dispatchId)
    if (!receipt) fail('PI_LEAD_MISSING')
    if (
      receipt.workspaceId !== workspaceId ||
      !receipt.allowedPrincipalIds.includes(principal.principalId)
    )
      fail('PI_LEAD_SCOPE_REJECTED')
    const admission = await this.#resolve(workspaceId, receipt.intentId, principal, operation)
    verifyReceipt(receipt, admission)
    return { receipt, admission }
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
}

export class UnavailablePiDurableLeadService implements PiDurableLeadService {
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
  }
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
