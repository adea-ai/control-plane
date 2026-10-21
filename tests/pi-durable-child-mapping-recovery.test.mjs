import { expect, test } from 'bun:test'
import { CanonicalDelegationRuntimeBridge } from '../packages/orchestration/src/delegation-runtime.ts'
import { recordId } from '../packages/sqlite-persistence/src/record-storage.ts'
import { withChildMappingRecovery } from './pi-durable-child-mapping-recovery.fixture.mjs'
import { PersistentModelSelectionRepository } from '../packages/model-gateway/src/selection-repository.ts'
import { SqliteCredentialVaultRepository } from '../packages/sqlite-persistence/src/credential-vault-repository.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  readPersistenceTransaction,
  writePersistenceTransaction,
} from '@control-plane/deployment/read-scope'

async function mutate(x, namespace, identity, change) {
  await x.provider.transaction(async (tx) => {
    const row = await tx.get(namespace, recordId(identity))
    await tx.put({
      namespace,
      id: row.id,
      expectedRevision: row.revision,
      value: change(structuredClone(row.value)),
    })
  })
}
async function deniesWithoutMapping(x, operation, message) {
  await expect(operation()).rejects.toThrow(message)
  expect(await x.records.getChildMapping(x.f.ids.childAttemptId)).toEqual(x.mapping)
  await x.assertNoOtherEffects()
}

test(
  'pre-native crash remains missing and never falls back to start',
  () =>
    withChildMappingRecovery(
      async (x) => {
        expect(x.handle).toBeUndefined()
        expect(x.f.child.requests).toHaveLength(0)
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'CHILD_NATIVE_RECEIPT_MISSING'
        )
      },
      { beforeNative: true }
    ),
  30000
)

test(
  'concurrent exact metadata repair converges and a closed transaction reader cannot be reused',
  () =>
    withChildMappingRecovery(async (x) => {
      const results = await Promise.all([
        x.bridge.recoverChildSession(x.f.identity),
        x.bridge.recoverChildSession(x.f.identity),
      ])
      expect(results[0]).toEqual(results[1])
      expect(results[0].handle).toEqual(x.handle)
      expect(results[0].mapping.externalSessionId).toBe(x.handle.externalSessionId)
      await expect(x.reader.getAttempt(x.f.ids.childAttemptId)).rejects.toThrow(
        'CHILD_ADMISSION_READER_CLOSED'
      )
      await x.assertNoOtherEffects()
    }),
  30000
)

test(
  'lost CP mapping acknowledgement replays identical native metadata',
  () =>
    withChildMappingRecovery(
      async (x) => {
        expect(x.mapping.externalSessionId).toBe(x.handle.externalSessionId)
        expect((await x.bridge.recoverChildSession(x.f.identity)).mapping).toEqual(x.mapping)
        expect((await x.bridge.recoverChildSession(x.f.identity)).mapping).toEqual(x.mapping)
        await x.assertNoOtherEffects()
      },
      { lostAck: true }
    ),
  30000
)

for (const which of ['missing', 'unqualified', 'function-only'])
  test(
    `read authority ${which} fails closed before native lookup`,
    () =>
      withChildMappingRecovery(async (x) => {
        const options = { ...x.options }
        if (which === 'missing') options.receiptReadAuthority = undefined
        if (which === 'unqualified') x.control.qualified = false
        if (which === 'function-only') {
          options.receiptReadAuthority = undefined
          options.assertReceiptRead = async () => ({ ...x.snapshot.receipt })
        }
        await deniesWithoutMapping(
          x,
          () => new CanonicalDelegationRuntimeBridge(options).recoverChildSession(x.f.identity),
          which === 'unqualified'
            ? 'TEST_READ_AUTHORITY_UNQUALIFIED'
            : 'DELEGATION_RUNTIME_ADMISSION_DENIED'
        )
        expect(x.control.lookups).toBe(0)
      }),
    30000
  )

for (const which of ['revocation', 'revision', 'expiry'])
  test(
    `${which} during metadata lookup denies without writes`,
    () =>
      withChildMappingRecovery(async (x) => {
        x.control.afterLookup = async () => {
          if (which === 'revocation') x.control.allowed = false
          if (which === 'revision') x.control.revision++
          if (which === 'expiry') x.control.at = x.control.expiresAt
        }
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          which === 'revocation'
            ? 'TEST_RECEIPT_READ_REVOKED'
            : 'DELEGATION_RUNTIME_ADMISSION_DENIED'
        )
      }),
    30000
  )

