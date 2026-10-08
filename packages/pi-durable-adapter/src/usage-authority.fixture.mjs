import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DurableUsageLedger, PinnedModelPrice } from '@control-plane/usage-ledger'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  SqlitePersistenceProvider,
  SqliteDurableUsageStore,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
} from '@control-plane/sqlite-persistence'
import { createPiDurableUsageAuthority } from './usage-authority.ts'

export const at = '2026-10-08T00:00:00.000Z'
export const ids = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
}

export async function withUsageAuthorityContext(
  run,
  {
    maximumTokens = 100,
    maximumInputTokens = 64,
    maximumMicrounits = 1000,
    maximumChildExecutions,
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ledger-'))
  const path = join(directory, 'ledger.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  const inputs = createExecutionPlanTestFixtureInputs({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  if (maximumChildExecutions !== undefined) {
    inputs.constraints.limits.childExecutions.maximumTotal = maximumChildExecutions
    inputs.profile.definition.executionConstraints.limits.childExecutions.maximumTotal =
      maximumChildExecutions
  }
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  const workspaceId = plan.correlation.workspaceId
  const authority = {
    request: {
      ...ids,
      idempotencyKey: 'start:one',
      executionPlan: plan,
      attemptBudget: {
        schemaVersion: 1,
        workspaceId,
        ...ids,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
        reservationKey: `runtime-attempt:${ids.attemptId}`,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
      },
    },
    admission: {
      schemaVersion: 'pi-durable-admission/v1',
      prompt: 'hello',
      selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      authority: {
        revision: 1,
        principalRef: 'principal:one',
        scopeRef: 'scope:one',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    },
  }
  const priceSnapshot = {
    schemaVersion: 1,
    deploymentId: 'pi-node',
    provider: 'test',
    model: 'mock',
    version: 'price:1',
    currency: 'USD',
    fundingSource: 'hq_managed',
    validFrom: at,
    validUntil: '2027-01-01T00:00:00.000Z',
    maximumInputTokens,
    maximumOutputTokens: 32,
    ratesMicrounitsPerMillionTokens: { input: 1_000_000, cachedInput: 500_000, output: 2_000_000 },
  }
  const price = new PinnedModelPrice(priceSnapshot, { now: () => at })
  // Scripted spending port: validates bridge sequencing, not live recorded grant integration.
  const spending = {
    active: true,
    reject: false,
    evidenceDigest: `sha256:${'e'.repeat(64)}`,
    assertions: 0,
    requests: [],
  }
  const assertSpendingAuthorized = async (_authority, request) => {
    spending.requests.push(request)
    if (spending.reject) throw new Error('SPENDING_NOT_AUTHORIZED')
    return {
      authorizationRef: 'model-spend:fixture',
      evidenceDigest: spending.evidenceDigest,
      assertActive: async () => {
        spending.assertions++
        if (!spending.active) throw new Error('SPENDING_REVOKED')
      },
    }
  }
  const reopen = async () => {
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const ledger = new DurableUsageLedger({
      store: new SqliteDurableUsageStore(provider),
      now: () => at,
    })
    return {
      ledger,
      bridge: createPiDurableUsageAuthority({
        ledger,
        resolvePrice: async () => ({ price, maximumOutputTokens: 32 }),
        assertSpendingAuthorized,
      }),
    }
  }
  try {
    await provider.migrate()
    await new SqliteContextPackageRepository(provider).put(inputs.contextPackage)
    await new SqliteExecutionPlanRepository(provider).put(plan)
    const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(provider))
    const execution = await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: at,
    })
    await lifecycle.createAttempt({
      ...ids,
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    const { ledger, bridge } = await reopen()
    await ledger.openBudget({
      workspaceId,
      executionId: ids.executionId,
      currency: 'USD',
      maximumMicrounits,
      maximumTokens,
      source: { sourceId: 'funded', idempotencyKey: 'funded' },
    })
    await ledger.reserve({
      workspaceId,
      ...ids,
      reservationKey: authority.request.attemptBudget.reservationKey,
      maximumMicrounits,
      maximumTokens,
      source: { sourceId: 'attempt', idempotencyKey: 'attempt' },
    })
    await run({
      authority,
      workspaceId,
      bridge,
      ledger,
      reopen,
      directory,
      path,
      priceSnapshot,
      spending,
    })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}
