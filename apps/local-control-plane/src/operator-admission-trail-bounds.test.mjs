import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { ControlApiFixtures, canonicalJsonStringify } from '@control-plane/contracts'
import { LocalAdmissionControlService } from './operator-admission-control-service.ts'
import {
  MAX_OUTCOME_SCAN_ROWS,
  applyAdmissionControl,
  getWorkflowAdmissionStop,
  listWorkflowAdmissionOutcomes,
  readWorkflowAdmissionOutcomeTrail,
} from './operator-admission-controls.ts'

// Server clock for the audit proofs; the caller-declared issuedAt is deliberately far away.
const SERVER_NOW = '2026-10-10T03:00:00.000Z'
const CALLER_ISSUED_AT = '2000-01-01T00:00:00.000Z'
const WORKSPACE = ControlApiFixtures.executionAcceptance.request.workspaceId
const SCOPE = { kind: 'workspace', workspaceId: WORKSPACE }
const PRINCIPAL = {
  kind: 'agent_hq_service',
  principalId: 'svc_trail-bounds-test',
  projectIds: ['prj_01JABCDEF0123456789ABCDEFG'],
  scopes: ['execution:admission'],
  workspaceIds: [WORKSPACE],
}
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Deterministic Crockford-style command identifiers: cmd_ + 26 characters. */
function commandId(index) {
  let value = index
  let suffix = ''
  for (let position = 0; position < 26; position++) {
    suffix = ALPHABET[value % 32] + suffix
    value = Math.floor(value / 32)
  }
  return `cmd_${suffix}`
}

/** A faithful in-memory provider: the real port shape, including the 1..128 scan limit. */
function inMemoryProvider() {
  const namespaces = new Map()
  const table = (name) => {
    if (!namespaces.has(name)) namespaces.set(name, new Map())
    return namespaces.get(name)
  }
  const stats = { scanCalls: 0, scanRows: 0 }
  const transaction = {
    async get(namespace, id) {
      return table(namespace).get(id)
    },
    async put(write) {
      const records = table(write.namespace)
      const prior = records.get(write.id)
      const record = {
        namespace: write.namespace,
        id: write.id,
        revision: (prior?.revision ?? 0) + 1,
        value: write.value,
        updatedAt: SERVER_NOW,
      }
      records.set(write.id, record)
      return record
    },
    async delete(namespace, id) {
      return table(namespace).delete(id)
    },
    async list(namespace) {
      return [...table(namespace).values()]
    },
    async scan(namespace, { afterId, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
        throw new Error('scan limit out of range')
      }
      stats.scanCalls += 1
      const ids = [...table(namespace).keys()].toSorted()
      const start = afterId === undefined ? 0 : ids.findIndex((id) => id > afterId)
      if (start < 0) return []
      const page = ids.slice(start, start + limit).map((id) => table(namespace).get(id))
      stats.scanRows += page.length
      return page
    },
  }
  return {
    provider: { transaction: (operation) => operation(transaction) },
    stats,
    reset() {
      stats.scanCalls = 0
      stats.scanRows = 0
    },
  }
}

function stopCommand(index, overrides = {}) {
  const base = ControlApiFixtures.executionAcceptance.request
  const payload = { reasonClass: 'incident_response', reason: 'Trail bounds proof' }
  return {
    ...base,
    operation: 'execution.admission-stop',
    commandId: commandId(index),
    issuedAt: CALLER_ISSUED_AT,
    idempotencyKey: `trail-bounds-${index}`,
    payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    payload,
    ...overrides,
  }
}

