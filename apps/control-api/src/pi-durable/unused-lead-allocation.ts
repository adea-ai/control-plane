import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  ExecutionLifecycleService,
  ExecutionSchema,
  ExecutionAttemptSchema,
  type ExecutionRepository,
  type Execution,
  type ExecutionAttempt,
} from '@control-plane/domain'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import type { DurableUsageLedger } from '@control-plane/usage-ledger'
import type { PiDurableLeadAdmission } from './pi-durable-lead.service.js'

export interface UnusedPiLeadAllocationTransaction {
  readonly executions: ExecutionRepository
  readonly ledger: DurableUsageLedger
}

export interface UnusedPiLeadAllocationReleaseOptions {
  /** Server-owned shared storage transaction, including execution/attempt CAS,
   * model admission, allocation validation and settlement. The resources must
   * be bound to that transaction; independently opened repositories are unsafe.
   * The preparation store retains release_pending before invoking this port.
   */
  transaction<Result>(
    workspaceId: string,
    operation: (resources: UnusedPiLeadAllocationTransaction) => Promise<Result>
  ): Promise<Result>
  readonly now?: () => string
}

/** Releases only a canonical, unused allocation. This server cleanup callback
 * grants no spending authority and must never be exposed as caller input.
 */
export function createUnusedPiLeadAllocationReleaser(
  options: UnusedPiLeadAllocationReleaseOptions
): (admission: PiDurableLeadAdmission) => Promise<void> {
  return async (admissionInput): Promise<void> => {
    try {
      const admission = structuredClone(admissionInput)
      const request = RuntimeStartRequestSchema.parse(admission.startRequest)
      const plan = assertExecutionPlanIntegrity(request.executionPlan)
      const budget = request.attemptBudget
      if (
        admission.schemaVersion !== 'pi-lead-authority/v1' ||
        budget === undefined ||
        admission.workspaceId !== plan.correlation.workspaceId ||
        admission.workspaceId !== budget.workspaceId ||
        admission.admittedAttempt.executionId !== request.executionId ||
        admission.admittedAttempt.attemptId !== request.attemptId ||
        admission.admittedAttempt.executionPlanId !== plan.executionPlanId ||
        admission.admittedAttempt.executionPlanDigest !== plan.contentDigest
      )
        unsafe()
      const digest = createHash('sha256')
        .update(
          canonicalJsonStringify({
            schemaVersion: 'pi-unused-lead-allocation/v1',
            workspaceId: admission.workspaceId,
            admittedAttempt: admission.admittedAttempt,
            budget,
          })
        )
        .digest('hex')
      const source = {
        sourceId: `pi-lead-unused:${digest}`,
        idempotencyKey: `${budget.reservationKey}:unused-release`,
      }
      await options.transaction(admission.workspaceId, async ({ executions, ledger }) => {
        const execution = ExecutionSchema.parse(await executions.getExecution(budget.executionId))
        const attempt = ExecutionAttemptSchema.parse(await executions.getAttempt(budget.attemptId))
        if (
          execution.executionId !== budget.executionId ||
          canonicalJsonStringify(execution.correlation) !==
            canonicalJsonStringify(plan.correlation) ||
          execution.executionPlan.executionPlanId !== plan.executionPlanId ||
          execution.executionPlan.contentDigest !== plan.contentDigest ||
          execution.executionPlan.schemaVersion !== plan.schemaVersion ||
          execution.latestAttemptId !== budget.attemptId ||
          attempt.executionId !== execution.executionId ||
          attempt.attemptId !== budget.attemptId ||
          attempt.sequence !== execution.attemptCount ||
          started(execution) ||
          started(attempt) ||
          attempt.runtime?.externalSessionId !== undefined
        )
          unsafe()
        const entries = await ledger.entries(budget.workspaceId, budget.executionId)
        // Even a settled or zero-cost physical hold establishes dispatch history.
        if (
          entries.some((entry) =>
            [
              'model_reservation',
              'model_release',
              'model_usage',
              'tool_charge',
              'sandbox_usage',
            ].includes(entry.kind)
          )
        )
          unsafe()
        const allocationEntries = entries.filter(
          (entry) =>
            entry.reservationKey === budget.reservationKey && entry.attemptId === budget.attemptId
        )
        const reservations = allocationEntries.filter((entry) => entry.kind === 'reservation')
        const reservation = reservations[0]
        if (
          reservations.length !== 1 ||
          !reservation ||
          reservation.source.sourceId !== budget.attemptId ||
          reservation.currency !== budget.currency ||
          reservation.quantity.unit !== 'microunits' ||
          reservation.quantity.value !== budget.maximumMicrounits ||
          reservation.costMicrounits !== budget.maximumMicrounits
        )
          unsafe()
        const settlements = allocationEntries.filter((entry) => entry.kind === 'settlement')
        const replay =
          execution.state === 'cancelled' &&
          attempt.state === 'cancelled' &&
          settlements.length === 1 &&
          settlements[0]?.source.sourceId === source.sourceId
        if (
          !replay &&
          (!['accepted', 'queued'].includes(execution.state) ||
            attempt.state !== 'queued' ||
            allocationEntries.length !== 1)
        )
          unsafe()
        // Exact replay of the existing runtime admission validates BOTH ceilings,
        // including tokens, against its durable fingerprint. The verified existing
        // reservation is a prerequisite; this call cannot mint a new allocation.
        await ledger.reserve({
          workspaceId: budget.workspaceId,
          executionId: budget.executionId,
          attemptId: budget.attemptId,
          reservationKey: budget.reservationKey,
          maximumMicrounits: budget.maximumMicrounits,
          maximumTokens: budget.maximumTokens,
          source: {
            sourceId: budget.attemptId,
            idempotencyKey: `${budget.reservationKey}:reserve`,
          },
        })
        if (!replay) {
          const transitionedAt = options.now?.() ?? new Date().toISOString()
          const lifecycle = new ExecutionLifecycleService(executions)
          await lifecycle.transitionAttempt({
            attemptId: attempt.attemptId,
            expectedVersion: attempt.version,
            to: 'cancelled',
            transitionedAt,
          })
          await lifecycle.transitionExecution({
            executionId: execution.executionId,
            expectedVersion: execution.version,
            to: 'cancelled',
            transitionedAt,
          })
        }
        await ledger.settle({
          workspaceId: budget.workspaceId,
          executionId: budget.executionId,
          reservationKey: budget.reservationKey,
          source,
        })
      })
    } catch {
      unsafe()
    }
  }
}

function started(record: Execution | ExecutionAttempt): boolean {
  return (
    record.startingAt !== undefined ||
    record.runningAt !== undefined ||
    record.awaitingInputAt !== undefined ||
    record.cancellingAt !== undefined ||
    record.reconciliationRequiredAt !== undefined ||
    record.terminalResultRef !== undefined
  )
}

function unsafe(): never {
  throw new Error('PI_LEAD_UNUSED_ALLOCATION_UNSAFE')
}