for (const which of ['actor', 'reader', 'audience'])
  test(
    `read binding ${which} mismatch cannot authenticate a host port`,
    () =>
      withChildMappingRecovery(async (x) => {
        x.control.bindingPatch =
          which === 'actor'
            ? { originalActorPrincipalId: 'user:foreign' }
            : which === 'reader'
              ? { readerPrincipalId: 'svc_other' }
              : { audienceRef: 'scope:other' }
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'DELEGATION_RUNTIME_ADMISSION_DENIED'
        )
        expect(x.control.lookups).toBe(0)
      }),
    30000
  )

const staleCases = [
  [
    'parent attempt',
    'executions',
    'parentExecutionId',
    (r) => ({ ...r, latestAttemptId: 'att_01JDBCDEF0123456789ABCDEFG' }),
  ],
  [
    'child attempt',
    'executions',
    'childExecutionId',
    (r) => ({ ...r, latestAttemptId: 'att_01JDBCDEF0123456789ABCDEFG' }),
  ],
  [
    'plan',
    'executions',
    'childExecutionId',
    (r) => ({
      ...r,
      executionPlan: { ...r.executionPlan, contentDigest: `sha256:${'f'.repeat(64)}` },
    }),
  ],
  [
    'workspace',
    'executions',
    'childExecutionId',
    (r) => ({
      ...r,
      correlation: { ...r.correlation, workspaceId: 'wsp_01JDBCDEF0123456789ABCDEFG' },
    }),
  ],
  [
    'runtime',
    'execution-attempts',
    'childAttemptId',
    (r) => ({
      ...r,
      runtime: { ...r.runtime, runtimeConnectionId: 'rtc_01JDBCDEF0123456789ABCDEFG' },
    }),
  ],
]
for (const [label, namespace, key, change] of staleCases)
  test(
    `changed ${label} after lookup cannot cross the CP CAS fence`,
    () =>
      withChildMappingRecovery(async (x) => {
        x.control.afterLookup = () => mutate(x, namespace, x.f.ids[key], change)
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'CHILD_RUNTIME_LOOKUP_STALE'
        )
      }),
    30000
  )

test(
  'transaction-bound current read revocation rolls back mapping',
  () =>
    withChildMappingRecovery(async (x) => {
      x.control.inTransaction = async (reader) => {
        expect((await reader.getExecution(x.f.ids.childExecutionId)).executionId).toBe(
          x.f.ids.childExecutionId
        )
        x.control.allowed = false
      }
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'TEST_RECEIPT_READ_REVOKED'
      )
    }),
  30000
)

test(
  'same-identity canonical revision contention denies until a fresh metadata read',
  () =>
    withChildMappingRecovery(async (x) => {
      x.control.afterLookup = async () => {
        x.control.afterLookup = undefined
        const record = await x.records.get(x.f.ids.delegationId)
        expect(
          await x.records.compareAndSet(record.revision, {
            ...record,
            revision: record.revision + 1,
          })
        ).toBe(true)
      }
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'CHILD_RUNTIME_LOOKUP_STALE'
      )
      expect((await x.bridge.recoverChildSession(x.f.identity)).handle).toEqual(x.handle)
      await x.assertNoOtherEffects()
    }),
  30000
)

for (const which of ['missing', 'wrong-attempt'])
  test(
    `native ${which} result never invents a handle`,
    () =>
      withChildMappingRecovery(async (x) => {
        x.options.nativeReceiptReader.findExistingHandle = async () =>
          which === 'missing'
            ? undefined
            : { ...x.handle, attemptId: 'att_01JDBCDEF0123456789ABCDEFG' }
        const options = x.options
        await deniesWithoutMapping(
          x,
          () => new CanonicalDelegationRuntimeBridge(options).recoverChildSession(x.f.identity),
          which === 'missing'
            ? 'CHILD_NATIVE_RECEIPT_MISSING'
            : 'DELEGATION_RUNTIME_ADMISSION_DENIED'
        )
      }),
    30000
  )

test(
  'runtime reader identity mismatch denies before lookup',
  () =>
    withChildMappingRecovery(async (x) => {
      const options = {
        ...x.options,
        nativeReceiptReader: {
          ...x.options.nativeReceiptReader,
          runtimeConnectionId: 'rtc_01JDBCDEF0123456789ABCDEFG',
        },
      }
      await deniesWithoutMapping(
        x,
        () => new CanonicalDelegationRuntimeBridge(options).recoverChildSession(x.f.identity),
        'DELEGATION_RUNTIME_ADMISSION_DENIED'
      )
      expect(x.control.lookups).toBe(0)
    }),
  30000
)

