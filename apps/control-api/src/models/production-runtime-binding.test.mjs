import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ContextPackageCompiler } from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PiDurableRuntimeAdapter,
  createNodePiDurableRuntime,
} from '@control-plane/pi-durable-adapter'
import { fixture } from '../../../../packages/pi-durable-adapter/src/adapter.fixture.mjs'
import { SqlitePiLeadPreparations } from '../pi-durable/lead-preparation.ts'
import { createProductionRuntimeBinding } from './production-runtime-binding.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('reopened starting workspace work inspects the bound adapter while expired preparation cleanup pauses startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-production-startup-'))
  const setup = fixture(directory)
  const inputs = createExecutionPlanTestFixtureInputs({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  delete inputs.correlation.projectId
  inputs.correlation.executionScope = { schemaVersion: 1, kind: 'workspace' }
  inputs.contextPackage = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: inputs.correlation.workspaceId,
    executionScope: inputs.correlation.executionScope,
    revision: 1,
    objective: 'Synthetic workspace recovery',
    artifacts: [],
    constraints: inputs.contextPackage.constraints,
    permissions: [],
    successCriteria: inputs.contextPackage.successCriteria,
    returnContract: inputs.contextPackage.returnContract,
    budgets: inputs.contextPackage.budgets,
    compiledAt: '2026-10-08T00:00:00.000Z',
  })
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  setup.request.executionPlan = plan
  setup.request.attemptBudget.executionPlanId = plan.executionPlanId
  setup.request.attemptBudget.executionPlanDigest = plan.contentDigest
  setup.admission.canonicalActorPrincipalId = 'user:f643a115-617d-4bae-8d52-cfe458c0b8ac'
  const scopeAuthority = {
    readCurrent: async (input) => ({
      ...input,
      executionScope: plan.correlation.executionScope,
      principalActive: true,
      grantActive: true,
      allowedPrincipalIds: [setup.admission.canonicalActorPrincipalId],
      expiresAt: '2027-01-01T00:00:00.000Z',
    }),
  }
  setup.options.scopeAuthority = scopeAuthority
  let seed, recovered, database, startup
  const releaseEntered = deferred(),
    releaseCleanup = deferred(),
    providerEntered = deferred()
  let outerRuntime,
    boundAdapter,
    readyCalls = 0
  try {
    seed = new PiDurableRuntimeAdapter(setup.options)
    const handle = await seed.start(setup.request)
    await seed.drain()
    const record = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, record.epoch, {
      state: 'starting',
      detail: { inferencePending: true },
    })
    await seed.close()
    const expiredRequest = structuredClone(setup.request)
    expiredRequest.executionId = 'exe_01JBBCDEF0123456789ABCDEFG'
    expiredRequest.attemptId = 'att_01JBBCDEF0123456789ABCDEFG'
    Object.assign(expiredRequest.attemptBudget, {
      executionId: expiredRequest.executionId,
      attemptId: expiredRequest.attemptId,
      reservationKey: `runtime-attempt:${expiredRequest.attemptId}`,
    })
    const admission = {
      schemaVersion: 'pi-lead-authority/v1',
      intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
      workspaceId: plan.correlation.workspaceId,
      allowedPrincipalIds: ['svc_agent-hq'],
      admissionDigest: `sha256:${'a'.repeat(64)}`,
      deadlineAt: '2026-10-08T01:00:00.000Z',
      admittedAttempt: {
        executionId: expiredRequest.executionId,
        attemptId: expiredRequest.attemptId,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
      },
      startRequest: expiredRequest,
    }
    const funding = {
      schemaVersion: 'model-funding-display/v1',
      workspaceId: admission.workspaceId,
      executionId: expiredRequest.executionId,
      attemptId: expiredRequest.attemptId,
      ...setup.admission.selection,
      state: 'ready',
      provider: 'openai',
      providerModel: 'gpt-5',
      accountRef: 'account:synthetic',
      authKind: 'api_key',
      fundingSource: 'byo_api',
      fundingOwner: {
        ownerRef: 'payer:synthetic',
        kind: 'provider_account',
        displayName: 'Synthetic payer',
        revision: 1,
        evidenceRef: 'evidence:synthetic',
      },
      authorizationRef: 'spend:synthetic',
      authorityRevision: 1,
      expiresAt: admission.deadlineAt,
    }
    const path = join(directory, 'preparations.sqlite')
    database = new DatabaseSync(path)
    await new SqlitePiLeadPreparations(
      database,
      { readFunding: async () => funding, releaseExpired: async () => {} },
      () => '2026-10-08T00:00:00.000Z'
    ).prepare(admission, {
      kind: 'agent_hq_service',
      principalId: 'svc_agent-hq',
      workspaceIds: [admission.workspaceId],
      projectIds: [],
      scopes: ['execution:accept'],
    })
    database.close()
    database = new DatabaseSync(path)
    const preparations = new SqlitePiLeadPreparations(
      database,
      {
        readFunding: async () => funding,
        releaseExpired: async () => {
          releaseEntered.resolve()
          await releaseCleanup.promise
        },
      },
      () => '2026-10-08T01:00:00.000Z'
    )
    const binding = createProductionRuntimeBinding()
    startup = (async () => {
      recovered = await createNodePiDurableRuntime({
        ...setup.options,
        reconcileInference: async () => 'safe_to_resume',
        onAdapterReady: async (adapter) => {
          readyCalls++
          boundAdapter = adapter
          binding.onAdapterReady(adapter)
        },
        resolveProvider: async (...args) => {
          try {
            await releaseEntered.promise
            expect(outerRuntime).toBeUndefined()
            await binding.assertSupported()
            providerEntered.resolve()
            return setup.options.resolveProvider(...args)
          } catch (error) {
            providerEntered.reject(error)
            throw error
          }
        },
      })
      await preparations.recoverExpired()
      return recovered
    })()
    await Promise.race([
      releaseEntered.promise,
      startup.then(() => {
        throw new Error('STARTUP_DID_NOT_PAUSE')
      }),
    ])
    await Promise.race([
      providerEntered.promise,
      recovered.adapter.drain().then(() => {
        throw new Error('RECOVERY_DID_NOT_RESOLVE_PROVIDER')
      }),
    ])
    expect(readyCalls).toBe(1)
    expect(outerRuntime).toBeUndefined()
    releaseCleanup.resolve()
    outerRuntime = await startup
    expect(outerRuntime.adapter).toBe(boundAdapter)
    await outerRuntime.adapter.drain()
    expect((await outerRuntime.adapter.status(handle)).state).toBe('completed')
    expect(outerRuntime.recoveryBlocked).toEqual([])
  } finally {
    releaseEntered.resolve()
    releaseCleanup.resolve()
    await startup?.catch(() => {})
    await recovered?.close()
    await seed?.close()
    database?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('failed ready callback closes the same adapter before recovery and preserves the error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-ready-failure-'))
  let adapter
  const sentinel = new Error('TRUSTED_READY_FAILED')
  try {
    await expect(
      createNodePiDurableRuntime({
        ...fixture(directory).options,
        onAdapterReady: (ready) => {
          adapter = ready
          throw sentinel
        },
      })
    ).rejects.toBe(sentinel)
    expect((await adapter.inspect()).health).toBe('unavailable')
  } finally {
    await adapter?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
