import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ManagedPiDriver, translateExecutionPlanToManagedPi } from './index.ts'
import { ManagedPiProcessClient } from './process-client.ts'

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const plan = createExecutionPlanTestFixture()
const attemptBudget = {
  schemaVersion: 1,
  workspaceId: plan.correlation.workspaceId,
  executionId,
  attemptId,
  executionPlanId: plan.executionPlanId,
  executionPlanDigest: plan.contentDigest,
  reservationKey: `runtime-attempt:${attemptId}`,
  currency: 'USD',
  maximumMicrounits: 1,
  maximumTokens: 1,
}

test('managed Pi driver forwards the pinned allocation separately from configuration', async () => {
  let received
  const client = {
    inspect: async () => ({
      driverVersion: '1.1.0',
      runtimeVersion: '1.0.0',
      protocolVersion: '1.0.0',
      health: 'healthy',
      limitations: [],
      observedAt: '2026-10-07T00:00:00Z',
      capabilities: plan.runtimeRequirements.map(({ capability }) => ({
        name: capability,
        support: 'supported',
      })),
    }),
    start: async (command) => {
      received = command
      throw new Error('OBSERVED_NATIVE_START')
    },
  }
  const driver = new ManagedPiDriver({
    client,
    adapterVersion: '1.2.0',
    minimumRuntimeVersion: '1.0.0',
    maximumRuntimeVersionExclusive: '1.1.0',
  })
  await expect(
    driver.start({
      attemptId,
      executionId,
      idempotencyKey: 'allocation:driver',
      executionPlan: plan,
      attemptBudget,
    })
  ).rejects.toThrow('OBSERVED_NATIVE_START')
  expect(received.executionId).toBe(executionId)
  expect(received.attemptBudget).toEqual(attemptBudget)
  expect(Object.isFrozen(received.attemptBudget)).toBe(true)
  expect(received.configuration.executionPlanDigest).toBe(plan.contentDigest)
  expect(received.configuration).not.toHaveProperty('attemptBudget')
})

test('native resolver receives immutable allocation context and admission binds its replay', async () => {
  const directory = await mkdtemp(
    join(process.env.M11_ALLOCATION_TEST_ROOT ?? tmpdir(), 'pi-allocation-')
  )
  const captured = []
  const client = new ManagedPiProcessClient({
    executablePath: '/must-not-be-launched',
    dataDirectory: directory,
    inputResolver: {
      resolveWorkspace: async () => plan.correlation.workspaceId,
      resolve: async (_configuration, context) => {
        captured.push(context)
        throw new Error('OBSERVED_NATIVE_CONTEXT')
      },
    },
  })
  const command = {
    attemptId,
    executionId,
    idempotencyKey: 'allocation:native',
    configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
    attemptBudget: { ...attemptBudget },
  }
  try {
    await expect(client.start(command)).rejects.toThrow('OBSERVED_NATIVE_CONTEXT')
    expect(captured).toEqual([{ attemptId, executionId, attemptBudget }])
    expect(Object.isFrozen(captured[0])).toBe(true)
    expect(Object.isFrozen(captured[0].attemptBudget)).toBe(true)
    command.attemptBudget.maximumTokens = 2
    expect(captured[0].attemptBudget.maximumTokens).toBe(1)
    await expect(client.start(command)).rejects.toThrow('PI_START_IDEMPOTENCY_CONFLICT')
    expect(captured).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each([
  ['execution', { executionId: 'exe_01JBBCDEF0123456789ABCDEFG' }],
  ['workspace', { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' }],
])(
  'native allocation %s mismatch is denied before input resolution and durable admission',
  async (_field, changed) => {
    const directory = await mkdtemp(
      join(process.env.M11_ALLOCATION_TEST_ROOT ?? tmpdir(), 'pi-allocation-denial-')
    )
    let resolutions = 0
    const client = new ManagedPiProcessClient({
      executablePath: '/must-not-be-launched',
      dataDirectory: directory,
      inputResolver: {
        resolveWorkspace: async () => plan.correlation.workspaceId,
        resolve: async () => {
          resolutions++
          throw new Error('UNEXPECTED_RESOLUTION')
        },
      },
    })
    try {
      await expect(
        client.start({
          attemptId,
          executionId,
          idempotencyKey: 'allocation:wrong-owner',
          configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
          attemptBudget: { ...attemptBudget, ...changed },
        })
      ).rejects.toThrow('PI_ATTEMPT_ALLOCATION_MISMATCH')
      expect(resolutions).toBe(0)
      const { readdir } = await import('node:fs/promises')
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('allocation without a trusted workspace resolver is denied before durable admission', async () => {
  const directory = await mkdtemp(
    join(process.env.M11_ALLOCATION_TEST_ROOT ?? tmpdir(), 'pi-allocation-no-scope-')
  )
  let resolutions = 0
  const client = new ManagedPiProcessClient({
    executablePath: '/must-not-be-launched',
    dataDirectory: directory,
    inputResolver: {
      resolve: async () => {
        resolutions++
        throw new Error('UNEXPECTED_RESOLUTION')
      },
    },
  })
  try {
    await expect(
      client.start({
        attemptId,
        executionId,
        idempotencyKey: 'allocation:missing-scope',
        configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
        attemptBudget,
      })
    ).rejects.toThrow('PI_ATTEMPT_ALLOCATION_SCOPE_UNAVAILABLE')
    expect(resolutions).toBe(0)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native start snapshots allocation and replay identity before asynchronous scope lookup', async () => {
  const directory = await mkdtemp(
    join(process.env.M11_ALLOCATION_TEST_ROOT ?? tmpdir(), 'pi-allocation-await-')
  )
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let received
  const client = new ManagedPiProcessClient({
    executablePath: '/must-not-be-launched',
    dataDirectory: directory,
    inputResolver: {
      resolveWorkspace: async () => {
        entered.resolve()
        await release.promise
        return plan.correlation.workspaceId
      },
      resolve: async (_configuration, context) => {
        received = context
        throw new Error('OBSERVED_NATIVE_CONTEXT')
      },
    },
  })
  const original = {
    attemptId,
    executionId,
    idempotencyKey: 'allocation:async-snapshot',
    configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
    attemptBudget,
  }
  const mutable = structuredClone(original)
  try {
    const start = client.start(mutable)
    await entered.promise
    mutable.idempotencyKey = 'allocation:mutated'
    mutable.executionId = 'exe_01JBBCDEF0123456789ABCDEFG'
    mutable.attemptBudget.workspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'
    mutable.attemptBudget.maximumTokens = 2
    release.resolve()
    await expect(start).rejects.toThrow('OBSERVED_NATIVE_CONTEXT')
    expect(received).toEqual({ attemptId, executionId, attemptBudget })
    await expect(client.start(original)).rejects.toThrow('OBSERVED_NATIVE_CONTEXT')
  } finally {
    release.resolve()
    await rm(directory, { recursive: true, force: true })
  }
})