test(
  'tampered retained request digest fails closed before native lookup',
  () =>
    withChildMappingRecovery(async (x) => {
      await mutate(x, 'delegation-runtime-lookups', x.f.ids.childAttemptId, (r) => ({
        ...r,
        requestDigest: `sha256:${'f'.repeat(64)}`,
      }))
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'Child runtime lookup identity mismatch'
      )
      expect(x.control.lookups).toBe(0)
    }),
  30000
)

test(
  'changed start request cannot overwrite the immutable lookup receipt',
  () =>
    withChildMappingRecovery(async (x) => {
      await expect(
        x.records.retainChildRuntimeStart({
          delegationId: x.f.ids.delegationId,
          request: {
            ...x.snapshot.receipt.request,
            attemptBudget: { ...x.snapshot.receipt.request.attemptBudget, maximumTokens: 1 },
          },
        })
      ).rejects.toThrow('CHILD_RUNTIME_LOOKUP_STALE')
      expect((await x.records.getChildRuntimeStart(x.f.ids.delegationId)).receipt).toEqual(
        x.snapshot.receipt
      )
    }),
  30000
)

for (const which of ['other-attempt', 'different-session'])
  test(
    `native session collision ${which} preserves both owners`,
    () =>
      withChildMappingRecovery(async (x) => {
        if (which === 'other-attempt')
          await x.provider.transaction(async (tx) => {
            const { canonicalJsonStringify } = await import('@control-plane/contracts')
            await tx.put({
              namespace: 'delegation-native-sessions',
              id: recordId(
                canonicalJsonStringify([x.mapping.runtimeConnectionId, x.handle.externalSessionId])
              ),
              value: {
                ...x.mapping,
                externalSessionId: x.handle.externalSessionId,
                childAttemptId: 'att_01JDBCDEF0123456789ABCDEFG',
              },
            })
          })
        else {
          const record = await x.records.get(x.f.ids.delegationId)
          await x.records.bindChildSession(record.revision, {
            ...x.mapping,
            externalSessionId: 'ses_01JDBCDEF0123456789ABCDEFG',
          })
          x.mapping.externalSessionId = 'ses_01JDBCDEF0123456789ABCDEFG'
        }
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'DELEGATION_CHILD_MAPPING_CONFLICT'
        )
      }),
    30000
  )

test(
  'a different native reader object with the same claimed runtime requires independent qualification',
  () =>
    withChildMappingRecovery(async (x) => {
      const options = { ...x.options, nativeReceiptReader: { ...x.options.nativeReceiptReader } }
      await deniesWithoutMapping(
        x,
        () => new CanonicalDelegationRuntimeBridge(options).recoverChildSession(x.f.identity),
        'TEST_READ_AUTHORITY_UNQUALIFIED'
      )
      expect(x.control.lookups).toBe(0)
    }),
  30000
)

test(
  'qualification lost during the transactional read denies the final write',
  () =>
    withChildMappingRecovery(async (x) => {
      x.control.inTransaction = async () => {
        x.control.qualified = false
      }
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'TEST_READ_AUTHORITY_UNQUALIFIED'
      )
    }),
  30000
)

test(
  'actual original grant revocation during lookup denies metadata access',
  () =>
    withChildMappingRecovery(async (x) => {
      x.control.afterLookup = async () => {
        x.f.state.active.child = false
      }
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'TEST_RECEIPT_READ_REVOKED'
      )
    }),
  30000
)

for (const field of ['originalActorPrincipalId', 'compilerAdmissionDigest', 'childAdmissionDigest'])
  test(
    `tampered retained ${field} cannot authenticate or replace canonical evidence`,
    () =>
      withChildMappingRecovery(async (x) => {
        await mutate(x, 'delegation-runtime-lookups', x.f.ids.childAttemptId, (r) => ({
          ...r,
          [field]:
            field === 'originalActorPrincipalId' ? 'svc_other-actor' : `sha256:${'f'.repeat(64)}`,
        }))
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'CHILD_RUNTIME_LOOKUP_CONFLICT'
        )
        expect(x.control.lookups).toBe(0)
      }),
    30000
  )

for (const [label, namespace, key, change] of staleCases)
  test(
    `stale ${label} before lookup denies without reading native metadata`,
    () =>
      withChildMappingRecovery(async (x) => {
        await mutate(x, namespace, x.f.ids[key], change)
        await deniesWithoutMapping(
          x,
          () => x.bridge.recoverChildSession(x.f.identity),
          'CHILD_RUNTIME_LOOKUP_STALE'
        )
        expect(x.control.lookups).toBe(0)
      }),
    30000
  )

