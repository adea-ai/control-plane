import { createHash } from 'node:crypto'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DelegationRepository } from '@control-plane/orchestration'
import {
  RuntimeStartRequestSchema,
  RuntimeUsageSchema,
  type RuntimeUsage,
} from '@control-plane/runtime-sdk'
import type { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  mutateChildUsage,
  readChildUsage,
  type ChildUsageOutcomesFor,
} from './child-usage-outcomes.js'

/** The journal read needed: terminal records of child attempts. Other records are left alone. */
export interface ChildTerminalJournal {
  list(): readonly {
    readonly state: string
    readonly admission: unknown
    readonly detail: Record<string, unknown>
  }[]
}

/** A durable step after which `afterStep` runs. Throwing or killing the process there interrupts. */
export type ChildSettlementStep = 'reported' | 'attempt-settled' | 'budget-finalized' | 'reconciled'

export interface ChildTerminalSettlementResult {
  /** Completed child attempts whose reservation, budget and cost state are settled. */
  readonly settled: number
  /** Completed child attempts the ledger refuses to settle yet, or whose usage entry is not retained. */
  readonly pending: number
  /** Completed child attempts with no priced usage. Nothing is settled or inferred for them. */
  readonly unpriced: number
}

/**
 * Terminal accounting for normally completed child runs, from the existing machinery only: the durable
 * usage ledger (`settle`, `finalizeBudget`, `summary`), the child cost-state projection and its
 * repository. It reads only durable state (the adapter journal's terminal record, the ledger and the
 * projection), so a new process resumes from exactly what was recorded. Every step is idempotent and
 * ordered so a cost state never runs ahead of the money: report (needs the retained usage entry),
 * settle the attempt reservation, finalize the child budget back into the parent's funding
 * reservation, then reconcile and settle the projection. A refusal leaves the reservation open for a
 * later pass. Failed, cancelled, unknown and interrupted children keep their reservation and cost
 * state exactly as recorded; nothing here infers or releases them.
 */
export class PiChildTerminalSettlement {
  #pass: Promise<ChildTerminalSettlementResult> | undefined
  #blocked = false
  #closed = false

  constructor(
    readonly options: {
      readonly journal: ChildTerminalJournal
      readonly ledger: Pick<DurableUsageLedger, 'entries' | 'settle' | 'finalizeBudget' | 'summary'>
      readonly delegations: Pick<DelegationRepository, 'findByChild'>
      readonly usageOutcomes: ChildUsageOutcomesFor
      readonly now: () => string
      /** Observation and interruption seam: runs after each durable step, never changes the outcome. */
      readonly afterStep?: (step: ChildSettlementStep) => Promise<void>
    }
  ) {}

  /** True while the last pass left a completed child pending, or the last pass threw. */
  get blocked(): boolean {
    return this.#blocked
  }

