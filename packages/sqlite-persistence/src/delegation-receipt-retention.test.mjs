import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DelegationService } from '@control-plane/orchestration'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from './index.js'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { delegationReceiptNamespaces, readDelegationReceiptPins } from './delegation-retention.ts'
import { fixture, ids } from './child-allocation-fixture.mjs'
import { sweepSqliteRetention, snapshotNamespaces } from './retention-sweep.fixture.mjs'

const parentExecutionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const childExecutionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const acceptedAt = '2026-05-01T10:00:00.000Z'
const terminalAt = '2026-05-02T10:00:00.000Z'
const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
const retentionNow = new Date(Date.parse(terminalAt) + ninetyDaysMs + 1_000)
const retentionOptions = { policyRetainMs: ninetyDaysMs, dryRun: false }

function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-delegation-receipt-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function terminalExecution(executionId, executionPlanId) {
  return {
    executionId,
    state: 'completed',
    version: 2,
    correlation: {
      workspaceId,
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: { executionPlanId, contentDigest: `sha256:${'b'.repeat(64)}`, schemaVersion: 1 },
    attemptCount: 0,
    acceptedAt,
    terminalAt,
    createdAt: acceptedAt,
    updatedAt: terminalAt,
  }
}

async function seedOwners(provider) {
  await provider.transaction(async (transaction) => {
    for (const executionId of [parentExecutionId, childExecutionId])
      await transaction.put({
        namespace: 'executions',
        id: storedId(executionId),
        value: terminalExecution(executionId, 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      })
  })
}

// Minimal rows that name their owners the way the real writers do. The real
// shapes are exercised against the actual writers further down.
const receiptRows = {
  'delegation-admission-receipts': (plans = {}) => ({
    request: {
      parentExecutionId,
      childExecutionId,
      ...(plans.parent ? { parentPlan: { executionPlanId: plans.parent } } : {}),
      ...(plans.child ? { childPlan: { executionPlanId: plans.child } } : {}),
    },
    receipt: { parentExecutionId, childExecutionId },
  }),
  'delegation-child-mappings': () => ({ parentExecutionId, childExecutionId }),
  'delegation-native-sessions': () => ({ parentExecutionId, childExecutionId }),
  'delegation-runtime-lookups': (plans = {}) => ({
    parentExecutionId,
    childExecutionId,
    request: {
      executionId: childExecutionId,
      ...(plans.child ? { executionPlan: { executionPlanId: plans.child } } : {}),
    },
  }),
  'delegation-terminal-receipts': () => ({
    status: 'pending',
    event: { parentExecutionId, childExecutionId },
  }),
}

describe('delegation receipt retention (#1022)', () => {
  test('every delegation namespace the persistence layer writes is classified', () => {
    // Owner-bearing rows were classified when #1022 wired them in; the rest are
    // indexes or sources whose lifecycle other checks already govern. A new
    // `delegation-*` namespace has to be added to one list on purpose.
    const governedElsewhere = new Set([
      'delegation-by-child',
      'delegation-publications',
      'delegation-tool-admissions-',
      'delegation-tool-call-admissions-',
      'delegation-tool-sources-',
    ])
    const sourceDirectory = new URL('.', import.meta.url)
    const found = new Set()
    for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, sourceDirectory), 'utf8')
      for (const match of source.matchAll(/['`](delegation-[a-z-]+)['`$]/g)) found.add(match[1])
    }
    expect([...found].filter((name) => !governedElsewhere.has(name)).sort()).toEqual(
      [...delegationReceiptNamespaces].sort()
    )
  })

  for (const namespace of delegationReceiptNamespaces)
    test(`${namespace} alone pins both owning executions through retention`, async () => {
      await withProvider(async (provider) => {
        const executions = new SqliteExecutionRepository(provider)
        await seedOwners(provider)
        const control = await executions.deleteEligibleExecutions(retentionNow, {
          ...retentionOptions,
          dryRun: true,
        })
        expect(control.retainedByReason).toEqual({})
        expect(control.deleted).toBe(0)
        await provider.transaction((transaction) =>
          transaction.put({
            namespace,
            id: storedId(namespace),
            value: receiptRows[namespace]({ parent: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
          })
        )
        const pinned = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(pinned.deleted).toBe(0)
        expect(pinned.retainedByReason).toEqual({ reference_pending: 2 })
        expect(await executions.getExecution(parentExecutionId)).toBeDefined()
        expect(await executions.getExecution(childExecutionId)).toBeDefined()
        await provider.transaction((transaction) =>
          transaction.delete(namespace, storedId(namespace))
        )
        const released = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(released.deleted).toBe(2)
      })
    })

  test('a damaged receipt still pins the owner it positively identifies', async () => {
    await withProvider(async (provider) => {
      const executions = new SqliteExecutionRepository(provider)
      await seedOwners(provider)
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'delegation-terminal-receipts',
          id: 'damaged-terminal-receipt',
          value: { status: 'pending', event: { childExecutionId } },
        })
      )
      const result = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
      expect(result.deleted).toBe(1)
      expect(await executions.getExecution(childExecutionId)).toBeDefined()
      expect(await executions.getExecution(parentExecutionId)).toBeUndefined()
    })
  })

  for (const namespace of ['delegation-admission-receipts', 'delegation-runtime-lookups'])
    test(`${namespace} pins the plans it names until released`, async () => {
      await withProvider(async (provider) => {
        const plans = new SqliteExecutionPlanRepository(provider)
        const plan = createExecutionPlanTestFixture()
        await new SqliteContextPackageRepository(provider).put(
          contextPackageSerializationFixtures.futurePi
        )
        await plans.put(plan)
        const deadline = new Date(Date.parse(plan.compiledAt) + 3 * ninetyDaysMs + 60_000)
        const id = storedId(namespace)
        await provider.transaction((transaction) =>
          transaction.put({
            namespace,
            id,
            value: receiptRows[namespace]({
              parent: plan.executionPlanId,
              child: plan.executionPlanId,
            }),
          })
        )
        const pinned = await plans.deleteEligibleExecutionPlans(deadline, retentionOptions)
        expect(pinned.deleted).toBe(0)
        expect(pinned.retainedByReason).toEqual({ reference_pending: 1 })
        await provider.transaction((transaction) => transaction.delete(namespace, id))
        // Release restarts the existing reference window; no new period applies.
        const released = await plans.deleteEligibleExecutionPlans(deadline, retentionOptions)
        expect(released.deleted).toBe(0)
        expect(released.retainedByReason).toEqual({ not_expired: 1 })
        const expired = await plans.deleteEligibleExecutionPlans(
          new Date(deadline.getTime() + ninetyDaysMs + 1),
          retentionOptions
        )
        expect(expired.deleted).toBe(1)
      })
    })

  test('real admission, mapping, session and pending terminal receipts survive every sweep and a restart', async () => {
    const f = await fixture()
    let reopened
    try {
      const child = await f.childAdmission()
      await child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => undefined,
      })
      const delegations = new SqliteDelegationRepository(f.provider)
      let crashPublication = false
      const service = new DelegationService({
        delegations,
        lifecycle: new ExecutionLifecycleService(new SqliteExecutionRepository(f.provider)),
        plans: new SqliteExecutionPlanRepository(f.provider),
        events: {
          async publish() {
            if (crashPublication) throw new Error('crash before publication')
          },
        },
      })
      const { delegationId } = child.childIds
      await service.dispatchChild(child.request.childDispatch)
      await service.recordChildProgress({
        delegationId,
        childAttemptId: child.request.childAttemptId,
        state: 'running',
        observedAt: '2026-10-09T12:00:10.000Z',
      })
      const mapping = {
        ...(await delegations.getChildMapping(child.request.childAttemptId)),
        externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
      }
      await delegations.bindChildSession((await delegations.get(delegationId)).revision, mapping)
      crashPublication = true
      await expect(
        service.recordChildProgress({
          delegationId,
          childAttemptId: child.request.childAttemptId,
          state: 'completed',
          observedAt: '2026-10-09T12:03:00.000Z',
          terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
        })
      ).rejects.toThrow('crash before publication')
      expect((await delegations.getTerminalReceipt(delegationId)).status).toBe('pending')

      // The lead finishes too, so both owners are old enough to be candidates.
      await f.provider.transaction(async (transaction) => {
        for (const [namespace, identity] of [
          ['executions', ids.parentExecutionId],
          ['execution-attempts', ids.parentAttemptId],
        ]) {
          const row = await transaction.get(namespace, storedId(identity))
          await transaction.put({
            namespace,
            id: row.id,
            expectedRevision: row.revision,
            value: { ...row.value, state: 'completed', terminalAt: '2026-10-09T12:04:00.000Z' },
          })
        }
      })
      const receiptNamespaces = delegationReceiptNamespaces
      const retained = await snapshotNamespaces(f.provider, [
        ...receiptNamespaces,
        'delegations',
        'executions',
        'execution-attempts',
        'execution-plans',
      ])
      expect(retained['delegation-admission-receipts']).toHaveLength(1)
      expect(retained['delegation-child-mappings']).toHaveLength(1)
      expect(retained['delegation-native-sessions']).toHaveLength(1)
      expect(retained['delegation-terminal-receipts']).toHaveLength(1)
      // Each real row names its owners where the pin reader looks, so the pins are
      // not an artefact of the hand-built rows above.
      const owners = [ids.parentExecutionId, child.request.childExecutionId].sort()
      const planIds = [
        f.canonicalParentPlan.executionPlanId,
        child.childPlan.executionPlanId,
      ].sort()
      for (const [namespace, expectedPlans] of [
        ['delegation-admission-receipts', planIds],
        ['delegation-child-mappings', []],
        ['delegation-native-sessions', []],
        ['delegation-terminal-receipts', []],
      ]) {
        const pins = await f.provider.transaction((transaction) =>
          readDelegationReceiptPins(transaction, [namespace])
        )
        expect([...pins.executionIds].sort()).toEqual(owners)
        expect([...pins.planIds].sort()).toEqual(expectedPlans)
      }
      const future = new Date('2030-01-01T00:00:00.000Z')

      await sweepSqliteRetention(f.provider, future)
      expect(await snapshotNamespaces(f.provider, Object.keys(retained))).toEqual(retained)

      // Remove the other delegation records: the receipts alone still pin the
      // owners and their plans. Nothing is restored afterwards, so this is the
      // state the sweeps see.
      await f.provider.transaction(async (transaction) => {
        for (const namespace of ['delegations', 'delegation-by-child'])
          for (const row of await transaction.list(namespace))
            await transaction.delete(namespace, row.id, row.revision)
      })
      const receiptsOnly = await snapshotNamespaces(f.provider, [
        ...receiptNamespaces,
        'executions',
        'execution-attempts',
        'execution-plans',
      ])
      const results = await sweepSqliteRetention(f.provider, future)
      expect(results.executions.deleted).toBe(0)
      expect(results.executions.retainedByReason.reference_pending).toBeGreaterThan(0)
      expect(results['execution-plans'].deleted).toBe(0)
      expect(await snapshotNamespaces(f.provider, Object.keys(receiptsOnly))).toEqual(receiptsOnly)

      // Restart: a fresh connection still reads every retained receipt exactly.
      await f.provider.close()
      reopened = new SqlitePersistenceProvider({ path: join(f.directory, 'state.sqlite') })
      await reopened.migrate()
      expect(await snapshotNamespaces(reopened, Object.keys(receiptsOnly))).toEqual(receiptsOnly)
      const reread = new SqliteDelegationRepository(reopened)
      expect((await reread.getAdmissionReceipt(delegationId)).request.childExecutionId).toBe(
        child.request.childExecutionId
      )
      expect(await reread.getChildMapping(child.request.childAttemptId)).toEqual(mapping)
      expect(
        await reread.findChildBySession(mapping.runtimeConnectionId, mapping.externalSessionId)
      ).toEqual(mapping)
    } finally {
      await reopened?.close()
      await f.close()
    }
  }, 60000)

  test('pin reads ignore rows that name no owner', async () => {
    await withProvider(async (provider) => {
      await provider.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'delegation-child-mappings',
          id: 'unidentified',
          value: { unrelated: true },
        })
        const pins = await readDelegationReceiptPins(transaction)
        expect(pins.executionIds.size).toBe(0)
        expect(pins.planIds.size).toBe(0)
      })
    })
  })
})
