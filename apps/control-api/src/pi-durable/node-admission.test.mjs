import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VersionedCatalog, ExecutionLifecycleService } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteExecutionRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { SqliteVersionedCatalogRepository } from '@control-plane/sqlite-persistence/catalog'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import { NodePiDurableLeadAdmission, deterministicPiLeadIntentIds } from './node-admission.ts'

const at = '2026-10-08T00:00:00.000Z'
const expiresAt = '2026-10-08T01:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-node-admission-'))
  const path = join(directory, 'node.sqlite')
  let provider, database
  const open = async () => {
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    database = new DatabaseSync(path)
    const executions = new SqliteExecutionRepository(provider)
    const plans = new SqliteExecutionPlanRepository(provider)
    const commandRepository = new SqliteCommandAcceptanceRepository(provider, {
      budgetAdmission: true,
    })
    const catalog = new SqliteVersionedCatalogRepository(provider)
    const usage = new SqliteDurableUsageStore(provider)
    return { executions, plans, commandRepository, catalog, usage }
  }
  try {
    let repositories = await open()
    const inputs = createExecutionPlanTestFixtureInputs()
    inputs.profile.definition.skills = []
    inputs.skills = []
    const ids = deterministicPiLeadIntentIds(inputs.correlation.workspaceId, intentId)
    inputs.correlation.requestId = ids.requestId
    const catalog = new VersionedCatalog(repositories.catalog, repositories.catalog)
    await catalog.createAgentProfile({
      profileId: inputs.profile.profileId,
      displayName: 'Pi lead fixture',
      ownership: { scope: 'system' },
      createdAt: inputs.profile.createdAt,
    })
    const draft = await catalog.createAgentProfileDraft({
      profileId: inputs.profile.profileId,
      profileVersionId: inputs.profile.profileVersionId,
      version: inputs.profile.version,
      definition: inputs.profile.definition,
      createdAt: inputs.profile.createdAt,
    })
    inputs.profile = await catalog.publishAgentProfileVersion({
      profileVersionId: draft.profileVersionId,
      expectedRevision: draft.revision,
      publishedAt: at,
    })
    await new SqliteContextPackageRepository(provider).put(inputs.contextPackage)
    const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    await repositories.plans.put(plan)
    let evidence = {
      schemaVersion: 'pi-lead-intent/v1',
      intentId,
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      messageRef: 'message:one',
      authorityRevision: 1,
      principalRef: 'lead:one',
      scopeRef: 'channel:one',
      expiresAt,
      allowedPrincipalIds: ['svc_adea'],
      selectionRef: `msel_${'a'.repeat(32)}`,
      selectionRevision: 1,
      prompt: 'Canonical lead message',
      profileVersionId: plan.profile.profileVersionId,
      profileContentDigest: plan.profile.contentDigest,
    }
    const principal = {
      kind: 'agent_hq_service',
      principalId: 'svc_adea',
      workspaceIds: [evidence.workspaceId],
      projectIds: [evidence.projectId],
      scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    }
    const options = (overrides) => ({
      database,
      product: {
        readCurrent: async (input) =>
          input.intentId === intentId ? structuredClone(evidence) : undefined,
      },
      resolvePlan: async () => plan,
      plans: repositories.plans,
      commandRepository: repositories.commandRepository,
      planValidator: new ExecutionPlanAcceptanceValidator(repositories.plans, {
        catalog: { profiles: repositories.catalog, skills: repositories.catalog },
      }),
      executions: repositories.executions,
      budgetAdmission: new DurableRuntimeBudgetAdmission({
        commands: repositories.commandRepository,
        store: repositories.usage,
      }),
      admissionPrincipalId: 'svc_pi-admission',
      now: () => at,
      ...overrides,
    })
    const resolve = (bridge) =>
      bridge.resolveIntent({ workspaceId: plan.correlation.workspaceId, intentId, principal })
    const reopen = async () => {
      database.close()
      await provider.close()
      repositories = await open()
      return new NodePiDurableLeadAdmission(options())
    }
    const ledger = () => new DurableUsageLedger({ store: repositories.usage })
    const counts = () =>
      provider.transaction(async (transaction) => ({
        commands: (await transaction.list('command-inbox')).length,
        executions: (await transaction.list('executions')).length,
      }))
    await operation({
      bridge: new NodePiDurableLeadAdmission(options()),
      options,
      resolve,
      reopen,
      counts,
      ledger,
      principal,
      plan,
      ids,
      get repositories() {
        return repositories
      },
      setEvidence: (change) => {
        evidence = change === undefined ? undefined : { ...evidence, ...change }
      },
      get database() {
        return database
      },
    })
  } finally {
    database?.close()
    await provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('real SQLite CP admission mints exactly one accepted execution, attempt and canonical budget', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    expect(admission.admittedAttempt).toMatchObject({
      executionId: setup.ids.executionId,
      attemptId: setup.ids.attemptId,
      executionPlanId: setup.plan.executionPlanId,
    })
    expect(admission.startRequest.attemptBudget.maximumTokens).toBe(
      setup.plan.constraints.limits.tokens.maximumTotal
    )
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
    const summary = await setup
      .ledger()
      .summary(setup.plan.correlation.workspaceId, setup.ids.executionId)
    expect(summary.reservedTokens).toBe(setup.plan.constraints.limits.tokens.maximumTotal)
    expect(summary.reservedMicrounits).toBe(setup.plan.constraints.limits.budget.maximumMicrounits)
    await setup.bridge.assertCurrent(admission, setup.principal, 'dispatch')
    await setup.bridge.canonicalAuthority.assertAuthority({
      request: admission.startRequest,
      admission: await setup.bridge.canonicalAuthority.resolveAdmission(admission.startRequest),
    })
    const reopened = await setup.reopen()
    expect(await setup.resolve(reopened)).toEqual(admission)
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
  })
})

