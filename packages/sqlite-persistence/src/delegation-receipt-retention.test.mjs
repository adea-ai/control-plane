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
import {
  delegationReceiptNamespaces,
  delegationReceiptRetentionClass,
  prepareReceiptOwnerPins,
  readDelegationReceiptPins,
  receiptOwnerPinNamespace,
  retainReceiptOwnerPins,
} from './delegation-retention.ts'
import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
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

// Retained the way the writers do: the row and its owner pins in one transaction.
async function seedReceipt(provider, namespace, id, value) {
  await provider.transaction(async (transaction) => {
    await transaction.put({ namespace, id, value })
    await retainReceiptOwnerPins(transaction, namespace, value)
  })
}

// Wraps a provider so each transaction reports what it read from the receipt
// namespaces and the owner pin index.
function measuredProvider(provider) {
  const receiptNamespaces = new Set([...delegationReceiptNamespaces, receiptOwnerPinNamespace])
  const transactions = []
  return {
    transactions,
    provider: {
      async transaction(operation) {
        const stat = { scans: 0, pinGets: 0, otherReceiptGets: 0, startedAt: performance.now() }
        transactions.push(stat)
        try {
          return await provider.transaction((transaction) =>
            operation(
              new Proxy(transaction, {
                get(target, key) {
                  const member = target[key]
                  if (typeof member !== 'function') return member
                  return (namespace, ...rest) => {
                    if (key === 'get' && namespace === receiptOwnerPinNamespace) stat.pinGets += 1
                    else if (key === 'get' && receiptNamespaces.has(namespace))
                      stat.otherReceiptGets += 1
                    else if ((key === 'list' || key === 'scan') && receiptNamespaces.has(namespace))
                      stat.scans += 1
                    return member.call(target, namespace, ...rest)
                  }
                },
              })
            )
          )
        } finally {
          stat.milliseconds = performance.now() - stat.startedAt
        }
      },
    },
  }
}

