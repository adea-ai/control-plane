import { expect, test } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry, defineTask } from '@earendil-works/pi-durable'
import { openCloudflarePiStorage } from './storage.ts'
import { fixture } from './test-fixtures.mjs'

// Actual Pi Harness lifecycle with a deterministic durable task; no model provider is installed.
function probe(version, onMigrate = () => {}) {
  const task = defineTask({
    name: 'cloudflare-qualification',
    version,
    initial: () => ({ phase: 'checkpoint' }),
    phases: {
      checkpoint: async (runningTask, runtime, context) =>
        runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'completed', result: runningTask.input },
          }),
          context
        ),
    },
    abort: async (_runningTask, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
    migrate(input, checkpoint, fromVersion) {
      if (fromVersion !== 1 || version !== 2) throw new Error('UNSUPPORTED_PROBE_VERSION')
      onMigrate(fromVersion)
      return { input, checkpoint }
    },
  })
  const registry = createRegistry()
  registry.install({ name: 'cloudflare-qualification', tasks: [task] })
  return { task, registry }
}

test('actual Pi Harness reopens a pending checkpoint through an explicit supported task upgrade', async () => {
  const f = fixture()
  const models = createModels()
  let first, reopened
  try {
    const before = probe(1)
    first = await Harness.open(
      await openCloudflarePiStorage(f.storage),
      { models, registry: before.registry },
      BACKGROUND_CONTEXT
    )
    const root = await first.root(BACKGROUND_CONTEXT)
    const input = {
      admittedPlanDigest: `sha256:${'a'.repeat(64)}`,
      opaqueAttemptId: 'fixture-attempt',
    }
    const taskId = await root.commit(
      (tx) => tx.createTask(before.task, input, { ownership: { kind: 'conversation' } }),
      BACKGROUND_CONTEXT
    )
    expect((await first.getTask(taskId, BACKGROUND_CONTEXT)).state.status).toBe('pending')
    await first.close(BACKGROUND_CONTEXT)
    first = undefined
    let migratedFrom
    const after = probe(2, (version) => {
      migratedFrom = version
    })
    reopened = await Harness.open(
      await openCloudflarePiStorage(f.storage),
      { models, registry: after.registry },
      BACKGROUND_CONTEXT
    )
    const settled = await reopened.waitForTask(taskId, BACKGROUND_CONTEXT)
    expect(settled.state.outcome).toEqual({ status: 'completed', result: input })
    expect(migratedFrom).toBe(1)
    expect((await reopened.root(BACKGROUND_CONTEXT)).id).toBe(root.id)
  } finally {
    await first?.close(BACKGROUND_CONTEXT)
    await reopened?.close(BACKGROUND_CONTEXT)
    f.db.close()
  }
}, 5000)