for (const boundary of [
  'after_marker',
  'after_accept',
  'after_attempt',
  'after_budget',
  'after_mapping',
]) {
  test(`physical SQLite reopen replays ${boundary} without duplicate work or budget`, async () => {
    await fixture(async (setup) => {
      const interrupted = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: (point) => {
            if (point === boundary) throw new Error('secret-crash-diagnostic')
          },
        })
      )
      await expect(setup.resolve(interrupted)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      const recovered = await setup.reopen()
      const admission = await setup.resolve(recovered)
      expect(admission.startRequest.attemptId).toBe(setup.ids.attemptId)
      expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
      expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(
        1
      )
      const entries = await setup
        .ledger()
        .entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      expect(entries.filter((entry) => entry.kind === 'credit')).toHaveLength(1)
      expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
    })
  })
}

test('pending immutable marker rejects changed product prompt or provider selection after crash', async () => {
  for (const change of [{ prompt: 'Changed message' }, { selectionRevision: 2 }]) {
    await fixture(async (setup) => {
      const interrupted = new NodePiDurableLeadAdmission(
        setup.options({
          checkpoint: (point) => {
            if (point === 'after_marker') throw new Error('crash')
          },
        })
      )
      await expect(setup.resolve(interrupted)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
      setup.setEvidence(change)
      await expect(setup.resolve(await setup.reopen())).rejects.toThrow(
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
    })
  }
})

test('message deletion and current audience revocation prevent accepted replay', async () => {
  for (const change of [undefined, { allowedPrincipalIds: ['svc_other'] }]) {
    await fixture(async (setup) => {
      await setup.resolve(setup.bridge)
      setup.setEvidence(change)
      await expect(setup.resolve(await setup.reopen())).rejects.toThrow()
      expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    })
  }
})

test('missing canonical budget admission never publishes a ready intent mapping', async () => {
  await fixture(async (setup) => {
    const bridge = new NodePiDurableLeadAdmission(
      setup.options({
        commandRepository: new SqliteCommandAcceptanceRepository(
          setup.repositories.executions.provider
        ),
      })
    )
    await expect(setup.resolve(bridge)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(await bridge.store.get(intentId)).toBeUndefined()
  })
})

test('superseding canonical attempt fails cold replay instead of minting a third attempt', async () => {
  await fixture(async (setup) => {
    await setup.resolve(setup.bridge)
    await setup.ledger().settle({
      workspaceId: setup.plan.correlation.workspaceId,
      executionId: setup.ids.executionId,
      reservationKey: `runtime-attempt:${setup.ids.attemptId}`,
      source: { sourceId: 'known-no-effect', idempotencyKey: 'known-no-effect:settle' },
    })
    const execution = await setup.repositories.executions.getExecution(setup.ids.executionId)
    await new ExecutionLifecycleService(setup.repositories.executions).createAttempt({
      executionId: execution.executionId,
      attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    await expect(setup.resolve(await setup.reopen())).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(2)
  })
})

test('terminal status keeps current audience and historical allocation without reopening spend', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    await setup.ledger().settle({
      workspaceId: setup.plan.correlation.workspaceId,
      executionId: setup.ids.executionId,
      reservationKey: `runtime-attempt:${setup.ids.attemptId}`,
      source: { sourceId: 'known-no-effect', idempotencyKey: 'terminal-read:settle' },
    })
    const execution = await setup.repositories.executions.getExecution(setup.ids.executionId)
    await new ExecutionLifecycleService(setup.repositories.executions).transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: at,
    })
    const reopened = await setup.reopen()
    const read = await reopened.resolveIntent({
      workspaceId: setup.plan.correlation.workspaceId,
      intentId,
      principal: setup.principal,
      operation: 'status',
    })
    expect(read).toEqual(admission)
    await reopened.assertCurrent(read, setup.principal, 'status')
    await expect(setup.resolve(reopened)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    setup.setEvidence({ allowedPrincipalIds: ['svc_other'] })
    await expect(
      reopened.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_SCOPE_REJECTED')
    expect(
      (
        await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      ).filter((entry) => entry.kind === 'reservation')
    ).toHaveLength(1)
  })
})

test('read operations cannot mint an execution even for a principal with accept scope', async () => {
  await fixture(async (setup) => {
    await expect(
      setup.bridge.resolveIntent({
        workspaceId: setup.plan.correlation.workspaceId,
        intentId,
        principal: setup.principal,
        operation: 'status',
      })
    ).rejects.toThrow('PI_LEAD_MISSING')
    expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
  })
})

test('current CP catalog revocation blocks replay and runtime authority without reminting', async () => {
  await fixture(async (setup) => {
    const admission = await setup.resolve(setup.bridge)
    const profile = await setup.repositories.catalog.getAgentProfileVersion(
      setup.plan.profile.profileVersionId
    )
    const catalog = new VersionedCatalog(setup.repositories.catalog, setup.repositories.catalog)
    await catalog.revokeAgentProfileVersion(
      profile.profileVersionId,
      profile.revision,
      at,
      'fixture policy revocation'
    )
    const reopened = await setup.reopen()
    await expect(setup.resolve(reopened)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
    await expect(
      reopened.canonicalAuthority.resolveAdmission(admission.startRequest)
    ).rejects.toThrow('PI_CANONICAL_AUTHORITY_REJECTED')
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
  })
})

test('concurrent canonical admission requests converge on one CP identity and allocation', async () => {
  await fixture(async (setup) => {
    const peers = [
      setup.bridge,
      new NodePiDurableLeadAdmission(setup.options()),
      new NodePiDurableLeadAdmission(setup.options()),
    ]
    const outcomes = await Promise.allSettled(peers.map((peer) => setup.resolve(peer)))
    // Independent SQLite connections may return bounded busy failures. Drain
    // every contender before exact retry, so no live transaction is abandoned.
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    const admissions = []
    for (const peer of peers) admissions.push(await setup.resolve(peer))
    expect(admissions[1]).toEqual(admissions[0])
    expect(admissions[2]).toEqual(admissions[0])
    expect(await setup.counts()).toEqual({ commands: 1, executions: 1 })
    expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(1)
    expect(
      (
        await setup.ledger().entries(setup.plan.correlation.workspaceId, setup.ids.executionId)
      ).filter((entry) => entry.kind === 'reservation')
    ).toHaveLength(1)
  })
})

test('provider-native secrets are rejected before marker, command or budget persistence', async () => {
  await fixture(async (setup) => {
    setup.setEvidence({ credential: 'provider-native-secret-canary' })
    try {
      await setup.resolve(setup.bridge)
      throw new Error('unexpected admission')
    } catch (error) {
      expect(error.message).toBe('PI_LEAD_UNAVAILABLE')
      expect(JSON.stringify(error)).not.toContain('provider-native-secret-canary')
    }
    expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
    expect(
      setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
    ).toHaveLength(0)
  })
})

test('workspace-only product evidence requires explicit project scope before any CP admission', async () => {
  for (const projectId of [null, undefined]) {
    await fixture(async (setup) => {
      setup.setEvidence({ projectId })
      await expect(setup.resolve(setup.bridge)).rejects.toThrow('PI_LEAD_PROJECT_SCOPE_REQUIRED')
      expect(await setup.counts()).toEqual({ commands: 0, executions: 0 })
      expect(await setup.repositories.executions.listAttempts(setup.ids.executionId)).toHaveLength(
        0
      )
      expect(
        await setup.repositories.usage.transaction(
          setup.plan.correlation.workspaceId,
          (transaction) => transaction.getBudget(setup.ids.executionId)
        )
      ).toBeUndefined()
      expect(
        setup.database.prepare('SELECT record FROM pi_lead_intent_admissions').all()
      ).toHaveLength(0)
    })
  }
})
