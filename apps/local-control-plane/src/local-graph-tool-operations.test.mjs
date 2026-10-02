import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { InteractionService } from '@control-plane/domain'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  SqliteDurableUsageStore,
  SqliteToolCallRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'
import { LocalControlApiComposition } from './local-api-composition.ts'
import { ManagedLocalGraphRuntime } from './managed-graph-runtime.ts'
import { LocalGraphToolOperations } from './local-graph-tool-operations.ts'

// Real accepted-plan fixtures and SQLite/ObjectStore effects; runtime admission remains fixture evidence.
test('Local graph tools require persisted approval, then write and charge once across cold replay', async () => {
  const fixture = await createLocalGraphToolFixture()
  let coldPersistence
  let store = new FilesystemObjectStore({
    rootDirectory: join(fixture.directory, 'objects'),
    maxObjectBytes: 4096,
  })
  try {
    const options = {
      api: fixture.api,
      persistence: fixture.persistence,
      objectStore: store,
      prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
      now: () => fixture.at,
    }
    const objectKey = [
      'tool-effects',
      fixture.operation.workspaceId,
      fixture.operation.executionId,
      'req_' +
        createHash('sha256')
          .update(fixture.operation.idempotencyKey)
          .digest('hex')
          .slice(0, 26)
          .toUpperCase(),
    ].join('/')
    let port = new LocalGraphToolOperations(options)
    let approval
    try {
      await port.invoke(fixture.operation)
    } catch (error) {
      if (!error.interaction) throw error
      approval = error.interaction
    }
    expect(approval).toMatchObject({ kind: 'approval' })
    const calls = new SqliteToolCallRepository(fixture.persistence, fixture.operation.workspaceId)
    const call = (await calls.listByExecution(fixture.operation.executionId))[0]
    expect(call.status).toBe('awaiting_approval')
    await expect(store.head(objectKey)).rejects.toThrow()
    // A graph wake-up does not mutate the persisted interaction decision.
    await expect(port.invoke(fixture.operation)).rejects.toMatchObject({ interaction: approval })
    const interaction = await fixture.api.interactions.get(approval.interactionKey)
    const interactions = new InteractionService(fixture.api.interactions)
    await expect(
      interactions.respond({
        interactionId: interaction.interactionId,
        executionId: call.executionId,
        attemptId: call.attemptId,
        expectedVersion: interaction.version,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
        respondingPrincipalId: 'svc_intruder',
        action: 'approve',
        respondedAt: fixture.at,
      })
    ).rejects.toThrow()
    await interactions.respond({
      interactionId: interaction.interactionId,
      executionId: call.executionId,
      attemptId: call.attemptId,
      expectedVersion: interaction.version,
      responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
      respondingPrincipalId: 'svc_graph-tool-test',
      action: 'approve',
      respondedAt: fixture.at,
    })
    const output = await port.invoke(fixture.operation)
    expect(output).toMatchObject({
      contentDigest: expect.stringMatching(/^sha256:/),
      size: expect.any(Number),
    })
    const saved = await store.get(objectKey)
    expect(JSON.parse(new TextDecoder().decode(saved.body))).toEqual(fixture.operation.input)
    store.close()
    store = new FilesystemObjectStore({
      rootDirectory: join(fixture.directory, 'objects'),
      maxObjectBytes: 4096,
    })
    fixture.persistence.close()
    coldPersistence = new SqlitePersistenceProvider({
      path: join(fixture.directory, 'state.sqlite'),
    })
    await coldPersistence.migrate()
    const coldApi = new LocalControlApiComposition(coldPersistence, 'http://127.0.0.1:1')
    port = new LocalGraphToolOperations({
      ...options,
      objectStore: store,
      persistence: coldPersistence,
      api: coldApi,
    })
    expect(await port.invoke(fixture.operation)).toEqual(output)
    const ledger = new DurableUsageLedger({ store: new SqliteDurableUsageStore(coldPersistence) })
    const summary = await ledger.summary(
      fixture.operation.workspaceId,
      fixture.operation.executionId
    )
    expect(summary.spentMicrounits).toBe(25)
    expect(summary.reservedMicrounits).toBe(0)
    expect(
      await new SqliteToolCallRepository(
        coldPersistence,
        fixture.operation.workspaceId
      ).listByExecution(fixture.operation.executionId)
    ).toHaveLength(1)
  } finally {
    store.close()
    coldPersistence?.close()
    await fixture.cleanup()
  }
})