test(
  'legacy missing pre-start lookup receipt fails closed without reconstruction',
  () =>
    withChildMappingRecovery(async (x) => {
      await x.provider.transaction((tx) =>
        tx.delete('delegation-runtime-lookups', recordId(x.f.ids.childAttemptId))
      )
      await deniesWithoutMapping(
        x,
        () => x.bridge.recoverChildSession(x.f.identity),
        'CHILD_RUNTIME_LOOKUP_MISSING'
      )
      expect(x.control.lookups).toBe(0)
    }),
  30000
)

test(
  'immutable pre-start receipt rejects changed budget even with an active canonical call',
  () =>
    withChildMappingRecovery(async (x) => {
      const { SqliteToolCallRepository } = await import('@control-plane/sqlite-persistence')
      const { canonicalJsonStringify } = await import('@control-plane/contracts')
      const calls = new SqliteToolCallRepository(x.provider, x.f.ids.workspaceId)
      // Deliberately restore only test call state to exercise the immutable comparison,
      // without asking recovery to change the tool outcome.
      await mutate(
        x,
        `tool-calls-${recordId(x.f.ids.workspaceId)}`,
        canonicalJsonStringify([x.f.ids.workspaceId, x.f.host.request.toolCallId]),
        (r) => ({ ...r, call: { ...r.call, status: 'executing' } })
      )
      const request = structuredClone(x.snapshot.receipt.request)
      request.attemptBudget.maximumTokens = 1
      await expect(
        x.records.retainChildRuntimeStart({ delegationId: x.f.ids.delegationId, request })
      ).rejects.toThrow('CHILD_RUNTIME_LOOKUP_CONFLICT')
      expect((await x.records.getChildRuntimeStart(x.f.ids.delegationId)).receipt).toEqual(
        x.snapshot.receipt
      )
      expect((await calls.get(x.f.host.request.toolCallId)).status).toBe('executing')
      expect(await x.records.getChildMapping(x.f.ids.childAttemptId)).toEqual(x.mapping)
    }),
  30000
)

test(
  'canonical attempt session mismatch denies recovery without forward or reverse mapping writes',
  () =>
    withChildMappingRecovery(async (x) => {
      const sessionB = 'ses_01JDBCDEF0123456789ABCDEFG'
      const sessionA = x.handle.externalSessionId
      expect(sessionA).not.toBe(sessionB)
      expect(x.mapping.externalSessionId).toBeUndefined()
      await mutate(x, 'execution-attempts', x.f.ids.childAttemptId, (attempt) => ({
        ...attempt,
        version: attempt.version + 1,
        runtime: { ...attempt.runtime, externalSessionId: sessionB },
      }))
      const { SqliteExecutionRepository } = await import('@control-plane/sqlite-persistence')
      const executions = new SqliteExecutionRepository(x.provider)
      const canonical = await executions.getAttempt(x.f.ids.childAttemptId)
      expect(canonical.runtime.externalSessionId).toBe(sessionB)
      const record = await x.records.get(x.f.ids.delegationId)
      await expect(
        x.records.bindChildSession(record.revision, { ...x.mapping, externalSessionId: sessionA })
      ).rejects.toThrow('DELEGATION_CHILD_MAPPING_STALE')
      const outcome = await x.bridge.recoverChildSession(x.f.identity).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      const forward = await x.records.getChildMapping(x.f.ids.childAttemptId)
      const reverseA = await x.records.findChildBySession(x.mapping.runtimeConnectionId, sessionA)
      const reverseB = await x.records.findChildBySession(x.mapping.runtimeConnectionId, sessionB)
      if (!outcome.error)
        console.log('canonical session mismatch baseline', {
          canonicalSession: canonical.runtime.externalSessionId,
          recoveredSession: outcome.value.mapping.externalSessionId,
          forwardSession: forward.externalSessionId,
          reverseSession: reverseA?.externalSessionId,
        })
      expect(outcome.error?.message).toBe('DELEGATION_CHILD_MAPPING_STALE')
      expect(x.control.lookups).toBe(1)
      expect(await executions.getAttempt(x.f.ids.childAttemptId)).toEqual(canonical)
      expect(forward).toEqual(x.mapping)
      expect(reverseA).toBeUndefined()
      expect(reverseB).toBeUndefined()
      await x.assertNoOtherEffects()
    }),
  30000
)

