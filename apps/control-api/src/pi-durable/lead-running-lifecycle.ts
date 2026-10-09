import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ExecutionLifecycleService,
  ExecutionSchema,
  ExecutionAttemptSchema,
  type ExecutionRepository,
} from '@control-plane/domain'
import { RuntimeStartRequestSchema, RuntimeExecutionHandleSchema } from '@control-plane/runtime-sdk'
import type {
  DurableExecutionAuthority,
  PiDurableRunningAuthority,
} from '@control-plane/pi-durable-adapter'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'

const live = new Set(['accepted', 'queued', 'starting', 'running', 'awaiting_input'])
const receiptSchema = z.strictObject({
  executionId: ExecutionSchema.shape.executionId,
  attemptId: ExecutionAttemptSchema.shape.attemptId,
  executionPlan: ExecutionSchema.shape.executionPlan,
  correlation: ExecutionSchema.shape.correlation,
  idempotencyKey: RuntimeStartRequestSchema.shape.idempotencyKey,
  handle: RuntimeExecutionHandleSchema,
})
function rejected(): never {
  throw new Error('PI_LEAD_RUNNING_AUTHORITY_REJECTED')
}

/** Lead-only canonical lifecycle bridge. Actual session identity is retained in this
 * host receipt and the adapter journal: attempt.runtime remains immutable.
 * This port grants neither terminal nor child continuation authority.
 */
export class SqlitePiLeadRunningLifecycle {
  readonly lifecycle: ExecutionLifecycleService
  constructor(
    readonly options: {
      database: DatabaseSync
      executions: ExecutionRepository
      assertAuthority: (authority: DurableExecutionAuthority) => Promise<void>
    }
  ) {
    this.lifecycle = new ExecutionLifecycleService(options.executions)
    options.database.exec(`CREATE TABLE IF NOT EXISTS pi_lead_running_receipts (
      attempt_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,
      handle_id TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL, observed_at TEXT NOT NULL
    ) STRICT`)
  }

  async onExecutionRunning(input: PiDurableRunningAuthority): Promise<void> {
    const request = RuntimeStartRequestSchema.parse(input.request)
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    const handle = RuntimeExecutionHandleSchema.parse(input.handle)
    const observedAt = z.iso.datetime().parse(input.observedAt)
    if (
      plan.parentExecutionPlan ||
      !request.executionId ||
      handle.attemptId !== request.attemptId ||
      !handle.externalSessionId
    )
      rejected()
    const authority = { request, admission: structuredClone(input.admission) }
    const pin = {
      executionPlanId: request.executionPlan.executionPlanId,
      contentDigest: request.executionPlan.contentDigest,
      schemaVersion: request.executionPlan.schemaVersion,
    }
    const read = async () => {
      await this.options.assertAuthority(authority)
      const [executionInput, attemptInput] = await Promise.all([
        this.options.executions.getExecution(request.executionId!),
        this.options.executions.getAttempt(request.attemptId),
      ])
      const execution = ExecutionSchema.parse(executionInput)
      const attempt = ExecutionAttemptSchema.parse(attemptInput)
      if (
        execution.executionId !== request.executionId ||
        execution.latestAttemptId !== request.attemptId ||
        attempt.attemptId !== request.attemptId ||
        attempt.executionId !== execution.executionId ||
        execution.parentExecutionId ||
        !live.has(execution.state) ||
        !live.has(attempt.state) ||
        canonicalJsonStringify(execution.executionPlan) !== canonicalJsonStringify(pin) ||
        canonicalJsonStringify(execution.correlation) !==
          canonicalJsonStringify(plan.correlation) ||
        Date.parse(observedAt) < Date.parse(execution.updatedAt) ||
        Date.parse(observedAt) < Date.parse(attempt.updatedAt) ||
        (attempt.runtime?.externalSessionId !== undefined &&
          attempt.runtime.externalSessionId !== handle.externalSessionId)
      )
        rejected()
      // Authority ports can await external policy reads: reject any concurrent CAS.
      await this.options.assertAuthority(authority)
      const [latestExecution, latestAttempt] = await Promise.all([
        this.options.executions.getExecution(execution.executionId),
        this.options.executions.getAttempt(attempt.attemptId),
      ])
      if (
        canonicalJsonStringify(latestExecution) !== canonicalJsonStringify(execution) ||
        canonicalJsonStringify(latestAttempt) !== canonicalJsonStringify(attempt)
      )
        rejected()
      return { execution, attempt }
    }
    await read()
    const receipt = canonicalJsonStringify(
      receiptSchema.parse({
        executionId: request.executionId,
        attemptId: request.attemptId,
        executionPlan: pin,
        correlation: plan.correlation,
        idempotencyKey: request.idempotencyKey,
        handle,
      })
    )
    this.options.database
      .prepare(`INSERT INTO pi_lead_running_receipts
      (attempt_id, execution_id, handle_id, receipt_json, observed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(request.attemptId, request.executionId, handle.handleId, receipt, observedAt)
    const retained = this.options.database
      .prepare('SELECT receipt_json FROM pi_lead_running_receipts WHERE attempt_id = ?')
      .get(request.attemptId) as { receipt_json: string } | undefined
    if (!retained || retained.receipt_json !== receipt) rejected()
    // Each CAS follows a fresh exact canonical read; partial transitions are restart safe.
    for (let step = 0; step < 8; step++) {
      const { execution, attempt } = await read()
      if (execution.state === 'running' && attempt.state === 'running') return
      if (execution.state === 'accepted' || execution.state === 'queued') {
        await this.lifecycle.transitionExecution({
          executionId: execution.executionId,
          expectedVersion: execution.version,
          to: execution.state === 'accepted' ? 'queued' : 'starting',
          transitionedAt: observedAt,
        })
      } else if (attempt.state === 'queued') {
        await this.lifecycle.transitionAttempt({
          attemptId: attempt.attemptId,
          expectedVersion: attempt.version,
          to: 'starting',
          transitionedAt: observedAt,
        })
      } else if (execution.state !== 'running') {
        await this.lifecycle.transitionExecution({
          executionId: execution.executionId,
          expectedVersion: execution.version,
          to: 'running',
          transitionedAt: observedAt,
        })
      } else {
        await this.lifecycle.transitionAttempt({
          attemptId: attempt.attemptId,
          expectedVersion: attempt.version,
          to: 'running',
          transitionedAt: observedAt,
        })
      }
    }
    rejected()
  }
}
