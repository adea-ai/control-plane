import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  ExecutionCancellationCommandSchema,
  validateExecutionScopeFields,
  executionScopesEqual,
  executionScopeOf,
  ExecutionCancellationCommandResultSchema,
  type ExecutionCancellationCommand,
} from '@control-plane/contracts'
import type {
  CommandAcceptanceRepository,
  ExecutionPlanAcceptanceValidator,
} from './command-inbox.js'

export const ExecutionCancellationScopeSchema = z
  .object({
    workspaceId: ExecutionCancellationCommandSchema.shape.workspaceId,
    projectId: ExecutionCancellationCommandSchema.shape.projectId,
    executionScope: ExecutionCancellationCommandSchema.shape.executionScope,
    caller: ExecutionCancellationCommandSchema.shape.caller,
    operation: ExecutionCancellationCommandSchema.shape.operation,
    idempotencyKey: ExecutionCancellationCommandSchema.shape.idempotencyKey,
  })
  .strip()
  .superRefine(validateExecutionScopeFields)
export const ExecutionCancellationReceiptSchema = z.strictObject({
  request: ExecutionCancellationCommandSchema,
  acceptedAt: z.iso.datetime().optional(),
})
export type ExecutionCancellationScope = z.output<typeof ExecutionCancellationScopeSchema>
export type ExecutionCancellationReceipt = z.output<typeof ExecutionCancellationReceiptSchema>
export interface ExecutionCancellationRepository {
  get(scope: ExecutionCancellationScope): Promise<ExecutionCancellationReceipt | undefined>
  /** Atomically preserve the first validated request for this scope. */
  reserve(receipt: ExecutionCancellationReceipt): Promise<{
    receipt: ExecutionCancellationReceipt
    inserted: boolean
  }>
  markAccepted(scope: ExecutionCancellationScope, at: string): Promise<ExecutionCancellationReceipt>
}
export interface ExecutionCancellationDispatcher {
  /** Use the stored command identity for downstream deduplication, including lost ACK retries. */
  cancel(request: ExecutionCancellationCommand): Promise<void>
}
export function executionCancellationScopeKey(input: ExecutionCancellationScope): string {
  const scope = ExecutionCancellationScopeSchema.parse(input)
  if (executionScopeOf(scope).kind === 'workspace')
    return JSON.stringify([
      'execution-scope/v1',
      'workspace',
      scope.caller.servicePrincipalId,
      scope.workspaceId,
      scope.operation,
      scope.idempotencyKey,
    ])
  return JSON.stringify([
    scope.caller.servicePrincipalId,
    scope.workspaceId,
    scope.projectId,
    scope.operation,
    scope.idempotencyKey,
  ])
}

export class DurableExecutionCancellationService {
  constructor(
    readonly receipts: ExecutionCancellationRepository,
    readonly executions: Pick<CommandAcceptanceRepository, 'getByExecutionId' | 'getExecution'>,
    readonly dispatcher: ExecutionCancellationDispatcher,
    readonly now: () => string = () => new Date().toISOString(),
    readonly scopeAuthority?: Pick<ExecutionPlanAcceptanceValidator, 'authorizeScope'>
  ) {}

  async cancel(input: unknown, authenticatedPrincipalId: string) {
    const request = ExecutionCancellationCommandSchema.parse(input)
    if (request.caller.servicePrincipalId !== authenticatedPrincipalId)
      throw new Error('EXECUTION_CANCELLATION_CALLER_MISMATCH')
    const [accepted, execution] = await Promise.all([
      this.executions.getByExecutionId(request.payload.executionId),
      this.executions.getExecution(request.payload.executionId),
    ])
    // Cancellation belongs to the accepting principal, not any principal in a workspace.
    if (
      !accepted ||
      !execution ||
      accepted.callerPrincipalId !== authenticatedPrincipalId ||
      accepted.executionId !== request.payload.executionId ||
      execution.executionId !== request.payload.executionId ||
      !executionScopesEqual(accepted, request) ||
      !executionScopesEqual(execution.correlation, request)
    )
      throw new Error('EXECUTION_CANCELLATION_SCOPE_REJECTED')
    if (
      accepted.executionScope !== undefined &&
      !(await this.scopeAuthority?.authorizeScope?.({
        workspaceId: accepted.workspaceId,
        projectId: accepted.projectId,
        executionScope: accepted.executionScope,
        executionPlan: accepted.executionPlan,
        callerPrincipalId: authenticatedPrincipalId,
      }))
    )
      throw new Error('EXECUTION_CANCELLATION_SCOPE_REJECTED')
    const existing = await this.receipts.get(request)
    // An existing intent may need its lost ACK reconciled after execution terminates.
    // A new command must not claim it cancelled already-terminal work.
    if (!existing && ['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state))
      throw new Error('EXECUTION_CANCELLATION_EXECUTION_INACTIVE')
    const reservation = existing
      ? { receipt: existing, inserted: false }
      : await this.receipts.reserve({ request })
    const receipt = ExecutionCancellationReceiptSchema.parse(reservation.receipt)
    if (
      executionCancellationScopeKey(request) !== executionCancellationScopeKey(receipt.request) ||
      !isDeepStrictEqual(request.payload, receipt.request.payload)
    )
      throw new Error('EXECUTION_CANCELLATION_PAYLOAD_CONFLICT')
    if (receipt.acceptedAt === undefined) {
      await this.dispatcher.cancel(receipt.request)
      await this.receipts.markAccepted(request, this.now())
    }
    return ExecutionCancellationCommandResultSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: {
        commandId: receipt.request.commandId,
        executionId: receipt.request.payload.executionId,
        status: 'accepted',
        replayed: !reservation.inserted,
      },
    })
  }
}