for (const lostReceipt of [false, true])
  test(`managed Local graph composition preserves ${lostReceipt ? 'an unconfirmed write' : 'confirmed delivery'} through approval`, async () => {
    const fixture = await createLocalGraphToolFixture()
    const store = new FilesystemObjectStore({
      rootDirectory: join(fixture.directory, 'objects'),
      maxObjectBytes: 4096,
    })
    try {
      const runtime = new ManagedLocalGraphRuntime(
        fixture.persistence,
        {
          capabilities: ['graph.tool-pins.v1'],
          compiler: {
            operationAllowlist: [{ kind: 'tool', name: 'store' }],
            schemaRegistry: {
              getValidator: () => (value) =>
                value !== null && typeof value === 'object' && !Array.isArray(value),
            },
          },
          operations: ({ api, persistence, objectStore }) =>
            new LocalGraphToolOperations({
              api,
              persistence,
              objectStore,
              prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
              now: () => fixture.at,
            }),
        },
        lostReceipt
          ? {
              putIfAbsent: async (input) => {
                await store.putIfAbsent(input)
                if (!accounting) throw Error('lost receipt')
                return result
              },
            }
          : store
      )
      const activity = runtime.activities(fixture.api)
      const request = {
        executionId: fixture.operation.executionId,
        attemptId: fixture.operation.attemptId,
        workspaceId: fixture.operation.workspaceId,
        workflowId: fixture.operation.workflowId,
        graph: fixture.graph.reference,
        threadId: fixture.operation.threadId,
        input: fixture.plan.graph.input,
        idempotencyKey: 'managed:tool:run',
      }
      const paused = await activity.runGraphSegment(request)
      expect(paused).toMatchObject({ outcome: 'awaiting_input' })
      const resume = {
        ...request,
        checkpointId: paused.checkpointId,
        response: { action: 'approve' },
        idempotencyKey: 'managed:tool:untrusted-wakeup',
      }
      delete resume.input
      expect((await activity.resumeGraphSegment(resume)).outcome).toBe('awaiting_input')
      const interaction = await fixture.api.interactions.get(paused.interactionId)
      await new InteractionService(fixture.api.interactions).respond({
        interactionId: interaction.interactionId,
        executionId: request.executionId,
        attemptId: request.attemptId,
        expectedVersion: interaction.version,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFM',
        respondingPrincipalId: 'svc_graph-tool-test',
        action: 'approve',
        respondedAt: fixture.at,
      })
      const completed = await activity.resumeGraphSegment({
        ...resume,
        idempotencyKey: 'managed:tool:approved-wakeup',
      })
      expect(completed.outcome).toBe(lostReceipt ? 'reconciliation_required' : 'completed')
      const recordedCalls = await new SqliteToolCallRepository(
        fixture.persistence,
        request.workspaceId
      ).listByExecution(request.executionId)
      expect(recordedCalls).toHaveLength(1)
      expect(recordedCalls[0].status).toBe(lostReceipt ? 'reconciliation_required' : 'succeeded')
      if (!lostReceipt)
        expect(recordedCalls[0].result.output).toMatchObject({
          contentDigest: expect.stringMatching(/^sha256:/),
          size: expect.any(Number),
        })
      const ledger = new DurableUsageLedger({
        store: new SqliteDurableUsageStore(fixture.persistence),
      })
      expect((await ledger.summary(request.workspaceId, request.executionId)).spentMicrounits).toBe(
        lostReceipt ? 0 : 25
      )
      expect(
        (await ledger.summary(request.workspaceId, request.executionId)).reservedMicrounits
      ).toBe(lostReceipt ? 25 : 0)
    } finally {
      store.close()
      await fixture.cleanup()
    }
  })

