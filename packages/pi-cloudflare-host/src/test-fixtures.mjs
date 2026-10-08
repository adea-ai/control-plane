import { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { CloudflareOwnerJournal } from './owner.ts'
import { CloudflarePiHost } from './host.ts'
const id = (prefix) => `${prefix}_00000000000000000000000001`
const digest = `sha256:${'a'.repeat(64)}`
export const pins = {
  schemaVersion: 1,
  adapterVersion: '0.1.0',
  runtimeVersion: '1.1.0',
  configurationDigest: digest,
  workspaceId: id('wsp'),
  conversationId: 'conversation-a',
  agentId: id('agt'),
}
export const request = {
  executionId: id('exe'),
  attemptId: id('att'),
  idempotencyKey: 'start-one',
  executionPlan: {
    schemaVersion: 2,
    executionPlanId: id('pln'),
    contentDigest: digest,
    runtimeRequirements: [],
    correlation: { workspaceId: pins.workspaceId },
    constraints: {
      limits: {
        budget: { currency: 'USD', maximumMicrounits: 100 },
        tokens: { maximumTotal: 100 },
      },
    },
  },
  attemptBudget: {
    schemaVersion: 1,
    workspaceId: pins.workspaceId,
    executionId: id('exe'),
    attemptId: id('att'),
    executionPlanId: id('pln'),
    executionPlanDigest: digest,
    reservationKey: `runtime-attempt:${id('att')}`,
    currency: 'USD',
    maximumMicrounits: 100,
    maximumTokens: 100,
  },
}
export const task = {
  schemaVersion: 1,
  canonicalActorPrincipalId: 'user:00000000-0000-0000-0000-000000000001',
  request,
}
export const result = {
  outcome: 'completed',
  output: { answer: 'canonical fixture' },
  usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
  artifacts: [],
}
export function fixture() {
  const db = new Database(':memory:')
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value
            )
          )
        return { toArray: () => rows }
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    async setAlarm() {},
    async transaction(operation) {
      db.exec('BEGIN')
      try {
        const transactionResult = await operation()
        db.exec('COMMIT')
        return transactionResult
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  let revoked = false,
    opens = 0,
    sends = 0,
    closes = 0
  const boundaries = []
  const authority = {
    async readAccepted() {
      return structuredClone(task)
    },
    async assertCurrent(accepted, owner, boundary) {
      boundaries.push(boundary)
      if (revoked) throw new Error('REVOKED')
      expect(accepted.canonicalActorPrincipalId).toBe(task.canonicalActorPrincipalId)
      expect(owner.workspaceId).toBe(pins.workspaceId)
    },
  }
  let run = async (accepted, beforeEffect) => {
    await beforeEffect()
    sends++
    return result
  }
  const openEngine = async () => {
    opens++
    return {
      run: (...args) => run(...args),
      async close() {
        closes++
      },
    }
  }
  const journal = new CloudflareOwnerJournal(storage, pins)
  const host = new CloudflarePiHost(journal, pins, authority, openEngine)
  return {
    db,
    storage,
    journal,
    host,
    authority,
    openEngine,
    boundaries,
    revoke: () => {
      revoked = true
    },
    setRun: (fn) => {
      run = fn
    },
    counts: () => ({ opens, sends, closes }),
  }
}
