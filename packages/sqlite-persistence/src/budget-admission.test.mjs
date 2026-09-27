import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandInboxService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
  SqliteDurableUsageStore,
  SQLITE_USAGE_NAMESPACES,
} from './index.ts'

const at = '2026-08-24T10:00:00.000Z'
const id = (prefix, tail = 'G') => `${prefix}_01JABCDEF0123456789ABCDEF${tail}`
const plan = createExecutionPlanTestFixture()

function input(selectedPlan = plan, tail = 'G', extra = {}) {
  const { workspaceId, projectId, taskId, agentId } = selectedPlan.correlation
  return {
    callerPrincipalId: 'svc_budget-admission',
    operation: 'execution.accept',
    commandId: id('cmd', tail),
    requestId: selectedPlan.correlation.requestId,
    idempotencyKey: `budget-admission-${tail}-0001`,
    payloadHash: (tail === 'G' ? 'a' : 'b').repeat(64),
    correlation: { workspaceId, projectId, taskId, agentId },
    executionPlan: {
      executionPlanId: selectedPlan.executionPlanId,
      contentDigest: selectedPlan.contentDigest,
      schemaVersion: selectedPlan.schemaVersion,
    },
    receivedAt: at,
    retentionExpiresAt: '2026-09-23T10:00:00.000Z',
    ...extra,
  }
}

function commands(provider, tail = 'G', enabled = true) {
  return new CommandInboxService({
    repository: new SqliteCommandAcceptanceRepository(provider, { budgetAdmission: enabled }),
    executionIdFactory: () => id('exe', tail),
    executionPlanValidator: { validate: async () => true },
    now: () => at,
  })
}

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-native-budget-admission-'))
  const path = join(directory, 'state.sqlite')
  const providers = []
  const open = async () => {
    const provider = new SqlitePersistenceProvider({ path })
    providers.push(provider)
    await provider.migrate()
    return provider
  }
  try {
    const provider = await open()
    await new SqliteContextPackageRepository(provider).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new SqliteExecutionPlanRepository(provider).put(plan)
    const ledger = new DurableUsageLedger({ store: new SqliteDurableUsageStore(provider) })
    await operation({ provider, ledger, open })
  } finally {
    await Promise.all(providers.map((provider) => provider.close()))
    await rm(directory, { recursive: true, force: true })
  }
}

async function records(provider) {
  return provider.transaction(async (transaction) =>
    Object.fromEntries(
      await Promise.all(
        [
          'command-inbox',
          'executions',
          'command-by-execution',
          ...Object.values(SQLITE_USAGE_NAMESPACES),
        ].map(async (namespace) => [namespace, await transaction.list(namespace)])
      )
    )
  )
}

function childPlan() {
  return deriveExecutionPlan(plan, {
    correlation: { ...plan.correlation, taskId: id('tsk', 'H'), requestId: id('req', 'H') },
    contextPackage: contextPackageSerializationFixtures.futurePi,
    constraints: plan.constraints,
    runtimeRequirements: plan.runtimeRequirements,
    outputContract: plan.outputContract,
    compiledAt: at,
  })
}

test('native admission race and direct duplicate preserve one allocation after plan cleanup and reopen', async () => {
  await fixture(async ({ provider, open }) => {
    const second = await open()
    // Drain both calls before closing either provider. Independent connections
    // may report SQLite's bounded busy error; retry only after the winner commits.
    const attempts = await Promise.allSettled([
      commands(provider).acceptExecution(input()),
      commands(second).acceptExecution(input()),
    ])
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 })
      }
    }
    const results = attempts
      .filter((attempt) => attempt.status === 'fulfilled')
      .map((attempt) => attempt.value)
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    const accepted = results[0]
    expect((await commands(second).acceptExecution(input())).replayed).toBe(true)
    expect(
      await new SqliteCommandAcceptanceRepository(provider, {
        budgetAdmission: true,
      }).accept(accepted.command, accepted.execution)
    ).toMatchObject({ outcome: 'duplicate' })
    const before = await records(provider)
    await provider.transaction(async (transaction) => {
      for (const stored of await transaction.list('execution-plans')) {
        await transaction.delete('execution-plans', stored.id)
      }
    })
    await second.close()
    await provider.close()
    const reopened = await open()
    const replay = await commands(reopened).acceptExecution(input())
    expect(replay.replayed).toBe(true)
    expect(replay.execution.executionId).toBe(accepted.execution.executionId)
    expect(await records(reopened)).toEqual(before)
    // The prior ledger instance is intentionally closed; durable reads use the reopened store.
    const entries = await new DurableUsageLedger({
      store: new SqliteDurableUsageStore(reopened),
    }).entries(plan.correlation.workspaceId, accepted.execution.executionId)
    expect(entries).toHaveLength(1)
  })
}, 15_000)