  /** One pass at a time: a caller that arrives during a pass shares that pass. Refused once closed. */
  settle(): Promise<ChildTerminalSettlementResult> {
    if (this.#closed) return Promise.reject(new Error('PI_CHILD_TERMINAL_SETTLEMENT_CLOSED'))
    this.#pass ??= this.#run()
      .then(
        (result) => {
          this.#blocked = result.pending > 0
          return result
        },
        (error: unknown) => {
          this.#blocked = true
          throw error
        }
      )
      .finally(() => {
        this.#pass = undefined
      })
    return this.#pass
  }

  /** Refuses later passes and waits for a running one. */
  async close(): Promise<void> {
    this.#closed = true
    await this.#pass?.catch(() => undefined)
  }

  async #run(): Promise<ChildTerminalSettlementResult> {
    let settled = 0
    let pending = 0
    let unpriced = 0
    let failure: { readonly error: unknown } | undefined
    for (const record of this.options.journal.list()) {
      if (record.state !== 'completed') continue
      const request = RuntimeStartRequestSchema.safeParse(
        (record.admission as { request?: unknown } | undefined)?.request
      )
      if (!request.success || request.data.executionId === undefined) continue
      const plan = assertExecutionPlanIntegrity(request.data.executionPlan)
      if (!plan.parentExecutionPlan) continue
      const delegation = await this.options.delegations.findByChild(request.data.executionId)
      if (!delegation || delegation.childAttemptId !== request.data.attemptId) continue
      const usage = RuntimeUsageSchema.safeParse(
        (record.detail['result'] as { usage?: unknown } | undefined)?.usage
      )
      if (!usage.success || usage.data.accounting === undefined) {
        unpriced += 1
        continue
      }
      try {
        const outcome = await this.#settleChild({
          workspaceId: plan.correlation.workspaceId,
          childAttemptId: request.data.attemptId,
          delegation,
          usage: usage.data,
        })
        if (outcome === 'settled') settled += 1
        else pending += 1
      } catch (error) {
        // One child's failure must not hold the others; the pass still reports it as blocked.
        failure ??= { error }
      }
    }
    if (failure) throw failure.error
    return { settled, pending, unpriced }
  }

  async #settleChild(input: {
    readonly workspaceId: string
    readonly childAttemptId: string
    readonly delegation: NonNullable<Awaited<ReturnType<DelegationRepository['findByChild']>>>
    readonly usage: RuntimeUsage
  }): Promise<'settled' | 'pending'> {
    const { workspaceId, childAttemptId, delegation, usage } = input
    const accounting = usage.accounting!
    const store = this.options.usageOutcomes(delegation.delegationId)
    const identity = {
      parentExecutionId: delegation.parentExecutionId,
      delegationId: delegation.delegationId,
      childExecutionId: delegation.childExecutionId,
      childAttemptId,
    }
    const executionId = delegation.childExecutionId
    const reservationKey = `runtime-attempt:${childAttemptId}`
    const step = (name: ChildSettlementStep) => this.options.afterStep?.(name)

    const current = await readChildUsage(store, identity)
    if (current.costState === 'settled') return 'settled'

    const usageEntry = (await this.options.ledger.entries(workspaceId, executionId)).find(
      (entry) => entry.kind === 'model_usage' && entry.source.sourceId === accounting.sourceId
    )
    if (!usageEntry) return 'pending'
    const reportId = `usage-settle:${childAttemptId}:${createHash('sha256')
      .update(accounting.sourceId)
      .digest('hex')
      .slice(0, 16)}`

    if (current.reported === undefined) {
      await mutateChildUsage(store, (cost) =>
        cost.recordReportedUsage(identity, usage, {
          reportId,
          publicationSequence: usageEntry.sequence,
        })
      )
      await step('reported')
    }

    try {
      await this.options.ledger.settle({
        workspaceId,
        executionId,
        reservationKey,
        source: {
          sourceId: childAttemptId,
          idempotencyKey: `${reservationKey}:terminal-settle`,
        },
      })
    } catch (error) {
      if (usageCode(error) === 'SETTLEMENT_INCOMPLETE') return 'pending'
      if (usageCode(error) !== 'RESERVATION_SETTLED') throw error
    }
    await step('attempt-settled')

    try {
      await this.options.ledger.finalizeBudget({
        workspaceId,
        executionId,
        source: {
          sourceId: `child-final:${executionId}`,
          idempotencyKey: `child-final:${executionId}:finalize`,
        },
      })
    } catch (error) {
      if (usageCode(error) === 'SETTLEMENT_INCOMPLETE') return 'pending'
      if (usageCode(error) !== 'BUDGET_SETTLED') throw error
    }
    await step('budget-finalized')

    const summary = await this.options.ledger.summary(workspaceId, executionId)
    if (!summary.settled || summary.reservedMicrounits !== 0)
      throw new Error('PI_CHILD_SETTLEMENT_INCOMPLETE')
    // The projection settles exactly what the ledger settled, and only when it agrees with the
    // priced report.
    if (summary.spentMicrounits !== accounting.chargedMicrounits)
      throw new Error('PI_CHILD_SETTLEMENT_MISMATCH')

    if (current.reconciled === undefined) {
      await mutateChildUsage(store, (cost) =>
        cost.reconcile(identity, { reconciledAt: this.options.now() })
      )
      await step('reconciled')
    }
    await mutateChildUsage(store, (cost) =>
      cost.settle(identity, {
        currency: 'USD',
        settledMicrounits: summary.spentMicrounits,
        settledAt: this.options.now(),
        settlementRef: reportId,
      })
    )
    return 'settled'
  }
}

function usageCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined
}
