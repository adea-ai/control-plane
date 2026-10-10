import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { emptyCheckpoint } from '@langchain/langgraph'
import { LangGraphSqliteCheckpointSaver } from './index.ts'
import {
  LEGACY_CHECKPOINT_NAMESPACE,
  LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE,
  LEGACY_DRAIN_FENCE_NAMESPACE,
  LEGACY_EXECUTION_NAMESPACE,
  LEGACY_EXECUTION_PLAN_NAMESPACE,
  LEGACY_GRAPH_API,
  claimLegacyDrainFence,
  createLegacyAdmissionGuard,
  createLegacyResumeFence,
  evaluateLegacyAdmissionGate,
  planLegacyDrain,
  readLegacyRemainder,
  releaseLegacyDrainFence,
} from './legacy-retirement.ts'
import {
  adapterFor,
  disposable,
  disposableStore,
  metadata,
  reopen,
  request,
  resumeInput,
  scope,
  storageThread,
  writeExecution,
} from './legacy-retirement.fixture.mjs'

// Disposable local stores only. Nothing here reads, writes or shuts down a deployed store.
describe('legacy LangGraph retirement controls (M16.03, #940)', () => {
  test('version and deprecation markers match exactly the public graph routes', async () => {
    const source = await readFile(
      new URL(
        '../../../apps/control-api/src/graphs/graph-administration.controller.ts',
        import.meta.url
      ),
      'utf8'
    )
    const routes = [...source.matchAll(/@Post\('([a-z-]+)'\)/g)].map(([, route]) => route)
    expect(routes.toSorted()).toEqual([...LEGACY_GRAPH_API.operations].toSorted())
    expect(LEGACY_GRAPH_API).toMatchObject({
      path: 'graphs',
      version: '1',
      lifecycle: 'deprecated',
    })
  })

  test('an empty disposable store is observed but never establishes zero live work', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const remainder = await readLegacyRemainder(provider, disposable)
      expect(remainder).toMatchObject({ observation: 'observed', exact: true, items: [] })
      expect(remainder.counts).toMatchObject({
        threads: 0,
        executionOnly: 0,
        checkpoints: 0,
        writes: 0,
      })
      expect(remainder.zero).toEqual({
        established: false,
        reasons: ['DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO'],
      })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('interrupted legacy work survives a physical restart, resumes, and turns terminal only with its execution', async () => {
    const { directory, path, provider } = await disposableStore()
    const calls = []
    try {
      const first = await adapterFor(provider, { calls }).run(request)
      expect(first).toMatchObject({ status: 'awaiting_input' })
      await writeExecution(provider, 'awaiting_input')
      provider.close()

      const reopened = await reopen(path)
      try {
        const before = await readLegacyRemainder(reopened, disposable)
        expect(before.counts).toMatchObject({ threads: 1, executionOnly: 0 })
        expect(before.counts.checkpoints).toBeGreaterThan(0)
        expect(before.items[0]).toMatchObject({
          kind: 'checkpoint-thread',
          identity: storageThread,
          executionId: request.executionId,
          classification: 'in-flight',
          blockers: ['IN_FLIGHT_WORK'],
        })
        const planBefore = planLegacyDrain(before)
        expect(planBefore.handoffEligible).toBe(false)
        expect(planBefore.retainedDependencies.length).toBeGreaterThan(0)
        expect(planBefore.items[0].ownerReasons).toContain('GRAPH_IDENTITY_UNKNOWN')

        const resumed = await adapterFor(reopened, { calls }).resume(
          resumeInput(first.checkpointId)
        )
        expect(resumed).toMatchObject({ status: 'completed' })
        expect(calls).toEqual(['prepare', 'finalize'])

        await writeExecution(reopened, 'completed')
        const after = await readLegacyRemainder(reopened, disposable)
        expect(after.items[0]).toMatchObject({ classification: 'terminal', blockers: [] })
        expect(after.zero.established).toBe(false)
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an unconfirmed effect blocks handoff until the execution is reconciled', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const result = await adapterFor(provider, { failOn: 'prepare' }).run(request)
      expect(result).toMatchObject({ status: 'reconciliation_required' })
      await writeExecution(provider, 'reconciliation_required')
      const held = await readLegacyRemainder(provider, disposable)
      const heldItem = held.items.find((item) => item.executionId === request.executionId)
      expect(heldItem).toMatchObject({
        classification: 'uncertain-effect',
        blockers: ['UNCERTAIN_EFFECT_UNRECONCILED'],
      })
      expect(planLegacyDrain(held).handoffEligible).toBe(false)

      // Operator reconciliation is the control plane's execution state transition; this module only reads it.
      await writeExecution(provider, 'failed')
      const reconciled = await readLegacyRemainder(provider, disposable)
      const reconciledItem = reconciled.items.find(
        (item) => item.executionId === request.executionId
      )
      expect(reconciled.counts.executionOnly).toBe(0)
      expect(reconciledItem === undefined || reconciledItem.blockers.length === 0).toBe(true)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a held handoff fence refuses a second owner and resume until released, across a restart', async () => {
    const { directory, path, provider } = await disposableStore()
    const calls = []
    try {
      const first = await adapterFor(provider, { calls }).run(request)
      expect(first).toMatchObject({ status: 'awaiting_input' })
      await writeExecution(provider, 'awaiting_input')
      const held = await claimLegacyDrainFence(provider, {
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      await expect(
        claimLegacyDrainFence(provider, { storageThreadId: storageThread, owner: 'drain-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
      await expect(
        adapterFor(provider, { calls, resumeFence: createLegacyResumeFence(provider) }).resume(
          resumeInput(first.checkpointId)
        )
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
      expect(calls).toEqual(['prepare'])
      provider.close()

      const reopened = await reopen(path)
      try {
        await expect(
          claimLegacyDrainFence(reopened, { storageThreadId: storageThread, owner: 'drain-b' })
        ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_HELD' })
        await expect(
          releaseLegacyDrainFence(reopened, { ...held, owner: 'drain-b' })
        ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_NOT_OWNED' })
        expect(await releaseLegacyDrainFence(reopened, held)).toBe(true)
        expect(await releaseLegacyDrainFence(reopened, held)).toBe(false)
        const resumed = await adapterFor(reopened, {
          calls,
          resumeFence: createLegacyResumeFence(reopened),
        }).resume(resumeInput(first.checkpointId))
        expect(resumed).toMatchObject({ status: 'completed' })
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a generation at the safe-integer boundary is refused before any write, and the last issuable one releases', async () => {
    const { directory, provider } = await disposableStore()
    const maximum = Number.MAX_SAFE_INTEGER
    const idOf = (thread) => `fence:${createHash('sha256').update(thread).digest('hex')}`
    const seedCounter = (thread, generation) =>
      provider.transaction((tx) =>
        tx.put({
          namespace: LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE,
          id: idOf(thread),
          value: { storageThreadId: thread, generation },
        })
      )
    const stateOf = (thread) =>
      provider.transaction(async (tx) => ({
        counter: await tx.get(LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE, idOf(thread)),
        live: await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, idOf(thread)),
      }))
    try {
      const last = `${storageThread}:last-generation`
      await seedCounter(last, maximum - 2)
      const issued = await claimLegacyDrainFence(provider, {
        storageThreadId: last,
        owner: 'drain-a',
      })
      expect(issued.generation).toBe(maximum - 1)
      expect(await releaseLegacyDrainFence(provider, issued)).toBe(true)
      const stored = await stateOf(last)
      await expect(
        claimLegacyDrainFence(provider, { storageThreadId: last, owner: 'drain-b' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
      expect(await stateOf(last)).toEqual(stored)

      // A counter at the maximum, or one below it, would issue a generation no release accepts: refused before any write.
      for (const [name, generation] of [
        ['at-maximum', maximum - 1],
        ['maximum', maximum],
      ]) {
        const thread = `${storageThread}:${name}`
        await seedCounter(thread, generation)
        const before = await stateOf(thread)
        await expect(
          claimLegacyDrainFence(provider, { storageThreadId: thread, owner: 'drain-a' })
        ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_STATE_INVALID' })
        expect(await stateOf(thread)).toEqual(before)
      }

      // A counter past the safe range does not parse as a generation: the persisted record fails closed before any write.
      const unsafe = `${storageThread}:past-safe-range`
      await seedCounter(unsafe, maximum + 1)
      const beforeUnsafe = await stateOf(unsafe)
      await expect(
        claimLegacyDrainFence(provider, { storageThreadId: unsafe, owner: 'drain-a' })
      ).rejects.toMatchObject({ code: 'LEGACY_DRAIN_FENCE_INVALID' })
      expect(await stateOf(unsafe)).toEqual(beforeUnsafe)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a release refuses a handle outside the counter domain before reading the fence', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const held = await claimLegacyDrainFence(provider, {
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      await expect(
        releaseLegacyDrainFence(provider, { ...held, generation: Number.MAX_SAFE_INTEGER })
      ).rejects.toMatchObject({ code: 'LEGACY_FENCE_INVALID' })
      await expect(
        releaseLegacyDrainFence(provider, { ...held, revision: Number.MAX_SAFE_INTEGER })
      ).rejects.toMatchObject({ code: 'LEGACY_FENCE_INVALID' })
      expect(await releaseLegacyDrainFence(provider, held)).toBe(true)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a live revision outside the handle domain rolls back the claim and its counter, so nothing commits', async () => {
    const { directory, provider } = await disposableStore()
    const id = `fence:${createHash('sha256').update(storageThread).digest('hex')}`
    const stateOf = () =>
      provider.transaction(async (tx) => ({
        counter: await tx.get(LEGACY_DRAIN_FENCE_GENERATION_NAMESPACE, id),
        live: await tx.get(LEGACY_DRAIN_FENCE_NAMESPACE, id),
      }))
    try {
      // The store performs both writes in the claim's transaction, then reports an out-of-domain revision for the live record.
      for (const reported of [0, Number.MAX_SAFE_INTEGER]) {
        const reportingOutOfDomain = {
          transaction: (operation) =>
            provider.transaction((tx) =>
              operation({
                get: (namespace, key) => tx.get(namespace, key),
                put: async (input) => {
                  const written = await tx.put(input)
                  return input.namespace === LEGACY_DRAIN_FENCE_NAMESPACE
                    ? { ...written, revision: reported }
                    : written
                },
                delete: (namespace, key, revision) => tx.delete(namespace, key, revision),
              })
            ),
        }
        await expect(
          claimLegacyDrainFence(reportingOutOfDomain, {
            storageThreadId: storageThread,
            owner: 'drain-a',
          })
        ).rejects.toMatchObject({ code: 'LEGACY_FENCE_INVALID' })
        expect(await stateOf()).toEqual({ counter: undefined, live: undefined })
      }
      // Nothing committed, so the next honest claim is the first generation.
      const honest = await claimLegacyDrainFence(provider, {
        storageThreadId: storageThread,
        owner: 'drain-a',
      })
      expect(honest.generation).toBe(1)
      expect(await releaseLegacyDrainFence(provider, honest)).toBe(true)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a bounded read reports lower bounds and never an exact or zero claim', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const saver = new LangGraphSqliteCheckpointSaver(provider, scope)
      for (let index = 0; index < 5; index += 1) {
        await saver.put(
          {
            configurable: {
              thread_id: `${request.workspaceId}:${request.executionId}:bounded-${index}`,
              checkpoint_ns: '',
            },
          },
          emptyCheckpoint(),
          metadata,
          {}
        )
      }
      const bounded = await readLegacyRemainder(provider, {
        ...disposable,
        maximumRecords: 3,
        pageSize: 2,
      })
      expect(bounded).toMatchObject({
        observation: 'incomplete',
        exact: false,
        truncated: { checkpoints: true },
      })
      expect(bounded.counts.checkpoints).toBeLessThanOrEqual(3)
      expect(bounded.zero.established).toBe(false)
      expect(bounded.zero.reasons).toContain('READ_INCOMPLETE')

      const full = await readLegacyRemainder(provider, { ...disposable, maximumRecords: 100 })
      expect(full).toMatchObject({ observation: 'observed', exact: true })
      expect(full.counts).toMatchObject({ threads: 5, checkpoints: 5 })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('exact counts match an independent count of the persisted checkpoint records', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const saver = new LangGraphSqliteCheckpointSaver(provider, scope)
      const config = {
        configurable: {
          thread_id: `${request.workspaceId}:${request.executionId}:counted`,
          checkpoint_ns: '',
        },
      }
      const first = await saver.put(config, emptyCheckpoint(), metadata, {})
      const second = await saver.put(first, emptyCheckpoint(), { ...metadata, step: 1 }, {})
      await saver.putWrites(
        second,
        [
          ['channel', { value: 1 }],
          ['channel', { value: 2 }],
        ],
        'task'
      )

      const remainder = await readLegacyRemainder(provider, disposable)
      const persisted = await provider.transaction((tx) => tx.list(LEGACY_CHECKPOINT_NAMESPACE))
      const kinds = persisted.map((record) => record.value.kind)
      expect(remainder.exact).toBe(true)
      expect(remainder.counts).toMatchObject({
        threads: 1,
        checkpoints: kinds.filter((kind) => kind === 'checkpoint').length,
        writes: kinds.filter((kind) => kind === 'write').length,
        unparseableCheckpointRecords: 0,
      })
      expect(remainder.items[0]).toMatchObject({
        classification: 'orphaned',
        blockers: ['ORPHANED_THREAD'],
      })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('owner selection stays with the legacy saver unless an equivalent replacement is proven for the exact graph', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const graph = {
        graphDefinitionId: 'legacy-graph',
        graphVersion: '1.0.0',
        contentDigest: `sha256:${'c'.repeat(64)}`,
      }
      const plan = {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'d'.repeat(64)}`,
        graph: { reference: graph },
      }
      await provider.transaction(async (tx) => {
        await tx.put({
          namespace: LEGACY_EXECUTION_PLAN_NAMESPACE,
          id: plan.executionPlanId,
          value: plan,
        })
        await tx.put({
          namespace: LEGACY_EXECUTION_NAMESPACE,
          id: request.executionId,
          value: {
            executionId: request.executionId,
            state: 'completed',
            correlation: { workspaceId: request.workspaceId },
            executionPlan: {
              executionPlanId: plan.executionPlanId,
              contentDigest: plan.contentDigest,
            },
          },
        })
      })
      await new LangGraphSqliteCheckpointSaver(provider, scope).put(
        { configurable: { thread_id: storageThread, checkpoint_ns: '' } },
        emptyCheckpoint(),
        metadata,
        {}
      )
      // Injected plan verifier: the test seam stands in for canonical plan verification, not for evidence.
      const verifyPlan = (value) => ({
        executionPlanId: value.executionPlanId,
        contentDigest: value.contentDigest,
        graph: value.graph.reference,
      })
      const remainder = await readLegacyRemainder(provider, { ...disposable, verifyPlan })
      expect(remainder.items[0].graph).toEqual(graph)

      const equivalent = [
        { graph, outcome: 'evidence-equivalent', reportDigest: `sha256:${'e'.repeat(64)}` },
      ]
      const proof = [{ graph, outcome: 'proven' }]
      expect(planLegacyDrain(remainder).items[0].ownerReasons).toEqual([
        'NO_COMPATIBLE_REPLACEMENT_EVIDENCE',
      ])
      expect(
        planLegacyDrain(remainder, {
          replacements: [{ ...equivalent[0], outcome: 'evidence-divergent' }],
        }).items[0].ownerReasons
      ).toEqual(['EVIDENCE_DIVERGENT'])
      expect(
        planLegacyDrain(remainder, { replacements: equivalent }).items[0].ownerReasons
      ).toEqual(['PROFILE_OR_FAILURE_EVIDENCE_UNPROVEN'])

      const ready = planLegacyDrain(remainder, {
        replacements: equivalent,
        profiles: proof,
        failures: proof,
      })
      expect(ready.items[0]).toMatchObject({
        selectedOwner: 'typed-replacement',
        handoffEligible: true,
        blockers: [],
      })
      expect(ready.handoffEligible).toBe(true)
      expect(ready.retainedDependencies).toEqual([
        'langgraph-checkpoints-v1 namespace',
        'LangGraph checkpoint saver composition',
      ])
      // Disposable scope can never satisfy the removal condition, even with eligible handoff.
      expect(ready.removal.satisfied).toBe(false)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('non-terminal executions without a checkpoint thread stay visible as blockers', async () => {
    const { directory, provider } = await disposableStore()
    try {
      await writeExecution(provider, 'queued')
      const remainder = await readLegacyRemainder(provider, disposable)
      expect(remainder.counts).toMatchObject({
        threads: 0,
        executionOnly: 1,
        inFlightExecutions: 1,
      })
      expect(remainder.items[0]).toMatchObject({
        kind: 'execution-only',
        identity: `execution:${request.executionId}`,
        classification: 'in-flight',
        blockers: ['IN_FLIGHT_WORK'],
      })
      expect(remainder.zero.reasons).toContain('IN_FLIGHT_EXECUTIONS_PRESENT')
      expect(planLegacyDrain(remainder).handoffEligible).toBe(false)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the admission gate stays open without deployed zero, evidence and an explicit request', async () => {
    const { directory, provider } = await disposableStore()
    try {
      const remainder = await readLegacyRemainder(provider, disposable)
      const graph = request.graph
      const complete = {
        remainder,
        admissibleGraphs: [graph],
        replacements: [
          { graph, outcome: 'evidence-equivalent', reportDigest: `sha256:${'f'.repeat(64)}` },
        ],
        profiles: [{ graph, outcome: 'proven' }],
        failures: [{ graph, outcome: 'proven' }],
        closureRequested: true,
      }
      expect(evaluateLegacyAdmissionGate(complete)).toEqual({
        decision: 'open',
        reasons: ['REMAINING_NOT_DEPLOYED_SCOPE', 'REMAINING_ZERO_NOT_ESTABLISHED'],
      })
      const missing = evaluateLegacyAdmissionGate({
        ...complete,
        replacements: [],
        profiles: [],
        failures: [],
        closureRequested: false,
      })
      expect(missing.decision).toBe('open')
      expect(missing.reasons).toEqual(
        expect.arrayContaining([
          'REPLACEMENT_NOT_EQUIVALENT:deterministic-interrupt@1.0.0',
          'PROFILE_UNPROVEN:deterministic-interrupt@1.0.0',
          'FAILURE_UNPROVEN:deterministic-interrupt@1.0.0',
          'CLOSURE_NOT_REQUESTED',
        ])
      )
      await expect(
        createLegacyAdmissionGuard(() => complete).assertNewAdmissionAllowed()
      ).resolves.toBeUndefined()

      // Synthetic deployed-dsn remainder: exercises the gate arithmetic only. No observation here is deployed or zero.
      const synthetic = {
        ...remainder,
        observationScope: 'deployed-dsn',
        zero: { established: true, reasons: [] },
      }
      const eligible = { ...complete, remainder: synthetic }
      expect(evaluateLegacyAdmissionGate({ ...eligible, closureRequested: false }).decision).toBe(
        'open'
      )
      expect(evaluateLegacyAdmissionGate(eligible)).toEqual({
        decision: 'closure-eligible',
        reasons: [],
      })
      await expect(
        createLegacyAdmissionGuard(() => eligible).assertNewAdmissionAllowed()
      ).rejects.toMatchObject({ code: 'LEGACY_ADMISSION_CLOSED' })

      const refusedBeforeWrite = adapterFor(provider, {
        admissionGuard: createLegacyAdmissionGuard(() => eligible),
      })
      await expect(refusedBeforeWrite.run(request)).rejects.toMatchObject({
        code: 'LEGACY_ADMISSION_CLOSED',
      })
      const afterRefusal = await readLegacyRemainder(provider, disposable)
      expect(afterRefusal.counts.checkpoints).toBe(0)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
