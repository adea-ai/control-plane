import { expect, test } from 'bun:test'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { recordId } from '../packages/sqlite-persistence/src/record-storage.ts'
import { CanonicalDelegationRuntimeBridge } from '../packages/orchestration/src/delegation-runtime.ts'
import { ExecutionLifecycleService } from '@control-plane/domain'
import {
  SqliteDelegationRepository,
  SqlitePersistenceProvider,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
} from '@control-plane/sqlite-persistence'
import {
  snapshotNamespaces,
  sqliteRetentionSweeps,
} from '../packages/sqlite-persistence/src/retention-sweep.fixture.mjs'
import { retentionClasses } from '../scripts/retention-classes.mjs'
import { sweepRegisteredRetentionClasses } from './retention-registry-sweep.fixture.mjs'
import {
  delegationReceiptNamespaces,
  delegationReceiptRetentionClass,
} from '../packages/sqlite-persistence/src/delegation-retention.ts'
import {
  missingPins,
  pinSources,
} from '../packages/sqlite-persistence/src/receipt-pin-sources.fixture.mjs'
import { receiptOwnerPinNamespace } from '../packages/sqlite-persistence/src/delegation-retention.ts'
import { withChildMappingRecovery } from './pi-durable-child-mapping-recovery.fixture.mjs'

test('the package sweep list mirrors the operator retention registry', () => {
  expect(
    Object.fromEntries(
      Object.entries(retentionClasses)
        .filter(([, entry]) => entry.sqlite !== null)
        .map(([classId, entry]) => [classId, [entry.sqlite, entry.apply]])
    )
  ).toEqual(sqliteRetentionSweeps)
})

test('the receipt classes have no registered deletion path yet', () => {
  for (const classId of new Set(Object.values(delegationReceiptRetentionClass)))
    expect(retentionClasses[classId]).toBeUndefined()
})

// The native-start lookup writer, run alone: with the pin index emptied and the
// lookup row removed, retaining the same start request again is the only writer
// that runs, so the owners and the plan can only be pinned by the lookup.
test(
  'the runtime lookup writer alone pins the lead, the child and the child plan',
  () =>
    withChildMappingRecovery(async (x) => {
      const lookupNamespace = 'delegation-runtime-lookups'
      const lookups = await x.provider.transaction((tx) => tx.list(lookupNamespace))
      expect(lookups).toHaveLength(1)
      const { parentExecutionId, childExecutionId, request } = lookups[0].value
      expect(await missingPins(x.provider)).toEqual({})
      await x.provider.transaction(async (tx) => {
        for (const row of await tx.list(receiptOwnerPinNamespace))
          await tx.delete(receiptOwnerPinNamespace, row.id, row.revision)
        await tx.delete(lookupNamespace, lookups[0].id, lookups[0].revision)
      })
      expect(await pinSources(x.provider)).toEqual({})
      // Restating the start needs the canonical call to be live, as in the
      // immutable-receipt tests of the recovery suite; the call state is the only thing set.
      await x.provider.transaction(async (tx) => {
        const callNamespace = `tool-calls-${recordId(x.f.ids.workspaceId)}`
        const identity = canonicalJsonStringify([x.f.ids.workspaceId, x.f.host.request.toolCallId])
        const row = await tx.get(callNamespace, recordId(identity))
        await tx.put({
          namespace: callNamespace,
          id: row.id,
          expectedRevision: row.revision,
          value: { ...row.value, call: { ...row.value.call, status: 'executing' } },
        })
      })

      await x.records.retainChildRuntimeStart({ delegationId: x.f.ids.delegationId, request })

      expect(await pinSources(x.provider)).toEqual({
        [`execution:${parentExecutionId}`]: [lookupNamespace],
        [`execution:${childExecutionId}`]: [lookupNamespace],
        [`plan:${request.executionPlan.executionPlanId}`]: [lookupNamespace],
      })
      // The other writers' rows are still there; their pins are what is absent now.
      expect(Object.keys(await missingPins(x.provider)).length).toBeGreaterThan(0)
    }),
  30000
)

const watched = [
  ...delegationReceiptNamespaces,
  'delegations',
  'executions',
  'execution-attempts',
  'execution-plans',
  'context-packages',
  'tool-calls',
]

// #1022: the pre-start lookup receipt and CP mapping are the records native
// start-to-mapping recovery reads. Both owners are terminal here and the
// retention clock is far past every decided period, so only a retention rule
// can be what keeps them.
test(
  'unresolved native-start lookup and mapping records survive every retention sweep and a canonical restart',
  () =>
    withChildMappingRecovery(async (x) => {
      await x.provider.transaction(async (tx) => {
        for (const namespace of ['executions', 'execution-attempts'])
          for (const row of await tx.list(namespace))
            await tx.put({
              namespace,
              id: row.id,
              expectedRevision: row.revision,
              value: {
                ...row.value,
                state: 'completed',
                terminalAt: '2026-08-25T18:10:00.000Z',
              },
            })
      })
      const before = await snapshotNamespaces(x.provider, watched)
      expect(before['delegation-runtime-lookups']).toHaveLength(1)
      expect(before['delegation-admission-receipts']).toHaveLength(1)
      expect(before['delegation-child-mappings']).toHaveLength(1)
      const executionCount = before.executions.length

      const results = await sweepRegisteredRetentionClasses(
        x.provider,
        new Date('2030-01-01T00:00:00.000Z')
      )
      expect(results.executions.deleted).toBe(0)
      expect(results['execution-plans'].deleted).toBe(0)
      expect(await snapshotNamespaces(x.provider, watched)).toEqual(before)
      expect(before.executions).toHaveLength(executionCount)

      // A restart is a fresh connection to the same canonical file.
      const reopened = { provider: new SqlitePersistenceProvider({ path: x.canonicalPath }) }
      await reopened.provider.migrate()
      try {
        expect(await snapshotNamespaces(reopened.provider, watched)).toEqual(before)
        const records = new SqliteDelegationRepository(reopened.provider)
        const bridge = new CanonicalDelegationRuntimeBridge({
          ...x.options,
          records,
          childReceipts: records,
          lifecycle: new ExecutionLifecycleService(
            new SqliteExecutionRepository(reopened.provider)
          ),
          plans: new SqliteExecutionPlanRepository(reopened.provider),
        })
        const recovered = await bridge.recoverChildSession(x.f.identity)
        expect(recovered.mapping.externalSessionId).toBe(x.handle.externalSessionId)
        await sweepRegisteredRetentionClasses(
          reopened.provider,
          new Date('2030-01-01T00:00:00.000Z')
        )
        expect(await records.getChildMapping(x.f.ids.childAttemptId)).toEqual(recovered.mapping)
        expect(
          (await snapshotNamespaces(reopened.provider, ['delegation-runtime-lookups']))[
            'delegation-runtime-lookups'
          ]
        ).toEqual(before['delegation-runtime-lookups'])
        await x.assertNoOtherEffects()
      } finally {
        await reopened.provider.close()
      }
    }),
  60000
)
