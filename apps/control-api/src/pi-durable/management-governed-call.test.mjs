import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  createPiDurableGovernedManagementCall,
  piDurableManagementRequestDigest,
  SqlitePiDurableManagementCallStore,
} from './management-governed-call.ts'
import { managementCanonicalRequestDigest } from './management-decision-issuer.ts'

const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const TARGET = 'prj_01JABCDEF0123456789ABCDEFG'
const PRINCIPAL = 'user:0f3a2e1c-0000-4000-8000-0000000000bb'

const approval = {
  allowedPrincipalIds: [PRINCIPAL],
  expiresAt: '2026-10-09T12:02:00.000Z',
  interactionId: 'int_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T11:59:00.000Z',
}
const baseRequest = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  audit: { principalRef: PRINCIPAL, traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  grant: {
    operations: ['project.update'],
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
    toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
    workspaceId: WORKSPACE,
  },
  idempotencyKey: 'lead:management:project.update:1',
  input: { name: 'Renamed' },
  operation: 'project.update',
  policySnapshotRef: 'policy://fixture',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  requestedAt: '2026-10-09T12:00:00.000Z',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
  toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
  workspaceId: WORKSPACE,
}

function memoryStore() {
  const records = new Map()
  return {
    records,
    async get(key) {
      return records.get(key)
    },
    async insert(record) {
      if (records.has(record.key)) return false
      records.set(record.key, record)
      return true
    },
    async compareAndSet(expectedRevision, record) {
      const current = records.get(record.key)
      if (!current || current.revision !== expectedRevision) return false
      records.set(record.key, record)
      return true
    },
  }
}

function harness(options = {}) {
  const counts = options.counts ?? { calls: 0, issued: 0 }
  const boundaries = []
  const store = options.store ?? memoryStore()
  const snapshots = []
  const caller = createPiDurableGovernedManagementCall({
    authority: {
      async assertCurrent(request, boundary) {
        boundaries.push(boundary)
        if (options.failBoundary === boundary) throw new Error('TEST_AUTHORITY_DENIED')
      },
    },
    store,
    async issue({ request, targetId }) {
      counts.issued += 1
      snapshots.push({ frozen: Object.isFrozen(request), request, targetId })
      const digest = options.wrongDigest
        ? `sha256:${'0'.repeat(64)}`
        : piDurableManagementRequestDigest(request)
      return {
        canonicalRequestDigest: digest,
        decision: `decision-jwt-${counts.issued}`,
        decisionId: `decision-${counts.issued}`,
        expiresAt: '2026-10-09T12:02:00.000Z',
      }
    },
    async callAdea(input) {
      counts.calls += 1
      if (options.dispatchGate) await options.dispatchGate.promise
      if (options.transportThrows) throw new Error('TEST_TRANSPORT_UNKNOWN')
      if (options.inspectRetained) options.inspectRetained(store, input)
      return options.refusal ?? { ok: true, value: { id: TARGET } }
    },
    resolveTargetId: () => TARGET,
  })
  return { boundaries, caller, counts, snapshots, store }
}

test('retains one frozen snapshot and one decision, validates every boundary, dispatches once', async () => {
  const request = { ...baseRequest, approval }
  const run = harness()
  expect(await run.caller.execute(request)).toEqual({
    state: 'succeeded',
    value: { id: TARGET },
  })
  expect(run.boundaries).toEqual(['admission', 'approval', 'effect'])
  expect(run.snapshots).toHaveLength(1)
  expect(run.snapshots[0].frozen).toBe(true)
  expect(run.snapshots[0].request).toEqual(request)
  expect(run.snapshots[0].request).not.toBe(request)
  expect(piDurableManagementRequestDigest(request)).toBe(managementCanonicalRequestDigest(request))
  expect(run.counts).toEqual({ calls: 1, issued: 1 })
})

test('retains the exact decision before dispatch', async () => {
  const request = { ...baseRequest, approval }
  const run = harness({
    inspectRetained(store, input) {
      const record = [...store.records.values()][0]
      expect(record.decision).toBe(input.decision)
      expect(record.decisionId).toBe('decision-1')
      expect(record.state).toBe('invoking')
    },
  })
  await run.caller.execute(request)
})

test('concurrent identical calls mint one decision and make one physical call', async () => {
  const request = { ...baseRequest, approval }
  let release
  const dispatchGate = { promise: new Promise((resolve) => (release = resolve)) }
  const run = harness({ dispatchGate })
  const first = run.caller.execute(request)
  await Promise.resolve()
  const duplicates = await Promise.all([run.caller.execute(request), run.caller.execute(request)])
  expect(duplicates).toEqual([
    { code: 'PI_MANAGEMENT_EFFECT_UNKNOWN', state: 'reconciliation_required' },
    { code: 'PI_MANAGEMENT_EFFECT_UNKNOWN', state: 'reconciliation_required' },
  ])
  release()
  expect(await first).toEqual({ state: 'succeeded', value: { id: TARGET } })
  expect(run.counts).toEqual({ calls: 1, issued: 1 })
  const repeated = await run.caller.execute(request)
  expect(repeated).toEqual({ state: 'succeeded', value: { id: TARGET } })
  expect(run.counts).toEqual({ calls: 1, issued: 1 })
})