test('cancelled pending tool approvals stay revoked after reconstructing the Local port', async () => {
  const fixture = await createLocalGraphToolFixture()
  const store = new FilesystemObjectStore({
    rootDirectory: join(fixture.directory, 'objects'),
    maxObjectBytes: 4096,
  })
  try {
    const options = {
      api: fixture.api,
      persistence: fixture.persistence,
      objectStore: store,
      prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
      now: () => fixture.at,
    }
    const port = new LocalGraphToolOperations(options)
    await expect(port.invoke(fixture.operation)).rejects.toMatchObject({
      interaction: { kind: 'approval' },
    })
    expect(
      await port.cancel(
        fixture.operation.executionId,
        fixture.operation.threadId,
        'graph-cancel-0001'
      )
    ).toBe(true)
    await expect(new LocalGraphToolOperations(options).invoke(fixture.operation)).rejects.toThrow(
      'GRAPH_TOOL_CANCELLED'
    )
    const calls = await new SqliteToolCallRepository(
      fixture.persistence,
      fixture.operation.workspaceId
    ).listByExecution(fixture.operation.executionId)
    expect(calls[0].status).toBe('denied')
    expect((await fixture.api.interactions.get(calls[0].approvalInteractionId)).state).toBe(
      'cancelled'
    )
    const summary = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(fixture.persistence),
    }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
    expect(summary.spentMicrounits).toBe(0)
    expect(summary.reservedMicrounits).toBe(0)
  } finally {
    store.close()
    await fixture.cleanup()
  }
})