test('audit time is the server clock: a caller-declared issuedAt never becomes the operator action time', async () => {
  const { provider } = inMemoryProvider()
  const service = new LocalAdmissionControlService({ persistence: provider, now: () => SERVER_NOW })

  const first = await service.stop(stopCommand(1), PRINCIPAL)
  expect(first.data.outcome).toBe('applied')

  const [audited] = await listWorkflowAdmissionOutcomes(provider, SCOPE)
  expect(audited.at).toBe(SERVER_NOW)
  expect(audited.at).not.toBe(CALLER_ISSUED_AT)
  expect((await getWorkflowAdmissionStop(provider, SCOPE)).stoppedAt).toBe(SERVER_NOW)

  // Replaying the same command with a different declared issuedAt returns the original receipt.
  const replay = await service.stop(
    stopCommand(1, { issuedAt: '2099-01-01T00:00:00.000Z' }),
    PRINCIPAL
  )
  expect(replay.data.outcome).toBe('replayed')
  expect(await listWorkflowAdmissionOutcomes(provider, SCOPE)).toHaveLength(1)
})

test('an outcome trail read is bounded: a budget-exhausted read is explicitly incomplete, never a silent window', async () => {
  const memory = inMemoryProvider()
  const { provider, stats } = memory
  for (let index = 0; index < 300; index++) {
    await applyAdmissionControl(provider, 'stop', {
      actor: PRINCIPAL,
      scope: SCOPE,
      commandId: commandId(index),
      reasonClass: 'incident_response',
      at: SERVER_NOW,
    })
  }
  memory.reset()

  const bounded = await readWorkflowAdmissionOutcomeTrail(provider, SCOPE, {
    limit: 1,
    maxRows: 200,
  })
  expect(bounded).toEqual({
    status: 'incomplete',
    reason: 'row_budget_reached',
    records: [],
    scannedRows: 200,
    rowBudget: 200,
  })
  // Exactly the budget was read: pages of 128 then 72, never the whole 300-row trail.
  expect(stats.scanCalls).toBe(2)
  expect(stats.scanRows).toBe(200)
})

test('a read within the budget is complete and returns the newest outcomes, oldest first', async () => {
  const memory = inMemoryProvider()
  const { provider, stats } = memory
  for (let index = 0; index < 300; index++) {
    await applyAdmissionControl(provider, 'stop', {
      actor: PRINCIPAL,
      scope: SCOPE,
      commandId: commandId(index),
      reasonClass: 'incident_response',
      at: SERVER_NOW,
    })
  }
  memory.reset()
  const trail = await readWorkflowAdmissionOutcomeTrail(provider, SCOPE, { limit: 5 })
  expect(trail.status).toBe('complete')
  expect(trail.scannedRows).toBe(300)
  expect(trail.records).toHaveLength(5)
  expect(stats.scanRows).toBe(300)
  const ordered = trail.records.map((record) => record.commandId)
  expect(ordered).toEqual([...ordered].toSorted())
})

test('the list API stays compatible for complete trails and refuses to pretend an incomplete one is complete', async () => {
  const { provider } = inMemoryProvider()
  for (let index = 0; index < 50; index++) {
    await applyAdmissionControl(provider, 'stop', {
      actor: PRINCIPAL,
      scope: SCOPE,
      commandId: commandId(index),
      reasonClass: 'incident_response',
      at: SERVER_NOW,
    })
  }
  expect(await listWorkflowAdmissionOutcomes(provider, SCOPE, 3)).toHaveLength(3)
})

test('invalid trail budgets and limits fail closed before any read', async () => {
  const { provider, stats } = inMemoryProvider()
  for (const maxRows of [0, -1, 1.5, MAX_OUTCOME_SCAN_ROWS + 1]) {
    await expect(readWorkflowAdmissionOutcomeTrail(provider, SCOPE, { maxRows })).rejects.toThrow(
      'ADMISSION_CONTROL_LIMIT_INVALID'
    )
  }
  await expect(readWorkflowAdmissionOutcomeTrail(provider, SCOPE, { limit: 0 })).rejects.toThrow(
    'ADMISSION_CONTROL_LIMIT_INVALID'
  )
  expect(stats.scanCalls).toBe(0)
})
