import type { DatabaseSync } from 'node:sqlite'
import { RuntimeAttemptBudgetAuthoritySchema } from '@control-plane/runtime-sdk'
import type { DurableUsageLedger } from '@control-plane/usage-ledger'

/** The only journal read needed: completed attempts are settled and every other record is left alone. */
export interface LeadTerminalJournal {
  list(): readonly { readonly attemptId: string; readonly state: string }[]
}

export interface LeadTerminalSettlementResult {
  /** Completed lead attempts whose reservation is settled, by this pass or an earlier one. */
  readonly settled: number
  /** Completed lead attempts the ledger refuses to settle yet, such as an open model request. */
  readonly pending: number
  /** Completed journal records with no bound lead budget. This path does not settle them. */
  readonly unbound: number
}

/**
 * Terminal accounting for normally completed lead runs. The adapter records `completed` only after each
 * model request is settled, so the reservation's unspent remainder is exact and can be released. Each
 * settlement uses one idempotency key per reservation, so a replay returns the stored settlement instead
 * of releasing again. A refusal leaves the reservation open for a later pass. Failed, cancelled, and
 * interrupted runs are not settled here.
 */
export class SqlitePiLeadTerminalSettlement {
  #pass: Promise<LeadTerminalSettlementResult> | undefined
  #blocked = false
  #closed = false

  constructor(
    readonly options: {
      readonly database: DatabaseSync
      readonly journal: LeadTerminalJournal
      readonly ledger: Pick<DurableUsageLedger, 'settle'>
    }
  ) {}

  /** True while the last pass left a completed attempt pending, or the last pass threw. */
  get blocked(): boolean {
    return this.#blocked
  }

  /** One pass at a time: a caller that arrives during a pass shares that pass. Refused once closed. */
  settle(): Promise<LeadTerminalSettlementResult> {
    if (this.#closed) return Promise.reject(new Error('PI_LEAD_TERMINAL_SETTLEMENT_CLOSED'))
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

  /** Refuses later passes and waits for a running one, so the database can close after this returns. */
  async close(): Promise<void> {
    this.#closed = true
    await this.#pass?.catch(() => undefined)
  }

  async #run(): Promise<LeadTerminalSettlementResult> {
    let settled = 0
    let pending = 0
    let unbound = 0
    for (const record of this.options.journal.list()) {
      if (record.state !== 'completed') continue
      const budget = this.#budgetFor(record.attemptId)
      if (budget === undefined) {
        unbound += 1
        continue
      }
      try {
        await this.options.ledger.settle({
          workspaceId: budget.workspaceId,
          executionId: budget.executionId,
          reservationKey: budget.reservationKey,
          source: {
            sourceId: budget.attemptId,
            idempotencyKey: `${budget.reservationKey}:terminal-settle`,
          },
        })
        settled += 1
      } catch (error) {
        // Already released under another source: the allowance is back, so nothing is left to do.
        if (usageCode(error) === 'RESERVATION_SETTLED') settled += 1
        else if (usageCode(error) === 'SETTLEMENT_INCOMPLETE') pending += 1
        else throw error
      }
    }
    return { settled, pending, unbound }
  }

  /** The budget admission bound to this attempt's intent; the lead admission writes both tables. */
  #budgetFor(attemptId: string) {
    const row = this.options.database
      .prepare(
        `SELECT budget.record AS record
         FROM pi_lead_intent_admissions AS admission
         JOIN pi_lead_intent_budgets AS budget ON budget.intent_id = admission.intent_id
         WHERE admission.attempt_id = ?`
      )
      .get(attemptId) as { record: string } | undefined
    if (row === undefined) return undefined
    const budget = RuntimeAttemptBudgetAuthoritySchema.parse(JSON.parse(row.record))
    if (budget.attemptId !== attemptId) throw new Error('PI_LEAD_TERMINAL_BUDGET_MISMATCH')
    return budget
  }
}

function usageCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined
}