for (const fault of [
  'none',
  'receipt lookup',
  'receipt persistence',
  'unavailable receipt lookup',
  'charge',
  'settlement',
])
  test(`a lost object-write receipt remains unconfirmed with ${fault} failure`, async () => {
    const fixture = await createLocalGraphToolFixture()
    const store = new FilesystemObjectStore({
      rootDirectory: join(fixture.directory, 'objects'),
      maxObjectBytes: 4096,
    })
    let writes = 0
    let failLookup = false
    let usageFault = ['charge', 'settlement'].includes(fault)
    const accounting = usageFault
    const persistence = new Proxy(fixture.persistence, {
      get(target, property) {
        if (property === 'transaction')
          return (callback) =>
            target.transaction((transaction) =>
              callback(
                new Proxy(transaction, {
                  get(inner, key) {
                    if (key === 'get')
                      return (...args) => {
                        if (failLookup && args[0].startsWith('tool-call-idempotency'))
                          throw Error('receipt lookup unavailable')
                        return inner.get(...args)
                      }
                    if (key === 'put')
                      return async (input) => {
                        if (input.value?.call?.status === 'reconciliation_required') {
                          if (fault === 'unavailable receipt lookup') failLookup = true
                          if (
                            fault === 'receipt persistence' ||
                            fault === 'unavailable receipt lookup'
                          )
                            throw Error('receipt transition unavailable')
                          const result = await inner.put(input)
                          if (fault === 'receipt lookup') failLookup = true
                          return result
                        }
                        if (
                          usageFault &&
                          input.namespace === 'usage-ledger-entries' &&
                          input.value.kind === (fault === 'charge' ? 'tool_charge' : 'settlement')
                        )
                          throw Error('usage receipt unavailable')
                        return inner.put(input)
                      }
                    const value = inner[key]
                    return typeof value === 'function' ? value.bind(inner) : value
                  },
                })
              )
            )
        const value = target[property]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      const options = {
        api: fixture.api,
        persistence,
        objectStore: {
          putIfAbsent: async (input) => {
            writes++
            const result = await store.putIfAbsent(input)
            if (!accounting) throw Error('lost receipt')
            return result
          },
        },
        prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
        now: () => fixture.at,
      }
      const port = new LocalGraphToolOperations(options)
      let approval
      try {
        await port.invoke(fixture.operation)
      } catch (error) {
        if (!error.interaction) throw error
        approval = error.interaction
      }
      const interaction = await fixture.api.interactions.get(approval.interactionKey)
      await new InteractionService(fixture.api.interactions).respond({
        interactionId: interaction.interactionId,
        executionId: fixture.operation.executionId,
        attemptId: fixture.operation.attemptId,
        expectedVersion: interaction.version,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFP',
        respondingPrincipalId: 'svc_graph-tool-test',
        action: 'approve',
        respondedAt: fixture.at,
      })
      await expect(port.invoke(fixture.operation)).rejects.toThrow(
        'GRAPH_TOOL_RECONCILIATION_REQUIRED'
      )
      failLookup = false
      if (accounting) {
        expect(
          await port.cancel(
            fixture.operation.executionId,
            fixture.operation.threadId,
            'graph-cancel-usage'
          )
        ).toBe(false)
      } else
        await expect(
          new LocalGraphToolOperations({ ...options, objectStore: store }).invoke(fixture.operation)
        ).rejects.toThrow('GRAPH_TOOL_RECONCILIATION_REQUIRED')
      expect(writes).toBe(1)
      expect(
        await port.cancel(
          fixture.operation.executionId,
          fixture.operation.threadId,
          'graph-cancel-0002'
        )
      ).toBe(false)
      const summary = await new DurableUsageLedger({
        store: new SqliteDurableUsageStore(fixture.persistence),
      }).summary(fixture.operation.workspaceId, fixture.operation.executionId)
      expect(summary.spentMicrounits).toBe(fault === 'settlement' ? 25 : 0)
      expect(summary.reservedMicrounits).toBe(fault === 'settlement' ? 0 : 25)
    } finally {
      store.close()
      await fixture.cleanup()
    }
  })

for (const value of [null, false, 0, ''])
  test(`malformed persisted rate state ${JSON.stringify(value)} denies the tool effect`, async () => {
    const fixture = await createLocalGraphToolFixture()
    const store = new FilesystemObjectStore({
      rootDirectory: join(fixture.directory, 'objects'),
      maxObjectBytes: 4096,
    })
    try {
      const port = new LocalGraphToolOperations({
        api: fixture.api,
        persistence: fixture.persistence,
        objectStore: store,
        prices: [{ pin: fixture.operation.toolPin, currency: 'USD', costMicrounits: 25 }],
        now: () => fixture.at,
      })
      let approval
      try {
        await port.invoke(fixture.operation)
      } catch (error) {
        if (!error.interaction) throw error
        approval = error.interaction
      }
      const interaction = await fixture.api.interactions.get(approval.interactionKey)
      await new InteractionService(fixture.api.interactions).respond({
        interactionId: interaction.interactionId,
        executionId: fixture.operation.executionId,
        attemptId: fixture.operation.attemptId,
        expectedVersion: interaction.version,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFP',
        respondingPrincipalId: 'svc_graph-tool-test',
        action: 'approve',
        respondedAt: fixture.at,
      })
      const id = createHash('sha256')
        .update(
          [
            fixture.operation.workspaceId,
            'svc_graph-tool-test',
            fixture.operation.toolPin.toolDefinitionId,
            'store-json',
          ].join(':')
        )
        .digest('hex')
      await fixture.persistence.transaction((transaction) =>
        transaction.put({ namespace: 'graph-tool-rate-limits', id, value })
      )
      await expect(port.invoke(fixture.operation)).rejects.toThrow('GRAPH_TOOL_RATE_STATE_INVALID')
      const key = [
        'tool-effects',
        fixture.operation.workspaceId,
        fixture.operation.executionId,
        'req_' +
          createHash('sha256')
            .update(fixture.operation.idempotencyKey)
            .digest('hex')
            .slice(0, 26)
            .toUpperCase(),
      ].join('/')
      await expect(store.head(key)).rejects.toThrow()
    } finally {
      store.close()
      await fixture.cleanup()
    }
  })
