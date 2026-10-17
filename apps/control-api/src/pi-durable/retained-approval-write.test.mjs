import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { InteractionService } from '@control-plane/domain'
import { createRetainedApprovalWriteRunner } from '@control-plane/pi-durable-adapter'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { fixture } from '../models/canonical-model-host-fixtures.mjs'
import {
  approverA,
  compose,
  interactionId,
  seedDatabase,
  taskFor,
  toolCallId,
  working,
} from './retained-approval-write.harness.mjs'

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retained-approval-write-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function trackedRunner({ effects, interactions, registry }, observations) {
  const readVersion = registry.readVersion.bind(registry)
  registry.readVersion = async (...args) => {
    observations.registryReads = (observations.registryReads ?? 0) + 1
    const version = await readVersion(...args)
    return observations.rewriteVersion?.(version, observations.registryReads) ?? version
  }

  return createRetainedApprovalWriteRunner({
    registry,
    interactions,
    effects: {
      async execute(request) {
        observations.effectCalls += 1
        await observations.beforeExecute?.({ interactions, registry })
        return effects.execute(request)
      },
    },
  })
}

test('approval gates the authorized write, settles once, and replays after physical reopen without a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f)
      const pending = await first.runner.run(task)
      expect(pending).toMatchObject({ state: 'awaiting_approval' })
      expect(await first.interactions.get(interactionId)).toMatchObject({ state: 'pending' })
      expect(counter.invocations).toBe(0)

      await new InteractionService(first.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      const settled = await first.runner.run(task)
      expect(settled).toMatchObject({ state: 'succeeded', call: { toolCallId } })
      expect(counter.invocations).toBe(1)
      first.close()

      const reopened = await compose(directory, f, { counter, clock })
      try {
        await expect(reopened.runner.run(task)).resolves.toEqual(settled)
        expect(counter.invocations).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      first.close()
    }
  })
})

test('a revoked approval cannot authorize the write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      await session.runner.run(taskFor(f))
      await new InteractionService(session.interactions).resolveTerminal(interactionId, working)
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('changed pins after restart conflict with the retained effect instead of creating a second write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    try {
      await first.runner.run(taskFor(f))
      await new InteractionService(first.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      await first.runner.run(taskFor(f))
      expect(counter.invocations).toBe(1)
      first.close()

      const reopened = await compose(directory, f, { counter, clock })
      try {
        const changed = taskFor(f, { input: { headline: 'Changed after approval', labels: [] } })
        await expect(reopened.runner.run(changed)).rejects.toMatchObject({
          code: 'PI_EFFECT_IDENTITY_CONFLICT',
        })
        expect(counter.invocations).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      first.close()
    }
  })
})

test('missing or stale tool, version, and operation pins are rejected before approval or effects', async () => {
  const invalidPins = [
    [
      (task) => {
        task.request.toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFZ'
        task.request.grant.toolDefinitionId = task.request.toolDefinitionId
      },
      'RETAINED_TOOL_PIN_UNAVAILABLE',
    ],
    [
      (task) => {
        task.request.toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFZ'
        task.request.grant.toolVersionId = task.request.toolVersionId
      },
      'VERSION_MISSING',
    ],
    [
      (task) => {
        task.request.operation = 'delete-json'
        task.request.grant.operations = ['delete-json']
      },
      'RETAINED_TOOL_PIN_UNAVAILABLE',
    ],
  ]

  for (const [mutateTask, expectedCode] of invalidPins) {
    await withDirectory(async (directory) => {
      const f = await fixture()
      await seedDatabase(join(directory, 'state.sqlite'), f)
      const counter = { invocations: 0 }
      const observations = { effectCalls: 0 }
      const session = await compose(directory, f, {
        counter,
        clock: { now: working },
        createRunner: (options) => trackedRunner(options, observations),
      })
      try {
        const task = taskFor(f)
        mutateTask(task)

        await expect(session.runner.run(task)).rejects.toMatchObject({ code: expectedCode })
        expect(await session.interactions.get(interactionId)).toBeUndefined()
        expect(observations.effectCalls).toBe(0)
        expect(counter.invocations).toBe(0)
      } finally {
        session.close()
      }
    })
  }
})

