import { z } from 'zod'
import { InteractionService, type InteractionRepository } from '@control-plane/domain'
import { DurableToolCallRequestSchema, type DurableToolCallRequest } from '@control-plane/tool-sdk'

/**
 * Typed durable task for one retained approval -> authorized write -> receipt -> settlement
 * workflow (M16.02, #939). It adds no scheduler and no DAG. It is a contract over the
 * existing Pi durable effect gate, which owns admission, the approval review, the
 * durable invocation barrier, the receipt, and the single retained settlement.
 *
 * The task pins the exact authorized write in `request`: plan and execution identity,
 * tool version and digest-bearing input, approval subject, audience, and expiry. The
 * effect key is derived from `taskId` alone. A rerun with changed pins therefore reaches
 * the gate with the same key and fails its request-digest identity check instead of
 * creating a second effect.
 */
export const RETAINED_APPROVAL_WRITE_SCHEMA = 'retained-approval-write/v1'

export class RetainedApprovalWriteError extends Error {
  constructor(readonly code: 'RETAINED_TASK_INVALID' | 'RETAINED_TASK_KEY_MISMATCH') {
    super(code)
    this.name = 'RetainedApprovalWriteError'
  }
}

/** Stable effect key for one retained task. Derived from identity, never from input. */
export function retainedApprovalWriteEffectKey(taskId: string): string {
  return `retained-write:${taskId}`
}

export const RetainedApprovalWriteTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(RETAINED_APPROVAL_WRITE_SCHEMA),
    taskId: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    request: DurableToolCallRequestSchema.refine((request) => request.approval !== undefined, {
      message: 'A retained write requires an approval subject',
    }),
  })
  .strict()
export type RetainedApprovalWriteTask = z.output<typeof RetainedApprovalWriteTaskSchema>

/** Parses a task definition and rejects any effect key not derived from its identity. */
export function parseRetainedApprovalWriteTask(input: unknown): RetainedApprovalWriteTask {
  const parsed = RetainedApprovalWriteTaskSchema.safeParse(input)
  if (!parsed.success) throw new RetainedApprovalWriteError('RETAINED_TASK_INVALID')
  if (parsed.data.request.idempotencyKey !== retainedApprovalWriteEffectKey(parsed.data.taskId))
    throw new RetainedApprovalWriteError('RETAINED_TASK_KEY_MISMATCH')
  return parsed.data
}

/** The gate's execute surface, as composed by the node Pi durable runtime. */
export interface RetainedApprovalWriteEffects {
  execute(request: DurableToolCallRequest): Promise<unknown>
}

/**
 * Runs one retained task through the production effect gate. Each call returns the gate's
 * outcome: awaiting approval, a settled receipt, a denial, or reconciliation. Replays return
 * the retained outcome and never repeat the write.
 *
 * The approval subject is requested as the task's first step, idempotently by interaction id.
 * The current-authority reader requires the interaction to exist at admission, before the gate
 * reviews it, so the gate's own create-on-review path is never reached for a retained task.
 * Revocation, expiry, and any audience, detail, or timing mismatch then fail closed in the gate.
 */
export function createRetainedApprovalWriteRunner(options: {
  readonly effects: RetainedApprovalWriteEffects
  readonly interactions: InteractionRepository
}) {
  const approvals = new InteractionService(options.interactions)
  return {
    async run(input: unknown): Promise<unknown> {
      const task = parseRetainedApprovalWriteTask(input)
      await requestApprovalOnce(options.interactions, approvals, task)
      return options.effects.execute(task.request)
    },
  }
}

async function requestApprovalOnce(
  interactions: InteractionRepository,
  approvals: InteractionService,
  task: RetainedApprovalWriteTask
): Promise<void> {
  const { request } = task
  const approval = request.approval
  if (approval === undefined) throw new RetainedApprovalWriteError('RETAINED_TASK_INVALID')
  if (await interactions.get(approval.interactionId)) return
  try {
    await approvals.request({
      interactionId: approval.interactionId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      kind: 'approval',
      prompt: {
        title: `Approve ${request.operation}`,
        detailsReference: `artifact://tool-call/${request.toolCallId}`,
      },
      allowedActions: ['approve', 'deny'],
      allowedPrincipalIds: approval.allowedPrincipalIds,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    })
  } catch (error) {
    // A concurrent run created the same interaction first. Anything else is a real failure.
    if (await interactions.get(approval.interactionId)) return
    throw error
  }
}