test('reopen after an unknown response yields no fresh decision and no second call', async () => {
  const request = { ...baseRequest, approval }
  const store = memoryStore()
  const counts = { calls: 0, issued: 0 }
  const first = harness({ store, counts, transportThrows: true })
  expect(await first.caller.execute(request)).toEqual({
    code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
    state: 'reconciliation_required',
  })
  expect(counts).toEqual({ calls: 1, issued: 1 })
  const reopened = harness({ store, counts })
  expect(await reopened.caller.execute(request)).toEqual({
    code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
    state: 'reconciliation_required',
  })
  expect(counts).toEqual({ calls: 1, issued: 1 })
})

test('repeat after success reuses the retained outcome with no fresh decision', async () => {
  const request = { ...baseRequest, approval }
  const store = memoryStore()
  const counts = { calls: 0, issued: 0 }
  const first = harness({ store, counts })
  expect(await first.caller.execute(request)).toEqual({
    state: 'succeeded',
    value: { id: TARGET },
  })
  const reopened = harness({ store, counts })
  expect(await reopened.caller.execute(request)).toEqual({
    state: 'succeeded',
    value: { id: TARGET },
  })
  expect(counts).toEqual({ calls: 1, issued: 1 })
})

test('the retained record survives a real file-backed close/reopen and still yields one effect', async () => {
  const request = { ...baseRequest, approval }
  const directory = mkdtempSync(join(tmpdir(), 'pi-management-retained-'))
  const path = join(directory, 'journal.sqlite')
  const counts = { calls: 0, issued: 0 }
  try {
    const firstDatabase = new DatabaseSync(path)
    const firstStore = new SqlitePiDurableManagementCallStore(firstDatabase)
    const first = harness({ store: firstStore, counts, transportThrows: true })
    expect(await first.caller.execute(request)).toEqual({
      code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
      state: 'reconciliation_required',
    })
    // Close the writer connection before reopening a NEW connection.
    firstDatabase.close()

    const reopenedDatabase = new DatabaseSync(path)
    const reopenedStore = new SqlitePiDurableManagementCallStore(reopenedDatabase)
    const reopened = harness({ store: reopenedStore, counts })
    expect(await reopened.caller.execute(request)).toEqual({
      code: 'PI_MANAGEMENT_EFFECT_UNKNOWN',
      state: 'reconciliation_required',
    })
    expect(counts).toEqual({ calls: 1, issued: 1 })
    const retained = await reopenedStore.get(JSON.stringify([WORKSPACE, request.idempotencyKey]))
    expect(retained?.decision).toBe('decision-jwt-1')
    expect(retained?.state).toBe('settled')
    reopenedDatabase.close()
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('the same identity with a different request digest is refused before dispatch', async () => {
  const request = { ...baseRequest, approval }
  const store = memoryStore()
  const counts = { calls: 0, issued: 0 }
  const first = harness({ store, counts })
  await first.caller.execute(request)
  const changed = { ...request, input: { name: 'Other' } }
  const second = harness({ store, counts })
  expect(await second.caller.execute(changed)).toEqual({
    code: 'authority_binding_mismatch',
    state: 'refused',
  })
  expect(counts).toEqual({ calls: 1, issued: 1 })
})

test('a decision that does not bind the exact request digest never reaches Adea', async () => {
  const run = harness({ wrongDigest: true })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'authority_binding_mismatch',
    state: 'refused',
  })
  expect(run.counts).toEqual({ calls: 0, issued: 1 })
})

test('an authority failure refuses before any decision, claim or dispatch', async () => {
  const run = harness({ failBoundary: 'admission' })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'authority_unavailable',
    state: 'refused',
  })
  expect(run.counts).toEqual({ calls: 0, issued: 0 })
  expect(run.store.records.size).toBe(0)
})

test('maps a typed Adea refusal without masking the reason', async () => {
  const run = harness({
    refusal: {
      code: 'LEAD_MANAGEMENT_REFUSED',
      ok: false,
      operation: 'project.update',
      reason: 'authority_replay',
    },
  })
  expect(await run.caller.execute(baseRequest)).toEqual({
    code: 'LEAD_MANAGEMENT_REFUSED',
    reason: 'authority_replay',
    state: 'refused',
  })
})

test('bounds oversize, deep and cyclic requests before any clone or callback', async () => {
  const run = harness()
  const oversizeInput = { blob: 'x'.repeat(200_000) }
  const hugeKeyInput = { ['k'.repeat(200_000)]: 1 }
  let deepInput = { leaf: 'x' }
  for (let i = 0; i < 40; i += 1) deepInput = { next: deepInput }
  const cyclicInput = { name: 'Renamed' }
  cyclicInput.self = cyclicInput
  for (const input of [oversizeInput, hugeKeyInput, deepInput, cyclicInput]) {
    await expect(run.caller.execute({ ...baseRequest, input })).rejects.toThrow(
      'PI_MANAGEMENT_CALL_INVALID'
    )
  }
  expect(run.boundaries).toEqual([])
  expect(run.counts).toEqual({ calls: 0, issued: 0 })
  expect(run.store.records.size).toBe(0)
})

test('rejects a malformed retained request before any store or callback', async () => {
  const run = harness()
  await expect(run.caller.execute({ operation: 'project.update' })).rejects.toThrow(
    'PI_MANAGEMENT_CALL_INVALID'
  )
  expect(run.boundaries).toEqual([])
  expect(run.counts).toEqual({ calls: 0, issued: 0 })
})