test('native admission rolls back command, owner, index and accounting when opening receipt fails', async () => {
  await fixture(async ({ provider }) => {
    const failing = {
      dialect: 'sqlite',
      transaction: (operation) =>
        provider.transaction((transaction) =>
          operation(
            new Proxy(transaction, {
              get(target, property) {
                if (property === 'put')
                  return async (record) => {
                    if (record.namespace === SQLITE_USAGE_NAMESPACES.effects) {
                      throw new Error('INJECTED_OPENING_RECEIPT_FAILURE')
                    }
                    return target.put(record)
                  }
                const value = Reflect.get(target, property)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          )
        ),
    }
    const before = await records(provider)
    await expect(commands(failing).acceptExecution(input())).rejects.toThrow(
      'INJECTED_OPENING_RECEIPT_FAILURE'
    )
    expect(await records(provider)).toEqual(before)
  })
})

test('native legacy owners without accounting are not automatically allocated on replay', async () => {
  await fixture(async ({ provider }) => {
    const accepted = await commands(provider, 'G', false).acceptExecution(input())
    const before = await records(provider)
    await expect(commands(provider).acceptExecution(input())).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
    await expect(
      new SqliteCommandAcceptanceRepository(provider, {
        budgetAdmission: true,
      }).accept(accepted.command, accepted.execution)
    ).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
    expect(await records(provider)).toEqual(before)
  })
})

test.each(['opening source', 'opening receipt'])(
  'native replay rejects damaged %s without rewriting persisted state',
  async (damage) => {
    await fixture(async ({ provider, open }) => {
      const accepted = await commands(provider).acceptExecution(input())
      await provider.transaction(async (transaction) => {
        const namespace =
          damage === 'opening source'
            ? SQLITE_USAGE_NAMESPACES.entries
            : SQLITE_USAGE_NAMESPACES.effects
        const [stored] = await transaction.list(namespace)
        const value = structuredClone(stored.value)
        if (damage === 'opening source') value.source.sourceId = 'foreign-allocation'
        else value.result.spentTokens += 1
        await transaction.put({ ...stored, expectedRevision: stored.revision, value })
      })
      const before = await records(provider)
      await provider.close()
      const reopened = await open()
      await expect(commands(reopened).acceptExecution(input())).rejects.toMatchObject({
        code: 'STORE_STATE_INVALID',
      })
      await expect(
        new SqliteCommandAcceptanceRepository(reopened, {
          budgetAdmission: true,
        }).accept(accepted.command, accepted.execution)
      ).rejects.toMatchObject({
        code: 'STORE_STATE_INVALID',
      })
      expect(await records(reopened)).toEqual(before)
    })
  }
)

test('native settled allowance rejects active replay but permits canonical terminal replay', async () => {
  await fixture(async ({ provider, ledger }) => {
    const accepted = await commands(provider).acceptExecution(input())
    await ledger.finalizeBudget({
      workspaceId: plan.correlation.workspaceId,
      executionId: accepted.execution.executionId,
      source: { sourceId: 'test-no-effects', idempotencyKey: 'test-no-effects-finalize' },
    })
    await expect(commands(provider).acceptExecution(input())).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
    await provider.transaction(async (transaction) => {
      const [owner] = await transaction.list('executions')
      await transaction.put({
        ...owner,
        expectedRevision: owner.revision,
        value: {
          ...owner.value,
          state: 'completed',
          terminalAt: at,
        },
      })
    })
    expect((await commands(provider).acceptExecution(input())).replayed).toBe(true)
    expect(
      await ledger.entries(plan.correlation.workspaceId, accepted.execution.executionId)
    ).toHaveLength(2)
  })
})

test.each(['exhausted', 'cross-project'])(
  'native child admission rolls back against a %s parent',
  async (kind) => {
    await fixture(async ({ provider, ledger }) => {
      const accepted = await commands(provider).acceptExecution(input())
      const child = childPlan()
      await new SqliteExecutionPlanRepository(provider).put(child)
      if (kind === 'exhausted') {
        await ledger.reserve({
          workspaceId: plan.correlation.workspaceId,
          executionId: accepted.execution.executionId,
          reservationKey: 'consume-all-capacity',
          maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
          maximumTokens: plan.constraints.limits.tokens.maximumTotal,
          source: { sourceId: 'capacity-fixture', idempotencyKey: 'consume-all-capacity' },
        })
      } else {
        await provider.transaction(async (transaction) => {
          const [owner] = await transaction.list('executions')
          await transaction.put({
            ...owner,
            expectedRevision: owner.revision,
            value: {
              ...owner.value,
              correlation: { ...owner.value.correlation, projectId: id('prj', 'H') },
            },
          })
        })
      }
      const before = await records(provider)
      await expect(
        commands(provider, 'H').acceptExecution(
          input(child, 'H', {
            parentExecutionId: accepted.execution.executionId,
          })
        )
      ).rejects.toMatchObject({
        code: kind === 'exhausted' ? 'BUDGET_EXHAUSTED' : 'INVALID_EXECUTION_PLAN_REFERENCE',
      })
      expect(await records(provider)).toEqual(before)
    })
  }
)

test('native child allocation clips both plan ceilings to parent availability and replays at zero remaining capacity', async () => {
  await fixture(async ({ provider, ledger }) => {
    const parent = await commands(provider).acceptExecution(input())
    const child = childPlan()
    await new SqliteExecutionPlanRepository(provider).put(child)
    await ledger.reserve({
      workspaceId: plan.correlation.workspaceId,
      executionId: parent.execution.executionId,
      reservationKey: 'prior-parent-work',
      maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits - 100,
      maximumTokens: plan.constraints.limits.tokens.maximumTotal - 10,
      source: { sourceId: 'prior-parent-work', idempotencyKey: 'prior-parent-work' },
    })
    const request = input(child, 'H', { parentExecutionId: parent.execution.executionId })
    const accepted = await commands(provider, 'H').acceptExecution(request)
    expect(
      await ledger.summary(plan.correlation.workspaceId, accepted.execution.executionId)
    ).toMatchObject({ maximumMicrounits: 100, maximumTokens: 10 })
    expect(
      await ledger.summary(plan.correlation.workspaceId, parent.execution.executionId)
    ).toMatchObject({ availableMicrounits: 0, availableTokens: 0 })
    const before = await records(provider)
    expect((await commands(provider, 'H').acceptExecution(request)).replayed).toBe(true)
    expect(await records(provider)).toEqual(before)
  })
})