describe('delegation receipt retention (#1022)', () => {
  test('every delegation namespace the persistence layer writes is classified', () => {
    // Owner-bearing rows were classified when #1022 wired them in; the rest are
    // indexes or sources whose lifecycle other checks already govern. A new
    // `delegation-*` namespace has to be added to one list on purpose.
    const governedElsewhere = new Set([
      'delegation-by-child',
      // The owner pin index the receipt writers maintain.
      'delegation-receipt-owner-pins',
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
    expect([...found].filter((name) => !governedElsewhere.has(name)).toSorted()).toEqual(
      [...delegationReceiptNamespaces].toSorted()
    )
  })

  test('every namespace is assigned an existing class without adding a period', () => {
    expect(Object.keys(delegationReceiptRetentionClass).toSorted()).toEqual(
      [...delegationReceiptNamespaces].toSorted()
    )
    for (const namespace of delegationReceiptNamespaces) {
      const policy = retentionClassPolicy(
        decidedRetentionPolicy,
        delegationReceiptRetentionClass[namespace]
      )
      expect(policy.id).toBe(delegationReceiptRetentionClass[namespace])
    }
    expect(delegationReceiptRetentionClass['delegation-terminal-receipts']).toBe(
      'native-terminal-snapshots'
    )
    for (const namespace of delegationReceiptNamespaces)
      if (namespace !== 'delegation-terminal-receipts')
        expect(
          retentionClassPolicy(decidedRetentionPolicy, delegationReceiptRetentionClass[namespace])
            .retainMs
        ).toBeNull()
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
        await seedReceipt(
          provider,
          namespace,
          storedId(namespace),
          receiptRows[namespace]({ parent: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV' })
        )
        const pinned = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(pinned.deleted).toBe(0)
        expect(pinned.retainedByReason).toEqual({ reference_pending: 2 })
        expect(await executions.getExecution(parentExecutionId)).toBeDefined()
        expect(await executions.getExecution(childExecutionId)).toBeDefined()
      })
      // Without the receipt the same owners are deleted, so the receipt was the pin.
      await withProvider(async (provider) => {
        await seedOwners(provider)
        const released = await new SqliteExecutionRepository(provider).deleteEligibleExecutions(
          retentionNow,
          retentionOptions
        )
        expect(released.deleted).toBe(2)
      })
    })

  test('a damaged receipt still pins the owner it positively identifies', async () => {
    await withProvider(async (provider) => {
      const executions = new SqliteExecutionRepository(provider)
      await seedOwners(provider)
      await seedReceipt(provider, 'delegation-terminal-receipts', 'damaged-terminal-receipt', {
        status: 'pending',
        event: { childExecutionId },
      })
      const result = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
      expect(result.deleted).toBe(1)
      expect(await executions.getExecution(childExecutionId)).toBeDefined()
      expect(await executions.getExecution(parentExecutionId)).toBeUndefined()
    })
  })

  for (const namespace of delegationReceiptNamespaces)
    test(`${namespace} rows retained before the pin index existed pin once swept`, async () => {
      await withProvider(async (provider) => {
        const executions = new SqliteExecutionRepository(provider)
        await seedOwners(provider)
        // A raw write stands in for a row retained by an earlier version.
        await provider.transaction((transaction) =>
          transaction.put({
            namespace,
            id: storedId(namespace),
            value: receiptRows[namespace]({ parent: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
          })
        )
        // A dry run writes nothing, so it reads the legacy rows once and still pins.
        const assessed = await executions.deleteEligibleExecutions(retentionNow, {
          ...retentionOptions,
          dryRun: true,
        })
        expect(assessed.retainedByReason).toEqual({ reference_pending: 2 })
        expect(await provider.transaction((tx) => tx.list(receiptOwnerPinNamespace))).toEqual([])
        // The first applying sweep indexes them once, then pins from the index.
        const pinned = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(pinned.deleted).toBe(0)
        expect(pinned.retainedByReason).toEqual({ reference_pending: 2 })
        expect(
          (await provider.transaction((tx) => tx.list(receiptOwnerPinNamespace))).length
        ).toBeGreaterThan(2)
        const again = await executions.deleteEligibleExecutions(retentionNow, retentionOptions)
        expect(again.retainedByReason).toEqual({ reference_pending: 2 })
      })
    })

  test('candidate lookups do not scan the retained receipts and do not grow with them', async () => {
    const free = 20
    const pinned = 20
    const measurements = []
    for (const retained of [50, 1_500]) {
      await withProvider(async (provider) => {
        // Unrelated receipts in every namespace, retained the way the writers do.
        await provider.transaction(async (transaction) => {
          for (let index = 0; index < retained; index += 1) {
            const namespace =
              delegationReceiptNamespaces[index % delegationReceiptNamespaces.length]
            const value = {
              parentExecutionId: `exe_unrelated_parent_${index}`,
              childExecutionId: `exe_unrelated_child_${index}`,
              request: { executionId: `exe_unrelated_child_${index}` },
              event: {
                parentExecutionId: `exe_unrelated_parent_${index}`,
                childExecutionId: `exe_unrelated_child_${index}`,
              },
            }
            await transaction.put({ namespace, id: `filler-${index}`, value })
            await retainReceiptOwnerPins(transaction, namespace, value)
          }
          for (let index = 0; index < free + pinned; index += 1) {
            const executionId = `exe_${'0'.repeat(23)}${String(index).padStart(3, '0')}`
            await transaction.put({
              namespace: 'executions',
              id: storedId(executionId),
              value: terminalExecution(executionId, 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
            })
            if (index < pinned) {
              const value = { parentExecutionId: executionId, childExecutionId: executionId }
              await transaction.put({
                namespace: 'delegation-child-mappings',
                id: `candidate-${index}`,
                value,
              })
              await retainReceiptOwnerPins(transaction, 'delegation-child-mappings', value)
            }
          }
        })
        // The one-time index step is part of preparing a sweep, not of a candidate.
        await prepareReceiptOwnerPins(provider, { dryRun: false })
        const measured = measuredProvider(provider)
        const result = await new SqliteExecutionRepository(
          measured.provider
        ).deleteEligibleExecutions(retentionNow, { ...retentionOptions, bound: 64 })
        expect(result.deleted).toBe(free)
        expect(result.retainedByReason).toEqual({ reference_pending: pinned })
        for (const stat of measured.transactions) {
          expect(stat.scans).toBe(0)
          expect(stat.otherReceiptGets).toBe(0)
          expect(stat.pinGets).toBeLessThanOrEqual(1)
        }
        measurements.push({
          retained,
          pinGets: measured.transactions.reduce((sum, stat) => sum + stat.pinGets, 0),
          transactions: measured.transactions.length,
          slowestMilliseconds: Math.max(...measured.transactions.map((stat) => stat.milliseconds)),
        })
      })
    }
    // 30 times more retained receipts, identical receipt reads.
    expect(measurements[1].pinGets).toBe(measurements[0].pinGets)
    expect(measurements[1].transactions).toBe(measurements[0].transactions)
    // One pin read per candidate, plus the sweep's single marker read.
    expect(measurements[0].pinGets).toBe(free + pinned + 1)
    console.info('receipt retention lock measurements', JSON.stringify(measurements))
  }, 120000)

  test('plan candidates read one pin and never scan the retained receipts', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await new SqliteContextPackageRepository(provider).put(
        contextPackageSerializationFixtures.futurePi
      )
      await plans.put(plan)
      await provider.transaction(async (transaction) => {
        for (let index = 0; index < 1_000; index += 1) {
          const value = {
            request: {
              parentPlan: { executionPlanId: `pln_unrelated_${index}` },
              childPlan: { executionPlanId: `pln_unrelated_child_${index}` },
            },
          }
          await transaction.put({
            namespace: 'delegation-admission-receipts',
            id: `filler-${index}`,
            value,
          })
          await retainReceiptOwnerPins(transaction, 'delegation-admission-receipts', value)
        }
      })
      await prepareReceiptOwnerPins(provider, { dryRun: false })
      const measured = measuredProvider(provider)
      const deadline = new Date(Date.parse(plan.compiledAt) + 3 * ninetyDaysMs + 60_000)
      await new SqliteExecutionPlanRepository(measured.provider).deleteEligibleExecutionPlans(
        deadline,
        retentionOptions
      )
      const reads = measured.transactions.filter((stat) => stat.pinGets > 0)
      expect(reads.length).toBeGreaterThan(0)
      for (const stat of measured.transactions) {
        expect(stat.scans).toBe(0)
        expect(stat.pinGets).toBeLessThanOrEqual(1)
      }
    })
  })

  for (const namespace of ['delegation-admission-receipts', 'delegation-runtime-lookups'])
    test(`${namespace} pins the plans it names`, async () => {
      await withProvider(async (provider) => {
        const plans = new SqliteExecutionPlanRepository(provider)
        const plan = createExecutionPlanTestFixture()
        await new SqliteContextPackageRepository(provider).put(
          contextPackageSerializationFixtures.futurePi
        )
        await plans.put(plan)
        const deadline = new Date(Date.parse(plan.compiledAt) + 3 * ninetyDaysMs + 60_000)
        const control = await plans.deleteEligibleExecutionPlans(deadline, {
          ...retentionOptions,
          dryRun: true,
        })
        expect(control.retainedByReason).toEqual({ not_expired: 1 })
        await seedReceipt(
          provider,
          namespace,
          storedId(namespace),
          receiptRows[namespace]({ parent: plan.executionPlanId, child: plan.executionPlanId })
        )
        const pinned = await plans.deleteEligibleExecutionPlans(deadline, retentionOptions)
        expect(pinned.deleted).toBe(0)
        expect(pinned.retainedByReason).toEqual({ reference_pending: 1 })
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
      const owners = [ids.parentExecutionId, child.request.childExecutionId].toSorted()
      const planIds = [
        f.canonicalParentPlan.executionPlanId,
        child.childPlan.executionPlanId,
      ].toSorted()
      for (const [namespace, expectedPlans] of [
        ['delegation-admission-receipts', planIds],
        ['delegation-child-mappings', []],
        ['delegation-native-sessions', []],
        ['delegation-terminal-receipts', []],
      ]) {
        const pins = await f.provider.transaction((transaction) =>
          readDelegationReceiptPins(transaction, [namespace])
        )
        expect([...pins.executionIds].toSorted()).toEqual(owners)
        expect([...pins.planIds].toSorted()).toEqual(expectedPlans)
      }
      // The writers' own pin index agrees with a full scan of what they retained.
      const scanned = await f.provider.transaction(readDelegationReceiptPins)
      const indexed = await f.provider.transaction((transaction) =>
        transaction.list(receiptOwnerPinNamespace)
      )
      const indexedIdentities = (kind) =>
        indexed
          .filter((row) => row.value.kind === kind)
          .map((row) => row.value.identity)
          .toSorted()
      expect(indexedIdentities('execution')).toEqual([...scanned.executionIds].toSorted())
      expect(indexedIdentities('plan')).toEqual([...scanned.planIds].toSorted())
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
