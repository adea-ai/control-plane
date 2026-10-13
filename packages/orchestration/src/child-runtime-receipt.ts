import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { ExecutionPlanSchema } from '@control-plane/execution-plan'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import type { ChildAdmissionReader } from './child-admission.js'
import { z } from 'zod'

export function childRuntimeDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const ChildRuntimeLookupReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal('child-runtime-lookup/v1'),
    workspaceId: IdentifierSchemas.workspaceId,
    originalActorPrincipalId: z.string().min(1).max(256),
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId,
    admittedToolCallId: IdentifierSchemas.toolCallId,
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    compilerAdmissionDigest: Digest,
    childAdmissionDigest: Digest,
    request: RuntimeStartRequestSchema,
    requestDigest: Digest,
  })
  .superRefine((receipt, context) => {
    const plan = ExecutionPlanSchema.safeParse(receipt.request.executionPlan)
    if (
      !plan.success ||
      receipt.requestDigest !== childRuntimeDigest(receipt.request) ||
      receipt.request.executionId !== receipt.childExecutionId ||
      receipt.request.attemptId !== receipt.childAttemptId ||
      plan.data.correlation.workspaceId !== receipt.workspaceId ||
      !receipt.request.attemptBudget ||
      receipt.request.attemptBudget.workspaceId !== receipt.workspaceId ||
      receipt.request.idempotencyKey !==
        `delegation:${receipt.delegationId}:attempt:${receipt.childAttemptId}`
    )
      context.addIssue({ code: 'custom', message: 'Child runtime lookup identity mismatch' })
  })
export type ChildRuntimeLookupReceipt = z.output<typeof ChildRuntimeLookupReceiptSchema>
export interface ChildRuntimeLookupSnapshot {
  readonly receipt: ChildRuntimeLookupReceipt
  readonly fence: string
}
export type RecoveredChildSessionMapping = Pick<
  ChildRuntimeLookupReceipt,
  | 'workspaceId'
  | 'parentExecutionId'
  | 'delegationId'
  | 'childExecutionId'
  | 'childAttemptId'
  | 'runtimeConnectionId'
> & { readonly externalSessionId: string }
export const ChildReceiptReadBindingSchema = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
  originalActorPrincipalId: z.string().min(1).max(256),
  readerPrincipalId: z.string().min(1).max(256),
  audienceRef: z.string().min(1).max(256),
  authorityRevision: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
})
/** Trusted host-only port, never accepted from request JSON. Schema validation
 * checks pins; it does NOT authenticate this implementation or qualify a profile.
 * Production composition must independently qualify/authenticate the read authority.
 */
export interface ChildReceiptReadAuthority {
  readonly readerPrincipalId: string
  readonly audienceRef: string
  now(): string
  assertQualified(scope: {
    workspaceId: string
    runtimeConnectionId: string
    nativeReceiptReader: object
  }): Promise<void>
  assertCurrent(receipt: ChildRuntimeLookupReceipt, reader?: ChildAdmissionReader): Promise<unknown>
}
