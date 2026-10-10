import { afterEach, test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { SqlitePiLeadTerminalSettlement } from './lead-terminal-settlement.ts'

// Terminal settlement health and close semantics, with a real in-memory lead budget table and fake
// journal and ledger ports. The composition tests cover the real ledger and journal.

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const unboundAttemptId = 'att_01JBBCDEF0123456789ABCDEFG'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const budget = {
  schemaVersion: 1,
  workspaceId,
  executionId,
  attemptId,
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  executionPlanDigest: `sha256:${'c'.repeat(64)}`,
  reservationKey: `runtime-attempt:${attemptId}`,
  currency: 'USD',
  maximumMicrounits: 1000,
  maximumTokens: 100,
}

// Every database opened here is closed after its test, so no handle outlives this file.
const openDatabases = []

function leadDatabase() {
  const database = new DatabaseSync(':memory:')
  openDatabases.push(database)
  database.exec(`CREATE TABLE pi_lead_intent_admissions (intent_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE pi_lead_intent_budgets (intent_id TEXT PRIMARY KEY, record TEXT NOT NULL);`)
  database
    .prepare('INSERT INTO pi_lead_intent_admissions VALUES (?, ?, ?, ?, ?, ?)')
    .run(intentId, workspaceId, attemptId, `sha256:${'d'.repeat(64)}`, 'ready', '{}')
  database
    .prepare('INSERT INTO pi_lead_intent_budgets VALUES (?, ?)')
    .run(intentId, JSON.stringify(budget))
  return database
}

function journalOf(records) {
  const journal = {
    reads: 0,
    list() {
      journal.reads += 1
      return records
    },
  }
  return journal
}

// Each outcome is one settle call: null settles, a code is a refusal with that code, 'unexpected' throws.
function ledgerOf(outcomes) {
  const ledger = {
    calls: [],
    async settle(input) {
      ledger.calls.push(input)
      const outcome = outcomes.shift() ?? null
      if (outcome === 'unexpected') throw new Error('STORE_UNAVAILABLE')
      if (outcome !== null) throw Object.assign(new Error(outcome), { code: outcome })
      return { releasedMicrounits: 1000, settlement: {} }
    },
  }
  return ledger
}

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

const completed = [{ attemptId, state: 'completed' }]

test('a completed attempt settles through its bound budget under one stable key on every pass', async () => {
  const ledger = ledgerOf([])
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal: journalOf(completed),
    ledger,
  })
  const first = await settlement.settle()
  const second = await settlement.settle()
  expect(first).toEqual({ settled: 1, pending: 0, unbound: 0 })
  expect(second).toEqual(first)
  expect(ledger.calls).toHaveLength(2)
  expect(ledger.calls[0]).toEqual({
    workspaceId,
    executionId,
    reservationKey: budget.reservationKey,
    source: { sourceId: attemptId, idempotencyKey: `${budget.reservationKey}:terminal-settle` },
  })
  expect(ledger.calls[1]).toEqual(ledger.calls[0])
  expect(settlement.blocked).toBe(false)
})

test('an attempt the ledger still refuses is pending and blocks the store until a later pass settles it', async () => {
  const ledger = ledgerOf(['SETTLEMENT_INCOMPLETE', null])
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal: journalOf(completed),
    ledger,
  })
  expect(await settlement.settle()).toEqual({ settled: 0, pending: 1, unbound: 0 })
  expect(settlement.blocked).toBe(true)
  expect(await settlement.settle()).toEqual({ settled: 1, pending: 0, unbound: 0 })
  expect(settlement.blocked).toBe(false)
})

test('an unexpected settlement error propagates and blocks the store until a pass succeeds', async () => {
  const ledger = ledgerOf(['unexpected', null])
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal: journalOf(completed),
    ledger,
  })
  await expect(settlement.settle()).rejects.toThrow('STORE_UNAVAILABLE')
  expect(settlement.blocked).toBe(true)
  expect(await settlement.settle()).toEqual({ settled: 1, pending: 0, unbound: 0 })
  expect(settlement.blocked).toBe(false)
})

test('running records and completed records without a bound budget are left alone', async () => {
  const ledger = ledgerOf([])
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal: journalOf([
      { attemptId, state: 'running' },
      { attemptId: unboundAttemptId, state: 'completed' },
    ]),
    ledger,
  })
  expect(await settlement.settle()).toEqual({ settled: 0, pending: 0, unbound: 1 })
  expect(ledger.calls).toHaveLength(0)
  expect(settlement.blocked).toBe(false)
})

test('close refuses later passes without touching the journal, the ledger, or the database', async () => {
  const ledger = ledgerOf([])
  const journal = journalOf(completed)
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal,
    ledger,
  })
  await settlement.close()
  await expect(settlement.settle()).rejects.toThrow('PI_LEAD_TERMINAL_SETTLEMENT_CLOSED')
  expect(journal.reads).toBe(0)
  expect(ledger.calls).toHaveLength(0)
  expect(settlement.blocked).toBe(false)
})

test('close waits for a running pass before it returns', async () => {
  const release = deferred()
  const ledger = {
    calls: [],
    async settle(input) {
      ledger.calls.push(input)
      await release.promise
      return { releasedMicrounits: 1000, settlement: {} }
    },
  }
  const settlement = new SqlitePiLeadTerminalSettlement({
    database: leadDatabase(),
    journal: journalOf(completed),
    ledger,
  })
  const pass = settlement.settle()
  let closed = false
  const closing = settlement.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(closed).toBe(false)
  release.resolve()
  expect(await pass).toEqual({ settled: 1, pending: 0, unbound: 0 })
  await closing
  expect(closed).toBe(true)
})
