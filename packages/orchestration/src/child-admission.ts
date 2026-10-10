import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { Execution, ExecutionAttempt } from '@control-plane/domain'
import { z } from 'zod'
import type { DelegationRecord } from './delegation.js'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const OpaqueReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const PlanPinSchema = z
  .object({
    executionPlanId: IdentifierSchemas.executionPlanId,
    contentDigest: DigestSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict()
const ChildDispatchSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childAttemptId: IdentifierSchemas.attemptId,
    runtime: z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
        runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId.optional(),
        externalSessionId: IdentifierSchemas.externalSessionId.optional(),
        runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
      })
      .strict(),
    dispatchedAt: TimestampSchema,
  })
  .strict()

/**
 * The immutable identity a trusted product adapter must authorize before the
 * child execution, attempt, or budget can be allocated. It deliberately
 * contains no provider credentials, prompt, selected model payload, or spend
 * grant; those remain owned by their existing authorities.
 */
export const ChildAdmissionRequestSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    parentIntentId: OpaqueReferenceSchema,
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId,
    parentExecutionVersion: z.number().int().positive(),
    parentPlan: PlanPinSchema,
    admittedToolCallId: IdentifierSchemas.toolCallId,
    delegationId: IdentifierSchemas.delegationId,
    childRequestId: IdentifierSchemas.requestId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
    childDispatch: ChildDispatchSchema,
    childPlan: PlanPinSchema,
    role: OpaqueReferenceSchema,
    profileVersionId: IdentifierSchemas.profileVersionId,
    originalActorPrincipalId: OpaqueReferenceSchema,
    childRequestDigest: DigestSchema,
    acceptedAt: TimestampSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.childDispatch.delegationId !== request.delegationId ||
      request.childDispatch.childAttemptId !== request.childAttemptId ||
      Date.parse(request.childDispatch.dispatchedAt) < Date.parse(request.acceptedAt)
    ) {
      context.addIssue({ code: 'custom', message: 'Child dispatch binding denied' })
    }
  })

/**
 * A short-lived, versioned receipt from the trusted model-selection/product
 * authority. `selectionRef` is an opaque pin; this receipt is not permission
 * to reuse credentials, dispatch a model request, or spend funds.
 */
export const ChildAdmissionReceiptSchema = z
  .object({
    schemaVersion: z.literal('pi-child-admission/v1'),
    workspaceId: IdentifierSchemas.workspaceId,
    parentIntentId: OpaqueReferenceSchema,
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId,
    parentExecutionVersion: z.number().int().positive(),
    parentPlan: PlanPinSchema,
    admittedToolCallId: IdentifierSchemas.toolCallId,
    delegationId: IdentifierSchemas.delegationId,
    childRequestId: IdentifierSchemas.requestId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
    childDispatch: ChildDispatchSchema,
    childPlan: PlanPinSchema,
    role: OpaqueReferenceSchema,
    profileVersionId: IdentifierSchemas.profileVersionId,
    originalActorPrincipalId: OpaqueReferenceSchema,
    childRequestDigest: DigestSchema,
    acceptedAt: TimestampSchema,
    authorityRevision: z.number().int().positive(),
    productRevision: OpaqueReferenceSchema,
    productReaderPrincipalId: OpaqueReferenceSchema,
    selectionRef: OpaqueReferenceSchema,
    selectionRevision: z.number().int().positive(),
    expiresAt: TimestampSchema,
  })
  .strict()

export type ChildAdmissionRequest = z.output<typeof ChildAdmissionRequestSchema>
export type ChildAdmissionReceipt = z.output<typeof ChildAdmissionReceiptSchema>

/**
 * Product-specific adapters implement this port using the canonical actor,
 * audience, role selection, and readiness repositories. They derive the
 * product-reader principal from trusted server composition, never this
 * request. `assertCurrent` must
 * re-read those authorities immediately before the caller's allocation
 * transaction; it must fail closed on missing, stale, expired, or revoked
 * state. The port must not perform allocation itself.
 */
/**
 * Canonical reads a child authority recheck may make. The allocator hands the recheck the reader of its
 * own open transaction, so every read in the fence sees that transaction and never re-enters the store.
 * A reader is valid only while its fence is running.
 */
export interface ChildAdmissionReader {
  getExecution(executionId: string): Promise<unknown | undefined>
  getAttempt(attemptId: string): Promise<unknown | undefined>
  getToolCall(toolCallId: string): Promise<unknown | undefined>
}

export interface ChildAdmissionAuthority {
  prepare(request: ChildAdmissionRequest): Promise<unknown>
  assertCurrent(
    request: ChildAdmissionRequest,
    receipt: ChildAdmissionReceipt,
    reader?: ChildAdmissionReader
  ): Promise<void>
}

/**
 * Storage-owned allocation seam. Implementations must lock/re-read the
 * canonical parent and lineage, call `assertCurrent` while holding their
 * allocation transaction and before the first write, then atomically create
 * the child execution, parent-budget reservation, child budget, and delegation
 * record. A false result means an identity conflict; policy/limit denials are
 * thrown and the entire transaction must roll back.
 */
export interface ChildAdmissionAllocator {
  allocate(input: {
    readonly request: ChildAdmissionRequest
    readonly receipt: ChildAdmissionReceipt
    readonly execution: Execution
    readonly attempt: ExecutionAttempt
    readonly delegation: DelegationRecord
    readonly assertCurrent: (reader: ChildAdmissionReader) => Promise<void>
  }): Promise<boolean>
}

export type ChildAdmissionAllocationErrorCode =
  | 'CHILD_ADMISSION_DENIED'
  | 'DELEGATION_LIMIT_EXCEEDED'
  | 'DELEGATION_DEPTH_EXCEEDED'
  | 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED'

export class ChildAdmissionAllocationError extends Error {
  constructor(readonly code: ChildAdmissionAllocationErrorCode) {
    super(code)
    this.name = 'ChildAdmissionAllocationError'
  }
}

/** Validates exact identity pins and freshness without exposing authority data. */
export function assertChildAdmissionReceiptMatches(
  requestInput: unknown,
  receiptInput: unknown,
  nowInput: unknown
): ChildAdmissionReceipt {
  const request = ChildAdmissionRequestSchema.parse(requestInput)
  const receipt = ChildAdmissionReceiptSchema.parse(receiptInput)
  const now = TimestampSchema.parse(nowInput)
  const {
    schemaVersion: _schemaVersion,
    authorityRevision: _authorityRevision,
    productRevision: _productRevision,
    productReaderPrincipalId: _productReaderPrincipalId,
    selectionRef: _selectionRef,
    selectionRevision: _selectionRevision,
    expiresAt: _expiresAt,
    ...receiptPins
  } = receipt
  if (
    canonicalJsonStringify(receiptPins) !== canonicalJsonStringify(request) ||
    Date.parse(receipt.expiresAt) <= Date.parse(now)
  ) {
    throw new Error('CHILD_ADMISSION_RECEIPT_MISMATCH')
  }
  return receipt
}

export function childAdmissionRequestDigest(value: unknown): string {
  const parsed = ChildAdmissionRequestSchema.parse(value)
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(parsed)).digest('hex')}`
}