test('a revoked tool version is refused with a typed preflight error before approval', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const observations = {
      effectCalls: 0,
      rewriteVersion: (version) => ({ ...version, lifecycle: 'revoked' }),
    }
    const session = await compose(directory, f, {
      counter,
      clock: { now: working },
      createRunner: (options) => trackedRunner(options, observations),
    })
    try {
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        name: 'RetainedApprovalWriteError',
        code: 'RETAINED_TOOL_PIN_UNAVAILABLE',
      })
      expect(observations.registryReads).toBe(1)
      expect(await session.interactions.get(interactionId)).toBeUndefined()
      expect(observations.effectCalls).toBe(0)
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('tool lifecycle drift after preflight is rejected by the final gate before the write', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    let drifted = false
    const observations = {
      effectCalls: 0,
      rewriteVersion(version) {
        return drifted ? { ...version, lifecycle: 'revoked' } : version
      },
      beforeExecute() {
        drifted = true
      },
    }
    const session = await compose(directory, f, {
      counter,
      clock: { now: working },
      createRunner: (options) => trackedRunner(options, observations),
    })
    try {
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(drifted).toBe(true)
      expect(observations.registryReads).toBeGreaterThan(1)
      expect(await session.interactions.get(interactionId)).toMatchObject({ state: 'pending' })
      expect(observations.effectCalls).toBe(1)
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('approval revocation after preflight is rejected by the final effect gate', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const observations = {
      effectCalls: 0,
      async beforeExecute({ interactions }) {
        await new InteractionService(interactions).resolveTerminal(interactionId, working)
      },
    }
    const session = await compose(directory, f, {
      counter,
      clock: { now: working },
      createRunner: (options) => trackedRunner(options, observations),
    })
    try {
      await expect(session.runner.run(taskFor(f))).rejects.toMatchObject({
        code: 'PI_EFFECT_AUTHORITY_REJECTED',
      })
      expect(await session.interactions.get(interactionId)).toMatchObject({ state: 'cancelled' })
      expect(observations.effectCalls).toBe(1)
      expect(counter.invocations).toBe(0)
    } finally {
      session.close()
    }
  })
})

test('concurrent runs of one approved task settle once', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0 }
    const clock = { now: working }
    const session = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f)
      await session.runner.run(task)
      await new InteractionService(session.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      const results = await Promise.allSettled([1, 2, 3].map(() => session.runner.run(task)))
      const fulfilled = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      for (const outcome of fulfilled) expect(outcome).toEqual(fulfilled[0])
      expect(fulfilled[0]).toMatchObject({ state: 'succeeded' })
      expect(counter.invocations).toBe(1)
    } finally {
      session.close()
    }
  })
})

test('an uncertain write settles once as reconciliation and is never retried after reopen', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    await seedDatabase(join(directory, 'state.sqlite'), f)
    const counter = { invocations: 0, failNext: true }
    const clock = { now: working }
    const first = await compose(directory, f, { counter, clock })
    try {
      const task = taskFor(f, { taskId: 'rwt_01JABCDEF0123456789ABCDEFI' })
      await first.runner.run(task)
      await new InteractionService(first.interactions).respond({
        interactionId,
        executionId: f.intent.executionId,
        attemptId: f.intent.attemptId,
        responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
        action: 'approve',
        respondingPrincipalId: approverA,
        expectedVersion: 1,
        respondedAt: '2026-10-08T12:05:00.000Z',
      })
      const uncertain = await first.runner.run(task)
      expect(uncertain).toMatchObject({ state: 'reconciliation_required' })
      expect(counter.invocations).toBe(1)
      first.close()

      const reopened = await compose(directory, f, { counter, clock })
      try {
        await expect(reopened.runner.run(task)).resolves.toEqual(uncertain)
        expect(counter.invocations).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      first.close()
    }
  })
})

test('composition closes the acquired provider when migration fails and preserves that failure', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    const migrationFailure = new Error('MIGRATION_FAILED')
    let providerCloseCount = 0

    await expect(
      compose(directory, f, {
        createProvider: () => ({
          migrate: async () => {
            throw migrationFailure
          },
          close() {
            providerCloseCount += 1
            throw new Error('PROVIDER_CLOSE_FAILED')
          },
        }),
      })
    ).rejects.toBe(migrationFailure)
    expect(providerCloseCount).toBe(1)
  })
})

test('composition closes the provider and effect database once when runner setup fails after opening both', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    const setupFailure = new Error('RUNNER_SETUP_FAILED')
    const closes = { provider: 0, effectDatabase: 0 }

    const createProvider = (options) => {
      const provider = new SqlitePersistenceProvider(options)
      const close = provider.close.bind(provider)
      provider.close = (...args) => {
        closes.provider += 1
        return close(...args)
      }
      return provider
    }
    const createEffectDatabase = (path) => {
      const database = new DatabaseSync(path)
      const close = database.close.bind(database)
      database.close = (...args) => {
        closes.effectDatabase += 1
        return close(...args)
      }
      return database
    }

    await expect(
      compose(directory, f, {
        createProvider,
        createEffectDatabase,
        createRunner: () => {
          throw setupFailure
        },
      })
    ).rejects.toBe(setupFailure)
    expect(closes).toEqual({ provider: 1, effectDatabase: 1 })
  })
})

test('session close is idempotent for its acquired handles', async () => {
  await withDirectory(async (directory) => {
    const f = await fixture()
    const closes = { provider: 0, effectDatabase: 0 }
    const createProvider = (options) => {
      const provider = new SqlitePersistenceProvider(options)
      const close = provider.close.bind(provider)
      provider.close = (...args) => {
        closes.provider += 1
        return close(...args)
      }
      return provider
    }
    const createEffectDatabase = (path) => {
      const database = new DatabaseSync(path)
      const close = database.close.bind(database)
      database.close = (...args) => {
        closes.effectDatabase += 1
        return close(...args)
      }
      return database
    }
    const session = await compose(directory, f, { createProvider, createEffectDatabase })

    expect(() => session.close()).not.toThrow()
    expect(() => session.close()).not.toThrow()
    expect(closes).toEqual({ provider: 1, effectDatabase: 1 })
  })
})