test(
  'matching canonical attempt session permits exact idempotent metadata recovery',
  () =>
    withChildMappingRecovery(async (x) => {
      const session = x.handle.externalSessionId
      await mutate(x, 'execution-attempts', x.f.ids.childAttemptId, (attempt) => ({
        ...attempt,
        version: attempt.version + 1,
        runtime: { ...attempt.runtime, externalSessionId: session },
      }))
      const { SqliteExecutionRepository } = await import('@control-plane/sqlite-persistence')
      const executions = new SqliteExecutionRepository(x.provider)
      const canonical = await executions.getAttempt(x.f.ids.childAttemptId)
      const first = await x.bridge.recoverChildSession(x.f.identity)
      expect(first.mapping).toEqual({ ...x.mapping, externalSessionId: session })
      expect(await x.bridge.recoverChildSession(x.f.identity)).toEqual(first)
      expect(await x.records.findChildBySession(x.mapping.runtimeConnectionId, session)).toEqual(
        first.mapping
      )
      expect(await executions.getAttempt(x.f.ids.childAttemptId)).toEqual(canonical)
      await x.assertNoOtherEffects()
    }),
  30000
)

test(
  'recovered-session authority reads share the locked provider without metadata writes or other effects',
  () =>
    withChildMappingRecovery(async (x) => {
      const models = new PersistentModelSelectionRepository(x.provider)
      const vault = new SqliteCredentialVaultRepository(x.provider)
      const original = x.provider.transaction.bind(x.provider)
      let authorityActive = false,
        reentries = 0,
        pending,
        captured
      x.provider.transaction = (operation) => {
        if (authorityActive) reentries++
        return original(operation)
      }
      x.control.inTransaction = async () => {
        authorityActive = true
        let timer
        try {
          pending = Promise.all([
            models.getDefaults(x.f.ids.workspaceId),
            vault.getCredential('crd_01JABCDEF0123456789ABCDEFG'),
          ])
          expect(
            await Promise.race([
              pending,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('RECOVERY_METADATA_QUEUED_BEHIND_OWN_TRANSACTION')),
                  250
                )
              }),
            ])
          ).toEqual([undefined, undefined])
          await readPersistenceTransaction(x.provider, async (reader) => {
            captured = reader
          })
          expect(() =>
            writePersistenceTransaction(x.provider, (tx) =>
              tx.put({ namespace: 'scope-proof', id: 'forbidden', value: true })
            )
          ).toThrow('PERSISTENCE_READ_SCOPE_WRITE_DENIED')
        } finally {
          clearTimeout(timer)
          authorityActive = false
        }
      }
      let result, error
      try {
        result = await x.bridge.recoverChildSession(x.f.identity)
      } catch (cause) {
        error = cause
      } finally {
        await pending?.catch(() => undefined)
      }
      expect({ code: error?.message ?? null, reentries, recovered: Boolean(result) }).toEqual({
        code: null,
        reentries: 0,
        recovered: true,
      })
      expect(result.mapping.externalSessionId).toBe(x.handle.externalSessionId)
      await expect(captured.get('scope-proof', 'value')).rejects.toThrow(
        'PERSISTENCE_READ_SCOPE_CLOSED'
      )
      await x.assertNoOtherEffects()
    }),
  30000
)

test('the retained lookup receipt is never rewritten by a later attempt', () =>
  withChildMappingRecovery(async (x) => {
    const delegationId = x.mapping.delegationId
    const request = {
      ...x.snapshot.receipt.request,
      attemptId: '11111111-1111-4111-8111-111111111111',
    }
    await expect(x.records.retainChildRuntimeStart({ delegationId, request })).rejects.toThrow()
    const retained = await x.records.getChildRuntimeStart(delegationId)
    expect(retained.receipt.requestDigest).toBe(x.snapshot.receipt.requestDigest)
    expect(retained.receipt.childAttemptId).toBe(x.snapshot.receipt.childAttemptId)
    await x.assertNoOtherEffects()
  }, 30000))

test('the retained lookup receipt survives a store restart and reads back identically', () =>
  withChildMappingRecovery(async (x) => {
    const delegationId = x.mapping.delegationId
    const before = await x.records.getChildRuntimeStart(delegationId)
    // The store is restarted: the first provider releases the write lock.
    await x.provider.close()
    const reopened = new SqlitePersistenceProvider({ path: x.canonicalPath })
    await reopened.migrate()
    try {
      const records = new SqliteDelegationRepository(reopened)
      const after = await records.getChildRuntimeStart(delegationId)
      expect(after.receipt.requestDigest).toBe(before.receipt.requestDigest)
      expect(after.receipt.childAttemptId).toBe(before.receipt.childAttemptId)
      expect(after.receipt.runtimeConnectionId).toBe(before.receipt.runtimeConnectionId)
    } finally {
      await reopened.close()
    }
  }, 30000))
